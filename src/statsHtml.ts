import type { LimitedStatsRow, StatsCardInfo } from "./domain/statsRollup.js";

/**
 * Milestone 20 (2026-09-30): "Add some kind of filter for event types and
 * set for limited formats. Also add deck color filter. Show winrates for
 * such specific filter." - a new tray page ("Limited Stats..." in
 * electron/main.ts), same self-contained-static-page convention as every
 * other generated page in this project (pastEventsHtml.ts, deckViewerHtml.ts,
 * draftProgressHtml.ts): one row per limited event run (statsRollup.ts's
 * LimitedStatsRow), embedded whole as JSON, filtered and re-aggregated
 * entirely by inline vanilla JS in the browser - no IPC/renderer surface
 * and no re-generation needed just to change a filter, exactly like this
 * project's other "browse what's already captured" pages.
 *
 * Deliberately NOT server-side filtered (unlike, say, a --format= CLI
 * flag) - the whole point of a filter UI is trying combinations quickly,
 * and the full row list is already small (one row per event run, not per
 * match) and has no sensitive data beyond what pastEventsHtml.ts already
 * shows unfiltered on the same machine.
 *
 * Milestone 20 follow-up (2026-09-30): "For limited events track winrates
 * even for single cards in maindeck" - the per-card table below is
 * deliberately derived from whichever runs pass the SAME filters above
 * (event type/set/color), not a separate, unfiltered card view, so e.g.
 * "how do my BR decks' cards perform" is just applying the color filter,
 * with no second page or query needed. Built from each row's deckVersions
 * (statsRollup.ts) rather than its single current mainDeck, so a card only
 * played in an earlier, later-cut version of a deck is credited/blamed for
 * that version's own record, not the run's whole history - and note that
 * this means the per-card totals are LOCAL-ONLY (deckVersions.ts's winRate
 * is never reconciled against CourseStanding), so they can differ slightly
 * from the run-level Win% column above, which is reconciled - both numbers
 * are correct for what they measure, they're just not the same measure.
 * `cardCatalog` supplies name/colors for whichever cardIds actually appear
 * in some row's deckVersions (see buildStatsCardCatalog) - kept as its own
 * small embedded array rather than looking cards up some other way, so
 * this page stays fully self-contained/offline like every other page here.
 */
