import type { EventReward } from "./types.js";
import { parseEventIdentity } from "./eventIdentity.js";

/**
 * Milestone 17: aggregates EventReward captures - "how much have I won,
 * total / per event / per format" - mirroring the existing rollupByEvent /
 * rollupByFormat pattern in rollups.ts, but summing reward totals instead
 * of win/loss counts. Kept in its own file rather than added to rollups.ts
 * since it operates on a completely different domain event and shares no
 * logic with the win/loss rollups beyond the general "group by
 * event/format" shape.
 */

export interface RewardTotal {
  gems: number;
  gold: number;
  /** Summed per set code (a claim with 2x HOB and a later claim with 3x HOB combine into one 5x HOB entry, not two separate lines). */
  boosters: Array<{ setCode: string; count: number }>;
  grantedCardCount: number;
  /** How many separate claims (EventReward captures) contributed to this total. */
  claimCount: number;
}

function emptyTotal(): RewardTotal {
  return { gems: 0, gold: 0, boosters: [], grantedCardCount: 0, claimCount: 0 };
}

function addInto(total: RewardTotal, reward: EventReward): void {
  total.gems += reward.gems;
  total.gold += reward.gold;
  total.grantedCardCount += reward.grantedCardCount;
  total.claimCount += 1;
  for (const b of reward.boosters) {
    const existing = total.boosters.find((x) => x.setCode === b.setCode);
    if (existing) existing.count += b.count;
    else total.boosters.push({ setCode: b.setCode, count: b.count });
  }
}

/** Sums every reward passed in into one combined total - the "how much have I won, ever" figure. */
export function sumRewards(rewards: EventReward[]): RewardTotal {
  const total = emptyTotal();
  for (const r of rewards) addInto(total, r);
  return total;
}

/** Groups rewards by their exact eventId (dated run) - "how much did this specific run pay out". */
export function rollupRewardsByEvent(rewards: EventReward[]): Map<string, RewardTotal> {
  const result = new Map<string, RewardTotal>();
  for (const r of rewards) {
    let total = result.get(r.eventId);
    if (!total) {
      total = emptyTotal();
      result.set(r.eventId, total);
    }
    addInto(total, r);
  }
  return result;
}

/** Groups rewards by event *format* (Draft/Sealed/Constructed/Other - see eventIdentity.ts) - "how much have I won from Draft events overall". */
export function rollupRewardsByFormat(rewards: EventReward[]): Map<string, RewardTotal> {
  const result = new Map<string, RewardTotal>();
  for (const r of rewards) {
    const format = parseEventIdentity(r.eventId).format;
    let total = result.get(format);
    if (!total) {
      total = emptyTotal();
      result.set(format, total);
    }
    addInto(total, r);
  }
  return result;
}
