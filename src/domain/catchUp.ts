import type { RawBlock } from "../log/logParser.js";
import type { DomainEvent } from "./types.js";

/** A raw block paired with whatever typed events the classifier produced for it. */
export interface ClassifiedBlock {
  block: RawBlock;
  events: DomainEvent[];
}

export interface CatchUpSelection {
  /** matchIds found in `blocks` that aren't in `existingMatchIds` - what "missed matches" resolves to. */
  newMatchIds: string[];
  /** Exactly the blocks (and all their events) that belong to one of newMatchIds - safe to append as-is. */
  toAppend: ClassifiedBlock[];
}

function hasMatchId(e: DomainEvent): e is DomainEvent & { matchId: string } {
  return typeof (e as unknown as { matchId?: unknown }).matchId === "string";
}

/**
 * Milestone 25: "the tracker was off for a bit, recover whatever matches
 * happened while it was" - first built as the standalone
 * backfillFromLog.ts script (replay all of Arena's current Player.log
 * through the classifier), then wired into app startup so it happens
 * automatically every launch instead of needing to be run by hand.
 *
 * Given every block classified from a full replay of Player.log, and the
 * matchIds already on record, picks out only the blocks belonging to
 * matches not already known. This is what makes replaying the whole log
 * on every startup safe to repeat: a match already in the store is
 * dropped here, never re-appended, no matter how many times its blocks
 * get reclassified.
 *
 * Deliberately matchId-scoped, not a general re-sync tool: events with no
 * matchId at all (PlayerIdentified, DraftPackSeen, CourseStanding, ...)
 * are never selected, even if they occurred during the gap - this only
 * recovers whole matches, not every event kind.
 */
export function selectNewMatchEvents(blocks: ClassifiedBlock[], existingMatchIds: ReadonlySet<string>): CatchUpSelection {
  const newMatchIds = new Set<string>();
  for (const { events } of blocks) {
    for (const e of events) {
      if (hasMatchId(e) && !existingMatchIds.has(e.matchId)) newMatchIds.add(e.matchId);
    }
  }

  const toAppend = blocks.filter(({ events }) => events.some((e) => hasMatchId(e) && newMatchIds.has(e.matchId)));

  return { newMatchIds: [...newMatchIds], toAppend };
}