export function generateStatsHtml(rows: LimitedStatsRow[], cardCatalog: StatsCardInfo[]): string {
  const dataJson = JSON.stringify(rows).replace(/</g, "\\u003c");
  const cardCatalogJson = JSON.stringify(cardCatalog).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Limited Stats - MTGA Tracker</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #14151a; color: #e8e8ec; margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .muted { color: #8a8d99; }
  p.hint { margin: 0 0 20px; }
  .filters { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; background: #1c1e26; border: 1px solid #2a2c36; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
  .filter-group { display: flex; flex-direction: column; gap: 6px; }
  .filter-group label.group-label { font-size: 0.75rem; color: #8a8d99; text-transform: uppercase; letter-spacing: 0.03em; }
  select { background: #14151a; color: #e8e8ec; border: 1px solid #2a2c36; border-radius: 6px; padding: 6px 8px; font-size: 0.9rem; min-width: 160px; }
  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; max-width: 420px; }
  .chip { cursor: pointer; user-select: none; font-size: 0.8rem; padding: 4px 10px; border-radius: 12px; border: 1px solid #2a2c36; background: #14151a; color: #cfd2dc; }
  .chip.active { background: #262a4a; border-color: #4a4fb0; color: #9fa6ff; }
  .reset-btn { align-self: flex-end; background: #262a4a; color: #9fa6ff; border: 1px solid #4a4fb0; border-radius: 6px; padding: 6px 12px; font-size: 0.85rem; cursor: pointer; }
  .summary { background: #1c1e26; border: 1px solid #2a2c36; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; display: flex; gap: 24px; align-items: baseline; flex-wrap: wrap; }
  .summary .big { font-size: 1.6rem; font-weight: 700; }
  .summary .big.pos { color: #7ee787; }
  .summary .big.neg { color: #ff8080; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #22242e; }
  th { color: #8a8d99; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.02em; }
  tbody tr:hover { background: #1c1e26; }
  .record-win { color: #7ee787; }
  .record-loss { color: #ff8080; }
  .empty-note { padding: 20px 0; }
  td a { color: #9fa6ff; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  h2 { font-size: 1.1rem; margin: 32px 0 4px; }
  .card-controls { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .card-controls input[type="number"] { width: 50px; background: #14151a; color: #e8e8ec; border: 1px solid #2a2c36; border-radius: 6px; padding: 5px 6px; }
  .color-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; }
</style>
</head>
<body>
  <h1>Limited Stats</h1>
  <p class="hint muted">Filter your Draft/Sealed runs by event type, set, and deck color to see the win rate for exactly that slice.</p>

  <div class="filters">
    <div class="filter-group">
      <label class="group-label" for="filter-subtype">Event type</label>
      <select id="filter-subtype"><option value="">All</option></select>
    </div>
    <div class="filter-group">
      <label class="group-label" for="filter-set">Set</label>
      <select id="filter-set"><option value="">All</option></select>
    </div>
    <div class="filter-group">
      <label class="group-label">Deck color (click to toggle, none = all)</label>
      <div class="chip-row" id="color-chips"></div>
    </div>
    <button class="reset-btn" id="reset-filters">Reset filters</button>
  </div>

  <div class="summary" id="summary"></div>

  <table>
    <thead>
      <tr><th>Event type</th><th>Set</th><th>Deck</th><th>Colors</th><th>Record</th><th>Win%</th></tr>
    </thead>
    <tbody id="rows-body"></tbody>
  </table>
  <p class="empty-note muted" id="empty-note" style="display:none;">No runs match this filter combination.</p>

  <h2>Card win rates</h2>
  <p class="hint muted">Win rate while each card was in the maindeck, for the runs matching the filters above. Local-only record (see note in source) - small sample sizes are noisy, hence the minimum below.</p>
  <div class="card-controls">
    <label class="group-label" for="min-decks">Min decks played</label>
    <input type="number" id="min-decks" min="1" value="2">
  </div>
  <table>
    <thead>
      <tr><th>Card</th><th>Colors</th><th>Decks played</th><th>Record</th><th>Win%</th></tr>
    </thead>
    <tbody id="card-rows-body"></tbody>
  </table>
  <p class="empty-note muted" id="card-empty-note" style="display:none;">No cards meet the minimum deck count for this filter combination.</p>

  <script id="stats-data" type="application/json">${dataJson}</script>
  <script id="card-catalog-data" type="application/json">${cardCatalogJson}</script>
  <script>
    const rows = JSON.parse(document.getElementById("stats-data").textContent);
    const cardCatalog = JSON.parse(document.getElementById("card-catalog-data").textContent);
    const cardById = new Map(cardCatalog.map((c) => [c.cardId, c]));
    const activeColors = new Set();

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

    function winRateOf(list) {
      const wins = list.reduce((sum, r) => sum + r.wins, 0);
      const losses = list.reduce((sum, r) => sum + r.losses, 0);
      const total = wins + losses;
      const pct = total > 0 ? Math.round((wins / total) * 100) + "%" : "-";
      return { wins, losses, total, pct };
    }

    function escapeText(s) {
      const div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }

    function render() {
      const subtypeSel = document.getElementById("filter-subtype").value;
      const setSel = document.getElementById("filter-set").value;

      const filtered = rows.filter((r) => {
        if (subtypeSel && r.subtype !== subtypeSel) return false;
        if (setSel && r.setCode !== setSel) return false;
        if (activeColors.size > 0 && !activeColors.has(r.colorCombo)) return false;
        return true;
      });

      const wr = winRateOf(filtered);
      const summary = document.getElementById("summary");
      const cls = wr.total === 0 ? "" : wr.wins >= wr.losses ? "pos" : "neg";
      summary.innerHTML =
        '<div><div class="big ' + cls + '">' + wr.wins + '-' + wr.losses + '</div><div class="muted">record</div></div>' +
        '<div><div class="big ' + cls + '">' + wr.pct + '</div><div class="muted">win rate</div></div>' +
        '<div><div class="big">' + filtered.length + '</div><div class="muted">' + (filtered.length === 1 ? "run" : "runs") + '</div></div>';

      const body = document.getElementById("rows-body");
      body.innerHTML = "";
      for (const r of filtered) {
        const tr = document.createElement("tr");
        const total = r.wins + r.losses;
        const pct = total > 0 ? Math.round((r.wins / total) * 100) + "%" : "-";
        tr.innerHTML =
          "<td>" + escapeText(r.subtype) + "</td>" +
          "<td>" + escapeText(r.setCode || "-") + "</td>" +
          "<td>" + (r.deckViewerFileName ? '<a href="../deck-viewer/' + encodeURIComponent(r.deckViewerFileName) + '">' + escapeText(r.deckName || "(no deck captured)") + "</a>" : escapeText(r.deckName || "(no deck captured)")) + "</td>" +
          "<td>" + escapeText(r.colorCombo) + "</td>" +
          '<td><span class="record-win">' + r.wins + '</span>-<span class="record-loss">' + r.losses + "</span></td>" +
          "<td>" + pct + "</td>";
        body.appendChild(tr);
      }
      document.getElementById("empty-note").style.display = filtered.length === 0 ? "block" : "none";

      renderCardStats(filtered);
    }

    function renderCardStats(filteredRuns) {
      const minDecks = Math.max(1, parseInt(document.getElementById("min-decks").value, 10) || 1);

      const perCard = new Map(); // cardId -> { wins, losses, decksPlayedIn }
      for (const run of filteredRuns) {
        for (const version of run.deckVersions) {
          for (const entry of version.mainDeck) {
            const existing = perCard.get(entry.cardId) ?? { wins: 0, losses: 0, decksPlayedIn: 0 };
            existing.wins += version.wins;
            existing.losses += version.losses;
            existing.decksPlayedIn += 1;
            perCard.set(entry.cardId, existing);
          }
        }
      }

      const cardRows = [...perCard.entries()]
        .map(([cardId, stat]) => ({ cardId, ...stat }))
        .filter((c) => c.decksPlayedIn >= minDecks)
        .sort((a, b) => b.decksPlayedIn - a.decksPlayedIn || (b.wins + b.losses === 0 ? 0 : b.wins / (b.wins + b.losses)) - (a.wins + a.losses === 0 ? 0 : a.wins / (a.wins + a.losses)));

      const body = document.getElementById("card-rows-body");
      body.innerHTML = "";
      for (const c of cardRows) {
        const info = cardById.get(c.cardId);
        const name = info ? info.name : "Unknown card #" + c.cardId;
        const colors = info ? info.colors : [];
        const total = c.wins + c.losses;
        const pct = total > 0 ? Math.round((c.wins / total) * 100) + "%" : "-";
        const dots = colors.map((col) => '<span class="color-dot" style="background:' + colorHex(col) + ';"></span>').join("");
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + escapeText(name) + "</td>" +
          "<td>" + (dots || "-") + "</td>" +
          "<td>" + c.decksPlayedIn + "</td>" +
          '<td><span class="record-win">' + c.wins + '</span>-<span class="record-loss">' + c.losses + "</span></td>" +
          "<td>" + pct + "</td>";
        body.appendChild(tr);
      }
      document.getElementById("card-empty-note").style.display = cardRows.length === 0 ? "block" : "none";
    }

    function colorHex(letter) {
      return { W: "#f8f6d8", U: "#0e68ab", B: "#4a4a4a", R: "#d3202a", G: "#00733e" }[letter] || "#8a8d99";
    }

    function buildColorChips() {
      const container = document.getElementById("color-chips");
      const combos = uniqueSorted(rows.map((r) => r.colorCombo));
      for (const combo of combos) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = combo;
        chip.addEventListener("click", () => {
          if (activeColors.has(combo)) activeColors.delete(combo);
          else activeColors.add(combo);
          chip.classList.toggle("active");
          render();
        });
        container.appendChild(chip);
      }
    }

    populateSelect(document.getElementById("filter-subtype"), uniqueSorted(rows.map((r) => r.subtype)));
    populateSelect(document.getElementById("filter-set"), uniqueSorted(rows.map((r) => r.setCode)));
    buildColorChips();

    document.getElementById("filter-subtype").addEventListener("change", render);
    document.getElementById("filter-set").addEventListener("change", render);
    document.getElementById("min-decks").addEventListener("input", render);
    document.getElementById("reset-filters").addEventListener("click", () => {
      document.getElementById("filter-subtype").value = "";
      document.getElementById("filter-set").value = "";
      activeColors.clear();
      document.querySelectorAll(".chip.active").forEach((c) => c.classList.remove("active"));
      render();
    });

    render();
  </script>
</body>
</html>
`;
}
