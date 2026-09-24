// Unit test for the hand-rolled streaming JSON array splitter used to read
// Scryfall's large default_cards bulk file without loading it whole (see
// jsonArrayStream.ts's own comment for why). This is the one part of the
// card pipeline that's fully testable without live network access, so it
// gets real test coverage - unlike scryfallEnrich.ts itself, which can only
// be verified end-to-end by the user against the real Scryfall API.

import assert from "node:assert/strict";
import { streamJsonArray } from "./jsonArrayStream.js";

async function* stringsOf(...parts: string[]): AsyncGenerator<string> {
  for (const p of parts) yield p;
}

async function run() {
  // Basic case: a few plain objects.
  const basic: unknown[] = [];
  await streamJsonArray(stringsOf('[{"a":1},{"a":2},{"a":3}]'), (o) => basic.push(o));
  assert.deepEqual(basic, [{ a: 1 }, { a: 2 }, { a: 3 }]);

  // Split arbitrarily mid-token across chunk boundaries, including right in
  // the middle of a string and right on a brace - this is the realistic
  // case for a fetch response, where chunk boundaries have nothing to do
  // with JSON token boundaries.
  const chunked: unknown[] = [];
  await streamJsonArray(
    stringsOf('[{"nam', 'e":"Mount', 'ain","oracle_text":"', "Add {T}: Add {R}.", '"},{"nested":{"x":[1,2,3]}}', "]"),
    (o) => chunked.push(o),
  );
  assert.deepEqual(chunked, [
    { name: "Mountain", oracle_text: "Add {T}: Add {R}." },
    { nested: { x: [1, 2, 3] } },
  ]);

  // Braces and brackets *inside* string values (very real for Scryfall -
  // oracle_text routinely contains "{" mana symbols) must not perturb depth
  // tracking.
  const withBraces: unknown[] = [];
  await streamJsonArray(stringsOf('[{"oracle_text":"{2}{U}: Draw a card. } not a real close {"}]'), (o) =>
    withBraces.push(o),
  );
  assert.deepEqual(withBraces, [{ oracle_text: "{2}{U}: Draw a card. } not a real close {" }]);

  // Escaped quotes inside a string must not be mistaken for the string's end.
  const withEscapes: unknown[] = [];
  await streamJsonArray(stringsOf('[{"flavor_text":"She said \\"hello\\" to the {tapped} card."}]'), (o) =>
    withEscapes.push(o),
  );
  assert.deepEqual(withEscapes, [{ flavor_text: 'She said "hello" to the {tapped} card.' }]);

  // Empty array.
  const empty: unknown[] = [];
  await streamJsonArray(stringsOf("[]"), (o) => empty.push(o));
  assert.deepEqual(empty, []);

  // Leading whitespace before the array (Scryfall doesn't emit this, but
  // being lenient here is free and cheap to verify).
  const leadingWs: unknown[] = [];
  await streamJsonArray(stringsOf('  \n [{"a":1}]'), (o) => leadingWs.push(o));
  assert.deepEqual(leadingWs, [{ a: 1 }]);

  console.log("OK: jsonArrayStream handles chunked, brace-in-string, and escaped-quote cases correctly.");
}

run();
