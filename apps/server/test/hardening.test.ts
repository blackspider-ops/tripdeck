/**
 * WP-08 production hardening: one production switch that fails closed (SEC-013 / OPT-073), security headers
 * (SEC-012), a minimal public /api/health (SEC-022), header/cookie-only dev access with a redacted debug view
 * (SEC-025), socket origins (SEC-026) and production web serving (OPT-059 / TR3-017).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  Object.assign(process.env, { ELEVENLABS_API_KEY: "", GEMINI_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "", PUBLIC_BASE_URL: "" });
});
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { config, productionProblems, resolveMode } from "../src/config.js";
import { apiRouter } from "../src/api/routes.js";
import { attachRealtime } from "../src/realtime/io.js";
import { TripService } from "../src/trips/service.js";
import { mountWeb, originAllowed, securityHeaders } from "../src/web.js";

const KEY = "k".repeat(40);
const saved = { production: config.production, devMode: config.devMode, devKey: config.devKey, serveWeb: config.serveWeb, publicBaseUrl: config.publicBaseUrl };
afterEach(() => Object.assign(config, saved));

describe("SEC-013 / OPT-073: one production switch, fail closed", () => {
  it("NODE_ENV=development can't switch production off when PUBLIC_BASE_URL is a real host", () => {
    expect(resolveMode({ NODE_ENV: "development", PUBLIC_BASE_URL: "https://allayes.tech" })).toMatchObject({ production: true, dev: false });
    expect(resolveMode({ APP_ENV: "production" })).toMatchObject({ production: true, dev: false });
    expect(resolveMode({ NODE_ENV: "production", APP_ENV: "development" })).toMatchObject({ production: true, dev: false });
  });
  it("dev routes need an explicit dev signal; a bare start is neither", () => {
    expect(resolveMode({})).toMatchObject({ production: false, dev: false });
    expect(resolveMode({ NODE_ENV: "development" })).toMatchObject({ production: false, dev: false });
    expect(resolveMode({ APP_ENV: "development" })).toMatchObject({ production: false, dev: true });
    expect(resolveMode({ npm_lifecycle_event: "dev" })).toMatchObject({ production: false, dev: true });
    expect(resolveMode({ NODE_ENV: "test", PUBLIC_BASE_URL: "http://localhost:8787" })).toMatchObject({ production: false, dev: true });
    // a dev tunnel may say so explicitly
    expect(resolveMode({ APP_ENV: "development", PUBLIC_BASE_URL: "https://x.trycloudflare.com" })).toMatchObject({ production: false, dev: true });
    expect(resolveMode({ PUBLIC_BASE_URL: "https://allayes.tech/path" }).publicBaseUrl).toBe("https://allayes.tech");
  });
  it("production refuses a guessable DEV_KEY or a missing PUBLIC_BASE_URL", () => {
    const ok = { production: true, devKey: KEY, publicBaseUrl: "https://allayes.tech" };
    expect(productionProblems(ok)).toEqual([]);
    expect(productionProblems({ ...ok, devKey: "" })).toEqual([]); // no key = dev routes simply off
    expect(productionProblems({ ...ok, devKey: "change-me" })).toHaveLength(1);
    expect(productionProblems({ ...ok, devKey: "short" })).toHaveLength(1);
    expect(productionProblems({ ...ok, publicBaseUrl: "" })).toHaveLength(1);
    expect(productionProblems({ ...ok, production: false, devKey: "change-me", publicBaseUrl: "" })).toEqual([]);
  });
});

describe("HTTP hardening", () => {
  let http: Server;
  let base = "";
  let dist = "";
  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), "aa-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>All Ayes</title>");
    writeFileSync(join(dist, "assets", "app-abc123.js"), "export {}");
    writeFileSync(join(dist, "assets", "app-abc123.js.map"), "{}");
    writeFileSync(join(dist, "favicon.svg"), "<svg/>");
    const helm = new TripService();
    const app = express();
    app.use(securityHeaders());
    app.use("/api", apiRouter(helm)); // O2-005: its own last handler is the JSON 404
    Object.assign(config, { serveWeb: true, production: true });
    mountWeb(app, dist);
    Object.assign(config, saved);
    http = createServer(app);
    attachRealtime(http, helm);
    await new Promise<void>((r) => http.listen(0, r));
    base = `http://localhost:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));
  const locked = () => Object.assign(config, { devMode: false, devKey: KEY });

  it("SEC-012: security headers on the app and the API; HSTS only in production", async () => {
    for (const path of ["/", "/api/health"]) {
      const res = await fetch(base + path);
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self' blob:");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("same-origin"); // L3-007
      expect(res.headers.get("permissions-policy")).toContain("xr-spatial-tracking=(self)");
    }
    expect((await fetch(base + "/api/health")).headers.get("strict-transport-security")).toBeNull();
    config.production = true;
    expect((await fetch(base + "/api/health")).headers.get("strict-transport-security")).toContain("max-age=31536000");
  });

  it("SEC-022: public health is liveness + coarse booleans; details need the key", async () => {
    locked();
    const pub = await (await fetch(base + "/api/health")).json();
    expect(Object.keys(pub).sort()).toEqual(["degraded", "eleven", "ok"]);
    expect(pub.ok).toBe(true);
    const full = await (await fetch(base + "/api/health", { headers: { "X-Dev-Key": KEY } })).json();
    expect(full).toHaveProperty("voyages");
    expect(full).toHaveProperty("budgets");
  });

  it("SEC-013 / SEC-025: dev routes refuse ?key=, accept the header, and a browser signs in by form → cookie", async () => {
    locked();
    expect((await fetch(`${base}/api/demo/seed`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base}/api/debug/NOPE?key=${KEY}`)).status).toBe(403);
    expect((await fetch(`${base}/api/debug/NOPE`, { headers: { "X-Dev-Key": "wrong" } })).status).toBe(403);
    expect((await fetch(`${base}/api/debug/NOPE`, { headers: { "X-Dev-Key": KEY } })).status).toBe(404); // allowed; no such voyage
    const bad = await fetch(`${base}/api/debug/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ key: "nope", next: "/api/debug/NOPE" }) });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("set-cookie")).toBeNull();
    const ok = await fetch(`${base}/api/debug/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ key: KEY, next: "/api/debug/NOPE" }) });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/api/debug/NOPE");
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/debug/);
    expect((await fetch(`${base}/api/debug/NOPE`, { headers: { cookie: cookie.split(";")[0] } })).status).toBe(404);
    // a forged cookie doesn't pass
    expect((await fetch(`${base}/api/debug/NOPE`, { headers: { cookie: `aa_dev=${Date.now() + 1e6}.forged` } })).status).toBe(403);
    // open redirect guarded
    const off = await fetch(`${base}/api/debug/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ key: KEY, next: "https://evil.example" }) });
    expect(off.headers.get("location")).toBe("/api/debug/login");
  });

  it("SEC-025: the debug view shows no names and no decline reasons", async () => {
    const helm = new TripService();
    const { trip } = helm.createTrip({ name: "Test", organizerName: "Rae Secretname", band: 2, origin: "ATL" });
    const app = express();
    app.use("/api", apiRouter(helm));
    const html = await new Promise<string>((resolve) => {
      const s = app.listen(0, async () => {
        const r = await fetch(`http://localhost:${(s.address() as AddressInfo).port}/api/debug/${trip.joinCode}`);
        resolve(await r.text());
        s.close();
      });
    });
    expect(html).toContain(trip.joinCode);
    expect(html).not.toContain("Secretname");
    expect(html).not.toMatch(/declineReason|INSUFFICIENT|insufficient/i);
  });

  it("TR3-006 / TR3-017: unknown /api/* is a JSON 404; /apiary is an app route", async () => {
    const res = await fetch(base + "/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
    const app = await fetch(base + "/apiary");
    expect(app.status).toBe(200);
    expect(await app.text()).toContain("<title>All Ayes");
  });

  it("OPT-059: hashed assets are immutable, index.html is no-cache, maps and missing files 404", async () => {
    const page = await fetch(base + "/t/ABC123");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(base + "/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await fetch(base + "/favicon.svg")).headers.get("cache-control")).toBe("public, max-age=3600");
    expect((await fetch(base + "/assets/app-abc123.js.map")).status).toBe(404);
    expect((await fetch(base + "/assets/gone-000.js")).status).toBe(404);
  });

  it("SEC-026: a foreign Origin can't open a socket in production; same origin and tokens-only clients can", async () => {
    const poll = (origin?: string) => fetch(`${base}/socket.io/?EIO=4&transport=polling`, { headers: origin ? { origin } : {} });
    config.production = true;
    config.publicBaseUrl = "https://allayes.tech";
    expect((await poll("https://evil.example")).status).toBe(403);
    expect((await poll("http://192.168.1.5:5173")).status).toBe(403);
    expect((await poll("https://allayes.tech")).status).toBe(200);
    expect((await poll(base)).status).toBe(200); // same origin (Origin host = Host)
    expect((await poll()).status).toBe(200);
    config.production = false;
    expect((await poll("http://192.168.1.5:5173")).status).toBe(200); // dev: phones on the LAN via Vite
    expect(originAllowed("https://x.trycloudflare.com")).toBe(true);
    expect(originAllowed("https://evil.example")).toBe(false);
  });
});
