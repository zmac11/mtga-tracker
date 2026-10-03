/**
 * Small HTML-building helpers shared between the browser pages this project
 * generates (deckViewerHtml.ts, milestone 7 phase 4; draftProgressHtml.ts,
 * phase 5) - escaping, the WUBRG color-dot markup, and the "hover preview"
 * fallback chain (real image -> oracle text -> "no data yet" message) that
 * both pages use identically for a card. Pulled out here rather than
 * duplicated once phase 5 needed the exact same preview logic deckViewerHtml
 * already had - each page still owns its own full inline <style>/layout, only
 * this shared bit of markup-building logic moved.
 *
 * Milestone 15 (2026-09-29): `HtmlCard.quantity` is optional and, when set to
 * more than 1, renders a small "xN" badge over the card's own art in the
 * hover-preview panel too - not just in the row/thumbnail the preview pops
 * out from (see deckViewerHtml.ts's visualCardHtml/cardRowHtml, both of which
 * already show quantity of their own; this is specifically "show it in the
 * zoomed view as well", per the user's ask). `.qty-badge` is the one shared
 * class for this across every place a quantity badge appears on a card image
 * in this project (a plain card-row's hover preview, a draft pack card's
 * preview, and the Visual tab's own always-visible thumbnail badge in
 * deckViewerHtml.ts) - one definition here, reused everywhere, instead of
 * three near-identical ad hoc badges drifting apart.
 *
 * Milestone 16 (2026-09-29): `.preview` always opened below-and-right of its
 * trigger by plain CSS (`left: 100%; top: 0`) - fine near the top of the
 * page, but a trigger near the bottom or right edge of the window pushed the
 * panel partly off-screen, which read as a flicker while scrolling/hovering
 * down a list (see CARD_PREVIEW_JS below). `CARD_PREVIEW_JS`, like
 * `CARD_PREVIEW_CSS`, is one shared string both deckViewerHtml.ts and
 * draftProgressHtml.ts interpolate into their own inline `<script>` - one
 * implementation of "keep the preview on screen", not two.
 */

