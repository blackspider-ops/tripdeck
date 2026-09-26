/**
 * WP-09 contract test (OPT-067, TR3-004/005/006/007/013, SEC-020).
 *  - every event the server sends (live over the bus, and on replay) is in the shared ServerToClient contract;
 *  - private events and `error` never go to the trip room; a failed table is a public `table:failed`, not an `error`;
 *  - every ClientToServer event has an io.ts handler, and every ServerToClient event a tripStore handler;
 *  - socket refusals carry the event that caused them and answer the ack; bad payloads are BAD_INPUT, not a crash;
 *  - REST: bad bodies are 4xx, unknown /api routes a JSON 404, statuses follow one map.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  Object.assign(process.env, { PACE_SCALE: "0", ELEVENLABS_API_KEY: "", GEMINI_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" });
});
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { io as connect, type Socket } from "socket.io-client";
import {
  CLIENT_TO_SERVER_EVENTS, PRIVATE_EVENTS, SERVER_TO_CLIENT_EVENTS, type Ack, type ClientToServer, type ServerToClient,
} from "@all-ayes/shared";
import { TripService } from "../src/trips/service.js";
import { type Bus } from "../src/trips/records.js";
import { apiRouter } from "../src/api/routes.js";
import { attachRealtime } from "../src/realtime/io.js";
import { NegotiationEngine } from "../src/negotiation/engine.js";
import { SimProvider } from "../src/payments/sim.js";
import { holdForHail } from "./support/holdForHail.js";

let http: Server;
let base = "";
let helm: TripService;
const handlerNames: string[][] = [];
const sent: { room: "trip" | "member"; ev: string }[] = [];

beforeAll(async () => {
  helm = new TripService();
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [5, 10];
  sim.declineMember = "";
  sim.timeoutMember = "";
  const app = express();
  app.use("/api", apiRouter(helm));
  http = createServer(app);
  const io = attachRealtime(http, helm);
  // listeners run in order: by now io.ts has registered its handlers on this socket
  io.on("connection", (s) => handlerNames.push(s.eventNames().map(String)));
  // instrument the bus: every live emit, trip room or member room
  const bus = (helm as unknown as { bus: Bus }).bus;
  helm.attachBus({
    trip: (id, ev, p) => { sent.push({ room: "trip", ev }); bus.trip(id, ev, p); },
    member: (id, ev, p) => { sent.push({ room: "member", ev }); bus.member(id, ev, p); },
    evict: (id) => bus.evict?.(id),
  });
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://localhost:${(http.address() as AddressInfo).port}`;
});
const sockets: Socket[] = [];
afterAll(() => new Promise<void>((r) => {
  for (const s of sockets) s.close();
  http.closeAllConnections?.();
  http.close(() => r());
}));
afterEach(() => vi.restoreAllMocks());

const known = new Set<string>(SERVER_TO_CLIENT_EVENTS);
const isPrivate = (ev: string) => (PRIVATE_EVENTS as readonly string[]).includes(ev);

async function req(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + "/api" + path, { method, body, headers });
  const text = await res.text();
  let json: { code?: string; message?: string } = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, type: res.headers.get("content-type") ?? "", json };
}
const postJson = (path: string, v: unknown, token?: string) =>
  req("POST", path, JSON.stringify(v), { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

type Seed = { tripId: string; joinCode: string; organizer: { memberToken: string; memberId: string }; maya: { memberToken: string; memberId: string }; dev: { memberId: string } };

function client(join: Record<string, unknown>) {
  const s: Socket<ServerToClient, ClientToServer> = connect(base, { path: "/socket.io", transports: ["websocket"], forceNew: true });
  sockets.push(s as Socket);
  const events: { ev: string; p: any }[] = [];
  s.onAny((ev, p) => events.push({ ev, p }));
  const joined = new Promise<Ack>((resolve) => s.on("connect", () => s.emit("trip:join", join as never, resolve)));
  const waitFor = (pred: (e: { ev: string; p: any }) => boolean, ms = 15000) => new Promise<any>((resolve, reject) => {
    const hit = events.find(pred);
    if (hit) return resolve(hit.p);
    const t = setTimeout(() => reject(new Error("timeout; saw: " + events.map((e) => e.ev).join(","))), ms);
    s.onAny((ev, p) => { if (pred({ ev, p })) { clearTimeout(t); resolve(p); } });
  });
  /** emit with an ack (TR3-007): resolves with the server's answer */
  const ask = <K extends keyof ClientToServer>(ev: K, p: unknown) =>
    new Promise<Ack>((resolve) => (s.emit as (e: K, p: unknown, a: (r: Ack) => void) => void)(ev, p, resolve));
  return { s, events, joined, waitFor, ask };
}

