import { groupByManaCurve, type CardCurveInfo, type CurveBucket } from "./domain/manaCurve.js";
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
 *
 * Milestone 13 (2026-09-28): added a "Visual" tab that lays the *maindeck*
 * out like Arena's own deck-builder screen - one column per mana-cost
 * bucket (reusing domain/manaCurve.ts's existing bucketing, same rules as
 * the "Curve" tab, rather than a second set of bucketing logic), each
 * holding a fanned, overlapping stack of real card-image thumbnails (only
 * a sliver of each card shows except the last in its column; hovering a
 * card lifts it above the rest of the stack to show it in full). Lands get
 * their own column in that same row (not a separate section) rather than
 * being silently dropped from the view. The sideboard deliberately keeps
 * its existing text-list treatment (deckListHtml) - this visual layout is
 * for the maindeck only. Card thumbnail size comes from
 * DeckViewerData.cardImageWidthPx (baked into the page as a CSS variable at
 * generation time) - see the "Card size" Settings section in
 * electron/main.ts for where that value is chosen and persisted.
 *
 * Milestone 14 (2026-09-28): reworked per user feedback on the first cut of
 * the Visual tab above - cards now overlap (fanned) instead of stacking
 * with a gap between every card, lands moved from their own section into a
 * plain extra column in the same row, and the creature/spell "Separate"
 * toggle no longer swaps in a whole different sub-layout (two separately
 * headed groups) - it now just opens a small gap at the creature/spell
 * boundary *within* each column's stack, everything else identical. Each
 * card carries a `data-role` ("creature"/"spell"/"land") and cards are
 * always ordered creatures-then-spells within a column (both modes); the
 * `.separated` toggle only changes the CSS margin on the one card
 * immediately after that boundary (matched via the `[data-role=creature] +
 * [data-role=spell]` adjacent-sibling selector - no JS reordering, no
 * duplicated markup for the two modes).
 *
 * Milestone 15 (2026-09-29): three more user-reported/requested changes -
 *
 * 1. The Visual tab's quantity badge used to sit at the bottom-right of each
 *    card image (`.visual-card-qty`, bottom:4px;right:4px), which is exactly
 *    the region the *next* card in a fanned/overlapping stack paints over -
 *    so it was invisible for every card except the last in its column. It
 *    now uses the shared `.qty-badge` class (see htmlCardHelpers.ts) at the
 *    top-right of the art instead - the one part of every card that stays
 *    visible regardless of overlap - and the same badge now also shows up
 *    on a card's hover-preview ("zoomed") image, everywhere in the app.
 * 2. Hovering down through an overlapping column could get "stuck" showing
 *    a previous card's preview - see initVisualHover()'s comment below for
 *    the root cause (a hovered/elevated card's hit-test box, not just its
 *    visible sliver, was grabbing the pointer) and its fix.
 * 3. The "Deck list" tab's Maindeck/Sideboard lists are now grouped into
 *    type sections (Creatures, Instants / Sorceries, Artifacts,
 *    Enchantments, Battles, Planeswalkers, Lands, Other) instead of one
 *    flat alphabetical list - see classifyCardType/CARD_TYPE_* below.
 *
 * Also (not a rendering change, but shown in this page's header): the
 * "Colors" line now calls out splash colors separately from the deck's main
 * colors - see deckColors.ts's DeckColorProfile.splashColors and this
 * file's DeckViewerData.splashColors.
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
  /** Milestone 15: deckColors.ts's deriveDeckColors().splashColors - colors present but below the main-color threshold, shown separately from colorCombo rather than silently dropped. Optional (defaults to none) for older callers/tests that don't pass it. */
  splashColors?: string[];
  winRate: { wins: number; losses: number; total: number; pct: string };
  mainDeck: ViewerCard[];
  /** Null when there's no DraftCompleted captured for this run to derive a sideboard from (see eventHistory.ts). */
  sideboard: ViewerCard[] | null;
  /** Pick-by-pick draft data (milestone 7 phase 6) - empty when this run has no captured DraftPickMade/DraftPackSeen data (e.g. not a draft event, or nothing was captured), in which case the "Draft" tab isn't shown at all. */
  draft: DraftViewerPick[];
  /** Milestone 13: card thumbnail width (px) for the "Visual" tab, from the Settings window's "Card size" choice. Defaults to DEFAULT_CARD_IMAGE_WIDTH_PX when omitted (e.g. in older callers/tests). */
  cardImageWidthPx?: number;
}

