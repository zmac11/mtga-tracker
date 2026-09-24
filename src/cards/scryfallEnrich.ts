import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { streamJsonArray, JsonArrayStreamParser } from "./jsonArrayStream.js";
import type { ArenaCard, EnrichedCard } from "./types.js";

/**
 * Enriches ArenaCard[] with Scryfall data - oracle text, mana cost, colors,
 * and (the main point of this whole module) image URLs - joined on
 * Scryfall's `arena_id` field, which is numerically identical to Arena's
 * own `grpId` (confirmed via Scryfall's own docs and cross-checked against
 * real captured grpIds during this project's research phase).
 *
 * IMPORTANT - this file could not be run against the real Scryfall API
 * during development: both the cloud sandbox and the device-bridge shell
 * used to build this project are blocked from reaching api.scryfall.com
 * and scryfall.io by network policy (confirmed via curl - both returned a
 * 403 from the proxy). Only jsonArrayStream.ts's parsing logic (fully unit
 * tested, see jsonArrayStream.test.ts) and extractArenaCards.ts (tested
 * against a real Raw_CardDatabase_*.mtga file) could be verified directly.
 * This file follows Scryfall's documented bulk-data API and card object
 * shape (https://scryfall.com/docs/api/bulk-data,
 * https://scryfall.com/docs/api/cards) as closely as possible, but it
 * needs a real end-to-end run - from a machine with normal internet access,
 * i.e. your own terminal, not through Claude - before it can be trusted.
 * `npm run refresh-cards` is the thing to try.
 *
 * Scryfall's own etiquette guidance: identify requests with a real
 * User-Agent, prefer `default_cards` over hitting individual card
 * endpoints per-card, and cache bulk data locally rather than
 * re-downloading it constantly - the cache in dataDir/cards-cache/ here is
 * kept for 20 hours before being treated as stale, which comfortably
 * clears Scryfall's "once a day" guidance while still picking up new sets
 * same-day when you actually run this.
 */

const USER_AGENT = "mtga-tracker/0.1 (personal MTG Arena companion app; https://github.com/zmac11/mtga-tracker)";
const CACHE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours

interface BulkDataEntry {
  type: string;
  download_uri: string;
  updated_at: string;
  size: number;
}

interface ScryfallCardFace {
  mana_cost?: string;
  oracle_text?: string;
  colors?: string[];
  image_uris?: ScryfallImageUris;
}

interface ScryfallImageUris {
  small?: string;
  normal?: string;
  large?: string;
  png?: string;
}

interface ScryfallCard {
  id: string;
  arena_id?: number;
  mana_cost?: string;
  oracle_text?: string;
  colors?: string[];
  rarity?: string;
  image_uris?: ScryfallImageUris;
  card_faces?: ScryfallCardFace[];
}

function isScryfallCard(obj: unknown): obj is ScryfallCard {
  return typeof obj === "object" && obj !== null && "id" in obj;
}

/**
 * Modal double-faced / transform / split cards don't carry mana_cost,
 * oracle_text, colors, or image_uris at the top level - each is nested
 * under card_faces[] instead (documented Scryfall behavior). We fall back
 * to the front face (card_faces[0]) for a single-card representation,
 * since that's what Arena's own single-grpId-per-card model expects for
 * everything except cards that need genuinely separate front/back
 * grpIds (rare, and Arena's own database - not Scryfall - is the source of
 * truth for which grpId means which face; we're just filling in whichever
 * grpId we're given with the closest available Scryfall data).
 */
function extractCardFields(card: ScryfallCard): {
  oracleText: string | null;
  manaCost: string | null;
  colors: string[] | null;
  images: ScryfallImageUris | null;
} {
  if (card.oracle_text !== undefined || card.image_uris !== undefined) {
    return {
      oracleText: card.oracle_text ?? null,
      manaCost: card.mana_cost ?? null,
      colors: card.colors ?? null,
      images: card.image_uris ?? null,
    };
  }
  const front = card.card_faces?.[0];
  if (!front) {
    return { oracleText: null, manaCost: null, colors: null, images: null };
  }
  // Combine both faces' oracle text (common convention: "front // back") -
  // useful for search/reference even though images below are front-only.
  const combinedText = (card.card_faces ?? [])
    .map((f) => f.oracle_text)
    .filter((t): t is string => Boolean(t))
    .join("\n//\n");
  return {
    oracleText: combinedText || null,
    manaCost: front.mana_cost ?? null,
    colors: front.colors ?? null,
    images: front.image_uris ?? null,
  };
}

function cachePaths(dataDir: string) {
  const dir = join(dataDir, "cards-cache");
  return {
    dir,
    rawPath: join(dir, "default-cards.json"),
    metaPath: join(dir, "default-cards.meta.json"),
  };
}

interface CacheMeta {
  scryfallUpdatedAt: string;
  fetchedAt: string;
}

function readCacheMeta(metaPath: string): CacheMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * True if we can skip hitting the network entirely and just re-parse the
 * file we already have on disk.
 */
function isCacheFresh(rawPath: string, metaPath: string): boolean {
  if (!existsSync(rawPath) || !existsSync(metaPath)) return false;
  const meta = readCacheMeta(metaPath);
  if (!meta) return false;
  const age = Date.now() - new Date(meta.fetchedAt).getTime();
  return age < CACHE_MAX_AGE_MS;
}

