/**
 * Look of the generated HTML pages (deck viewer, past events, stats, draft
 * progress, ...): Dark, Light, System default, or one of the overlay's own looks
 * (Blue, Ember, Grove, Gilded, Neon, Five Colors, Retro). Chosen in the
 * Settings window; applied each time a page is generated.
 *
 * How it works: every page's own CSS refers to its colors as
 * `var(--bg, #14151a)` and so on - the fallback is the dark value, so a page
 * generated without a theme (the CLI scripts, the tests) looks exactly as it
 * always did. applyPageTheme() then marks the finished page with
 * `data-theme="<key>"` and adds one <style> block (PAGE_THEME_CSS) defining
 * those variables for each theme. Pure string work - no DOM, no Electron.
 */

export interface PageThemeInfo {
  key: string;
  label: string;
}

export const PAGE_THEMES: PageThemeInfo[] = [
  { key: "dark", label: "Dark (default)" },
  { key: "light", label: "Light" },
  { key: "system", label: "System default" },
  { key: "blue", label: "Blue" },
  { key: "ember", label: "Ember" },
  { key: "grove", label: "Grove" },
  { key: "gilded", label: "Gilded" },
  { key: "neon", label: "Neon" },
  { key: "crest", label: "Five Colors" },
  { key: "retro", label: "Retro" },
];

export const DEFAULT_PAGE_THEME = "dark";

export function normalizePageTheme(theme: unknown): string {
  return typeof theme === "string" && PAGE_THEMES.some((t) => t.key === theme) ? theme : DEFAULT_PAGE_THEME;
}

const DARK_VARS = `
  --cs: dark;
  --bg: #14151a;
  --surface: #1c1e26;
  --surface-2: #22232c;
  --surface-3: #1b1c23;
  --popover: #1c1d24;
  --input-bg: #0f1014;
  --border: #2a2c36;
  --border-2: #34364280;
  --border-3: #3a3c48;
  --border-faint: #22242e;
  --text: #e8e8ec;
  --text-2: #cfd2dc;
  --text-3: #b7bac6;
  --muted: #8a8d99;
  --muted-2: #9296a3;
  --muted-3: #6a6d79;
  --accent: #9fa6ff;
  --accent-bg: #262a4a;
  --accent-bg-2: #21243a;
  --accent-border: #4a4fb0;
  --accent-solid: #3d4ee0;
  --pos: #7ee787;
  --neg: #ff8080;
  --ok-text: #8fd9a8;
  --ok-bg: #1e3a2a;
  --warn-text: #f0c674;
  --warn-bg: #3d3320;
  --gem: #7fd6e8;
  --gold: #e8c76a;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
`;

const LIGHT_VARS = `
  --cs: light;
  --bg: #f4f5f9;
  --surface: #ffffff;
  --surface-2: #e9ebf3;
  --surface-3: #f0f1f7;
  --popover: #ffffff;
  --input-bg: #ffffff;
  --border: #d3d6e2;
  --border-2: #b9bdd080;
  --border-3: #c4c7d6;
  --border-faint: #e3e5ee;
  --text: #1c1e29;
  --text-2: #3b3e4d;
  --text-3: #52566a;
  --muted: #656a7e;
  --muted-2: #6f7488;
  --muted-3: #8a8fa3;
  --accent: #3846c9;
  --accent-bg: #e5e8ff;
  --accent-bg-2: #eef0ff;
  --accent-border: #a9b1f5;
  --accent-solid: #3d4ee0;
  --pos: #1a8f3c;
  --neg: #c62f3b;
  --ok-text: #1b6b3a;
  --ok-bg: #daf3e3;
  --warn-text: #8a5a00;
  --warn-bg: #fbefd0;
  --gem: #0b7f94;
  --gold: #946a00;
`;

