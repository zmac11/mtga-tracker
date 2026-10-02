import assert from "node:assert/strict";
import { buildSetSearchCards } from "./setSearch.js";
import type { EnrichedCard } from "./cards/types.js";

function card(over: Partial<EnrichedCard> & { grpId: number; name: string }): EnrichedCard {
  return {
    setCode: "HOB",
    collectorNumber: "1",
    rarityRaw: 0,
    isToken: false,
    isDigitalOnly: false,
    isRebalanced: false,
    rebalancedCardGrpId: null,
    colors: [],
    types: ["Creature"],
    scryfallId: null,
    oracleText: null,
    manaCost: null,
    scryfallColors: null,
    scryfallRarity: null,
    imageSmall: null,
    imageNormal: null,
    imageLarge: null,
    imagePng: null,
    enrichedAt: null,
    ...over,
  } as EnrichedCard;
}

function run() {
  const all = [
    card({ grpId: 1, name: "Zebra Knight", collectorNumber: "20", colors: ["W"], manaCost: "{1}{W}", scryfallRarity: "common", oracleText: "Vigilance" }),
    card({ grpId: 2, name: "Zebra Knight", collectorNumber: "5", colors: ["W"] }), // alternate art, lower number wins
    card({ grpId: 3, name: "Ant Token", isToken: true }),
    card({ grpId: 4, name: "Forest", types: ["Land"] }),
    card({ grpId: 5, name: "Apple Thief", colors: [], scryfallColors: ["U"], manaCost: "{U}" }),
    card({ grpId: 6, name: "Other Set Card", setCode: "MH3" }),
    card({ grpId: 7, name: "Hidden Vale", types: ["Land"] }),
  ];
  const out = buildSetSearchCards(all, "hob");
  assert.deepEqual(out.map((c) => c.n), ["Apple Thief", "Hidden Vale", "Zebra Knight"], "tokens, basics, other sets out; sorted by name");
  assert.equal(out.find((c) => c.n === "Zebra Knight")!.g, 2, "one entry per name, lowest collector number");
  assert.deepEqual(out.find((c) => c.n === "Apple Thief")!.c, ["U"], "falls back to Scryfall colors");
  assert.equal(buildSetSearchCards(all, "ZZZ").length, 0);

  console.log("setSearch tests passed");
}

run();
