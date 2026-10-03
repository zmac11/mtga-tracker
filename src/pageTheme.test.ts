import assert from "node:assert/strict";
import { DEFAULT_PAGE_THEME, PAGE_THEMES, PAGE_THEME_CSS, applyPageTheme, normalizePageTheme } from "./pageTheme.js";

function run() {
  assert.deepEqual(PAGE_THEMES.map((t) => t.key), ["dark", "light", "system", "blue", "ember", "grove", "gilded", "neon", "crest", "retro"]);
  // Every theme has a palette block, and the overlay's looks are all offered for pages too.
  for (const t of PAGE_THEMES) if (t.key !== "dark" && t.key !== "system") assert.ok(PAGE_THEME_CSS.includes(`:root[data-theme="${t.key}"] {`), `${t.key} palette`);
  assert.equal(normalizePageTheme("light"), "light");
  assert.equal(normalizePageTheme("nonsense"), DEFAULT_PAGE_THEME);
  assert.equal(normalizePageTheme(undefined), DEFAULT_PAGE_THEME);

  const page = '<!DOCTYPE html>\n<html lang="en">\n<head><title>x</title><style>body{color:var(--text, #e8e8ec)}</style></head>\n<body>hi</body></html>';

  const light = applyPageTheme(page, "light");
  assert.ok(light.includes('<html lang="en" data-theme="light">'), "marks the page with the theme");
  assert.ok(light.includes('<style id="page-theme">'), "adds the theme variables");
  assert.ok(light.indexOf('id="page-theme"') < light.indexOf("</head>"), "inside <head>");
  assert.ok(light.includes("--bg: #f4f5f9"), "light palette present");
  assert.ok(light.includes('body{color:var(--text, #e8e8ec)}'), "the page's own CSS is untouched");

  // An unknown theme falls back to dark; re-applying replaces the old mark instead of stacking.
  assert.ok(applyPageTheme(page, "bogus").includes('data-theme="dark"'));
  const twice = applyPageTheme(applyPageTheme(page, "light"), "retro");
  const htmlTag = twice.match(/<html[^>]*>/)![0];
  assert.equal(htmlTag.match(/data-theme=/g)?.length, 1, "one data-theme attribute");
  assert.ok(htmlTag.includes('data-theme="retro"'));

  // A fragment (no </head>) is left alone.
  assert.equal(applyPageTheme("<section>x</section>", "light"), "<section>x</section>");

  // System follows the OS setting through a media query.
  assert.ok(PAGE_THEME_CSS.includes('@media (prefers-color-scheme: light)'));
  assert.ok(PAGE_THEME_CSS.includes(':root[data-theme="system"]'));

  console.log("pageTheme tests passed");
}

run();