/** Retro: the DOS file-manager look of the overlay's Retro theme - blue screen, monospace, cyan/yellow accents, square corners. */
const RETRO_VARS = `
  --cs: dark;
  --bg: #000090;
  --surface: #0000b0;
  --surface-2: #0000c8;
  --surface-3: #000080;
  --popover: #000080;
  --input-bg: #000070;
  --border: #a8a8d8;
  --border-2: #a8a8d8a0;
  --border-3: #c0c0e0;
  --border-faint: #4848c0;
  --text: #f0f0f8;
  --text-2: #d0d0e8;
  --text-3: #c0c0dc;
  --muted: #a0a0d8;
  --muted-2: #a8a8dc;
  --muted-3: #8888c8;
  --accent: #55ffff;
  --accent-bg: #000070;
  --accent-bg-2: #0000d8;
  --accent-border: #55ffff;
  --accent-solid: #008888;
  --pos: #55ff55;
  --neg: #ff5555;
  --ok-text: #55ff55;
  --ok-bg: #004000;
  --warn-text: #ffff55;
  --warn-bg: #404000;
  --gem: #55ffff;
  --gold: #ffff55;
  --font: "Lucida Console", Menlo, Consolas, "Courier New", monospace;
`;


/** Builds one theme's variable block; every dark-based theme shares --cs: dark. */
function palette(o: Record<string, string>, font?: string): string {
  const lines = Object.entries(o).map(([k, v]) => `  --${k}: ${v};`);
  if (font) lines.push(`  --font: ${font};`);
  return `\n  --cs: dark;\n${lines.join("\n")}\n`;
}

// The overlay's own looks, carried over to the pages. Each palette is the
// overlay theme's hue spread over the same variables the other themes use;
// decorations (a glow, hatching, scanlines, a top bar) are in EXTRA_CSS below.
const BLUE_VARS = palette({
  bg: "#10152e", surface: "#182046", "surface-2": "#1f2a5c", "surface-3": "#151c3d", popover: "#161e44", "input-bg": "#0d1229",
  border: "#2c3a78", "border-2": "#3a4a9080", "border-3": "#4a5cae", "border-faint": "#1f2a5a",
  text: "#e8edff", "text-2": "#cdd6ff", "text-3": "#b3c0f5", muted: "#8e9cd6", "muted-2": "#98a5dd", "muted-3": "#6e7db8",
  accent: "#9bbcff", "accent-bg": "#263a86", "accent-bg-2": "#1d2c6a", "accent-border": "#5f86e6", "accent-solid": "#4a6bf0",
  pos: "#7ee787", neg: "#ff8f8f", "ok-text": "#8fd9a8", "ok-bg": "#1b3a36", "warn-text": "#f0c674", "warn-bg": "#3b3624", gem: "#7fd6e8", gold: "#e8c76a",
});

const EMBER_VARS = palette({
  bg: "#170d0b", surface: "#231512", "surface-2": "#2e1b16", "surface-3": "#1f120f", popover: "#26160f", "input-bg": "#120a08",
  border: "#4a2a20", "border-2": "#5c342880", "border-3": "#6e4030", "border-faint": "#321d17",
  text: "#fbeee6", "text-2": "#ecd2c2", "text-3": "#d9b9a6", muted: "#b89886", "muted-2": "#c0a090", "muted-3": "#8e7060",
  accent: "#ffb77f", "accent-bg": "#4a2412", "accent-bg-2": "#3a1d10", "accent-border": "#d9742f", "accent-solid": "#d9541e",
  pos: "#8fe08a", neg: "#ff7d6e", "ok-text": "#9be0a0", "ok-bg": "#23361f", "warn-text": "#ffd27a", "warn-bg": "#4a3414", gem: "#7fd6e8", gold: "#f0c870",
});

