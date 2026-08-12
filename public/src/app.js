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

// Dynamic imports so each page ships only the mapping it actually uses.
const MAPPINGS = {
  interference: () => import("./mappings/interference.js"),
  amplitude: () => import("./mappings/amplitude.js"),
  spectrum: () => import("./mappings/spectrum.js"),
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
  const load = MAPPINGS[mappingId];
  if (!load) throw new Error(`Unknown mapping "${mappingId}"`);
  const mapping = (await load()).createMapping();

  const bus = createAudioBus();

  // The visualization runs regardless of whether a session is active — with no
  // audio source the bus decays to silence and the mappings idle gently, so the
  // page is never a black rectangle.
  const viz = createViz({ mapping, getAudio: (dt) => bus.sample(dt) });
  viz.start();

  const ui = createUI({
    mapping,
    onStart: () => {
      ui.clearError();
      conversation.start();
    },
    onStop: () => conversation.stop(),
    onInterrupt: () => conversation.interruptResponse(),
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
