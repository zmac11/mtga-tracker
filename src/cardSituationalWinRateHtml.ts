import { FAVICON_LINK_TAG } from "./faviconHtml.js";

/**
 * Milestone 23 (features e/f, 2026-09-30 request): "win rate on cards
 * based on whether they were in the opening hand" / "...played during the
 * match", both per format - a new tray page ("Card Situational Win
 * Rate..." in electron/main.ts), same self-contained-static-page/
 * embedded-JSON/client-side-filter convention as Draft Pick Stats
 * (draftPickStatsHtml.ts) and Limited Stats (statsHtml.ts). One row per
 * (card, format) pair ever captured with hand/play data (see
 * domain/cardSituationalWinRate.ts's buildCardSituationalWinRateRows),
 * joined to a name/colors here the same way those other pages do
 * (statsRollup.ts's buildStatsCardCatalog).
 */
export interface CardSituationalWinRateHtmlRow {
  cardId: number;
  name: string;
  colors: string[];
  format: string;
  inHand: { wins: number; losses: number; total: number; pct: string };
  notInHand: { wins: number; losses: number; total: number; pct: string };
  played: { wins: number; losses: number; total: number; pct: string };
  notPlayed: { wins: number; losses: number; total: number; pct: string };
}

export function generateCardSituationalWinRateHtml(rows: CardSituationalWinRateHtmlRow[]): string {
  const dataJson = JSON.stringify(rows).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Card Situational Win Rate - MTGA Tracker</title>
${FAVICON_LINK_TAG}
<style>
  :root { color-scheme: var(--cs, dark); }
  body { font-family: var(--font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); background: var(--bg, #14151a); color: var(--text, #e8e8ec); margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .muted { color: var(--muted, #8a8d99); }
  p.hint { margin: 0 0 20px; max-width: 760px; }
  .filters { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; background: var(--surface, #1c1e26); border: 1px solid var(--border, #2a2c36); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
  .filter-group { display: flex; flex-direction: column; gap: 6px; }
  .filter-group label.group-label { font-size: 0.75rem; color: var(--muted, #8a8d99); text-transform: uppercase; letter-spacing: 0.03em; }
  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; max-width: 420px; }
  .chip { cursor: pointer; user-select: none; font-size: 0.8rem; padding: 4px 10px; border-radius: 12px; border: 1px solid var(--border, #2a2c36); background: var(--bg, #14151a); color: var(--text-2, #cfd2dc); }
  .chip.active { background: var(--accent-bg, #262a4a); border-color: var(--accent-border, #4a4fb0); color: var(--accent, #9fa6ff); }
  .reset-btn { align-self: flex-end; background: var(--accent-bg, #262a4a); color: var(--accent, #9fa6ff); border: 1px solid var(--accent-border, #4a4fb0); border-radius: 6px; padding: 6px 12px; font-size: 0.85rem; cursor: pointer; }
  .card-controls { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .card-controls input[type="number"] { width: 50px; background: var(--bg, #14151a); color: var(--text, #e8e8ec); border: 1px solid var(--border, #2a2c36); border-radius: 6px; padding: 5px 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border-faint, #22242e); }
  th { color: var(--muted, #8a8d99); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.02em; }
  tbody tr:hover { background: var(--surface, #1c1e26); }
  .color-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; }
  .empty-note { padding: 20px 0; }
  .summary { background: var(--surface, #1c1e26); border: 1px solid var(--border, #2a2c36); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; display: flex; gap: 24px; align-items: baseline; flex-wrap: wrap; }
  .summary .big { font-size: 1.6rem; font-weight: 700; }
  .delta-pos { color: var(--pos, #5fd87a); }
  .delta-neg { color: var(--neg, #e5697a); }
  .delta-flat { color: var(--muted, #8a8d99); }
</style>
</head>
<body>
  <h1>Card Situational Win Rate</h1>
  <p class="hint muted">How your win rate changes depending on whether a card actually showed up in your games. "In hand" compares games where the card was in your final, post-mulligan kept opening hand against games where it wasn't. "Played" compares games where the card left your hand at some point (cast, played as a land, discarded, or otherwise) against games where it never did. Covers every match ever captured with hand/play data, split by format.</p>

  <div class="filters">
    <div class="filter-group">
      <label class="group-label">Format (click to toggle, none = all)</label>
      <div class="chip-row" id="format-chips"></div>
    </div>
    <div class="filter-group">
      <label class="group-label">Color (click to toggle, none = all)</label>
      <div class="chip-row" id="color-chips"></div>
    </div>
    <div class="filter-group">
      <label class="group-label" for="min-games">Min games (per bucket)</label>
      <input type="number" id="min-games" min="1" value="3">
    </div>
    <button class="reset-btn" id="reset-filters">Reset filters</button>
  </div>

  <div class="summary" id="summary"></div>

  <table>
    <thead>
      <tr><th>Card</th><th>Colors</th><th>Format</th><th>In hand</th><th>Not in hand</th><th>Δ</th><th>Played</th><th>Not played</th><th>Δ</th></tr>
    </thead>
    <tbody id="rows-body"></tbody>
  </table>
  <p class="empty-note muted" id="empty-note" style="display:none;">No cards match this filter combination.</p>

  <script id="situational-winrate-data" type="application/json">${dataJson}</script>
  <script>
    const rows = JSON.parse(document.getElementById("situational-winrate-data").textContent);
    const activeColors = new Set();
    const activeFormats = new Set();

    function uniqueSorted(values) {
      return [...new Set(values.filter((v) => v !== null && v !== ""))].sort();
    }

    function escapeText(s) {
      const div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }

    function colorHex(letter) {
      return { W: "#f8f6d8", U: "#0e68ab", B: "#4a4a4a", R: "#d3202a", G: "#00733e" }[letter] || "var(--muted, #8a8d99)";
    }

    // "Colorless" is its own pseudo-chip (rows with an empty colors array) -
    // same convention as the Draft Pick Stats page.
    function colorKeysFor(row) {
      return row.colors.length > 0 ? row.colors : ["C"];
    }

    function pctCell(bucket) {
      return bucket.total === 0 ? '<span class="muted">-</span>' : bucket.pct + ' <span class="muted">(' + bucket.wins + '-' + bucket.losses + ')</span>';
    }

    // A signed percentage-point delta between two buckets - "-" when either
    // side has no decided games at all (nothing to compare), since a
    // 0-sample bucket's own 0% isn't a meaningful comparison point.
    function deltaCell(a, b) {
      if (a.total === 0 || b.total === 0) return '<span class="muted">-</span>';
      const pa = (a.wins / a.total) * 100;
      const pb = (b.wins / b.total) * 100;
      const diff = Math.round(pa - pb);
      const cls = diff > 0 ? "delta-pos" : diff < 0 ? "delta-neg" : "delta-flat";
      return '<span class="' + cls + '">' + (diff > 0 ? "+" : "") + diff + "pp</span>";
    }

    function render() {
      const minGames = Math.max(1, parseInt(document.getElementById("min-games").value, 10) || 1);

      const filtered = rows.filter((r) => {
        if (activeFormats.size > 0 && !activeFormats.has(r.format)) return false;
        if (activeColors.size > 0 && !colorKeysFor(r).some((c) => activeColors.has(c))) return false;
        // A row needs at least minGames on BOTH sides of at least one of
        // the two comparisons to be worth showing at all - otherwise
        // every card in the game ever drawn even once would clutter the
        // table with single-game noise.
        const handComparable = r.inHand.total >= minGames && r.notInHand.total >= minGames;
        const playedComparable = r.played.total >= minGames && r.notPlayed.total >= minGames;
        return handComparable || playedComparable;
      });

      // Sort by the larger-magnitude of the two deltas (in-hand vs played),
      // most extreme first - the cards whose presence/play correlates most
      // strongly with winning (or losing) surface at the top either way.
      function biggestAbsDelta(r) {
        const handDelta = r.inHand.total > 0 && r.notInHand.total > 0 ? (r.inHand.wins / r.inHand.total) - (r.notInHand.wins / r.notInHand.total) : 0;
        const playedDelta = r.played.total > 0 && r.notPlayed.total > 0 ? (r.played.wins / r.played.total) - (r.notPlayed.wins / r.notPlayed.total) : 0;
        return Math.max(Math.abs(handDelta), Math.abs(playedDelta));
      }
      filtered.sort((a, b) => biggestAbsDelta(b) - biggestAbsDelta(a));

      const summary = document.getElementById("summary");
      summary.innerHTML =
        '<div><div class="big">' + filtered.length + '</div><div class="muted">' + (filtered.length === 1 ? "card" : "cards") + '</div></div>';

      const body = document.getElementById("rows-body");
      body.innerHTML = "";
      for (const r of filtered) {
        const dots = r.colors.map((c) => '<span class="color-dot" style="background:' + colorHex(c) + ';"></span>').join("");
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + escapeText(r.name) + "</td>" +
          "<td>" + (dots || "-") + "</td>" +
          "<td>" + escapeText(r.format) + "</td>" +
          "<td>" + pctCell(r.inHand) + "</td>" +
          "<td>" + pctCell(r.notInHand) + "</td>" +
          "<td>" + deltaCell(r.inHand, r.notInHand) + "</td>" +
          "<td>" + pctCell(r.played) + "</td>" +
          "<td>" + pctCell(r.notPlayed) + "</td>" +
          "<td>" + deltaCell(r.played, r.notPlayed) + "</td>";
        body.appendChild(tr);
      }
      document.getElementById("empty-note").style.display = filtered.length === 0 ? "block" : "none";
    }

    function buildChips(containerId, keys, activeSet, labelFor) {
      const container = document.getElementById(containerId);
      for (const key of keys) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = labelFor ? labelFor(key) : key;
        chip.addEventListener("click", () => {
          if (activeSet.has(key)) activeSet.delete(key);
          else activeSet.add(key);
          chip.classList.toggle("active");
          render();
        });
        container.appendChild(chip);
      }
    }

    buildChips("format-chips", uniqueSorted(rows.map((r) => r.format)), activeFormats);
    buildChips("color-chips", uniqueSorted(rows.flatMap(colorKeysFor)), activeColors, (key) => (key === "C" ? "Colorless" : key));
    document.getElementById("min-games").addEventListener("input", render);
    document.getElementById("reset-filters").addEventListener("click", () => {
      document.getElementById("min-games").value = 3;
      activeColors.clear();
      activeFormats.clear();
      document.querySelectorAll(".chip.active").forEach((c) => c.classList.remove("active"));
      render();
    });

    render();
  </script>
</body>
</html>
`;
}
