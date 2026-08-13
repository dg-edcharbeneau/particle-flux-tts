// Mapping 1 — Dual-band interference.
//
// This is the original swarm's wave-optics math, with the two wave sources
// wired to two halves of the voice spectrum:
//
//   low band  (80-400 Hz, pitch)      -> strength of Source A
//   high band (2-6 kHz, consonants)   -> strength of Source B
//   mid band  (400-2000 Hz, formants) -> how far apart the sources sit
//   overall RMS                       -> wave amplitude
//
// The result is that vowels push the sources apart into wide, slow fringes
// while sibilants ("s", "sh", "t") tighten the ripples and light up Source B.
// Speech makes the two sources genuinely beat against each other, which is what
// the interference math was always for — the original export had srcDist pinned
// at 1, which collapsed both sources onto the same point.

import { shade } from "../theme.js";

export function createMapping() {
  // Per-frame values, computed once in prepare() and read 20,000 times.
  let s1x = 0;
  let s2x = 0;
  let k = 1;
  let amp = 1;
  let wA = 1;
  let wB = 1;
  let baseHue = 0.5;
  let baseSat = 1;

  // Phase is accumulated rather than derived from `time * speed`, because
  // speed is audio-driven: multiplying a moving speed by absolute time makes
  // the whole wavefront jump whenever the speed changes.
  let phase = 0;

  const DECAY = 0.03; // attenuation with distance from the source

  return {
    id: "interference",
    title: "Dual-band interference",
    blurb:
      "Low frequencies drive Source A, highs drive Source B. Vowels spread the sources apart; consonants tighten the fringes.",

    prepare(audio, time, dt, palette) {
      const { rms, low, mid, high } = audio;

      // Sources sit on the X axis, symmetric about the origin.
      const srcDist = 6 + mid * 64;
      s1x = -srcDist * 0.5;
      s2x = srcDist * 0.5;

      // Spatial frequency: sibilance tightens the ripples.
      k = (3 + high * 20) * 0.2;

      // Temporal frequency: louder audio makes the wavefronts travel faster.
      phase += dt * (3 + rms * 12);

      amp = 0.6 + rms * 20;
      wA = 0.35 + low * 1.3;
      wB = 0.35 + high * 1.3;

      baseHue = palette.hue;
      baseSat = palette.sat;
    },

    particle(i, G, out) {
      const x = G.x[i];
      const z = G.z[i];

      const dx1 = x - s1x;
      const dx2 = x - s2x;
      const d1 = Math.sqrt(dx1 * dx1 + z * z);
      const d2 = Math.sqrt(dx2 * dx2 + z * z);

      const w1 = (Math.sin(d1 * k - phase) * wA) / (1 + d1 * DECAY);
      const w2 = (Math.sin(d2 * k - phase) * wB) / (1 + d2 * DECAY);
      const interference = w1 + w2;
      const mag = interference < 0 ? -interference : interference;

      out.x = x;
      out.y = interference * amp;
      out.z = z;
      out.scale = 1 + mag * 0.7;

      // The theme turns "how energetic" into a lightness — bright on dark,
      // deep on light.
      shade(out.color, baseHue - interference * 0.12, baseSat * (0.55 + mag * 0.5), mag);
    },
  };
}
