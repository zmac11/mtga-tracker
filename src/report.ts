import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TypedEventStore } from "./db/sqliteStore.js";
import type { DraftPickMade } from "./domain/types.js";
import { computeMatchOutcomes, reconcileWinRate, rollupByEvent, rollupByEventDefinition, rollupBySubtype, rollupByFormat, winRate } from "./domain/rollups.js";
import { buildEventRunHistory, listEventRuns } from "./domain/eventHistory.js";
import { loadEventHistorySource } from "./eventHistoryLoader.js";
import { deriveDeckColors } from "./domain/deckColors.js";
import { rollupByColorCombo, type RunColorInfo } from "./domain/colorRollup.js";
import { CardStore } from "./cards/cardStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type GroupByLevel = "run" | "definition" | "subtype" | "format" | "all";

/**
 * `--group-by=<level>` lets the user "compact" the win-rate view to whichever
 * granularity they want to see - e.g. `--group-by=format` for "all my draft
 * history combined", `--group-by=subtype` for "all QuickDraft, any set"
 * (the user's "specific quick draft history" example), or the default `all`
 * to just print every level (from most compacted down to per-run) since this
 * is a quick CLI readout, not a UI with tabs - showing everything is cheap
 * and the user can skim to whichever section they care about. `definition`
 * (e.g. "QuickDraft - HOB" specifically, the user's "hobbit quick draft
 * history" example) already existed before this flag; this just makes it
 * one of several selectable levels instead of the only non-per-run option.
 */
function parseArgs(argv: string[]): { groupBy: GroupByLevel; eventId: string | null } {
  let groupBy: GroupByLevel = "all";
  let eventId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--group-by=")) {
      const value = arg.slice("--group-by=".length);
      if (value === "run" || value === "definition" || value === "subtype" || value === "format" || value === "all") {
        groupBy = value;
      } else {
        console.error(`Unknown --group-by value "${value}" - expected one of: run, definition, subtype, format, all. Falling back to "all".`);
      }
    } else if (arg.startsWith("--event=")) {
      eventId = arg.slice("--event=".length);
    }
  }
  return { groupBy, eventId };
}

/**
 * Prints a quick human-readable summary from data/tracker.db. Not the
 * overlay, not a dashboard - just a sanity-check readout proving the typed
 * events add up to something useful (deck used, draft picks, win/loss).
 */
