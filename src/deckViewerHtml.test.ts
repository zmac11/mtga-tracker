// Coverage for generateDeckViewerHtml (milestone 7 phase 4) - checks the
// generated page contains the expected content for both the deck-list and
// curve views, without needing a real browser to render it.

import assert from "node:assert/strict";
import { generateDeckViewerHtml, type DeckViewerData, type DraftViewerPick, type DraftViewerPickCard, type ViewerCard } from "./deckViewerHtml.js";

function card(overrides: Partial<ViewerCard> & Pick<ViewerCard, "cardId" | "name">): ViewerCard {
  return { quantity: 1, colors: [], types: [], manaCost: null, oracleText: null, imageNormal: null, ...overrides };
}

function draftCard(overrides: Partial<DraftViewerPickCard> & Pick<DraftViewerPickCard, "cardId" | "name">): DraftViewerPickCard {
  return { colors: [], oracleText: null, imageNormal: null, ...overrides };
}

function run() {
  const data: DeckViewerData = {
    eventId: "ContenderDraft_HOB_20260824",
    format: "Draft",
    definitionLabel: "ContenderDraft - HOB",
    deckName: "Draft Deck",
    colorCombo: "BR",
    winRate: { wins: 4, losses: 2, total: 6, pct: "67%" },
    mainDeck: [
      card({ cardId: 1, name: "Bothersome Noisemaker", quantity: 2, colors: ["R"], types: ["Creature"], manaCost: "{1}{R}", imageNormal: "https://example.com/img.jpg" }),
      card({ cardId: 2, name: "Necromancy", quantity: 1, colors: ["B"], types: ["Enchantment"], manaCost: "{1}{B}", oracleText: "Reanimate a creature." }),
      card({ cardId: 3, name: "Mountain", quantity: 8, types: ["Land"] }),
    ],
    sideboard: [card({ cardId: 4, name: "Shock", quantity: 1, colors: ["R"], types: ["Instant"], manaCost: "{R}" })],
    draft: [],
  };

  const html = generateDeckViewerHtml(data);

  // Header content.
  assert.ok(html.includes("Draft Deck"));
  assert.ok(html.includes("ContenderDraft - HOB"));
  assert.ok(html.includes("ContenderDraft_HOB_20260824"));
  assert.ok(html.includes("BR"));
  assert.ok(html.includes("4-2"));
  assert.ok(html.includes("67%"));

  // Maindeck/sideboard card rows.
  assert.ok(html.includes("Bothersome Noisemaker"));
  assert.ok(html.includes("https://example.com/img.jpg")); // hover image
  assert.ok(html.includes("Necromancy"));
  assert.ok(html.includes("Reanimate a creature.")); // oracle-text fallback for a card with no image
  assert.ok(html.includes("Shock")); // sideboard card present

  // Curve section: buckets should include the Mountain's "Land" label and Bothersome Noisemaker's cmc-2 bucket.
  assert.ok(html.includes("curve-label\">Land<"));
  assert.ok(html.includes("curve-label\">2<"));

  // A run with no sideboard data shows the "not captured" message rather than an empty list.
  const noSideboard = generateDeckViewerHtml({ ...data, sideboard: null });
  assert.ok(noSideboard.includes("Not captured for this run"));

  // HTML-escapes card names to avoid injecting markup from a (theoretically) untrusted card name.
  const withSpecialChars = generateDeckViewerHtml({ ...data, mainDeck: [card({ cardId: 5, name: "<script>alert(1)</script>" })] });
  assert.ok(!withSpecialChars.includes("<script>alert(1)</script>"));
  assert.ok(withSpecialChars.includes("&lt;script&gt;"));

  // No draft data captured (e.g. not a draft event) - no "Draft" tab button or view at all.
  assert.ok(!html.includes(`data-view="draft"`));
  assert.ok(!html.includes(">Draft<"));

  // Milestone 7 phase 6: a run WITH draft pick data renders the "Draft" tab -
  // pack contents, which card(s) were taken, and wheel/taken-by-others info.
  const draftPicks: DraftViewerPick[] = [
    {
      pack: 1,
      pick: 1,
      packCards: [
        draftCard({ cardId: 1, name: "Bothersome Noisemaker", colors: ["R"] }),
        draftCard({ cardId: 6, name: "Some Other Card" }),
      ],
      pickedCardIds: [1],
      wheeledAt: { pack: 1, pick: 9 },
      takenByOthers: [draftCard({ cardId: 7, name: "Taken By Opponent" })],
    },
    {
      pack: 1,
      pick: 2,
      packCards: [draftCard({ cardId: 2, name: "Necromancy" })],
      pickedCardIds: [2],
      wheeledAt: null,
      takenByOthers: [],
    },
  ];
  const withDraft = generateDeckViewerHtml({ ...data, draft: draftPicks });
  assert.ok(withDraft.includes(`data-view="draft"`));
  assert.ok(withDraft.includes(">Draft<"));
  assert.ok(withDraft.includes("Pack 1, Pick 1"));
  assert.ok(withDraft.includes("Some Other Card")); // full pack shown, not just the pick
  assert.ok(withDraft.includes("Wheeled to Pack 1, Pick 9"));
  assert.ok(withDraft.includes("Taken By Opponent"));
  assert.ok(withDraft.includes("Did not wheel back")); // pick 2's no-wheel case
  // The picked card gets the "picked" styling hook.
  assert.ok(/draft-card-row picked/.test(withDraft));

  // "Pick Two" draft (2 cards taken in one pick - see types.ts's
  // DraftPickMade.grpIds comment): both taken cards get the "picked" hook,
  // and the multi-card note renders.
  const pickTwoPicks: DraftViewerPick[] = [
    {
      pack: 1,
      pick: 1,
      packCards: [
        draftCard({ cardId: 1, name: "Card A" }),
        draftCard({ cardId: 2, name: "Card B" }),
        draftCard({ cardId: 3, name: "Card C" }),
      ],
      pickedCardIds: [1, 2],
      wheeledAt: null,
      takenByOthers: [],
    },
  ];
  const withPickTwo = generateDeckViewerHtml({ ...data, draft: pickTwoPicks });
  assert.equal((withPickTwo.match(/draft-card-row picked/g) ?? []).length, 2);
  assert.ok(withPickTwo.includes("2 cards taken this pick"));

  console.log("OK: generateDeckViewerHtml renders header/record/colors, maindeck+sideboard card rows (image or oracle-text hover fallback), curve buckets, the no-sideboard-captured message, escapes card names, hides the Draft tab with no draft data, renders pack/pick/wheel info when draft data is present, and highlights both cards of a multi-card 'Pick Two' pick.");
}

run();
