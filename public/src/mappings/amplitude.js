// Mapping 2 — Amplitude breathing.
//
// The simplest signal (overall loudness) made legible by adding time: instead
// of every particle reacting to the *current* level, a particle's distance from
// the center selects how far *into the past* it reads.
//
//   center -> right now
//   rim    -> ~3 seconds ago
//
// So each syllable is born at the origin and travels outward as a visible ring.
// A sentence becomes a series of expanding wavefronts you can literally count,
// and the gaps between phrases show up as smooth water. This reads far better
// than mapping loudness to a single global height, where speech just looks like
// uniform jitter.

import { shade } from "../theme.js";

const HISTORY = 200; // samples retained
const STEP = 1 / 60; // seconds per sample — fixed, so ring speed is frame-rate independent

export function createMapping() {
  const history = new Float32Array(HISTORY);
  let head = 0;
  let accum = 0;

  let amp = 24;
  let baseHue = 0.5;
  let baseSat = 1;
  let idlePhase = 0;

  return {
    id: "amplitude",
    title: "Amplitude breathing",
    blurb:
      "Loudness over time, rendered as rings. Each syllable is born at the center and travels outward — distance from the middle is age.",

    prepare(audio, time, dt, palette) {
      // Advance the ring buffer on a fixed clock. dt is clamped upstream to
      // 0.1s, so this loop runs at most 6 times.
      accum += dt;
      while (accum >= STEP) {
        head = (head + 1) % HISTORY;
        // A little of the mid band on top of RMS: it makes vowels read as
        // fuller rings than a plain amplitude envelope does.
        history[head] = Math.min(1, audio.rms * 1.6 + audio.mid * 0.4);
        accum -= STEP;
      }

      amp = 24;
      baseHue = palette.hue;
      baseSat = palette.sat;
      idlePhase = time * 1.1;
    },

    particle(i, G, out) {
      const nr = G.nr[i];

      // Age in samples, from the ring buffer.
      const age = (nr * (HISTORY - 1)) | 0;
      let idx = head - age;
      if (idx < 0) idx += HISTORY;
      const v = history[idx];

      // Rings lose energy as they travel, so the field doesn't look like a
      // rigid corrugated sheet all the way to the rim.
      const falloff = 1 - nr * 0.55;
      const level = v * falloff;

      // A slow swell keeps the surface alive during silence.
      const idle = Math.sin(nr * 9 - idlePhase) * 0.5;

      out.x = G.x[i];
      out.y = level * amp + idle;
      out.z = G.z[i];
      out.scale = 0.7 + level * 1.8;

      shade(out.color, baseHue + level * 0.1, baseSat * (0.5 + level * 0.6), level);
    },
  };
}
