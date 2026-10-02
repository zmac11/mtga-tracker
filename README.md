# MTGA Tracker

A background companion app for MTG Arena. It reads the game's own
`Player.log` file (the same "Detailed Logs" the game itself writes) to
capture match results, draft picks, and submitted decks, and turns that
into:

- A small always-on-top **overlay** showing what event you're in and your
  win rate for it, click-through by default so it never gets in the way of
  Arena underneath it.
- A **deck viewer** page (opened from the tray) for any event you've played
  - a text deck list grouped by card type, a visual "laid out like Arena's
    own deck builder" view by mana cost, a mana curve chart, and (for a
    draft) every pick you made pack-by-pack, including what wheeled back to
    you.
- A **live draft progress** page that updates itself while you're actually
  in a draft - the current pack, and everything you've picked so far.
- A **card database refresh** (from the tray menu) that pulls card
  names/images/oracle text so the pages above have real card art and text,
  not just IDs.

Everything runs locally. The app never sends your `Player.log`, your
decks, or your match history anywhere - the only network calls it makes on
its own are refreshing card data from Scryfall and (optionally) checking
this GitHub repo for a newer release. See "Update checks" and "Privacy"
below.

## Installing

You'll need [Node.js](https://nodejs.org) 22 or later either way (check
with `node --version`; the "LTS" download from nodejs.org is fine).

**Option 1 - git clone (recommended if you have git):**

```
git clone https://github.com/zmac11/mtga-tracker.git
cd mtga-tracker
npm install
npm run overlay
```

**Option 2 - download the source without git:**

On the GitHub page, click the green "Code" button -> "Download ZIP", unzip
it, then open a terminal in that folder and run:

```
npm install
npm run overlay
```

**Option 3 - a packaged installer:**

Check this repo's [Releases page](https://github.com/zmac11/mtga-tracker/releases)
for a downloadable installer (a `.dmg` for macOS or an installer `.exe` for
Windows), if one has been published. Because these builds aren't
code-signed or (on macOS) notarized - that costs money this project doesn't
have - your OS will likely show a security warning the first time you open
one ("unidentified developer" on macOS, a SmartScreen prompt on Windows).
That's expected for an unsigned indie/hobby app; you'll need to explicitly
allow it (macOS: right-click the app -> Open, then confirm; Windows: "More
info" -> "Run anyway"). If that's not something you're comfortable doing,
Option 1 or 2 above run from source instead and don't trigger either
warning.

Either way, before your first run: in MTG Arena, go to **Options > Account**
and turn on **Detailed Logs (Plugin Support)**, then relaunch Arena once.
Without that, Arena won't write the log file this app reads, and the tray
menu will tell you it couldn't find `Player.log`.

### If it can't find Player.log or your card database

The app looks in the default location for your OS/install method
automatically - this is well-tested on macOS + Steam (where it was built),
but the equivalent Windows locations are best-effort guesses that haven't
been confirmed against every real install (a different drive, a
non-Steam install, etc. could all land somewhere else). If the tray says
it couldn't find `Player.log`, or "Refresh Card Database" fails to find
Arena's database, open **Overlay Settings...** from the tray and use the
new **Locations** section to browse to the right file/folder yourself:

- **Player.log** - the exact log file MTG Arena writes (see the paths in
  "Privacy" below for where it normally lives per OS). Setting this
  restarts the app.
- **Card database folder** - the folder inside your Arena install
  containing a file named `Raw_CardDatabase_<something>.mtga` (usually
  something like `.../MTGA/MTGA_Data/Downloads/Raw/`). Takes effect the
  next time you click "Refresh Card Database" - no restart needed.

Either box can be reset back to "Auto-detect" the same way.

## Using it

Launching the app (`npm run overlay`, or the packaged app) adds an icon to
your menu bar/system tray - there's no dock icon or window menu, since the
overlay window is the only visible thing this app shows on its own. Click
the tray icon for:

- **Start MTGA Tracker at Login** - launch it automatically.
- **Unlock Overlay (drag to move)** (`Cmd/Ctrl+Shift+O`) - the overlay is
  click-through by default; toggle this to reposition it, then toggle it
  back off.
- **Hide Overlay** (`Cmd/Ctrl+Shift+H`) - hide/show the whole overlay
  window.
- **Overlay Settings...** - overlay size, transparency, deck-viewer card
  thumbnail size, automatic update checks (see below), and, under
  "Locations," manual overrides for where the app looks for `Player.log`
  and Arena's card database if it can't find either automatically (see
  "If it can't find Player.log or your card database" below).
- **Refresh Card Database** - pulls current card names/images/text so the
  deck viewer and draft-progress pages can show real art instead of just
  card IDs. Worth doing once after installing, and again after any Arena
  set release/rebalance.
- **Check for Updates Now** / **Send Feedback...** - see below.
- **Quit MTGA Tracker** (`Cmd/Ctrl+Shift+Q`).

Click the overlay's current-event label (once you're in a match or draft)
to open its **deck viewer** in your browser; a running draft also gets a
**draft progress** page that keeps itself up to date while you're picking.

