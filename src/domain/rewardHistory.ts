import type { EventHistorySource } from "./eventHistory.js";
import { listEventRuns, buildEventRunHistory } from "./eventHistory.js";
import type { RewardGrant } from "./types.js";
import type { EventFormat } from "./eventIdentity.js";

/**
 * Milestone 21 (2026-10-01): "Now I want to have layout of event rewards -
 * button in settings -> layout where I can filter for events by format,
 * set and see rewards earned. Also I want to track overall rewards from
 * quests etc. just to see overall stuff player earned." - the two halves
 * of that request, kept in this one file since they share the same
 * "rewards" subject even though they read from completely different
 * EventHistorySource fields.
 *
 * Half 1 (buildEventRewardRows): one row per event RUN, filterable by
 * format/set - a THIN join over listEventRuns/buildEventRunHistory, the
 * exact same pattern statsRollup.ts and opponentStats.ts already use.
 * Needed NO new capture at all: EventRunHistory has carried .entry
 * (what was paid to join) and .reward (that run's own prize claim) since
 * milestone 17 - this just reshapes them into a flat, per-run row.
 *
 * Half 2 (summarizeOverallRewards): "overall rewards... from quests etc."
 * is NOT scoped to any one event run at all, so it can't reuse the join
 * above - it reads the new, generic RewardGrant ledger instead (see that
 * type's doc comment in types.ts, and classifyRewardGrants in
 * classifier.ts for how it's captured). Arena has no separate traditional
 * "quest" reward source left in the real data investigated for this
 * milestone - what the user means by "quests etc." is the modern
 * equivalent, the Mastery Pass / Campaign Graph tier-up reward
 * (CampaignGraphTieredRewardNode), confirmed real via the user's own
 * BattlePass_FRA capture.
 *
 * The "earned" total here deliberately EXCLUDES two confirmed-real
 * sources that are NOT rewards: EventGrantCardPool (a Sealed pool -
 * something bought by joining, not given for free) and EventPayEntry (the
 * entry fee itself - a cost, negative gems). Both are still surfaced,
 * just labeled as separate context rather than folded into "earned",
 * since counting a purchase or a cost as a reward would overstate what
 * the player actually won. Any OTHER source (none observed in real data
 * as of this writing, besides the four confirmed ones) is bucketed into
 * `other` rather than dropped, so a future Arena reward type doesn't
 * silently vanish from the total - see classifyRewardGrants's own comment
 * for the same "stay neutral, don't guess" stance at the capture layer.
 */

export interface EventRewardRow {
  eventId: string;
  /** Non-null only for a courseId-disambiguated run - see EventRunRef.courseId's comment in eventHistory.ts. */
  courseId: string | null;
  format: EventFormat;
  subtype: string;
  setCode: string | null;
  definitionLabel: string;
  /** What it cost to join this run - null if no join was captured. */
  entry: { currencyType: string; amountPaid: number } | null;
  /** This run's own prize claim - null if none was captured (yet, or none was ever due). */
  reward: {
    gems: number;
    gold: number;
    boosters: Array<{ setCode: string; count: number }>;
    grantedCardCount: number;
  } | null;
}

/** One row per event run (same granularity/courseId-disambiguation as statsRollup.ts/opponentStats.ts), carrying that run's own entry cost + prize claim for the "filter by format/set, see rewards earned" page. */
export function buildEventRewardRows(source: EventHistorySource): EventRewardRow[] {
  const rows: EventRewardRow[] = [];
  for (const run of listEventRuns(source)) {
    const history = buildEventRunHistory(run.eventId, source, run.courseId);
    rows.push({
      eventId: run.eventId,
      courseId: run.courseId,
      format: history.format,
      subtype: history.identity.subtype,
      setCode: history.identity.setCode,
      definitionLabel: history.identity.definitionLabel,
      entry: history.entry,
      reward: history.reward
        ? {
            gems: history.reward.gems,
            gold: history.reward.gold,
            boosters: history.reward.boosters,
            grantedCardCount: history.reward.grantedCardCount,
          }
        : null,
    });
  }
  return rows;
}

