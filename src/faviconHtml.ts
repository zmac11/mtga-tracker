/**
 * Milestone 21 follow-up (2026-10-01): the user reported the generated
 * report pages (Past Events, Limited Stats, Opponent History, Reward
 * History, the deck viewer, draft progress) were "missing an icon" -
 * none of them ever set a favicon, so the browser tab just shows its own
 * generic blank-page glyph. One shared constant here (a small PNG, same
 * simplified crown+bars glyph as the tray icon - see
 * src/electron/assets/iconTemplate.png's own header for why it's cropped
 * down from the full build/icon.png rather than using that detailed
 * version directly) rather than duplicating the data: URI in every one of
 * these files, inlined as a base64 data: URI (not a separate asset file)
 * so each page stays single-file/self-contained, same convention as the
 * embedded JSON data blocks these pages already use.
 */
export const FAVICON_LINK_TAG =
  '<link rel="icon" type="image/png" href="data:image/png;base64,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">';