/** Milestone 13: the "Visual" tab's default card-thumbnail width, used whenever DeckViewerData.cardImageWidthPx is omitted. Also the fallback main.ts's CARD_SIZE_PRESETS resolves to if the persisted setting is ever missing/invalid. */
export const DEFAULT_CARD_IMAGE_WIDTH_PX = 130;

function cardRowHtml(card: ViewerCard): string {
  return `
    <li class="card-row" tabindex="0">
      <span class="qty">${card.quantity}x</span>
      ${colorDotsHtml(card.colors)}
      <span class="name">${escapeHtml(card.name)}</span>
      <div class="preview">${cardPreviewInnerHtml(card)}</div>
    </li>`;
}

/**
 * Milestone 15: which "Deck list" tab section a card belongs in, based on
 * Arena's own decoded `types` (see extractArenaCards.ts's decodeArenaTypes -
 * always one of exactly these 7 strings, no others exist). This is a
 * *classification* order (first match wins, for a card with more than one
 * type) - it's deliberately not the same as CARD_TYPE_DISPLAY_ORDER below,
 * which is just the order sections are shown in:
 *
 * - Land is checked first because a land stays a land for deck-building
 *   purposes even on the rare card that's also statically some other type
 *   (e.g. Dryad Arbor, a Land Creature) - it belongs with the other lands,
 *   not buried in a 1-card "Creatures" section.
 * - Creature comes next since it's the single most common category, and an
 *   Artifact Creature / Enchantment Creature reads as a creature first.
 * - Planeswalker and Battle are checked before the spell/permanent types
 *   below since they're rare and always worth their own bucket rather than
 *   vanishing into whatever secondary type they might carry.
 * - Instant/Sorcery, Artifact, Enchantment are the remaining, mutually
 *   exclusive base types (a card is never both Instant and Artifact, etc.,
 *   under Arena's own decoding), so their relative order here doesn't
 *   actually matter for real cards - listed in the order the user asked
 *   for the sections to read, for consistency with CARD_TYPE_DISPLAY_ORDER.
 */
const CARD_TYPE_CLASSIFICATION_ORDER: Array<{ label: string; match: (types: string[]) => boolean }> = [
  { label: "Lands", match: (t) => t.includes("Land") },
  { label: "Creatures", match: (t) => t.includes("Creature") },
  { label: "Planeswalkers", match: (t) => t.includes("Planeswalker") },
  { label: "Battles", match: (t) => t.includes("Battle") },
  { label: "Instants / Sorceries", match: (t) => t.includes("Instant") || t.includes("Sorcery") },
  { label: "Artifacts", match: (t) => t.includes("Artifact") },
  { label: "Enchantments", match: (t) => t.includes("Enchantment") },
];

/** Milestone 15: display order for the "Deck list" tab's grouped sections - the order the user asked for ("Creature, Instant/Sorcery, Artifacts, Enchantments, Battlefields, Planeswalkers and Lands"), independent of the classification priority above. "Other" is a catch-all for a card with none of Arena's 7 known types (unenriched/unrecognized data) - only shown if it's ever non-empty. */
const CARD_TYPE_DISPLAY_ORDER = ["Creatures", "Instants / Sorceries", "Artifacts", "Enchantments", "Battles", "Planeswalkers", "Lands", "Other"];

function classifyCardType(types: string[]): string {
  for (const group of CARD_TYPE_CLASSIFICATION_ORDER) {
    if (group.match(types)) return group.label;
  }
  return "Other";
}

/**
 * Milestone 15: the "Deck list" tab now groups each column (Maindeck,
 * Sideboard) into type sections instead of one flat alphabetical list - see
 * classifyCardType/CARD_TYPE_DISPLAY_ORDER above. Within a section, cards
 * are still sorted alphabetically exactly as before; only the top-level
 * grouping is new. A section with no cards is skipped entirely rather than
 * shown empty.
 */
