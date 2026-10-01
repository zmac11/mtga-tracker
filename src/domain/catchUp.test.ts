import assert from "node:assert/strict";
import { selectNewMatchEvents, type ClassifiedBlock } from "./catchUp.js";
import type { MatchFound, MatchCompleted, PlayerIdentified } from "./types.js";

function rawBlock(): ClassifiedBlock["block"] {
  // Only selectNewMatchEvents' own filtering matters here, not the raw
  // block's own content - a minimal valid RawBlock is enough.
  return { direction: "unknown", header: "", methodGuess: null, timestampGuess: null, json: {}, raw: "{}" };
}

function matchFound(matchId: string): MatchFound {
  return {
    kind: "MatchFound",
    matchId,
    eventId: "e1",
    players: [{ userId: "u1", playerName: "Me", systemSeatId: 1, teamId: 1, courseId: null }],
    ts: "t1",
  };
}

function matchCompleted(matchId: string): MatchCompleted {
  return { kind: "MatchCompleted", matchId, results: [], ts: "t2" };
}

function playerIdentified(): PlayerIdentified {
  return { kind: "PlayerIdentified", screenName: "Me", clientId: "c1", ts: "t0" };
}

function run() {
  // Three matches worth of blocks: "old" is already on record, "new1" and
  // "new2" aren't - plus one block with no matchId at all (should never
  // be selected, even though it's interleaved among the new matches).
  const blocks: ClassifiedBlock[] = [
    { block: rawBlock(), events: [playerIdentified()] },
    { block: rawBlock(), events: [matchFound("old")] },
    { block: rawBlock(), events: [matchCompleted("old")] },
    { block: rawBlock(), events: [matchFound("new1")] },
    { block: rawBlock(), events: [matchCompleted("new1")] },
    { block: rawBlock(), events: [matchFound("new2")] },
    { block: rawBlock(), events: [matchCompleted("new2")] },
  ];

  const result = selectNewMatchEvents(blocks, new Set(["old"]));

  assert.deepEqual(new Set(result.newMatchIds), new Set(["new1", "new2"]));
  // Exactly the 4 blocks for new1+new2 (2 each) - not the PlayerIdentified
  // block, and not either of "old"'s blocks.
  assert.equal(result.toAppend.length, 4);
  const keptMatchIds = new Set(
    result.toAppend.flatMap(({ events }) => events.map((e) => (e as { matchId?: string }).matchId)),
  );
  assert.deepEqual(keptMatchIds, new Set(["new1", "new2"]));

  console.log("OK: selectNewMatchEvents picks out only the blocks for matchIds not already known, dropping an already-known match's blocks and any matchId-less block even when interleaved among new matches.");
}

function runNoNewMatches() {
  const blocks: ClassifiedBlock[] = [
    { block: rawBlock(), events: [matchFound("old")] },
    { block: rawBlock(), events: [matchCompleted("old")] },
  ];
  const result = selectNewMatchEvents(blocks, new Set(["old"]));
  assert.equal(result.newMatchIds.length, 0);
  assert.equal(result.toAppend.length, 0);
  console.log("OK: selectNewMatchEvents returns nothing to append when every matchId seen is already on record.");
}

function runEmptyExisting() {
  // A totally fresh store (e.g. first-ever run) - everything with a
  // matchId counts as new.
  const blocks: ClassifiedBlock[] = [
    { block: rawBlock(), events: [matchFound("m1")] },
    { block: rawBlock(), events: [matchCompleted("m1")] },
  ];
  const result = selectNewMatchEvents(blocks, new Set());
  assert.deepEqual(result.newMatchIds, ["m1"]);
  assert.equal(result.toAppend.length, 2);
  console.log("OK: selectNewMatchEvents treats every matchId as new when existingMatchIds is empty.");
}

run();
runNoNewMatches();
runEmptyExisting();
