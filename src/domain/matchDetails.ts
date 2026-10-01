import type { GameStateSnapshot, MatchFound } from "./types.js";
import { compareTs } from "./courseRuns.js";

/**
 * Milestone 20 (2026-09-30): "add tracking match information: Who played
 * first, number of rounds, number of mulgains (me and opponent)" - the
 * third of six sub-requests from the user's 2026-09-30 message.
 *
 * Deliberately built entirely from data this project ALREADY captures
 * (`GameStateSnapshot` - 9,868 rows already in the real `tracker.db` as of
 * this milestone, one per meaningful GRE state diff) plus one small
 * classifier addition (`mulliganCount`, see types.ts/classifier.ts) rather
 * than a brand-new, unverified message shape:
 *
 * - "Who played first" doesn't need the raw `ChooseStartingPlayerReq`/
 *   `Resp` messages (whose exact semantics weren't fully certain from a
 *   single grep) - it falls out of data already classified and flattened
 *   (`turnInfo.activePlayer` -> `GameStateSnapshot.turnActivePlayer`).
 *   Confirmed directly from the real capture (2026-09-30): the very first
 *   `GameStateSnapshot` of a game with a non-null `turnActivePlayer` is
 *   turn 1's own upkeep (`phase: "Phase_Beginning", step: "Step_Upkeep",
 *   turnNumber: 1`), and that snapshot's active-player's own entry in
 *   `players[]` is the only one carrying `turnNumber: 1` at all (the field
 *   is per-player and only ever set on whoever's turn it currently is) -
 *   so "whoever is turnActivePlayer on the earliest snapshot with a
 *   resolved activePlayer" IS "who went first," with no need to interpret
 *   the pre-game choice message itself.
 * - "Number of rounds" (read as turn count, the natural reading for a
 *   single Magic game) is just the max `players[].turnNumber` ever seen
 *   across a game's snapshots - already captured, just never surfaced.
 * - "Mulligans" needed the one real classifier addition - see types.ts.
 *
 * Kept as its own small module rather than folding into `rollups.ts`'s
 * `MatchOutcome`/`computeMatchOutcomes` (used everywhere, heavily tested)
 * - this is optional, additive detail a caller looks up per matchId
 * alongside an existing `MatchOutcome`, not a replacement for it.
 */
export interface MatchGameSummary {
  /** Arena's own gameNumber (1-indexed) - matches `GameStateSnapshot.gameNumber`/`MatchOutcome.games`' own convention. */
  gameNumber: number;
  /** true = I was on the play, false = I drew, null = no snapshot for this game ever resolved a turnActivePlayer, or myScreenName/this match's seat couldn't be resolved. */
  iPlayedFirst: boolean | null;
  /** Highest turnNumber reached by either player in this game - null if never captured (e.g. the game state was only seen after it already ended, or a pure-noise-filtered game with no player turnNumber ever seen). */
  turnCount: number | null;
  myMulligans: number;
  opponentMulligans: number;
}

/**
 * Builds per-game (who-played-first / turn-count / mulligan) detail for
 * every match `snapshots` has data for, keyed by matchId. A match with no
 * resolvable seat (e.g. `myScreenName` is null, or this matchId has no
 * `MatchFound` at all) is simply absent from the result - callers should
 * treat a missing key as "no detail available," the same convention as
 * `EventRunHistory.deck === null` etc. elsewhere in this project.
 */
