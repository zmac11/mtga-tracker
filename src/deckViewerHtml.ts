import { groupByManaCurve, type CardCurveInfo } from "./domain/manaCurve.js";
import { CARD_PREVIEW_CSS, cardPreviewInnerHtml, colorDotsHtml, escapeHtml } from "./htmlCardHelpers.js";

/**
 * Milestone 7 phase 4: generates the deck-viewer browser page for one event
 * run. A single self-contained static HTML file (inline CSS/JS, no external
 * requests) - matches the "local page opened in the default browser" UI
 * surface decided with the user (see feature-roadmap-milestone7.md). Pure
 * string-building over already-resolved data (no DB access here - see
 * generateDeckViewer.ts for the loader that builds this from tracker.db),
 * same convention as the rest of src/domain/ - keeps this testable without a
 * real database or a real browser.
 */

export interface ViewerCard {
  cardId: number;
  quantity: number;
  name: string;
  /** Arena's own decoded colors (see extractArenaCards.ts) - always available. */
  colors: string[];
  /** Arena's own decoded types (e.g. ["Creature"]) - always available. */
  types: string[];
  /** Scryfall's mana_cost string, or null if this card has no Scryfall enrichment yet. */
  manaCost: string | null;
  /** Scryfall's oracle text, or null if unenriched. Shown as a hover fallback when there's no image. */
  oracleText: string | null;
  /** Scryfall's normal-size image URL, or null if unenriched - the hover-preview image. */
  imageNormal: string | null;
}

/** A card as it appears inside a draft pick's pack - see htmlCardHelpers.ts's HtmlCard (this shape is structurally compatible with it). */
export interface DraftViewerPickCard {
  cardId: number;
  name: string;
  colors: string[];
  oracleText: string | null;
  imageNormal: string | null;
}

export interface DraftViewerPick {
  pack: number;
  pick: number;
  /** The full pack as first offered at this pick, in original order (includes every id in pickedCardIds below). */
  packCards: DraftViewerPickCard[];
  /** Every card taken at this pick - almost always one, but see types.ts's DraftPickMade.grpIds comment for "Pick Two" draft. */
  pickedCardIds: number[];
  /** Where this same physical pack was next seen (wheeled back), or null - see draftWheel.ts's WheelInfo. */
  wheeledAt: { pack: number; pick: number } | null;
  /** Cards gone from this pack by the wheel point, taken by other pod members (excludes every card this player took at this pick) - empty/meaningless when wheeledAt is null. */
  takenByOthers: DraftViewerPickCard[];
}

export interface DeckViewerData {
  eventId: string;
  format: string;
  definitionLabel: string;
  deckName: string | null;
  /** From deckColors.ts's deriveDeckColors().comboKey. */
  colorCombo: string;
  winRate: { wins: number; losses: number; total: number; pct: string };
  mainDeck: ViewerCard[];
  /** Null when there's no DraftCompleted captured for this run to derive a sideboard from (see eventHistory.ts). */
  sideboard: ViewerCard[] | null;
  /** Pick-by-pick draft data (milestone 7 phase 6) - empty when this run has no captured DraftPickMade/DraftPackSeen data (e.g. not a draft event, or nothing was captured), in which case the "Draft" tab isn't shown at all. */
  draft: DraftViewerPick[];
}

function cardRowHtml(card: ViewerCard): string {
  return `
    <li class="card-row" tabindex="0">
      <span class="qty">${card.quantity}x</span>
      ${colorDotsHtml(card.colors)}
      <span class="name">${escapeHtml(card.name)}</span>
      <div class="preview">${cardPreviewInnerHtml(card)}</div>
    </li>`;
}

function deckListHtml(title: string, cards: ViewerCard[] | null): string {
  if (cards === null) {
    return `<section class="deck-column"><h2>${escapeHtml(title)}</h2><p class="muted">Not captured for this run (no DraftCompleted event, so the pool/sideboard can't be derived).</p></section>`;
  }
  const totalCount = cards.reduce((n, c) => n + c.quantity, 0);
  const sorted = [...cards].sort((a, b) => a.name.localeCompare(b.name));
  return `
    <section class="deck-column">
      <h2>${escapeHtml(title)} <span class="muted">(${totalCount} cards)</span></h2>
      <ul class="card-list">
        ${sorted.map(cardRowHtml).join("")}
      </ul>
    </section>`;
}

