import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Finds the MTG Arena Player.log file for the current platform.
 *
 * MTGA only writes gameplay/draft data to this file when "Detailed Logs
 * (Plugin Support)" is turned on in the game's Options > Account menu.
 * Without that setting the file exists but only contains diagnostic noise.
 */
export function candidateLogPaths(): string[] {
  const home = homedir();
  const plat = platform();

  if (plat === "darwin") {
    return [
      join(home, "Library", "Logs", "Wizards Of The Coast", "MTGA", "Player.log"),
    ];
  }

  if (plat === "win32") {
    // %USERPROFILE%\AppData\LocalLow\Wizards Of The Coast\MTGA\Player.log
    // LOCALAPPDATA usually points at ...\AppData\Local, so we go up one and
    // into the sibling "LocalLow" directory rather than relying on an env
    // var that may not be set the way we expect.
    return [
      join(home, "AppData", "LocalLow", "Wizards Of The Coast", "MTGA", "Player.log"),
    ];
  }

  // Unsupported platform (e.g. Linux) - MTGA doesn't officially run here,
  // but we still return a best-guess so callers can report a clear error.
  return [join(home, ".local", "share", "Wizards Of The Coast", "MTGA", "Player.log")];
}

export interface LocateResult {
  found: boolean;
  path: string;
  checked: string[];
}

export function locateLogFile(explicitPath?: string): LocateResult {
  if (explicitPath) {
    return { found: existsSync(explicitPath), path: explicitPath, checked: [explicitPath] };
  }

  const candidates = candidateLogPaths();
  for (const path of candidates) {
    if (existsSync(path)) {
      return { found: true, path, checked: candidates };
    }
  }
  return { found: false, path: candidates[0], checked: candidates };
}
