// -----------------------------------------------------------------------------
// Token + static server
//
// The Deepgram API key NEVER reaches the browser. This tiny Node server does
// two jobs:
//   1. GET /api/token  -> mint a short-lived Deepgram token for the browser
//   2. serve the static files in ../public
//
// The browser then opens WebSockets DIRECTLY to Deepgram using that short-lived
// token, so audio never round-trips through this server — which matters here,
// because the visualization needs the audio at frame rate.
//
// The Deepgram SDK (@deepgram/sdk) is used here, server-side, because its v5
// streaming clients authenticate with HTTP headers that browsers cannot set.
// Minting tokens is exactly the job the SDK is best suited for on the server.
// -----------------------------------------------------------------------------

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { DeepgramClient } from "@deepgram/sdk";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

const PORT = Number(process.env.PORT || 3031);
const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 60);
const API_KEY = process.env.DEEPGRAM_API_KEY;

// Model selection lives here rather than in the client config so it can be
// changed with a server restart instead of a code edit. The browser picks these
// up from /api/config at boot.
const DEFAULT_TTS_VOICE = "flux-haley-en";
const DEFAULT_STT_MODEL = "flux-general-en";
const TTS_VOICE = process.env.DEEPGRAM_TTS_VOICE?.trim() || DEFAULT_TTS_VOICE;

// Delivery controls, Flux TTS only. Clamped here rather than trusted: an
// out-of-range value is rejected by Deepgram at connect time, which surfaces as
// a dead TTS socket rather than anything that points at the .env file.
function clampEnv(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`  Warning: ${name}="${raw}" is not a number; using ${fallback}.`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, n));
  if (clamped !== n) {
    console.warn(`  Warning: ${name}=${n} is outside ${min}..${max}; using ${clamped}.`);
  }
  return clamped;
}
const TTS_SPEED = clampEnv("DEEPGRAM_TTS_SPEED", 1, 0.85, 1.15);
const TTS_EXPRESSIVITY = clampEnv("DEEPGRAM_TTS_EXPRESSIVITY", 0, -2, 2);
const STT_MODEL = process.env.DEEPGRAM_STT_MODEL?.trim() || DEFAULT_STT_MODEL;

// Turn-taking here is driven entirely by Flux's TurnInfo events. Another model
// will still transcribe, but StartOfTurn/EndOfTurn never arrive, so turns never
// commit and barge-in stops working — worth saying out loud rather than letting
// it look like a broken demo.
if (!STT_MODEL.startsWith("flux-")) {
  console.warn(
    `\n  Warning: DEEPGRAM_STT_MODEL="${STT_MODEL}" is not a Flux model.\n` +
      `  Turn detection and barge-in rely on Flux TurnInfo events and will not fire.\n`
  );
}

if (!API_KEY) {
  console.error(
    "\n  Missing DEEPGRAM_API_KEY.\n" +
      "  Copy .env.example to .env and set your key from https://console.deepgram.com\n"
  );
  process.exit(1);
}

// The SDK reads DEEPGRAM_API_KEY from the environment by default; we pass it
// explicitly to keep the dependency obvious.
const deepgram = new DeepgramClient({ apiKey: API_KEY });

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

// --- GET /api/token ----------------------------------------------------------
// Returns { access_token, expires_in }. The browser uses access_token as the
// "bearer" WebSocket subprotocol when connecting to Deepgram.
async function handleToken(res) {
  try {
    const result = await deepgram.auth.v1.tokens.grant({
      ttl_seconds: TOKEN_TTL_SECONDS,
    });
    send(res, 200, JSON.stringify(result), {
      "Content-Type": "application/json; charset=utf-8",
      // Tokens are per-session secrets: never let a proxy or the browser cache them.
      "Cache-Control": "no-store",
    });
  } catch (err) {
    console.error("Failed to grant token:", err);
    send(res, 502, JSON.stringify({ error: "token_grant_failed" }), {
      "Content-Type": "application/json; charset=utf-8",
    });
  }
}

// --- GET /api/config ---------------------------------------------------------
// Server-owned settings the browser needs. Nothing secret goes in here — it is
// world-readable, so it carries model names and nothing else.
function handleConfig(res) {
  const body = {
    ttsVoice: TTS_VOICE,
    sttModel: STT_MODEL,
    ttsSpeed: TTS_SPEED,
    ttsExpressivity: TTS_EXPRESSIVITY,
  };
  send(res, 200, JSON.stringify(body), {
    "Content-Type": "application/json; charset=utf-8",
    // no-store so editing .env and restarting takes effect on a plain reload.
    "Cache-Control": "no-store",
  });
}

// --- static files ------------------------------------------------------------
async function handleStatic(req, res) {
  // Resolve within PUBLIC_DIR and reject path traversal.
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = normalize(join(PUBLIC_DIR, relPath));

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    return send(res, 403, "Forbidden");
  }

  try {
    const data = await readFile(filePath);
    const type = CONTENT_TYPES[extname(filePath)] || "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  } catch {
    send(res, 404, "Not found");
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url.split("?")[0] === "/api/token") {
    return handleToken(res);
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/config") {
    return handleConfig(res);
  }
  if (req.method === "GET") {
    return handleStatic(req, res);
  }
  send(res, 405, "Method not allowed");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${PORT} is already in use.\n` +
        `  Something else (another server, Docker, etc.) is listening there.\n` +
        `  Free it, or start on a different port:\n\n` +
        `      PORT=3100 npm run dev\n\n` +
        `  (or set PORT in your .env file)\n`
    );
  } else {
    console.error("\n  Server failed to start:", err.message, "\n");
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  Particle Flux running:`);
  console.log(`  → http://localhost:${PORT}/            interference`);
  console.log(`  → http://localhost:${PORT}/amplitude.html  amplitude`);
  console.log(`  → http://localhost:${PORT}/spectrum.html   spectrum\n`);
  const dflt = (v) => (v ? "" : "  (default)");
  // The voice name decides the endpoint, so show which one it resolved to —
  // it's the difference between Flux TTS and the older Aura API.
  const speak = TTS_VOICE.startsWith("flux-") ? "/v2/speak" : "/v1/speak";
  console.log(`  STT:   ${STT_MODEL}  →  /v2/listen${dflt(process.env.DEEPGRAM_STT_MODEL?.trim())}`);
  console.log(`  Voice: ${TTS_VOICE}  →  ${speak}${dflt(process.env.DEEPGRAM_TTS_VOICE?.trim())}`);
  if (speak === "/v2/speak") {
    console.log(`  Delivery: speed ${TTS_SPEED}, expressivity ${TTS_EXPRESSIVITY}`);
  }
  console.log(`  Token TTL: ${TOKEN_TTL_SECONDS}s  |  API key: server-side only\n`);
});