function deckListHtml(title: string, cards: ViewerCard[] | null): string {
  if (cards === null) {
    return `<section class="deck-column"><h2>${escapeHtml(title)}</h2><p class="muted">Not captured for this run (no DraftCompleted event, so the pool/sideboard can't be derived).</p></section>`;
  }
  const totalCount = cards.reduce((n, c) => n + c.quantity, 0);

  const byGroup = new Map<string, ViewerCard[]>();
  for (const c of cards) {
    const label = classifyCardType(c.types);
    let group = byGroup.get(label);
    if (!group) {
      group = [];
      byGroup.set(label, group);
    }
    group.push(c);
  }

  const groupsHtml = CARD_TYPE_DISPLAY_ORDER.map((label) => {
    const group = byGroup.get(label);
    if (!group || group.length === 0) return "";
    const groupCount = group.reduce((n, c) => n + c.quantity, 0);
    const sorted = [...group].sort((a, b) => a.name.localeCompare(b.name));
    return `
        <div class="deck-type-group">
          <h3>${escapeHtml(label)} <span class="muted">(${groupCount})</span></h3>
          <ul class="card-list">
            ${sorted.map(cardRowHtml).join("")}
          </ul>
        </div>`;
  }).join("");

  return `
    <section class="deck-column">
      <h2>${escapeHtml(title)} <span class="muted">(${totalCount} cards)</span></h2>
      ${groupsHtml}
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

/** Milestone 13/14: a card's role within its "Visual" tab column - drives both which sub-group it sorts into (creatures before spells, within a mana-cost column) and the `data-role` attribute the "Separate creatures / spells" toggle's CSS selector keys off (see visualColumnHtml/generateDeckViewerHtml's stylesheet). Lands never split by creature/spell (that distinction isn't meaningful for a land), so they're their own role, unaffected by the toggle either way. */
type VisualCardRole = "creature" | "spell" | "land";

/** Milestone 13/14/15: an always-visible card thumbnail for the "Visual" tab - unlike cardRowHtml above, the image itself is the row (not a hover-only preview), fanned into an overlapping stack by the CSS in generateDeckViewerHtml (each card's negative top margin, see `.visual-card`), with a quantity badge for stacks of more than one (the shared `.qty-badge` class from htmlCardHelpers.ts - milestone 15 moved this from the bottom-right, which a fanned stack's next card paints over, to the top-right, which never gets covered) and a hover panel (reusing cardPreviewInnerHtml, same as every other card in this project) for the enlarged/fallback view. `data-role` is what the creature/spell "Separate" toggle's adjacent-sibling CSS selector matches against - see visualColumnHtml. Which card is actually "hovered" is driven by JS (see initVisualHover in generateDeckViewerHtml), not plain CSS :hover - `is-hovered` is the class it toggles. */
function visualCardHtml(card: ViewerCard, role: VisualCardRole): string {
  const badge = card.quantity > 1 ? `<span class="qty-badge">x${card.quantity}</span>` : "";
  const inner = card.imageNormal
    ? `<img src="${escapeHtml(card.imageNormal)}" alt="${escapeHtml(card.name)}">`
    : `<div class="visual-card-placeholder">${colorDotsHtml(card.colors)}<span>${escapeHtml(card.name)}</span></div>`;
  return `
    <div class="visual-card" data-role="${role}" tabindex="0">
      ${inner}
      ${badge}
      <div class="preview">${cardPreviewInnerHtml(card)}</div>
    </div>`;
}

/**
 * Renders one mana-cost column (or the "Land" column - same function, no
 * special-casing needed beyond skipping the creature/spell split for it,
 * since a land's role is always "land"). Cards are always ordered
 * creatures-then-spells within a non-land column (both toggle modes) -
 * only the CSS margin at that boundary changes based on whether
 * `.visual-section` has the `.separated` class (see generateDeckViewerHtml's
 * stylesheet's `[data-role=creature] + [data-role=spell]` rule) - so
 * "separating" never swaps in a different layout, just opens a small gap
 * in the existing stack.
 */
function visualColumnHtml(bucket: CurveBucket, cardsById: Map<number, ViewerCard>): string {
  const cards = bucket.cardIds
    .map((entry) => cardsById.get(entry.cardId))
    .filter((c): c is ViewerCard => Boolean(c));
  if (cards.length === 0) return "";

  const byName = (a: ViewerCard, b: ViewerCard) => a.name.localeCompare(b.name);
  let ordered: Array<{ card: ViewerCard; role: VisualCardRole }>;
  if (bucket.label === "Land") {
    ordered = [...cards].sort(byName).map((card) => ({ card, role: "land" as const }));
  } else {
    const creatures = cards.filter((c) => c.types.includes("Creature")).sort(byName);
    const spells = cards.filter((c) => !c.types.includes("Creature")).sort(byName);
    ordered = [
      ...creatures.map((card) => ({ card, role: "creature" as const })),
      ...spells.map((card) => ({ card, role: "spell" as const })),
    ];
  }

  return `
    <div class="visual-column">
      <div class="visual-column-header">${escapeHtml(bucket.label)}</div>
      <div class="visual-column-cards">${ordered.map(({ card, role }) => visualCardHtml(card, role)).join("")}</div>
    </div>`;
}

function visualHtml(mainDeck: ViewerCard[]): string {
  const cardInfo = new Map<number, CardCurveInfo>();
  const cardsById = new Map<number, ViewerCard>();
  for (const c of mainDeck) {
    cardInfo.set(c.cardId, { types: c.types, manaCost: c.manaCost });
    cardsById.set(c.cardId, c);
  }
  // One pass over the whole maindeck (lands included) - CURVE_BUCKET_ORDER
  // already places "Land" among the mana-cost buckets, so it just becomes
  // one more column in the same row rather than a separate section.
  const buckets = groupByManaCurve(
    mainDeck.map((c) => ({ cardId: c.cardId, quantity: c.quantity })),
    cardInfo,
  );
  const columns = buckets
    .map((b) => visualColumnHtml(b, cardsById))
    .filter((html) => html.length > 0)
    .join("");

  return `
    <section class="visual-section" id="visual-section">
      <div class="visual-toolbar">
        <h2>Maindeck by mana cost</h2>
        <button id="visual-separate-btn" class="toggle-btn" onclick="toggleVisualSeparate()">Separate creatures / spells</button>
      </div>
      <div class="visual-columns">
        ${columns}
      </div>
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
  const cardImageWidthPx = data.cardImageWidthPx ?? DEFAULT_CARD_IMAGE_WIDTH_PX;
  const splashColors = data.splashColors ?? [];
  const splashLine = splashColors.length > 0 ? ` <span class="muted">(splash: ${splashColors.map((c) => escapeHtml(c)).join("")})</span>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(data.deckName ?? data.definitionLabel)} - MTGA Tracker</title>
<style>
  :root { color-scheme: dark; --card-img-width: ${cardImageWidthPx}px; --card-overlap: calc(var(--card-img-width) * -1.05); }
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
  .deck-type-group { margin-bottom: 14px; }
  .deck-type-group:last-child { margin-bottom: 0; }
  .deck-type-group h3 { font-size: 0.78rem; margin: 0 0 4px; color: #9296a3; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
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
  .visual-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .toggle-btn { background: #22232c; color: #e8e8ec; border: 1px solid #34364280; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  .toggle-btn.active { background: #3d4ee0; border-color: #3d4ee0; }
  .visual-columns { display: flex; gap: 20px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
  .visual-column { display: flex; flex-direction: column; flex: 0 0 auto; width: var(--card-img-width); }
  .visual-column-header { text-align: center; font-size: 0.8rem; color: #8a8d99; padding-bottom: 4px; margin-bottom: 14px; border-bottom: 1px solid #2a2c36; }
  /* Fanned/overlapping stack: every card after the first in a column pulls up
     over the previous card's bottom (via the negative --card-overlap margin),
     so only a sliver of each earlier card peeks out above the next one -
     matching the Arena deck-builder screenshot this tab is modeled on. The
     card lowest in a column's stack is the one shown in full; hovering any
     card lifts it (z-index + a small translateY) above the ones after it so
     it can be seen whole without leaving the stack. Milestone 15: "hovering"
     here means the JS-driven .is-hovered class (see initVisualHover below),
     not plain CSS :hover - see that function's comment for why. */
  .visual-column-cards { display: flex; flex-direction: column; }
  .visual-card { position: relative; transition: transform 120ms ease; }
  .visual-card:not(:first-child) { margin-top: var(--card-overlap); }
  .visual-card.is-hovered, .visual-card:focus { z-index: 30; transform: translateY(-6px); }
  .visual-card img { width: 100%; border-radius: 6px; display: block; box-shadow: 0 2px 6px rgba(0,0,0,0.5); }
  .visual-card.is-hovered img, .visual-card:focus img { box-shadow: 0 10px 24px rgba(0,0,0,0.65); }
  .visual-card.is-hovered .preview, .visual-card:focus .preview { display: block; }
  .visual-card-placeholder { width: var(--card-img-width); aspect-ratio: 5 / 7; background: #22232c; border: 1px solid #34364280; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 6px; text-align: center; font-size: 0.7rem; }
  /* "Separate creatures / spells": same layout either way (see the header
     comment) - this just opens a small gap at the one card immediately
     after the last creature in a column, instead of the usual overlap. */
  .visual-section.separated .visual-card[data-role="creature"] + .visual-card[data-role="spell"] { margin-top: 18px; }
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
    <div class="meta">Colors: <strong>${escapeHtml(data.colorCombo)}</strong>${splashLine} &middot; Record: <strong>${recordLine}</strong></div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" data-view="list" onclick="showView('list')">Deck list</button>
    <button class="tab-btn" data-view="visual" onclick="showView('visual')">Visual</button>
    <button class="tab-btn" data-view="curve" onclick="showView('curve')">Curve</button>
    ${data.draft.length > 0 ? `<button class="tab-btn" data-view="draft" onclick="showView('draft')">Draft</button>` : ""}
  </div>

  <div id="view-list" class="view active" data-view="list">
    <div class="deck-columns">
      ${deckListHtml("Maindeck", data.mainDeck)}
      ${deckListHtml("Sideboard", data.sideboard)}
    </div>
  </div>

  <div id="view-visual" class="view" data-view="visual">
    ${visualHtml(data.mainDeck)}
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
    function toggleVisualSeparate() {
      var section = document.getElementById('visual-section');
      var btn = document.getElementById('visual-separate-btn');
      var nowSeparated = !section.classList.contains('separated');
      section.classList.toggle('separated', nowSeparated);
      btn.classList.toggle('active', nowSeparated);
      btn.textContent = nowSeparated ? 'Show combined' : 'Separate creatures / spells';
    }
    // Milestone 15: the Visual tab's fanned/overlapping card stacks made
    // plain CSS :hover ambiguous while moving the cursor down a column.
    // Hovering a card lifts it with a high z-index so its full art shows -
    // but that elevation makes its *entire* card-height hit-test box (not
    // just the sliver that's visually its own) paint on top of every card
    // below it too, so the cursor can keep "hovering" that earlier card even
    // once it's visually over a later one's face. Fixed by not using :hover
    // to drive this at all: a per-column mousemove listener figures out
    // which card the cursor is really over by checking each card's current
    // rect from the back of the stack forward (later cards paint on top by
    // default - that's the whole point of the fan - so checking them first
    // finds the right one regardless of any hover-elevation elsewhere in the
    // column) and toggles a plain .is-hovered class. While the cursor is over
    // the open preview panel itself, the handler leaves the active card
    // alone rather than trying to resolve it against the column's cards (the
    // preview renders outside the column's own width) - so looking closer at
    // the zoomed art doesn't dismiss it, and it's never what decides which
    // card counts as "hovered" either.
    function initVisualHover() {
      document.querySelectorAll('.visual-column-cards').forEach(function (col) {
        var cards = Array.prototype.slice.call(col.querySelectorAll('.visual-card'));
        var active = null;
        function setActive(card) {
          if (active === card) return;
          if (active) active.classList.remove('is-hovered');
          active = card;
          if (active) active.classList.add('is-hovered');
        }
        col.addEventListener('mousemove', function (e) {
          if (e.target && e.target.closest && e.target.closest('.preview')) return;
          var target = null;
          for (var i = cards.length - 1; i >= 0; i--) {
            var rect = cards[i].getBoundingClientRect();
            if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
              target = cards[i];
              break;
            }
          }
          setActive(target);
        });
        col.addEventListener('mouseleave', function () { setActive(null); });
      });
    }
    initVisualHover();
  </script>
</body>
</html>
`;
}
