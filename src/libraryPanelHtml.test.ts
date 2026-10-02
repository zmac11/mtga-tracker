import assert from "node:assert/strict";
import { formatPercent, libraryFragmentHtml, manaValueOf, type LibraryCardInfo } from "./libraryPanelHtml.js";
import type { LibrarySnapshot } from "./domain/libraryTracker.js";

function run() {
  assert.equal(manaValueOf("{2}{R}{R}"), 4);
  assert.equal(manaValueOf("{X}{G}"), 1);
  assert.equal(manaValueOf("{W/U}{1}"), 2);
  assert.equal(manaValueOf(null), 0);

  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(0.1234), "12%");
  assert.equal(formatPercent(0.045), "4.5%");
  assert.equal(formatPercent(1), "100%");

  const cards = new Map<number, LibraryCardInfo>([
    [1, { name: "Forest", manaCost: null, types: ["Land"] }],
    [2, { name: "Big <Beast>", manaCost: "{4}{G}", types: ["Creature"] }],
    [3, { name: "Cheap Elf", manaCost: "{G}", types: ["Creature"] }],
  ]);
  const snap: LibrarySnapshot = {
    seat: 1,
    libraryCount: 20,
    entries: [
      { grpId: 1, deckCount: 17, inLibrary: 9, pNext: 0.45 },
      { grpId: 2, deckCount: 2, inLibrary: 0, pNext: 0 },
      { grpId: 3, deckCount: 4, inLibrary: 3, pNext: 0.15 },
      { grpId: 9, deckCount: 1, inLibrary: 1, pNext: 0.05 },
    ],
    knownTop: [],
    knownBottom: [3],
    consistent: true,
  };
  const html = libraryFragmentHtml(snap, cards);
  assert.ok(html.includes("20 cards"));
  assert.ok(html.includes("Big &lt;Beast&gt;"), "names are escaped");
  assert.ok(!html.includes("Big <Beast>"));
  assert.ok(html.includes("Bottom: Cheap Elf"));
  assert.ok(html.includes("lib-gone"), "a card with no copies left is dimmed");
  assert.ok(html.includes("Card 9"), "an unresolved grpId still renders");
  assert.ok(!html.includes("lib-warn"), "no warning when consistent");
  // Order: spells by mana value (Cheap Elf, Big Beast), unknown card next to them, lands last.
  assert.ok(html.indexOf("Cheap Elf") < html.indexOf("Big &lt;Beast&gt;"));
  assert.ok(html.indexOf("Big &lt;Beast&gt;") < html.indexOf(">Forest<"));

  const warn = libraryFragmentHtml({ ...snap, consistent: false }, cards);
  assert.ok(warn.includes("lib-warn"));

  console.log("libraryPanelHtml tests passed");
}

run();
