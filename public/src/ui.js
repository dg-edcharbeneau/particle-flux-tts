// The overlay that sits on top of the particle canvas.
//
// All DOM reads/writes live here so the rest of the code stays framework-free.
// The markup is built in JS rather than duplicated across the three HTML pages,
// which keeps those files down to "which mapping am I?" and stops the three
// copies drifting apart.
//
// Accessibility: status changes are announced via aria-live, controls are real
// <button>s, and the level meter is decorative (aria-hidden) with the state
// text carrying the meaning. The canvas itself is inert — everything the
// visualization says is also said in text.

const STATE_LABEL = {
  idle: "Idle",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  error: "Error",
};

const PAGES = [
  { id: "interference", href: "/index.html", label: "Interference" },
  { id: "amplitude", href: "/amplitude.html", label: "Amplitude" },
  { id: "spectrum", href: "/spectrum.html", label: "Spectrum" },
  { id: "resonance", href: "/resonance.html", label: "Resonance" },
];

export function createUI({ mapping, onStart, onStop, onInterrupt }) {
  const root = document.createElement("div");
  root.id = "overlay";
  root.dataset.state = "idle";

  const nav = PAGES.map(
    (p) =>
      `<a href="${p.href}" class="nav-link"${
        p.id === mapping.id ? ' aria-current="page"' : ""
      }>${p.label}</a>`
  ).join("");

  root.innerHTML = `
    <header class="panel hero">
      <nav class="nav" aria-label="Visualization">${nav}</nav>
      <h1 class="title">${mapping.title}</h1>
      <p class="blurb">${mapping.blurb}</p>
    </header>

    <section class="panel status-panel" aria-label="Session status">
      <div class="status-row">
        <span class="dot" aria-hidden="true"></span>
        <span id="status" role="status" aria-live="polite">Idle</span>
        <span id="source" class="source" aria-hidden="true"></span>
      </div>
      <div class="meter" aria-hidden="true"><div id="meter-fill" class="meter-fill"></div></div>
      <div class="controls">
        <button id="start" type="button" class="btn btn-primary">Start listening</button>
        <button id="interrupt" type="button" class="btn" disabled>Stop speaking</button>
        <button id="stop" type="button" class="btn" disabled>Stop</button>
      </div>
      <p id="error" class="error" role="alert" hidden></p>
    </section>

    <section class="panel transcript-panel" aria-label="Transcript">
      <ul id="transcript" class="transcript"></ul>
      <p id="interim" class="interim" aria-live="polite"></p>
    </section>
  `;
  document.body.appendChild(root);

  const $ = (id) => root.querySelector(`#${id}`);
  const startBtn = $("start");
  const stopBtn = $("stop");
  const interruptBtn = $("interrupt");
  const statusEl = $("status");
  const sourceEl = $("source");
  const meterFill = $("meter-fill");
  const interimEl = $("interim");
  const transcriptEl = $("transcript");
  const errorEl = $("error");

  startBtn.addEventListener("click", () => onStart());
  stopBtn.addEventListener("click", () => onStop());
  interruptBtn.addEventListener("click", () => onInterrupt());

  return {
    setState(state) {
      root.dataset.state = state;
      statusEl.textContent = STATE_LABEL[state] ?? state;
      const running = state !== "idle" && state !== "error";
      startBtn.disabled = running;
      stopBtn.disabled = !running;
      // Only stoppable when there's a response in flight to stop.
      interruptBtn.disabled = state !== "speaking" && state !== "thinking";

      // Tell the viewer which audio the particles are following right now.
      sourceEl.textContent =
        state === "speaking" ? "driven by TTS" : running ? "driven by mic" : "";

      if (state === "idle") {
        meterFill.style.transform = "scaleX(0)";
        interimEl.textContent = "";
      }
    },

    setLevel(level) {
      // level is RMS 0..1; scale for a livelier meter and clamp.
      const scaled = Math.min(1, level * 3);
      meterFill.style.transform = `scaleX(${scaled.toFixed(3)})`;
    },

    setTranscript({ interim, committed }) {
      if (committed) {
        const text = interim.trim();
        if (text) {
          const li = document.createElement("li");
          li.className = "turn";
          li.textContent = text;
          transcriptEl.appendChild(li);
          // Keep the overlay small: only the last few turns stay on screen.
          while (transcriptEl.children.length > 4) {
            transcriptEl.removeChild(transcriptEl.firstChild);
          }
        }
        interimEl.textContent = "";
      } else {
        interimEl.textContent = interim;
      }
    },

    showError(message) {
      errorEl.textContent = message;
      errorEl.hidden = !message;
    },

    clearError() {
      errorEl.textContent = "";
      errorEl.hidden = true;
    },
  };
}
