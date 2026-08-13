// The conversation orchestrator — the state machine that defines the voice UI's
// behavior, and (here) the thing that tells the visualization who is talking.
//
// States:
//   idle       - not connected; nothing captured
//   connecting - opening sockets / acquiring mic
//   listening  - mic live, waiting for or hearing the user
//   thinking   - user's turn ended; producing a response
//   speaking   - TTS audio is playing back
//   error      - something failed; surfaced to the user
//
// Turn-taking and barge-in are driven by Flux TurnInfo events. See
// handleSTTEvent below.
//
// Beyond the reference implementation this is ported from, it reports the mic
// and TTS analyser taps through onMicTap / onTtsTap so the audio bus can switch
// between them as the state changes.

import { getToken } from "./token.js";
import { startMic } from "./mic.js";
import { connectSTT } from "./stt.js";
import { connectTTS } from "./tts.js";
import { createPlayer } from "./player.js";
import { TTS } from "./config.js";
import { respell } from "./pronounce.js";

// The "response" seam. This demo echoes the user's finished turn back through
// TTS so the full realtime loop (mic -> STT -> turn detection -> TTS -> barge-in)
// is exercised without needing an LLM — and so you can hear and see both halves
// of the conversation drive the particles. Swap this for a call to your LLM: it
// may return a string, a Promise<string>, OR stream the reply chunk-by-chunk
// through the onChunk callback (respond(text, onChunk)) so audio can start on
// the first finished sentence instead of after the whole reply. A streaming
// responder should also cancel its own request on barge-in (the turn-index
// guard already stops any late chunks from being spoken).
const echoResponder = (finalTranscript) => finalTranscript;

// If a run of text arrives with no sentence boundary (a long list, a code
// block, a rambling clause), don't sit on it forever — flush at a word break
// once the buffer passes this length so audio keeps flowing.
const MAX_SPEAK_BUFFER = 240;

// Pull complete sentences out of a growing text buffer. A sentence ends at
// . ! ? … or a newline. While text is still streaming we only cut at a
// terminator that is *followed by whitespace*, so mid-token boundaries like
// "3.14" or "v1.2" aren't split. Returns the finished sentences plus the
// not-yet-complete remainder to carry into the next chunk.
function extractSentences(buf) {
  const sentences = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    const isTerminator = c === "." || c === "!" || c === "?" || c === "…";
    if (c === "\n" || isTerminator) {
      const next = buf[i + 1];
      // A newline is always a hard break; a terminator only counts once we can
      // see it's followed by whitespace (otherwise wait for the next chunk).
      if (c === "\n" || (next !== undefined && /\s/.test(next))) {
        const piece = buf.slice(start, i + 1).trim();
        if (piece) sentences.push(piece);
        start = i + 1;
      }
    }
  }
  return { sentences, rest: buf.slice(start) };
}

