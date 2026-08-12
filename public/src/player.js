// Gap-free playback of streamed linear16 PCM using the Web Audio API, with an
// analyser tap so the particle field can react to the synthesized voice.
//
// Glitch-free playback: we schedule each incoming chunk on a running timeline
// (`nextTime`) instead of playing them "now", so consecutive chunks butt up
// against each other sample-accurately with no clicks or gaps.
//
// Barge-in: flush() stops every scheduled source instantly, which is how we cut
// the agent off the moment the user starts talking.
//
// Graph: [buffer sources] -> out (gain) -> analyser -> destination
// The analyser sits in the signal path here (unlike the mic tap) because these
// sources genuinely play out, so routing through it costs nothing and
// guarantees it's pulled every render quantum.

import { createAnalyserTap } from "./analyser.js";

export function createPlayer({ sampleRate, onStart, onEnd }) {
  const ctx = new AudioContext();
  const sources = new Set();
  let nextTime = 0;
  let playing = false;
  // Timeline position where the current run of audio began, so we can report
  // how much of it the listener actually heard when they barge in.
  let startedAt = 0;

  const out = ctx.createGain();
  const tap = createAnalyserTap(ctx);
  out.connect(tap.node);
  tap.node.connect(ctx.destination);

  function enqueue(arrayBuffer) {
    const pcm = new Int16Array(arrayBuffer);
    if (pcm.length === 0) return;

    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 0x8000;

    const buffer = ctx.createBuffer(1, float.length, sampleRate);
    buffer.copyToChannel(float, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(out);

    // Small lead so the very first chunk doesn't start in the past.
    const now = ctx.currentTime;
    if (nextTime < now) nextTime = now + 0.02;
    const startTime = nextTime;
    src.start(startTime);
    nextTime += buffer.duration;

    sources.add(src);
    if (!playing) {
      playing = true;
      startedAt = startTime;
      onStart?.();
    }
    src.onended = () => {
      sources.delete(src);
      if (sources.size === 0 && playing) {
        playing = false;
        onEnd?.();
      }
    };
  }

  function flush() {
    for (const src of sources) {
      try {
        src.onended = null;
        src.stop();
      } catch {}
    }
    sources.clear();
    nextTime = 0;
    startedAt = 0;
    if (playing) {
      playing = false;
      onEnd?.();
    }
  }

  return {
    tap,
    /** Must be called from a user gesture to satisfy autoplay policies. */
    resume: () => ctx.resume(),
    enqueue,
    flush,
    get isPlaying() {
      return playing;
    },

    /**
     * Milliseconds of the current run that have actually reached the speakers.
     * Flux TTS takes this as `playback_offset` on an Interrupt so it knows
     * where the listener was cut off. Capped at what we've scheduled, since
     * the audio clock runs ahead of the queue between chunks.
     *
     * Must be read BEFORE flush() — that resets the timeline.
     */
    get playedMs() {
      if (!playing) return 0;
      const elapsed = (ctx.currentTime - startedAt) * 1000;
      const scheduled = (nextTime - startedAt) * 1000;
      return Math.min(Math.max(elapsed, 0), Math.max(scheduled, 0));
    },
    close: () => {
      flush();
      try {
        out.disconnect();
        tap.node.disconnect();
      } catch {}
      ctx.close();
    },
  };
}
