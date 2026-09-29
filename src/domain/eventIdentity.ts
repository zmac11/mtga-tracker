/**
 * Arena's InternalEventName (used everywhere in this project as
 * eventId/eventName - MatchFound.eventId, DeckSubmitted.eventName,
 * DraftCompleted.eventName, CourseStanding.eventId) identifies one *live
 * window* of an event, not the event type forever: when the same event
 * comes back later (e.g. HOB QuickDraft returns after rotating out of the
 * current rotation), Arena mints a new name with a new date stamp.
 * Confirmed real shapes so far: "QuickDraft_HOB_20260915",
 * "ContenderDraft_HOB_20260824" - both `<Subtype>_<SetCode>_<YYYYMMDD>`.
 * Multiple runs *within* the same live window already correctly share one
 * eventId (nothing new needed there) - this module exists so a later
 * window of the *same* event type isn't treated as a brand new, unrelated
 * event with no shared history, per the user's 2026-09-24 request.
 *
 * Every individual dated eventId still stays its own "event run" for
 * per-run history (its own deck, draft, and match list - see the planned
 * per-run history layer) - this only adds a second, coarser grouping key
 * on top, for "how have I done at HOB QuickDraft overall, across every
 * time it's run" style aggregates. See rollups.ts's rollupByEventDefinition.
 *
 * Never throws and never assumes the dated pattern holds - Wizards can
 * rename/reshape this at any time (and formats we haven't seen live yet,
 * like Sealed, are unconfirmed guesses at this pattern rather than
 * observed data). An unrecognized name just falls back to being its own
 * ungrouped bucket, identical to today's plain per-eventId behavior.
 */

export type EventFormat = "Draft" | "Sealed" | "Constructed" | "Other";

export interface EventIdentity {
  /** The raw InternalEventName, unchanged - today's eventId/eventName everywhere else in this project. */
  raw: string;
  format: EventFormat;
  /** e.g. "QuickDraft", "ContenderDraft" - whatever precedes the set code in a dated name, or the whole raw name if unparseable. */
  subtype: string;
  /** e.g. "HOB" - null if the name didn't match the dated `<Subtype>_<SetCode>_<YYYYMMDD>` pattern. */
  setCode: string | null;
  /** e.g. "20260915" - null if the name didn't match the dated pattern. */
  dateStamp: string | null;
  /**
   * Grouping key for "this event type across every time it's been run" -
   * `${subtype}_${setCode}` when the dated pattern matched, otherwise the
   * raw name itself (so an unrecognized shape stays its own bucket rather
   * than being incorrectly merged with anything else).
   */
  definitionKey: string;
  /** Human-readable label for definitionKey, e.g. "QuickDraft - HOB". */
  definitionLabel: string;
}

const DATED_EVENT_PATTERN = /^([A-Za-z]+)_([A-Za-z0-9]+)_(\d{8})$/;

function classifyFormat(subtypeOrRaw: string): EventFormat {
  const s = subtypeOrRaw.toLowerCase();
  if (s.includes("draft")) return "Draft";
  if (s.includes("sealed")) return "Sealed";
  if (s.includes("play") || s.includes("ladder") || s.includes("constructed")) return "Constructed";
  return "Other";
}

export function parseEventIdentity(rawEventName: string): EventIdentity {
  const match = DATED_EVENT_PATTERN.exec(rawEventName);
  if (match) {
    const [, subtype, setCode, dateStamp] = match;
    return {
      raw: rawEventName,
      format: classifyFormat(subtype),
      subtype,
      setCode,
      dateStamp,
      definitionKey: `${subtype}_${setCode}`,
      definitionLabel: `${subtype} - ${setCode}`,
    };
  }
  return {
    raw: rawEventName,
    format: classifyFormat(rawEventName),
    subtype: rawEventName,
    setCode: null,
    dateStamp: null,
    definitionKey: rawEventName,
    definitionLabel: rawEventName,
  };
}

/**
 * Milestone 18: a more reliable format signal than parseEventIdentity's own
 * `format` (which only ever guesses from the event NAME's text) - prefers
 * the deck's own real, Arena-supplied Format attribute (DeckSubmitted.format
 * - confirmed real for "Draft", see its doc comment in types.ts) when one
 * was captured, falling back to the name-based guess otherwise (a run with
 * no DeckSubmitted at all has nothing else to go on). Kept as a separate
 * function rather than folded into parseEventIdentity itself, since
 * parseEventIdentity only ever takes a bare eventId string (no deck lookup)
 * and is also what every coarser rollup (rollupByFormat/rollupByEventDefinition
 * in rollups.ts) groups by - changing what THOSE buckets mean would need
 * deck data threaded through every one of them, a larger change than this
 * milestone's ask (deck/version tracking + Sealed pool capture + Bo3
 * readiness) covers. This is used specifically where a single run's own
 * format is shown to the user (report.ts's `--event=` detail, the deck
 * viewer) - see eventHistory.ts's buildEventRunHistory.
 *
 * `deckFormat` values seen so far: only "Draft" (real). The mapping below
 * is a reasoned best-effort covering Arena's known non-limited format names
 * (Standard/Historic/Explorer/Alchemy/Timeless/Pioneer/Brawl and their
 * Ranked-prefixed variants) - none of these specific strings have actually
 * been observed in a real capture yet, only "Draft" and (by the existing
 * name-based classifyFormat) event names that mention "sealed".
 */
export function resolveEventFormat(identity: EventIdentity, deckFormat: string | null | undefined): EventFormat {
  if (!deckFormat) return identity.format;
  const f = deckFormat.toLowerCase();
  if (f.includes("draft")) return "Draft";
  if (f.includes("sealed")) return "Sealed";
  if (f === "constructed") return "Constructed";
  // Known non-limited Arena format names all mean "Constructed" here (this
  // project doesn't currently distinguish Standard from Historic from Brawl
  // etc. - see the project doc's open items) - anything that isn't
  // recognizably Draft/Sealed and isn't blank falls into this bucket,
  // rather than "Other", since a real Format attribute (as opposed to a
  // name-based guess) having a value at all means Arena itself considers
  // this a real deck for a real format.
  return "Constructed";
}
