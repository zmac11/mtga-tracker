import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import type { ArenaCard, EnrichedCard } from "./types.js";

/**
 * Enriches ArenaCard[] with Scryfall data - oracle text, mana cost, colors,
 * and (the main point of this whole module) image URLs - joined on
 * Scryfall's `arena_id` field, which is numerically identical to Arena's
 * own `grpId` (confirmed via Scryfall's own docs and cross-checked against
 * real captured grpIds during this project's research phase).
 *
 * IMPORTANT - this file could not be run against the real Scryfall API
 * during initial development: both the cloud sandbox and the device-bridge
 * shell used to build this project are blocked from reaching
 * api.scryfall.com and scryfall.io by network policy (confirmed via curl -
 * both returned a 403 from the proxy). A real run from the user's own
 * terminal on 2026-09-24 surfaced the first (and so far only) bug this
 * untested path actually had: Scryfall stopped populating the bulk-data
 * `download_uri` field for `default_cards` (confirmed via Scryfall's own
 * blog, "Two New Ways to Sync Scryfall Data", and cross-checked against
 * other open-source Scryfall clients that hit the same break the same
 * week) in favor of `jsonl_download_uri` - a gzip-compressed JSON Lines
 * file (one card object per line) rather than the old single giant JSON
 * array. That's also a genuine improvement, not just a rename: Node's
 * `JSON.parse` has a string-length ceiling that the old uncompressed
 * `default_cards` array was creeping up on anyway, and line-by-line
 * parsing sidesteps that entirely. This file now downloads and parses that
 * format (see downloadToFile/scanCachedFile below); the plain-JSON-array
 * streaming parser this used to depend on (jsonArrayStream.ts) is no
 * longer used here but is left in place since it's independently tested
 * and may still be handy for other Scryfall endpoints later.
 * This file follows Scryfall's documented bulk-data API and card object
 * shape (https://scryfall.com/docs/api/bulk-data,
 * https://scryfall.com/docs/api/cards) as closely as possible, but Scryfall
 * has already changed this once without much notice, so a fresh
 * `npm run refresh-cards` from your own terminal is still the real test
 * after any change here.
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
  /**
   * Legacy field: as of 2026-09-19 Scryfall stopped populating this for
   * default_cards (it's absent/undefined on the real response, which is
   * what produced the "Failed to parse URL from undefined" bug this
   * comment is next to). Kept optional here defensively in case Scryfall
   * ever repopulates it, but jsonl_download_uri below is what's actually
   * used now.
   */
  download_uri?: string;
  /** Current field: a gzip-compressed JSON Lines (.jsonl.gz) file, one card object per line. */
  jsonl_download_uri?: string;
  updated_at: string;
  size: number;
}

/**
 * Picks the field Scryfall actually populates today. Deliberately doesn't
 * fall back to the legacy `download_uri` even when present - that would
 * point at a plain (uncompressed) JSON array, and everything downstream of
 * this (downloadToFile/scanCachedFile) now assumes gzip-compressed JSON
 * Lines. Silently "falling back" to a differently-shaped file would just
 * trade this bug for a more confusing gunzip/parse crash later. Better to
 * fail clearly here if Scryfall's shape has moved again.
 */
export function resolveDownloadUri(entry: BulkDataEntry): string {
  if (entry.jsonl_download_uri) return entry.jsonl_download_uri;
  throw new Error(
    "Scryfall's default_cards bulk-data entry has no jsonl_download_uri" +
      (entry.download_uri ? " (only the legacy download_uri, which is no longer usable here)" : "") +
      " - their API shape has changed again and this needs another look.",
  );
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
  scryfallColors: string[] | null;
  images: ScryfallImageUris | null;
} {
  if (card.oracle_text !== undefined || card.image_uris !== undefined) {
    return {
      oracleText: card.oracle_text ?? null,
      manaCost: card.mana_cost ?? null,
      scryfallColors: card.colors ?? null,
      images: card.image_uris ?? null,
    };
  }
  const front = card.card_faces?.[0];
  if (!front) {
    return { oracleText: null, manaCost: null, scryfallColors: null, images: null };
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
    scryfallColors: front.colors ?? null,
    images: front.image_uris ?? null,
  };
}

function cachePaths(dataDir: string) {
  const dir = join(dataDir, "cards-cache");
  return {
    dir,
    // .jsonl.gz, not .json - see the file-level comment above: Scryfall
    // switched default_cards from a plain JSON array to gzip-compressed
    // JSON Lines on 2026-09-19. Naming it accurately means a leftover
    // default-cards.json from before this fix is just silently ignored
    // (isCacheFresh() below checks this exact path) rather than mistakenly
    // treated as a valid cache in the new format.
    rawPath: join(dir, "default-cards.jsonl.gz"),
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
 * Downloads the gzip-compressed JSON Lines file straight to disk, unparsed.
 * Kept separate from scanning (below) so a fresh download and a cache hit
 * share exactly one parsing code path - the file on disk is always "the
 * cache", whether it was just written or is from an earlier run.
 */
async function downloadToFile(downloadUri: string, rawPath: string): Promise<void> {
  const res = await fetch(downloadUri, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Scryfall bulk-data download failed: HTTP ${res.status} ${res.statusText}`);
  }
  const nodeBody = Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>);
  await pipeline(nodeBody, createWriteStream(rawPath));
}

/**
 * Streams cards out of a downloaded default_cards file - a gzip-compressed
 * JSON Lines file (one full card object per line, no enclosing `[...]` or
 * trailing commas). Works identically whether `rawPath` was just written by
 * downloadToFile() this run or is left over from an earlier one; either
 * way peak memory stays proportional to the number of *matched* cards, not
 * the size of Scryfall's entire catalog (hundreds of thousands of
 * printings, most of which aren't on Arena at all).
 */
export async function scanCachedFile(rawPath: string, onCard: (c: ScryfallCard) => void): Promise<void> {
  const gunzipped = createReadStream(rawPath).pipe(createGunzip());
  const lines = createInterface({ input: gunzipped, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // JSON Lines files commonly end with a trailing newline.
    const obj = JSON.parse(trimmed);
    if (isScryfallCard(obj)) onCard(obj);
  }
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
    const downloadUri = resolveDownloadUri(bulkMeta);
    await downloadToFile(downloadUri, rawPath);
    await scanCachedFile(rawPath, onCard);
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
      return { ...arenaCard, scryfallId: null, oracleText: null, manaCost: null, scryfallColors: null, scryfallRarity: null, imageSmall: null, imageNormal: null, imageLarge: null, imagePng: null, enrichedAt: null };
    }
    const fields = extractCardFields(scryfallCard);
    return {
      ...arenaCard,
      scryfallId: scryfallCard.id,
      oracleText: fields.oracleText,
      manaCost: fields.manaCost,
      scryfallColors: fields.scryfallColors,
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
