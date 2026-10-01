import type { EventRewardRow, OverallRewardSummary } from "./domain/rewardHistory.js";
import { FAVICON_LINK_TAG } from "./faviconHtml.js";

/**
 * Milestone 21 (2026-10-01): "layout of event rewards - button in
 * settings -> layout where I can filter for events by format, set and see
 * rewards earned. Also I want to track overall rewards from quests etc."
 * - a new tray page ("Reward History..." in electron/main.ts), same
 * self-contained static-page/embedded-JSON/client-side-filter convention
 * as opponentHtml.ts/statsHtml.ts (no IPC surface, no re-generation needed
 * per filter change - see opponentHtml.ts's own header for the general
 * rationale).
 *
 * UI-placement note: the user asked for this as a Settings button, but
 * every filterable report this project has shipped (Past Events, Limited
 * Stats, Opponent History) is its own tray item, not something inside the
 * Settings window (which this project reserves for toggles/sliders -
 * overlay size, opacity, card size, auto-update-check). This follows that
 * same established convention instead - see electron/main.ts's
 * "Reward History..." tray item.
 *
 * Two sections: a filterable (format/set/search) per-event-run table of
 * entry cost + prize claim (EventRewardRow - reuses eventHistory.ts's own
 * .entry/.reward, no new capture needed for this half), and a separate,
 * filter-independent "Overall rewards earned" summary (OverallRewardSummary
 * - the new generic RewardGrant ledger, covering "quests etc." via the
 * Mastery Pass). The two summary totals below the per-event table
 * (eventPrizes + masteryPass + other = earnedTotal) are the account-wide
 * figures; entryFeesPaid/sealedPoolsReceived are shown as separate context
 * only, NOT folded into earnedTotal - see that type's doc comment in
 * rewardHistory.ts for why a cost and a purchase don't count as earned.
 */
