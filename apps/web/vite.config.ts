/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// One .env at the repo root for both apps (envDir below). The config itself reads it too, so API_URL,
// VITE_ALLOWED_HOSTS, VITE_SOURCEMAP and PUBLIC_BASE_URL work from that file; real env vars still win.
const ENV_DIR = "../..";
const fileEnv = loadEnv(process.env.NODE_ENV === "production" ? "production" : "development", ENV_DIR, "");
const envOf = (k: string) => process.env[k] || fileEnv[k] || undefined;

const API = envOf("API_URL") ?? "http://localhost:8787";

// SEC-024: the dev server answers only these hosts (DNS-rebinding protection stays on). localhost is always allowed;
// cloudflared quick tunnels are for the Quest; add a named tunnel or LAN name with VITE_ALLOWED_HOSTS=a.example,b.lan
// (a leading dot allows subdomains). PUBLIC_BASE_URL's host is allowed too.
const hostOf = (u: string | undefined) => { try { return u ? new URL(u).hostname : ""; } catch { return ""; } };
const allowedHosts = [
  "localhost", ".localhost", "127.0.0.1", ".trycloudflare.com",
  hostOf(envOf("PUBLIC_BASE_URL")),
  ...(envOf("VITE_ALLOWED_HOSTS") ?? "").split(",").map((h) => h.trim()),
].filter(Boolean);

// S2-005: the dev server serves files from these folders only (not the repo root, where apps/server/data holds the
// local memory store and docs/ the review notes), and never these, even when something links to them.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const REPO = here("../..");
const globSafe = (p: string) => p.replace(/[*?[\]{}()!+@]/g, "\\$&");
export const devFs = {
  strict: true,
  allow: [here("."), `${REPO}/packages/shared`, `${REPO}/node_modules`],
  deny: [
    ".env", ".env.*", "*.{crt,pem}", "**/.git/**", // Vite's defaults (a custom list replaces them)
    `${globSafe(REPO)}/apps/server/**`, `${globSafe(REPO)}/docs/**`, "**/.cache/**", "**/*.sqlite", "**/*.log",
  ],
};

// S2-004 / S2-005: the helm opens its dev routes without DEV_KEY only to a loopback client. Behind this proxy every
// request comes from 127.0.0.1 with Host rewritten, so say who really asked (always overwritten, never passed through).
type ProxyLike = { on(ev: "proxyReq", fn: (proxyReq: { setHeader(k: string, v: string): void }, req: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }) => void): void };
const markClient = (proxy: ProxyLike) => proxy.on("proxyReq", (proxyReq, req) => {
  proxyReq.setHeader("x-dev-proxy-client", req.socket.remoteAddress ?? "unknown");
  proxyReq.setHeader("x-dev-proxy-host", String(req.headers.host ?? "unknown"));
});

export default defineConfig({
  plugins: [react()],
  // One .env at the repo root for both apps. Vite exposes only VITE_* names to the browser, so the server's keys
  // (GEMINI_API_KEY, MONGODB_URI, …) in the same file never reach the bundle.
  envDir: ENV_DIR,
  server: {
    port: 5173,
    // S2-005: localhost only by default (`npm run dev`); `npm run dev:lan` (vite --host) opts into the LAN. A
    // cloudflared tunnel runs on this machine, so it works with either.
    host: "localhost",
    allowedHosts,
    fs: devFs,
    proxy: {
      "/api": { target: API, changeOrigin: true, configure: (proxy) => markClient(proxy as unknown as ProxyLike) },
      "/socket.io": { target: API, ws: true, changeOrigin: true },
    },
  },
  optimizeDeps: { exclude: ["@all-ayes/shared"] },
  // O2-067: tests run in node by default (pure logic, three.js math); hook/component tests opt into a DOM with a
  // `// @vitest-environment happy-dom` docblock, so the pure suites don't pay for a DOM they never touch.
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
  },
  build: {
    outDir: "dist",
    // SEC-024 / OPT-059: maps are written for local debugging but never referenced (no sourceMappingURL); the server
    // doesn't serve *.map in production either. Set VITE_SOURCEMAP=off to skip them entirely.
    sourcemap: envOf("VITE_SOURCEMAP") === "off" ? false : "hidden",
    // OPT-054: vendor code in its own content-stable chunks (shared by XR and Gallery, cached across deploys)
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // O2-060: the store and the 2D helpers every surface shares (phone, headset, Gallery) under a name that says
          // so, instead of rollup naming the chunk after its first module (it was `labels`, then `timing`)
          // (React and @all-ayes/shared get their own chunks, else rollup would pull them into this one)
          if (/\/src\/(net\/tripStore|shared-ui\/|phone\/timing)/.test(id)) return "tripstore";
          if (/\/packages\/shared\//.test(id)) return "shared";
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (/node_modules\/three\//.test(id)) return "three";
          if (/node_modules\/(troika-|bidi-js|webgl-sdf-generator)/.test(id)) return "troika";
          if (/node_modules\/3d-tiles-renderer\//.test(id)) return "3d-tiles";
          // O2-060: the realtime client (every surface) gets its own content-stable chunk, not one named after
          // whichever app module rollup met first
          if (/node_modules\/(socket\.io-|engine\.io-|@socket\.io\/)/.test(id)) return "socket";
          return undefined;
        },
      },
    },
  },
});
