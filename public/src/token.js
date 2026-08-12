// Fetches short-lived Deepgram tokens from our own server.
//
// Key security: the browser never holds the API key. It asks our server for a
// token that is scoped and expires in seconds. We fetch a fresh token
// immediately before each WebSocket connect, because a token only needs to be
// valid for the handshake — once a socket is open, the token expiring does not
// close it.

import { TOKEN_REFRESH_MARGIN_MS } from "./config.js";

let cached = null; // { access_token, expiresAt }

/**
 * Return a valid token, fetching a new one if we don't have a fresh cached one.
 * Reusing a still-valid token avoids hammering the grant endpoint when both the
 * STT and TTS sockets connect back-to-back.
 */
export async function getToken() {
  const now = Date.now();
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
    return cached.access_token;
  }

  const res = await fetch("/api/token", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status})`);
  }
  const { access_token, expires_in } = await res.json();
  if (!access_token) {
    throw new Error("Token response missing access_token");
  }

  cached = {
    access_token,
    expiresAt: now + (expires_in ?? 30) * 1000,
  };
  return access_token;
}
