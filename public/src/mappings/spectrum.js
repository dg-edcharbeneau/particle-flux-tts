// Mapping 3 — Radial spectrum.
//
// A polar FFT: distance from the center selects a frequency bin, so the whole
// field becomes a spectrum analyzer wrapped into a disc.
//
//   center -> 60 Hz
//   rim    -> 8 kHz
//
// The bins are log-spaced (see analyser.js), which is what makes this readable
// for speech — a linear FFT would spend most of the disc on empty high end.
// Vowel formants show up as bright concentric bands; sibilants flare the rim.
//
// Two touches keep it from looking like a static test pattern: the bin index is
// skewed slightly by angle, turning the rings into a slow spiral, and particles
// are pushed outward in proportion to their bin's energy so loud bands physically
// bloom.

import { shade } from "../theme.js";

const SPIRAL_TURNS = 1.4; // how much the angle skews the bin lookup
const TAU = Math.PI * 2;

export function createMapping() {
  let bins = null;
  let n = 0;
  let amp = 30;
  let baseHue = 0.5;
  let baseSat = 1;
  let spin = 0;
  // Unlike the other two mappings, a silent spectrum is genuinely flat — every
  // bin reads zero. Without this the page is a dead plate before you press
  // Start, so we add a slow swell and fade it out as soon as real audio arrives.
  let idleAmount = 1;
  let idlePhase = 0;

  return {
    id: "spectrum",
    title: "Radial spectrum",
    blurb:
      "A log-spaced FFT wrapped into a disc: bass at the center, sibilance at the rim. Vowel formants appear as bright bands.",

    prepare(audio, time, dt, palette) {
      bins = audio.bins;
      n = bins.length;
      amp = 30;
      baseHue = palette.hue;
      baseSat = palette.sat;
      spin += dt * 0.15;
      idleAmount = Math.max(0, 1 - audio.rms * 8);
      idlePhase = time * 0.8;
    },

    particle(i, G, out) {
      // Fractional bin index, skewed by angle so the rings spiral. `%` keeps
      // the sign of its operand in JS, so normalize into [0,1) by hand —
      // otherwise the skew goes negative and the spiral seams while `spin` is
      // still small.
      let turn = (G.a[i] / TAU + spin) % 1;
      if (turn < 0) turn += 1;

      let f = G.nr[i] * (n - 1) + turn * SPIRAL_TURNS;
      if (f < 0) f = 0;
      else if (f > n - 1) f = n - 1;

      // Linear interpolation between neighbouring bins — without it the rings
      // are visibly quantized into 64 hard steps.
      const j = f | 0;
      const frac = f - j;
      const a = bins[j];
      const b = j + 1 < n ? bins[j + 1] : a;
      const mag = a + (b - a) * frac;

      // Loud bands push their ring outward.
      const push = 1 + mag * 0.16;

      out.x = G.x[i] * push;
      out.y = mag * amp + Math.sin(G.nr[i] * 14 - idlePhase) * 0.5 * idleAmount;
      out.z = G.z[i] * push;
      out.scale = 0.6 + mag * 2.0;

      // Hue tracks frequency, so you can read the spectrum by color as well as
      // by height. The spread is deliberately narrow — a full rainbow fights
      // with the state palette.
      shade(out.color, baseHue + (f / n - 0.5) * 0.32, baseSat * (0.55 + mag * 0.5), mag);
    },
  };
}
