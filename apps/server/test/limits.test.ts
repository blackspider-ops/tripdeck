/**
 * WP-07 abuse limits & resource bounds: spend caps (SEC-005), auth before big bodies (SEC-006), voice cache
 * (OPT-040/TR5-020/OPT-046), spoof-resistant rate limits (SEC-007 + TR3-015/TR2-011/TR3-014/OPT-023),
 * client:log (SEC-014/OPT-030) and bounded maps with O(1) lookups (SEC-015/OPT-043/OPT-044).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class { models = { generateContent: vi.fn(async () => { throw new Error("network must not be called"); }) }; },
  Type: { STRING: "string", OBJECT: "object" },
}));
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { io as connect, type Socket } from "socket.io-client";
import { TripService } from "../src/trips/service.js";
import { apiRouter } from "../src/api/routes.js";
import { attachRealtime } from "../src/realtime/io.js";
import { config } from "../src/config.js";
import { LIMITS, Lru, RateLimiter, clientIp, resetSpend, spend, spendFlags, withTrip } from "../src/util/limits.js";
import { generateLine } from "../src/negotiation/gemini.js";
import { mp3DurationMs, pruneAudioCache, synthesize } from "../src/voice/voice.js";
import { recall } from "../src/memory/memory.js";

const caps = config.limits.spend;
const savedCaps = JSON.parse(JSON.stringify(caps)) as typeof caps;
afterEach(() => {
  Object.assign(caps.daily, savedCaps.daily);
  Object.assign(caps.trip, savedCaps.trip);
  config.gemini.apiKey = "";
  config.eleven.apiKey = "";
  config.backboard.apiKey = "";
  config.limits.trustProxyHops = 0;
  resetSpend();
  vi.restoreAllMocks();
});

// ---------- shared utilities ----------
describe("limits utilities", () => {
  it("Lru forgets the least recently used entry", () => {
    const l = new Lru<string, number>(2);
    l.set("a", 1); l.set("b", 2); l.get("a"); l.set("c", 3);
    expect([...l.keys()]).toEqual(["a", "c"]);
  });

  it("RateLimiter: take counts, blocked/note count only failures, state is bounded", () => {
    const r = new RateLimiter(2, 1000, 3);
    expect(r.take("x", 0)).toBe(true);
    expect(r.take("x", 10)).toBe(true);
    expect(r.take("x", 20)).toBe(false);
    expect(r.retryAfterMs("x", 20)).toBe(980);
    expect(r.take("x", 1001)).toBe(true); // the first hit slid out of the window
    const f = new RateLimiter(2, 1000, 3);
    f.note("y", 0); expect(f.blocked("y", 0)).toBe(false);
    f.note("y", 0); expect(f.blocked("y", 0)).toBe(true);
    for (const k of ["a", "b", "c", "d", "e"]) f.take(k, 0);
    expect(f.keys).toBeLessThanOrEqual(3);
  });

  it("TR3-015: clientIp ignores X-Forwarded-For with 0 hops, and trusts only the proxy's own entry with 1", () => {
    expect(clientIp("::ffff:1.2.3.4", "6.6.6.6", 0)).toBe("1.2.3.4");
    // behind one proxy the client can prepend anything; the proxy appends the real address last
    expect(clientIp("10.0.0.1", "6.6.6.6, 203.0.113.9", 1)).toBe("203.0.113.9");
    expect(clientIp("10.0.0.1", undefined, 1)).toBe("10.0.0.1");
  });

  it("SEC-007 re-audit: IPv6 clients are keyed on their /64, so rotating the interface id can't dodge a limit", () => {
    const a = clientIp("2001:db8:1:2:aaaa:bbbb:cccc:1", undefined, 0);
    expect(a).toBe("2001:db8:1:2::/64");
    expect(clientIp("2001:0db8:0001:0002:ffff:0:0:9", undefined, 0)).toBe(a);
    expect(clientIp("2001:db8:1:2::5", undefined, 0)).toBe(a);
    expect(clientIp("10.0.0.1", "[2001:db8:1:2::77]", 1)).toBe(a);
    expect(clientIp("2001:db8::1", undefined, 0)).toBe("2001:db8:0:0::/64");
    expect(clientIp("2001:db8:1:3::1", undefined, 0)).not.toBe(a);
    // one limiter bucket for the whole /64
    const l = new RateLimiter(2, 60_000);
    expect(l.take(clientIp("2001:db8:1:2::1", undefined, 0))).toBe(true);
    expect(l.take(clientIp("2001:db8:1:2::2", undefined, 0))).toBe(true);
    expect(l.take(clientIp("2001:db8:1:2::3", undefined, 0))).toBe(false);
  });
});

// ---------- SEC-005 spend caps ----------
describe("SEC-005: spend caps fall back to the no-key paths", () => {
  it("counts per voyage and per day; health shows only coarse flags", () => {
    caps.daily.gemini = 3;
    caps.trip.gemini = 2;
    expect(withTrip("T1", () => spend("gemini"))).toBe(true);
    expect(withTrip("T1", () => spend("gemini"))).toBe(true);
    expect(withTrip("T1", () => spend("gemini"))).toBe(false); // voyage budget spent
    expect(spend("gemini", "T2")).toBe(true);
    expect(spendFlags().gemini).toBe("capped");
    expect(spend("gemini", "T3")).toBe(false); // daily budget spent
    expect(spendFlags().tts).toBe("ok");
  });

  it("Gemini over budget → null (template line), no SDK call", async () => {
    config.gemini.apiKey = "test";
    caps.daily.gemini = 0;
    expect(await generateLine({ system: "s", user: "u", temperature: 0, allowChoice: false })).toBeNull();
  });

  it("TTS over budget → null (captions), no network", async () => {
    config.eleven.apiKey = "test";
    caps.daily.tts = 0;
    const f = vi.spyOn(globalThis, "fetch");
    expect(await synthesize("turn-1", "A brand new line nobody cached", "1")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("Backboard over budget → local memory, no network", async () => {
    config.backboard.apiKey = "test";
    caps.daily.backboard = 0;
    const f = vi.spyOn(globalThis, "fetch");
    expect(await recall("crew:nobody|x")).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

// ---------- OPT-040 / TR5-020 / OPT-046 voice ----------
describe("voice cache", () => {
  it("OPT-046: mp3DurationMs scans at most 4 kB past the header", () => {
    const frame = (at: number, len: number) => { const b = Buffer.alloc(len); b[at] = 0xff; b[at + 1] = 0xfb; b[at + 2] = 0x90; return b; };
    expect(mp3DurationMs(frame(100, 16_100))).toBe(Math.round((16_000 * 8) / 128));
    expect(mp3DurationMs(frame(6000, 16_000))).toBeNull(); // sync beyond the 4 kB window is not searched
  });

  it("O2-045: a cache hit reads the mp3's header, not the file, and gives the same length as the whole file", async () => {
    config.eleven.apiKey = "test";
    // an ID3 tag of 5,000 bytes, then the first frame: past a plain 4 kB scan from the file start, found after the tag
    const tag = 5000;
    const mp3 = Buffer.alloc(tag + 10 + 40_000);
    mp3.write("ID3", 0); mp3[6] = 0; mp3[7] = 0; mp3[8] = (tag >> 7) & 0x7f; mp3[9] = tag & 0x7f;
    const at = 10 + tag + 300;
    mp3[at] = 0xff; mp3[at + 1] = 0xfb; mp3[at + 2] = 0x90;
    const whole = mp3DurationMs(mp3)!;
    expect(whole).toBe(Math.round(((mp3.length - at) * 8) / 128));
    const text = "A line whose voice is already cached";
    const key = createHash("sha1").update(`${config.eleven.voices["1"]}|${config.expoMode ? 1.1 : 1.0}|${text}`).digest("hex");
    mkdirSync(join(config.cacheDir, "tts"), { recursive: true });
    writeFileSync(join(config.cacheDir, "tts", `${key}.mp3`), mp3);
    const f = vi.spyOn(globalThis, "fetch");
    expect(await synthesize("turn-h1", text, "1")).toBe(whole);
    expect(await synthesize("turn-h2", text, "1")).toBe(whole); // then from the duration cache
    expect(f).not.toHaveBeenCalled();
    rmSync(join(config.cacheDir, "tts", `${key}.mp3`)); // the next test counts the cache's files
  });

  it("OPT-040: TTS writes one content-addressed file, serves it per turn, and the cache is bounded", async () => {
    config.eleven.apiKey = "test";
    const mp3 = Buffer.alloc(2000); mp3[0] = 0xff; mp3[1] = 0xfb; mp3[2] = 0x90;
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(mp3)));
    expect(await synthesize("turn-a", "Same line", "1")).toBeGreaterThan(0);
    expect(await synthesize("turn-b", "Same line", "1")).toBeGreaterThan(0);
    expect(f).toHaveBeenCalledTimes(1); // second turn hits the cache
    const { audioFile } = await import("../src/voice/voice.js");
    expect(audioFile("turn-a")).toBe(audioFile("turn-b"));
    expect(existsSync(join(config.cacheDir, "audio"))).toBe(false); // no per-turn copies

    const tts = join(config.cacheDir, "tts");
    mkdirSync(join(config.cacheDir, "audio"), { recursive: true });
    writeFileSync(join(config.cacheDir, "audio", "legacy.mp3"), "x");
    const old = new Date(Date.now() - 10_000);
    for (let i = 0; i < 5; i++) { const p = join(tts, `old${i}.mp3`); writeFileSync(p, "x"); utimesSync(p, old, old); }
    const removed = await pruneAudioCache({ maxFiles: 2, maxAgeMs: 3_600_000 });
    expect(removed).toBe(4); // 6 files, keep the 2 most recently used (the fresh line + one old)
    expect(existsSync(audioFile("turn-a")!)).toBe(true);
    expect(existsSync(join(config.cacheDir, "audio"))).toBe(false);
  });
});

// ---------- HTTP + sockets ----------
let http: Server;
let base = "";
let helm: TripService;
beforeAll(async () => {
  helm = new TripService();
  const app = express();
  app.use("/api", apiRouter(helm));
  http = createServer(app);
  attachRealtime(http, helm);
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://localhost:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));

const newCrew = (name = "Rae") => helm.createTrip({ name: "Limits", organizerName: name, band: 2, origin: "ATL" as never });
const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) => fetch(base + "/api" + path, { method: "POST", body, headers });
const json = (v: unknown) => JSON.stringify(v);

describe("SEC-006: big bodies only after auth", () => {
  it("an unauthenticated 2 MB upload is refused 403 before its body is read (the 512 kB parser never ran)", async () => {
    const { trip } = newCrew();
    const res = await post(`/trips/${trip._id}/hail-audio`, new Uint8Array(2_000_000), { "Content-Type": "audio/webm" });
    expect(res.status).toBe(403); // a parser run first would have answered 413
  });

  it("an authenticated 1 MB clip → 413 from Content-Length; a big JSON body → 413, not 500", async () => {
    config.eleven.apiKey = "test";
    const f = vi.spyOn(globalThis, "fetch");
    const { trip, token } = newCrew();
    const res = await post(`/trips/${trip._id}/hail-audio`, new Uint8Array(1_000_000), { "Content-Type": "audio/webm", Authorization: `Bearer ${token}` });
    expect(res.status).toBe(413);
    expect(f.mock.calls.filter(([u]) => String(u).includes("elevenlabs"))).toHaveLength(0);
    const big = await post("/trips", json({ name: "x".repeat(40_000) }), { "Content-Type": "application/json" });
    expect(big.status).toBe(413);
  });

  it("TR3-014: 3 clips within 5 s → the third is 429; STT past the voyage budget → NO_STT", async () => {
    config.eleven.apiKey = "test";
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) =>
      String(u).includes("elevenlabs") ? new Response(json({ text: "somewhere warmer" })) : realFetch(u as never, init));
    const { trip, token } = newCrew();
    const clip = () => post(`/trips/${trip._id}/hail-audio`, new Uint8Array(2000), { "Content-Type": "audio/webm", Authorization: `Bearer ${token}` });
    const statuses = [(await clip()).status, (await clip()).status, (await clip()).status];
    expect(statuses).toEqual([200, 200, 429]);
    const other = newCrew("Maya");
    caps.trip.stt = 0;
    const res = await post(`/trips/${other.trip._id}/hail-audio`, new Uint8Array(2000), { "Content-Type": "audio/webm", Authorization: `Bearer ${other.token}` });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("NO_STT");
  });
});

describe("SEC-014: client:log", () => {
  const join = (p: Record<string, unknown>) => new Promise<Socket>((resolve) => {
    const s: Socket = connect(base, { path: "/socket.io", transports: ["websocket"], forceNew: true });
    s.on("connect", () => s.emit("trip:join", p));
    s.once("trip:state", () => resolve(s));
  });

  it("gallery lines are ignored; member lines are coerced and capped; weird surfaces can't break /api/debug", async () => {
    const { trip, token } = newCrew();
    const gallery = await join({ joinCode: trip.joinCode, surface: { evil: true } });
    gallery.emit("client:log", { level: "error", msg: "seal DECLINED for Maya" });
    const phone = await join({ tripId: trip._id, memberToken: token, surface: "phone" });
    phone.emit("client:log", { level: "x".repeat(20_000), msg: "y".repeat(20_000) });
    for (let i = 0; i < 20; i++) phone.emit("client:log", { level: "warn", msg: `spam ${i}` });
    await new Promise((r) => setTimeout(r, 300));
    const lines = helm.debugLines(trip._id).filter((l) => l.event.startsWith("client:"));
    expect(lines.some((l) => l.summary.includes("DECLINED"))).toBe(false);
    expect(lines[0].event).toBe("client:log");
    expect(lines[0].summary.length).toBeLessThanOrEqual(300);
    expect(lines.length).toBeLessThanOrEqual(5); // 5 per second per socket
    const debug = await fetch(`${base}/api/debug/${trip.joinCode}`);
    expect(debug.status).toBe(200);
    gallery.close(); phone.close();
  });
});

describe("SEC-007: rate limits keyed on the real client address", () => {
  it("TR2-011: successful pairs don't count toward the per-address limit", async () => {
    for (let i = 0; i < 12; i++) {
      const c = newCrew();
      const { code } = helm.headsetCode(c.trip._id, { memberId: c.member._id });
      const res = await post("/xr/pair", json({ code }), { "Content-Type": "application/json" });
      expect(res.status).toBe(200);
    }
  });

  it("rotating X-Forwarded-For doesn't reset the pairing limit (trust proxy = 0 hops)", async () => {
    const statuses: number[] = [];
    const max = LIMITS.http.pairFailPerMinute; // O2-032: the limit tested is the one the router uses
    for (let i = 0; i <= max; i++) {
      const res = await post("/xr/pair", json({ code: "ZZZZZZZ" + (i % 10) }), { "Content-Type": "application/json", "X-Forwarded-For": `10.9.8.${i}` });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, max).every((s) => s === 403)).toBe(true);
    expect(statuses[max]).toBe(429);
  });

  it("wrong join codes are throttled over REST and over sockets", async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= LIMITS.http.lookupMissPerMinute; i++) statuses.push((await fetch(`${base}/api/trips/by-code/QQQQ${i}`)).status);
    expect(statuses.at(-1)).toBe(429);

    const s: Socket = connect(base, { path: "/socket.io", transports: ["websocket"], forceNew: true });
    const errors: string[] = [];
    s.on("error", (e: { code: string }) => errors.push(e.code));
    await new Promise<void>((r) => s.on("connect", () => r()));
    for (let i = 0; i < 50; i++) s.emit("trip:join", { joinCode: `NOPE${i}`, surface: "gallery" });
    await new Promise((r) => setTimeout(r, 300));
    expect(errors).toContain("SLOW_DOWN");
    expect(errors.filter((c) => c === "NO_TRIP").length).toBeLessThanOrEqual(20);
    s.close();
  });
});

describe("SEC-015: bounded maps and O(1) lookups", () => {
  it("join codes and headset codes are looked up without scanning voyages", () => {
    const h = new TripService();
    let last!: ReturnType<typeof newCrew>;
    for (let i = 0; i < 2000; i++) last = h.createTrip({ name: "v", organizerName: "O", band: 2, origin: "ATL" as never });
    const { code } = h.headsetCode(last.trip._id, { memberId: last.member._id });
    h.findByCode("x"); // index built
    const values = vi.spyOn(h.trips, "values");
    expect(h.tripByCode(last.trip.joinCode.toLowerCase())._id).toBe(last.trip._id);
    expect(() => h.pairHeadset("ZZZZZZZZ")).toThrow();
    expect(h.pairHeadset(code).tripId).toBe(last.trip._id);
    expect(() => h.pairHeadset(code)).toThrow(); // single use
    expect(values).not.toHaveBeenCalled();
  });

  it("the sweep evicts idle voyages with their members, briefs and caches; live ones stay", () => {
    const h = new TripService();
    const idle = h.createTrip({ name: "idle", organizerName: "O", band: 2, origin: "ATL" as never });
    const fresh = h.createTrip({ name: "fresh", organizerName: "P", band: 2, origin: "ATL" as never });
    h.chartBooks.set(idle.trip._id, []);
    h.privacy.set(idle.trip._id, {} as never);
    h.clientLog(idle.trip._id, "phone", "log", "hi");
    idle.trip.updatedAt = new Date(Date.now() - config.limits.voyageIdleMs - 1000).toISOString();
    expect(h.sweep()).toEqual([idle.trip._id]);
    expect(h.trips.has(idle.trip._id)).toBe(false);
    expect(h.members.has(idle.member._id)).toBe(false);
    expect(h.chartBooks.has(idle.trip._id)).toBe(false);
    expect(h.privacy.has(idle.trip._id)).toBe(false);
    expect(h.debugLines(idle.trip._id)).toEqual([]);
    expect(h.findByCode(idle.trip.joinCode)).toBeUndefined();
    expect(h.findByCode(fresh.trip.joinCode)?._id).toBe(fresh.trip._id);
  });
});

describe("S2-006 (R2-WP-11): global ceilings on new voyages", () => {
  /** A router of its own (its limiters read the config when it is built), behind one trusted proxy. */
  async function server(limits: Partial<typeof config.limits>) {
    const saved = { ...config.limits };
    Object.assign(config.limits, limits);
    const h = new TripService();
    const app = express();
    app.use("/api", apiRouter(h));
    const srv = createServer(app);
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://localhost:${(srv.address() as AddressInfo).port}/api/trips`;
    config.limits.trustProxyHops = 1;
    const create = (ip: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: json({ name: "Cap", organizerName: "O", band: 2, origin: "ATL" }) });
    const close = () => new Promise<void>((r) => { Object.assign(config.limits, saved); srv.closeAllConnections?.(); srv.close(() => r()); });
    return { h, create, close };
  }

  it("MAX_LIVE_VOYAGES=100: creates from 50 distinct /64s stop at 100 with 503 HELM_FULL; a lone idle voyage is swept after the short TTL", async () => {
    const s = await server({ maxLiveVoyages: 100, createPerMinute: 1000, createPer48PerMinute: 1000 });
    try {
      const statuses: number[] = [];
      let full: { code?: string } = {};
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 50; i++) {
          const res = await s.create(`2001:db8:${i + 1}::${round + 1}`);
          statuses.push(res.status);
          if (res.status === 503) full = (await res.json()) as { code?: string };
        }
      }
      expect(statuses.filter((x) => x === 200)).toHaveLength(100);
      expect(statuses.slice(100).every((x) => x === 503)).toBe(true);
      expect(full.code).toBe("HELM_FULL");
      expect(s.h.trips.size).toBe(100);
      // every one of them is a lone voyage: past VOYAGE_LONE_HOURS the sweep (run by the next create) makes room
      const old = new Date(Date.now() - config.limits.voyageLoneMs - 60_000).toISOString();
      const lone = [...s.h.trips.values()][0];
      lone.updatedAt = old;
      const res = await s.create("2001:db8:99::1");
      expect(res.status).toBe(200);
      expect(s.h.trips.has(lone._id)).toBe(false);
      expect(s.h.trips.size).toBe(100);
    } finally { await s.close(); }
  });

  it("a whole server rate and a per-/48 rate sit next to the per-address one", async () => {
    const all = await server({ maxLiveVoyages: 0, createPerMinute: 5, createPer48PerMinute: 1000 });
    try {
      const st: number[] = [];
      for (let i = 0; i < 6; i++) st.push((await all.create(`203.0.113.${i + 1}`)).status);
      expect(st).toEqual([200, 200, 200, 200, 200, 429]);
    } finally { await all.close(); }
    const net = await server({ maxLiveVoyages: 0, createPerMinute: 1000, createPer48PerMinute: 3 });
    try {
      const st: number[] = [];
      // four /64s of one /48 (a routed /48 has 65,536 of them): the fourth is refused; another /48 isn't
      for (let i = 0; i < 4; i++) st.push((await net.create(`2001:db8:7:${i + 1}::1`)).status);
      st.push((await net.create("2001:db8:8:1::1")).status);
      expect(st).toEqual([200, 200, 200, 429, 200]);
    } finally { await net.close(); }
  });
});

