// A reusable AnalyserNode "tap" — the bridge between the voice pipeline and the
// particle field.
//
// We create one of these in each audio graph (mic input, TTS output) and read
// it once per animation frame. Everything here is allocation-free after setup:
// the byte buffers, the band index ranges, and the log-spaced bin edges are all
// computed once, because sample() runs 60 times a second.
//
// Two things come out of a tap:
//   - scalar drives  (rms, low, mid, high) for "how loud / how bright is this?"
//   - a log-spaced spectrum (bins) for "what shape is this sound?"
//
// The spectrum is log-spaced rather than linear because a linear FFT wastes
// most of its resolution on 8-20 kHz, where speech has almost nothing. Log
// spacing puts the detail where voices actually live.

import { ANALYSIS } from "./config.js";

/**
 * @param {AudioContext} ctx
 * @returns {{ node: AnalyserNode, sample: (out: object) => object }}
 */
export function createAnalyserTap(ctx) {
  const node = ctx.createAnalyser();
  node.fftSize = ANALYSIS.fftSize;
  node.smoothingTimeConstant = ANALYSIS.smoothing;
  node.minDecibels = -85;
  node.maxDecibels = -12;

  const binCount = node.frequencyBinCount; // fftSize / 2
  const freqBytes = new Uint8Array(binCount);
  const timeBytes = new Uint8Array(node.fftSize);
  const hzPerBin = ctx.sampleRate / ANALYSIS.fftSize;

  // --- band index ranges (computed once) ---
  const rangeFor = ([loHz, hiHz]) => {
    const lo = Math.max(0, Math.floor(loHz / hzPerBin));
    const hi = Math.min(binCount - 1, Math.ceil(hiHz / hzPerBin));
    return [lo, Math.max(lo, hi)];
  };
  const bandRanges = {
    low: rangeFor(ANALYSIS.bands.low),
    mid: rangeFor(ANALYSIS.bands.mid),
    high: rangeFor(ANALYSIS.bands.high),
  };

  // --- log-spaced spectrum edges (computed once) ---
  const N = ANALYSIS.bins;
  const [fLo, fHi] = ANALYSIS.spectrumHz;
  const edges = new Int32Array(N + 1);
  for (let j = 0; j <= N; j++) {
    const hz = fLo * Math.pow(fHi / fLo, j / N);
    edges[j] = Math.min(binCount - 1, Math.max(0, Math.round(hz / hzPerBin)));
  }

  function bandEnergy(range) {
    const [a, b] = range;
    let sum = 0;
    for (let i = a; i <= b; i++) sum += freqBytes[i];
    return sum / ((b - a + 1) * 255);
  }

  /**
   * Read the current audio into `out` (mutated in place, never allocated).
   * `out.bins` must be a Float32Array of ANALYSIS.bins length.
   */
  function sample(out) {
    node.getByteFrequencyData(freqBytes);
    node.getByteTimeDomainData(timeBytes);

    // RMS from the time domain — a truer "loudness" than summing FFT bins,
    // and it's what makes the field breathe with the actual waveform.
    let sumSquares = 0;
    for (let i = 0; i < timeBytes.length; i++) {
      const v = (timeBytes[i] - 128) / 128;
      sumSquares += v * v;
    }
    out.rms = Math.sqrt(sumSquares / timeBytes.length);

    out.low = bandEnergy(bandRanges.low);
    out.mid = bandEnergy(bandRanges.mid);
    out.high = bandEnergy(bandRanges.high);

    // Reduce the FFT into log-spaced bins. We take the max (not the mean) in
    // each band so narrow peaks survive — a mean smears formants into mush.
    const bins = out.bins;
    for (let j = 0; j < N; j++) {
      const a = edges[j];
      const b = Math.max(a, edges[j + 1] - 1);
      let peak = 0;
      for (let i = a; i <= b; i++) {
        if (freqBytes[i] > peak) peak = freqBytes[i];
      }
      bins[j] = peak / 255;
    }

    return out;
  }

  return { node, sample, binCount };
}

/** Allocate a frame object shaped the way sample() expects to fill it. */
export function createAudioFrame() {
  return {
    rms: 0,
    low: 0,
    mid: 0,
    high: 0,
    bins: new Float32Array(ANALYSIS.bins),
    source: "none", // "mic" | "tts" | "none"
    state: "idle",
  };
}
