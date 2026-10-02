import { escapeHtml } from "./htmlCardHelpers.js";
import { FAVICON_LINK_TAG } from "./faviconHtml.js";
import type { EventIdentity } from "./domain/eventIdentity.js";
import type { WinRate } from "./domain/rollups.js";

/**
 * Milestone 19: "open a previous event/deck, not just the current one" -
 * the tray's "Past Events..." item generates this index page, listing every
 * event run we have any data for (see eventHistory.ts's listEventRuns),
 * each linking to its own deck-viewer page (electron/main.ts writes one
 * such page per entry, right before opening this index, using the exact
 * same buildDeckViewerData/generateDeckViewerHtml path the current-event
 * click already uses - see that file's open-deck-viewer handler). No new
 * IPC/renderer surface: this is a plain static page linking to other plain
 * static pages, the same "self-contained, no local server" approach as
 * every other generated page in this project.
 *
 * Deliberately NOT auto-refreshing (unlike draftProgressHtml.ts's pages) -
 * this is a browse-history list, not something changing while it's open.
 *
 * Milestone 19 follow-up (2026-09-30): `courseId`/`runLabel` are non-null
 * only for a run that listEventRuns had to split apart because Arena
 * reused one eventId across more than one real course (see
 * domain/courseRuns.ts) - shown as a small badge so two rows sharing a
 * name are still distinguishable at a glance.
 */
export interface PastEventRow {
  eventId: string;
  identity: EventIdentity;
  format: string;
  deckName: string | null;
  winRate: WinRate;
  /** Filename (no path) of this run's own generated deck-viewer page, for the link href. */
  fileName: string;
  /** Non-null only for a disambiguated run - see this file's header comment. */
  courseId: string | null;
  /** Human-readable "run started <when>" label, set exactly when courseId is - see deckViewerLoader.ts's identical label for the deck-viewer page itself. */
  runLabel: string | null;
  /** Whether the run is over - decided by domain/runStatus.ts (prize claimed, Arena's own finish signal, manual score, or a reached win/loss cap). */
  finished: boolean;
  /** Short wording for why/how it ended ("Completed 4-3 - eliminated at 3 losses"), or "In progress". */
  statusLabel: string;
}

function formatDateStamp(dateStamp: string | null): string {
  if (!dateStamp || dateStamp.length !== 8) return "";
  return `${dateStamp.slice(0, 4)}-${dateStamp.slice(4, 6)}-${dateStamp.slice(6, 8)}`;
}

function rowHtml(row: PastEventRow): string {
  const date = formatDateStamp(row.identity.dateStamp);
  const record = row.winRate.total > 0 ? `${row.winRate.wins}-${row.winRate.losses} (${row.winRate.pct})` : "no decided matches";
  const deckLabel = row.deckName ? escapeHtml(row.deckName) : "(no deck captured)";
  const runBadge = row.runLabel ? ` <span class="badge">${escapeHtml(row.runLabel)}</span>` : "";
  return `
    <li class="run-row">
      <a href="./${escapeHtml(row.fileName)}">
        <span class="event-name">${escapeHtml(row.identity.definitionLabel)}${runBadge} <span class="status ${row.finished ? "status-done" : "status-live"}">${escapeHtml(row.statusLabel)}</span></span>
        <span class="muted">${escapeHtml(row.format)}${date ? ` &middot; ${escapeHtml(date)}` : ""}</span>
      </a>
      <div class="sub">
        <span>${deckLabel}</span>
        <span class="muted">${escapeHtml(record)}</span>
      </div>
    </li>`;
}

export function generatePastEventsHtml(rows: PastEventRow[]): string {
  // Newest first: dateStamp sorts lexicographically the same as
  // chronologically (YYYYMMDD, per eventIdentity.ts) - anything without one
  // (an unparsed/unusual eventId) sinks to the bottom rather than the top.
  // Two rows sharing an eventId (a disambiguated collision) keep their
  // relative order via runLabel as a secondary key, earliest run first.
  const sorted = [...rows].sort((a, b) => {
    const byDate = (b.identity.dateStamp ?? "").localeCompare(a.identity.dateStamp ?? "");
    if (byDate !== 0) return byDate;
    return (a.runLabel ?? "").localeCompare(b.runLabel ?? "");
  });

  const inProgress = sorted.filter((r) => !r.finished);
  const completed = sorted.filter((r) => r.finished);
  const section = (title: string, list: PastEventRow[]) =>
    list.length > 0 ? `<h2>${escapeHtml(title)} <span class="muted">(${list.length})</span></h2><ul class="run-list">${list.map(rowHtml).join("")}</ul>` : "";

  const body =
    sorted.length > 0
      ? `${section("In progress", inProgress)}${section("Completed", completed)}`
      : `<p class="muted">No events captured yet - play a match, draft, or sealed run with the tracker running and it'll show up here.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Past Events - MTGA Tracker</title>
${FAVICON_LINK_TAG}
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #14151a; color: #e8e8ec; margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .muted { color: #8a8d99; }
  p.hint { margin: 0 0 20px; }
  ul.run-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  li.run-row { background: #1c1e26; border: 1px solid #2a2c36; border-radius: 8px; padding: 10px 14px; }
  li.run-row a { display: flex; justify-content: space-between; align-items: baseline; text-decoration: none; color: #e8e8ec; gap: 12px; }
  li.run-row a:hover .event-name { text-decoration: underline; }
  .event-name { font-weight: 600; }
  .badge { font-weight: 400; font-size: 0.75rem; color: #9fa6ff; background: #262a4a; border-radius: 4px; padding: 1px 6px; margin-left: 6px; }
  h2 { font-size: 1.05rem; margin: 22px 0 8px; }
  .status { font-weight: 400; font-size: 0.75rem; border-radius: 4px; padding: 1px 6px; margin-left: 6px; }
  .status-done { color: #8fd9a8; background: #1e3a2a; }
  .status-live { color: #f0c674; background: #3d3320; }
  .sub { display: flex; justify-content: space-between; align-items: baseline; margin-top: 4px; font-size: 0.85rem; color: #cfd2dc; gap: 12px; }
</style>
</head>
<body>
  <h1>Past Events</h1>
  <p class="hint muted">Every event run captured so far, split into what's still being played and what's finished. Click one to open its deck.</p>
  ${body}
</body>
</html>
`;
}
