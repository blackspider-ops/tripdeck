/**
 * R2-WP-05: dev routes and the debug view off-localhost (S2-004 / S2-005).
 * - In dev mode the dev routes open without DEV_KEY to a loopback client only: a tunnel Host, a LAN client behind the
 *   Vite proxy (x-dev-proxy-client), cloudflared's headers or a forwarded-for chain all need the key.
 * - The debug view's `crew-xxxxxx` reference is keyed with a server secret (not sha256 of the public member id), seals
 *   show their public status (no DECLINED), and no instruction/auth refs or decline addressee appear.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "", PUBLIC_BASE_URL: "" }));
vi.mock("../src/memory/memory.js", () => ({
  crewKeyHash: (k: string) => `h:${k}`,
  personKey: (keyHash: string, name: string) => `crew:${keyHash}|${name.trim().toLowerCase()}`,
  validCrewKey: (k: unknown) => typeof k === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(k),
  recall: async () => [],
  remember: async () => undefined,
  rememberAll: async () => undefined,
  budgetBand: () => "mid budget",
}));

import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import express from "express";
import { config } from "../src/config.js";
import { apiRouter } from "../src/api/routes.js";
import { isLoopbackRequest, redactRef } from "../src/api/devAccess.js";
import { TripService } from "../src/trips/service.js";
import type { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";

const KEY = "k".repeat(40);
const saved = { devMode: config.devMode, devKey: config.devKey, production: config.production };
afterEach(() => Object.assign(config, saved));

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean) => { for (let i = 0; i < 1000 && !pred(); i++) await settle(); };
const sha6 = (s: string) => "crew-" + createHash("sha256").update(s).digest("hex").slice(0, 6);

const fakeReq = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as unknown as Request;

describe("S2-004 / S2-005: what counts as a loopback request", () => {
  it("this machine, directly or through the local Vite proxy", () => {
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { host: "localhost:8787" }))).toBe(true);
    expect(isLoopbackRequest(fakeReq("::1", { host: "[::1]:8787" }))).toBe(true);
    expect(isLoopbackRequest(fakeReq("::ffff:127.0.0.1", { host: "127.0.0.1:8787", origin: "http://localhost:5173", referer: "http://localhost:5173/demo" }))).toBe(true);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { host: "localhost:8787", "x-dev-proxy-client": "::1", "x-dev-proxy-host": "localhost:5173" }))).toBe(true);
  });
  it("a tunnel, the LAN, or any forwarder is remote", () => {
    const lo = { host: "localhost:8787" };
    expect(isLoopbackRequest(fakeReq("192.168.1.20", lo))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { host: "a.trycloudflare.com" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { host: "10.0.0.5:8787" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { ...lo, "x-dev-proxy-client": "192.168.1.20", "x-dev-proxy-host": "192.168.1.5:5173" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { ...lo, "x-dev-proxy-client": "127.0.0.1", "x-dev-proxy-host": "a.trycloudflare.com" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { ...lo, "cf-connecting-ip": "203.0.113.9" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { ...lo, "cf-ray": "abc" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { ...lo, "x-forwarded-for": "203.0.113.9, 127.0.0.1" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { ...lo, "x-forwarded-host": "a.trycloudflare.com" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { ...lo, forwarded: "for=203.0.113.9" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { ...lo, origin: "https://a.trycloudflare.com" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { ...lo, origin: "null" }))).toBe(false);
    expect(isLoopbackRequest(fakeReq("127.0.0.1", { host: "localhost.evil.com" }))).toBe(false);
  });
});

describe("S2-004: the debug view in dev mode", () => {
  let http: Server;
  let port = 0;
  const helm = new TripService();
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  let seed: Awaited<ReturnType<typeof seedExpo>>;

  /** node:http so the Host header can be set (fetch won't). */
  const get = (path: string, headers: Record<string, string> = {}, method = "GET") => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject).end();
  });

  beforeAll(async () => {
    const app = express();
    app.use("/api", apiRouter(helm));
    http = createServer(app);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    port = (http.address() as AddressInfo).port;
    // a declined booking: Dev's seal declines, the booking voids
    sim.latency = [1, 2]; sim.timeoutMember = "";
    seed = await seedExpo(helm);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    await until(() => helm.trip(seed.tripId).status === "DRY_RUN");
    sim.declineMember = seed.dev.memberId;
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const bookingId = helm.trip(seed.tripId).bookingId!;
    for (const m of [seed.organizer, seed.maya, seed.dev]) await helm.setSeal(seed.tripId, m.memberId, bookingId).catch(() => undefined);
    await until(() => helm.trip(seed.tripId).status === "VOIDED");
    await settle(30);
  }, 30_000);
  afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));

  it("the voyage really declined (the raw booking says so)", () => {
    const b = helm.payments.bookings.get(helm.trip(seed.tripId).bookingId!)!;
    expect(helm.trip(seed.tripId).status).toBe("VOIDED");
    expect(b.seals.some((s) => s.status === "DECLINED")).toBe(true);
  });

  it("names nobody in a way that can be recomputed, shows no DECLINED, refs or decline addressee", async () => {
    config.devMode = true;
    const { status, body } = await get(`/api/debug/${seed.joinCode}`);
    expect(status).toBe(200);
    const ids = [seed.organizer.memberId, seed.maya.memberId, seed.dev.memberId];
    for (const id of ids) {
      expect(body).not.toContain(sha6(id));
      expect(body).not.toContain(id);
      expect(body).toContain(redactRef(seed.tripId, id));
    }
    expect(body).not.toMatch(/DECLINED|sim_auth_|sim_ins_|sim_card_|over_limit|user_cancelled/);
    expect(body).toMatch(/seal:declinedPrivate<\/td><td>member:\*</);
    // the reference is per voyage too
    expect(redactRef("another-trip", seed.dev.memberId)).not.toBe(redactRef(seed.tripId, seed.dev.memberId));
  });

  it("off-localhost it needs the key, even in dev mode: tunnel Host, LAN client via the proxy, cloudflared", async () => {
    Object.assign(config, { devMode: true, devKey: "" });
    const remote: Record<string, string>[] = [
      { host: "x.trycloudflare.com" },
      { "x-dev-proxy-client": "192.168.1.20", "x-dev-proxy-host": "192.168.1.5:5173" },
      { "x-dev-proxy-client": "127.0.0.1", "x-dev-proxy-host": "x.trycloudflare.com" },
      { "cf-connecting-ip": "203.0.113.9" },
    ];
    for (const h of remote) {
      const r = await get(`/api/debug/${seed.joinCode}`, h);
      expect(r.status, JSON.stringify(h)).toBe(403);
      expect(r.body).not.toContain("crew-");
      expect((await get("/api/demo/seed", h, "POST")).status).toBe(403);
    }
    // with a DEV_KEY set, the header opens it from anywhere
    config.devKey = KEY;
    expect((await get(`/api/debug/${seed.joinCode}`, { host: "x.trycloudflare.com", "x-dev-key": KEY })).status).toBe(200);
    expect((await get(`/api/debug/${seed.joinCode}`, { host: "x.trycloudflare.com", "x-dev-key": "wrong" })).status).toBe(403);
    // /api/health from a tunnel is the public view
    const pub = JSON.parse((await get("/api/health", { host: "x.trycloudflare.com" })).body);
    expect(Object.keys(pub).sort()).toEqual(["degraded", "eleven", "ok"]);
  });
});
