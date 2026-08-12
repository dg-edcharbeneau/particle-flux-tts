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
  console.log(`  Token TTL: ${TOKEN_TTL_SECONDS}s  |  API key: server-side only\n`);
});
