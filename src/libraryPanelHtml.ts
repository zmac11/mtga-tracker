import type { LibrarySnapshot } from "./domain/libraryTracker.js";
import { escapeHtml } from "./htmlCardHelpers.js";

/**
 * The overlay's in-game deck-list panel: every card of the player's deck with
 * how many copies are still in the library and the chance the next draw is
 * that card. Pure (snapshot + a small card lookup in, trusted HTML fragment
 * out) like draftProgressHtml.ts's draftBoardFragmentHtml - electron/main.ts
 * resolves grpIds to this lookup from the card catalog and pushes the string
 * to the overlay, which just drops it in.
 */

export interface LibraryCardInfo {
  name: string;
  /** Scryfall-style "{2}{R}" string, when enriched. */
  manaCost: string | null;
  /** Decoded Arena types ("Land", "Creature", ...). */
  types: string[];
}

/** Rough mana value from a "{2}{R}{R}" string: numbers add up, X is 0, any other symbol (colored, hybrid, phyrexian) counts 1. */
export function manaValueOf(manaCost: string | null): number {
  if (!manaCost) return 0;
  let total = 0;
  for (const m of manaCost.matchAll(/\{([^}]+)\}/g)) {
    const sym = m[1];
    if (/^\d+$/.test(sym)) total += Number(sym);
    else if (sym !== "X" && sym !== "Y" && sym !== "Z") total += 1;
  }
  return total;
}

/** "12%" for 10% and up, "4.5%" below (small odds are where one decimal matters), "0%" for none. */
export function formatPercent(p: number): string {
  const pct = p * 100;
  if (pct <= 0) return "0%";
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1)}%`;
}

function sortKey(info: LibraryCardInfo | undefined): [number, number] {
  if (!info) return [1, 0];
  if (info.types.includes("Land")) return [2, 0];
  return [0, manaValueOf(info.manaCost)];
}

export function libraryFragmentHtml(snapshot: LibrarySnapshot, cards: Map<number, LibraryCardInfo>): string {
  const name = (grpId: number) => cards.get(grpId)?.name ?? `Card ${grpId}`;
  const rows = [...snapshot.entries].sort((a, b) => {
    const [ga, ma] = sortKey(cards.get(a.grpId));
    const [gb, mb] = sortKey(cards.get(b.grpId));
    return ga - gb || ma - mb || name(a.grpId).localeCompare(name(b.grpId));
  });

  const head =
    `<div class="lib-head"><span class="lib-title">Library</span>` +
    `<span class="lib-count">${snapshot.libraryCount} card${snapshot.libraryCount === 1 ? "" : "s"}` +
    `${snapshot.consistent ? "" : ` <span class="lib-warn" title="Some cards could not be matched, so these numbers may be slightly off">~</span>`}</span></div>`;

  const body = rows
    .map((e) => {
      const gone = e.inLibrary === 0;
      const classes = ["lib-row"];
      if (gone) classes.push("lib-gone");
      else if (e.pNext >= 0.999) classes.push("lib-next");
      return (
        `<div class="${classes.join(" ")}">` +
        `<span class="lib-name" title="${escapeHtml(name(e.grpId))}">${escapeHtml(name(e.grpId))}</span>` +
        `<span class="lib-n">${e.inLibrary}/${e.deckCount}</span>` +
        `<span class="lib-p">${gone ? "-" : formatPercent(e.pNext)}</span>` +
        `</div>`
      );
    })
    .join("");

  const notes: string[] = [];
  if (snapshot.knownTop.length > 0) notes.push(`Top: ${snapshot.knownTop.map((g) => escapeHtml(name(g))).join(", ")}`);
  if (snapshot.knownBottom.length > 0) notes.push(`Bottom: ${snapshot.knownBottom.map((g) => escapeHtml(name(g))).join(", ")}`);
  const foot = notes.length > 0 ? `<div class="lib-foot">${notes.join("<br>")}</div>` : "";

  return head + `<div class="lib-rows">${body}</div>` + foot;
}