function main() {
  const { groupBy, eventId } = parseArgs(process.argv.slice(2));
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
  // Milestone 12: Arena's own authoritative per-event record (see
  // CourseStanding in types.ts / milestone 6) - used below to reconcile the
  // "by event run" win-rate table the same way eventHistory.ts's
  // buildEventRunHistory and the overlay's live display already are, so
  // --event=<id> and the deck-viewer page can't show a different number
  // than this table for the same run.
  const courseStandings = store.all("CourseStanding");

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
  if (groupBy === "run" || groupBy === "all") {
    const byEvent = rollupByEvent(matchOutcomes);

    console.log("\n=== Win rate by event run / deck ===");
    if (byEvent.size === 0) {
      console.log("(no matches captured yet)");
    }
    for (const [eventId, outcomes] of byEvent) {
      const deck = decks.find((d) => d.eventName === eventId);
      const label = deck ? `${eventId} - "${deck.deckName}"` : eventId;
      const standing = [...courseStandings].reverse().find((s) => s.eventId === eventId) ?? null;
      const { wins, losses, total, pct } = reconcileWinRate(winRate(outcomes), standing);
      console.log(`  - ${label}: ${wins}-${losses}` + (total > 0 ? ` (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : " (no decided matches yet)"));
    }
  }

  // Same win/loss data, grouped instead by *event type* (see
  // eventIdentity.ts) - so a repeated event (same format/set, later date)
  // adds to the same overall record instead of starting a fresh one every
  // time it comes back around. This is the "hobbit quick draft history"
  // compaction level from the user's request - one specific subtype+set.
  if (groupBy === "definition" || groupBy === "all") {
    const byDefinition = rollupByEventDefinition(matchOutcomes);

    console.log("\n=== Win rate by event type (across all runs of that exact type) ===");
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
  }

  // Coarser still: every set combined for a given subtype (e.g. "QuickDraft"
  // regardless of which set) - the user's "specific quick draft history"
  // compaction level.
  if (groupBy === "subtype" || groupBy === "all") {
    const bySubtype = rollupBySubtype(matchOutcomes);

    console.log("\n=== Win rate by subtype (every set combined) ===");
    if (bySubtype.size === 0) {
      console.log("(no matches captured yet)");
    }
    for (const [subtype, { outcomes, definitionKeys }] of bySubtype) {
      const { wins, losses, total, pct } = winRate(outcomes);
      const setNote = definitionKeys.length > 1 ? ` (${definitionKeys.length} sets)` : "";
      console.log(`  - ${subtype}${setNote}: ${wins}-${losses}` + (total > 0 ? ` (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : " (no decided matches yet)"));
    }
  }

  // Most compacted: everything of one format combined (e.g. every Draft
  // event, any subtype, any set) - the user's "all events in draft history"
  // compaction level.
  if (groupBy === "format" || groupBy === "all") {
    const byFormat = rollupByFormat(matchOutcomes);

    console.log("\n=== Win rate by format (most compacted) ===");
    if (byFormat.size === 0) {
      console.log("(no matches captured yet)");
    }
    for (const [format, { outcomes, definitionKeys }] of byFormat) {
      const { wins, losses, total, pct } = winRate(outcomes);
      console.log(
        `  - ${format} (${definitionKeys.length} event type${definitionKeys.length === 1 ? "" : "s"}): ${wins}-${losses}` +
          (total > 0 ? ` (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : " (no decided matches yet)"),
      );
    }
  }

  // --- Win rate by color combination (milestone 7 phase 3) ---
  // For every event *type* (rollupByEventDefinition - not per-run, so a
  // repeated event's separate runs still combine), buckets each of its runs
  // by the color combination of the deck submitted for that run, derived
  // from Arena's own decoded card colors (see cards/extractArenaCards.ts and
  // domain/deckColors.ts) - "how do I do on UR vs WB in HOB QuickDraft".
  // Needs the `cards` table (from `npm run refresh-cards`) to know any
  // card's colors; a run whose deck's cards aren't found there just shows as
  // "(no deck captured)" rather than being skipped or crashing the report.
  {
    const cardColors = new Map<number, string[]>();
    try {
      const cardStore = new CardStore(dbPath);
      for (const c of cardStore.all()) cardColors.set(c.grpId, c.colors);
      cardStore.close();
    } catch (err) {
      console.error("\n(Could not load card colors from the cards table - run `npm run refresh-cards` first. Color-combination win rates will show as unknown.)");
      console.error(`  ${err instanceof Error ? err.message : err}`);
    }

    const byEventRun = rollupByEvent(matchOutcomes);
    const byDefinitionForColors = rollupByEventDefinition(matchOutcomes);

    console.log("\n=== Win rate by color combination (within each event type) ===");
    if (byDefinitionForColors.size === 0) {
      console.log("(no matches captured yet)");
    }
    for (const [, { identity, runIds }] of byDefinitionForColors) {
      const runInfos: RunColorInfo[] = runIds.map((runId) => {
        const deck = decks.find((d) => d.eventName === runId);
        const comboKey = deck ? deriveDeckColors(deck.mainDeck, cardColors).comboKey : "(no deck captured)";
        return { eventId: runId, comboKey, outcomes: byEventRun.get(runId) ?? [] };
      });
      const byCombo = rollupByColorCombo(runInfos);
      console.log(`  ${identity.definitionLabel}:`);
      for (const [comboKey, bucket] of byCombo) {
        const { wins, losses, total, pct } = bucket.winRate;
        console.log(`    - ${comboKey}: ${wins}-${losses}` + (total > 0 ? ` (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : " (no decided matches yet)"));
      }
    }
  }

  // --- Per-run event history (milestone 7 phase 2) ---
  // `--event=<eventId>` prints one specific run's full history (deck,
  // sideboard, draft pick sequence, matches) - the same data the planned
  // deck-viewer/draft-history UI will read, surfaced here first so it can be
  // validated against real data before any UI is built on top of it.
  if (eventId) {
    const source = loadEventHistorySource(store);
    const knownRuns = listEventRuns(source);
    if (!knownRuns.some((r) => r.eventId === eventId)) {
      console.log(`\n=== Event history: ${eventId} ===`);
      console.log("(no data captured for this exact eventId - known event runs:)");
      for (const r of knownRuns) console.log(`  - ${r.eventId}`);
    } else {
      const history = buildEventRunHistory(eventId, source);
      console.log(`\n=== Event history: ${eventId} ===`);
      console.log(`Type: [${history.identity.format}] ${history.identity.definitionLabel}`);
      if (history.deck) {
        const mainCount = history.deck.mainDeck.reduce((n, x) => n + x.quantity, 0);
        console.log(`Deck: "${history.deck.deckName}" (${mainCount} cards)`);
        try {
          const cardStore = new CardStore(dbPath);
          const cardColors = new Map<number, string[]>();
          for (const c of cardStore.all()) cardColors.set(c.grpId, c.colors);
          cardStore.close();
          const profile = deriveDeckColors(history.deck.mainDeck, cardColors);
          console.log(`  Colors: ${profile.comboKey}`);
        } catch {
          // cards table not available - not fatal, just skip the colors line.
        }
        console.log(`  Maindeck: ${history.deck.mainDeck.map((c) => `${c.quantity}x ${c.cardId}`).join(", ")}`);
        if (history.deck.sideboard) {
          const sideCount = history.deck.sideboard.reduce((n, x) => n + x.quantity, 0);
          console.log(`  Sideboard (${sideCount} cards): ${history.deck.sideboard.map((c) => `${c.quantity}x ${c.cardId}`).join(", ") || "(none)"}`);
        } else {
          console.log("  Sideboard: (no DraftCompleted captured, so pool/sideboard can't be derived)");
        }
      } else {
        console.log("Deck: (no DeckSubmitted captured for this run)");
      }
      console.log(`Draft picks captured: ${history.picks.length}${history.picks.length > 0 ? ` (pack ${history.picks[0].pack} pick ${history.picks[0].pick} .. pack ${history.picks.at(-1)!.pack} pick ${history.picks.at(-1)!.pick})` : ""}`);
      console.log(`Packs seen captured: ${history.packsSeen.length}`);
      console.log(`Matches: ${history.matches.length} (${history.winRate.wins}-${history.winRate.losses}${history.winRate.total > 0 ? `, ${history.winRate.pct}` : ""})`);
    }
  }

  store.close();
}

main();
