/**
 * Small HTML-building helpers shared between the browser pages this project
 * generates (deckViewerHtml.ts, milestone 7 phase 4; draftProgressHtml.ts,
 * phase 5) - escaping, the WUBRG color-dot markup, and the "hover preview"
 * fallback chain (real image -> oracle text -> "no data yet" message) that
 * both pages use identically for a card. Pulled out here rather than
 * duplicated once phase 5 needed the exact same preview logic deckViewerHtml
 * already had - each page still owns its own full inline <style>/layout, only
 * this shared bit of markup-building logic moved.
 */

export interface HtmlCard {
  name: string;
  /** Arena's own decoded colors (see extractArenaCards.ts) - always available. */
  colors: string[];
  /** Scryfall's oracle text, or null if unenriched. Shown as a hover fallback when there's no image. */
  oracleText: string | null;
  /** Scryfall's normal-size image URL, or null if unenriched - the hover-preview image. */
  imageNormal: string | null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function colorDotsHtml(colors: string[]): string {
  if (colors.length === 0) return `<span class="dot dot-C" title="Colorless"></span>`;
  return colors.map((c) => `<span class="dot dot-${escapeHtml(c)}" title="${escapeHtml(c)}"></span>`).join("");
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
  if (card.imageNormal) {
    return `<img src="${escapeHtml(card.imageNormal)}" alt="${escapeHtml(card.name)}">`;
  }
  if (card.oracleText) {
    return `<div class="preview-text"><strong>${escapeHtml(card.name)}</strong><br>${escapeHtml(card.oracleText).replace(/\n/g, "<br>")}</div>`;
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
  .preview { display: none; position: absolute; left: 100%; top: 0; z-index: 10; margin-left: 12px; background: #1c1d24; border: 1px solid #3a3c48; border-radius: 8px; padding: 8px; width: 260px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  .preview img { width: 100%; border-radius: 6px; display: block; }
  .preview-text { font-size: 0.85rem; line-height: 1.4; }
  code { background: #22232c; padding: 1px 5px; border-radius: 4px; }
`;
