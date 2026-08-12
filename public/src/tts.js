// Streaming text-to-speech over a raw WebSocket to Deepgram Aura-2 (/v1/speak).
//
// Same auth story as STT: browser-native subprotocol auth with a short-lived
// token. We use a raw WebSocket here for a second reason too — the SDK's Speak
// socket JSON-parses every incoming frame, so it can't hand us the *binary*
// audio. Here we set binaryType = "arraybuffer" and treat binary frames as
// audio (linear16 PCM) and text frames as JSON control messages
// (Metadata / Flushed / Cleared / Warning).
//
// Control messages we send:
//   Speak  { text }  - queue text to synthesize
//   Flush            - force synthesis of everything buffered so far
//   Clear            - drop server-side buffered audio (used for barge-in)
//   Close            - close the stream

import { DEEPGRAM_WS, TTS } from "./config.js";

export function connectTTS({ token, onAudio, onOpen, onClose, onError, onControl }) {
  const params = new URLSearchParams({
    model: TTS.model,
    encoding: TTS.encoding,
    sample_rate: String(TTS.sampleRate),
  });
  const ws = new WebSocket(`${DEEPGRAM_WS}/v1/speak?${params}`, ["bearer", token]);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => onOpen?.();
  ws.onclose = (e) => onClose?.(e);
  ws.onerror = () => onError?.(new Error("TTS socket error"));
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      onAudio?.(e.data); // linear16 PCM
    } else {
      try {
        onControl?.(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    }
  };

  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  return {
    /** Queue text. Empty text returns a 400 from Deepgram, so we guard it. */
    speak(text) {
      const t = (text ?? "").trim();
      if (t) send({ type: "Speak", text: t });
    },
    flush() {
      send({ type: "Flush" });
    },
    /** Barge-in: tell the server to discard audio it hasn't sent yet. */
    clear() {
      send({ type: "Clear" });
    },
    close() {
      send({ type: "Close" });
      try {
        ws.close();
      } catch {}
    },
  };
}