export function createConversation({
  onState,
  onTranscript,
  onLevel,
  onError,
  onMicTap,
  onTtsTap,
  respond = echoResponder,
}) {
  let state = "idle";
  let mic = null;
  let stt = null;
  let tts = null;
  let player = null;

  // Tracks the transcript of the turn currently in progress.
  let currentTurn = "";
  // Guards against a late response being spoken after the user barged in.
  let activeTurnIndex = -1;
  // True while the responder is still streaming this turn's reply. While it's
  // true, a drained audio queue is just a gap between sentences — not the end of
  // the turn — so we don't fall back to "listening" yet.
  let generating = false;
  // Flushes sent to TTS but not yet acknowledged with a "Flushed" control
  // message. Non-zero means more audio for this turn is still on its way, even
  // if the player has momentarily run dry.
  let outstandingFlushes = 0;

  function setState(next) {
    if (state === next) return;
    state = next;
    onState?.(state);
  }

  // --- barge-in ---------------------------------------------------------------
  // Abandon the in-flight response: invalidate the turn so a late (or still
  // streaming) reply is discarded, and cut audio locally AND on the server. Done
  // at the point of detection so the cut-off is instant. NaN never equals any
  // real turn index, so a pending commitTurn() reply — and any sentence still
  // arriving through onChunk — is guaranteed to be dropped.
  function interrupt() {
    if (state !== "speaking" && state !== "thinking") return;
    activeTurnIndex = Number.NaN;
    generating = false;
    outstandingFlushes = 0;
    // Read how much the listener actually heard BEFORE flushing — flush()
    // resets the player's timeline, and Flux TTS wants that offset to record
    // where the turn was cut. (The v1 Aura path ignores it.)
    const heardMs = player?.playedMs ?? 0;
    player?.flush();
    tts?.interrupt(heardMs);
  }

  // Decide whether playback for the current turn is truly finished. Because we
  // stream TTS sentence-by-sentence, the player queue empties between
  // sentences — that's a gap, not the end. We only return to "listening" once
  // ALL of these hold: the responder has stopped generating, every flush has
  // been acknowledged (so no more audio is coming), and the player has drained.
  function maybeSettle() {
    if (generating) return;
    if (outstandingFlushes > 0) return;
    if (player?.isPlaying) return;
    if (state === "speaking" || state === "thinking") setState("listening");
  }

  // Click-driven barge-in: the same cut-off as voice barge-in, but triggered by
  // the user pressing a Stop button instead of speaking, and it always drops us
  // back to "listening" (there's no incoming turn to do it for us).
  function interruptResponse() {
    if (state !== "speaking" && state !== "thinking") return;
    interrupt();
    setState("listening");
  }

  // --- Flux turn events -------------------------------------------------------
  function handleSTTEvent(msg) {
    if (msg.type !== "TurnInfo") return;

    switch (msg.event) {
      case "StartOfTurn":
        // The user began a new turn. If the agent was talking (or thinking),
        // cut it off.
        interrupt();
        currentTurn = "";
        setState("listening");
        onTranscript?.({ interim: "", committed: false });
        break;

      case "Update":
        // Interim transcription of the in-progress turn.
        currentTurn = msg.transcript || "";
        onTranscript?.({ interim: currentTurn, committed: false });
        break;

      case "EagerEndOfTurn":
        // Deepgram thinks the user *might* be done. A real app can start
        // preparing (e.g. fire the LLM request) here and cancel on TurnResumed.
        // For the echo demo there's nothing to pre-warm.
        break;

      case "TurnResumed":
        // False alarm — the user kept talking. Cancel anything we started
        // speaking speculatively.
        interrupt();
        setState("listening");
        break;

      case "EndOfTurn":
        // The user is done. Commit the turn and respond.
        currentTurn = msg.transcript || currentTurn;
        onTranscript?.({ interim: currentTurn, committed: true });
        commitTurn(msg.turn_index ?? -1, currentTurn);
        break;
    }
  }

  async function commitTurn(turnIndex, text) {
    const clean = (text || "").trim();
    if (!clean) {
      setState("listening");
      return;
    }
    activeTurnIndex = turnIndex;
    setState("thinking");
    generating = true;

    // Buffer streamed text and hand TTS one sentence at a time, so audio starts
    // as soon as the first sentence is ready instead of after the whole reply
    // finishes. Each sentence is a Speak + Flush; new chunks only ever *append*
    // audio — they never cut off what's already playing. Only a barge-in does
    // that (see interrupt).
    let pending = "";
    let streamed = false;

    // Send one speakable unit to TTS and count the flush so maybeSettle() knows
    // audio is still outstanding. Guards against speaking into a barged-in turn.
    const speak = (piece) => {
      const t = (piece || "").trim();
      if (!t || activeTurnIndex !== turnIndex) return;
      // Respell only what goes to the synthesizer — onTranscript has already
      // fired with the real words, so the overlay stays truthful.
      tts?.speak(respell(t));
      tts?.flush();
      outstandingFlushes++;
    };

    // Each streamed chunk: append, speak any newly-complete sentences, and keep
    // the trailing partial sentence for next time. The player flips us to
    // "speaking" as the first sentence's audio arrives.
    const onChunk = (chunk) => {
      if (activeTurnIndex !== turnIndex) return;
      streamed = true;
      pending += chunk;
      const { sentences, rest } = extractSentences(pending);
      pending = rest;
      for (const s of sentences) speak(s);
      // Long unpunctuated run: flush at the last word break so we don't stall.
      if (pending.length > MAX_SPEAK_BUFFER) {
        const cut = pending.lastIndexOf(" ");
        if (cut > 0) {
          speak(pending.slice(0, cut));
          pending = pending.slice(cut + 1);
        }
      }
    };

    try {
      const reply = await respond(clean, onChunk);
      // If the user barged in while we were generating, abandon this reply.
      if (activeTurnIndex !== turnIndex) return;
      // Speak whatever's left: the streamed tail, or — for a non-streaming
      // responder that never called onChunk (like echo) — the whole reply.
      speak(streamed ? pending : reply);
    } catch (err) {
      onError?.(err);
      setState("listening");
    } finally {
      // Only clear generating if this is still the active turn; a barge-in may
      // have already started a new one that now owns the flag.
      if (activeTurnIndex === turnIndex) {
        generating = false;
        maybeSettle();
      }
    }
  }

  // --- lifecycle --------------------------------------------------------------
  async function start() {
    if (state !== "idle" && state !== "error") return;
    setState("connecting");
    try {
      const token = await getToken();

      player = createPlayer({
        sampleRate: TTS.sampleRate,
        // Ignore stray audio that lands after a barge-in (activeTurnIndex is
        // NaN then); otherwise the first chunk of a sentence flips us to
        // "speaking". Fires once per sentence, but setState is idempotent.
        onStart: () => {
          if (!Number.isNaN(activeTurnIndex)) setState("speaking");
        },
        // The queue drains between sentences while we're still streaming, so we
        // can't treat "empty" as "done" — maybeSettle() decides.
        onEnd: () => maybeSettle(),
      });
      // Resume the audio context from within the click that called start().
      await player.resume();
      onTtsTap?.(player.tap);

      tts = connectTTS({
        token,
        onAudio: (buf) => player.enqueue(buf),
        // Deepgram acks each Flush with a "Flushed" once it has sent all the
        // audio for it. That's how we know the last sentence's audio is in the
        // player and the turn can settle.
        onControl: (msg) => {
          if (msg?.type === "Flushed" && outstandingFlushes > 0) {
            outstandingFlushes--;
            maybeSettle();
          }
        },
        onError: (e) => onError?.(e),
      });

      stt = connectSTT({
        token,
        onEvent: handleSTTEvent,
        onError: (e) => onError?.(e),
        onClose: () => {
          if (state !== "idle") stop();
        },
      });

      mic = await startMic({
        onFrame: (buf) => stt?.sendAudio(buf),
        onLevel: (lvl) => onLevel?.(lvl),
      });
      onMicTap?.(mic.tap);

      setState("listening");
    } catch (err) {
      onError?.(err);
      setState("error");
      await stop();
    }
  }

  async function stop() {
    // Full teardown. Order matters: stop capturing first.
    mic?.stop();
    stt?.finish();
    stt?.close();
    tts?.close();
    player?.close();
    mic = stt = tts = player = null;
    // Drop the taps — their AudioContexts are closed and reading them would
    // just return silence forever.
    onMicTap?.(null);
    onTtsTap?.(null);
    currentTurn = "";
    activeTurnIndex = -1;
    generating = false;
    outstandingFlushes = 0;
    setState("idle");
  }

  return {
    start,
    stop,
    interruptResponse,
    get state() {
      return state;
    },
  };
}
