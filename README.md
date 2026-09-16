# MTGA Tracker — Milestone 1: headless log capture

Background companion for MTG Arena. Long-term goal: track deck performance,
per-event stats, and limited/draft data, with an in-game overlay. This first
milestone deliberately does **not** draw an overlay yet — it just proves we
can reliably capture MTGA's own event stream, and shows us exactly what
that stream looks like on your real installation.

## Why start here

MTG Arena has no public API. The established approach (used by 17Lands,
MTGA Pro Tracker, and others) is to read `Player.log`, a file Arena writes
locally when detailed logging is turned on. The exact JSON shape of that
log has changed several times over the years, and we don't have a current,
verified field-by-field map of it. Rather than guess and risk building on
wrong assumptions, this milestone:

1. Finds and tails your `Player.log` live, handling Arena restarts (which
   rewrite the file) without losing events.
2. Extracts every JSON payload the log contains, generically — no
   assumptions about specific field names.
3. Logs each one (with a best-effort event name, direction, and timestamp)
   to `data/raw-events.jsonl`, and saves one sample of each *distinct*
   event type to `samples/`.

Once you've played a few games/drafts with this running, we'll look at
`samples/` together and write the real, typed parser (matches, games,
draft picks, deck lists) against your actual log — grounded in data instead
of guesses. That typed layer is milestone 2, and is when a proper local
database replaces the raw JSONL file.

## Setup

1. **Enable detailed logs in Arena** (one-time): in the Arena client, go to
   *Options → Account* and turn on **"Detailed Logs (Plugin Support)"**.
   Restart Arena once after enabling it.
2. Install dependencies:
   ```
   npm install
   ```
3. Run it (leave it running in a terminal while you play):
   ```
   npm start
   ```
   It auto-detects the log path for your OS. To point at a specific file or
   to replay the whole existing log instead of only new events, use:
   ```
   npm start -- --log-path "/path/to/Player.log" --from-start
   ```

You'll see one line per captured event (its guessed name + direction), and
a summary of event-type counts every 60 seconds and on exit (Ctrl+C).

## What's next (milestone 2+)

- Inspect `samples/` from a real play session and map the event types we
  actually see to typed domain events (match start/end, game result, draft
  pack/pick, deck submission).
- Replace the raw JSONL store with a small local database (SQLite) keyed on
  those typed events.
- Build the always-on-top overlay window (Electron `BrowserWindow` with
  transparency + click-through) that reads from that database live.
- Layer in deck/collection tracking, per-archetype win rates, and draft
  pick analysis on top.

## Project layout

```
src/
  log/
    logLocator.ts    finds Player.log for the current OS
    logTailer.ts      tails the file live, handles Arena restarts/rotation
    logParser.ts      generic streaming JSON-block extractor
    logParser.test.ts self-test against a synthetic log fixture
  db/
    store.ts          appends events to data/raw-events.jsonl + samples/
  cli.ts               headless entry point (this milestone's app)
data/                  raw-events.jsonl lands here (gitignored)
samples/                one sample JSON per distinct event type (gitignored)
```

## A note on Wizards' policy

This reads a local log file the game itself writes and never touches game
memory, packets, or automation — the same approach 17Lands, MTGA Pro
Tracker and other established community tools use, under Wizards' Fan
Content Policy. It's worth rechecking [Wizards' Fan Content
Policy](https://company.wizards.com/en/legal/fancontentpolicy) yourself
before distributing anything beyond personal use.
