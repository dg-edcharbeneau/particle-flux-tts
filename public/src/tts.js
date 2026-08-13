// Streaming text-to-speech over a raw WebSocket to Deepgram.
//
// Two generations of the API are supported, chosen automatically from the
// configured voice:
//
//   flux-*  ->  /v2/speak  (Flux TTS — streaming-first, native interruption)
//   aura*   ->  /v1/speak  (Aura / Aura-2 — still the only option outside English)
//
// Flux TTS is English-only at the time of writing, so the Aura path stays for
// non-English voices. The protocols are close but not identical, and the
// difference that matters here is barge-in:
//
//   v1: { type: "Clear" }      — drop buffered audio
//   v2: { type: "Interrupt", playback_offset: {...} }
//                              — drop it AND tell the server how much of the
//                                turn the listener actually heard
//
// Why a raw WebSocket at all? Browser-native subprotocol auth with a
// short-lived token, and — unlike the SDK's Speak socket, which JSON-parses
// every incoming frame — we need the *binary* audio. So binaryType is
// "arraybuffer": binary frames are audio (linear16 PCM), text frames are JSON
// control messages.

import { DEEPGRAM_WS, TTS } from "./config.js";

/** Flux TTS lives on /v2/speak; everything else is the v1 Aura endpoint. */
export function isFluxVoice(model) {
  return typeof model === "string" && model.startsWith("flux-");
}

export function connectTTS({ token, onAudio, onOpen, onClose, onError, onControl }) {
  const flux = isFluxVoice(TTS.model);
  const params = new URLSearchParams({
    model: TTS.model,
    encoding: TTS.encoding,
    sample_rate: String(TTS.sampleRate),
  });
  // Delivery controls exist only on v2. Sending them to v1 would be rejected,
  // and sending defaults is just noise, so both are conditional.
  if (flux) {
    if (TTS.speed !== 1) params.set("speed", String(TTS.speed));
    if (TTS.expressivity !== 0) params.set("expressivity", String(TTS.expressivity));
  }
  const path = flux ? "/v2/speak" : "/v1/speak";
  const ws = new WebSocket(`${DEEPGRAM_WS}${path}?${params}`, ["bearer", token]);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => onOpen?.();
  ws.onclose = (e) => onClose?.(e);
  ws.onerror = () => onError?.(new Error("TTS socket error"));
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      onAudio?.(e.data); // linear16 PCM
      return;
    }
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    // v2 has an explicit fatal Error message; surface it rather than letting
    // the socket just go quiet.
    if (msg?.type === "Error") {
      onError?.(new Error(msg.description || msg.message || "TTS error"));
    }
    onControl?.(msg);
  };

  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  return {
    /** Which wire protocol this socket ended up on — handy for logging. */
    endpoint: path,

    /** Queue text. Empty text returns a 400 from Deepgram, so we guard it. */
    speak(text) {
      const t = (text ?? "").trim();
      if (t) send({ type: "Speak", text: t });
    },

    /** End the active turn: drain the buffer and synthesize what's left. */
    flush() {
      send({ type: "Flush" });
    },

    /**
     * Barge-in — discard audio the server hasn't sent yet.
     *
     * @param {number} [heardMs] how much of the turn actually reached the
     *   listener's ears. v2 uses it to record where the speech was cut; v1 has
     *   no equivalent and ignores it.
     */
    interrupt(heardMs) {
      if (!flux) {
        send({ type: "Clear" });
        return;
      }
      const msg = { type: "Interrupt" };
      if (Number.isFinite(heardMs)) {
        msg.playback_offset = {
          type: "time_ms",
          value: Math.max(0, Math.round(heardMs)),
        };
      }
      send(msg);
    },

    close() {
      send({ type: "Close" });
      try {
        ws.close();
      } catch {}
    },
  };
}
