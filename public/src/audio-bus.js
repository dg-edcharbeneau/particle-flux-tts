// The single audio signal the visualization reads.
//
// There are two live audio graphs in this app — the microphone and the TTS
// player — each with its own AnalyserNode (and its own AudioContext, so they
// can't share one). The bus picks whichever one is meaningful *right now* based
// on the conversation state, and smooths the result so the particle field moves
// like a physical thing instead of strobing.
//
//   listening / thinking -> mic tap    (the user's voice drives the field)
//   speaking             -> TTS tap    (the synthesized voice drives it)
//   idle / connecting    -> decay to silence
//
// Smoothing uses an asymmetric envelope follower: fast attack so a consonant
// lands as a visible hit, slow release so the field settles rather than
// flickering between syllables. Rates are per-second and converted with
// 1 - exp(-rate * dt), which keeps the feel identical at 30 or 144 fps.

import { ANALYSIS } from "./config.js";
import { createAudioFrame } from "./analyser.js";

export function createAudioBus() {
  let micTap = null;
  let ttsTap = null;
  let state = "idle";

  // `raw` holds this frame's unsmoothed read; `frame` is what callers see.
  const raw = createAudioFrame();
  const frame = createAudioFrame();
  const N = ANALYSIS.bins;

  const follow = (current, target, dt) => {
    const rate = target > current ? ANALYSIS.attackPerSec : ANALYSIS.releasePerSec;
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  };

  function activeTap() {
    if (state === "speaking") return ttsTap;
    if (state === "listening" || state === "thinking") return micTap;
    return null;
  }

  return {
    setMicTap(t) {
      micTap = t;
    },
    setTtsTap(t) {
      ttsTap = t;
    },
    setState(s) {
      state = s;
    },

    /**
     * Read the current audio. Returns a stable object — do not hold references
     * to `frame.bins` expecting a snapshot; it's mutated every call.
     */
    sample(dt) {
      const tap = activeTap();

      if (tap) {
        tap.sample(raw);
        frame.source = state === "speaking" ? "tts" : "mic";
      } else {
        // No active source: fall toward silence rather than snapping to it.
        raw.rms = raw.low = raw.mid = raw.high = 0;
        raw.bins.fill(0);
        frame.source = "none";
      }

      frame.state = state;
      frame.rms = follow(frame.rms, raw.rms, dt);
      frame.low = follow(frame.low, raw.low, dt);
      frame.mid = follow(frame.mid, raw.mid, dt);
      frame.high = follow(frame.high, raw.high, dt);
      for (let i = 0; i < N; i++) {
        frame.bins[i] = follow(frame.bins[i], raw.bins[i], dt);
      }

      return frame;
    },
  };
}
