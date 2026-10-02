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
function applySettings({ fontSizePx, opacity, theme }) {
  // 2026-10-02: overlay.css restyles everything off body[data-theme].
  if (typeof theme === "string") {
    document.body.dataset.theme = theme;
  }
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

// 2026-10-02: the menu button, the in-overlay menu it opens, and the
// clickable spots in general. The window is click-through, so main.ts polls
// the real cursor position against the rects reported here and makes the
// window clickable only while the cursor is over one of them (hover events
// inside this page can't be relied on - see main.ts's
// updateOverlayHotspotState). That works in locked mode too, not just when the
// overlay is unlocked.
const menuBtn = document.getElementById("menu-btn");
const menuPanel = document.getElementById("menu-panel");

menuBtn.addEventListener("click", () => {
  window.overlay.openMenu();
});

// The menu is drawn here, inside the overlay (a native popup menu doesn't
// reliably show above fullscreen Arena). main.ts pushes the entries - the same
// ones the tray has - and grows the window to fit; a click is reported back by
// entry id, and main runs it and closes the menu.
function renderMenu({ open, entries }) {
  document.body.classList.toggle("menu-open", open);
  menuPanel.innerHTML = "";
  if (!open) {
    menuPanel.classList.add("hidden");
    queueHotspotReport();
    return;
  }
  for (const entry of entries) {
    if (entry.kind === "separator") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menuPanel.appendChild(sep);
      continue;
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = entry.enabled ? "menu-item" : "menu-item disabled";
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = entry.kind === "checkbox" && entry.checked ? "\u2713" : "";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = entry.label;
    item.appendChild(check);
    item.appendChild(label);
    if (entry.hint) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = entry.hint;
      item.appendChild(hint);
    }
    if (entry.enabled) {
      item.addEventListener("click", () => window.overlay.menuAction(entry.id));
    }
    menuPanel.appendChild(item);
  }
  menuPanel.classList.remove("hidden");
  menuPanel.scrollTop = 0;
  queueHotspotReport();
}
window.overlay.onMenu(renderMenu);

// 2026-10-02: the in-game deck-list column. main.ts sends a trusted,
// pre-rendered HTML fragment (libraryPanelHtml.ts - names escaped there) or
// null once the game is over; it also grows/shrinks the window to match, this
// only fills and shows/hides the panel.
const deckList = document.getElementById("deck-list");
window.overlay.onLibrary(({ html }) => {
  if (html) {
    deckList.innerHTML = html;
    deckList.classList.remove("hidden");
    document.body.classList.add("has-library");
  } else {
    deckList.classList.add("hidden");
    deckList.innerHTML = "";
    document.body.classList.remove("has-library");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.overlay.closeMenu();
});

function reportHotspots() {
  const rects = [];
  for (const el of [menuBtn, els.eventRecord, els.draftProgress]) {
    if (el.classList.contains("hidden")) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    rects.push({ x: r.left - 2, y: r.top - 2, width: r.width + 4, height: r.height + 4 });
  }
  window.overlay.setHotspots(rects);
}

let hotspotReportQueued = false;
function queueHotspotReport() {
  if (hotspotReportQueued) return;
  hotspotReportQueued = true;
  requestAnimationFrame(() => {
    hotspotReportQueued = false;
    reportHotspots();
  });
}

// Layout moves whenever state renders (rows appear/disappear), the size
// preset changes the root font-size, or the window resizes for a draft/menu.
new ResizeObserver(queueHotspotReport).observe(document.body);
window.addEventListener("resize", queueHotspotReport);
window.overlay.onState(queueHotspotReport);
window.overlay.onSettings(queueHotspotReport);
queueHotspotReport();
