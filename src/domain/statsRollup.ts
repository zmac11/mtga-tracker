import type { EventHistorySource } from "./eventHistory.js";
import { listEventRuns, buildEventRunHistory } from "./eventHistory.js";
import { deriveDeckColors, type ColorLetter } from "./deckColors.js";
import type { WinRate } from "./rollups.js";
import { buildMatchGameDetails, turnCountTotals } from "./matchDetails.js";

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
  /**
   * Milestone 24 (2026-10-01): "average turns per format and per set in
   * limited" - raw sum/count (not a pre-divided average), same convention
   * wins/losses above already use, so statsHtml.ts can correctly
   * re-aggregate a weighted average across however many rows the live
   * subtype/set/color filter currently matches, rather than averaging
   * each run's own average a second time (which would quietly overweight
   * a run with fewer games). Averaged PER GAME, not per match - a run
   * with a 3-game Bo3 counts three data points, not one match-level
   * number (see matchDetails.ts's averageTurnCount for why). 0/0 (not
   * null) when this run has no captured turn data at all, so summing
   * across rows never needs a null check.
   */
  totalTurns: number;
  turnGameCount: number;
  /** This run's own (latest) maindeck (cardId+quantity), or empty if no deck was captured - see this interface's header comment for why it's carried here. */
  mainDeck: Array<{ cardId: number; quantity: number }>;
  /**
   * Milestone 20 follow-up (2026-09-30): "For limited events track winrates
   * even for single cards in maindeck" - one entry per PLAYED deck
   * configuration for this run (deckVersions.ts's DeckVersion, not just the
   * final mainDeck above), each with its own maindeck and the local
   * win/loss record earned while that exact configuration was in use. This
   * is the granularity a per-card win rate needs (a card that was only in
   * an early, poorly-performing version of the deck shouldn't be blamed
   * for games played after it got cut) - the flat `wins`/`losses` above
   * are the run's OVERALL, CourseStanding-reconciled total and deliberately
   * NOT the same thing (deckVersions.ts's own winRate is local-only, never
   * reconciled - see that file's header), so the two can disagree slightly
   * and that's expected, not a bug. Empty when no deck version was ever
   * actually played (see DeckVersion's own doc comment) - a real, if rare,
   * gap: such a run's cards simply don't contribute to the per-card
   * breakdown at all.
   */
  deckVersions: Array<{ mainDeck: Array<{ cardId: number; quantity: number }>; wins: number; losses: number }>;
  /**
   * Milestone 20 follow-up (2026-09-30): "I want to be able to open decks
   * from limited filter" - the relative filename of this run's own
   * deck-viewer page (written into the sibling `deck-viewer/` directory by
   * electron/main.ts's shared `writeDeckViewerPage`, the exact same helper
   * openPastEventsPage already uses), so statsHtml.ts can link straight to
   * it. Always null coming out of `buildLimitedStatsRows` below - this is
   * a pure, file-I/O-free domain function (see this file's header comment
   * on that split) and has no store/pipeline.dataDir to write a page to.
   * electron/main.ts's `openLimitedStatsPage` fills this in afterward, one
   * row at a time, exactly the way it already attaches `fileName` to each
   * `PastEventRow` in the sibling "Past Events" page.
   */
  deckViewerFileName: string | null;
  /**
   * Milestone 22 (2026-10-01): "I can export one deck or set of decks from
   * my event filter" - a pre-rendered share-page HTML fragment for this
   * run's deck (same visual layout + Arena-import box as the single-deck
   * share page, deckShareHtml.ts's renderShareSectionHtml), so the Limited
   * Stats page's "Export filtered decks" button can assemble one combined
   * HTML file from whichever rows currently pass the live filter, entirely
   * client-side (string concatenation + a Blob download - see
   * statsHtml.ts), with no round-trip back into Electron (this static
   * page has no IPC access at all - see electron/main.ts's own notes on
   * why). Always null coming out of `buildLimitedStatsRows` below, same
   * reasoning as `deckViewerFileName` above (a pure, file-I/O-free domain
   * function has no card catalog to render card art from) -
   * electron/main.ts's `openLimitedStatsPage` fills it in afterward.
   */
  shareFragmentHtml: string | null;
}

/** A card's basic display info, keyed by cardId - the small subset statsHtml.ts's per-card table needs, not a full EnrichedCard. */
export interface StatsCardInfo {
  cardId: number;
  name: string;
  colors: string[];
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
  const gameDetails = buildMatchGameDetails(source.gameStateSnapshots, source.matchFounds, source.myScreenName);

  for (const run of listEventRuns(source)) {
    const history = buildEventRunHistory(run.eventId, source, run.courseId);
    if (history.format !== "Draft" && history.format !== "Sealed") continue;

    const mainDeck = history.deck?.mainDeck ?? [];
    const profile = history.deck ? deriveDeckColors(mainDeck, cardColors) : null;
    const { totalTurns, gameCount } = turnCountTotals(gameDetails, history.matches.map((m) => m.matchId));

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
      totalTurns,
      turnGameCount: gameCount,
      mainDeck,
      deckVersions: history.deckVersions.map((v) => ({ mainDeck: v.mainDeck, wins: v.winRate.wins, losses: v.winRate.losses })),
      deckViewerFileName: null,
      shareFragmentHtml: null,
    });
  }
  return rows;
}

/**
 * The small, JSON-embeddable card catalog statsHtml.ts's per-card table
 * needs (name/colors only) - built here rather than embedding a full
 * EnrichedCard per card, and scoped to only the cardIds that actually
 * appear in some row's deckVersions (not the whole card database), to keep
 * the generated page's embedded payload small - same convention as
 * deckViewerLoader.ts's own per-page card lookups.
 */
export function buildStatsCardCatalog(rows: LimitedStatsRow[], cardsById: Map<number, { name: string; colors: string[] }>): StatsCardInfo[] {
  const ids = new Set<number>();
  for (const r of rows) for (const v of r.deckVersions) for (const e of v.mainDeck) ids.add(e.cardId);
  return [...ids].map((cardId) => {
    const c = cardsById.get(cardId);
    return { cardId, name: c?.name ?? `Unknown card #${cardId} (run npm run refresh-cards)`, colors: c?.colors ?? [] };
  });
}

/** Plain wins/losses -> WinRate, same convention as rollups.ts's winRateFromCounts - kept local rather than importing that one function just for this, since statsHtml.ts's client-side JS needs the identical pct-rounding rule re-implemented in JS anyway (see that file). */
export function winRateOf(rows: Array<{ wins: number; losses: number }>): WinRate {
  const wins = rows.reduce((sum, r) => sum + r.wins, 0);
  const losses = rows.reduce((sum, r) => sum + r.losses, 0);
  const total = wins + losses;
  const pct = total > 0 ? `${Math.round((wins / total) * 100)}%` : "-";
  return { wins, losses, total, pct };
}