**On Windows**, run Arena in **Borderless Windowed** mode (Arena's own
Options > Graphics setting), not true exclusive Fullscreen - an
always-on-top window like this overlay generally can't draw above an
exclusive-fullscreen game on Windows, which is an OS-level limitation, not
something this app can work around. Borderless Windowed looks identical to
fullscreen but is a regular window underneath, so the overlay shows up
above it normally. This isn't an issue on macOS.

## Update checks

The Settings window has an "Automatically check for updates" toggle
(on by default). When it's on, the app periodically compares its own
version against this repo's latest published
[GitHub Release](https://github.com/zmac11/mtga-tracker/releases) - on
startup, every few hours, and (best-effort - see the comment on
`checkArenaProcess` in `src/electron/main.ts` if it doesn't seem to work
for you) when MTG Arena itself looks like it just launched.

This is a "check and notify" feature, not a real auto-updater: it never
downloads or installs anything by itself. If a newer version is out, you
get a native notification and a tray item linking to the release - updating
is still `git pull && npm install` (or re-downloading), same as installing
was. A real silent auto-updater needs a code-signing certificate (and, on
macOS, Apple notarization) to install safely; this project doesn't have
that set up, so this stays a manual step on purpose rather than training
you to click through a security warning to get an "update."

You can also click "Check for Updates Now" any time from the tray or the
Settings window.

## Sending feedback

The tray's "Send Feedback..." item opens your computer's default mail app
with a new message addressed to the maintainer, pre-filled with your app
version and OS so a bug report always has the basics. Nothing is sent by
the app itself - you still have to hit send yourself, exactly like clicking
any other `mailto:` link on a website. If you'd rather not use email, GitHub
[Issues](https://github.com/zmac11/mtga-tracker/issues) work too.

## Privacy

This app only ever reads your local `Player.log` and your own card/match
data - it doesn't touch anything else on your computer, and it doesn't
send your deck lists, match history, or draft picks anywhere. The only
outbound network calls it makes on its own are: refreshing card data from
Scryfall's public API (tray menu's "Refresh Card Database"), and, if you
leave the update-check setting on, a request to GitHub's public API asking
for this repo's latest release tag. Neither call includes anything about
you or your account.

## Development

```
npm install
npm test          # runs every *.test.ts file in src/
npm run build      # compiles TypeScript to dist/ and copies Electron assets
npm run overlay    # build + launch the Electron app
npm run report     # headless CLI: win rates, color combos, per-event history (--event=<id>)
npm run backfill   # replay Player.log from the start into tracker.db
npm run backfill-from-log   # recover matches missed while the tracker was off (Player.log + Player-prev.log); add -- --dry-run to preview
npm run deck-viewer -- <eventId>      # regenerate one event's deck-viewer page without the app running
npm run draft-progress                # regenerate the live draft-progress page without the app running
npm run refresh-cards                 # the same card-database refresh as the tray button, from a terminal
npm run dist       # package an installer for your current OS (see "Installing" above)
npm run dist:mac / dist:win / dist:linux   # package for a specific OS (cross-building generally needs that OS/toolchain)
```

`npm test` runs the full unit-test suite (parsing, classification, live
state, the deck-viewer/draft-progress HTML generators, color/curve logic,
and more) with Node's built-in test runner via `tsx` - no real database,
browser, or network access needed. There's no CI configured yet, so running
`npm test` yourself before sending a pull request is the current substitute.

### Project layout

```
src/
  log/            Player.log location + tailing + line-block parsing
  domain/         pure classification/rollup/derivation logic (no I/O)
  cards/          Arena's own card database + Scryfall enrichment
  db/             SQLite storage for classified events + the card catalog
  electron/       the tray app - main.ts, preload, and the overlay/settings renderer pages
  *Html.ts        pure string-building for the deck-viewer/draft-progress browser pages
  *Loader.ts      thin joins from the database into the shape those pages need
  cli.ts          headless entry point (used by npm run start/dev)
  report.ts       headless win-rate/color/per-event reporting CLI
```

Every `*.test.ts` file sits next to the module it tests. `src/domain/` in
particular is deliberately pure (plain functions over plain data, no
database/Electron/filesystem access) so it's fast and easy to test in
isolation; the `*Loader.ts`/`electron/main.ts` files are the thin, harder-
to-unit-test glue that wires that pure logic up to real data and a real
window.

## A note on Wizards' policy

This reads a local log file the game itself writes and never touches game
memory, packets, or automation - the same approach 17Lands, MTGA Pro
Tracker and other established community tools use. It also reads a
second local file, Arena's own `Raw_CardDatabase_*.mtga` (already on your
disk), to map card IDs to names/images - read-only, and the only data it
extracts (card names, sets, oracle text) is the same public information
already published on Scryfall/Gatherer. Both fall under Wizards' Fan
Content Policy. It's worth rechecking
[Wizards' Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy)
yourself before distributing anything beyond personal/friends use - this
project is an unofficial fan project, not affiliated with or endorsed by
Wizards of the Coast.

## License

MIT - see [LICENSE](LICENSE). That covers the code in this repository only;
it doesn't grant any rights to Magic: The Gathering/Arena's own content
(card names, images, text, etc.), which remains Wizards of the Coast's.
