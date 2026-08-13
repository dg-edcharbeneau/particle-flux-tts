// Light / dark theming for both the overlay and the 3D scene.
//
// The CSS side is ordinary tokens. The scene side needs real thought, because
// the dark look leans on two light-on-dark techniques that invert badly:
//
//   * Particles read energy as brightness — dim at rest, brilliant at peak.
//     Both themes keep that direction; the light theme just raises the floor,
//     using a mid-tone backdrop so there is still headroom above it to glow
//     into. A near-white backdrop would force the opposite (energy going dark),
//     which loses the glow entirely.
//
//   * Bloom is a glow, and UnrealBloomPass at threshold 0 blooms everything —
//     including the backdrop. Each theme therefore carries its own threshold,
//     set above its own background luminance so only particles glow.
//
// This module is imported by the mappings, which the Node test harness also
// loads, so every browser API here is optional-chained or wrapped.

const STORAGE_KEY = "particle-flux-theme";

export const THEMES = {
  dark: {
    id: "dark",
    label: "Dark",
    background: 0x000000,
    // Flat black on purpose — a gradient here would only band and dither, and
    // the glow already supplies all the depth this theme needs.
    gradient: null,
    // Trails fade toward this along their length. Black here, so a tail simply
    // dissolves into the backdrop the way a comet's does — a "shadow" on black
    // would be nothing at all.
    trailColor: 0x000000,
    fogDensity: 0.0075,
    bloomScale: 1,
    bloomThreshold: 0, // nothing to protect — the backdrop is black
    // Energy 0 -> a dim but present glow; energy 1 -> brilliant.
    //
    // The floor is not 0. Below about 0.15 the resting field disappears into
    // the backdrop entirely and the page is a black rectangle until someone
    // speaks — worst for the violet/indigo states, since blue carries only 7%
    // of luminance. The original casberry export used 0.15 for the same reason.
    lightness: { base: 0.17, range: 0.39 },
    saturation: 1,
    palette: {
      idle: { hue: 0.58, sat: 0.35, bloom: 1.0 },
      connecting: { hue: 0.58, sat: 0.5, bloom: 1.1 },
      listening: { hue: 0.44, sat: 0.9, bloom: 1.5 }, // Deepgram green
      thinking: { hue: 0.62, sat: 0.7, bloom: 1.3 }, // blue-violet
      speaking: { hue: 0.88, sat: 0.95, bloom: 1.9 }, // magenta
      error: { hue: 0.02, sat: 0.9, bloom: 1.2 }, // red
    },
  },

  light: {
    id: "light",
    label: "Light",
    // A mid-tone slate blue, not near-white. Against a near-white backdrop the
    // only way for a particle to stand out is to go *darker*, which throws away
    // the glow this whole system is built on. Dropping the backdrop to a middle
    // value leaves headroom above it, so particles brighten into it exactly as
    // they do on black — the light theme is now the dark theme with the floor
    // raised, rather than an inversion of it.
    background: 0x6b86a8,
    // Painted behind everything as a screen-space texture. `background` above
    // stays the flat fallback and, more importantly, the fog colour — fog can
    // only blend toward one colour, so it matches the gradient's midpoint,
    // which is roughly where the horizon and the far field sit.
    gradient: {
      top: "#43587a", // deepest at the top of the sky
      mid: "#6b86a8", // meets the horizon
      midStop: 0.58,
      bottom: "#93aac6", // lifts again in the near foreground
      // Soft horizontal light streaks. Off — the clean gradient reads better
      // behind the particles. Entries take the shape
      // { at, thickness, alpha }, with `at` and `thickness` as fractions of
      // screen height measured from the top.
      bands: [],
    },
    // A deep navy, so a falling particle drags a genuine shadow across the
    // pale ground rather than fading out invisibly.
    trailColor: 0x16243c,
    fogDensity: 0.0065,
    // Bloom stays on, but the threshold has to clear the backdrop's own
    // luminance (~0.27) or the pass blooms the background itself and greys the
    // whole frame. 0.6 lets only genuine peaks glow.
    bloomScale: 0.7,
    bloomThreshold: 0.6,
    // Energy 0 -> a soft tint just above the backdrop; energy 1 -> near-white.
    //
    // The floor sits high on purpose. A mid-tone backdrop can hide a particle
    // from *either* side, and violet/indigo are the trap: at a lower floor they
    // land on almost exactly the backdrop's luminance and disappear. 0.75 keeps
    // every state brighter than the ground, so none of them can cross it.
    lightness: { base: 0.75, range: 0.22 },
    saturation: 0.85,
    // A blue family throughout, but spread far enough apart that the
    // conversation states stay tellable: cyan for you, violet for the agent.
    palette: {
      idle: { hue: 0.6, sat: 0.3, bloom: 1.0 },
      connecting: { hue: 0.6, sat: 0.45, bloom: 1.0 },
      listening: { hue: 0.52, sat: 0.85, bloom: 1.0 }, // cyan-blue
      thinking: { hue: 0.66, sat: 0.7, bloom: 1.0 }, // indigo
      speaking: { hue: 0.78, sat: 0.85, bloom: 1.0 }, // blue-violet
      error: { hue: 0.02, sat: 0.8, bloom: 1.0 }, // red, for legibility
    },
  },
};

function preferred() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* no storage (private mode, or Node) — fall through */
  }
  // Match the OS when the user hasn't chosen. Mirrors the CSS default, so the
  // overlay and the scene agree on the very first frame.
  return globalThis.matchMedia?.("(prefers-color-scheme: light)")?.matches
    ? "light"
    : "dark";
}

let activeId = preferred();
const listeners = new Set();

export const getTheme = () => THEMES[activeId];
export const getThemeId = () => activeId;

/** Stamp the root element so the CSS tokens switch. Safe to call repeatedly. */
export function applyThemeAttribute() {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = activeId;
  }
}

export function setTheme(id) {
  if (!THEMES[id] || id === activeId) return;
  activeId = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
  applyThemeAttribute();
  for (const fn of listeners) fn(THEMES[activeId]);
}

export const toggleTheme = () => setTheme(activeId === "dark" ? "light" : "dark");

/** Subscribe to theme changes. Returns an unsubscribe function. */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Write a themed colour into `color`.
 *
 * Mappings describe a particle as hue + saturation + how energetic it is, and
 * let the theme decide what "energetic" looks like. That keeps the light/dark
 * inversion in one place instead of four, and costs exactly what the old
 * direct setHSL call did.
 *
 * @param {{setHSL: Function}} color  mutated in place
 * @param {number} hue                0..1, wrapped by setHSL
 * @param {number} sat                0..1 before the theme's own scaling
 * @param {number} energy             0..1, clamped
 */
export function shade(color, hue, sat, energy) {
  const t = THEMES[activeId];
  const e = energy > 1 ? 1 : energy < 0 ? 0 : energy;
  const s = sat * t.saturation;
  return color.setHSL(
    hue,
    s > 1 ? 1 : s < 0 ? 0 : s,
    t.lightness.base + t.lightness.range * e
  );
}