export function buildMatchGameDetails(snapshots: GameStateSnapshot[], matchFounds: MatchFound[], myScreenName: string | null): Map<string, MatchGameSummary[]> {
  const result = new Map<string, MatchGameSummary[]>();
  if (!myScreenName) return result;

  const matchById = new Map(matchFounds.map((m) => [m.matchId, m]));

  const byMatch = new Map<string, GameStateSnapshot[]>();
  for (const s of snapshots) {
    if (!s.matchId) continue; // lastKnownMatchId hadn't resolved yet when this snapshot was classified
    const list = byMatch.get(s.matchId) ?? [];
    list.push(s);
    byMatch.set(s.matchId, list);
  }

  for (const [matchId, matchSnapshots] of byMatch) {
    const found = matchById.get(matchId);
    const me = found?.players.find((p) => p.playerName === myScreenName);
    const opponent = found?.players.find((p) => p.playerName !== myScreenName);
    if (!me || !opponent) continue; // can't attribute "mine" vs "opponent's" without both seats

    const byGame = new Map<number, GameStateSnapshot[]>();
    for (const s of matchSnapshots) {
      if (s.gameNumber === null) continue;
      const list = byGame.get(s.gameNumber) ?? [];
      list.push(s);
      byGame.set(s.gameNumber, list);
    }

    const summaries: MatchGameSummary[] = [];
    for (const [gameNumber, gameSnapshots] of byGame) {
      const sorted = [...gameSnapshots].sort((a, b) => compareTs(a.ts, b.ts));

      const firstResolved = sorted.find((s) => s.turnActivePlayer !== null);
      const iPlayedFirst = firstResolved ? firstResolved.turnActivePlayer === me.systemSeatId : null;

      let turnCount: number | null = null;
      let myMulligans = 0;
      let opponentMulligans = 0;
      for (const s of sorted) {
        for (const p of s.players) {
          if (typeof p.turnNumber === "number") turnCount = Math.max(turnCount ?? 0, p.turnNumber);
          if (p.systemSeatNumber === me.systemSeatId && typeof p.mulliganCount === "number") myMulligans = Math.max(myMulligans, p.mulliganCount);
          if (p.systemSeatNumber === opponent.systemSeatId && typeof p.mulliganCount === "number") opponentMulligans = Math.max(opponentMulligans, p.mulliganCount);
        }
      }

      summaries.push({ gameNumber, iPlayedFirst, turnCount, myMulligans, opponentMulligans });
    }

    summaries.sort((a, b) => a.gameNumber - b.gameNumber);
    if (summaries.length > 0) result.set(matchId, summaries);
  }

  return result;
}

/**
 * Milestone 24 (2026-10-01): "I want to have number of turns displayed for
 * each match. Also average number for chosen deck" (plus per-format/
 * per-set breakdowns elsewhere - see statsRollup.ts). Averages PER GAME,
 * not per match - per the user's own explicit choice, a 3-game Bo3
 * contributes three data points to an average, not one summed number
 * (every match captured so far is still Bo1, so this is one game per
 * match in practice today, but the distinction matters once a real Bo3 is
 * captured).
 *
 * Takes the already-built `gameDetails` map (buildMatchGameDetails' own
 * return value) rather than snapshots/matchFounds/myScreenName directly,
 * so a caller already computing per-match turn detail (e.g.
 * opponentStats.ts, which needs the SAME map's turnCounts for its own
 * per-match rows) builds it once and reuses it here rather than this
 * function re-deriving it a second time from raw snapshots.
 */
export function turnCountTotals(gameDetails: Map<string, MatchGameSummary[]>, matchIds: Iterable<string>): { totalTurns: number; gameCount: number } {
  let totalTurns = 0;
  let gameCount = 0;
  for (const matchId of matchIds) {
    for (const g of gameDetails.get(matchId) ?? []) {
      if (g.turnCount === null) continue; // no resolved turnNumber ever seen for this game - absent, not zero
      totalTurns += g.turnCount;
      gameCount += 1;
    }
  }
  return { totalTurns, gameCount };
}

/**
 * Convenience wrapper around turnCountTotals for a caller that only wants
 * the final average (deckViewerLoader.ts's single-run page, which has no
 * further cross-row aggregation to do) - a caller that DOES need to
 * re-aggregate across several of these (statsRollup.ts's per-run rows,
 * summed later by whichever subtype/set/color filter is currently active
 * in statsHtml.ts) should call turnCountTotals directly and keep the raw
 * sum/count, the same reason wins/losses are stored raw rather than as a
 * pre-divided pct everywhere else in this project.
 */
export function averageTurnCount(gameDetails: Map<string, MatchGameSummary[]>, matchIds: Iterable<string>): { avgTurns: number | null; gameCount: number } {
  const { totalTurns, gameCount } = turnCountTotals(gameDetails, matchIds);
  return { avgTurns: gameCount > 0 ? totalTurns / gameCount : null, gameCount };
}