async function fetchDefaultCardsBulkMeta(): Promise<BulkDataEntry> {
  const res = await fetch("https://api.scryfall.com/bulk-data", {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Scryfall bulk-data listing failed: HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data: BulkDataEntry[] };
  const entry = body.data.find((d) => d.type === "default_cards");
  if (!entry) throw new Error("Scryfall bulk-data listing had no 'default_cards' entry - has their API changed?");
  return entry;
}

/**
 * Downloads default_cards to disk (for reuse as a cache) while
 * simultaneously streaming it through the JSON array parser, so peak
 * memory stays proportional to the number of *matched* cards, not the size
 * of Scryfall's entire card catalog (hundreds of thousands of printings,
 * most of which aren't on Arena at all).
 */
async function downloadAndScan(downloadUri: string, rawPath: string, onCard: (c: ScryfallCard) => void): Promise<void> {
  const res = await fetch(downloadUri, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok || !res.body) {
    throw new Error(`Scryfall bulk-data download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const fileStream = createWriteStream(rawPath);
  const decoder = new TextDecoder("utf-8");
  const parser = new JsonArrayStreamParser();
  const reader = res.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      parser.feed(decoder.decode(value, { stream: true }));
      for (const obj of parser.drain()) {
        if (isScryfallCard(obj)) onCard(obj);
      }
    }
    const tail = decoder.decode();
    if (tail) parser.feed(tail);
    for (const obj of parser.drain()) {
      if (isScryfallCard(obj)) onCard(obj);
    }
  } finally {
    await new Promise<void>((resolve, reject) => fileStream.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
}

/** Re-parses an already-downloaded cache file from disk - no network involved. */
async function scanCachedFile(rawPath: string, onCard: (c: ScryfallCard) => void): Promise<void> {
  async function* textChunks() {
    const decoder = new TextDecoder("utf-8");
    for await (const chunk of createReadStream(rawPath)) {
      yield decoder.decode(chunk as Buffer, { stream: true });
    }
  }
  await streamJsonArray(textChunks(), (obj) => {
    if (isScryfallCard(obj)) onCard(obj);
  });
}

export interface EnrichOptions {
  dataDir: string;
  /** Ignore the local cache's freshness and re-download from Scryfall regardless. */
  forceRefresh?: boolean;
}

export interface EnrichResult {
  cards: EnrichedCard[];
  matchedCount: number;
  /** True if enrichment came from a fresh Scryfall download this run, false if served from the local cache. */
  downloaded: boolean;
}

/**
 * The main entry point: takes Arena's own card list and returns it enriched
 * with whatever Scryfall data we can match. Cards with no Scryfall match
 * (shouldn't normally happen for anything real, but tokens and
 * digital-only test objects might legitimately have none) come back with
 * their enrichment fields set to null - never dropped, since the Arena-only
 * fields (name/set/collector number) are still useful on their own.
 */
export async function enrichCards(arenaCards: ArenaCard[], options: EnrichOptions): Promise<EnrichResult> {
  const { dir, rawPath, metaPath } = cachePaths(options.dataDir);
  mkdirSync(dir, { recursive: true });

  const wanted = new Map<number, ArenaCard>();
  for (const c of arenaCards) wanted.set(c.grpId, c);

  const matches = new Map<number, ScryfallCard>();
  const onCard = (card: ScryfallCard) => {
    if (card.arena_id !== undefined && wanted.has(card.arena_id)) {
      matches.set(card.arena_id, card);
    }
  };

  let downloaded = false;
  if (!options.forceRefresh && isCacheFresh(rawPath, metaPath)) {
    await scanCachedFile(rawPath, onCard);
  } else {
    const bulkMeta = await fetchDefaultCardsBulkMeta();
    await downloadAndScan(bulkMeta.download_uri, rawPath, onCard);
    writeFileSync(
      metaPath,
      JSON.stringify({ scryfallUpdatedAt: bulkMeta.updated_at, fetchedAt: new Date().toISOString() } satisfies CacheMeta),
      "utf8",
    );
    downloaded = true;
  }

  const now = new Date().toISOString();
  const cards: EnrichedCard[] = arenaCards.map((arenaCard) => {
    const scryfallCard = matches.get(arenaCard.grpId);
    if (!scryfallCard) {
      return { ...arenaCard, scryfallId: null, oracleText: null, manaCost: null, colors: null, scryfallRarity: null, imageSmall: null, imageNormal: null, imageLarge: null, imagePng: null, enrichedAt: null };
    }
    const fields = extractCardFields(scryfallCard);
    return {
      ...arenaCard,
      scryfallId: scryfallCard.id,
      oracleText: fields.oracleText,
      manaCost: fields.manaCost,
      colors: fields.colors,
      scryfallRarity: scryfallCard.rarity ?? null,
      imageSmall: fields.images?.small ?? null,
      imageNormal: fields.images?.normal ?? null,
      imageLarge: fields.images?.large ?? null,
      imagePng: fields.images?.png ?? null,
      enrichedAt: now,
    };
  });

  return { cards, matchedCount: matches.size, downloaded };
}

/** For a quick cache-freshness check from CLI output (see refreshCards.ts). */
export function describeCacheState(dataDir: string): string {
  const { rawPath, metaPath } = cachePaths(dataDir);
  if (!existsSync(rawPath)) return "no local Scryfall cache yet";
  const meta = readCacheMeta(metaPath);
  if (!meta) return `cache file present but unreadable metadata (${rawPath})`;
  const sizeMb = (statSync(rawPath).size / (1024 * 1024)).toFixed(1);
  return `cached ${sizeMb} MB, Scryfall's own updated_at=${meta.scryfallUpdatedAt}, last fetched ${meta.fetchedAt}`;
}