export interface HtmlCard {
  name: string;
  /** Arena's own decoded colors (see extractArenaCards.ts) - always available. */
  colors: string[];
  /** Scryfall's oracle text, or null if unenriched. Shown as a hover fallback when there's no image. */
  oracleText: string | null;
  /** Scryfall's normal-size image URL, or null if unenriched - the hover-preview image. */
  imageNormal: string | null;
  /** Milestone 15: how many copies of this card - when present and > 1, the preview panel shows an "xN" badge over the art, same as the source row/thumbnail. Optional so callers with no meaningful quantity (draft pack cards - always exactly one copy on offer) don't need to pass it. */
  quantity?: number;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function colorDotsHtml(colors: string[]): string {
  if (colors.length === 0) return `<span class="dot dot-C" title="Colorless"></span>`;
  return colors.map((c) => `<span class="dot dot-${escapeHtml(c)}" title="${escapeHtml(c)}"></span>`).join("");
}

/** Milestone 15: the "xN" quantity badge markup, shared by every card-image context that wants one - see this file's header comment. Empty string when there's nothing worth badging (no quantity, or exactly 1 copy). */
function qtyBadgeHtml(quantity: number | undefined): string {
  return quantity !== undefined && quantity > 1 ? `<span class="qty-badge">x${quantity}</span>` : "";
}

/**
 * The contents of a `.preview` hover panel for one card: its real Scryfall
 * image if enriched, else its oracle text, else a plain message pointing at
 * `npm run refresh-cards`. Callers wrap this in whatever container markup
 * their page uses (see cardRowHtml in deckViewerHtml.ts / packCardHtml in
 * draftProgressHtml.ts) - this function only builds the fallback-chain
 * content itself, so both pages show exactly the same thing for the same
 * card data.
 */
export function cardPreviewInnerHtml(card: HtmlCard): string {
  const badge = qtyBadgeHtml(card.quantity);
  if (card.imageNormal) {
    // Milestone 15: wrapped in its own positioned container so the badge
    // sits over the art itself (top-right, just below where a real card's
    // mana symbols print) rather than floating relative to the whole
    // (possibly taller, oracle-text) preview panel.
    return `<div class="preview-img-wrap"><img src="${escapeHtml(card.imageNormal)}" alt="${escapeHtml(card.name)}">${badge}</div>`;
  }
  if (card.oracleText) {
    return `<div class="preview-text">${badge}<strong>${escapeHtml(card.name)}</strong><br>${escapeHtml(card.oracleText).replace(/\n/g, "<br>")}</div>`;
  }
  return `<div class="preview-text">${escapeHtml(card.name)} - no image or text yet (run <code>npm run refresh-cards</code> without --skip-enrich)</div>`;
}

/**
 * The shared CSS the classes above need (color dots, the hover-preview
 * panel, the inline `code` tag) - each page still inlines its own full
 * <style> block (kept self-contained per page, no shared CSS file request
 * over the network), but both interpolate this same string in so the class
 * names/behavior stay identical rather than drifting.
 */
export const CARD_PREVIEW_CSS = `
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .dot-W { background: #f8f6d8; } .dot-U { background: #4fa8e0; } .dot-B { background: #6b6b76; }
  .dot-R { background: #e05a4f; } .dot-G { background: #4fae6a; } .dot-C { background: #55586b; }
  .preview { display: none; position: absolute; left: 100%; top: 0; z-index: 10; margin-left: 12px; background: var(--popover, #1c1d24); border: 1px solid var(--border-3, #3a3c48); border-radius: 8px; padding: 8px; width: 260px; max-height: calc(100vh - 24px); overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  /* Milestone 16: collision-aware flip classes - see CARD_PREVIEW_JS. .flip-up
     opens the panel upward (its bottom edge anchored to the trigger's top)
     instead of downward, when there isn't room below. .flip-left opens it to
     the left of the trigger instead of the right, when there isn't room on
     the right. Either, both, or neither can be active at once. */
  .preview.flip-up { top: auto; bottom: 0; }
  .preview.flip-left { left: auto; right: 100%; margin-left: 0; margin-right: 12px; }
  .preview img { width: 100%; border-radius: 6px; display: block; }
  .preview-img-wrap { position: relative; }
  .preview-text { position: relative; font-size: 0.85rem; line-height: 1.4; }
  /* Milestone 15: shared "xN" quantity badge - see this file's header comment for every place it's reused (a hover preview's art here, plus the Visual tab's always-visible thumbnail badge in deckViewerHtml.ts, which pulls in this stylesheet). Positioned in the upper-right corner of whatever it's placed in, just below where a real card's mana-cost symbols print - the one spot that's never covered by a fanned/overlapping stack's next card (see deckViewerHtml.ts's Milestone 15 comment for why that mattered). */
  .qty-badge { position: absolute; top: 15%; right: 6px; background: rgba(0,0,0,0.78); color: #fff; font-size: 0.7rem; font-weight: 600; padding: 1px 5px; border-radius: 4px; z-index: 2; line-height: 1.3; }
  code { background: var(--surface-2, #22232c); padding: 1px 5px; border-radius: 4px; }
`;

/**
 * Milestone 16: keeps every `.preview` panel fully on screen, no matter
 * where its trigger (a `.card-row`, `.pick-row`, or the Visual tab's
 * `.visual-card`) sits on the page. `.preview` opens below-and-right of its
 * trigger by default (plain CSS) - this measures the real trigger and panel
 * geometry right as the panel is about to become visible and flips it to
 * whichever side actually has room, the same "collision-aware" approach a
 * tooltip library like Floating UI uses, done here in plain JS since this
 * project doesn't pull in a library for one positioning check. \`trigger\` is
 * whatever element owns the \`.preview\` (its CSS positioning context) -
 * \`positionPreview\` itself doesn't care which kind it is.
 *
 * \`getBoundingClientRect()\` on the still-hidden \`.preview\` returns an empty
 * rect until it's actually visible, so this only works called at a point
 * where the panel's \`display: block\` has already taken effect - a plain
 * \`:hover\`/\`:focus\`-driven trigger satisfies that by the time a \`mouseover\`/
 * \`focusin\` event reaches this listener (the browser matches \`:hover\`
 * before dispatching the event), which is what \`initCardPreviewPositioning\`
 * below relies on; a JS-driven trigger (the Visual tab's \`.is-hovered\`,
 * added by initVisualHover in deckViewerHtml.ts) instead calls
 * \`positionPreview\` itself, right after adding that class.
 */
export const CARD_PREVIEW_JS = `
  function positionPreview(trigger) {
    var preview = trigger.querySelector('.preview');
    if (!preview) return;
    preview.classList.remove('flip-up', 'flip-left');
    var margin = 8;
    var triggerRect = trigger.getBoundingClientRect();
    var previewRect = preview.getBoundingClientRect();
    if (triggerRect.top + previewRect.height + margin > window.innerHeight) {
      preview.classList.add('flip-up');
    }
    if (triggerRect.right + previewRect.width + margin > window.innerWidth) {
      preview.classList.add('flip-left');
    }
  }
  function initCardPreviewPositioning() {
    document.addEventListener('mouseover', function (e) {
      var trigger = e.target.closest('.card-row, .pick-row');
      if (trigger) positionPreview(trigger);
    });
    document.addEventListener('focusin', function (e) {
      var trigger = e.target.closest('.card-row, .pick-row, .visual-card');
      if (trigger) positionPreview(trigger);
    });
  }
  initCardPreviewPositioning();
`;