const GROVE_VARS = palette({
  bg: "#0b1712", surface: "#12261c", "surface-2": "#193326", "surface-3": "#0f2018", popover: "#112419", "input-bg": "#08120d",
  border: "#24503a", "border-2": "#2f6a4a80", "border-3": "#3b8059", "border-faint": "#17342a",
  text: "#e6f6ec", "text-2": "#c6e6d2", "text-3": "#addcbd", muted: "#86b79a", "muted-2": "#90bfa2", "muted-3": "#628a72",
  accent: "#9be8b0", "accent-bg": "#1d4a31", "accent-bg-2": "#163b27", "accent-border": "#4eb877", "accent-solid": "#2f9a5c",
  pos: "#8be88f", neg: "#ff8d85", "ok-text": "#9be8b0", "ok-bg": "#1d4a31", "warn-text": "#e8d078", "warn-bg": "#3f3a1a", gem: "#7fe0d6", gold: "#e8d070",
});

const GILDED_VARS = palette({
  bg: "#100d08", surface: "#1b160d", "surface-2": "#261f12", "surface-3": "#17120a", popover: "#1e1810", "input-bg": "#0c0a06",
  border: "#4a3d1f", "border-2": "#5e4d2680", "border-3": "#77622f", "border-faint": "#2e2512",
  text: "#f6edd6", "text-2": "#e6d7b4", "text-3": "#d2c196", muted: "#ad9d77", "muted-2": "#b6a680", "muted-3": "#86784f",
  accent: "#e8c872", "accent-bg": "#4a3a14", "accent-bg-2": "#3a2e10", "accent-border": "#c9a23c", "accent-solid": "#a8801c",
  pos: "#a8e08a", neg: "#ff8a78", "ok-text": "#b4e29a", "ok-bg": "#28381a", "warn-text": "#f0c85a", "warn-bg": "#4a3a12", gem: "#86d4d8", gold: "#f0cc6a",
}, '"Palatino", "Palatino Linotype", "Book Antiqua", "Times New Roman", serif');

const NEON_VARS = palette({
  bg: "#07080f", surface: "#0e1426", "surface-2": "#141c36", "surface-3": "#0b1020", popover: "#0d1328", "input-bg": "#05060c",
  border: "#124a5c", "border-2": "#17697f80", "border-3": "#1c8aa3", "border-faint": "#0f2433",
  text: "#e2f6ff", "text-2": "#bff0ff", "text-3": "#a6e0f2", muted: "#7fb4c6", "muted-2": "#8cc0d0", "muted-3": "#5b8a9a",
  accent: "#5ef0ff", "accent-bg": "#0b3a4a", "accent-bg-2": "#0a2f3d", "accent-border": "#1cc6e0", "accent-solid": "#0a9ab5",
  pos: "#5dffa0", neg: "#ff6aa8", "ok-text": "#5dffa0", "ok-bg": "#0c3a2a", "warn-text": "#ffe14d", "warn-bg": "#3a3410", gem: "#5ef0ff", gold: "#ffd84d",
}, 'ui-monospace, "SF Mono", Menlo, Consolas, monospace');

const CREST_VARS = palette({
  bg: "#101219", surface: "#181b25", "surface-2": "#202433", "surface-3": "#141720", popover: "#181b25", "input-bg": "#0c0e14",
  border: "#2d3346", "border-2": "#3a415a80", "border-3": "#4a5270", "border-faint": "#1e2231",
  text: "#e9ecf6", "text-2": "#d0d6ea", "text-3": "#b8c0da", muted: "#8e97b4", "muted-2": "#98a1bc", "muted-3": "#6c7592",
  accent: "#d4dcf0", "accent-bg": "#2b3350", "accent-bg-2": "#222842", "accent-border": "#6b78a8", "accent-solid": "#4a5aa8",
  pos: "#86c796", neg: "#ef8d73", "ok-text": "#86c796", "ok-bg": "#1e3a2a", "warn-text": "#f0c674", "warn-bg": "#3d3320", gem: "#7db8ef", gold: "#f4d98a",
});

/**
 * A thin bar fixed to the top edge of the window, shared by the themes that have
 * one (ember, gilded, crest). The ::before sits above the page but ignores clicks.
 */
function topBar(theme: string, background: string): string {
  return `:root[data-theme="${theme}"] body::before { content: ""; position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 50; pointer-events: none; background: ${background}; }`;
}

