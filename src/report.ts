import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TypedEventStore } from "./db/sqliteStore.js";
import type { DraftPickMade } from "./domain/types.js";
import { computeMatchOutcomes, latestStandingByEvent, reconciledWinRateByRun, rollupByEvent, rollupByEventDefinition, rollupBySubtype, rollupByFormat } from "./domain/rollups.js";
import { buildEventRunHistory, listEventRuns } from "./domain/eventHistory.js";
import { loadEventHistorySource } from "./eventHistoryLoader.js";
import { deriveDeckColors } from "./domain/deckColors.js";
import { rollupByColorCombo, type RunColorInfo } from "./domain/colorRollup.js";
import { averageManaValue, type CardCurveInfo } from "./domain/manaCurve.js";
import { rollupRewardsByFormat, sumRewards, type RewardTotal } from "./domain/rewardRollup.js";
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
  // CourseStanding in types.ts / milestone 6) - used below to reconcile
  // every win-rate view (per-run, by event type/subtype/format, and by
  // color combo) the same way eventHistory.ts's buildEventRunHistory and
  // the overlay's live display already are, so no two views in this report
  // - or the deck-viewer page - can show a different number for the same
  // run. latestStandingByEvent keeps only the LATEST snapshot per event.
  const courseStandings = store.all("CourseStanding");
  const standingsByEvent = latestStandingByEvent(courseStandings);

  // One outcome record per match, computed once (via the shared rollups
  // module - also used by the overlay's live state) and reused below for
  // both the per-match printout and the win-rate rollups.
  const matchOutcomes = computeMatchOutcomes(matchFounds, matchCompletions, myScreenName);

  console.log("\n=== Matches ===");
  if (matchOutcomes.length === 0) {
    console.log("(none captured yet)");
  }
  for (const m of matchOutcomes) {
    // Milestone 18 (Bo3 readiness): only show a "(N-M)" game score when
    // there's more than one game to report - every match captured so far
    // is Bo1 (see MatchOutcome.games' doc comment in rollups.ts), where
    // it's always exactly the outcome restated as 1-0/0-1, so omitting it
    // there keeps every existing report line looking exactly as it always
    // has (this project's established "don't show an uninteresting number"
    // convention).
    const gameScore = m.games && m.games.wins + m.games.losses > 1 ? ` (${m.games.wins}-${m.games.losses})` : "";
    const label = m.outcome ? `${m.outcome} (${m.reason})${gameScore}` : "in progress / result not captured";
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
    const reconciledByRun = reconciledWinRateByRun(matchOutcomes, standingsByEvent);

    console.log("\n=== Win rate by event run / deck ===");
    if (byEvent.size === 0) {
      console.log("(no matches captured yet)");
    }
    for (const [eventId] of byEvent) {
      const deck = decks.find((d) => d.eventName === eventId);
      const label = deck ? `${eventId} - "${deck.deckName}"` : eventId;
      // Guaranteed present: reconciledByRun was built from this same byEvent grouping of matchOutcomes.
      const { wins, losses, total, pct } = reconciledByRun.get(eventId)!;
      console.log(`  - ${label}: ${wins}-${losses}` + (total > 0 ? ` (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : " (no decided matches yet)"));
    }
  }

  // Same win/loss data, grouped instead by *event type* (see
  // eventIdentity.ts) - so a repeated event (same format/set, later date)
  // adds to the same overall record instead of starting a fresh one every
  // time it comes back around. This is the "hobbit quick draft history"
  // compaction level from the user's request - one specific subtype+set.
  if (groupBy === "definition" || groupBy === "all") {
    const byDefinition = rollupByEventDefinition(matchOutcomes, standingsByEvent);

    console.log("\n=== Win rate by event type (across all runs of that exact type) ===");
    if (byDefinition.size === 0) {
      console.log("(no matches captured yet)");
    }
    for (const [, { identity, runIds, winRate: rate }] of byDefinition) {
      const { wins, losses, total, pct } = rate;
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
    const bySubtype = rollupBySubtype(matchOutcomes, standingsByEvent);

    console.log("\n=== Win rate by subtype (every set combined) ===");
    if (bySubtype.size === 0) {
      console.log("(no matches captured yet)");
    }
    for (const [subtype, { definitionKeys, winRate: rate }] of bySubtype) {
      const { wins, losses, total, pct } = rate;
      const setNote = definitionKeys.length > 1 ? ` (${definitionKeys.length} sets)` : "";
      console.log(`  - ${subtype}${setNote}: ${wins}-${losses}` + (total > 0 ? ` (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : " (no decided matches yet)"));
    }
  }

  // Most compacted: everything of one format combined (e.g. every Draft
  // event, any subtype, any set) - the user's "all events in draft history"
  // compaction level.
  if (groupBy === "format" || groupBy === "all") {
    const byFormat = rollupByFormat(matchOutcomes, standingsByEvent);

    console.log("\n=== Win rate by format (most compacted) ===");
    if (byFormat.size === 0) {
      console.log("(no matches captured yet)");
    }
    for (const [format, { definitionKeys, winRate: rate }] of byFormat) {
      const { wins, losses, total, pct } = rate;
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
    const byDefinitionForColors = rollupByEventDefinition(matchOutcomes, standingsByEvent);

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
      const byCombo = rollupByColorCombo(runInfos, standingsByEvent);
      console.log(`  ${identity.definitionLabel}:`);
      for (const [comboKey, bucket] of byCombo) {
        const { wins, losses, total, pct } = bucket.winRate;
        console.log(`    - ${comboKey}: ${wins}-${losses}` + (total > 0 ? ` (${pct} over ${total} decided match${total === 1 ? "" : "es"})` : " (no decided matches yet)"));
      }
    }
  }

  // --- Rewards (milestone 17) ---
  // "How much have I won" - see EventReward in types.ts/classifier.ts for
  // where this comes from (EventClaimPrize) and which fields are confirmed
  // vs. best-effort. Uses the raw store read here rather than
  // loadEventHistorySource's deduped version since that loader isn't
  // otherwise needed unless --event was passed - see the block below.
  {
    const rewards = dedupeBy(store.all("EventReward"), (r) => `${r.courseId}|${r.ts}`);
    const formatRewardTotal = (t: RewardTotal): string => {
      const parts: string[] = [];
      if (t.gems > 0) parts.push(`${t.gems} Gems`);
      if (t.gold > 0) parts.push(`${t.gold} Gold`);
      for (const b of t.boosters) parts.push(`${b.count}x ${b.setCode} Booster${b.count === 1 ? "" : "s"}`);
      if (t.grantedCardCount > 0) parts.push(`${t.grantedCardCount} card${t.grantedCardCount === 1 ? "" : "s"}`);
      return parts.length > 0 ? parts.join(", ") : "(none)";
    };

    console.log("\n=== Rewards ===");
    if (rewards.length === 0) {
      console.log("(no EventClaimPrize captures yet - only recorded when a claimed event's prize is actually opened)");
    } else {
      console.log(`Total won across ${rewards.length} claim${rewards.length === 1 ? "" : "s"}: ${formatRewardTotal(sumRewards(rewards))}`);
      const byFormat = rollupRewardsByFormat(rewards);
      for (const [format, total] of byFormat) {
        console.log(`  - ${format}: ${formatRewardTotal(total)} (${total.claimCount} claim${total.claimCount === 1 ? "" : "s"})`);
      }
    }
  }

  // --- Decks seen, by deck id (milestone 18 - Constructed prep) ---
  // The user's own question this milestone: is a Constructed deck
  // identified by name or by some kind of id? Answer: by id - deckId is a
  // real, client-supplied GUID (confirmed real, see DeckSubmitted's doc
  // comment in types.ts), not a server-generated per-run id, so it's
  // expected to be the SAME value every time the player submits "the same
  // saved deck" to a new event - unlike deckName, which the player can
  // freely rename without it meaning anything changed. This section groups
  // every DeckSubmitted ever captured by deckId, listing every eventId
  // (run) and every distinct deckName it's ever shown up under, so once a
  // real Constructed event is captured, this is where to check the
  // hypothesis: does the deck the player used for their last three Ranked
  // games really show up here as one deckId with three eventIds, or as
  // three separate ones? (Today's data is Draft-only, where every run gets
  // its own fresh CourseDeck/deckId by design, so this will correctly show
  // one deckId per run until a Constructed submission is captured.)
  {
    const allDecks = dedupeBy(store.all("DeckSubmitted"), (d) => `${d.deckId}|${d.ts}`);
    const byDeckId = new Map<string, { names: Set<string>; eventIds: Set<string>; formats: Set<string> }>();
    for (const d of allDecks) {
      let entry = byDeckId.get(d.deckId);
      if (!entry) {
        entry = { names: new Set(), eventIds: new Set(), formats: new Set() };
        byDeckId.set(d.deckId, entry);
      }
      entry.names.add(d.deckName);
      entry.eventIds.add(d.eventName);
      if (d.format) entry.formats.add(d.format);
    }

    console.log("\n=== Decks seen (by deck id) ===");
    if (byDeckId.size === 0) {
      console.log("(no deck submissions captured yet)");
    }
    for (const [deckId, { names, eventIds, formats }] of byDeckId) {
      const nameLabel = [...names].join(" / ");
      const formatNote = formats.size > 0 ? ` [${[...formats].join("/")}]` : "";
      console.log(`  - ${deckId}${formatNote}: "${nameLabel}" - played in ${eventIds.size} event run${eventIds.size === 1 ? "" : "s"}`);
      if (eventIds.size > 1) {
        for (const id of eventIds) console.log(`      ${id}`);
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
      // Milestone 18: history.format (resolved from the deck's own real
      // Format attribute when captured) rather than identity.format (a
      // name-based guess) - see eventHistory.ts's buildEventRunHistory.
      console.log(`Type: [${history.format}] ${history.identity.definitionLabel}`);
      // Milestone 18: the whole opened/drafted pool, when one was captured
      // (DraftCompleted for Draft, or the newer EventCardPool capture for
      // Sealed - see types.ts) - "track the whole card pool" for Sealed.
      if (history.cardPool) {
        console.log(`Card pool: ${history.cardPool.length} cards captured`);
      }
      if (history.deck) {
        const mainCount = history.deck.mainDeck.reduce((n, x) => n + x.quantity, 0);
        // Milestone 18: deckId is Arena's own persistent identifier for this
        // deck (a client-supplied GUID, confirmed real - see DeckSubmitted's
        // doc comment in types.ts) - printed here so it's easy to check,
        // once real Constructed events are captured, whether the same
        // deckId really does recur across separate runs of the same saved
        // deck (the open question this milestone's project-doc notes flag).
        console.log(`Deck: "${history.deck.deckName}" (id ${history.deck.deckId}, ${mainCount} cards)`);
        try {
          const cardStore = new CardStore(dbPath);
          const cardColors = new Map<number, string[]>();
          for (const c of cardStore.all()) cardColors.set(c.grpId, c.colors);
          cardStore.close();
          const profile = deriveDeckColors(history.deck.mainDeck, cardColors);
          // Milestone 15: name splash colors separately rather than silently
          // folding them into (or dropping them from) the main combo key -
          // see deckColors.ts's DeckColorProfile.splashColors.
          const splashNote = profile.splashColors.length > 0 ? ` (splash: ${profile.splashColors.join("")})` : "";
          console.log(`  Colors: ${profile.comboKey}${splashNote}`);
        } catch {
          // cards table not available - not fatal, just skip the colors line.
        }
        try {
          const cardStore = new CardStore(dbPath);
          const cardCurveInfo = new Map<number, CardCurveInfo>();
          for (const c of cardStore.all()) cardCurveInfo.set(c.grpId, { types: c.types, manaCost: c.manaCost });
          cardStore.close();
          const avgMv = averageManaValue(history.deck.mainDeck, cardCurveInfo);
          if (avgMv.value !== null) console.log(`  Avg. mana value: ${avgMv.value.toFixed(2)} (${avgMv.consideredCount} of ${avgMv.consideredCount + avgMv.excludedCount} cards considered)`);
        } catch {
          // cards table not available - skip, same as the colors block above.
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

      // Milestone 17: entry cost + reward, both best-effort/absent unless
      // actually captured (joining/claiming happen at specific moments -
      // see DraftJoined/EventReward in types.ts).
      console.log(`Entry: ${history.entry ? `${history.entry.amountPaid} ${history.entry.currencyType}` : "(not captured)"}`);
      if (history.reward) {
        const r = history.reward;
        const parts: string[] = [];
        if (r.gems > 0) parts.push(`${r.gems} Gems`);
        if (r.gold > 0) parts.push(`${r.gold} Gold`);
        for (const b of r.boosters) parts.push(`${b.count}x ${b.setCode} Booster${b.count === 1 ? "" : "s"}`);
        if (r.grantedCardCount > 0) parts.push(`${r.grantedCardCount} card${r.grantedCardCount === 1 ? "" : "s"}`);
        console.log(`Reward: ${parts.length > 0 ? parts.join(", ") : "(none)"}`);
      } else {
        console.log("Reward: (not captured - only recorded when the prize is actually claimed)");
      }

      // Milestone 17: every played deck version - see deckVersions.ts. Most
      // runs will just show one, unplayed (see deriveDeckVersions).
      if (history.deckVersions.length > 0) {
        console.log(`Deck versions played: ${history.deckVersions.length}`);
        for (const v of history.deckVersions) {
          const { wins, losses, total, pct } = v.winRate;
          console.log(`  - Version ${v.versionNumber} (submitted ${v.submittedAt}): ${wins}-${losses}${total > 0 ? ` (${pct})` : ""}`);
        }
      }
    }
  }

  store.close();
}

main();
