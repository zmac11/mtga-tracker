import type { DeckSubmitted } from "./types.js";
import { winRate, type MatchOutcome, type WinRate } from "./rollups.js";
import { compareTs } from "./courseRuns.js";

/**
 * Milestone 17: tracks every distinct deck a player actually PLAYED within
 * one event run, not just the latest submission. Arena's own event-sourced
 * log already captures a DeckSubmitted for every deck change mid-event
 * (the tracker.db `events` table is append-only - see
 * eventHistoryLoader.ts's comment on why the old `dedupeBy(..., (d) =>
 * d.deckId)` loader step was throwing this history away); this module is
 * what turns that raw submission history into "versions" worth showing a
 * player.
 *
 * Two things this deliberately does NOT do, per how the feature was asked
 * for:
 *  - It does not surface a version the player never actually played a game
 *    with. A deck can be resubmitted (even repeatedly, even back to an
 *    earlier configuration) without ever starting a match under that exact
 *    configuration - those submissions are real history but not a
 *    "version" worth cluttering the UI with.
 *  - It does not touch the event's own total win rate. That figure (see
 *    eventHistory.ts's buildEventRunHistory) is reconciled against Arena's
 *    own CourseStanding and must keep meaning "this event's overall
 *    record" regardless of how many deck versions it's broken down into
 *    here - CourseStanding has no per-version breakdown to reconcile
 *    against, so each version's own WinRate below is intentionally the
 *    raw local count, not reconciled.
 */

export interface DeckVersion {
  deckId: string;
  deckName: string;
  mainDeck: Array<{ cardId: number; quantity: number }>;
  /**
   * Milestone 18: the real sideboard captured alongside this specific
   * submission (DeckSubmitted.sideboard - see its doc comment in types.ts)
   * - always an array (possibly empty), never derived. Included in what
   * makes two submissions "the same version" (see deckContentKey below) so
   * a Constructed player's sideboard-only edit (real postboard tech
   * between event games, or between separate runs) is tracked as its own
   * version too, not silently merged into whichever version has the same
   * maindeck.
   */
  sideboard: Array<{ cardId: number; quantity: number }>;
  /** ts of the DeckSubmitted that introduced this version. */
  submittedAt: string;
  /** 1-indexed, in submission order across every version of this run (played or not) - "Version 1" is the deck the event was started with. */
  versionNumber: number;
  /** Matches attributed to this version (see deriveDeckVersions), NOT reconciled against CourseStanding - see the file header. */
  matches: MatchOutcome[];
  winRate: WinRate;
}

/** Order-independent content key for a card list - two lists with the same cards/quantities (regardless of array order) hash the same. */
function cardListKey(cards: Array<{ cardId: number; quantity: number }>): string {
  return [...cards]
    .map((e) => `${e.cardId}:${e.quantity}`)
    .sort()
    .join(",");
}

/**
 * Milestone 18: a version's identity is its mainDeck AND its sideboard
 * together - two submissions with the same 40/60/100 but a different
 * sideboard (a real Constructed scenario: postboard tech between event
 * games, kept for a later run) are meaningfully different configurations,
 * not "the same version" just because the maindeck matches.
 */
function deckContentKey(mainDeck: Array<{ cardId: number; quantity: number }>, sideboard: Array<{ cardId: number; quantity: number }>): string {
  return `${cardListKey(mainDeck)}|${cardListKey(sideboard)}`;
}

/**
 * Collapses a run's raw DeckSubmitted history (already filtered to one
 * eventName/eventId, any order) into distinct content-versions in
 * submission order, then attributes each locally-observed match (by ts,
 * relying on the same "ts is a sortable string" convention every other
 * chronological ordering in this codebase already uses - see
 * liveState.ts's activity sort) to whichever version was active when that
 * match was found. A match found before the first submission (shouldn't
 * normally happen, but real logs have surprised this project before) is
 * attributed to the first version rather than dropped, so no match is
 * ever silently lost from the per-version breakdown.
 *
 * Only versions with at least one attributed match are returned - see the
 * file header for why an unplayed resubmission isn't a "version" here.
 */
export function deriveDeckVersions(submissions: DeckSubmitted[], matches: MatchOutcome[]): DeckVersion[] {
  const sorted = [...submissions].sort((a, b) => compareTs(a.ts, b.ts));

  // Collapse consecutive submissions with identical deck content - a
  // resubmit of the exact same list (e.g. Arena re-sending state) isn't a
  // new version, only an actual content change is.
  const distinct: DeckSubmitted[] = [];
  let lastKey: string | null = null;
  for (const s of sorted) {
    const key = deckContentKey(s.mainDeck, s.sideboard ?? []);
    if (key !== lastKey) {
      distinct.push(s);
      lastKey = key;
    }
  }
  if (distinct.length === 0) return [];

  const sortedMatches = [...matches].sort((a, b) => compareTs(a.ts, b.ts));

  const versions: DeckVersion[] = distinct.map((s, i) => ({
    deckId: s.deckId,
    deckName: s.deckName,
    mainDeck: s.mainDeck,
    sideboard: s.sideboard ?? [],
    submittedAt: s.ts,
    versionNumber: i + 1,
    matches: [],
    winRate: winRate([]),
  }));

  for (const match of sortedMatches) {
    // The last version whose submittedAt is <= this match's ts is the
    // active one; a match earlier than every submission falls back to the
    // first version (see the doc comment above).
    let active = versions[0];
    for (const v of versions) {
      if (compareTs(v.submittedAt, match.ts) <= 0) active = v;
      else break;
    }
    active.matches.push(match);
  }

  for (const v of versions) v.winRate = winRate(v.matches);

  return versions.filter((v) => v.matches.length > 0);
}
