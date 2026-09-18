import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TypedEventStore } from "./db/sqliteStore.js";
import type { DraftPickMade } from "./domain/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Prints a quick human-readable summary from data/tracker.db. Not the
 * overlay, not a dashboard - just a sanity-check readout proving the typed
 * events add up to something useful (deck used, draft picks, win/loss).
 */
function main() {
  const dbPath = join(__dirname, "..", "data", "tracker.db");
  const store = new TypedEventStore(dbPath);

  const identified = store.all("PlayerIdentified");
  const myScreenName = identified.at(-1)?.screenName ?? null;

  console.log("=== Player ===");
  console.log(myScreenName ? `You are: ${myScreenName}` : "(no PlayerIdentified event captured yet)");

  // --- Drafts ---
  // Note: these all get deduped by a natural key below. That's not just
  // tidiness - re-running `npm start -- --from-start` re-appends the whole
  // replayed log onto data/raw-events.jsonl each time (milestone-1's raw
  // store has no de-dup), so the same real draft/match can easily appear
  // more than once in the raw data. Natural-key de-dup here means the
  // report stays correct regardless of how many times the log was replayed.
  const dedupeBy = <T>(items: T[], keyFn: (item: T) => string): T[] => {
    const map = new Map<string, T>();
    for (const item of items) map.set(keyFn(item), item);
    return [...map.values()];
  };

  const joins = dedupeBy(store.all("DraftJoined"), (j) => `${j.eventName}|${j.entryCurrencyPaid}`);
  const completions = dedupeBy(store.all("DraftCompleted"), (c) => c.courseId);
  const decks = dedupeBy(store.all("DeckSubmitted"), (d) => d.deckId);
  const picks = store.all("DraftPickMade");

  // Dedupe picks by (draftId, pack, pick), keeping the last (most-confirmed) entry.
  const latestPickByKey = new Map<string, DraftPickMade>();
  for (const p of picks) {
    latestPickByKey.set(`${p.draftId}|${p.pack}|${p.pick}`, p);
  }
  const dedupedPicks = [...latestPickByKey.values()];
  const confirmedPicks = dedupedPicks.filter((p) => p.success === true).length;

  console.log("\n=== Drafts ===");
  console.log(`Joined: ${joins.length}   Completed: ${completions.length}   Decks submitted: ${decks.length}`);
  console.log(`Picks made: ${dedupedPicks.length} (${confirmedPicks} confirmed successful)`);
  for (const c of completions) {
    const deck = decks.find((d) => d.eventName === c.eventName);
    console.log(
      `  - ${c.eventName}: ${c.cardPool.length}-card pool` + (deck ? `, deck "${deck.deckName}" (${deck.mainDeck.reduce((n, x) => n + x.quantity, 0)} cards)` : ", no deck submission captured"),
    );
  }

  // --- Matches ---
  const matchFounds = dedupeBy(store.all("MatchFound"), (m) => m.matchId);
  const matchCompletions = dedupeBy(store.all("MatchCompleted"), (m) => m.matchId);

  console.log("\n=== Matches ===");
  if (matchFounds.length === 0) {
    console.log("(none captured yet)");
  }
  for (const found of matchFounds) {
    const me = found.players.find((p) => p.playerName === myScreenName);
    const opponent = found.players.find((p) => p.playerName !== myScreenName);
    const completion = matchCompletions.find((m) => m.matchId === found.matchId);
    const matchResult = completion?.results.find((r) => r.scope === "MatchScope_Match");

    let outcome = "in progress / result not captured";
    if (me && matchResult) {
      outcome = matchResult.winningTeamId === me.teamId ? "WIN" : "LOSS";
      outcome += ` (${matchResult.reason.replace("ResultReason_", "")})`;
    }

    console.log(`  - vs ${opponent?.playerName ?? "?"} [event: ${found.eventId ?? "?"}] -> ${outcome}`);
  }

  store.close();
}

main();
