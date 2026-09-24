// Regression test for the 2026-09-24 bug: MTGA rotates Player.log by
// renaming the old file to Player-prev.log and creating a brand new
// Player.log at the same path, rather than truncating in place. A watcher
// on the exact file path can miss that a new file now exists there - this
// test reproduces the real rotation sequence against a real temp directory
// and confirms the tailer picks up post-rotation data. Uses real fs/chokidar
// timing (not mocked), so it polls with a timeout rather than asserting
// synchronously - genuine filesystem watch events aren't instant.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTailer } from "./logTailer.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

async function run() {
  const dir = mkdtempSync(join(tmpdir(), "logtailer-test-"));
  const logPath = join(dir, "Player.log");
  const prevPath = join(dir, "Player-prev.log");

  writeFileSync(logPath, "session 1 line 1\n", "utf8");

  const tailer = new LogTailer(logPath); // default: start at EOF, only see new data
  const chunks: string[] = [];
  const errors: Error[] = [];
  tailer.on("data", (chunk) => chunks.push(chunk));
  tailer.on("error", (err) => errors.push(err));
  let rotatedFired = false;
  tailer.on("rotated", () => {
    rotatedFired = true;
  });
  tailer.start();
  // chokidar's native watcher (fsevents/inotify) needs a brief moment to
  // actually attach after start() returns - writing immediately risks the
  // write landing before the watch is live and missing the event entirely.
  // This isn't specific to our code; it's a documented chokidar caveat.
  await sleep(300);

  try {
    // Sanity check: ordinary same-file growth is picked up.
    writeFileSync(logPath, "session 1 line 1\nsession 1 line 2\n", "utf8");
    await waitFor(() => chunks.join("").includes("session 1 line 2"), 5000, "ordinary append to be tailed");

    // The actual rotation this bug is about: rename the current file away,
    // then create a brand new file at the same path - not a truncate.
    renameSync(logPath, prevPath);
    writeFileSync(logPath, "session 2 line 1\n", "utf8");

    await waitFor(
      () => chunks.join("").includes("session 2 line 1"),
      5000,
      "post-rotation content from the recreated file to be tailed",
    );

    // The full sequence emitted so far should be exactly the ordinary
    // append followed by the post-rotation line, with nothing duplicated
    // and nothing re-read from Player-prev.log (the renamed-away old file).
    assert.equal(chunks.join(""), "session 1 line 2\nsession 2 line 1\n");
    assert.ok(rotatedFired, "expected the 'rotated' event to have fired");
    assert.equal(errors.length, 0, `expected no tailer errors, got: ${errors.map((e) => e.message).join("; ")}`);

    // Keep growing the new file after rotation - confirms the watcher is
    // genuinely re-attached to the new file, not just caught a one-off event.
    writeFileSync(logPath, "session 2 line 1\nsession 2 line 2\n", "utf8");
    await waitFor(() => chunks.join("").includes("session 2 line 2"), 5000, "continued tailing after rotation");
    assert.equal(chunks.join(""), "session 1 line 2\nsession 2 line 1\nsession 2 line 2\n");

    console.log("OK: logTailer survives a rename-based Player.log rotation (old file renamed away, new file created at the same path) and keeps tailing the new file.");
  } finally {
    await tailer.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
