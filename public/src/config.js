// Central configuration. Everything tunable lives here so the rest of the code
// reads like prose. Change models / rates / visual scale in one place.

export const DEEPGRAM_WS = "wss://api.deepgram.com";

// --- Speech-to-text: Deepgram Flux (/v2/listen) ------------------------------
// Flux is built for conversational turn-taking: it emits StartOfTurn,
// EagerEndOfTurn, TurnResumed and EndOfTurn events, which is exactly what a
// voice UI needs for VAD and barge-in — no manual endpointing math.
export const STT = {
  model: "flux-general-en",
  encoding: "linear16",
  sampleRate: 16000, // Flux recommends 16 kHz for raw linear16.
};

// --- Text-to-speech: Deepgram Aura-2 (/v1/speak) -----------------------------
// Streamed so playback — and therefore the visualization — starts on the first
// audio frame instead of waiting for the whole utterance.
export const TTS = {
  model: "aura-2-thalia-en",
  encoding: "linear16",
  sampleRate: 24000, // aura-2 streams 24 kHz linear16 cleanly.
};

// --- Microphone capture ------------------------------------------------------
// ~80 ms chunks are Deepgram's recommended streaming granularity: small enough
// for low latency, large enough to avoid per-packet overhead.
export const MIC = {
  targetSampleRate: STT.sampleRate,
  chunkMs: 80,
};

// Fetch a fresh token this many ms before the current one expires.
export const TOKEN_REFRESH_MARGIN_MS = 10_000;

// --- Audio analysis ----------------------------------------------------------
// One AnalyserNode is tapped into each audio graph (mic input and TTS output).
// `bins` is the log-spaced spectrum the visualizations read; 64 is plenty of
// resolution for a particle field and keeps the per-frame reduction cheap.
export const ANALYSIS = {
  fftSize: 1024,
  // Smoothing inside the AnalyserNode itself. Some smoothing here is free
  // (it happens in native code), but too much makes speech feel laggy.
  smoothing: 0.7,
  bins: 64,
  // Log-spaced spectrum range. Below 60 Hz is room rumble; above 8 kHz there's
  // almost nothing left in a 16/24 kHz speech stream.
  spectrumHz: [60, 8000],
  // Speech-oriented band split, used by the interference mapping.
  bands: {
    low: [80, 400], // fundamental / pitch
    mid: [400, 2000], // vowel formants
    high: [2000, 6000], // consonants, sibilance
  },
  // Envelope follower applied on top, in "fraction closed per second".
  // Fast attack so consonants punch; slower release so the field doesn't
  // strobe between syllables.
  attackPerSec: 60,
  releasePerSec: 8,
};

// --- Visualization -----------------------------------------------------------
export const VIZ = {
  count: 20000,
  span: 120, // world units across the particle grid
  size: 0.25, // tetrahedron radius
  lerpPerSec: 9, // how fast a particle chases its target position
  // Bloom is fill-rate hungry and 20k instances already cost us. Capping the
  // pixel ratio keeps retina displays smooth; raise it if you have headroom.
  maxPixelRatio: 1.5,
  bloom: { strength: 1.6, radius: 0.4, threshold: 0 },
  // The camera sweeps back and forth rather than orbiting continuously: it
  // travels `arcDegrees`, eases to a stop, and reverses. Motion is a pendulum
  // (sinusoidal), so the turnarounds decelerate instead of snapping.
  sweep: {
    arcDegrees: 180,
    periodSec: 40, // one full there-and-back cycle
    audioBoost: 1.5, // louder audio sweeps faster
  },
  // Base hue per conversation state. Mappings shift away from these, but the
  // field always reads as "who is talking right now".
  palette: {
    idle: { hue: 0.58, sat: 0.35, bloom: 1.0 },
    connecting: { hue: 0.58, sat: 0.5, bloom: 1.1 },
    listening: { hue: 0.44, sat: 0.9, bloom: 1.5 }, // Deepgram green
    thinking: { hue: 0.62, sat: 0.7, bloom: 1.3 }, // blue-violet
    speaking: { hue: 0.88, sat: 0.95, bloom: 1.9 }, // magenta
    error: { hue: 0.02, sat: 0.9, bloom: 1.2 }, // red
  },
};
