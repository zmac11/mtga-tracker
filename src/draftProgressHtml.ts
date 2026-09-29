import { CARD_PREVIEW_CSS, CARD_PREVIEW_JS, cardPreviewInnerHtml, colorDotsHtml, escapeHtml } from "./htmlCardHelpers.js";

/**
 * Milestone 7 phase 5: generates the live draft-progress browser page - the
 * same "self-contained static HTML, no external requests" approach as
 * deckViewerHtml.ts (phase 4), per the UI-surface decision in
 * feature-roadmap-milestone7.md. Pure string-building over already-resolved
 * data (no DB/live-state access here - see draftProgressLoader.ts for the
 * join, and electron/main.ts for what regenerates this page and when).
 *
 * One real difference from the deck viewer: that page shows a *finished*
 * run, generated once per click. This one is meant to track something
 * changing every 15-30 seconds while a draft is actually in progress, and
 * this project deliberately avoided running a local HTTP server (see the
 * phase 4 notes on that decision) - so instead of a live-updating page, this
 * is a static file that (a) electron/main.ts rewrites on every relevant
 * live event (DraftPackSeen/DraftPickMade - see main.ts), and (b) the page
 * itself asks the browser to reload every few seconds via a plain
 * <meta http-equiv="refresh">, so it picks up each rewrite without any
 * client-side JS/polling/websocket machinery. Cheap and simple; the cost is
 * a full-page reload every few seconds while this tab is open, which is a
 * fine tradeoff for a page that's only open during an active draft.
 */

const REFRESH_INTERVAL_SECONDS = 3;

export interface DraftProgressCard {
  cardId: number;
  name: string;
  colors: string[];
  oracleText: string | null;
  imageNormal: string | null;
}

export interface DraftProgressPick {
  pack: number;
  pick: number;
  /** Almost always one card - see types.ts's DraftPickMade.grpIds comment for "Pick Two" draft (2 cards per pick), which this also renders correctly. */
  cards: DraftProgressCard[];
}

export interface DraftProgressData {
  draftId: string;
  pack: number;
  pick: number;
  /** The pack currently being offered, resolved to real card data. */
  currentPack: DraftProgressCard[];
  /** Every pick made so far this draft, in (pack, pick) order. */
  picks: DraftProgressPick[];
  /** Evolving read on colors from picks so far - deckColors.ts's deriveDeckColors().comboKey, treating each pick as one copy. */
  colorCombo: string;
}

function packCardHtml(card: DraftProgressCard): string {
  return `
    <li class="card-row" tabindex="0">
      ${colorDotsHtml(card.colors)}
      <span class="name">${escapeHtml(card.name)}</span>
      <div class="preview">${cardPreviewInnerHtml(card)}</div>
    </li>`;
}

function pickRowHtml(entry: DraftProgressPick): string {
  // Almost always one card; a "Pick Two" pick renders each card as its own
  // row sharing the same pack/pick label, rather than cramming two names
  // into one row.
  return entry.cards
    .map(
      (card) => `
    <li class="pick-row" tabindex="0">
      <span class="pick-num">P${entry.pack}p${entry.pick}</span>
      ${colorDotsHtml(card.colors)}
      <span class="name">${escapeHtml(card.name)}</span>
      <div class="preview">${cardPreviewInnerHtml(card)}</div>
    </li>`,
    )
    .join("");
}

/**
 * Placeholder shown once a draft that was previously in progress finishes
 * (or before any draft has ever started) - written by electron/main.ts
 * whenever LiveStateTracker.snapshot().currentDraft goes back to null, so a
 * tab left open on this page doesn't keep showing a stale, already-finished
 * pack forever. Still auto-refreshes, so if a new draft starts later, the
 * open tab naturally picks it back up once main.ts regenerates the file for
 * real progress again.
 */
export function generateNoDraftInProgressHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${REFRESH_INTERVAL_SECONDS}">
<title>No draft in progress - MTGA Tracker</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #14151a; color: #e8e8ec; margin: 0; padding: 24px; }
  .muted { color: #8a8d99; }
</style>
</head>
<body>
  <h1>No draft in progress</h1>
  <p class="muted">This page updates on its own once a draft starts - leave it open, or come back here (or click the overlay's draft-progress indicator) once you've started one.</p>
</body>
</html>
`;
}

export function generateDraftProgressHtml(data: DraftProgressData): string {
  // Newest pick first - "what did I just take" is the more useful read at a
  // glance while the draft is still moving; the full ordered list is right
  // there either way.
  const picksNewestFirst = [...data.picks].reverse();
  // Cards taken, not pick actions - the same thing for a normal 1-card
  // draft, but a "Pick Two" pick should count as 2 here, not 1.
  const cardsTaken = data.picks.reduce((n, p) => n + p.cards.length, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${REFRESH_INTERVAL_SECONDS}">
<title>Draft in progress - MTGA Tracker</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #14151a; color: #e8e8ec; margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 0 0 8px; color: #cfd2dc; }
  .muted { color: #8a8d99; font-weight: normal; font-size: 0.85em; }
  .header { margin-bottom: 20px; border-bottom: 1px solid #2a2c36; padding-bottom: 12px; }
  .header .meta { color: #b7bac6; font-size: 0.95rem; }
  .columns { display: flex; gap: 32px; flex-wrap: wrap; }
  .column { flex: 1 1 320px; min-width: 280px; }
  .card-list, .pick-list { list-style: none; margin: 0; padding: 0; }
  .card-row, .pick-row { position: relative; display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px; cursor: default; }
  .card-row:hover, .card-row:focus, .pick-row:hover, .pick-row:focus { background: #22232c; outline: none; }
  .card-row:hover .preview, .card-row:focus .preview, .pick-row:hover .preview, .pick-row:focus .preview { display: block; }
  .pick-num { color: #8a8d99; width: 3.2em; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .name { flex: 1; }
  ${CARD_PREVIEW_CSS}
</style>
</head>
<body>
  <div class="header">
    <h1>Draft in progress <span class="muted">(auto-refreshes every ${REFRESH_INTERVAL_SECONDS}s)</span></h1>
    <div class="meta">Pack ${data.pack}, Pick ${data.pick} &middot; ${data.currentPack.length} card${data.currentPack.length === 1 ? "" : "s"} in this pack &middot; ${cardsTaken} picked so far</div>
    <div class="meta">Colors so far: <strong>${escapeHtml(data.colorCombo)}</strong></div>
  </div>

  <div class="columns">
    <section class="column">
      <h2>This pack</h2>
      <ul class="card-list">
        ${data.currentPack.map(packCardHtml).join("")}
      </ul>
    </section>

    <section class="column">
      <h2>Picks so far <span class="muted">(newest first)</span></h2>
      <ul class="pick-list">
        ${picksNewestFirst.map(pickRowHtml).join("")}
      </ul>
    </section>
  </div>

  <script>
    ${CARD_PREVIEW_JS}
  </script>
</body>
</html>
`;
}
