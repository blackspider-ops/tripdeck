/**
 * Quest-first (docs/03 §4, docs/04 §6): headsets as crew devices. A Quest that starts or joins a voyage takes its own
 * seat; a headset for an existing seat is let in by that seat's own device (one tap, one-time, expiring); any number
 * of headsets sit at one table, each seeing only its own member's private terms; a seal PIN for a headset without
 * passkeys; chart-room pins (course:set).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import type { BriefInput } from "@all-ayes/shared";
import { HEADSET_REQUEST_TTL_MS, SEAL_PIN_LOCK_MS, SEAL_PIN_TRIES } from "@all-ayes/shared";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createHash } from "node:crypto";
import { io as connect, type Socket } from "socket.io-client";
import { TripService } from "../src/trips/service.js";
import type { HelmError } from "../src/util/errors.js";
import { SimProvider } from "../src/payments/sim.js";
import { apiRouter } from "../src/api/routes.js";
import { attachRealtime } from "../src/realtime/io.js";

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean | Promise<boolean>) => { for (let i = 0; i < 600 && !(await pred()); i++) await settle(); };
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };
const BRIEF = (capCents: number): BriefInput => ({ capCents, dateWindowIds: ["W1"], mustHaves: ["food"], dealbreakers: [] });

function helm() {
  const h = new TripService();
  const sim = (h.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const member: { id: string; ev: string; p: any }[] = [];
  h.attachBus({ trip: () => undefined, member: (id, ev, p) => member.push({ id, ev, p }) });
  return { h, member };
}

/** A voyage at SEALING: Rae (organizer) and Maya, both sealed, the first chart picked. */
async function sealing(h: TripService) {
  const { trip, member: rae } = h.createTrip({ name: "Pin", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"], windowIds: ["W1"] });
  const maya = h.join(trip._id, { name: "Maya", band: 2, origin: "ORD", device: "headset" });
  await h.submitBrief(trip._id, rae._id, BRIEF(110_000));
  await h.submitBrief(trip._id, maya.member._id, BRIEF(95_000));
  await h.startTable(trip._id, { memberId: rae._id });
  await until(() => h.trip(trip._id).status === "DRY_RUN");
  await h.pick(trip._id, { memberId: rae._id }, h.trip(trip._id).shortlistIds![0]);
  return { trip, rae, maya: maya.member, bookingId: h.trip(trip._id).bookingId! };
}

afterEach(() => vi.useRealTimers());

describe("seal PIN (a headset without passkeys)", () => {
  it("is 4–6 digits, stored hashed, and then gates the seal: missing → PIN_REQUIRED, wrong → BAD_PIN", async () => {
    const { h } = helm();
    const { trip, maya, rae, bookingId } = await sealing(h);
    expect(await code(() => h.setSealPin(trip._id, maya._id, "12"))).toBe("BAD_INPUT");
    expect(await code(() => h.setSealPin(trip._id, maya._id, "12ab"))).toBe("BAD_INPUT");
    expect(await code(() => h.setSealPin(trip._id, maya._id, "1234567"))).toBe("BAD_INPUT");
    h.setSealPin(trip._id, maya._id, "4821");
    const stored = JSON.stringify(h.members.get(maya._id));
    expect(stored).not.toContain("4821");
    expect(h.members.get(maya._id)!.sealPin!.hash).toMatch(/^[0-9a-f]{64}$/);
    // nobody's PIN appears in the public crew
    expect(JSON.stringify(h.crewPublic(h.trip(trip._id)))).not.toContain("sealPin");

    expect(await code(() => h.setSeal(trip._id, maya._id, bookingId))).toBe("PIN_REQUIRED");
    expect(await code(() => h.setSeal(trip._id, maya._id, bookingId, undefined, "0000"))).toBe("BAD_PIN");
    // a member without a PIN or passkey still seals with a tap
    expect(await code(() => h.setSeal(trip._id, rae._id, bookingId))).toBe("OK");
    expect(await code(() => h.setSeal(trip._id, maya._id, bookingId, undefined, "4821"))).toBe("OK");
    await until(() => h.trip(trip._id).status === "BOOKED");
    expect(h.trip(trip._id).status).toBe("BOOKED");
  });

  it(`locks after ${SEAL_PIN_TRIES} wrong PINs (even the right one is refused) until the lock passes`, async () => {
    const { h } = helm();
    const { trip, maya, bookingId } = await sealing(h);
    h.setSealPin(trip._id, maya._id, "482193");
    for (let i = 1; i < SEAL_PIN_TRIES; i++) expect(await code(() => h.setSeal(trip._id, maya._id, bookingId, undefined, "000000"))).toBe("BAD_PIN");
    expect(await code(() => h.setSeal(trip._id, maya._id, bookingId, undefined, "000000"))).toBe("PIN_LOCKED");
    expect(await code(() => h.setSeal(trip._id, maya._id, bookingId, undefined, "482193"))).toBe("PIN_LOCKED");
    // changing the PIN while locked is refused too (it needs the current PIN)
    expect(await code(() => h.setSealPin(trip._id, maya._id, "1111", "482193"))).toBe("PIN_LOCKED");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + SEAL_PIN_LOCK_MS + 1000);
    expect(await code(() => h.setSeal(trip._id, maya._id, bookingId, undefined, "482193"))).toBe("OK");
    vi.restoreAllMocks();
  });

  it("replacing a PIN needs the current one; a seat reset forgets the PIN and the headset", async () => {
    const { h } = helm();
    const { trip, member: rae } = h.createTrip({ name: "Reset", organizerName: "Rae", band: 1, origin: "ATL" });
    const maya = h.join(trip._id, { name: "Maya", band: 2, origin: "ORD", device: "headset" });
    h.setSealPin(trip._id, maya.member._id, "2468");
    expect(await code(() => h.setSealPin(trip._id, maya.member._id, "1357"))).toBe("BAD_PIN");
    expect(await code(() => h.setSealPin(trip._id, maya.member._id, "1357", "2468"))).toBe("OK");
    expect(h.crewPublic(h.trip(trip._id)).find((c) => c.memberId === maya.member._id)?.onHeadset).toBe(true);
    h.resetSeat(trip._id, { memberId: rae._id }, maya.member._id);
    const m = h.members.get(maya.member._id)!;
    expect(m.sealPin).toBeUndefined();
    expect(m.onHeadset).toBeUndefined();
  });
});

describe("lifting a seal, then setting it again (user report)", () => {
  it("a lifted seal can be set again while others still gather; publicly it read 'set' throughout; the booking then books", async () => {
    const { h, member } = helm();
    const room: { ev: string; p: any }[] = [];
    h.attachBus({ trip: (_t, ev, p) => room.push({ ev, p }), member: (id, ev, p) => member.push({ id, ev, p }) });
    const { trip, rae, maya, bookingId } = await sealing(h);
    await h.setSeal(trip._id, rae._id, bookingId);
    h.cancelSeal(trip._id, rae._id, bookingId);
    expect(member.some((e) => e.id === rae._id && e.ev === "seal:declinedPrivate" && e.p.reason === "user_cancelled")).toBe(true);
    const raeStatuses = () => room.filter((e) => e.ev === "seal:status" && e.p.memberId === rae._id).map((e) => e.p.status);
    expect(raeStatuses()).toEqual(["AUTHORIZED"]); // the lift is invisible to the room
    expect(await code(() => h.setSeal(trip._id, rae._id, bookingId))).toBe("OK");
    expect(raeStatuses()).toEqual(["AUTHORIZED"]); // and so is setting it again
    await h.setSeal(trip._id, maya._id, bookingId);
    await until(() => h.trip(trip._id).status === "BOOKED");
    expect(h.trip(trip._id).status).toBe("BOOKED");
  });

  it("lifted last (every other seal in): it settles and voids; setting it again is refused (SEAL_LOCKED)", async () => {
    const { h } = helm();
    const { trip, rae, maya, bookingId } = await sealing(h);
    await h.setSeal(trip._id, maya._id, bookingId);
    await h.setSeal(trip._id, rae._id, bookingId);
    // everyone's in: settling; a lift now is refused too
    expect(await code(() => h.cancelSeal(trip._id, rae._id, bookingId))).toBe("SEAL_LOCKED");
    await until(() => h.trip(trip._id).status === "BOOKED");
    const t2 = await sealing(h);
    await h.setSeal(t2.trip._id, t2.maya._id, t2.bookingId);
    h.cancelSeal(t2.trip._id, t2.rae._id, t2.bookingId); // the last seal, lifted: the booking settles (and voids)
    expect(await code(() => h.setSeal(t2.trip._id, t2.rae._id, t2.bookingId))).toBe("SEAL_LOCKED");
    await until(() => h.trip(t2.trip._id).status === "VOIDED");
    expect(h.trip(t2.trip._id).status).toBe("VOIDED");
  });
});

describe("chart-room pins (course:set)", () => {
  it("the organizer sets named ports, regions or anywhere; the crew only while crewPins is on; BRIEFING only", async () => {
    const { h } = helm();
    const { trip, member: rae } = h.createTrip({ name: "Pins", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"] });
    const maya = h.join(trip._id, { name: "Maya", band: 2, origin: "ORD" });
    h.setCourse(trip._id, { memberId: rae._id }, { destination: { kind: "cities", cityIds: ["LIS", "MEX", "YUL"] } });
    expect(h.trip(trip._id).candidateCityIds).toEqual(["LIS", "MEX", "YUL"]);
    expect(h.state(h.trip(trip._id)).candidateCities.map((c) => c.cityId)).toEqual(["LIS", "MEX", "YUL"]);
    // at least two ports stay on the chart
    expect(await code(() => h.setCourse(trip._id, { memberId: rae._id }, { destination: { kind: "cities", cityIds: ["LIS"] } }))).toBe("BAD_INPUT");
    expect(await code(() => h.setCourse(trip._id, { memberId: maya.member._id }, { destination: { kind: "anywhere" } }))).toBe("NOT_ORGANIZER");
    h.setCourse(trip._id, { memberId: rae._id }, { crewPins: true });
    expect(h.state(h.trip(trip._id)).crewPins).toBe(true);
    h.setCourse(trip._id, { memberId: maya.member._id }, { destination: { kind: "regions", regions: ["Europe"] } });
    expect(h.trip(trip._id).destination).toEqual({ kind: "regions", regions: ["Europe"] });
    // only the organizer turns crewPins off
    expect(await code(() => h.setCourse(trip._id, { memberId: maya.member._id }, { crewPins: false }))).toBe("NOT_ORGANIZER");
    h.setCourse(trip._id, { memberId: rae._id }, { destination: { kind: "anywhere" } });
    expect(h.trip(trip._id).destination).toEqual({ kind: "anywhere" });
    h.trip(trip._id).status = "AT_TABLE";
    expect(await code(() => h.setCourse(trip._id, { memberId: rae._id }, { destination: { kind: "anywhere" } }))).toBe("BAD_PHASE");
  });
});

describe("over HTTP + Socket.io", () => {
  let http: Server;
  let base = "";
  let h: TripService;
  beforeAll(async () => {
    h = new TripService();
    const sim = (h.payments as unknown as { provider: SimProvider }).provider;
    sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
    const app = express();
    app.use("/api", apiRouter(h));
    http = createServer(app);
    attachRealtime(http, h);
    await new Promise<void>((r) => http.listen(0, r));
    base = `http://localhost:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));

  const call = async (method: string, path: string, body: unknown = {}, token?: string, ip?: string) => {
    const res = await fetch(base + "/api" + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(ip ? { "X-Forwarded-For": ip } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  function client(join: Record<string, unknown>) {
    const s: Socket = connect(base, { path: "/socket.io", transports: ["websocket"], forceNew: true });
    const events: { ev: string; p: any }[] = [];
    s.onAny((ev, p) => events.push({ ev, p }));
    const ack = new Promise<any>((r) => s.on("connect", () => s.emit("trip:join", join, r)));
    const waitFor = async (pred: (e: { ev: string; p: any }) => boolean) => { await until(() => events.some(pred)); return events.find(pred)?.p; };
    const emit = (ev: string, p: unknown) => new Promise<any>((r) => s.emit(ev, p, r));
    return { s, events, ack, waitFor, emit };
  }
  const briefs = (c: { events: { ev: string; p: any }[] }) => c.events.filter((e) => e.ev === "brief:private" && e.p.brief).map((e) => e.p.brief.capCents);

  it("a Quest starts a voyage (its own organizer seat), friends' Quests join by code: N headsets, one table, own terms only", async () => {
    const made = (await call("POST", "/trips", { name: "Quest", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"], device: "headset" })).json;
    const maya = (await call("POST", `/trips/${made.tripId}/members`, { name: "Maya", band: 2, origin: "ORD", device: "headset" })).json;
    const dev = (await call("POST", `/trips/${made.tripId}/members`, { name: "Dev", band: 3, origin: "JFK", device: "headset" })).json;
    const byCode = (await call("GET", `/trips/by-code/${made.joinCode}`)).json;
    expect(byCode.crew.map((c: any) => c.onHeadset)).toEqual([true, true, true]);

    const raeX = client({ tripId: made.tripId, memberToken: made.memberToken, surface: "xr" });
    const mayaX = client({ tripId: made.tripId, memberToken: maya.memberToken, surface: "xr" });
    const devX = client({ tripId: made.tripId, memberToken: dev.memberToken, surface: "xr" });
    // the legacy shared headset (code pairing) still sits at the same table too
    const { code: c } = h.headsetCode(made.tripId, { memberId: made.memberId });
    const pair = (await call("POST", "/xr/pair", { code: c })).json;
    const shared = client({ tripId: made.tripId, deviceToken: pair.deviceToken, surface: "xr" });
    for (const x of [raeX, mayaX, devX]) expect(await x.ack).toEqual({ ok: true, as: "member" });
    expect(await shared.ack).toEqual({ ok: true, as: "device" });

    expect((await raeX.emit("brief:submit", BRIEF(120_000))).ok).toBe(true);
    expect((await mayaX.emit("brief:submit", BRIEF(80_000))).ok).toBe(true);
    // every headset sees the same table state (both sealed flags) …
    for (const x of [raeX, mayaX, devX, shared]) {
      await x.waitFor((e) => e.ev === "trip:state" && e.p.crew.filter((m: any) => m.briefSealed).length === 2);
    }
    await settle(30);
    // … but each headset only ever gets its own member's terms, and the shared one none
    expect(briefs(raeX)).toEqual([120_000]);
    expect(briefs(mayaX)).toEqual([80_000]);
    expect(briefs(devX)).toEqual([]);
    expect(shared.events.some((e) => e.ev === "brief:private")).toBe(false);
    // the organizer's controls go only to the organizer's own headset (and the shared one)
    expect(await mayaX.emit("crew:setOpen", { open: false })).toMatchObject({ ok: false, code: "NOT_ORGANIZER" });
    expect((await raeX.emit("crew:setOpen", { open: false })).ok).toBe(true);
    // the shared (organizer-controls) headset never lifts or sets a seal: those are a member's own
    expect(await shared.emit("seal:cancel", { bookingId: "b" })).toMatchObject({ ok: false, code: "NOT_MEMBER" });
    expect(await shared.emit("seal:set", { bookingId: "b" })).toMatchObject({ ok: false, code: "NOT_MEMBER" });
    for (const x of [raeX, mayaX, devX, shared]) x.s.close();
  });

  it("a headset asks to sit in an existing seat; only that seat's own device lets it in; the key comes once", async () => {
    const made = (await call("POST", "/trips", { name: "Attach", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"] })).json;
    const maya = (await call("POST", `/trips/${made.tripId}/members`, { name: "Maya", band: 2, origin: "ORD" })).json;
    const raePhone = client({ tripId: made.tripId, memberToken: made.memberToken, surface: "phone" });
    const mayaPhone = client({ tripId: made.tripId, memberToken: maya.memberToken, surface: "phone" });
    await raePhone.ack; await mayaPhone.ack;
    expect((await raePhone.emit("brief:submit", BRIEF(130_000))).ok).toBe(true);
    expect((await mayaPhone.emit("brief:submit", BRIEF(70_000))).ok).toBe(true);

    const ask = await call("POST", "/xr/attach", { joinCode: made.joinCode.toLowerCase(), memberId: made.memberId }, undefined, "10.9.0.1");
    expect(ask.status).toBe(200);
    expect(ask.json).toMatchObject({ askName: "Rae", tripId: made.tripId, joinCode: made.joinCode });
    const prompt = await raePhone.waitFor((e) => e.ev === "headset:request" && !e.p.answered);
    expect(prompt).toMatchObject({ requestId: ask.json.requestId, memberName: "Rae" });
    // the request is private to the seat: Maya's phone never sees it
    expect(mayaPhone.events.some((e) => e.ev === "headset:request")).toBe(false);

    const poll = (secret = ask.json.secret) => call("POST", "/xr/attach/status", { requestId: ask.json.requestId, secret }, undefined, "10.9.0.1");
    expect((await poll()).json).toMatchObject({ status: "pending" });
    expect((await poll("wrong")).json.code).toBe("BAD_CODE");
    // someone else can't answer it
    expect(await mayaPhone.emit("headset:approve", { requestId: ask.json.requestId, allow: true })).toMatchObject({ ok: false, code: "BAD_CODE" });
    expect(await raePhone.emit("headset:approve", { requestId: ask.json.requestId, allow: "yes" })).toMatchObject({ ok: false, code: "BAD_INPUT" });
    expect((await raePhone.emit("headset:approve", { requestId: ask.json.requestId, allow: true })).ok).toBe(true);
    await raePhone.waitFor((e) => e.ev === "headset:request" && e.p.answered);
    await raePhone.waitFor((e) => e.ev === "trip:state" && e.p.crew.find((c: any) => c.memberId === made.memberId)?.onHeadset);

    const ok = (await poll()).json;
    expect(ok).toMatchObject({ status: "approved", tripId: made.tripId, memberId: made.memberId });
    expect(ok.deviceToken).toBeTruthy();
    expect(ok.deviceToken).not.toBe(made.memberToken);
    expect((await poll()).json.code).toBe("BAD_CODE"); // handed over once
    // a second approval of the same request is refused
    expect(await raePhone.emit("headset:approve", { requestId: ask.json.requestId, allow: true })).toMatchObject({ ok: false, code: "BAD_CODE" });

    // the headset is Rae: her terms only, and the organizer's controls
    const raeX = client({ tripId: made.tripId, memberToken: ok.deviceToken, surface: "xr" });
    expect(await raeX.ack).toEqual({ ok: true, as: "member" });
    await raeX.waitFor((e) => e.ev === "brief:private");
    await settle(20);
    expect(briefs(raeX)).toEqual([130_000]);
    expect(raeX.events.some((e) => e.ev === "brief:private" && e.p.brief?.capCents === 70_000)).toBe(false);
    // REST as the member, too (the seal-PIN status)
    expect((await call("GET", `/trips/${made.tripId}/seal-pin`, undefined, ok.deviceToken)).json).toEqual({ set: false });
    expect((await raeX.emit("crew:setOpen", { open: false })).ok).toBe(true);

    // Maya's headset: asked of Maya's phone, denied once, then let in — Maya's terms only, no organizer controls
    const ask2 = (await call("POST", "/xr/attach", { joinCode: made.joinCode, memberId: maya.memberId }, undefined, "10.9.0.2")).json;
    await mayaPhone.waitFor((e) => e.ev === "headset:request" && e.p.requestId === ask2.requestId);
    expect((await mayaPhone.emit("headset:approve", { requestId: ask2.requestId, allow: false })).ok).toBe(true);
    expect((await call("POST", "/xr/attach/status", { requestId: ask2.requestId, secret: ask2.secret }, undefined, "10.9.0.2")).json).toEqual({ status: "denied" });
    const ask3 = (await call("POST", "/xr/attach", { joinCode: made.joinCode, memberId: maya.memberId }, undefined, "10.9.0.2")).json;
    await mayaPhone.waitFor((e) => e.ev === "headset:request" && e.p.requestId === ask3.requestId);
    expect((await mayaPhone.emit("headset:approve", { requestId: ask3.requestId, allow: true })).ok).toBe(true);
    const ok3 = (await call("POST", "/xr/attach/status", { requestId: ask3.requestId, secret: ask3.secret }, undefined, "10.9.0.2")).json;
    const mayaX = client({ tripId: made.tripId, memberToken: ok3.deviceToken, surface: "xr" });
    expect(await mayaX.ack).toEqual({ ok: true, as: "member" });
    await mayaX.waitFor((e) => e.ev === "brief:private");
    await settle(20);
    expect(briefs(mayaX)).toEqual([70_000]);
    expect(await mayaX.emit("table:start", {})).toMatchObject({ ok: false, code: "NOT_ORGANIZER" });

    // a headset ended from its seat's device stops working
    expect((await call("DELETE", `/trips/${made.tripId}/my-headset`, undefined, maya.memberToken)).json).toEqual({ ok: true });
    const gone = client({ tripId: made.tripId, memberToken: ok3.deviceToken, surface: "xr" });
    expect(await gone.ack).toMatchObject({ as: "spectator", tokenRejected: "member" });
    for (const x of [raePhone, mayaPhone, raeX, mayaX, gone]) x.s.close();
  });

  it("requests expire, a new request replaces the last, an unknown seat is refused, and requests are rate-limited", async () => {
    const made = (await call("POST", "/trips", { name: "Expire", organizerName: "Rae", band: 1, origin: "ATL" })).json;
    const raePhone = client({ tripId: made.tripId, memberToken: made.memberToken, surface: "phone" });
    await raePhone.ack;
    expect((await call("POST", "/xr/attach", { joinCode: made.joinCode, memberId: "nobody" }, undefined, "10.9.1.1")).json.code).toBe("NOT_FOUND");
    expect((await call("POST", "/xr/attach", { joinCode: "ZZZZZZ", memberId: made.memberId }, undefined, "10.9.1.1")).status).toBe(404);
    const a = (await call("POST", "/xr/attach", { joinCode: made.joinCode, memberId: made.memberId }, undefined, "10.9.1.1")).json;
    const b = (await call("POST", "/xr/attach", { joinCode: made.joinCode, memberId: made.memberId }, undefined, "10.9.1.1")).json;
    // the first prompt is withdrawn, and can no longer be answered
    await raePhone.waitFor((e) => e.ev === "headset:request" && e.p.requestId === a.requestId && e.p.answered);
    expect(await raePhone.emit("headset:approve", { requestId: a.requestId, allow: true })).toMatchObject({ ok: false, code: "BAD_CODE" });
    // past its TTL: the answer is refused and the headset is told it expired
    expect(b.expiresAt - Date.now()).toBeLessThanOrEqual(HEADSET_REQUEST_TTL_MS);
    (h.identity.headsets as unknown as { requests: Map<string, { expiresAt: number }> }).requests.get(b.requestId)!.expiresAt = Date.now() - 1;
    expect(await raePhone.emit("headset:approve", { requestId: b.requestId, allow: true })).toMatchObject({ ok: false, code: "BAD_CODE" });
    expect((await call("POST", "/xr/attach/status", { requestId: b.requestId, secret: b.secret }, undefined, "10.9.1.1")).json).toEqual({ status: "expired" });
    // per address: a handful of requests a minute
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call("POST", "/xr/attach", { joinCode: made.joinCode, memberId: made.memberId }, undefined, "10.9.1.9")).status;
    expect(last).toBe(429);
    raePhone.s.close();
  });

  it("the seal PIN over REST and seal:set { pin }", async () => {
    const t = await sealing(h);
    // a known token for Maya to talk REST / sockets with (the helper above didn't keep hers)
    const token = `maya-${Math.random().toString(36).slice(2)}`;
    h.members.get(t.maya._id)!.tokenHash = createHash("sha256").update(token).digest("hex");
    expect((await call("POST", `/trips/${t.trip._id}/seal-pin`, { pin: "12" }, token)).json.code).toBe("BAD_INPUT");
    expect((await call("POST", `/trips/${t.trip._id}/seal-pin`, { pin: "9031" }, token)).json).toEqual({ ok: true });
    expect((await call("GET", `/trips/${t.trip._id}/seal-pin`, undefined, token)).json).toEqual({ set: true });
    expect((await call("GET", `/trips/${t.trip._id}/passkey`, undefined, token)).json.pin).toBe(true);
    const x = client({ tripId: t.trip._id, memberToken: token, surface: "xr" });
    await x.ack;
    expect(await x.emit("seal:set", { bookingId: t.bookingId })).toMatchObject({ ok: false, code: "PIN_REQUIRED" });
    expect(await x.emit("seal:set", { bookingId: t.bookingId, pin: "1111" })).toMatchObject({ ok: false, code: "BAD_PIN" });
    expect((await x.emit("seal:set", { bookingId: t.bookingId, pin: "9031" })).ok).toBe(true);
    x.s.close();
  });
});
