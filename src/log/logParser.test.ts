// Quick self-test for LogParser against a synthetic, MTGA-log-shaped fixture.
// This is NOT a claim that this is byte-exact to a real Player.log (formats
// have changed over the years and we haven't captured a real one yet) - it
// exercises the things we know the real format does: a logger tag + arrow
// marker header before each JSON block, JSON that can contain escaped JSON
// strings nested inside string fields, multi-line JSON bodies, and stray
// brace characters in free-text lines that must NOT be mistaken for JSON.

import assert from "node:assert/strict";
import { LogParser, type RawBlock } from "./logParser.js";

const fixture = `
[UnityCrossThreadLogger]9/16/2026 3:14:07 PM
==> Bot.BotDraftPack
{"id":"abc-123","request":"{\\"DraftId\\":\\"draft-1\\",\\"PackNumber\\":1,\\"PickNumber\\":1,\\"DraftPack\\":[12345,67890,11111]}"}

[UnityCrossThreadLogger]9/16/2026 3:14:09 PM
<== Bot.BotDraftPack
{"id":"abc-123","payload":"{\\"DraftId\\":\\"draft-1\\",\\"PackNumber\\":1,\\"PickCards\\":[12345]}"}

[UnityCrossThreadLogger]9/16/2026 3:15:00 PM
Some free text line with a stray { not valid json } that should be ignored

[UnityCrossThreadLogger]9/16/2026 3:15:02 PM
==> Event.MatchCreated
{
  "matchId": "match-999",
  "opponentInfo": {"displayName": "Opponent#1234"},
  "format": "Standard"
}
`;

function run() {
  const parser = new LogParser();
  const blocks: RawBlock[] = [];
  parser.on("block", (b) => blocks.push(b));

  // Feed it in small, arbitrary chunks to exercise cross-chunk buffering,
  // the way real tailed data will arrive.
  for (let i = 0; i < fixture.length; i += 17) {
    parser.feed(fixture.slice(i, i + 17));
  }

  assert.equal(blocks.length, 3, `expected 3 valid JSON blocks, got ${blocks.length}`);

  assert.equal(blocks[0].direction, "request");
  assert.equal(blocks[0].methodGuess, "Bot.BotDraftPack");
  assert.equal((blocks[0].json as any).id, "abc-123");
  // The nested escaped JSON string should have survived as a plain string,
  // not been parsed as nested structure or corrupted the outer parse.
  const innerRequest = JSON.parse((blocks[0].json as any).request);
  assert.equal(innerRequest.DraftId, "draft-1");
  assert.deepEqual(innerRequest.DraftPack, [12345, 67890, 11111]);

  assert.equal(blocks[1].direction, "response");
  assert.equal(blocks[1].methodGuess, "Bot.BotDraftPack");

  assert.equal(blocks[2].direction, "request");
  assert.equal(blocks[2].methodGuess, "Event.MatchCreated");
  assert.equal((blocks[2].json as any).matchId, "match-999");
  assert.equal((blocks[2].json as any).opponentInfo.displayName, "Opponent#1234");

  console.log(`OK: parsed ${blocks.length} blocks correctly from ${fixture.length}-byte fixture, fed in 17-byte chunks.`);
}

run();
