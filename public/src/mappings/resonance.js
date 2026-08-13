// Mapping 4 — Voice resonance.
//
// Built from the tuned wave-optics export in reference/audo-export.html, whose
// parameters are preserved verbatim below: well-separated sources and tight
// ripples (freq at maximum).
//
// The two sources are speakers in a conversation:
//
//   Source A (left)  = you        — green
//   Source B (right) = the agent  — magenta
//
// Only ever ONE of them is live. Flux's StartOfTurn cuts the agent off the
// instant you speak, and the audio bus exposes a single tap at a time, so the
// two sources share one envelope: `voice` is how loud the speaker is, and
// `side` crossfades that energy from one speaker to the other. Modelling it
// this way (rather than giving each source its own envelope) means total
// radiated strength is constant no matter who is talking, so peaks can be
// tuned right up to the edge of the frame without a handoff overshooting it.
//
// The crossfade is deliberately slow enough to see: a barge-in reads as the
// wavefield sweeping bodily across from magenta to green.
//
// The export's `decay` of 0.2 is the resting state, not a constant. Held fixed
// it attenuates to 1/9 by 40 units out, so in a 120-unit field only a small
// blob near the sources ever moves. Here decay falls toward 0.03 as the voice
// rises, so a loud voice literally carries further and the wavefronts sweep the
// whole field.

import { getTheme, shade } from "../theme.js";

// Straight from the export's PARAMS block.
const TUNED = {
  freq: 20,
  speed: 7.4,
  srcDist: 18.64,
  amp: 15,
  decay: 0.2,
};

const BASE_K = TUNED.freq * 0.2; // the export's `k = freq * 0.2`

// Conversational speech RMS usually sits around 0.1-0.2, so lift it into a
// usable 0..1 envelope.
const DRIVE_GAIN = 5.5;
const ATTACK_PER_SEC = 25;
const RELEASE_PER_SEC = 3; // slow, so a finished turn lingers a moment

// How fast energy slides from one speaker to the other. Slow enough to read as
// a sweep across the field rather than a snap.
const HANDOFF_PER_SEC = 5;

// Idle radiation, so the field breathes when nobody is talking.
const IDLE_STRENGTH = 0.15;

// Height: calm at rest, rising to roughly a quarter of the field's width at
// full voice. Seen from the near-horizon camera the wavefront is edge-on, so
// crests read far taller than the same number did looking down at the plane.
const IDLE_AMP = 1.5;
const PEAK_AMP = 17;

// Spatial reach. At rest the export's tight lobes; under voice the wavefronts
// travel across the entire field.
const IDLE_DECAY = TUNED.decay; // 0.2
const VOICED_DECAY = 0.03;

// Crest exaggeration. A plain linear amplitude scales the whole field
// uniformly, so ripples grow but never *spike*. This boosts each particle in
// proportion to how displaced it already is: near-flat regions are left alone
// (keeping the field broad) while crests leap out of the plane.
const CREST_BOOST = 0.45;

// Crests also inflate particle size, and unbounded that turns the brightest
// ridges into a single blown-out blob once bloom is applied. Cap the growth.
const MAX_CREST = 2.4;

