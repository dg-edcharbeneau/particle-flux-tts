// Streaming speech-to-text over a raw WebSocket to Deepgram Flux (/v2/listen).
//
// Why a raw WebSocket (and not the SDK)? The @deepgram/sdk v5 streaming clients
// authenticate with an HTTP Authorization header, which browsers are not allowed
// to set on a WebSocket. The browser-native way to authenticate is the
// Sec-WebSocket-Protocol subprotocol, which we do here with our short-lived
// token: `new WebSocket(url, ["bearer", token])`.
//
// Flux gives us turn-taking for free. It emits TurnInfo messages whose `event`
// is one of:
//   StartOfTurn     - user started speaking (use this to trigger barge-in)
//   Update          - more of the current turn was transcribed (interim text)
//   EagerEndOfTurn  - probably done; a chance to pre-warm a response
//   TurnResumed     - false alarm, the user kept talking (cancel any draft)
//   EndOfTurn       - user finished; commit the turn

import { DEEPGRAM_WS, STT } from "./config.js";

/**
 * @returns a controller: { sendAudio, finish, close }
 */
export function connectSTT({ token, onEvent, onOpen, onClose, onError }) {
  const params = new URLSearchParams({
    model: STT.model,
    encoding: STT.encoding,
    sample_rate: String(STT.sampleRate),
  });
  const ws = new WebSocket(`${DEEPGRAM_WS}/v2/listen?${params}`, ["bearer", token]);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => onOpen?.();
  ws.onclose = (e) => onClose?.(e);
  ws.onerror = () => onError?.(new Error("STT socket error"));
  ws.onmessage = (e) => {
    // Flux only ever sends JSON to the client.
    try {
      onEvent?.(JSON.parse(e.data));
    } catch {
      /* ignore non-JSON frames */
    }
  };

  return {
    /** Send one linear16 audio chunk. Never send empty frames — Deepgram treats
     *  a zero-length binary frame as a stream close. */
    sendAudio(buffer) {
      if (ws.readyState === WebSocket.OPEN && buffer.byteLength > 0) {
        ws.send(buffer);
      }
    },
    /** Flush and end the stream cleanly. */
    finish() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      }
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}
