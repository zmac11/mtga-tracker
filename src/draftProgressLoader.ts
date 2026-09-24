import type { CardStore } from "./cards/cardStore.js";
import type { DraftProgress } from "./domain/liveState.js";
import { deriveDeckColors } from "./domain/deckColors.js";
import type { DraftProgressCard, DraftProgressData } from "./draftProgressHtml.js";

/**
 * Thin loader between LiveStateTracker's bare-grpId DraftProgress and the
 * pure draftProgressHtml.ts renderer - milestone 7 phase 5, same convention
 * as deckViewerLoader.ts (phase 4). Resolves names/colors/images from the
 * card catalog and derives an evolving color-combo read from the picks made
 * so far (reusing deckColors.ts's deriveDeckColors - each pick counted as
 * one copy, same as a maindeck entry with quantity 1... quantity summed for
 * any grpId picked more than once, e.g. a second copy of the same land).
 */
export function buildDraftProgressData(progress: DraftProgress, cardStore: CardStore): DraftProgressData {
  const cardColors = new Map<number, string[]>();
  const cardsById = new Map<number, ReturnType<CardStore["all"]>[number]>();
  for (const c of cardStore.all()) {
    cardColors.set(c.grpId, c.colors);
    cardsById.set(c.grpId, c);
  }

  const toCard = (grpId: number): DraftProgressCard => {
    const c = cardsById.get(grpId);
    return {
      cardId: grpId,
      name: c?.name ?? `Unknown card #${grpId} (run npm run refresh-cards)`,
      colors: c?.colors ?? [],
      oracleText: c?.oracleText ?? null,
      imageNormal: c?.imageNormal ?? null,
    };
  };

  const pickCounts = new Map<number, number>();
  for (const p of progress.picks) pickCounts.set(p.grpId, (pickCounts.get(p.grpId) ?? 0) + 1);
  const pseudoDeck = [...pickCounts.entries()].map(([cardId, quantity]) => ({ cardId, quantity }));
  const colorCombo = deriveDeckColors(pseudoDeck, cardColors).comboKey;

  return {
    draftId: progress.draftId,
    pack: progress.pack,
    pick: progress.pick,
    currentPack: progress.packCards.map(toCard),
    picks: progress.picks.map((p) => ({ pack: p.pack, pick: p.pick, card: toCard(p.grpId) })),
    colorCombo,
  };
}
