import type { EventHistorySource } from "./eventHistory.js";
import { listEventRuns, buildEventRunHistory } from "./eventHistory.js";
import { deriveDeckColors, type ColorLetter } from "./deckColors.js";
import type { WinRate } from "./rollups.js";

/**
 * Milestone 20 (2026-09-30): "Add some kind of filter for event types and
 * set for limited formats. Also add deck color filter. Show winrates for
 * such specific filter." - the first of the six sub-requests in that
 * message. One row per event RUN (same granularity as pastEventsHtml.ts's
 * PastEventRow/electron/main.ts's openPastEventsPage - reuses
 * listEventRuns so a courseId-collided eventId already yields one row per
 * real course, see courseRuns.ts), restricted to limited formats (Draft or
 * Sealed - Constructed/Other excluded, since "set" and "deck color" are
 * limited-format concepts per the user's own framing) and carrying this
 * run's own deck color profile so statsHtml.ts's filter UI can slice by
 * subtype/set/color entirely client-side from one embedded JSON array,
 * without another database round-trip per filter change.
 *
 * Deliberately a THIN join on top of eventHistory.ts/deckColors.ts rather
 * than new aggregation logic - buildEventRunHistory already does the real
 * work (matches, winRate reconciled against CourseStanding, the deck's own
 * mainDeck) for exactly this same per-run granularity; this only adds the
 * one thing that layer doesn't have, the deck's color identity, and
 * reshapes the result into the flat, JSON-embeddable shape the stats page
 * needs.
 *
 * `mainDeck` is carried through (not just used to derive colorCombo here)
 * because the next sub-request in the same user message - "For limited
 * events track winrates even for single cards in maindeck" - needs each
 * run's maindeck+winRate to roll up per-card; keeping it on this row now
 * means that follow-up work can reuse LimitedStatsRow directly instead of
 * re-deriving a second, parallel row shape.
 */
export interface LimitedStatsRow {
  eventId: string;
  /** Non-null only for a courseId-disambiguated run - see EventRunRef.courseId's comment in eventHistory.ts. */
  courseId: string | null;
  /** This run's resolved format - always "Draft" or "Sealed" here, since buildLimitedStatsRows below already filtered to those. */
  format: "Draft" | "Sealed";
  /** e.g. "QuickDraft", "Sealed" - whatever eventIdentity.ts parsed as the subtype. */
  subtype: string;
  /** e.g. "HOB" - null if this eventId didn't match the dated `<Subtype>_<SetCode>_<YYYYMMDD>` pattern. */
  setCode: string | null;
  /** Human-readable event-type label, e.g. "QuickDraft - HOB". */
  definitionLabel: string;
  deckName: string | null;
  /** e.g. "WU", "Mono-R", "Colorless", or "(no deck captured)" when this run has no deck at all. */
  colorCombo: string;
  splashColors: ColorLetter[];
  wins: number;
  losses: number;
  /** This run's own maindeck (cardId+quantity), or empty if no deck was captured - see this interface's header comment for why it's carried here. */
  mainDeck: Array<{ cardId: number; quantity: number }>;
}

/**
 * `cardColors` is a plain grpId->colors lookup (same shape deckViewerLoader.ts
 * already builds from CardStore.all() for the exact same deriveDeckColors
 * call) - passed in rather than taking a CardStore directly, so this stays
 * a plain-array/Map function like the rest of domain/ (see eventHistory.ts's
 * own file header for why that split matters here).
 */
export function buildLimitedStatsRows(source: EventHistorySource, cardColors: Map<number, string[]>): LimitedStatsRow[] {
  const rows: LimitedStatsRow[] = [];
  for (const run of listEventRuns(source)) {
    const history = buildEventRunHistory(run.eventId, source, run.courseId);
    if (history.format !== "Draft" && history.format !== "Sealed") continue;

    const mainDeck = history.deck?.mainDeck ?? [];
    const profile = history.deck ? deriveDeckColors(mainDeck, cardColors) : null;

    rows.push({
      eventId: run.eventId,
      courseId: run.courseId,
      format: history.format,
      subtype: history.identity.subtype,
      setCode: history.identity.setCode,
      definitionLabel: history.identity.definitionLabel,
      deckName: history.deck?.deckName ?? null,
      colorCombo: profile?.comboKey ?? "(no deck captured)",
      splashColors: profile?.splashColors ?? [],
      wins: history.winRate.wins,
      losses: history.winRate.losses,
      mainDeck,
    });
  }
  return rows;
}

/** Plain wins/losses -> WinRate, same convention as rollups.ts's winRateFromCounts - kept local rather than importing that one function just for this, since statsHtml.ts's client-side JS needs the identical pct-rounding rule re-implemented in JS anyway (see that file). */
export function winRateOf(rows: Array<{ wins: number; losses: number }>): WinRate {
  const wins = rows.reduce((sum, r) => sum + r.wins, 0);
  const losses = rows.reduce((sum, r) => sum + r.losses, 0);
  const total = wins + losses;
  const pct = total > 0 ? `${Math.round((wins / total) * 100)}%` : "-";
  return { wins, losses, total, pct };
}
