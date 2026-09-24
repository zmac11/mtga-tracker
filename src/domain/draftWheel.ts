import type { DraftPackSeen, DraftPickMade } from "./types.js";

/**
 * Milestone 7 phase 6 - draft pool "wheel" attribution. Confirmed against
 * real captured data before writing this (2026-09-18 ContenderDraft, an
 * 8-person human/Traditional-draft pod - see feature-roadmap-milestone7.md's
 * phase 6 notes for the investigation this is based on): Arena's `pack`
 * field groups one full booster-circulation *round* together, not one
 * single physical pack - each pick within a `pack` group can be a
 * DIFFERENT physical pack passing by, and a "wheel" (the same physical pack
 * coming back around to this player after everyone else in the pod has
 * taken one card from it) shows up as a LATER pick's `packCards` being a
 * strict subset of an EARLIER pick's `packCards`, within the same `pack`
 * group. Verified directly against the real data: pick 1's 14-card pack and
 * pick 9's 6-card pack shared all 6 of pick 9's cards, with exactly 8 gone
 * (this player's own pick-1 card, plus 7 taken by the other 7 pod members)
 * - consistent with an 8-person pod and a wheel offset of exactly pod size.
 * Pick 2 -> pick 10, pick 3 -> pick 11, ... pick 6 -> pick 14 all confirmed
 * the same offset-8 pattern.
 *
 * This deliberately does NOT hardcode a pod size (8, or any other number) -
 * it *derives* the real offset from the data itself, per pack-number group:
 * collect every (earlier pick, later pick) pair within the group where the
 * later pick's cards are a strict subset of the earlier pick's, then take
 * whichever offset (later.pick - earlier.pick) is the most common one among
 * those pairs as the group's real wheel distance, and only attribute a
 * wheel using that confirmed offset - a plain "nearest smaller-subset
 * match" is NOT enough, and produces a real false positive on this exact
 * data: pick 8's 7-card pack happens to fully contain pick 13's unrelated
 * 2-card remainder purely by coincidence (offset 5), even though that
 * doesn't fit this draft's real, dominant offset-8 pattern (confirmed 6
 * times over, for picks 1 through 6). Requiring the dominant offset instead
 * of "nearest match" correctly rejects that one and leaves pick 8 with no
 * wheel, which is the right answer - pick 8 truly doesn't wheel back within
 * this round (that would need pick 16, and the round ends at pick 14).
 *
 * This also self-adapts to whatever the real pod size is for a given draft,
 * and to drafts where nothing ever wheels at all - including Bot Draft,
 * whose wheel behavior (or lack thereof) was NOT captured/confirmed in real
 * data as of this writing (no Bot Draft DraftPackSeen data exists in the
 * tracker.db this was validated against - see phase 6's roadmap notes). If a
 * pack-number group has no subset-pair candidates at all (e.g. because Bot
 * Draft isn't modeled as a circulating pod), every pick in it just comes
 * back with wheeledAt: null - the honest, correct answer, not a crash or a
 * wrong attribution. Confirm/revise this comment once real Bot Draft pack
 * data is captured.
 */

export interface WheelInfo {
  /** Where this same physical pack was next seen with fewer cards - null if it was never seen again in what we captured (including "this pod never wheels this pack back around before the round ends", which is normal for later picks). */
  wheeledAt: { pack: number; pick: number } | null;
  /**
   * grpIds present in this pack the first time it was seen but gone by the
   * wheel point, excluding whatever THIS player took at this very pick
   * (that one's just "your pick", not "taken by someone else" - see
   * `grpId` on DraftPickAttribution). Undifferentiated beyond that - which
   * specific opponent took which card isn't knowable from this data (see
   * the roadmap's own note on this). Empty array (not meaningful) when
   * wheeledAt is null.
   */
  takenByOthers: number[];
}

export interface DraftPickAttribution {
  pack: number;
  pick: number;
  /** The card this player took at this pick. */
  grpId: number;
  /** The full pack as first offered at this pick (includes `grpId` above - it hadn't been taken yet). */
  packCards: number[];
  wheel: WheelInfo;
}

