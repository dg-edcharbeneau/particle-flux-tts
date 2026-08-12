// AudioWorkletProcessor — runs on the real-time audio thread.
//
// The browser hands us mono Float32 audio at the AudioContext's native rate
// (often 48 kHz). Deepgram Flux wants 16 kHz linear16 (signed 16-bit PCM). So
// here we:
//   1. resample native-rate -> 16 kHz with linear interpolation,
//   2. pack to Int16,
//   3. emit fixed ~80 ms chunks (Deepgram's recommended streaming granularity),
//   4. report an RMS level so the UI can show a live mic meter (VAD feedback).
//
// This lives in its own file because worklet code is loaded by URL into a
// separate global scope (AudioWorkletGlobalScope) — it can't be bundled with
// the main-thread modules.

class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetSampleRate, chunkMs } = options.processorOptions;
    this.targetRate = targetSampleRate;
    this.chunkSamples = Math.round((targetSampleRate * chunkMs) / 1000);
    // Input samples consumed per output sample. `sampleRate` is a global in the
    // worklet scope = the AudioContext rate.
    this.ratio = sampleRate / targetSampleRate;

    this.leftover = new Float32Array(0); // input samples not yet consumed
    this.readPos = 0; // fractional read cursor into `leftover`
    this.out = new Int16Array(this.chunkSamples);
    this.outIndex = 0;
    this.levelTick = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true; // no mic frame this quantum; stay alive
    const channel = input[0];

    // Append this render quantum to whatever we couldn't consume last time.
    const merged = new Float32Array(this.leftover.length + channel.length);
    merged.set(this.leftover, 0);
    merged.set(channel, this.leftover.length);
    this.leftover = merged;

    let sumSquares = 0;
    let counted = 0;

    // Resample by walking a fractional cursor and linearly interpolating.
    while (this.readPos + 1 < this.leftover.length) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      let s = this.leftover[i] * (1 - frac) + this.leftover[i + 1] * frac;
      s = Math.max(-1, Math.min(1, s));

      // Float [-1,1] -> Int16.
      this.out[this.outIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSquares += s * s;
      counted++;

      if (this.outIndex === this.chunkSamples) {
        // Transfer ownership of the buffer to the main thread (zero-copy).
        this.port.postMessage({ type: "audio", buffer: this.out.buffer }, [
          this.out.buffer,
        ]);
        this.out = new Int16Array(this.chunkSamples);
        this.outIndex = 0;
      }
      this.readPos += this.ratio;
    }

    // Drop the input we've fully consumed; keep the tail for interpolation.
    const consumed = Math.floor(this.readPos);
    if (consumed > 0) {
      this.leftover = this.leftover.slice(consumed);
      this.readPos -= consumed;
    }

    // Report level roughly every ~4 quanta (~10-12 ms) to drive the mic meter.
    if (counted > 0 && ++this.levelTick % 4 === 0) {
      this.port.postMessage({ type: "level", level: Math.sqrt(sumSquares / counted) });
    }

    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
