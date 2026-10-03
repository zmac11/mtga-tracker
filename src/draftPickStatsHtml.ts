import { FAVICON_LINK_TAG } from "./faviconHtml.js";

/**
 * Milestone 23 (feature d): "in settings there should be a draft filter
 * button to view such draft data" - a new tray page ("Draft Pick
 * Stats..." in electron/main.ts), same self-contained-static-page/
 * embedded-JSON/client-side-filter convention as statsHtml.ts's Limited
 * Stats page (milestone 20). One row per distinct card ever picked across
 * every captured draft (domain/draftPickPriority.ts's PickPriorityRow,
 * joined to a name/colors here the same way statsRollup.ts's
 * buildStatsCardCatalog does), filterable by color and a minimum
 * times-picked threshold, sorted by "priority" (feature b's own metric -
 * how many other cards were still in the pack when a card was picked,
 * averaged over every time it was taken) with the highest-priority cards
 * first.
 */
export interface DraftPickStatsRow {
  cardId: number;
  name: string;
  colors: string[];
  timesPicked: number;
  avgOthersInPack: number;
  minOthersInPack: number;
  maxOthersInPack: number;
}

export function generateDraftPickStatsHtml(rows: DraftPickStatsRow[]): string {
  const dataJson = JSON.stringify(rows).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Draft Pick Stats - MTGA Tracker</title>
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
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border-faint, #22242e); }
  th { color: var(--muted, #8a8d99); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.02em; }
  tbody tr:hover { background: var(--surface, #1c1e26); }
  .color-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; }
  .empty-note { padding: 20px 0; }
  .summary { background: var(--surface, #1c1e26); border: 1px solid var(--border, #2a2c36); border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; display: flex; gap: 24px; align-items: baseline; flex-wrap: wrap; }
  .summary .big { font-size: 1.6rem; font-weight: 700; }
</style>
</head>
<body>
  <h1>Draft Pick Stats</h1>
  <p class="hint muted">How often each card gets picked, and how much competition it was picked under: "avg others in pack" is the average number of OTHER cards still available in the booster at the moment you took this card. A card you take even with plenty of alternatives still on offer reads as a high-priority pick; one only ever taken when little else was left reads as a low-priority/last-resort pick. Covers every draft ever captured, not just one run.</p>

  <div class="filters">
    <div class="filter-group">
      <label class="group-label">Color (click to toggle, none = all)</label>
      <div class="chip-row" id="color-chips"></div>
    </div>
    <div class="filter-group">
      <label class="group-label" for="min-picked">Min times picked</label>
      <input type="number" id="min-picked" min="1" value="1">
    </div>
    <button class="reset-btn" id="reset-filters">Reset filters</button>
  </div>

  <div class="summary" id="summary"></div>

  <table>
    <thead>
      <tr><th>Card</th><th>Colors</th><th>Times picked</th><th>Avg others in pack</th><th>Min</th><th>Max</th></tr>
    </thead>
    <tbody id="rows-body"></tbody>
  </table>
  <p class="empty-note muted" id="empty-note" style="display:none;">No cards match this filter combination.</p>

  <script id="pick-stats-data" type="application/json">${dataJson}</script>
  <script>
    const rows = JSON.parse(document.getElementById("pick-stats-data").textContent);
    const activeColors = new Set();

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
    // same convention as this page's own color dots, which render nothing
    // for an empty array, rather than silently excluding colorless cards
    // from the filter chips entirely.
    function colorKeysFor(row) {
      return row.colors.length > 0 ? row.colors : ["C"];
    }

    function render() {
      const minPicked = Math.max(1, parseInt(document.getElementById("min-picked").value, 10) || 1);

      const filtered = rows.filter((r) => {
        if (r.timesPicked < minPicked) return false;
        if (activeColors.size > 0 && !colorKeysFor(r).some((c) => activeColors.has(c))) return false;
        return true;
      });

      // Highest-priority (most others still in the pack when picked) first;
      // ties broken by times picked, so a well-sampled card wins over a
      // one-off at the same average.
      filtered.sort((a, b) => b.avgOthersInPack - a.avgOthersInPack || b.timesPicked - a.timesPicked);

      const summary = document.getElementById("summary");
      summary.innerHTML =
        '<div><div class="big">' + filtered.length + '</div><div class="muted">' + (filtered.length === 1 ? "card" : "cards") + '</div></div>' +
        '<div><div class="big">' + rows.reduce((n, r) => n + r.timesPicked, 0) + '</div><div class="muted">total picks captured</div></div>';

      const body = document.getElementById("rows-body");
      body.innerHTML = "";
      for (const r of filtered) {
        const dots = r.colors.map((c) => '<span class="color-dot" style="background:' + colorHex(c) + ';"></span>').join("");
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + escapeText(r.name) + "</td>" +
          "<td>" + (dots || "-") + "</td>" +
          "<td>" + r.timesPicked + "</td>" +
          "<td>" + r.avgOthersInPack.toFixed(1) + "</td>" +
          "<td>" + r.minOthersInPack + "</td>" +
          "<td>" + r.maxOthersInPack + "</td>";
        body.appendChild(tr);
      }
      document.getElementById("empty-note").style.display = filtered.length === 0 ? "block" : "none";
    }

    function buildColorChips() {
      const container = document.getElementById("color-chips");
      const keys = uniqueSorted(rows.flatMap(colorKeysFor));
      for (const key of keys) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = key === "C" ? "Colorless" : key;
        chip.addEventListener("click", () => {
          if (activeColors.has(key)) activeColors.delete(key);
          else activeColors.add(key);
          chip.classList.toggle("active");
          render();
        });
        container.appendChild(chip);
      }
    }

    buildColorChips();
    document.getElementById("min-picked").addEventListener("input", render);
    document.getElementById("reset-filters").addEventListener("click", () => {
      document.getElementById("min-picked").value = 1;
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
