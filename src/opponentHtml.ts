import type { OpponentMatchRow } from "./domain/opponentStats.js";
import { FAVICON_LINK_TAG } from "./faviconHtml.js";

/**
 * Milestone 20 (2026-09-30): "I want to search which opponents I have
 * played against and winrate against them - option to filter them by
 * format and search games and deck which I played vs them" - a new tray
 * page ("Opponent History..." in electron/main.ts), same self-contained
 * static-page/embedded-JSON/client-side-filter convention as statsHtml.ts
 * (see that file's header for the general rationale - no IPC surface, no
 * re-generation needed per filter change).
 *
 * Two-level UI: a searchable/filterable table of every opponent faced
 * (aggregate record), and clicking one opens a detail panel listing that
 * opponent's individual matches (date, event, my deck, result) - exactly
 * the "search games and deck which I played vs them" part of the request.
 */
export function generateOpponentHtml(rows: OpponentMatchRow[]): string {
  const dataJson = JSON.stringify(rows).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Opponent History - MTGA Tracker</title>
${FAVICON_LINK_TAG}
<style>
  :root { color-scheme: var(--cs, dark); }
  body { font-family: var(--font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); background: var(--bg, #14151a); color: var(--text, #e8e8ec); margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 28px 0 10px; }
  .muted { color: var(--muted, #8a8d99); }
  p.hint { margin: 0 0 20px; }
  .filters { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; background: var(--surface, #1c1e26); border: 1px solid var(--border, #2a2c36); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
  .filter-group { display: flex; flex-direction: column; gap: 6px; }
  .filter-group label.group-label { font-size: 0.75rem; color: var(--muted, #8a8d99); text-transform: uppercase; letter-spacing: 0.03em; }
  input[type="text"], select { background: var(--bg, #14151a); color: var(--text, #e8e8ec); border: 1px solid var(--border, #2a2c36); border-radius: 6px; padding: 6px 8px; font-size: 0.9rem; min-width: 180px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border-faint, #22242e); }
  th { color: var(--muted, #8a8d99); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.02em; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--surface, #1c1e26); }
  tbody tr.selected { background: var(--accent-bg-2, #21243a); }
  .record-win { color: var(--pos, #7ee787); }
  .record-loss { color: var(--neg, #ff8080); }
  .in-progress { color: var(--muted, #8a8d99); font-style: italic; }
  .empty-note { padding: 20px 0; }
  #detail-panel { background: var(--surface, #1c1e26); border: 1px solid var(--border, #2a2c36); border-radius: 8px; padding: 14px 16px; margin-top: 8px; }
  #detail-panel h3 { margin: 0 0 10px; font-size: 1rem; }
</style>
</head>
<body>
  <h1>Opponent History</h1>
  <p class="hint muted">Search or filter to find an opponent, then click their row to see the individual games and decks played against them.</p>

  <div class="filters">
    <div class="filter-group">
      <label class="group-label" for="search-opponent">Search opponent</label>
      <input type="text" id="search-opponent" placeholder="Name contains...">
    </div>
    <div class="filter-group">
      <label class="group-label" for="filter-format">Format</label>
      <select id="filter-format"><option value="">All</option></select>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Opponent</th><th>Matches</th><th>Record</th><th>Win%</th></tr>
    </thead>
    <tbody id="opponent-rows-body"></tbody>
  </table>
  <p class="empty-note muted" id="empty-note" style="display:none;">No opponents match this search/filter.</p>

  <div id="detail-panel" style="display:none;">
    <h3 id="detail-title"></h3>
    <table>
      <thead>
        <tr><th>Date</th><th>Event</th><th>Format</th><th>My deck</th><th>Result</th><th>Turns</th></tr>
      </thead>
      <tbody id="detail-rows-body"></tbody>
    </table>
  </div>

  <script id="opponent-data" type="application/json">${dataJson}</script>
  <script>
    const rows = JSON.parse(document.getElementById("opponent-data").textContent);
    let selectedOpponent = null;

    function uniqueSorted(values) {
      return [...new Set(values.filter((v) => v !== null && v !== ""))].sort();
    }

    function populateSelect(select, values) {
      for (const v of values) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
      }
    }

    function escapeText(s) {
      const div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }

    function formatDate(ts) {
      const d = new Date(ts);
      return isNaN(d.getTime()) ? ts : d.toLocaleDateString();
    }

    function render() {
      const search = document.getElementById("search-opponent").value.trim().toLowerCase();
      const formatSel = document.getElementById("filter-format").value;

      const filtered = rows.filter((r) => {
        if (formatSel && r.format !== formatSel) return false;
        return true;
      });

      const byOpponent = new Map();
      for (const r of filtered) {
        if (search && !r.opponent.toLowerCase().includes(search)) continue;
        const bucket = byOpponent.get(r.opponent) ?? { wins: 0, losses: 0, matchCount: 0 };
        bucket.matchCount += 1;
        if (r.outcome === "WIN") bucket.wins += 1;
        else if (r.outcome === "LOSS") bucket.losses += 1;
        byOpponent.set(r.opponent, bucket);
      }

      const summaries = [...byOpponent.entries()]
        .map(([opponent, b]) => ({ opponent, ...b }))
        .sort((a, b) => b.matchCount - a.matchCount || a.opponent.localeCompare(b.opponent));

      const body = document.getElementById("opponent-rows-body");
      body.innerHTML = "";
      for (const s of summaries) {
        const total = s.wins + s.losses;
        const pct = total > 0 ? Math.round((s.wins / total) * 100) + "%" : "-";
        const tr = document.createElement("tr");
        if (s.opponent === selectedOpponent) tr.classList.add("selected");
        tr.innerHTML =
          "<td>" + escapeText(s.opponent) + "</td>" +
          "<td>" + s.matchCount + "</td>" +
          '<td><span class="record-win">' + s.wins + '</span>-<span class="record-loss">' + s.losses + "</span></td>" +
          "<td>" + pct + "</td>";
        tr.addEventListener("click", () => {
          selectedOpponent = s.opponent;
          render();
        });
        body.appendChild(tr);
      }
      document.getElementById("empty-note").style.display = summaries.length === 0 ? "block" : "none";

      renderDetail(filtered);
    }

    function renderDetail(filteredRows) {
      const panel = document.getElementById("detail-panel");
      if (!selectedOpponent || !filteredRows.some((r) => r.opponent === selectedOpponent)) {
        panel.style.display = "none";
        return;
      }
      panel.style.display = "block";
      document.getElementById("detail-title").textContent = "Games vs " + selectedOpponent;

      const matches = filteredRows
        .filter((r) => r.opponent === selectedOpponent)
        .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

      const body = document.getElementById("detail-rows-body");
      body.innerHTML = "";
      for (const m of matches) {
        const resultHtml =
          m.outcome === "WIN" ? '<span class="record-win">WIN</span>' + (m.reason ? " (" + escapeText(m.reason) + ")" : "") :
          m.outcome === "LOSS" ? '<span class="record-loss">LOSS</span>' + (m.reason ? " (" + escapeText(m.reason) + ")" : "") :
          '<span class="in-progress">in progress / not captured</span>';
        const tr = document.createElement("tr");
        // Joined with "/" (not "+") - these are each game's OWN turn
        // count, not a sum, per the same "average per game, not per
        // match" convention this project's turn-count averages use
        // elsewhere (matchDetails.ts's averageTurnCount).
        const turnsText = m.turnCounts.length > 0 ? m.turnCounts.join(" / ") : "-";
        tr.innerHTML =
          "<td>" + formatDate(m.ts) + "</td>" +
          "<td>" + escapeText(m.definitionLabel || m.eventId || "-") + "</td>" +
          "<td>" + escapeText(m.format) + "</td>" +
          "<td>" + escapeText(m.myDeckName || "(no deck captured)") + "</td>" +
          "<td>" + resultHtml + "</td>" +
          "<td>" + turnsText + "</td>";
        body.appendChild(tr);
      }
    }

    populateSelect(document.getElementById("filter-format"), uniqueSorted(rows.map((r) => r.format)));

    document.getElementById("search-opponent").addEventListener("input", render);
    document.getElementById("filter-format").addEventListener("change", render);

    render();
  </script>
</body>
</html>
`;
}