export function generateRewardHtml(rows: EventRewardRow[], overall: OverallRewardSummary): string {
  const dataJson = JSON.stringify(rows).replace(/</g, "\\u003c");
  const overallJson = JSON.stringify(overall).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Reward History - MTGA Tracker</title>
${FAVICON_LINK_TAG}
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #14151a; color: #e8e8ec; margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 28px 0 10px; }
  .muted { color: #8a8d99; }
  p.hint { margin: 0 0 20px; }
  .filters { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; background: #1c1e26; border: 1px solid #2a2c36; border-radius: 8px; padding: 14px 16px; margin-bottom: 16px; }
  .filter-group { display: flex; flex-direction: column; gap: 6px; }
  .filter-group label.group-label { font-size: 0.75rem; color: #8a8d99; text-transform: uppercase; letter-spacing: 0.03em; }
  input[type="text"], select { background: #14151a; color: #e8e8ec; border: 1px solid #2a2c36; border-radius: 6px; padding: 6px 8px; font-size: 0.9rem; min-width: 180px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #22242e; }
  th { color: #8a8d99; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.02em; }
  tfoot td { font-weight: 600; border-top: 1px solid #2a2c36; border-bottom: none; }
  .gem { color: #7fd6e8; }
  .gold { color: #e8c76a; }
  .empty-note { padding: 20px 0; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 8px; }
  .summary-card { background: #1c1e26; border: 1px solid #2a2c36; border-radius: 8px; padding: 12px 14px; }
  .summary-card .label { font-size: 0.75rem; color: #8a8d99; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
  .summary-card .value { font-size: 1.1rem; }
  .summary-card .sub { font-size: 0.78rem; color: #8a8d99; margin-top: 2px; }
  .context-note { margin: 4px 0 20px; }
</style>
</head>
<body>
  <h1>Reward History</h1>
  <p class="hint muted">Filter your event runs by format or set to see what each one cost to join and what it paid out.</p>

  <div class="filters">
    <div class="filter-group">
      <label class="group-label" for="search-event">Search event</label>
      <input type="text" id="search-event" placeholder="Name contains...">
    </div>
    <div class="filter-group">
      <label class="group-label" for="filter-format">Format</label>
      <select id="filter-format"><option value="">All</option></select>
    </div>
    <div class="filter-group">
      <label class="group-label" for="filter-set">Set</label>
      <select id="filter-set"><option value="">All</option></select>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Event</th><th>Format</th><th>Set</th><th>Entry paid</th><th>Gems</th><th>Gold</th><th>Boosters</th><th>Cards</th></tr>
    </thead>
    <tbody id="reward-rows-body"></tbody>
    <tfoot>
      <tr><td colspan="4">Totals for filtered events</td><td id="totals-gems"></td><td id="totals-gold"></td><td id="totals-boosters"></td><td id="totals-cards"></td></tr>
    </tfoot>
  </table>
  <p class="empty-note muted" id="empty-note" style="display:none;">No events match this search/filter.</p>

  <h2>Overall rewards earned</h2>
  <p class="hint muted">Account-wide, not affected by the filters above - every event prize claim and every Mastery Pass tier reward ever captured.</p>
  <div class="summary-grid" id="overall-summary"></div>
  <p class="context-note muted" id="overall-context"></p>

  <script id="reward-data" type="application/json">${dataJson}</script>
  <script id="overall-data" type="application/json">${overallJson}</script>
  <script>
    const rows = JSON.parse(document.getElementById("reward-data").textContent);
    const overall = JSON.parse(document.getElementById("overall-data").textContent);

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

    function formatBoosters(boosters) {
      if (!boosters || boosters.length === 0) return "-";
      return boosters.map((b) => b.count + "x " + b.setCode).join(", ");
    }

    function mergeBoosterLists(lists) {
      const bySet = new Map();
      for (const list of lists) {
        for (const b of list) {
          bySet.set(b.setCode, (bySet.get(b.setCode) || 0) + b.count);
        }
      }
      return [...bySet.entries()].map(([setCode, count]) => ({ setCode, count }));
    }

    function render() {
      const search = document.getElementById("search-event").value.trim().toLowerCase();
      const formatSel = document.getElementById("filter-format").value;
      const setSel = document.getElementById("filter-set").value;

      const filtered = rows.filter((r) => {
        if (formatSel && r.format !== formatSel) return false;
        if (setSel && r.setCode !== setSel) return false;
        if (search && !(r.definitionLabel || r.eventId).toLowerCase().includes(search)) return false;
        return true;
      });

      const body = document.getElementById("reward-rows-body");
      body.innerHTML = "";
      let totalGems = 0, totalGold = 0, totalCards = 0;
      const boosterLists = [];
      for (const r of filtered) {
        totalGems += r.reward ? r.reward.gems : 0;
        totalGold += r.reward ? r.reward.gold : 0;
        totalCards += r.reward ? r.reward.grantedCardCount : 0;
        if (r.reward) boosterLists.push(r.reward.boosters);

        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + escapeText(r.definitionLabel || r.eventId) + "</td>" +
          "<td>" + escapeText(r.format) + "</td>" +
          "<td>" + escapeText(r.setCode || "-") + "</td>" +
          "<td>" + (r.entry ? r.entry.amountPaid + " " + escapeText(r.entry.currencyType) : "-") + "</td>" +
          '<td class="gem">' + (r.reward ? r.reward.gems : "-") + "</td>" +
          '<td class="gold">' + (r.reward ? r.reward.gold : "-") + "</td>" +
          "<td>" + (r.reward ? formatBoosters(r.reward.boosters) : "-") + "</td>" +
          "<td>" + (r.reward ? r.reward.grantedCardCount : "-") + "</td>";
        body.appendChild(tr);
      }
      document.getElementById("empty-note").style.display = filtered.length === 0 ? "block" : "none";
      document.getElementById("totals-gems").textContent = totalGems;
      document.getElementById("totals-gems").className = "gem";
      document.getElementById("totals-gold").textContent = totalGold;
      document.getElementById("totals-gold").className = "gold";
      document.getElementById("totals-boosters").textContent = formatBoosters(mergeBoosterLists(boosterLists));
      document.getElementById("totals-cards").textContent = totalCards;
    }

    function summaryCard(label, total, note) {
      const div = document.createElement("div");
      div.className = "summary-card";
      div.innerHTML =
        '<div class="label">' + escapeText(label) + "</div>" +
        '<div class="value"><span class="gem">' + total.gems + ' gems</span> / <span class="gold">' + total.gold + " gold</span></div>" +
        '<div class="sub">' + formatBoosters(total.boosters) + (total.grantedCardCount ? ", " + total.grantedCardCount + " cards" : "") + "</div>" +
        (note ? '<div class="sub">' + escapeText(note) + "</div>" : "");
      return div;
    }

    function renderOverall() {
      const grid = document.getElementById("overall-summary");
      grid.innerHTML = "";
      grid.appendChild(summaryCard("Event prizes", overall.eventPrizes, overall.eventPrizes.grantCount + " claim(s)"));
      grid.appendChild(summaryCard("Mastery Pass (quests)", overall.masteryPass, overall.masteryPass.grantCount + " tier reward(s)"));
      if (overall.other.grantCount > 0) grid.appendChild(summaryCard("Other", overall.other, overall.other.grantCount + " grant(s)"));
      grid.appendChild(summaryCard("Total earned", overall.earnedTotal, overall.earnedTotal.grantCount + " grant(s) total"));

      document.getElementById("overall-context").textContent =
        "Not counted as earned (shown for context only): " + Math.abs(overall.entryFeesPaid.gems) + " gems paid in entry fees across " +
        overall.entryFeesPaid.grantCount + " event(s), and " + overall.sealedPoolsReceived.grantedCardCount + " card(s) received from Sealed pools you paid to open.";
    }

    populateSelect(document.getElementById("filter-format"), uniqueSorted(rows.map((r) => r.format)));
    populateSelect(document.getElementById("filter-set"), uniqueSorted(rows.map((r) => r.setCode)));

    document.getElementById("search-event").addEventListener("input", render);
    document.getElementById("filter-format").addEventListener("change", render);
    document.getElementById("filter-set").addEventListener("change", render);

    render();
    renderOverall();
  </script>
</body>
</html>
`;
}