export function createMapping() {
  let voice = 0; // loudness of whoever currently holds the floor
  let side = 0; // 0 = you (Source A), 1 = the agent (Source B)

  let s1x = -TUNED.srcDist / 2;
  let s2x = TUNED.srcDist / 2;
  let k = BASE_K;
  let amp = IDLE_AMP;
  let decay = IDLE_DECAY;
  let strengthA = IDLE_STRENGTH;
  let strengthB = IDLE_STRENGTH;
  let phase = 0;

  // Hue blends two views of "who owns this particle": `side` (who is talking)
  // and the local wavefront balance. Local alone isn't enough — the silent
  // source still idle-radiates, and near it its own wavefront wins locally, so
  // half the field would read as the wrong speaker. We lean on `side` while one
  // speaker holds the floor and swing to local mid-handoff, which is what makes
  // the crossfade read as a moving front rather than a global colour fade.
  let localWeight = 0.25;

  // Both speakers are on screen at once, so this mapping needs two hues rather
  // than just the current state's. Re-read each frame so a theme switch takes
  // effect — the light theme uses a blue pair (cyan / violet) in place of the
  // dark theme's green / magenta.
  let hueA = 0.44; // you
  let hueSpan = 0.44; // distance to the agent's hue

  const follow = (current, target, dt) => {
    const rate = target > current ? ATTACK_PER_SEC : RELEASE_PER_SEC;
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  };

  return {
    id: "resonance",
    title: "Voice resonance",

    // No camera override: crests now stay low enough for the shared
    // near-horizon view, where they read as a wavefront seen edge-on.

    blurb:
      "Two speakers in dialogue: your voice radiates from the left in green, the agent's from the right in magenta. Only one ever holds the floor — watch the field sweep across on a barge-in.",

    prepare(audio, time, dt) {
      const pal = getTheme().palette;
      hueA = pal.listening.hue;
      hueSpan = pal.speaking.hue - hueA;

      const live = audio.source === "mic" || audio.source === "tts";
      voice = follow(voice, live ? Math.min(1, audio.rms * DRIVE_GAIN) : 0, dt);

      // Slide toward whichever speaker is live; hold position through silence
      // so the field stays tinted by whoever spoke last.
      if (live) {
        const target = audio.source === "tts" ? 1 : 0;
        side += (target - side) * (1 - Math.exp(-HANDOFF_PER_SEC * dt));
      }

      // One voice, split between the sources — so the total is always
      // 2*IDLE_STRENGTH + voice regardless of who is speaking or mid-handoff.
      strengthA = IDLE_STRENGTH + voice * (1 - side);
      strengthB = IDLE_STRENGTH + voice * side;

      // Mid-handoff both sources are comparably lit, which is the one time the
      // local balance genuinely means something.
      const straddle = 1 - Math.abs(2 * side - 1);
      localWeight = 0.25 + straddle * 0.6;

      // The speakers physically pull apart as the voice rises.
      const srcDist = TUNED.srcDist * (1 + voice * 0.55);
      s1x = -srcDist / 2;
      s2x = srcDist / 2;

      // Sibilance tightens the ripples hard around the tuned value.
      k = BASE_K + audio.high * 3;

      amp = IDLE_AMP + voice * (PEAK_AMP - IDLE_AMP);

      // The big one for visibility: a voice pushes energy out across the field.
      // Reach opens on sqrt(voice) rather than linearly — height and reach
      // multiply, so scaling both linearly makes the response quadratic and
      // soft speech barely registers.
      decay = IDLE_DECAY + Math.sqrt(voice) * (VOICED_DECAY - IDLE_DECAY);

      // Accumulated, not time*speed — speed is modulated, and multiplying a
      // moving speed by absolute time makes the wavefront jump.
      phase += dt * TUNED.speed * (1 + voice * 0.6);
    },

    particle(i, G, out) {
      const x = G.x[i];
      const z = G.z[i];

      const dx1 = x - s1x;
      const dx2 = x - s2x;
      const d1 = Math.sqrt(dx1 * dx1 + z * z);
      const d2 = Math.sqrt(dx2 * dx2 + z * z);

      const w1 = (Math.sin(d1 * k - phase) * strengthA) / (1 + d1 * decay);
      const w2 = (Math.sin(d2 * k - phase) * strengthB) / (1 + d2 * decay);
      const interference = w1 + w2;
      const rawMag = interference < 0 ? -interference : interference;

      // Super-linear crest boost — see CREST_BOOST. Left as a multiply-add
      // rather than a Math.pow, which at 20k particles a frame would cost more
      // than the rest of the mapping combined.
      const shaped = interference * (1 + rawMag * CREST_BOOST);

      // Half-wave: the surface only ever sits at or above the base plane.
      // Troughs flatten into still water and the crests read as jets rising out
      // of it, which is the fountain the tuned export was reaching for.
      //
      // Chosen over |v| or v² deliberately: both of those fold the troughs
      // upward and so double the spatial frequency, and the fringes are already
      // finer than the particle grid can resolve (~1.9 particles per
      // wavelength). Clamping leaves the frequency alone.
      //
      // `mag` is the clamped value, not |shaped| — a particle parked at base
      // should be small and dim, not still full-size and glowing.
      const mag = shaped > 0 ? shaped : 0;

      out.x = x;
      out.y = mag * amp;
      out.z = z;
      out.scale = 0.5 + (mag < MAX_CREST ? mag : MAX_CREST) * 2.0;

      // 0 = you, 1 = the agent. The hue lerp is deliberately linear rather than
      // shortest-arc, so the blend runs green -> cyan -> blue -> violet ->
      // magenta where the fields meet.
      const a1 = w1 < 0 ? -w1 : w1;
      const a2 = w2 < 0 ? -w2 : w2;
      const localT = a2 / (a1 + a2 + 1e-6);
      const t = side + (localT - side) * localWeight;

      shade(out.color, hueA + hueSpan * t, 0.6 + mag * 0.4, mag);
    },
  };
}
