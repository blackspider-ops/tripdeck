// OPT-059 / SEC-021: compile the helm to one ESM file (dist/index.js) so production runs plain `node`, without tsx.
// Runtime npm dependencies stay external (installed with `npm ci --omit=dev`); the TypeScript workspace package
// @all-ayes/shared is bundled in. esbuild comes with tsx/vite (dev tooling).
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith("@all-ayes/"));

rmSync(new URL("dist/", root), { recursive: true, force: true });
await build({
  entryPoints: [fileURLToPath(new URL("src/index.ts", root))],
  outfile: fileURLToPath(new URL("dist/index.js", root)),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [...external, ...external.map((d) => `${d}/*`)],
  sourcemap: false,
  logLevel: "info",
});
// data/loader.ts reads dataset.json next to itself (import.meta.url); in the bundle that's dist/
mkdirSync(new URL("dist/", root), { recursive: true });
copyFileSync(new URL("src/data/dataset.json", root), new URL("dist/dataset.json", root));
