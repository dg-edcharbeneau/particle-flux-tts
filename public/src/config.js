// Central configuration. Everything tunable lives here so the rest of the code
// reads like prose. Change models / rates / visual scale in one place.

export const DEEPGRAM_WS = "wss://api.deepgram.com";

// --- Speech-to-text: Deepgram Flux (/v2/listen) ------------------------------
// Flux is built for conversational turn-taking: it emits StartOfTurn,
// EagerEndOfTurn, TurnResumed and EndOfTurn events, which is exactly what a
// voice UI needs for VAD and barge-in — no manual endpointing math.
//
// `model` is only a fallback: the real value comes from DEEPGRAM_STT_MODEL in
// the server's .env, applied by applyServerConfig() below during boot.
export const STT = {
  model: "flux-general-en",
  encoding: "linear16",
  sampleRate: 16000, // Flux recommends 16 kHz for raw linear16.
};

// --- Text-to-speech: Deepgram Flux TTS (/v2/speak) ---------------------------
// Streamed so playback — and therefore the visualization — starts on the first
// audio frame instead of waiting for the whole utterance.
//
// Flux TTS is the current generation: streaming-first, expressive by default,
// with native interruption handling, which pairs naturally with Flux STT's
// turn detection. tts.js picks the endpoint from this name — `flux-*` voices
// go to /v2/speak, `aura*` voices fall back to /v1/speak (still the only
// option outside English).
//
// `model` is only a fallback: the real value comes from DEEPGRAM_TTS_VOICE in
// the server's .env, applied by applyServerConfig() below during boot.
export const TTS = {
  model: "flux-haley-en",
  encoding: "linear16",
  sampleRate: 24000, // valid on both endpoints (8k / 16k / 24k / 48k).
  // Flux TTS only; the v1 Aura endpoint ignores these. Server-clamped.
  speed: 1,
  expressivity: 0,
};

/**
 * Pull server-owned settings (.env) into the client config.
 *
 * Called once at boot, long before any socket opens. This mutates STT and TTS
 * in place rather than returning new objects, because stt.js, tts.js and
 * conversation.js import those bindings directly — mutating means the values
 * simply arrive, with no async config threaded through every module.
 *
 * A failure here is not fatal: we keep the built-in models and carry on, since
 * a missing config endpoint shouldn't take the whole demo down.
 *
 * @returns {Promise<{sttModel: string, ttsVoice: string}>} what's in effect
 */
export async function applyServerConfig() {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error(`config request failed (${res.status})`);
    const { ttsVoice, sttModel, ttsSpeed, ttsExpressivity } = await res.json();
    if (ttsVoice) TTS.model = ttsVoice;
    if (sttModel) STT.model = sttModel;
    if (Number.isFinite(ttsSpeed)) TTS.speed = ttsSpeed;
    if (Number.isFinite(ttsExpressivity)) TTS.expressivity = ttsExpressivity;
  } catch (err) {
    console.warn(
      `Could not load server config; using defaults (${STT.model}, ${TTS.model}).`,
      err
    );
  }
  return { sttModel: STT.model, ttsVoice: TTS.model };
}

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
  // Default camera — a low, near-horizon view (16.8° above the plane) placed so
  // the field runs off the bottom of the frame and well past both side edges.
  //
  // The angle is a deliberate compromise. For a *finite* field viewed from
  // outside it, filling the bottom of the frame and sitting near the horizon
  // pull against each other: at 11° the near edge lands mid-screen and leaves
  // roughly a third of the frame empty below it, and getting it lower without
  // raising the angle means standing among the particles. 16.8° fills the frame
  // while still reading as a view across the field rather than down onto it.
  //
  // Two other things that shaped this: a wider FOV counterintuitively *shrinks*
  // how much of the frame the field covers, so 60° stays; and apparent width
  // oscillates through the 180° sweep — the field overflows the frame face-on
  // and pulls in corner-on, which is inherent to orbiting a square.
  //
  // A mapping may export its own `camera` to override this.
  camera: [0, 26, 86],
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
  // Per-state hues, background, fog and bloom all live in ./theme.js, since
  // they differ between the light and dark themes.
};