/** The per-theme decorations on top of the palettes: glows, hatching, scanlines, top bars. */
const EXTRA_CSS = [
  // Ember: a glow rising from the bottom-left corner, a hot bar along the top.
  `:root[data-theme="ember"] body { background-image: radial-gradient(120% 60% at 0% 100%, rgba(255, 105, 40, 0.14), transparent 60%); background-attachment: fixed; }`,
  topBar("ember", "linear-gradient(90deg, #ffa23c, #ff4d2e 65%, transparent)"),
  // Grove: fine diagonal hatching and soft light from the top right.
  `:root[data-theme="grove"] body { background-image: repeating-linear-gradient(135deg, rgba(150, 235, 175, 0.035) 0 2px, transparent 2px 10px), radial-gradient(90% 50% at 100% 0%, rgba(110, 220, 150, 0.12), transparent 65%); background-attachment: fixed; }`,
  // Gilded: a gold rule along the top and a faint warm light from above.
  `:root[data-theme="gilded"] body { background-image: radial-gradient(130% 60% at 50% 0%, rgba(232, 196, 110, 0.09), transparent 65%); background-attachment: fixed; }`,
  topBar("gilded", "linear-gradient(90deg, transparent, #e8c872 20%, #e8c872 80%, transparent)"),
  // Neon: scanlines, with a cyan glow top-left and a magenta one bottom-right.
  `:root[data-theme="neon"] body { background-image: repeating-linear-gradient(0deg, rgba(120, 255, 255, 0.035) 0 1px, transparent 1px 3px), radial-gradient(70% 50% at 0% 0%, rgba(0, 226, 255, 0.1), transparent 60%), radial-gradient(70% 50% at 100% 100%, rgba(255, 40, 170, 0.1), transparent 60%); background-attachment: fixed; }`,
  // Five Colors: a bar through all five Magic colors along the top.
  topBar("crest", "linear-gradient(90deg, #f4efd6 0 20%, #7db8ef 20% 40%, #a99bb0 40% 60%, #ef8d73 60% 80%, #86c796 80%)"),
].join("\n");

export const PAGE_THEME_CSS = `
:root { ${DARK_VARS} }
:root[data-theme="light"] { ${LIGHT_VARS} }
:root[data-theme="retro"] { ${RETRO_VARS} }
:root[data-theme="blue"] { ${BLUE_VARS} }
:root[data-theme="ember"] { ${EMBER_VARS} }
:root[data-theme="grove"] { ${GROVE_VARS} }
:root[data-theme="gilded"] { ${GILDED_VARS} }
:root[data-theme="neon"] { ${NEON_VARS} }
:root[data-theme="crest"] { ${CREST_VARS} }
${EXTRA_CSS}
@media (prefers-color-scheme: light) {
  :root[data-theme="system"] { ${LIGHT_VARS} }
}
/* The white-mana dot is nearly the page color on a light page - give the dots a thin ring there. */
:root[data-theme="light"] .dot, :root[data-theme="light"] .color-dot { box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28); }
@media (prefers-color-scheme: light) {
  :root[data-theme="system"] .dot, :root[data-theme="system"] .color-dot { box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28); }
}
/* Retro: square corners everywhere except the round color dots/swatches. */
:root[data-theme="retro"] *:not([class*="dot"]):not([class*="swatch"]) { border-radius: 0 !important; }
`;

/**
 * Marks a finished, full page (one with <html> and </head>) with the chosen
 * theme and adds the theme's variables. Anything else (a fragment) is
 * returned unchanged. An unknown or missing theme means the default.
 */
export function applyPageTheme(html: string, theme: unknown): string {
  if (!/<\/head>/i.test(html)) return html;
  const key = normalizePageTheme(theme);
  const marked = html.replace(/<html([^>]*)>/i, (_m, attrs: string) => `<html${attrs.replace(/\sdata-theme="[^"]*"/i, "")} data-theme="${key}">`);
  return marked.replace(/<\/head>/i, `<style id="page-theme">${PAGE_THEME_CSS}</style>\n</head>`);
}
