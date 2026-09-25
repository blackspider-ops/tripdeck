// S2-005: the dev server (vite.config.ts) binds to localhost unless `npm run dev:lan` opts in, serves only the web app,
// packages/shared and node_modules (never apps/server/data, docs/ or the repo root), and tells the helm who really
// asked for an /api route. Runs the real config in middleware mode (no port, no HMR socket).
import { createServer as createHttp, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
let vite: ViteDevServer;
let http: Server;
let base = "";

beforeAll(async () => {
  vite = await createServer({
    configFile: `${WEB}vite.config.ts`, root: WEB, logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    // O2-067: no dependency pre-bundling crawl (vite.close() waited ~3 s for it); these tests only fetch files
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  http = createHttp(vite.middlewares);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}, 30_000);
afterAll(async () => {
  // fetch keeps its sockets alive; without this, close() (and so the whole web suite) sometimes waited ~3 s for them
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
  await vite.close();
});

const fsUrl = (rel: string) => `${base}/@fs${encodeURI(`${REPO}/${rel}`)}`;

describe("S2-005: the dev server doesn't publish the repo", () => {
  it("binds to localhost by default", () => {
    expect(vite.config.server.host).toBe("localhost");
  });

  it("refuses repo files outside the web app: server data, source, docs, the root package.json, .env", async () => {
    for (const rel of ["package.json", "apps/server/data/memory.json", "apps/server/src/config.ts", "apps/server/package.json", "docs/review-2/TASKS.md", ".env"]) {
      const res = await fetch(fsUrl(rel));
      expect([403, 404], rel).toContain(res.status);
      await res.body?.cancel();
    }
    expect((await fetch(fsUrl("apps/server/package.json"))).status).toBe(403);
  });

  it("still serves the app, packages/shared and dependencies", async () => {
    expect((await fetch(`${base}/src/main.tsx`)).status).toBe(200);
    expect((await fetch(fsUrl("packages/shared/package.json"))).status).toBe(200);
    expect((await fetch(fsUrl("node_modules/react/package.json"))).status).toBe(200);
  });

  it("the /api proxy always overwrites who asked (x-dev-proxy-client / -host), so the helm can refuse remote clients", () => {
    const opts = vite.config.server.proxy?.["/api"];
    const configure = typeof opts === "object" ? opts.configure : undefined;
    expect(configure).toBeTypeOf("function");
    let handler: ((proxyReq: { setHeader(k: string, v: string): void }, req: unknown) => void) | undefined;
    configure!({ on: (_ev: string, fn: typeof handler) => { handler = fn; } } as never, {} as never);
    const set: Record<string, string> = {};
    handler!({ setHeader: (k, v) => { set[k] = v; } }, { socket: { remoteAddress: "192.168.1.20" }, headers: { host: "x.trycloudflare.com", "x-dev-proxy-client": "127.0.0.1" } });
    expect(set).toEqual({ "x-dev-proxy-client": "192.168.1.20", "x-dev-proxy-host": "x.trycloudflare.com" });
  });
});
