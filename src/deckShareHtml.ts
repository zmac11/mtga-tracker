import type { AverageManaValue } from "./domain/manaCurve.js";
import { CARD_PREVIEW_CSS, CARD_PREVIEW_JS, escapeHtml } from "./htmlCardHelpers.js";
import { FAVICON_LINK_TAG } from "./faviconHtml.js";
import {
  DEFAULT_CARD_IMAGE_WIDTH_PX,
  VISUAL_TAB_CSS,
  VISUAL_TAB_JS,
  deckListHtml,
  renderDeckHeaderHtml,
  visualHtml,
  type DeckViewerReward,
  type ViewerCard,
} from "./deckViewerHtml.js";

/**
 * Milestone 22 (2026-10-01): "I would like to have possibility to share
 * deck detail with other people... he can view cards in visible layout
 * (arts, columns and separated creatures/non-creatures) + event stats...
 * I can export one deck or set of decks from my event filter... I guess
 * format for people who do not have tracker installed and format who have
 * tracker installed? Must be easy to share and view."
 *
 * This is the "no tracker installed" half of that answer: a single,
 * self-contained static HTML file (same "no external requests" convention
 * as every other generated page in this project) with no tabs and no
 * dependency on the rest of the app - just open it in any browser. It
 * reuses, rather than re-implements, everything deckViewerHtml.ts already
 * built for the exact same visual layout the user asked for:
 * renderDeckHeaderHtml for the stats line, visualHtml (+ VISUAL_TAB_CSS/JS)
 * for the mana-cost-column card grid with creature/spell separation, and
 * deckListHtml for a plain sideboard list (the Visual tab is maindeck-only
 * by design - see deckViewerHtml.ts's own comment on that - so the
 * sideboard still needs a text list here, same as the normal deck-viewer
 * page's "Deck list" tab uses for it).
 *
 * The "format for people who have the tracker installed" half is this
 * exact same file, actually - see writeDeckViewerPage in electron/main.ts,
 * which emits this as a sibling file next to every normal deck-viewer page
 * it writes, and links the two together. A tracker user gets the richer,
 * tabbed deckViewerHtml.ts page (draft history, versions, curve chart);
 * anyone they send this sibling file to - tracker or not - gets this one.
 *
 * Split into two pieces so the "export a whole filtered set of decks as
 * ONE combined file" ask can reuse them without a second implementation:
 *
 * - `renderShareSectionHtml` renders just ONE deck's content (no
 *   <html>/<head>/<style>/<script> wrapper) - a `<section>` that's safe to
 *   concatenate with other sections from other decks into one page sharing
 *   a single copy of the CSS/JS below, rather than every deck dragging its
 *   own copy along.
 * - `buildShareShellParts` renders the shared wrapper (everything BEFORE
 *   the first section, and everything AFTER the last one) as a `{head,
 *   tail}` pair - `head + section1 + section2 + ... + tail` is a complete,
 *   valid page. `generateDeckShareHtml` below is just that formula with
 *   exactly one section (the single-deck case). The multi-deck case
 *   (statsHtml.ts's "Export filtered decks" button) needs this same
 *   `{head, tail}` pair too, but can't call this TypeScript function
 *   directly - that button runs client-side, in the browser, with no
 *   server round-trip at all (the static Limited Stats page has zero IPC
 *   access - see electron/main.ts's own notes on why). So
 *   electron/main.ts's `openLimitedStatsPage` calls `buildShareShellParts`
 *   itself, ONCE, server-side, and embeds the resulting `{head, tail}`
 *   strings as JSON into the generated stats page (same "embed once,
 *   consume client-side" convention that page's own row/card-catalog data
 *   already uses) - the browser's click handler then just concatenates
 *   that embedded head/tail with whichever rows' own pre-rendered
 *   `shareFragmentHtml` (statsRollup.ts's `LimitedStatsRow.shareFragmentHtml`,
 *   itself built by calling `renderShareSectionHtml` once per row,
 *   server-side, at the same time) currently pass the live filter.
 *
 * `arenaImportText` (domain/arenaExport.ts's buildArenaImportText output)
 * is passed in pre-built rather than built here, since it needs a
 * setCode/collectorNumber lookup this module has no access to (ViewerCard
 * doesn't carry those fields - ViewerCard's own comment explains why) -
 * every caller already has the card catalog loaded to build the rest of
 * the page's data anyway.
 */
