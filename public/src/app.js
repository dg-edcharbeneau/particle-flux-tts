// Entry point, shared by all three pages.
//
// Each HTML page calls boot("<mapping id>"). Everything else — the voice
// pipeline, the audio bus, the particle field — is identical across pages.
//
// The wiring in one line: conversation state decides which analyser the bus
// reads, the bus feeds the visualization every frame, and the visualization
// asks the mapping what to draw.
//
//   Flux STT ─┐
//             ├─ conversation ── state ──┬─ audio bus ── viz ── mapping
//   Aura TTS ─┘                          └─ ui

import { createUI } from "./ui.js";
import { createConversation } from "./conversation.js";
import { createAudioBus } from "./audio-bus.js";
import { createViz } from "./viz.js";
import { applyServerConfig, TTS } from "./config.js";
import { applyThemeAttribute } from "./theme.js";

// Dynamic imports so each page ships only the mapping it actually uses.
const MAPPINGS = {
  interference: () => import("./mappings/interference.js"),
  amplitude: () => import("./mappings/amplitude.js"),
  spectrum: () => import("./mappings/spectrum.js"),
  resonance: () => import("./mappings/resonance.js"),
};

function friendlyError(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow the mic and try again.";
  }
  if (name === "NotFoundError") {
    return "No microphone was found. Plug one in and try again.";
  }
  return err?.message || "Something went wrong. Check the console for details.";
}

function preflight() {
  // Mic capture requires a secure context (https or localhost).
  if (!window.isSecureContext) {
    return "This demo needs a secure context. Open it over http://localhost or https://.";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "This browser doesn't support microphone capture (getUserMedia).";
  }
  if (typeof AudioWorkletNode === "undefined") {
    return "This browser doesn't support AudioWorklet.";
  }
  if (!window.WebGL2RenderingContext) {
    return "This browser doesn't support WebGL2, which the visualization needs.";
  }
  return null;
}

export async function boot(mappingId) {
  // Stamp the saved theme before anything renders. The CSS already follows
  // prefers-color-scheme on its own, so this only matters when the user's
  // stored choice differs from their OS setting.
  applyThemeAttribute();

  const load = MAPPINGS[mappingId];
  if (!load) throw new Error(`Unknown mapping "${mappingId}"`);

  // Both are independent, so fetch the server config while the mapping module
  // downloads. Must finish before the first socket opens, which it does — that
  // can't happen until the user clicks Start.
  const [mappingModule, models] = await Promise.all([load(), applyServerConfig()]);
  const mapping = mappingModule.createMapping();

  // Voice precedence, lowest to highest:
  //   built-in default  ->  DEEPGRAM_TTS_VOICE  ->  mapping.voice  ->  picker
  // A mapping may export `voice` to pair itself with a particular delivery, the
  // same way it may export `camera`. None do by default.
  if (mapping.voice) TTS.model = mapping.voice;
  console.info(
    `STT ${models.sttModel}  |  TTS ${TTS.model}` +
      ` (speed ${TTS.speed}, expressivity ${TTS.expressivity})`
  );

  const bus = createAudioBus();

  // The visualization runs regardless of whether a session is active — with no
  // audio source the bus decays to silence and the mappings idle gently, so the
  // page is never a black rectangle.
  const viz = createViz({ mapping, getAudio: (dt) => bus.sample(dt) });
  viz.start();

  const ui = createUI({
    mapping,
    voice: TTS.model,
    onStart: () => {
      ui.clearError();
      conversation.start();
    },
    onStop: () => conversation.stop(),
    onInterrupt: () => conversation.interruptResponse(),
    // connectTTS reads TTS.model at connect time, so this lands on the next
    // session without any further plumbing.
    onVoice: (id) => {
      TTS.model = id;
      console.info(`TTS voice -> ${id} (applies on next start)`);
    },
  });

  const conversation = createConversation({
    onState: (s) => {
      ui.setState(s);
      bus.setState(s);
      viz.setState(s);
    },
    onTranscript: (t) => ui.setTranscript(t),
    onLevel: (l) => ui.setLevel(l),
    onMicTap: (tap) => bus.setMicTap(tap),
    onTtsTap: (tap) => bus.setTtsTap(tap),
    onError: (err) => {
      console.error(err);
      ui.showError(friendlyError(err));
    },
    // respond: async (text, onChunk) => { ... },  // <- LLM goes here
  });

  const blocker = preflight();
  if (blocker) {
    ui.showError(blocker);
    ui.setState("error");
    viz.setState("error");
  } else {
    ui.setState("idle");
  }
}
