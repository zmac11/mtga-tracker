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
  draftProgress: document.getElementById("draft-progress"),
  draftPackPick: document.getElementById("draft-pack-pick"),
  draftPicked: document.getElementById("draft-picked"),
  draftBoard: document.getElementById("draft-board"),
};

function setStatus(text) {
  els.status.textContent = text;
  els.status.classList.remove("hidden");
  els.match.classList.add("hidden");
}

function render({ foundLog, watchingPath, snapshot, draftBoardHtml }) {
  if (!foundLog) {
    setStatus("Player.log not found. Enable Options > Account > Detailed Logs, then relaunch Arena.");
    els.eventRecord.classList.add("hidden");
    els.draftProgress.classList.add("hidden");
    els.draftBoard.classList.add("hidden");
    return;
  }

  const { match, eventRecord, currentDraft } = snapshot;

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
      // Milestone 18 (Bo3 readiness): only append a "(N-M)" game score when
      // there's more than one game to show - a Bo1 match (every match
      // captured so far) is always exactly 1-0/0-1, which would just
      // restate the WIN/LOSS text, so it's left out to keep today's
      // overlay looking exactly as it always has.
      const games = match.games;
      const scoreSuffix = games && games.wins + games.losses > 1 ? ` (${games.wins}-${games.losses})` : "";
      els.outcome.textContent = (match.reason ? `${match.outcome} (${match.reason})` : match.outcome) + scoreSuffix;
      els.outcome.classList.remove("hidden", "win", "loss");
      els.outcome.classList.add(match.outcome === "WIN" ? "win" : "loss");
    } else {
      els.outcome.classList.add("hidden");
      const activeIsMe = match.me && match.activeSeat === match.me.seat;
      const activeIsOpp = match.opponent && match.activeSeat === match.opponent.seat;
      // Milestone 18: "Game 2"/"Game 3" during a live Bo3 - omitted for
      // game 1 (the only case that's ever existed so far) so a Bo1 match
      // in progress still just shows whose turn it is, unchanged.
      const gameNote = match.currentGameNumber && match.currentGameNumber > 1 ? `Game ${match.currentGameNumber} - ` : "";
      const turnNote = activeIsMe ? "Your turn" : activeIsOpp ? "Opponent's turn" : "";
      els.turn.textContent = gameNote && turnNote ? `${gameNote}${turnNote}` : gameNote ? gameNote.replace(/ - $/, "") : turnNote;
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

  if (currentDraft) {
    els.draftProgress.classList.remove("hidden");
    els.draftPackPick.textContent = `Pack ${currentDraft.pack}, Pick ${currentDraft.pick}`;
    // Cards taken, not pick actions - the same number for a normal 1-card
    // draft, but a "Pick Two" pick (2 cards per pick action) should count
    // as 2 here, not 1.
    const cardsTaken = currentDraft.picks.reduce((n, p) => n + p.grpIds.length, 0);
    els.draftPicked.textContent = `${cardsTaken} picked`;
  } else {
    els.draftProgress.classList.add("hidden");
  }

  // Milestone 23: the expanded draft board - draftBoardHtml is a trusted,
  // already-escaped HTML fragment the main process generated with
  // draftProgressHtml.ts's draftBoardFragmentHtml (same card-name/oracle
  // data as the live draft-progress page, see draftProgressLoader.ts) and
  // pushed alongside this same state message - never user/page-supplied, so
  // innerHTML here is the same "server renders trusted HTML, the renderer
  // just drops it in" pattern already used for the deck-share export. main.ts
  // (setOverlayDraftExpanded) is what actually grows/shrinks the window to
  // make room for this; this only ever shows/hides and fills the panel
  // within whatever size the window currently is.
  if (draftBoardHtml) {
    els.draftBoard.innerHTML = draftBoardHtml;
    els.draftBoard.classList.remove("hidden");
  } else {
    els.draftBoard.classList.add("hidden");
    els.draftBoard.innerHTML = "";
  }
}

// Milestone 9+ (2026-09-24): the overlay's size and background transparency
// are user-configurable from the Settings window (tray menu > "Overlay
// Settings..."). main.ts is the source of truth for both - it resizes the
// actual BrowserWindow to match the chosen size preset and pushes the
// resulting font-size (everything in overlay.css is in rem, scaled off the
// root font-size) plus the opacity value here, both on load and any time
// they change. Applying both through inline styles (rather than, say,
// reloading the page) means there's no flicker when adjusting the slider.
function applySettings({ fontSizePx, opacity }) {
  if (typeof fontSizePx === "number") {
    document.documentElement.style.fontSize = `${fontSizePx}px`;
  }
  if (typeof opacity === "number") {
    document.documentElement.style.setProperty("--panel-opacity", String(opacity));
  }
}

window.overlay.onState(render);
window.overlay.onSettings(applySettings);
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

// Milestone 7 phase 5: clicking the draft-progress line opens the live
// draft-progress page (a static HTML page that auto-refreshes itself - see
// draftProgressHtml.ts). Same unlock-first constraint as the event record
// above.
els.draftProgress.addEventListener("click", async () => {
  const result = await window.overlay.openDraftProgress();
  if (!result || !result.ok) {
    console.warn("Draft progress:", (result && result.reason) || "Could not open the draft-progress page.");
  }
});

// 2026-10-02: the menu button. The window is click-through, so main.ts only
// makes it clickable while the cursor is over this button (mouse-move events
// still reach the page in click-through mode - setIgnoreMouseEvents'
// `forward` option - which is what lets mouseenter/mouseleave fire at all).
const menuBtn = document.getElementById("menu-btn");
menuBtn.addEventListener("mouseenter", () => window.overlay.setClickable(true));
menuBtn.addEventListener("mouseleave", () => window.overlay.setClickable(false));
menuBtn.addEventListener("click", () => {
  window.overlay.openMenu();
});