/**
 * `picks`/`packsSeen` should already be scoped to one draft run (e.g.
 * eventHistory.ts's `EventRunHistory.picks`/`packsSeen`, which are already
 * deduped-to-latest and draftId-scoped) - this function doesn't filter by
 * draftId itself, consistent with the rest of src/domain/ taking already-
 * narrowed data rather than reaching into storage.
 */
export function attributeDraftWheel(picks: DraftPickMade[], packsSeen: DraftPackSeen[]): DraftPickAttribution[] {
  const byPackNumber = new Map<number, DraftPackSeen[]>();
  for (const p of packsSeen) {
    const arr = byPackNumber.get(p.pack) ?? [];
    arr.push(p);
    byPackNumber.set(p.pack, arr);
  }
  for (const arr of byPackNumber.values()) arr.sort((a, b) => a.pick - b.pick);

  const pickByPackPick = new Map<string, DraftPickMade>();
  for (const p of picks) pickByPackPick.set(`${p.pack}|${p.pick}`, p);

  const results: DraftPickAttribution[] = [];
  for (const group of byPackNumber.values()) {
    // Pass 1: collect every (i, j) pair within this pack-number group where
    // group[j]'s cards are a strict subset of group[i]'s - each one is a
    // *candidate* wheel match - and tally how often each resulting offset
    // (j.pick - i.pick) occurs. The offset that occurs most often is this
    // group's real, confirmed wheel distance (the pod size); see the file
    // comment for why a coincidental small-subset match (a wrong offset
    // that only occurs once) must not be trusted just because it's the
    // nearest one.
    const candidates: Array<{ i: number; j: number; offset: number }> = [];
    const offsetCounts = new Map<number, number>();
    for (let i = 0; i < group.length; i++) {
      const seen = group[i];
      for (let j = i + 1; j < group.length; j++) {
        const later = group[j];
        if (later.packCards.length >= seen.packCards.length) continue; // must be strictly smaller to even be a candidate
        const isSubset = later.packCards.every((id) => seen.packCards.includes(id));
        if (isSubset) {
          const offset = later.pick - seen.pick;
          candidates.push({ i, j, offset });
          offsetCounts.set(offset, (offsetCounts.get(offset) ?? 0) + 1);
        }
      }
    }
    let dominantOffset: number | null = null;
    let dominantCount = 0;
    for (const [offset, count] of offsetCounts) {
      if (count > dominantCount) {
        dominantCount = count;
        dominantOffset = offset;
      }
    }

    // Pass 2: attribute each pick, only accepting a candidate match whose
    // offset equals the group's dominant offset - anything else (like the
    // pick-8-to-pick-13 coincidence, offset 5, a lone outlier next to six
    // real offset-8 matches) is discarded rather than attributed.
    for (let i = 0; i < group.length; i++) {
      const seen = group[i];
      const made = pickByPackPick.get(`${seen.pack}|${seen.pick}`);
      // Saw the pack but never captured a matching pick (a real capture gap,
      // e.g. the log-rotation bug milestone 5 fixed) - nothing to attribute
      // this row to, so skip it rather than guessing what was taken.
      if (!made) continue;

      let wheel: WheelInfo = { wheeledAt: null, takenByOthers: [] };
      if (dominantOffset !== null) {
        const match = candidates.find((c) => c.i === i && c.offset === dominantOffset);
        if (match) {
          const later = group[match.j];
          const laterSet = new Set(later.packCards);
          const takenByOthers = seen.packCards.filter((id) => !laterSet.has(id) && id !== made.grpId);
          wheel = { wheeledAt: { pack: later.pack, pick: later.pick }, takenByOthers };
        }
      }

      results.push({ pack: seen.pack, pick: seen.pick, grpId: made.grpId, packCards: seen.packCards, wheel });
    }
  }

  return results.sort((a, b) => a.pack - b.pack || a.pick - b.pick);
}