export interface RewardCategoryTotal {
  gems: number;
  gold: number;
  /** Summed per set code - same "combine, don't duplicate" convention as rewardRollup.ts's RewardTotal.boosters. */
  boosters: Array<{ setCode: string; count: number }>;
  grantedCardCount: number;
  /** How many separate RewardGrant captures contributed to this total. */
  grantCount: number;
}

export interface OverallRewardSummary {
  /** source === "EventReward" - an event's prize claim. Earned. */
  eventPrizes: RewardCategoryTotal;
  /** source === "CampaignGraphTieredRewardNode" - a Mastery Pass tier-up. Earned - this is "quests etc." in current Arena. */
  masteryPass: RewardCategoryTotal;
  /** Any source besides the four confirmed real ones - earned by default (see this file's header for why nothing is dropped). */
  other: RewardCategoryTotal;
  /** eventPrizes + masteryPass + other combined - "how much has this account earned, total". */
  earnedTotal: RewardCategoryTotal;
  /** source === "EventPayEntry" - a cost, NOT a reward (gems will be negative). Context only, excluded from earnedTotal. */
  entryFeesPaid: RewardCategoryTotal;
  /** source === "EventGrantCardPool" - a Sealed pool bought by joining, NOT a free reward. Context only, excluded from earnedTotal. */
  sealedPoolsReceived: RewardCategoryTotal;
}

function emptyCategoryTotal(): RewardCategoryTotal {
  return { gems: 0, gold: 0, boosters: [], grantedCardCount: 0, grantCount: 0 };
}

function addInto(total: RewardCategoryTotal, grant: RewardGrant): void {
  total.gems += grant.gems;
  total.gold += grant.gold;
  total.grantedCardCount += grant.grantedCardCount;
  total.grantCount += 1;
  for (const b of grant.boosters) {
    const existing = total.boosters.find((x) => x.setCode === b.setCode);
    if (existing) existing.count += b.count;
    else total.boosters.push({ setCode: b.setCode, count: b.count });
  }
}

function mergeInto(target: RewardCategoryTotal, source: RewardCategoryTotal): void {
  target.gems += source.gems;
  target.gold += source.gold;
  target.grantedCardCount += source.grantedCardCount;
  target.grantCount += source.grantCount;
  for (const b of source.boosters) {
    const existing = target.boosters.find((x) => x.setCode === b.setCode);
    if (existing) existing.count += b.count;
    else target.boosters.push({ setCode: b.setCode, count: b.count });
  }
}

/** Categorizes and sums every RewardGrant ever captured (account-wide, not scoped to any run) into the "overall rewards earned" summary - see this file's header for the earned-vs-cost/purchase split. */
export function summarizeOverallRewards(grants: RewardGrant[]): OverallRewardSummary {
  const eventPrizes = emptyCategoryTotal();
  const masteryPass = emptyCategoryTotal();
  const other = emptyCategoryTotal();
  const entryFeesPaid = emptyCategoryTotal();
  const sealedPoolsReceived = emptyCategoryTotal();

  for (const g of grants) {
    switch (g.source) {
      case "EventReward":
        addInto(eventPrizes, g);
        break;
      case "CampaignGraphTieredRewardNode":
        addInto(masteryPass, g);
        break;
      case "EventPayEntry":
        addInto(entryFeesPaid, g);
        break;
      case "EventGrantCardPool":
        addInto(sealedPoolsReceived, g);
        break;
      default:
        addInto(other, g);
    }
  }

  const earnedTotal = emptyCategoryTotal();
  mergeInto(earnedTotal, eventPrizes);
  mergeInto(earnedTotal, masteryPass);
  mergeInto(earnedTotal, other);

  return { eventPrizes, masteryPass, other, earnedTotal, entryFeesPaid, sealedPoolsReceived };
}
