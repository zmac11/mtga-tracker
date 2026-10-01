/**
 * Milestone 22 (2026-10-01): "I would like to have possibility to share
 * deck detail with other people... I guess format for people who do not
 * have tracker installed" - half of that answer is a plain-text decklist
 * in Arena's own clipboard-import format, so anyone (tracker or no
 * tracker) can paste it straight into the Arena deck builder. Format
 * (confirmed via Arena's own export/import, matching what MTGGoldfish,
 * Moxfield etc. already produce for the same game):
 *
 *   Deck
 *   <qty> <name> (<SET CODE>) <collector number>
 *   ...
 *
 *   Sideboard
 *   <qty> <name> (<SET CODE>) <collector number>
 *   ...
 *
 * The blank line + "Sideboard" header is only emitted when there's a
 * non-empty sideboard to show - Arena's own import is fine with a
 * maindeck-only paste, and a dangling empty "Sideboard" header would just
 * be confusing to paste in.
 *
 * setCode/collectorNumber come from the card catalog (cards/cardStore.ts)
 * via `lookup`, not from deckViewerHtml.ts's ViewerCard itself (which
 * doesn't carry them - see that file's own comment on why) - a card
 * missing from the lookup (shouldn't happen in practice: every ArenaCard
 * always has both fields populated, see cards/types.ts) is silently
 * skipped rather than thrown on, matching this project's established
 * "stay neutral about an unexpected gap rather than crash the whole page"
 * stance (see rewardHistory.ts's own header comment for the same stance
 * applied elsewhere).
 */

export interface ArenaExportCard {
  cardId: number;
  quantity: number;
  name: string;
}

export interface ArenaExportCardInfo {
  setCode: string;
  collectorNumber: string;
}

function lineFor(card: ArenaExportCard, lookup: Map<number, ArenaExportCardInfo>): string | null {
  const info = lookup.get(card.cardId);
  if (!info) return null;
  return `${card.quantity} ${card.name} (${info.setCode}) ${info.collectorNumber}`;
}

/** Builds Arena's clipboard-import plain text for a maindeck (+ optional sideboard) - see this file's header for the exact format. */
export function buildArenaImportText(mainDeck: ArenaExportCard[], sideboard: ArenaExportCard[] | null, lookup: Map<number, ArenaExportCardInfo>): string {
  const deckLines = mainDeck.map((c) => lineFor(c, lookup)).filter((l): l is string => l !== null);
  const sections = ["Deck", ...deckLines];

  const sideboardLines = (sideboard ?? []).map((c) => lineFor(c, lookup)).filter((l): l is string => l !== null);
  if (sideboardLines.length > 0) {
    sections.push("", "Sideboard", ...sideboardLines);
  }

  return sections.join("\n");
}
