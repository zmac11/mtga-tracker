/**
 * Incrementally parses a top-level JSON array of objects from a stream of
 * text chunks, yielding one parsed object at a time as soon as its closing
 * brace is seen - without ever holding the whole array in memory.
 *
 * This exists specifically for Scryfall's `default_cards` bulk-data file
 * (see scryfallEnrich.ts), which is a single JSON array with one object per
 * card printing and can be very large (hundreds of MB). We only care about
 * a small fraction of its entries (the ones with a non-null `arena_id`), so
 * `JSON.parse`-ing the whole thing just to filter it would waste memory
 * proportional to the entire file rather than to what we keep. A streaming
 * parser lets the caller filter as it goes.
 *
 * This is a purpose-built splitter, not a general JSON parser: it assumes
 * (and Scryfall's bulk data guarantees) a top-level array of objects, with
 * no other top-level shape. It tracks object/array nesting depth and
 * string/escape state character by character so that braces and brackets
 * *inside* string values (e.g. card text containing "{" mana symbols, which
 * Scryfall's oracle_text does contain literally) never confuse the depth
 * count.
 */
export class JsonArrayStreamParser {
  private depth = 0;
  private inString = false;
  private escapeNext = false;
  private started = false; // seen the opening top-level '['
  private buf = "";
  private readonly ready: unknown[] = [];

  /** Feed the next chunk of raw text. Call drain() after each feed() to collect any objects completed by it. */
  feed(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      if (!this.started) {
        // Skip whitespace/BOM before the array opens; the '[' itself is
        // consumed and not part of any object buffer.
        if (ch === "[") this.started = true;
        continue;
      }

      if (this.depth === 0) {
        // Between top-level elements: skip commas/whitespace, ignore the
        // closing ']', and start buffering on the object's opening '{'.
        if (ch === "{") {
          this.depth = 1;
          this.buf = "{";
        }
        continue;
      }

      this.buf += ch;

      if (this.escapeNext) {
        this.escapeNext = false;
        continue;
      }
      if (ch === "\\" && this.inString) {
        this.escapeNext = true;
        continue;
      }
      if (ch === '"') {
        this.inString = !this.inString;
        continue;
      }
      if (this.inString) continue;

      if (ch === "{" || ch === "[") {
        this.depth++;
      } else if (ch === "}" || ch === "]") {
        this.depth--;
        if (this.depth === 0) {
          this.ready.push(JSON.parse(this.buf));
          this.buf = "";
        }
      }
    }
  }

  /** Returns and clears every object completed since the last drain() call. */
  drain(): unknown[] {
    if (this.ready.length === 0) return [];
    const out = this.ready.splice(0, this.ready.length);
    return out;
  }
}

/**
 * Convenience wrapper: reads a whole Response/stream of text chunks and
 * calls `onCard` for each parsed object as it completes, without
 * accumulating the array. `chunks` is any async iterable of strings (a
 * decoded fetch response body, or a file read stream through a text
 * decoder - see scryfallEnrich.ts for how it's wired up in practice).
 */
export async function streamJsonArray(
  chunks: AsyncIterable<string>,
  onObject: (obj: unknown) => void,
): Promise<void> {
  const parser = new JsonArrayStreamParser();
  for await (const chunk of chunks) {
    parser.feed(chunk);
    for (const obj of parser.drain()) onObject(obj);
  }
}
