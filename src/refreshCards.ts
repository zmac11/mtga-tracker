import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { locateCardDatabase } from "./cards/cardDbLocator.js";
import { extractArenaCards } from "./cards/extractArenaCards.js";
import { enrichCards, describeCacheState } from "./cards/scryfallEnrich.js";
import { CardStore } from "./cards/cardStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * CLI entry point for the card database pipeline:
 *   1. Locate Arena's own Raw_CardDatabase_*.mtga (cardDbLocator.ts)
 *   2. Extract every real card from it (extractArenaCards.ts)
 *   3. Enrich with Scryfall data - oracle text, images, true rarity
 *      (scryfallEnrich.ts) - unless --skip-enrich is passed
 *   4. Upsert the result into the `cards` table in data/tracker.db
 *      (cardStore.ts), so the overlay/UI can look up any grpId later
 *      without touching Arena's own database or Scryfall again.
 *
 * Safe to re-run any time (e.g. after a new set drops, or on a schedule) -
 * every run replaces each card's row with current data; nothing is ever
 * only-appended, so there's no drift between runs.
 *
 * Flags:
 *   --card-db-path <path>   Explicit Raw_CardDatabase_*.mtga file or
 *                            directory to search, overriding auto-detection.
 *   --skip-enrich            Only extract from Arena's database - skips the
 *                            Scryfall network step entirely. Useful for
 *                            checking the Arena-side extraction works
 *                            without needing internet access at all, and
 *                            for the very first end-to-end test of this
 *                            pipeline on a machine that hasn't been
 *                            confirmed to reach Scryfall yet.
 *   --force-refresh          Re-download Scryfall's bulk data even if the
 *                            local cache (data/cards-cache/) is still fresh
 *                            (under 20h old). Normally unnecessary.
 */
function parseArgs(argv: string[]) {
  const args = { cardDbPath: undefined as string | undefined, skipEnrich: false, forceRefresh: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--card-db-path") args.cardDbPath = argv[++i];
    else if (argv[i] === "--skip-enrich") args.skipEnrich = true;
    else if (argv[i] === "--force-refresh") args.forceRefresh = true;
  }
  return args;
}

async function main() {
  const { cardDbPath, skipEnrich, forceRefresh } = parseArgs(process.argv.slice(2));
  const dataDir = join(__dirname, "..", "data");

  const located = locateCardDatabase(cardDbPath);
  if (!located.found || !located.path) {
    console.error("Could not find Arena's card database. Checked:");
    for (const c of located.checked) console.error(`  ${c}`);
    console.error("\nIf Arena is installed somewhere else, pass its Raw/ folder (or the .mtga file itself) with --card-db-path.");
    process.exitCode = 1;
    return;
  }
  console.log(`Reading Arena card database: ${located.path}`);

  const arenaCards = extractArenaCards(located.path);
  console.log(`Extracted ${arenaCards.length} cards from Arena's own database.`);

  const store = new CardStore(join(dataDir, "tracker.db"));

  if (skipEnrich) {
    // syncArenaData only ever touches the Arena-derived columns, so
    // existing Scryfall enrichment from an earlier full run is preserved -
    // safe to run repeatedly. It's also a single transaction rather than
    // one upsert() per card, which matters at ~27,000 rows: a naive
    // per-row autocommit loop measured in the tens of seconds here, this
    // is well under a second.
    store.syncArenaData(arenaCards);
    console.log(`--skip-enrich: synced Arena-side data for ${arenaCards.length} cards.`);
    console.log(`Store now has ${store.count()} cards (${store.enrichedCount()} enriched from Scryfall).`);
    store.close();
    return;
  }

  console.log(`Scryfall cache: ${describeCacheState(dataDir)}`);
  console.log("Enriching from Scryfall (this needs internet access to api.scryfall.com/scryfall.io - if this hangs or errors, try --skip-enrich to confirm the Arena-side extraction works on its own)...");

  try {
    const { cards, matchedCount, downloaded } = await enrichCards(arenaCards, { dataDir, forceRefresh });
    store.upsertMany(cards);
    console.log(`${downloaded ? "Downloaded fresh" : "Reused cached"} Scryfall data.`);
    console.log(`Matched ${matchedCount} / ${arenaCards.length} cards to Scryfall entries.`);
    console.log(`Store now has ${store.count()} cards (${store.enrichedCount()} enriched).`);
  } catch (err) {
    console.error("Scryfall enrichment failed:", err instanceof Error ? err.message : err);
    console.error("Falling back to syncing Arena-only data (existing enrichment, if any, is preserved)...");
    store.syncArenaData(arenaCards);
    console.log(`Store now has ${store.count()} cards (${store.enrichedCount()} enriched).`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
