import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TypedEventStore } from "./db/sqliteStore.js";
import type { DraftPickMade } from "./domain/types.js";
import { computeMatchOutcomes, rollupByEvent, rollupByEventDefinition, winRate } from "./domain/rollups.js";

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

  // One outcome record per match, computed once (via the shared rollups
  // module - also used by the overlay's live state) and reused below for
  // both the per-match printout and the win-rate rollups.
  const matchOutcomes = computeMatchOutcomes(matchFounds, matchCompletions, myScreenName);

  console.log("\n=== Matches ===");
  if (matchOutcomes.length === 0) {
    console.log("(none captured yet)");
  }
  for (const m of matchOutcomes) {
    const label = m.outcome ? `${m.outcome} (${m.reason})` : "in progress / result not captured";
    console.log(`  - vs ${m.opponent} [event: ${m.eventId ?? "?"}] -> ${label}`);
  }

  // --- Win rate rollups ---
  // Only counts decided matches (outcome !== null). Rolled up by event RUN
  // (eventId/eventName - e.g. every match under this exact dated
  // "ContenderDraft_HOB_20260824" live window) and, within that, by the deck
  // submitted for it.
  //
  // NOTE: eventName is currently the *only* reliable join between a match
  // and a draft run/deck. MatchFound.players[].courseId looked promising for
  // linking a match to the specific draft run, but it's confirmed to be a
  // different ID space entirely (values like "Avatar_Basic_Gollum_HOB" -
  // likely a cosmetic avatar id, not DraftCompleted's courseId GUID) - see
  // the comment on MatchFound in types.ts. Practical effect: multiple runs
  // *within* the same live window are correctly lumped into one "by event"
  // bucket here (fine - "by deck" shows whichever deck was submitted most
  // recently for that event name). A later, separately-dated run of the
  // *same event type* (e.g. HOB QuickDraft coming back after rotating out)
  // gets its own bucket here instead, by design - see the "by event type"
  // section right below for the aggregate across those.
  const byEvent = rollupByEvent(matchOutcomes);

  console.log("\n=== Win rate by event run / deck ===");
  if (byEvent.size === 0) {
    console.log("(no matches captured yet)");
  }
  for (const [eventId, outcomes] of byEvent) {
    const deck = decks.find((d) => d.eventName === eventId);
    const label = deck ? `${eventId} - "${deck.deckName}"` : eventId;
    const { wins, losses, total, pct } = winRate(outcomes);
    console.log(`  - ${label}: ${wins}-${losses}` + (total > 0 ? ` (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : " (no decided matches yet)"));
  }

  // Same win/loss data, grouped instead by *event type* (see
  // eventIdentity.ts) - so a repeated event (same format/set, later date)
  // adds to the same overall record instead of starting a fresh one every
  // time it comes back around.
  const byDefinition = rollupByEventDefinition(matchOutcomes);

  console.log("\n=== Win rate by event type (across all runs) ===");
  if (byDefinition.size === 0) {
    console.log("(no matches captured yet)");
  }
  for (const [, { identity, outcomes, runIds }] of byDefinition) {
    const { wins, losses, total, pct } = winRate(outcomes);
    const runNote = runIds.length > 1 ? ` (${runIds.length} runs)` : "";
    console.log(
      `  - [${identity.format}] ${identity.definitionLabel}${runNote}: ${wins}-${losses}` +
        (total > 0 ? ` (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : " (no decided matches yet)"),
    );
  }

  store.close();
}

main();
