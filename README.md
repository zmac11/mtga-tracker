# MTGA Tracker — Milestone 2: typed events

Background companion for MTG Arena. Long-term goal: track deck performance,
per-event stats, and limited/draft data, with an in-game overlay.

Milestone 1 proved we could reliably capture MTGA's own event stream from
`Player.log` without guessing its shape. Milestone 2 (this one) turns that
generic capture into typed, queryable data — draft picks, deck lists, match
results, live game state (life totals/turn) — based on shapes confirmed
against a real draft + match, not guesses. There's still no overlay UI yet;
this is the data layer it'll read from.

## How it fits together

```
Player.log  →  logTailer + logParser (generic JSON capture, milestone 1)
                    │
                    ├─→ data/raw-events.jsonl   (every event, untyped, for audit/debugging)
                    │
                    └─→ classifier.ts           (recognizes known shapes)
                              │
                              └─→ data/tracker.db   (typed events, SQLite)
                                        │
                                        └─→ npm run report  (human-readable summary)
```

The classifier (`src/domain/classifier.ts`) currently recognizes: joining a
draft, seeing a pack, making a pick, completing a draft, submitting a deck,
a match being found, live game state (life totals, turn, stage), and a
match completing with its result. It does **not** yet parse turn-by-turn
actions (spells cast, mana spent, the stack) — that's `clientToMatchServiceMessageType`
and most `greToClientEvent` messages, intentionally left unclassified until
there's a concrete reason (e.g. the overlay) to need them.

## Setup

1. **Enable detailed logs in Arena** (one-time): *Options → Account* →
   **"Detailed Logs (Plugin Support)"** → on. Restart Arena once after.
2. Install dependencies:
   ```
   npm install
   ```
3. Run it (leave it running in a terminal while you play):
   ```
   npm start
   ```
   To replay the whole existing log instead of only new events (e.g. the
   first time, or if you started the tracker mid-session):
   ```
   npm start -- --from-start
   ```
4. See what's been captured:
   ```
   npm run report
   ```

Re-running `npm start -- --from-start` more than once re-appends the whole
replayed log to `data/raw-events.jsonl` (milestone-1's raw store doesn't
de-dup) — that's fine, `npm run report` de-dupes by natural key (draft
course ID, deck ID, match ID) so repeated data doesn't skew the summary.

If you ever want to rebuild `data/tracker.db` from scratch (e.g. after a
classifier change, without needing to replay the real log again), run:
```
npm run backfill
```

## Testing

```
npm test
```
Runs two fixture-based self-tests: the generic log-block extractor
(`src/log/logParser.test.ts`) and the typed classifier
(`src/domain/classifier.test.ts`, built from real captured shapes).

## What's next (milestone 3+)

- Turn-by-turn action parsing, if/when the overlay needs it (spells cast,
  mana spent, combat).
- Per-deck / per-archetype win-rate rollups once there's more than one
  match of data.
- The overlay itself: an always-on-top, click-through Electron
  `BrowserWindow` positioned over the Arena window, reading live from the
  classifier (or from `tracker.db`).
- Handle the cases we haven't seen yet: bot drafts, Bo3 matches, losses,
  draws, disconnects — the classifier's shapes are only confirmed for one
  human draft + one Bo1 win so far.

## Project layout

```
src/
  log/
    logLocator.ts       finds Player.log for the current OS
    logTailer.ts         tails the file live, handles Arena restarts/rotation
    logParser.ts         generic streaming JSON-block extractor
    logParser.test.ts    self-test against a synthetic log fixture
  db/
    store.ts             appends raw events to data/raw-events.jsonl + samples/
    sqliteStore.ts        typed event-sourced store (data/tracker.db)
  domain/
    types.ts              typed domain event definitions
    classifier.ts          raw block -> typed event(s)
    classifier.test.ts      self-test against real captured shapes
  cli.ts                 headless entry point: capture + classify, live
  backfill.ts             rebuilds tracker.db from raw-events.jsonl
  report.ts               human-readable summary from tracker.db
data/                   raw-events.jsonl + tracker.db land here (gitignored)
samples/                 one sample JSON per distinct raw event type (gitignored)
```

## A note on Wizards' policy

This reads a local log file the game itself writes and never touches game
memory, packets, or automation — the same approach 17Lands, MTGA Pro
Tracker and other established community tools use, under Wizards' Fan
Content Policy. It's worth rechecking [Wizards' Fan Content
Policy](https://company.wizards.com/en/legal/fancontentpolicy) yourself
before distributing anything beyond personal use.
