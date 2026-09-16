import { EventEmitter } from "node:events";

/**
 * A single JSON payload extracted from the log, plus whatever context we
 * could recover about it.
 *
 * IMPORTANT: this is deliberately a *generic* extractor, not a typed MTGA
 * event parser. We don't yet have a confirmed, current mapping of MTGA's
 * internal JSON shapes (method names, GRE message types, draft event
 * fields) - Wizards has changed these multiple times over the years and we
 * don't want to ship confidently-wrong field guesses. Instead, milestone 1
 * captures every JSON block MTGA writes, with enough surrounding context
 * (direction, method name, timestamp) to classify it by hand from a real
 * log. Milestone 2 turns the patterns we actually observe into typed
 * domain events (MatchStart, DraftPick, DeckSubmitted, ...).
 */
export interface RawBlock {
  /** Best-effort request/response direction, from a "==>"/"<==" marker. */
  direction: "request" | "response" | "unknown";
  /** Text between the previous block and this one (trimmed). */
  header: string;
  /** Best-effort method/event name pulled from the header, if any. */
  methodGuess: string | null;
  /** Best-effort timestamp string pulled from the header, if any. */
  timestampGuess: string | null;
  /** Parsed JSON value. */
  json: unknown;
  /** Raw JSON text exactly as it appeared in the log. */
  raw: string;
}

const TIMESTAMP_RE = /\d{1,2}\/\d{1,2}\/\d{4}[^\n]{0,20}(?:AM|PM)?/;
const METHOD_RE = /(?:==>|<==)\s*([A-Za-z0-9_.]+)/;

type ScanState = "normal" | "inString" | "escapedInString";

/**
 * Streaming extractor: feed it raw text chunks as they arrive from the log
 * tailer, and it emits one "block" event per top-level JSON value found, in
 * order. Keeps only the unconsumed tail of the log in memory.
 */
export class LogParser extends EventEmitter {
  private buffer = "";
  /** Index in `buffer` up to which we've already emitted blocks / header text. */
  private consumedUpTo = 0;
  private static readonly MAX_BUFFER = 8 * 1024 * 1024; // 8MB safety cap

  feed(chunk: string): void {
    this.buffer += chunk;
    this.scan();
    this.trimBuffer();
  }

  private scan(): void {
    const buf = this.buffer;
    let i = this.consumedUpTo;
    let headerFrom = this.consumedUpTo;
    let state: ScanState = "normal";
    let depth = 0;
    let blockStart = -1;

    while (i < buf.length) {
      const c = buf[i];

      if (state === "inString") {
        if (c === "\\") {
          state = "escapedInString";
        } else if (c === '"') {
          state = "normal";
        }
        i++;
        continue;
      }
      if (state === "escapedInString") {
        state = "inString";
        i++;
        continue;
      }

      // state === "normal"
      if (c === '"') {
        state = "inString";
        i++;
        continue;
      }
      if (c === "{" || c === "[") {
        if (depth === 0) {
          blockStart = i;
        }
        depth++;
        i++;
        continue;
      }
      if (c === "}" || c === "]") {
        if (depth > 0) {
          depth--;
          if (depth === 0 && blockStart !== -1) {
            const end = i + 1; // exclusive
            this.tryEmitBlock(buf, headerFrom, blockStart, end);
            headerFrom = end;
            this.consumedUpTo = end;
            blockStart = -1;
          }
        }
        i++;
        continue;
      }
      i++;
    }
    // Any in-progress (unterminated) JSON value, or trailing plain text,
    // stays in the buffer (from consumedUpTo onward) for the next feed().
  }

  private tryEmitBlock(buf: string, headerStart: number, jsonStart: number, jsonEnd: number): void {
    const raw = buf.slice(jsonStart, jsonEnd);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // Braces/brackets that balanced but weren't actually valid JSON
      // (e.g. coincidental punctuation in free-text log lines). Skip it.
      return;
    }

    const header = buf.slice(headerStart, jsonStart);
    const methodMatch = header.match(METHOD_RE);
    const timestampMatch = header.match(TIMESTAMP_RE);
    const direction: RawBlock["direction"] = header.includes("==>")
      ? "request"
      : header.includes("<==")
        ? "response"
        : "unknown";

    const block: RawBlock = {
      direction,
      header: header.trim(),
      methodGuess: methodMatch ? methodMatch[1] : null,
      timestampGuess: timestampMatch ? timestampMatch[0].trim() : null,
      json,
      raw,
    };
    this.emit("block", block);
  }

  /** Drop everything already consumed so memory stays bounded over a long session. */
  private trimBuffer(): void {
    if (this.consumedUpTo > 0) {
      this.buffer = this.buffer.slice(this.consumedUpTo);
      this.consumedUpTo = 0;
    }
    if (this.buffer.length > LogParser.MAX_BUFFER) {
      // Pathological case: a huge amount of text with no closing bracket
      // (shouldn't happen in practice). Drop the oldest part as a safety
      // valve so we don't leak memory; we lose whatever was mid-flight.
      this.buffer = this.buffer.slice(this.buffer.length - 64 * 1024);
    }
  }
}

export interface LogParser {
  on(event: "block", listener: (block: RawBlock) => void): this;
  emit(event: "block", block: RawBlock): boolean;
}
