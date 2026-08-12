# Particle Flux

A 20,000-instance Three.js particle field driven in realtime by a Deepgram voice
loop: **Flux** (streaming STT) for what you say, **Aura-2** (streaming TTS) for
what comes back. The same field renders three different ways — pick one from the
nav in the top-left.

The demo **echoes** each finished turn back to you, so you can see and hear both
halves of the conversation drive the particles without wiring up an LLM.

## Setup

```bash
npm install
cp .env.example .env      # then add your key from https://console.deepgram.com
npm run dev
```

Open <http://localhost:3031>, click **Start listening**, and talk.

Start talking again *while it's speaking* to see barge-in — Flux's `StartOfTurn`
cuts the response off instantly, and the field snaps back from magenta to green.

## The three visualizations

| Page | Mapping | What the audio does |
|---|---|---|
| `/` | [Dual-band interference](public/src/mappings/interference.js) | Low band drives Wave Source A, high band drives Source B, mid band pushes the sources apart. Vowels spread the fringes; consonants tighten them. |
| `/amplitude.html` | [Amplitude breathing](public/src/mappings/amplitude.js) | Distance from center is *age*, not space — each syllable is born at the origin and travels outward as a ring. |
| `/spectrum.html` | [Radial spectrum](public/src/mappings/spectrum.js) | A log-spaced FFT wrapped into a disc: 60 Hz at the center, 8 kHz at the rim. |

Conversation state drives the palette in all three: **green** while listening,
**violet** while thinking, **magenta** while speaking.

## How it fits together

```
                    ┌─ Flux STT  (/v2/listen)  ──┐
  mic ── worklet ───┤                            ├── conversation ─┬─ ui
                    └─ Aura-2 TTS (/v1/speak) ───┘     (state)     │
                                   │                               │
                       analyser taps ──── audio bus ──── viz ── mapping
```

* **`server/server.mjs`** — mints short-lived Deepgram tokens and serves
  `public/`. The API key never reaches the browser; audio never round-trips
  through this server, which matters because the visualization needs it at
  frame rate.
* **`src/conversation.js`** — the state machine (`idle → connecting → listening
  → thinking → speaking`), turn-taking, and barge-in, driven by Flux `TurnInfo`
  events.
* **`src/analyser.js`** — an `AnalyserNode` tap producing RMS, three speech
  bands, and a 64-bin log-spaced spectrum. Allocation-free after setup.
* **`src/audio-bus.js`** — picks the mic tap or the TTS tap based on state, then
  applies an asymmetric envelope (fast attack, slow release) so the field moves
  like a physical thing instead of strobing.
* **`src/viz.js`** — the shared Three.js scene and animation loop.
* **`src/mappings/*.js`** — the three strategies. Each answers one question per
  particle: where is it, and what color?

### Adding a fourth visualization

Write a module in `src/mappings/` exporting `createMapping()` with `prepare()`
and `particle()`, register it in the `MAPPINGS` map in `src/app.js`, add it to
`PAGES` in `src/ui.js`, and copy one of the HTML files.

### Swapping the echo for an LLM

`createConversation()` takes a `respond` option — see the commented seam in
`src/app.js`. It can return a string, a `Promise<string>`, or stream chunks
through `onChunk` so audio starts on the first finished sentence.

## Credits

The original particle swarm was exported from <https://casberry.in/> and is
preserved unmodified in [`reference/casberry-export.html`](reference/casberry-export.html).
The voice pipeline is ported from
[dg-edcharbeneau/voice-best-practices](https://github.com/dg-edcharbeneau/voice-best-practices/tree/main/examples/basic-html-js).