export interface ShareDeckData {
  eventId: string;
  format: string;
  definitionLabel: string;
  deckName: string | null;
  colorCombo: string;
  splashColors?: string[];
  winRate: { wins: number; losses: number; total: number; pct: string };
  mainDeck: ViewerCard[];
  /** Same "not captured" null as DeckViewerData.sideboard - see that field's own comment. */
  sideboard: ViewerCard[] | null;
  cardImageWidthPx?: number;
  avgManaValue?: AverageManaValue;
  entry?: { currencyType: string; amountPaid: number } | null;
  reward?: DeckViewerReward | null;
  runLabel?: string | null;
  /** Arena's clipboard-import plain text for this deck (maindeck + sideboard) - see domain/arenaExport.ts. */
  arenaImportText: string;
  appVersion?: string;
}

/**
 * The machine-readable copy of one deck embedded in every share section, so the page's
 * download bar (see buildShareShellParts) can offer the deck as a file in other formats
 * (.txt / .csv / .md / .json) without any server round-trip - the page stays a plain static
 * file that works the same when it's been emailed or hosted. A combined multi-deck page has
 * one of these per section; the download bar merges them. `</` is escaped so a card name can
 * never close the script tag.
 */
export interface ShareDeckPayload {
  title: string;
  subtitle: string;
  colors: string;
  record: string;
  winRate: string | null;
  main: SharePayloadCard[];
  sideboard: SharePayloadCard[];
  arenaImport: string;
}
export interface SharePayloadCard {
  quantity: number;
  name: string;
  types: string;
  manaCost: string;
}

export function buildSharePayload(data: ShareDeckData): ShareDeckPayload {
  const toCard = (c: ViewerCard): SharePayloadCard => ({ quantity: c.quantity, name: c.name, types: c.types.join(" "), manaCost: c.manaCost ?? "" });
  const { wins, losses, total, pct } = data.winRate;
  return {
    title: data.deckName ?? data.definitionLabel,
    subtitle: `[${data.format}] ${data.definitionLabel} - ${data.eventId}${data.runLabel ? ` - ${data.runLabel}` : ""}`,
    colors: data.colorCombo + ((data.splashColors ?? []).length > 0 ? ` (splash: ${(data.splashColors ?? []).join("")})` : ""),
    record: `${wins}-${losses}`,
    winRate: total > 0 ? pct : null,
    main: data.mainDeck.map(toCard),
    sideboard: (data.sideboard ?? []).map(toCard),
    arenaImport: data.arenaImportText,
  };
}

function deckDataScript(data: ShareDeckData): string {
  const json = JSON.stringify(buildSharePayload(data)).replace(/</g, "\\u003c");
  return `<script type="application/json" class="deck-data">${json}</script>`;
}

/** One deck's worth of shareable content - header, Visual-tab card grid, optional sideboard list, and the Arena-import box - with no outer page wrapper. See this file's header for why this is split out from generateDeckShareHtml. The copy button inside the import box is wired up via a class (not an id - a combined multi-deck page has many of these on one page) and copyImportText (see buildShareShellParts's tail) resolves its own textarea via `.closest(".import-box")` rather than a fixed id. */
export function renderShareSectionHtml(data: ShareDeckData): string {
  const sideboard = data.sideboard ?? [];
  return `<section class="shared-deck">
  ${deckDataScript(data)}
  ${renderDeckHeaderHtml(data)}
  ${visualHtml(data.mainDeck)}
  ${sideboard.length > 0 ? `<div class="deck-columns">${deckListHtml("Sideboard", sideboard)}</div>` : ""}
  <h2>Import into Arena</h2>
  <div class="import-box">
    <p class="muted">Paste this into Arena's deck builder (Deck &rarr; Import) to build this exact deck.</p>
    <textarea class="arena-import" readonly onclick="this.select()">${escapeHtml(data.arenaImportText)}</textarea>
    <br>
    <button class="copy-btn" onclick="copyImportText(this)">Copy decklist</button>
  </div>
</section>`;
}

/** The shared page wrapper (everything before the first `renderShareSectionHtml` section, and everything after the last one) - see this file's header for the `head + section... + tail` formula and why both the single- and multi-deck export share this one implementation. */
export interface ShareShellParts {
  head: string;
  tail: string;
}

