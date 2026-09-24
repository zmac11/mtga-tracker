// Unit tests for the parts of scryfallEnrich.ts that don't require live
// network access: resolveDownloadUri() (the exact logic that was wrong when
// the user hit "Failed to parse URL from undefined" on 2026-09-24 - Scryfall
// had stopped populating `download_uri` for default_cards in favor of
// `jsonl_download_uri`) and scanCachedFile() (the gzip + JSON Lines parser
// that replaced the old plain-JSON-array streaming parser). The network call
// itself (fetchDefaultCardsBulkMeta/downloadToFile) still can't be tested
// from here - see the file-level comment in scryfallEnrich.ts - so this is
// the next best thing: prove the parsing/selection logic is correct against
// data shaped exactly like Scryfall's real response, and let
// `npm run refresh-cards` from a real terminal be the final check.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { resolveDownloadUri, scanCachedFile } from "./scryfallEnrich.js";

async function run() {
  // --- resolveDownloadUri ---

  // The current, real shape: only jsonl_download_uri is populated.
  assert.equal(
    resolveDownloadUri({ type: "default_cards", jsonl_download_uri: "https://data.scryfall.io/x.jsonl.gz", updated_at: "now", size: 1 }),
    "https://data.scryfall.io/x.jsonl.gz",
  );

  // jsonl_download_uri wins even if a legacy download_uri is somehow also present.
  assert.equal(
    resolveDownloadUri({
      type: "default_cards",
      download_uri: "https://data.scryfall.io/legacy.json",
      jsonl_download_uri: "https://data.scryfall.io/x.jsonl.gz",
      updated_at: "now",
      size: 1,
    }),
    "https://data.scryfall.io/x.jsonl.gz",
  );

  // The exact real-world shape that broke on 2026-09-24: no jsonl_download_uri,
  // no download_uri either - must throw a clear error, never silently produce
  // `undefined` for something that gets handed to fetch().
  assert.throws(
    () => resolveDownloadUri({ type: "default_cards", updated_at: "now", size: 1 }),
    /no jsonl_download_uri/,
  );

  // download_uri alone (legacy-only) must also throw, not "fall back" to a
  // file shape scanCachedFile can't parse - see resolveDownloadUri's own
  // comment for why that would just trade one confusing crash for another.
  assert.throws(
    () => resolveDownloadUri({ type: "default_cards", download_uri: "https://data.scryfall.io/legacy.json", updated_at: "now", size: 1 }),
    /no jsonl_download_uri.*legacy download_uri/,
  );

  console.log("OK: resolveDownloadUri prefers jsonl_download_uri and fails clearly when it's missing.");

  // --- scanCachedFile ---

  const dir = mkdtempSync(join(tmpdir(), "scryfall-enrich-test-"));
  try {
    // Realistic file: one card per line, trailing newline, a card missing
    // `id` (should be skipped, not crash - isScryfallCard's job), and a
    // blank line in the middle (JSON Lines readers should tolerate this).
    const lines = [
      JSON.stringify({ id: "a1", arena_id: 100, name: "Mountain" }),
      "",
      JSON.stringify({ id: "a2", arena_id: 200, name: "Island", oracle_text: "Contains a { brace }." }),
      JSON.stringify({ name: "No id field - not a real card object, should be skipped" }),
    ];
    const rawPath = join(dir, "default-cards.jsonl.gz");
    writeFileSync(rawPath, gzipSync(lines.join("\n") + "\n"));

    const seen: unknown[] = [];
    await scanCachedFile(rawPath, (c) => seen.push(c));
    assert.deepEqual(seen, [
      { id: "a1", arena_id: 100, name: "Mountain" },
      { id: "a2", arena_id: 200, name: "Island", oracle_text: "Contains a { brace }." },
    ]);

    console.log("OK: scanCachedFile reads gzip-compressed JSON Lines, skipping blank lines and non-card objects.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

run();
