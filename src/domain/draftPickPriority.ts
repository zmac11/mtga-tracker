import type { DraftPackSeen, DraftPickMade } from "./types.js";

/**
 * Milestone 23 (feature b): "how often are cards picked with high
 * priority" - per the user's own chosen definition (one of four
 * clarifying questions this feature was built from): priority is measured
 * as how many OTHER cards were still in the pack at the exact moment a
 * given card was picked, averaged across every time that card was ever
 * taken in any captured draft. A card picked even when plenty of
 * alternatives remained reads as a high-priority pick; one only ever taken
 * when little else was left reads as low-priority/last-resort. Deliberately
 * dataset-wide (every draft ever captured, not scoped to one run) - see
 * eventHistoryLoader.ts's loadEventHistorySource, whose `picks`/`packsSeen`
 * fields are this function's natural input.
 *
 * Pure/Electron-free/DB-free, same split as every other domain/*.ts file -
 * the Electron layer (a future draft-filter settings page, milestone 23
 * feature d) joins grpId -> card name/colors afterward, same pattern as
 * LimitedStatsRow.deckViewerFileName/shareFragmentHtml.
 */
export interface PickPriorityRow {
  grpId: number;
  /** How many times this exact card (by grpId) was picked across every captured draft. */
  timesPicked: number;
  /** Average number of other cards still in the pack when this card was picked. */
  avgOthersInPack: number;
  minOthersInPack: number;
  maxOthersInPack: number;
}

function dedupeLatestByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(keyFn(item), item);
  return [...map.values()];
}

/**
 * `picks`/`packsSeen` are expected to be the raw, dataset-wide event lists
 * (e.g. EventHistorySource's own fields) - this function does its own
 * (draftId, pack, pick) dedup internally (same "latest wins" convention
 * eventHistory.ts/liveState.ts already use for the exact same raw data),
 * so callers don't need to pre-dedupe or pre-scope to one draft.
 */
export function buildPickPriorityRows(picks: DraftPickMade[], packsSeen: DraftPackSeen[]): PickPriorityRow[] {
  // Scoped by draftId too (via the composite key), not just pack/pick -
  // two different drafts legitimately reuse the same "pack 1, pick 1"
  // label for two entirely different boosters.
  const packCardsByKey = new Map<string, number[]>();
  for (const seen of dedupeLatestByKey(packsSeen, (p) => `${p.draftId}|${p.pack}|${p.pick}`)) {
    packCardsByKey.set(`${seen.draftId}|${seen.pack}|${seen.pick}`, seen.packCards);
  }

  // Same dedup for picks - a replayed log (`--from-start`) can re-append
  // the same real pick more than once; this isn't "picked it twice", just
  // one real pick captured twice.
  const dedupedPicks = dedupeLatestByKey(picks, (p) => `${p.draftId}|${p.pack}|${p.pick}`);

  const samplesByGrpId = new Map<number, number[]>();
  for (const pick of dedupedPicks) {
    const packCards = packCardsByKey.get(`${pick.draftId}|${pick.pack}|${pick.pick}`);
    // No matching DraftPackSeen captured for this exact pick (a capture
    // gap - e.g. the app wasn't running when the pack was offered) - skip
    // rather than guess at how many cards were in it.
    if (!packCards) continue;
    // Almost always 1 card taken (0 others-than-self to subtract beyond
    // itself); "Pick Two" draft takes 2, so both of those 2 cards count
    // the same "how many OTHER cards were left" value (the whole pack
    // minus both cards taken this pick), not the pack minus just one.
    const others = Math.max(0, packCards.length - pick.grpIds.length);
    for (const grpId of pick.grpIds) {
      const arr = samplesByGrpId.get(grpId);
      if (arr) arr.push(others);
      else samplesByGrpId.set(grpId, [others]);
    }
  }

  const rows: PickPriorityRow[] = [];
  for (const [grpId, samples] of samplesByGrpId) {
    const sum = samples.reduce((a, b) => a + b, 0);
    rows.push({
      grpId,
      timesPicked: samples.length,
      avgOthersInPack: sum / samples.length,
      minOthersInPack: Math.min(...samples),
      maxOthersInPack: Math.max(...samples),
    });
  }
  // Most-picked first (the cards there's actually enough data about to
  // read anything into); ties broken by grpId for a stable, deterministic
  // order instead of whatever order the Map happened to iterate in.
  return rows.sort((a, b) => b.timesPicked - a.timesPicked || a.grpId - b.grpId);
}