// ---------- R2-WP-12 ----------
describe("R2-WP-12: hail-audio input, pairing buckets, budget reserve", () => {
  const sttReply = (text: string) => {
    const realFetch = globalThis.fetch;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) =>
      String(u).includes("elevenlabs") ? new Response(json({ text })) : realFetch(u as never, init));
  };

  it("L1-010: an empty upload is 422 BAD_INPUT before any rate slot or STT budget is used", async () => {
    config.eleven.apiKey = "test";
    const f = sttReply("somewhere warmer");
    caps.daily.stt = 1;
    const { trip, token } = newCrew();
    const empty = await post(`/trips/${trip._id}/hail-audio`, new Uint8Array(0), { "Content-Type": "audio/webm", Authorization: `Bearer ${token}` });
    expect(empty.status).toBe(422);
    expect((await empty.json()).code).toBe("BAD_INPUT");
    expect(f.mock.calls.filter(([u]) => String(u).includes("elevenlabs"))).toHaveLength(0);
    expect(spendFlags().stt).toBe("ok");
    // the one clip the day allows is still there
    const clip = await post(`/trips/${trip._id}/hail-audio`, new Uint8Array(2000), { "Content-Type": "audio/webm", Authorization: `Bearer ${token}` });
    expect(clip.status).toBe(200);
  });

  it("L1-005: a dictated note keeps 200 characters (?kind=note), a hail 160", async () => {
    config.eleven.apiKey = "test";
    const long = "a".repeat(190) + " end of the note and more words";
    sttReply(long);
    const a = newCrew(), b = newCrew("Maya");
    const note = await post(`/trips/${a.trip._id}/hail-audio?kind=note`, new Uint8Array(2000), { "Content-Type": "audio/webm", Authorization: `Bearer ${a.token}` });
    expect((await note.json()).transcript).toBe(long.slice(0, 200));
    const hail = await post(`/trips/${b.trip._id}/hail-audio`, new Uint8Array(2000), { "Content-Type": "audio/webm", Authorization: `Bearer ${b.token}` });
    expect((await hail.json()).transcript).toHaveLength(160);
  });

  it("S2-008: 300 wrong codes from 30 /64s don't block a fresh address with the right code; a /48 has its own bucket", async () => {
    const h = new TripService();
    const app = express();
    app.use("/api", apiRouter(h));
    const srv = createServer(app);
    await new Promise<void>((r) => srv.listen(0, r));
    config.limits.trustProxyHops = 1;
    const url = `http://localhost:${(srv.address() as AddressInfo).port}/api/xr/pair`;
    const pair = (ip: string, code: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: json({ code }) });
    try {
      const wrong: number[] = [];
      for (let n = 0; n < 30; n++) for (let i = 0; i < 10; i++) wrong.push((await pair(`2001:db8:${n + 100}:1::${i + 1}`, `ZZZZZZZ${i}`)).status);
      expect(wrong.filter((x) => x === 403)).toHaveLength(300);
      const c = h.createTrip({ name: "Pair", organizerName: "O", band: 2, origin: "ATL" as never });
      const { code } = h.headsetCode(c.trip._id, { memberId: c.member._id });
      expect((await pair("2001:db8:999:1::1", code)).status).toBe(200);
      // one /48: 30 wrong codes over three of its /64s, then its fourth /64 is refused; another /48 isn't
      for (let n = 0; n < 3; n++) for (let i = 0; i < 10; i++) await pair(`2001:db8:7:${n + 1}::1`, `YYYYYYY${i}`);
      expect((await pair("2001:db8:7:4::1", "YYYYYYYY")).status).toBe(429);
      expect((await pair("2001:db8:8:1::1", "YYYYYYYY")).status).toBe(403);
    } finally {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("S2-014: abusive voyages use up the unreserved budget; a voyage past the table still gets Gemini from the reserve", () => {
    const h = new TripService();
    apiRouter(h); // registers this helm's voyages for the reserve
    caps.daily.gemini = 10; // 20 % held back → 8 for anyone, 2 more for voyages past the table
    caps.trip.gemini = 3;
    let granted = 0;
    for (let v = 0; v < 10; v++) {
      const abuse = h.createTrip({ name: "Spam", organizerName: "X", band: 2, origin: "ATL" as never });
      for (let i = 0; i < 3; i++) if (spend("gemini", abuse.trip._id)) granted++;
    }
    expect(granted).toBe(8);
    expect(spendFlags().gemini).toBe("reserve");
    const fresh = h.createTrip({ name: "New", organizerName: "Y", band: 2, origin: "ATL" as never });
    expect(spend("gemini", fresh.trip._id)).toBe(false); // a brand-new voyage is outside the reserve
    expect(spend("gemini")).toBe(false); // so is a call outside any voyage
    const legit = h.createTrip({ name: "Real", organizerName: "Z", band: 2, origin: "ATL" as never });
    legit.trip.status = "DRY_RUN";
    expect(spend("gemini", legit.trip._id)).toBe(true);
    expect(spend("gemini", legit.trip._id)).toBe(true);
    expect(spend("gemini", legit.trip._id)).toBe(false); // the whole daily cap is spent now
    expect(spendFlags().gemini).toBe("capped");
  });
});