export function buildShareShellParts(title: string, cardImageWidthPx: number = DEFAULT_CARD_IMAGE_WIDTH_PX): ShareShellParts {
  const head = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
${FAVICON_LINK_TAG}
<style>
  :root { color-scheme: var(--cs, dark); --card-img-width: ${cardImageWidthPx}px; --card-overlap: calc(var(--card-img-width) * -1.05); }
  body { font-family: var(--font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); background: var(--bg, #14151a); color: var(--text, #e8e8ec); margin: 0; padding: 24px; max-width: 1240px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 28px 0 8px; color: var(--text-2, #cfd2dc); }
  .muted { color: var(--muted, #8a8d99); font-weight: normal; font-size: 0.85em; }
  .header { margin-bottom: 20px; border-bottom: 1px solid var(--border, #2a2c36); padding-bottom: 12px; }
  .header .meta { color: var(--text-3, #b7bac6); font-size: 0.95rem; }
  .shared-deck { margin-bottom: 36px; padding-bottom: 28px; border-bottom: 1px solid var(--border, #2a2c36); }
  .shared-deck:last-of-type { border-bottom: none; }
  .deck-columns { display: flex; gap: 32px; flex-wrap: wrap; }
  .deck-column { flex: 1 1 320px; min-width: 280px; }
  .deck-type-group { margin-bottom: 14px; }
  .deck-type-group:last-child { margin-bottom: 0; }
  .deck-type-group h3 { font-size: 0.78rem; margin: 0 0 4px; color: var(--muted-2, #9296a3); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .card-list { list-style: none; margin: 0; padding: 0; }
  .card-row { position: relative; display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px; cursor: default; }
  .card-row:hover, .card-row:focus { background: var(--surface-2, #22232c); outline: none; }
  .card-row:hover .preview, .card-row:focus .preview { display: block; }
  .qty { color: var(--muted, #8a8d99); width: 2.2em; text-align: right; flex-shrink: 0; }
  .name { flex: 1; }
  ${CARD_PREVIEW_CSS}
  ${VISUAL_TAB_CSS}
  .import-box { background: var(--surface-3, #1b1c23); border: 1px solid var(--border, #2a2c36); border-radius: 8px; padding: 16px; margin-top: 8px; }
  .import-box textarea { width: 100%; min-height: 180px; box-sizing: border-box; background: var(--input-bg, #0f1014); color: var(--text-2, #cfd2dc); border: 1px solid var(--border-2, #34364280); border-radius: 6px; padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; resize: vertical; }
  .copy-btn { background: var(--accent-solid, #3d4ee0); color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; margin-top: 10px; }
  .copy-btn.copied { background: #4fae6a; }
  .download-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 20px; padding: 10px 12px; background: var(--surface-3, #1b1c23); border: 1px solid var(--border, #2a2c36); border-radius: 8px; }
  .download-bar .label { color: var(--muted, #8a8d99); font-size: 0.85rem; margin-right: 4px; }
  .download-bar button { background: var(--surface-2, #22232c); color: var(--text-2, #cfd2dc); border: 1px solid var(--border-2, #343642); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-family: inherit; }
  .download-bar button:hover { background: var(--accent-solid, #3d4ee0); color: #fff; border-color: transparent; }
  .download-bar button.done { background: #4fae6a; color: #fff; border-color: transparent; }
  @media print {
    :root:root:root { --bg: #fff; --surface: #fff; --surface-2: #f2f2f2; --surface-3: #f7f7f7; --input-bg: #fff; --text: #111; --text-2: #222; --text-3: #333; --muted: #555; --muted-2: #555; --muted-3: #666; --border: #ccc; --border-2: #bbb; --cs: light; }
    .download-bar, .import-box .copy-btn { display: none; }
    body { padding: 0; }
  }
  .app-version-footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid var(--border, #2a2c36); color: var(--muted-3, #6a6d79); font-size: 0.75rem; }
  .app-version-footer a { color: var(--muted-3, #6a6d79); }
</style>
</head>
<body>
<div class="download-bar" id="download-bar">
  <span class="label">Download or share:</span>
  <button type="button" onclick="downloadDecks('html', this)" title="This whole page as one HTML file - open it in any browser">Web page (.html)</button>
  <button type="button" onclick="downloadDecks('txt', this)" title="Plain text you can paste into Arena's deck builder">Arena decklist (.txt)</button>
  <button type="button" onclick="downloadDecks('csv', this)" title="One row per card - opens in Excel, Numbers or Google Sheets">Spreadsheet (.csv)</button>
  <button type="button" onclick="downloadDecks('md', this)" title="Markdown text for Discord, Reddit, GitHub...">Markdown (.md)</button>
  <button type="button" onclick="downloadDecks('json', this)" title="Structured data">JSON (.json)</button>
  <button type="button" onclick="window.print()" title="Opens the print dialog - choose 'Save as PDF'">Print / PDF</button>
</div>
`;

  const tail = `
  <script>
    ${CARD_PREVIEW_JS}
    ${VISUAL_TAB_JS}
    initVisualHover();
    function collectDecks() {
      return Array.prototype.map.call(document.querySelectorAll('script.deck-data'), function (el) { return JSON.parse(el.textContent); });
    }
    function slugify(text) {
      var slug = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return slug || 'deck';
    }
    function saveTextFile(fileName, mimeType, text) {
      var blob = new Blob([text], { type: mimeType + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
    }
    function csvCell(value) {
      var text = String(value);
      return /[",\\r\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    function buildDeckFile(kind, decks) {
      var i, j, d, lines;
      if (kind === 'txt') {
        if (decks.length === 1) return decks[0].arenaImport + '\\n';
        return decks.map(function (deck) { return '=== ' + deck.title + ' ===\\n' + deck.arenaImport; }).join('\\n\\n') + '\\n';
      }
      if (kind === 'json') return JSON.stringify(decks.length === 1 ? decks[0] : decks, null, 2) + '\\n';
      if (kind === 'csv') {
        lines = ['Deck,Section,Quantity,Name,Type,Mana cost'];
        for (i = 0; i < decks.length; i++) {
          d = decks[i];
          [['Maindeck', d.main], ['Sideboard', d.sideboard]].forEach(function (part) {
            for (j = 0; j < part[1].length; j++) {
              var c = part[1][j];
              lines.push([d.title, part[0], c.quantity, c.name, c.types, c.manaCost].map(csvCell).join(','));
            }
          });
        }
        return '\\uFEFF' + lines.join('\\r\\n') + '\\r\\n';
      }
      if (kind === 'md') {
        lines = [];
        decks.forEach(function (deck) {
          lines.push('# ' + deck.title, '', deck.subtitle, '', 'Colors: ' + deck.colors + ' | Record: ' + deck.record + (deck.winRate ? ' (' + deck.winRate + ')' : ''), '');
          [['Maindeck', deck.main], ['Sideboard', deck.sideboard]].forEach(function (part) {
            if (part[1].length === 0) return;
            var count = part[1].reduce(function (sum, c) { return sum + c.quantity; }, 0);
            lines.push('## ' + part[0] + ' (' + count + ' cards)', '');
            part[1].forEach(function (c) { lines.push('- ' + c.quantity + 'x ' + c.name); });
            lines.push('');
          });
        });
        return lines.join('\\n');
      }
      return '';
    }
    function downloadDecks(kind, btn) {
      var decks = collectDecks();
      if (decks.length === 0) return;
      var base = decks.length === 1 ? slugify(decks[0].title) : 'mtga-shared-decks';
      if (kind === 'html') {
        saveTextFile(base + '.html', 'text/html', '<!DOCTYPE html>\\n' + document.documentElement.outerHTML);
      } else {
        var types = { txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json' };
        saveTextFile(base + '.' + kind, types[kind], buildDeckFile(kind, decks));
      }
      if (btn) {
        var original = btn.textContent;
        btn.textContent = 'Saved!';
        btn.classList.add('done');
        setTimeout(function () { btn.textContent = original; btn.classList.remove('done'); }, 1500);
      }
    }
    function copyImportText(btn) {
      var box = btn.closest('.import-box');
      var ta = box.querySelector('.arena-import');
      function flash() {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy decklist'; btn.classList.remove('copied'); }, 1500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ta.value).then(flash, function () {
          ta.select();
          document.execCommand('copy');
          flash();
        });
      } else {
        ta.select();
        document.execCommand('copy');
        flash();
      }
    }
  </script>
</body>
</html>
`;

  return { head, tail };
}

/** The single-deck share page - see this file's header. Just `head + one section + an optional app-version footer + tail`. */
export function generateDeckShareHtml(data: ShareDeckData): string {
  const cardImageWidthPx = data.cardImageWidthPx ?? DEFAULT_CARD_IMAGE_WIDTH_PX;
  const { head, tail } = buildShareShellParts(`${data.deckName ?? data.definitionLabel} (shared) - MTGA Tracker`, cardImageWidthPx);
  const footer = data.appVersion ? `<div class="app-version-footer">Shared from MTGA Tracker v${escapeHtml(data.appVersion)} &middot; <a href="https://github.com/zmac11/mtga-tracker">github.com/zmac11/mtga-tracker</a></div>` : "";
  return head + renderShareSectionHtml(data) + footer + tail;
}
