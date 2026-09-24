// Plain script (no bundler, no imports) - runs in the renderer with
// contextIsolation on and nodeIntegration off, talking to main.ts only
// through the `overlay` object preload.cjs exposes via contextBridge.

const els = {
  status: document.getElementById("status"),
  match: document.getElementById("match"),
  meName: document.getElementById("me-name"),
  meLife: document.getElementById("me-life"),
  oppName: document.getElementById("opp-name"),
  oppLife: document.getElementById("opp-life"),
  turn: document.getElementById("turn-indicator"),
  outcome: document.getElementById("outcome"),
  eventRecord: document.getElementById("event-record"),
  eventName: document.getElementById("event-name"),
  eventWl: document.getElementById("event-wl"),
};

function setStatus(text) {
  els.status.textContent = text;
  els.status.classList.remove("hidden");
  els.match.classList.add("hidden");
}

function render({ foundLog, watchingPath, snapshot }) {
  if (!foundLog) {
    setStatus("Player.log not found. Enable Options > Account > Detailed Logs, then relaunch Arena.");
    els.eventRecord.classList.add("hidden");
    return;
  }

  const { match, eventRecord } = snapshot;

  if (!match) {
    setStatus("Watching for a match...");
  } else {
    els.status.classList.add("hidden");
    els.match.classList.remove("hidden");

    els.meName.textContent = match.me ? match.me.name : "You";
    els.meLife.textContent = match.me && match.me.life !== null ? match.me.life : "-";
    els.oppName.textContent = match.opponent ? match.opponent.name : "Opponent";
    els.oppLife.textContent = match.opponent && match.opponent.life !== null ? match.opponent.life : "-";

    if (match.outcome) {
      els.turn.textContent = "";
      els.outcome.textContent = match.reason ? `${match.outcome} (${match.reason})` : match.outcome;
      els.outcome.classList.remove("hidden", "win", "loss");
      els.outcome.classList.add(match.outcome === "WIN" ? "win" : "loss");
    } else {
      els.outcome.classList.add("hidden");
      const activeIsMe = match.me && match.activeSeat === match.me.seat;
      const activeIsOpp = match.opponent && match.activeSeat === match.opponent.seat;
      els.turn.textContent = activeIsMe ? "Your turn" : activeIsOpp ? "Opponent's turn" : "";
    }
  }

  if (eventRecord) {
    els.eventRecord.classList.remove("hidden");
    els.eventName.textContent = eventRecord.deckName || eventRecord.eventId;
    els.eventName.title = eventRecord.eventId;
    els.eventWl.textContent = `${eventRecord.wins}-${eventRecord.losses}` + (eventRecord.total > 0 ? ` (${eventRecord.pct})` : "");
  } else {
    els.eventRecord.classList.add("hidden");
  }
}

window.overlay.onState(render);
window.overlay.onInteractiveChanged((interactive) => {
  document.body.classList.toggle("interactive", interactive);
});

// Milestone 7 phase 4: clicking the event record opens that event's deck
// viewer (a static HTML page) in the default browser. Only reachable when
// the overlay is unlocked (Cmd/Ctrl+Shift+O) since it's click-through by
// default - same constraint as dragging the overlay, and documented in the
// element's title/tooltip above.
els.eventRecord.addEventListener("click", async () => {
  const result = await window.overlay.openDeckViewer();
  if (!result || !result.ok) {
    const reason = result && result.reason ? result.reason : "Could not open the deck viewer.";
    els.eventWl.title = reason;
    console.warn("Deck viewer:", reason);
  }
});
