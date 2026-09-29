import assert from "node:assert/strict";
import { parseEventIdentity, resolveEventFormat } from "./eventIdentity.js";

function run() {
  // Real confirmed shapes (from actual captured logs - see classifier.test.ts/report.ts).
  const quickDraft = parseEventIdentity("QuickDraft_HOB_20260915");
  assert.equal(quickDraft.format, "Draft");
  assert.equal(quickDraft.subtype, "QuickDraft");
  assert.equal(quickDraft.setCode, "HOB");
  assert.equal(quickDraft.dateStamp, "20260915");
  assert.equal(quickDraft.definitionKey, "QuickDraft_HOB");
  assert.equal(quickDraft.definitionLabel, "QuickDraft - HOB");

  const contenderDraft = parseEventIdentity("ContenderDraft_HOB_20260824");
  assert.equal(contenderDraft.format, "Draft");
  assert.equal(contenderDraft.subtype, "ContenderDraft");
  assert.equal(contenderDraft.setCode, "HOB");
  assert.equal(contenderDraft.dateStamp, "20260824");
  assert.equal(contenderDraft.definitionKey, "ContenderDraft_HOB");

  // The whole point: a later, separately-dated run of the *same* event type
  // must produce the same definitionKey as an earlier one, so they can be
  // aggregated together, while each keeps its own distinct raw eventId for
  // per-run history.
  const quickDraftAgainLater = parseEventIdentity("QuickDraft_HOB_20261020");
  assert.equal(quickDraftAgainLater.definitionKey, quickDraft.definitionKey);
  assert.notEqual(quickDraftAgainLater.raw, quickDraft.raw);

  // A different set must NOT collapse into the same bucket.
  const quickDraftDifferentSet = parseEventIdentity("QuickDraft_XYZ_20260915");
  assert.notEqual(quickDraftDifferentSet.definitionKey, quickDraft.definitionKey);

  // Sealed hasn't actually been observed live yet - this is a projected shape
  // based on the same dated-event convention, not confirmed real data. If
  // Wizards names Sealed events differently, this assertion (only, not the
  // fallback behavior below) would need updating once we see a real one.
  const sealed = parseEventIdentity("Sealed_HOB_20260915");
  assert.equal(sealed.format, "Sealed");
  assert.equal(sealed.setCode, "HOB");

  // Fallback: a real captured shape that does NOT match the dated pattern
  // (no set/date component at all) - must degrade gracefully rather than
  // throwing or misparsing, and must not be silently merged with anything
  // else (its raw name becomes its own definitionKey, unchanged from today's
  // plain per-eventId behavior).
  const historicPlay = parseEventIdentity("Historic_Play");
  assert.equal(historicPlay.format, "Constructed");
  assert.equal(historicPlay.setCode, null);
  assert.equal(historicPlay.dateStamp, null);
  assert.equal(historicPlay.definitionKey, "Historic_Play");

  // Some hypothetical totally unrecognized future shape - still must not throw.
  const unknown = parseEventIdentity("SomeBrandNewThing2027");
  assert.equal(unknown.format, "Other");
  assert.equal(unknown.definitionKey, "SomeBrandNewThing2027");

  // --- Milestone 18: resolveEventFormat prefers the deck's own real Format
  // attribute over the name-based guess. ---

  // No deck captured at all (or no Format on it) -> falls back to the
  // name-based guess, unchanged from today's behavior.
  assert.equal(resolveEventFormat(historicPlay, null), "Constructed");
  assert.equal(resolveEventFormat(historicPlay, undefined), "Constructed");

  // A real captured value ("Draft" - the only one actually observed so far)
  // maps correctly even for a name that wouldn't have guessed it.
  assert.equal(resolveEventFormat(historicPlay, "Draft"), "Draft");

  // A real deck's Format saying "Sealed" wins over an event name that
  // doesn't even look like a dated event at all.
  assert.equal(resolveEventFormat(historicPlay, "Sealed"), "Sealed");

  // Best-effort: a non-limited format name (never actually observed, but a
  // reasonable Arena format name) maps to Constructed rather than Other -
  // see resolveEventFormat's doc comment on why an unrecognized-but-present
  // Format value still means "Constructed", not "unknown".
  assert.equal(resolveEventFormat(quickDraft, "Standard"), "Constructed");
  assert.equal(resolveEventFormat(quickDraft, "Historic"), "Constructed");
  assert.equal(resolveEventFormat(quickDraft, "Brawl"), "Constructed");

  console.log("OK: parseEventIdentity groups repeated dated runs of the same event type together, keeps different sets/subtypes separate, falls back gracefully for unparseable names, and resolveEventFormat prefers a real captured deck Format over the name-based guess (falling back to it when no deck/Format was captured).");
}

run();
