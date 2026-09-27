#!/usr/bin/env node
/**
 * O2-061: a size guard for the web build, chained into `npm run check` after `npm run build`.
 *
 *   node scripts/bundle-budget.mjs [distDir]      (default: apps/web/dist)
 *
 * Fails (exit 1) when
 *   - a JS chunk grows past its budget by more than TOLERANCE (10%). Chunks are named without their content hash;
 *     the page's entry script (from index.html) is "entry". A chunk with no budget of its own gets OTHER_BUDGET, so a
 *     new heavy chunk is noticed too.
 *   - three.js (or anything 3D) reaches a phone chunk: the phone routes' static import closure must not contain
 *     three, troika, 3d-tiles, Stage, XRPage or GalleryPage (phone routes load no 3D, doc 07).
 *
 * The budgets are the sizes at R2-WP-17 (raw bytes of the minified JS, not gzip). When a chunk grows on purpose,
 * raise its budget here in the same change. BUNDLE_BUDGET_SCALE=0.5 (for example) shrinks every budget, to check
 * that the guard bites.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KB = 1000;
const BUDGETS = {
  three: 641 * KB,
  react: 224 * KB,
  "3d-tiles": 159 * KB,
  troika: 123 * KB,
  Stage: 80 * KB,
  TripShell: 72 * KB, // + Quest-first: "Let this headset in?" (HeadsetAsk), the seal-PIN step on Seal, the headset seat's larger screens
  entry: 44 * KB,
  socket: 42 * KB,
  browser: 26 * KB, // @simplewebauthn/browser (lazy, the seal/passkey flow only)
  XRPage: 76 * KB, // + VR chart room (lens-shell / Cardboard): gaze input, room rig, iOS motion + lens settings; + Quest-first: the side panel (canvas UI kit, trip / crew / terms / seal views, keyboard), globe spin + pins, MR recenter + alignment, headset seats
  cardboard: 172 * KB, // webxr-polyfill (lazy: the headset route's Cardboard fallback only)
  index: 9.5 * KB, // qrcode (lazy, the headset code card)
  tripstore: 9.5 * KB, // + the seating plan for 2–12 (shared-ui/seating.ts: exclusion windows, even spread, two-ring fallback, flag tiers)
  Create: 13 * KB, // the course pickers: ports by region + Surprise me + any city (CitySearch), regions / states, the date-range calendar + trip length
  shared: 10 * KB, // @all-ayes/shared + dates.ts (date ranges, availability, generated window ids/labels; docs/04 §4.12)
};
const OTHER_BUDGET = 8 * KB;
const TOLERANCE = 0.10;
const PHONE_ROOTS = ["entry", "TripShell", "Landing", "Join", "Create", "Demo"];
const NO_3D = ["three", "troika", "3d-tiles", "Stage", "XRPage", "GalleryPage"];

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.argv[2] ?? join(here, "..", "apps", "web", "dist"));
const scale = Number(process.env.BUNDLE_BUDGET_SCALE ?? 1);
if (!Number.isFinite(scale) || scale <= 0) fail([`BUNDLE_BUDGET_SCALE must be a positive number (got ${process.env.BUNDLE_BUDGET_SCALE})`]);
const assets = join(dist, "assets");
if (!existsSync(assets)) fail([`no build at ${dist} (run \`npm run build\` first)`]);

const html = readFileSync(join(dist, "index.html"), "utf8");
const entryFile = /<script[^>]+src="\/?assets\/([^"]+\.js)"/.exec(html)?.[1];
if (!entryFile) fail(["index.html has no entry <script src=\"/assets/…\">"]);

/** "TripShell-GDFlMXf4.js" → "TripShell" (rollup's default `[name]-[hash].js`; the hash is 8 url-safe chars). */
const nameOf = (file) => (file === entryFile ? "entry" : file.replace(/-[\w-]{8}\.js$/, ""));
const files = readdirSync(assets).filter((f) => f.endsWith(".js"));
const chunks = new Map(files.map((f) => [f, { name: nameOf(f), bytes: statSync(join(assets, f)).size, src: readFileSync(join(assets, f), "utf8") }]));

const problems = [];
const rows = [];

// 1) sizes
for (const [file, c] of chunks) {
  const budget = (BUDGETS[c.name] ?? OTHER_BUDGET) * scale;
  const limit = budget * (1 + TOLERANCE);
  const over = c.bytes > limit;
  rows.push({ name: c.name, file, bytes: c.bytes, budget, over });
  if (over) problems.push(`${c.name} (${file}) is ${kb(c.bytes)}, over its ${kb(budget)} budget by more than ${TOLERANCE * 100}% (limit ${kb(limit)})`);
}

// 2) no 3D in a phone chunk: follow static imports (`from"./x.js"`, `import"./x.js"`) from every phone route
const staticImports = (src) => [...src.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]);
const byName = new Map();
for (const [file, c] of chunks) byName.set(c.name, [...(byName.get(c.name) ?? []), file]);
for (const root of PHONE_ROOTS) {
  const start = byName.get(root) ?? [];
  if (!start.length && root !== "entry") problems.push(`phone route chunk "${root}" not found (renamed? update PHONE_ROOTS in scripts/bundle-budget.mjs)`);
  const seen = new Set(), path = new Map(start.map((f) => [f, [f]]));
  const queue = [...start];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f) || !chunks.has(f)) continue;
    seen.add(f);
    const c = chunks.get(f);
    if (NO_3D.includes(c.name)) problems.push(`the phone route "${root}" statically loads ${c.name}: ${path.get(f).join(" → ")}`);
    for (const dep of staticImports(c.src)) if (!path.has(dep)) { path.set(dep, [...path.get(f), dep]); queue.push(dep); }
  }
}

rows.sort((a, b) => b.bytes - a.bytes);
const width = Math.max(...rows.map((r) => r.name.length));
console.log(`bundle budget (${dist}${scale !== 1 ? `, budgets ×${scale}` : ""})`);
for (const r of rows) console.log(`  ${r.over ? "✗" : "✓"} ${r.name.padEnd(width)} ${kb(r.bytes).padStart(9)} / ${kb(r.budget).padStart(9)}`);
if (problems.length) fail(problems);
console.log(`bundle budget ok: ${rows.length} chunks within ${TOLERANCE * 100}% of budget; no 3D in a phone route`);

function kb(n) { return `${(n / KB).toFixed(1)} kB`; }
function fail(msgs) {
  for (const m of msgs) console.error(`bundle budget: ${m}`);
  process.exit(1);
}
