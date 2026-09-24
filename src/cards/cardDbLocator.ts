import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Finds MTG Arena's own local card database - a SQLite file named
 * Raw_CardDatabase_<hash>.mtga that Arena writes into its own install
 * directory and keeps in sync with whatever the client has installed
 * (every set, every rebalance, always current - no external service to
 * poll). This is the ground-truth source for grpId -> {name, set,
 * collector number}; see cards/extractArenaCards.ts for what we do with it
 * and the project doc's card-database section for the research behind
 * this approach.
 *
 * Unlike Player.log (a fixed per-user path regardless of how Arena was
 * installed), this file lives *inside* Arena's own install directory, which
 * varies by install method (Steam, the standalone Wizards client, Epic).
 * The candidates below are the ones actually confirmed, plus reasonable
 * guesses for the others based on each launcher's normal install
 * conventions - explicitly marked as unconfirmed where they are, the same
 * way logLocator.ts's Windows Player.log path was a documented default that
 * was never tested against a real Windows machine.
 *
 * Confirmed (2026-09-24, this project's own user, macOS + Steam):
 *   ~/Library/Application Support/Steam/steamapps/common/MTGA/MTGA_Data/Downloads/Raw/Raw_CardDatabase_<hash>.mtga
 *
 * The <hash> suffix changes between client updates, so every candidate
 * directory below is *searched* (not matched by exact filename), and we
 * pick whichever matching file was modified most recently across all of
 * them - that's always Arena's currently-active card database.
 */

const FILENAME_RE = /^Raw_CardDatabase_.*\.mtga$/i;

function candidateDirs(): string[] {
  const home = homedir();
  const plat = platform();

  if (plat === "darwin") {
    return [
      // Confirmed for this project.
      join(home, "Library", "Application Support", "Steam", "steamapps", "common", "MTGA", "MTGA_Data", "Downloads", "Raw"),
      // Unconfirmed guess: standalone (non-Steam) Mac client, following the
      // same "Wizards Of The Coast" / "MTGA" naming Player.log's own path
      // uses (see logLocator.ts) rather than a confirmed observation.
      join(home, "Library", "Application Support", "Wizards Of The Coast", "MTGA", "MTGA_Data", "Downloads", "Raw"),
    ];
  }

  if (plat === "win32") {
    // None of these have been tested against a real Windows machine -
    // they're each launcher's documented/typical default install location.
    // A real Windows install could easily be on a different drive or a
    // custom path chosen at install time, which is exactly why
    // --card-db-path exists as an escape hatch (see refreshCards.ts).
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    return [
      join(programFilesX86, "Steam", "steamapps", "common", "MTGA", "MTGA_Data", "Downloads", "Raw"),
      join(programFiles, "Steam", "steamapps", "common", "MTGA", "MTGA_Data", "Downloads", "Raw"),
      join(programFiles, "Wizards of the Coast", "MTGA", "MTGA_Data", "Downloads", "Raw"),
      join(programFiles, "Epic Games", "MTGA", "MTGA_Data", "Downloads", "Raw"),
    ];
  }

  // MTGA doesn't officially run on Linux - no real candidates, just a
  // best-guess so callers get a clear "checked: [...]" error rather than
  // an empty list.
  return [join(home, ".local", "share", "Steam", "steamapps", "common", "MTGA", "MTGA_Data", "Downloads", "Raw")];
}

export interface LocateCardDbResult {
  found: boolean;
  /** The matched Raw_CardDatabase_*.mtga file, if found. */
  path: string | null;
  /** Every directory that was searched, for a clear error message when nothing's found. */
  checked: string[];
}

/**
 * `explicitPath` can be either a direct path to a Raw_CardDatabase_*.mtga
 * file, or a directory to search within (in which case it's searched the
 * same way the built-in candidates are) - mirrors --log-path's flexibility.
 */
export function locateCardDatabase(explicitPath?: string): LocateCardDbResult {
  const dirsToSearch = explicitPath ? [explicitPath] : candidateDirs();
  const checked: string[] = [];
  const matches: Array<{ path: string; mtimeMs: number }> = [];

  for (const dir of dirsToSearch) {
    if (explicitPath && existsSync(explicitPath) && statSync(explicitPath).isFile()) {
      // Explicit path pointed directly at the file itself.
      return { found: true, path: explicitPath, checked: [explicitPath] };
    }

    checked.push(dir);
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!FILENAME_RE.test(entry)) continue;
      const fullPath = join(dir, entry);
      try {
        matches.push({ path: fullPath, mtimeMs: statSync(fullPath).mtimeMs });
      } catch {
        // Race condition (deleted between readdir and stat) - skip it.
      }
    }
  }

  if (matches.length === 0) {
    return { found: false, path: null, checked };
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { found: true, path: matches[0].path, checked };
}
