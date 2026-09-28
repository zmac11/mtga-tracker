// Coverage for generateDeckViewerHtml (milestone 7 phase 4) - checks the
// generated page contains the expected content for both the deck-list and
// curve views, without needing a real browser to render it.

import assert from "node:assert/strict";
import {
  generateDeckViewerHtml,
  DEFAULT_CARD_IMAGE_WIDTH_PX,
  type DeckViewerData,
  type DraftViewerPick,
  type DraftViewerPickCard,
  type ViewerCard,
} from "./deckViewerHtml.js";

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

  // Milestone 13/14: "Visual" tab - one column per mana-cost bucket, each an
  // overlapping/fanned stack of real card-image thumbnails (Arena's own
  // deck-builder style), separate from the "Deck list"/"Curve" tabs above.
  assert.ok(html.includes(`data-view="visual"`));
  assert.ok(html.includes(">Visual<"));
  // Default card width (and the overlap amount derived from it) baked in as CSS variables when the loader doesn't specify a width.
  assert.ok(html.includes(`--card-img-width: ${DEFAULT_CARD_IMAGE_WIDTH_PX}px`));
  assert.ok(html.includes("--card-overlap:"));
  // A card with an image gets a real thumbnail plus a quantity badge (only shown above x1), tagged with its creature/spell/land role.
  assert.ok(html.includes(`<img src="https://example.com/img.jpg" alt="Bothersome Noisemaker">`));
  assert.ok(html.includes("visual-card-qty\">x2<"));
  assert.ok(/<div class="visual-card" data-role="creature"[^>]*>[\s\S]*?Bothersome Noisemaker/.test(html));
  // A card with no image falls back to a named placeholder box instead of vanishing, with no quantity badge at x1, tagged "spell" (non-creature, non-land).
  assert.ok(html.includes("visual-card-placeholder"));
  assert.ok(/<div class="visual-card" data-role="spell"[^>]*>[\s\S]*?Necromancy/.test(html));
  // Milestone 14: lands are just one more column in the same row, not a separate section - Mountain (x8) shows up there, tagged "land".
  assert.ok(!html.includes("visual-lands"));
  assert.ok(html.includes("visual-card-qty\">x8<"));
  assert.ok(/<div class="visual-card" data-role="land"[^>]*>[\s\S]*?Mountain/.test(html));
  // Milestone 14: no more separate "Creatures"/"Other spells" sub-layout or gap div - same columns always, just a CSS class toggle.
  assert.ok(!html.includes("visual-lands"));
  assert.ok(!html.includes("visual-group-gap"));
  assert.ok(!html.includes("visual-group-title"));
  assert.ok(!html.includes('id="visual-combined"'));
  assert.ok(!html.includes('id="visual-separated"'));
  // The "Separate" toggle's adjacent-sibling CSS rule (only overrides the margin at the creature->spell boundary card, when .visual-section carries .separated) and its JS are present.
  assert.ok(html.includes(`.visual-section.separated .visual-card[data-role="creature"] + .visual-card[data-role="spell"]`));
  assert.ok(html.includes("toggleVisualSeparate"));
  assert.ok(html.includes(`id="visual-section"`));

  // A custom card-image width (from the Settings window's "Card size" choice) is baked in as the CSS variable instead of the default.
  const wideCards = generateDeckViewerHtml({ ...data, cardImageWidthPx: 210 });
  assert.ok(wideCards.includes("--card-img-width: 210px"));

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

  console.log(
    "OK: generateDeckViewerHtml renders header/record/colors, maindeck+sideboard card rows (image or oracle-text hover fallback), curve buckets, the Visual tab's overlapping mana-cost columns (lands as their own column, not a section), the creature/spell 'Separate' toggle's boundary-only CSS rule (not a duplicated layout), configurable card width/overlap, the no-sideboard-captured message, escapes card names, hides the Draft tab with no draft data, renders pack/pick/wheel info when draft data is present, and highlights both cards of a multi-card 'Pick Two' pick.",
  );
}

run();