function curveHtml(mainDeck: ViewerCard[]): string {
  const cardInfo = new Map<number, CardCurveInfo>();
  const cardsById = new Map<number, ViewerCard>();
  for (const c of mainDeck) {
    cardInfo.set(c.cardId, { types: c.types, manaCost: c.manaCost });
    cardsById.set(c.cardId, c);
  }
  const buckets = groupByManaCurve(
    mainDeck.map((c) => ({ cardId: c.cardId, quantity: c.quantity })),
    cardInfo,
  );
  const maxCount = Math.max(1, ...buckets.map((b) => b.creatureCount + b.nonCreatureCount));

  return `
    <section class="curve">
      <h2>Mana curve <span class="muted">(creature vs non-creature - cost from Scryfall enrichment, unavailable cards fall into "Unknown cost")</span></h2>
      <div class="curve-chart">
        ${buckets
          .map((b) => {
            const total = b.creatureCount + b.nonCreatureCount;
            const heightPct = Math.round((total / maxCount) * 100);
            const namesInBucket = b.cardIds
              .map((entry) => cardsById.get(entry.cardId))
              .filter((c): c is ViewerCard => Boolean(c))
              .map((c) => `${c.quantity}x ${escapeHtml(c.name)}`)
              .join(", ");
            return `
              <div class="curve-bar-wrap" title="${escapeHtml(namesInBucket)}">
                <div class="curve-bar" style="height:${heightPct}%">
                  <div class="curve-bar-creature" style="height:${total > 0 ? Math.round((b.creatureCount / total) * 100) : 0}%"></div>
                </div>
                <div class="curve-count">${total}</div>
                <div class="curve-label">${escapeHtml(b.label)}</div>
              </div>`;
          })
          .join("")}
      </div>
      <p class="muted legend"><span class="swatch swatch-creature"></span> creature &nbsp; <span class="swatch swatch-noncreature"></span> non-creature</p>
    </section>`;
}