describe("OPT-067: the event contract", () => {
  it("a full voyage + replay emits only contract events; private ones and `error` never reach the trip room", async () => {
    const seed = (await postJson("/demo/seed?kind=expo", {})).json as unknown as Seed;
    const rae = client({ tripId: seed.tripId, memberToken: seed.organizer.memberToken, surface: "phone" });
    const maya = client({ tripId: seed.tripId, memberToken: seed.maya.memberToken, surface: "phone" });
    const gallery = client({ joinCode: seed.joinCode, surface: "gallery" });
    // R2-WP-07 / L3-001: the join ack names the role it resolved
    expect(await rae.joined).toEqual({ ok: true, as: "member" });
    expect(await maya.joined).toEqual({ ok: true, as: "member" });
    expect(await gallery.joined).toEqual({ ok: true, as: "spectator" });

    const release = holdForHail(helm); // O2-062: PACE_SCALE=0; the first Watch-1 line waits for the hail instead
    expect(await rae.ask("table:start", {})).toEqual({ ok: true });
    await rae.waitFor((e) => e.ev === "turn:new" && e.p.act === "PROPOSE"); // L4-005: hails open at Watch 1
    expect(await rae.ask("table:hail", { text: "I'd pay more for the beach." })).toEqual({ ok: true });
    await gallery.waitFor((e) => e.ev === "table:decided");
    release();
    await rae.waitFor((e) => e.ev === "dryrun:script");
    expect(await rae.ask("dryrun:control", { action: "pause" })).toEqual({ ok: true });
    expect(await maya.ask("plan:vote", { planId: "LIS-W1-casa-alfama" })).toEqual({ ok: true });
    expect(await rae.ask("plan:pick", { planId: "LIS-W1-casa-alfama" })).toEqual({ ok: true });
    const booking = await rae.waitFor((e) => e.ev === "booking:created");
    expect(typeof booking.serverNow).toBe("number"); // the seal countdown's clock mapping
    await rae.waitFor((e) => e.ev === "seal:private");
    expect(await rae.ask("seal:set", { bookingId: booking.bookingId })).toEqual({ ok: true });
    expect(await maya.ask("seal:set", { bookingId: booking.bookingId })).toEqual({ ok: true });
    await gallery.waitFor((e) => e.ev === "booking:result");

    // replay, for a member and for a spectator
    const replayed: string[] = [];
    await helm.replayer.replay(helm.trip(seed.tripId), (ev) => replayed.push(ev), seed.maya.memberId);
    await helm.replayer.replay(helm.trip(seed.tripId), (ev) => replayed.push(ev));

    const all = [...sent.map((e) => e.ev), ...replayed, ...[rae, maya, gallery].flatMap((c) => c.events.map((e) => e.ev))];
    expect(all.filter((ev) => !known.has(ev))).toEqual([]);
    expect(sent.filter((e) => e.room === "trip" && (isPrivate(e.ev) || e.ev === "error"))).toEqual([]);
    // the spectator saw nothing private
    expect(gallery.events.filter((e) => isPrivate(e.ev))).toEqual([]);
    // the run exercised most of the contract (not just trip:state)
    expect(new Set(all).size).toBeGreaterThanOrEqual(12);
    for (const c of [rae, maya, gallery]) c.s.close();
  }, 30000);

  it("TR3-007: a failed table is a public table:failed, never a room-wide error", async () => {
    vi.spyOn(NegotiationEngine.prototype, "run").mockRejectedValue(new Error("model down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seed = (await postJson("/demo/seed?kind=expo", {})).json as unknown as Seed;
    const gallery = client({ joinCode: seed.joinCode, surface: "gallery" });
    const rae = client({ tripId: seed.tripId, memberToken: seed.organizer.memberToken, surface: "phone" });
    await gallery.joined; await rae.joined;
    const before = sent.length;
    expect(await rae.ask("table:start", {})).toEqual({ ok: true });
    expect(await gallery.waitFor((e) => e.ev === "table:failed")).toEqual({ code: "TABLE_FAILED", message: expect.any(String) });
    await gallery.waitFor((e) => e.ev === "trip:state" && e.p.status === "BRIEFING");
    expect(sent.slice(before).filter((e) => e.ev === "error")).toEqual([]);
    expect(gallery.events.filter((e) => e.ev === "error")).toEqual([]);
    for (const c of [rae, gallery]) c.s.close();
  });

  it("every ClientToServer event has an io.ts handler", async () => {
    const c = client({ joinCode: "NOPE00", surface: "gallery" });
    await c.joined;
    const names = handlerNames.at(-1)!;
    expect(CLIENT_TO_SERVER_EVENTS.filter((ev) => !names.includes(ev))).toEqual([]);
    c.s.close();
  });

  it("every ServerToClient event has a tripStore handler (static check of the web client)", () => {
    const src = readFileSync(new URL("../../web/src/net/tripStore.ts", import.meta.url), "utf8");
    // R2-WP-16 (O2-021): the handlers are the keys of tripStore's pure `reducers` map (`"trip:state": (st, p) => …`)
    const map = src.slice(src.indexOf("export const reducers"));
    const handled = new Set([...map.matchAll(/^ {2}"?([a-zA-Z:]+)"?: \(/gm)].map((m) => m[1]));
    expect(SERVER_TO_CLIENT_EVENTS.filter((ev) => !handled.has(ev))).toEqual([]);
  });
});

describe("TR3-007 / SEC-020: socket refusals", () => {
  it("answer the ack and name the event; bad payloads are BAD_INPUT without a stack in the log", async () => {
    const err = vi.spyOn(console, "error");
    const seed = (await postJson("/demo/seed?kind=expo", {})).json as unknown as Seed;
    const loner = client({ joinCode: "NOPE00", surface: "gallery" });
    expect(await loner.joined).toMatchObject({ ok: false, code: "NO_TRIP" });
    expect(await loner.ask("plan:pick", { planId: "x" })).toMatchObject({ ok: false, code: "NOT_JOINED" });
    expect(await loner.waitFor((e) => e.ev === "error" && e.p.event === "plan:pick")).toMatchObject({ code: "NOT_JOINED" });

    const rae = client({ tripId: seed.tripId, memberToken: seed.organizer.memberToken, surface: "phone" });
    await rae.joined;
    expect(await rae.ask("brief:submit", { capCents: 90_000, dateWindowIds: "W1" })).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect(await rae.ask("table:sailWithout", { memberIds: 7 })).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect(await rae.ask("plan:vote", { planId: { $ne: 1 } })).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect(await rae.ask("seal:set", "not an object")).toMatchObject({ ok: false, code: "BAD_INPUT" });
    // an unknown dry-run action used to be a silent no-op: now it is refused
    expect(await rae.ask("dryrun:control", { action: "dance" })).toMatchObject({ ok: false, code: "BAD_INPUT" });
    // an action that changes nothing still resolves its ack
    expect(await rae.ask("crew:setOpen", { open: true })).toEqual({ ok: true });
    expect(err.mock.calls.filter((c) => String(c[0]).startsWith("[io]"))).toEqual([]);
    for (const c of [loner, rae]) c.s.close();
  });
});

describe("TR3-005 / TR3-006 / TR3-013: REST errors", () => {
  it("bad bodies are 4xx with a code, and nothing is logged as a crash", async () => {
    const err = vi.spyOn(console, "error");
    const bad = await req("POST", "/trips", "{bad", { "Content-Type": "application/json" });
    expect([bad.status, bad.json.code]).toEqual([400, "BAD_JSON"]);
    const text = await req("POST", "/trips", "hello", { "Content-Type": "text/plain" });
    expect(text.status).toBeGreaterThanOrEqual(400);
    expect(text.status).toBeLessThan(500);
    const pair = await req("POST", "/xr/pair", "hello", { "Content-Type": "text/plain" });
    expect([pair.status, pair.json.code]).toEqual([403, "BAD_CODE"]);
    const big = await req("POST", "/trips", JSON.stringify({ name: "x".repeat(70_000) }), { "Content-Type": "application/json" });
    expect([big.status, big.json.code]).toEqual([413, "TOO_LARGE"]);
    const arr = await req("POST", "/trips", "[1,2]", { "Content-Type": "application/json" });
    expect(arr.status).toBe(422);
    expect(err.mock.calls.filter((c) => String(c[0]).startsWith("[api]"))).toEqual([]);
  });

  it("an unknown /api route is a JSON 404", async () => {
    for (const path of ["/nope", "/trips/by-code/", "/trips/x/y/z"]) {
      const r = await req("GET", path);
      expect(r.status).toBe(404);
      expect(r.type).toMatch(/json/);
      expect(r.json.code).toMatch(/NOT_FOUND|NO_TRIP/);
    }
  });

  it("a missing voyage is 404 before any auth check; conflicts are 409; bad input 422", async () => {
    expect((await postJson("/trips/nope/absent", { name: "x", band: 2, origin: "ATL" })).json.code).toBe("NO_TRIP");
    expect((await postJson("/trips/nope/absent", {})).status).toBe(404);
    expect((await req("GET", "/trips/nope/passkey")).status).toBe(404);
    const t = (await postJson("/trips", { name: "Map", organizerName: "Rae", band: 1, origin: "ATL" })).json as unknown as { tripId: string };
    const taken = await postJson(`/trips/${t.tripId}/members`, { name: "Maya", band: 1, origin: "ORD" });
    expect([taken.status, taken.json.code]).toEqual([409, "BAND_TAKEN"]);
    const noName = await postJson(`/trips/${t.tripId}/members`, { name: "", band: 2, origin: "ORD" });
    expect([noName.status, noName.json.code]).toEqual([422, "BAD_INPUT"]);
    const notOrg = await postJson(`/trips/${t.tripId}/absent`, { name: "x", band: 2, origin: "ATL" }, "wrong-token");
    expect([notOrg.status, notOrg.json.code]).toEqual([403, "NOT_ORGANIZER"]);
  });
});

describe("R2-WP-08: join handshake and socket loose ends", () => {
  it("L3-002: the join ack doesn't wait for a slow memory recall; an action sent on the ack is answered before the memory lines", async () => {
    const seed = (await postJson("/demo/seed?kind=expo", {})).json as unknown as Seed;
    // O2-062: the recall is held open until the test releases it (was a 1.5 s timer), so "doesn't wait" is exact
    let recall!: () => void;
    const recalled = new Promise<string[]>((r) => { recall = () => r(["voyage: Lisbon · booked"]); });
    vi.spyOn(helm, "memoryFor").mockImplementation(() => recalled);
    const rae = client({ tripId: seed.tripId, memberToken: seed.organizer.memberToken, surface: "phone" });
    await new Promise<void>((r) => rae.s.on("connect", () => r()));
    const connectedAt = Date.now();
    expect(await rae.joined).toEqual({ ok: true, as: "member" });
    expect(Date.now() - connectedAt).toBeLessThan(500); // the ack came back while the recall is still pending
    const briefs = () => rae.events.filter((e) => e.ev === "brief:private");
    expect(briefs()).toHaveLength(1); // the replay proper: brief without memory, sent before the ack
    expect(briefs()[0].p.memory).toBeUndefined();
    expect(await rae.ask("crew:setOpen", { open: true })).toEqual({ ok: true });
    expect(briefs()).toHaveLength(1); // still no memory lines: the recall hasn't answered yet
    recall();
    const late = await rae.waitFor((e) => e.ev === "brief:private" && Array.isArray(e.p.memory));
    expect(late.memory).toEqual(["voyage: Lisbon · booked"]);
    rae.s.close();
  });

  it("L3-004: crew:setOpen needs a boolean; client:log is never acked; an unknown event's ack is answered; headset:unpair is gone", async () => {
    const seed = (await postJson("/demo/seed?kind=expo", {})).json as unknown as Seed;
    const rae = client({ tripId: seed.tripId, memberToken: seed.organizer.memberToken, surface: "phone" });
    await rae.joined;
    expect(await rae.ask("crew:setOpen", { open: "true" })).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect(await rae.ask("crew:setOpen", { open: 0 })).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect(helm.trip(seed.tripId).crewClosed).toBeFalsy(); // a non-boolean used to close the crew
    let logAck = false;
    (rae.s.emit as (e: string, p: unknown, a: () => void) => void)("client:log", { level: "log", msg: "x" }, () => { logAck = true; });
    expect(await rae.ask("foo:bar" as never, {})).toEqual({ ok: false, code: "UNKNOWN_EVENT", message: expect.any(String) });
    expect(await rae.ask("headset:unpair" as never, {})).toMatchObject({ ok: false, code: "UNKNOWN_EVENT" });
    expect(CLIENT_TO_SERVER_EVENTS).not.toContain("headset:unpair");
    await new Promise((r) => setTimeout(r, 100));
    expect(logAck).toBe(false);
    rae.s.close();
  });

  it("L3-005: a join naming no voyage is BAD_INPUT (not LOADING), and isn't counted as a wrong code", async () => {
    for (const join of [{ surface: "gallery" }, { joinCode: "", surface: "gallery" }, { tripId: null, joinCode: null }]) {
      const c = client(join);
      expect(await c.joined).toMatchObject({ ok: false, code: "BAD_INPUT" });
      c.s.close();
    }
    const nul = client({});
    await nul.joined;
    expect(await nul.ask("trip:join", null)).toMatchObject({ ok: false, code: "BAD_INPUT" });
    nul.s.close();
  });
});
