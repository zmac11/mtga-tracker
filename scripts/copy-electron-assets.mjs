// tsc only compiles .ts files, so the Electron preload script (deliberately
// plain CommonJS, see preload.cjs's own comment) and the renderer's
// html/css/js (deliberately unbundled, plain browser scripts) need to be
// copied into dist/ alongside the compiled main.js by hand. Using
// fs.cpSync instead of a shell `cp` so this works the same on Windows if
// this project ever gets there.
import { cpSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

mkdirSync(join(root, "dist", "electron", "renderer"), { recursive: true });
cpSync(join(root, "src", "electron", "preload.cjs"), join(root, "dist", "electron", "preload.cjs"));
cpSync(join(root, "src", "electron", "renderer"), join(root, "dist", "electron", "renderer"), { recursive: true });

console.log("Copied electron preload.cjs + renderer/ into dist/electron/");