function draftPickCardHtml(card: DraftViewerPickCard, isPick: boolean): string {
  return `
    <li class="card-row draft-card-row${isPick ? " picked" : ""}" tabindex="0">
      ${colorDotsHtml(card.colors)}
      <span class="name">${escapeHtml(card.name)}</span>
      ${isPick ? `<span class="picked-badge" title="You took this">&#10003;</span>` : ""}
      <div class="preview">${cardPreviewInnerHtml(card)}</div>
    </li>`;
}

function draftPickHtml(entry: DraftViewerPick): string {
  const wheelLine = entry.wheeledAt
    ? `Wheeled to Pack ${entry.wheeledAt.pack}, Pick ${entry.wheeledAt.pick}` +
      (entry.takenByOthers.length > 0
        ? ` &middot; taken by others: ${entry.takenByOthers.map((c) => escapeHtml(c.name)).join(", ")}`
        : ` &middot; nothing else was taken`)
    : `Did not wheel back`;

  // Almost always one card taken per pick; a "Pick Two" pick (see types.ts's
  // DraftPickMade.grpIds comment) takes 2, hence pickedCardIds being a set.
  const pickedSet = new Set(entry.pickedCardIds);
  const takenNote = entry.pickedCardIds.length === 1 ? "" : ` <span class="muted">(${entry.pickedCardIds.length} cards taken this pick)</span>`;

  return `
    <section class="draft-pick">
      <h3>Pack ${entry.pack}, Pick ${entry.pick}${takenNote} <span class="muted">(${entry.packCards.length} card${entry.packCards.length === 1 ? "" : "s"} offered)</span></h3>
      <ul class="card-list draft-card-list">
        ${entry.packCards.map((c) => draftPickCardHtml(c, pickedSet.has(c.cardId))).join("")}
      </ul>
      <p class="muted wheel-line">${wheelLine}</p>
    </section>`;
}

function draftTabHtml(picks: DraftViewerPick[]): string {
  if (picks.length === 0) {
    return `<p class="muted">No draft pick data captured for this run.</p>`;
  }
  return `<div class="draft-picks">${picks.map(draftPickHtml).join("")}</div>`;
}

export function generateDeckViewerHtml(data: DeckViewerData): string {
  const { wins, losses, total, pct } = data.winRate;
  const recordLine = total > 0 ? `${wins}-${losses} (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : `${wins}-${losses} (no decided matches yet)`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(data.deckName ?? data.definitionLabel)} - MTGA Tracker</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #14151a; color: #e8e8ec; margin: 0; padding: 24px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 0 0 8px; color: #cfd2dc; }
  .muted { color: #8a8d99; font-weight: normal; font-size: 0.85em; }
  .header { margin-bottom: 20px; border-bottom: 1px solid #2a2c36; padding-bottom: 12px; }
  .header .meta { color: #b7bac6; font-size: 0.95rem; }
  .tabs { margin: 16px 0; }
  .tabs button { background: #22232c; color: #e8e8ec; border: 1px solid #34364280; padding: 6px 14px; border-radius: 6px; cursor: pointer; margin-right: 8px; font-size: 0.9rem; }
  .tabs button.active { background: #3d4ee0; border-color: #3d4ee0; }
  .view { display: none; }
  .view.active { display: block; }
  .deck-columns { display: flex; gap: 32px; flex-wrap: wrap; }
  .deck-column { flex: 1 1 320px; min-width: 280px; }
  .card-list { list-style: none; margin: 0; padding: 0; }
  .card-row { position: relative; display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px; cursor: default; }
  .card-row:hover, .card-row:focus { background: #22232c; outline: none; }
  .card-row:hover .preview, .card-row:focus .preview { display: block; }
  .qty { color: #8a8d99; width: 2.2em; text-align: right; flex-shrink: 0; }
  .name { flex: 1; }
  ${CARD_PREVIEW_CSS}
  .curve-chart { display: flex; align-items: flex-end; gap: 12px; height: 220px; margin: 16px 0; }
  .curve-bar-wrap { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; flex: 1; height: 100%; }
  .curve-bar { width: 100%; max-width: 48px; background: #4fa8e0; border-radius: 4px 4px 0 0; display: flex; flex-direction: column; justify-content: flex-end; min-height: 2px; }
  .curve-bar-creature { background: #4fae6a; border-radius: 4px 4px 0 0; width: 100%; }
  .curve-count { margin-top: 4px; font-size: 0.8rem; color: #cfd2dc; }
  .curve-label { font-size: 0.8rem; color: #8a8d99; }
  .legend { margin-top: 8px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; }
  .swatch-creature { background: #4fae6a; }
  .swatch-noncreature { background: #4fa8e0; }
  .draft-picks { display: flex; flex-direction: column; gap: 20px; }
  .draft-pick { border-bottom: 1px solid #2a2c36; padding-bottom: 14px; }
  .draft-card-list { display: flex; flex-wrap: wrap; gap: 2px 18px; }
  .draft-card-row { width: 220px; }
  .draft-card-row.picked .name { color: #6fd57a; font-weight: 600; }
  .picked-badge { color: #6fd57a; flex-shrink: 0; }
  .wheel-line { margin-top: 6px; }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(data.deckName ?? "(no deck submission captured)")}</h1>
    <div class="meta">[${escapeHtml(data.format)}] ${escapeHtml(data.definitionLabel)} &middot; ${escapeHtml(data.eventId)}</div>
    <div class="meta">Colors: <strong>${escapeHtml(data.colorCombo)}</strong> &middot; Record: <strong>${recordLine}</strong></div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" data-view="list" onclick="showView('list')">Deck list</button>
    <button class="tab-btn" data-view="curve" onclick="showView('curve')">Curve</button>
    ${data.draft.length > 0 ? `<button class="tab-btn" data-view="draft" onclick="showView('draft')">Draft</button>` : ""}
  </div>

  <div id="view-list" class="view active" data-view="list">
    <div class="deck-columns">
      ${deckListHtml("Maindeck", data.mainDeck)}
      ${deckListHtml("Sideboard", data.sideboard)}
    </div>
  </div>

  <div id="view-curve" class="view" data-view="curve">
    ${curveHtml(data.mainDeck)}
  </div>

  ${
    data.draft.length > 0
      ? `<div id="view-draft" class="view" data-view="draft">
    ${draftTabHtml(data.draft)}
  </div>`
      : ""
  }

  <script>
    function showView(name) {
      document.querySelectorAll('.view').forEach(function (el) { el.classList.toggle('active', el.dataset.view === name); });
      document.querySelectorAll('.tab-btn').forEach(function (el) { el.classList.toggle('active', el.dataset.view === name); });
    }
  </script>
</body>
</html>
`;
}
