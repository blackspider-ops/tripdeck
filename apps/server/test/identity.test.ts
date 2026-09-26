/**
 * WP-06 — identity, sessions & seats: private crew-key memory (SEC-003/TR4-007/TR5-018), demo handoff and absent
 * invites (SEC-004), closing the crew (SEC-010), removed members (TR4-001/TR4-020), headset pairing (SEC-018/TR5-023).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import { createHash } from "node:crypto";
import type { BriefInput, Tag } from "@all-ayes/shared";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { io as connect, type Socket } from "socket.io-client";
import { TripService } from "../src/trips/service.js";
import { type HelmError } from "../src/util/errors.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";
import { apiRouter } from "../src/api/routes.js";
import { attachRealtime } from "../src/realtime/io.js";
import { crewKeyHash, personKey, recall } from "../src/memory/memory.js";
import { newToken } from "../src/util/ids.js";

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean | Promise<boolean>) => { for (let i = 0; i < 600 && !(await pred()); i++) await settle(); };
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };
const BRIEF = (capCents: number, mustHaves: Tag[]): BriefInput => ({ capCents, dateWindowIds: ["W1"], mustHaves, dealbreakers: [] });

function helm() {
  const h = new TripService();
  const sim = (h.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const trip: { ev: string; p: any }[] = [];
  const member: { id: string; ev: string; p: any }[] = [];
  const evicted: string[] = [];
  h.attachBus({ trip: (_t, ev, p) => trip.push({ ev, p }), member: (id, ev, p) => member.push({ id, ev, p }), evict: (id) => evicted.push(id) });
  return { h, trip, member, evicted };
}
const lastMemory = (member: { id: string; ev: string; p: any }[], id: string) =>
  [...member].reverse().find((e) => e.id === id && e.ev === "brief:private")?.p.memory as string[];

afterEach(() => vi.useRealTimers());

describe("SEC-003 / TR4-007 / TR5-018: memory belongs to a private crew key, not to name + airport", () => {
  it("a booked voyage's memory reaches only the same crew key; a same-named stranger from the same airport gets none", async () => {
    const { h, member } = helm();
    const raeKey = newToken(), mayaKey = newToken();
    const { trip, member: rae, crewKey: raeEcho } = h.createTrip({ name: "One", organizerName: "Rae", band: 1, origin: "ATL", crewKey: raeKey });
    expect(raeEcho).toBe(raeKey); // a valid key the phone already holds is kept
    const maya = h.join(trip._id, { name: "Maya", band: 2, origin: "ORD", crewKey: mayaKey });
    expect(maya.crewKey).toBe(mayaKey);
    // the raw key is never stored
    expect(JSON.stringify(h.members.get(maya.member._id))).not.toContain(mayaKey);
    await h.submitBrief(trip._id, rae._id, BRIEF(110_000, ["food"]));
    await h.submitBrief(trip._id, maya.member._id, BRIEF(90_000, ["beach"]));
    await h.startTable(trip._id, { memberId: rae._id });
    await until(() => h.trip(trip._id).status === "DRY_RUN");
    const planId = h.trip(trip._id).shortlistIds![0];
    await h.pick(trip._id, { memberId: rae._id }, planId);
    const bookingId = h.trip(trip._id).bookingId!;
    await Promise.all([h.setSeal(trip._id, rae._id, bookingId), h.setSeal(trip._id, maya.member._id, bookingId)]);
    await until(() => h.trip(trip._id).status === "BOOKED");
    const mayaThread = personKey(crewKeyHash(mayaKey), "Maya");
    await until(async () => (await recall(mayaThread)).some((l) => l.includes("· booked ·")));
    expect((await recall(mayaThread)).some((l) => l.includes("· booked ·"))).toBe(true);

    // another voyage: a stranger calls themselves "Maya", flies from ORD, has no crew key → nothing recalled
    const two = h.createTrip({ name: "Two", organizerName: "Eve", band: 1, origin: "ATL" });
    const fake = h.join(two.trip._id, { name: "Maya", band: 2, origin: "ORD" });
    expect(fake.crewKey).not.toBe(mayaKey);
    await h.submitBrief(two.trip._id, fake.member._id, BRIEF(90_000, ["beach"]));
    expect(lastMemory(member, fake.member._id)).toEqual([]);
    // a forged key that isn't shaped like one is ignored (a fresh identity is minted)
    const junk = h.join(two.trip._id, { name: "Maya", band: 3, origin: "ORD", crewKey: "maya|ORD" });
    expect(junk.crewKey).not.toBe("maya|ORD");
    await h.submitBrief(two.trip._id, junk.member._id, BRIEF(90_000, ["beach"]));
    expect(lastMemory(member, junk.member._id)).toEqual([]);

    // the real Maya's phone carries her key to a new voyage → her memory follows her
    const three = h.createTrip({ name: "Three", organizerName: "Rae", band: 1, origin: "ATL" });
    const real = h.join(three.trip._id, { name: "Maya", band: 2, origin: "ORD", crewKey: mayaKey });
    await h.submitBrief(three.trip._id, real.member._id, BRIEF(90_000, ["beach"]));
    expect(lastMemory(member, real.member._id).join(" ")).toContain("· booked ·");
  }, 20_000);

  it("the Expo seed still gives Maya her 'conceded' line, and no other seat recalls it", async () => {
    const { h, member } = helm();
    const seed = await seedExpo(h);
    expect(lastMemory(member, seed.maya.memberId).join(" ")).toMatch(/conceded the city choice/);
    expect(lastMemory(member, seed.organizer.memberId)).toEqual([]);
    // an absent seat has no crew key until claimed; the seeded claim mints one (Dev's own, not Rae's)
    const dev = h.members.get(seed.dev.memberId)!;
    expect(dev.crewKeyHash).toBeTruthy();
    expect(dev.crewKeyHash).not.toBe(h.members.get(seed.organizer.memberId)!.crewKeyHash);
  });
});

describe("SEC-004: demo handoff and absent invites", () => {
  it("demo links carry a one-time handoff code, not a member token", async () => {
    const { h } = helm();
    const seed = await seedExpo(h);
    expect(seed.maya.handoff).not.toBe(seed.maya.memberToken);
    expect(await code(() => h.redeemHandoff(seed.tripId, seed.organizer.memberId, seed.maya.handoff))).toBe("BAD_HANDOFF"); // wrong seat
    // (a failed redeem burns the code: nobody can keep guessing seats with it)
    expect(await code(() => h.redeemHandoff(seed.tripId, seed.maya.memberId, seed.maya.handoff))).toBe("BAD_HANDOFF");
    const again = h.mintHandoff(seed.tripId, seed.maya.memberId, seed.maya.memberToken);
    expect(h.redeemHandoff(seed.tripId, seed.maya.memberId, again).memberToken).toBe(seed.maya.memberToken);
    expect(await code(() => h.redeemHandoff(seed.tripId, seed.maya.memberId, again))).toBe("BAD_HANDOFF"); // single use
    expect(await code(() => h.redeemHandoff(seed.tripId, seed.maya.memberId, "bogus"))).toBe("BAD_HANDOFF");
    vi.useFakeTimers({ now: Date.now() });
    const late = h.mintHandoff(seed.tripId, seed.dev.memberId, seed.dev.memberToken);
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000 + 1);
    expect(await code(() => h.redeemHandoff(seed.tripId, seed.dev.memberId, late))).toBe("BAD_HANDOFF"); // expired
  });

  it("the invite key is in the link's fragment; the organizer's phone can't claim it; the claim mints a token only the friend holds", async () => {
    const { h } = helm();
    const orgKey = newToken();
    const { trip, member: rae, token: raeToken } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL", crewKey: orgKey });
    const inv = h.addAbsent(trip._id, { memberId: rae._id }, { name: "Dev", band: 3, origin: "JFK" });
    expect(inv.invitePath).toMatch(new RegExp(`^/t/${trip.joinCode}/brief#m=${inv.memberId}&k=`));
    expect(inv.invitePath).not.toContain("?");
    expect(inv.inviteKey.length).toBeGreaterThanOrEqual(43);
    expect("memberToken" in inv).toBe(false);
    // the organizer opening it on their own phone is refused, and the invite stays good for the friend
    expect(await code(() => h.claimAbsent(trip._id, inv.memberId, inv.inviteKey, orgKey))).toBe("OWN_INVITE");
    const friendKey = newToken();
    const claim = h.claimAbsent(trip._id, inv.memberId, inv.inviteKey, friendKey);
    expect(claim.crewKey).toBe(friendKey);
    expect(h.memberByToken(trip._id, claim.memberToken)?._id).toBe(inv.memberId);
    expect(h.memberByToken(trip._id, raeToken)?._id).toBe(rae._id); // untouched
    expect(await code(() => h.claimAbsent(trip._id, inv.memberId, inv.inviteKey, friendKey))).toBe("BAD_INVITE"); // single use
  });
});

describe("SEC-010: the organizer can close the crew", () => {
  it("a closed crew refuses joins by code; only the organizer can close/reopen; absent invites still work", async () => {
    const { h, trip: room } = helm();
    const { trip, member: rae } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const maya = h.join(trip._id, { name: "Maya", band: 2, origin: "ORD" });
    expect(await code(() => h.setCrewOpen(trip._id, { memberId: maya.member._id }, false))).toBe("NOT_ORGANIZER");
    h.setCrewOpen(trip._id, { memberId: rae._id }, false);
    expect(h.state(trip).crewClosed).toBe(true);
    expect(room.filter((e) => e.ev === "trip:state").at(-1)!.p.crewClosed).toBe(true);
    expect(await code(() => h.join(trip._id, { name: "Stranger", band: 3, origin: "JFK" }))).toBe("CREW_CLOSED");
    expect(h.activeMembers(trip).length).toBe(2);
    expect(h.addAbsent(trip._id, { memberId: rae._id }, { name: "Dev", band: 3, origin: "JFK" }).memberId).toBeTruthy();
    h.setCrewOpen(trip._id, { memberId: rae._id }, true);
    expect(h.join(trip._id, { name: "Late", band: 4, origin: "JFK" }).member._id).toBeTruthy();
  });

  it("joins after the table has met are refused", async () => {
    const { h } = helm();
    const seed = await seedExpo(h);
    await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    expect(await code(() => h.join(seed.tripId, { name: "Late", band: 4, origin: "JFK" }))).toBe("BAD_PHASE");
  });
});

describe("TR4-001 / TR4-020: a member removed by 'sail without them' can't act", () => {
  it("vote / submitBrief / hail / seal from a removed member → NOT_MEMBER; their sockets are evicted", async () => {
    const { h, evicted } = helm();
    const { trip, member: rae } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const maya = h.join(trip._id, { name: "Maya", band: 2, origin: "ORD" });
    const b = h.join(trip._id, { name: "B", band: 3, origin: "JFK" });
    h.sailWithout(trip._id, { memberId: rae._id }, [b.member._id]);
    expect(evicted).toEqual([b.member._id]);
    expect(await code(() => h.submitBrief(trip._id, b.member._id, BRIEF(90_000, ["beach"])))).toBe("NOT_MEMBER");
    await h.submitBrief(trip._id, rae._id, BRIEF(110_000, ["food"]));
    await h.submitBrief(trip._id, maya.member._id, BRIEF(90_000, ["beach"]));
    await h.startTable(trip._id, { memberId: rae._id });
    expect(await code(() => h.hail(trip._id, b.member._id, "somewhere with a beach"))).toBe("NOT_MEMBER");
    await until(() => h.trip(trip._id).status === "DRY_RUN");
    const t = h.trip(trip._id);
    const planId = t.shortlistIds![0];
    expect(await code(() => h.vote(trip._id, b.member._id, planId))).toBe("NOT_MEMBER");
    expect(t.votes[b.member._id]).toBeUndefined();
    // a ghost vote left over from before removal never counts toward a majority / auto-pick
    t.votes[b.member._id] = planId;
    expect(h.state(t).votes).toEqual({});
    h.vote(trip._id, maya.member._id, planId);
    expect(h.state(t).votes).toEqual({ [planId]: 1 });
    expect(t.autoPick).toBeNull(); // 1 of 2 is not a strict majority; the ghost doesn't make it 2
    await h.pick(trip._id, { memberId: rae._id }, planId);
    const bookingId = h.trip(trip._id).bookingId!;
    expect(await code(() => h.setSeal(trip._id, b.member._id, bookingId))).toBe("NOT_MEMBER");
    expect(await code(() => h.cancelSeal(trip._id, b.member._id, bookingId))).toBe("NOT_MEMBER");
  }, 15_000);

  it("sail-without is idempotent and revokes anything issued for the seat", async () => {
    const { h } = helm();
    const { trip, member: rae } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const inv = h.addAbsent(trip._id, { memberId: rae._id }, { name: "Dev", band: 3, origin: "JFK" });
    h.payments.standing.set(inv.memberId, { memberId: inv.memberId } as never);
    h.sailWithout(trip._id, { memberId: rae._id }, [inv.memberId]);
    h.sailWithout(trip._id, { memberId: rae._id }, [inv.memberId, inv.memberId]);
    expect(h.trip(trip._id).removedMemberIds).toEqual([inv.memberId]);
    expect(h.payments.standing.has(inv.memberId)).toBe(false);
    expect(await code(() => h.claimAbsent(trip._id, inv.memberId, inv.inviteKey))).toBe("BAD_INVITE"); // the invite is dead too
  });
});

describe("SEC-018 / TR5-023: headset pairing", () => {
  it("codes are 8 unambiguous characters, stored as an HMAC (not a plain SHA-256), single use, 10 minutes", async () => {
    const { h } = helm();
    const seed = await seedExpo(h);
    expect(seed.headsetCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    const stored = h.trip(seed.tripId).headset!.codeHash;
    expect(stored).not.toBe(createHash("sha256").update(seed.headsetCode).digest("hex"));
    expect(stored).not.toContain(seed.headsetCode);
    vi.useFakeTimers({ now: Date.now() });
    const { code: c } = h.headsetCode(seed.tripId, { memberId: seed.organizer.memberId });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect(await code(() => h.pairHeadset(c))).toBe("BAD_CODE");
    vi.useRealTimers();
    const { code: c2 } = h.headsetCode(seed.tripId, { memberId: seed.organizer.memberId });
    expect(h.pairHeadset(c2.toLowerCase()).deviceToken).toBeTruthy(); // case-insensitive
    expect(await code(() => h.pairHeadset(c2))).toBe("BAD_CODE");
  });

  it("a device token past its TTL loses organizer controls; the organizer can unpair; the headset can't unpair itself", async () => {
    const { h } = helm();
    const seed = await seedExpo(h);
    const { deviceToken } = h.pairHeadset(seed.headsetCode);
    expect(h.deviceOk(seed.tripId, deviceToken)).toBe(true);
    vi.useFakeTimers({ now: Date.now() });
    vi.setSystemTime(Date.now() + 12 * 60 * 60_000 + 1);
    expect(h.deviceOk(seed.tripId, deviceToken)).toBe(false);
    // R2-WP-07 / L2-002: the headset is told to re-pair, not that its wearer isn't the organizer
    expect(await code(() => h.startTable(seed.tripId, { deviceToken }))).toBe("DEVICE_EXPIRED");
    vi.useRealTimers();

    const { code: c } = h.headsetCode(seed.tripId, { memberId: seed.organizer.memberId });
    const fresh = h.pairHeadset(c).deviceToken;
    expect(await code(() => h.unpairHeadset(seed.tripId, { deviceToken: fresh }))).toBe("NOT_ORGANIZER");
    expect(await code(() => h.unpairHeadset(seed.tripId, { memberId: seed.maya.memberId }))).toBe("NOT_ORGANIZER");
    h.unpairHeadset(seed.tripId, { memberId: seed.organizer.memberId });
    expect(h.deviceOk(seed.tripId, fresh)).toBe(false);
    expect(await code(() => h.startTable(seed.tripId, { deviceToken: fresh }))).toBe("DEVICE_EXPIRED");
    // a member who isn't the organizer still gets NOT_ORGANIZER
    expect(await code(() => h.startTable(seed.tripId, { memberId: seed.maya.memberId }))).toBe("NOT_ORGANIZER");
  });
});

// ---------- over the wire ----------
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

  const call = async (method: string, path: string, body: unknown = {}, token?: string) => {
    const res = await fetch(base + "/api" + path, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  function client(join: Record<string, unknown>) {
    const s: Socket = connect(base, { path: "/socket.io", transports: ["websocket"], forceNew: true });
    const events: { ev: string; p: any }[] = [];
    s.onAny((ev, p) => events.push({ ev, p }));
    s.on("connect", () => s.emit("trip:join", join));
    const waitFor = async (pred: (e: { ev: string; p: any }) => boolean) => { await until(() => events.some(pred)); return events.find(pred)?.p; };
    return { s, events, waitFor };
  }

  it("crew keys ride on create/join/claim; a closed crew refuses a join; handoff redeems once", async () => {
    const crewKey = newToken();
    const made = await call("POST", "/trips", { name: "Wire", organizerName: "Rae", band: 1, origin: "ATL", crewKey });
    expect(made.json.crewKey).toBe(crewKey);
    const joined = await call("POST", `/trips/${made.json.tripId}/members`, { name: "Maya", band: 2, origin: "ORD" });
    expect(joined.json.crewKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const inv = await call("POST", `/trips/${made.json.tripId}/absent`, { name: "Dev", band: 3, origin: "JFK" }, made.json.memberToken);
    const own = await call("POST", `/trips/${made.json.tripId}/absent/${inv.json.memberId}/claim`, { inviteKey: inv.json.inviteKey, crewKey });
    expect([own.status, own.json.code]).toEqual([403, "OWN_INVITE"]);
    const claimed = await call("POST", `/trips/${made.json.tripId}/absent/${inv.json.memberId}/claim`, { inviteKey: inv.json.inviteKey });
    expect(claimed.json.memberToken).toBeTruthy();
    expect(claimed.json.crewKey).toBeTruthy();

    const rae = client({ tripId: made.json.tripId, memberToken: made.json.memberToken, surface: "phone" });
    await rae.waitFor((e) => e.ev === "trip:state");
    rae.s.emit("crew:setOpen", { open: false });
    await rae.waitFor((e) => e.ev === "trip:state" && e.p.crewClosed === true);
    const byCode = await fetch(`${base}/api/trips/by-code/${made.json.joinCode}`).then((r) => r.json());
    expect(byCode.crewClosed).toBe(true);
    const refused = await call("POST", `/trips/${made.json.tripId}/members`, { name: "Stranger", band: 4, origin: "JFK" });
    expect([refused.status, refused.json.code]).toEqual([403, "CREW_CLOSED"]);
    rae.s.close();

    const seed = (await call("POST", "/demo/seed?kind=expo")).json;
    const ok = await call("POST", `/trips/${seed.tripId}/members/${seed.maya.memberId}/handoff`, { code: seed.maya.handoff });
    expect(ok.json.memberToken).toBe(seed.maya.memberToken);
    const again = await call("POST", `/trips/${seed.tripId}/members/${seed.maya.memberId}/handoff`, { code: seed.maya.handoff });
    expect([again.status, again.json.code]).toEqual([403, "BAD_HANDOFF"]);
  });

  it("TR4-001: a socket joined before 'sail without them' stops getting private events and can't act", async () => {
    const made = (await call("POST", "/trips", { name: "Ghost", organizerName: "Rae", band: 1, origin: "ATL" })).json;
    const b = (await call("POST", `/trips/${made.tripId}/members`, { name: "B", band: 2, origin: "ORD" })).json;
    const rae = client({ tripId: made.tripId, memberToken: made.memberToken, surface: "phone" });
    const ghost = client({ tripId: made.tripId, memberToken: b.memberToken, surface: "phone" });
    await rae.waitFor((e) => e.ev === "trip:state");
    await ghost.waitFor((e) => e.ev === "brief:private");
    rae.s.emit("table:sailWithout", { memberIds: [b.memberId] });
    await ghost.waitFor((e) => e.ev === "trip:state" && !e.p.crew.some((c: any) => c.memberId === b.memberId));
    ghost.events.length = 0;
    ghost.s.emit("brief:submit", BRIEF(90_000, ["beach"]));
    const err = await ghost.waitFor((e) => e.ev === "error");
    expect(err.code).toBe("NOT_MEMBER");
    expect(ghost.events.some((e) => e.ev === "brief:private")).toBe(false);
    expect(h.briefs.has(b.memberId)).toBe(false);
    // the ghost still sees the public room (as a spectator) but nothing private
    ghost.s.emit("trip:join", { tripId: made.tripId, memberToken: b.memberToken, surface: "phone" });
    await ghost.waitFor((e) => e.ev === "trip:state");
    await settle(30);
    expect(ghost.events.some((e) => e.ev === "brief:private")).toBe(false);
    rae.s.close(); ghost.s.close();
  });

  describe("R2-WP-07 / L3-001 / L2-002: trip:join says who it let in; a rejected credential is never silent", () => {
    function joiner(join: Record<string, unknown>) {
      const s: Socket = connect(base, { path: "/socket.io", transports: ["websocket"], forceNew: true });
      const events: { ev: string; p: any }[] = [];
      s.onAny((ev, p) => events.push({ ev, p }));
      const ack = new Promise<any>((r) => s.on("connect", () => s.emit("trip:join", join, r)));
      const waitFor = async (pred: (e: { ev: string; p: any }) => boolean) => { await until(() => events.some(pred)); return events.find(pred)?.p; };
      return { s, events, ack, waitFor };
    }
    const errors = (c: { events: { ev: string; p: any }[] }) => c.events.filter((e) => e.ev === "error").map((e) => e.p);

    it("member, spectator (Gallery) and a bad member token: ack role + TOKEN_REJECTED before the replay", async () => {
      const seed = (await call("POST", "/demo/seed?kind=expo")).json;
      const maya = joiner({ tripId: seed.tripId, memberToken: seed.maya.memberToken, surface: "phone" });
      const gallery = joiner({ joinCode: seed.joinCode, surface: "gallery" });
      const stale = joiner({ tripId: seed.tripId, memberToken: "nope", surface: "phone" });
      expect(await maya.ack).toEqual({ ok: true, as: "member" });
      expect(await gallery.ack).toEqual({ ok: true, as: "spectator" });
      expect(await stale.ack).toEqual({ ok: true, as: "spectator", tokenRejected: "member" });
      await settle(20);
      expect(errors(maya)).toEqual([]);
      expect(errors(gallery)).toEqual([]);
      expect(errors(stale)).toEqual([expect.objectContaining({ code: "TOKEN_REJECTED", event: "trip:join" })]);
      // told first, then the public replay (a spectator's view, nothing private)
      const i = stale.events.findIndex((e) => e.ev === "error");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(stale.events.findIndex((e) => e.ev === "trip:state")).toBeGreaterThan(i);
      expect(stale.events.some((e) => e.ev === "brief:private")).toBe(false);
      maya.s.close(); gallery.s.close(); stale.s.close();
    });

    it("a replaced or unpaired headset: its next action and its next join say DEVICE_EXPIRED", async () => {
      const seed = (await call("POST", "/demo/seed?kind=expo")).json;
      const pairA = (await call("POST", "/xr/pair", { code: seed.headsetCode })).json;
      const a = joiner({ tripId: seed.tripId, deviceToken: pairA.deviceToken, surface: "xr" });
      expect(await a.ack).toEqual({ ok: true, as: "device" });
      await a.waitFor((e) => e.ev === "trip:state");
      expect(errors(a)).toEqual([]);

      // a second headset pairs (identity.pairHeadset replaces the device token)
      const { code: c2 } = h.headsetCode(seed.tripId, { memberId: seed.organizer.memberId });
      const pairB = (await call("POST", "/xr/pair", { code: c2 })).json;
      const refused = await new Promise<any>((r) => a.s.emit("table:start", {}, r));
      expect(refused).toMatchObject({ ok: false, code: "DEVICE_EXPIRED" });
      a.s.emit("table:hail", { text: "somewhere warm" });
      await a.waitFor((e) => e.ev === "error" && e.p.event === "table:hail");
      expect(errors(a).find((e) => e.event === "table:hail").code).toBe("DEVICE_EXPIRED");
      a.s.close();

      const again = joiner({ tripId: seed.tripId, deviceToken: pairA.deviceToken, surface: "xr" });
      expect(await again.ack).toEqual({ ok: true, as: "spectator", tokenRejected: "device" });
      expect((await again.waitFor((e) => e.ev === "error")).code).toBe("DEVICE_EXPIRED");
      again.s.close();

      // B works until the organizer unpairs it; then B's rejoin is refused the same way
      const b = joiner({ tripId: seed.tripId, deviceToken: pairB.deviceToken, surface: "xr" });
      expect(await b.ack).toEqual({ ok: true, as: "device" });
      b.s.close();
      h.unpairHeadset(seed.tripId, { memberId: seed.organizer.memberId });
      const b2 = joiner({ tripId: seed.tripId, deviceToken: pairB.deviceToken, surface: "xr" });
      expect(await b2.ack).toMatchObject({ as: "spectator", tokenRejected: "device" });
      expect((await b2.waitFor((e) => e.ev === "error")).code).toBe("DEVICE_EXPIRED");
      b2.s.close();
    });

    it("once BOOKED a headset rejoins quietly as a spectator (nothing to re-pair for)", async () => {
      const seed = (await call("POST", "/demo/seed?kind=expo")).json;
      const pair = (await call("POST", "/xr/pair", { code: seed.headsetCode })).json;
      h.trip(seed.tripId).status = "BOOKED";
      const x = joiner({ tripId: seed.tripId, deviceToken: pair.deviceToken, surface: "xr" });
      expect(await x.ack).toEqual({ ok: true, as: "spectator" });
      await x.waitFor((e) => e.ev === "trip:state");
      await settle(20);
      expect(errors(x)).toEqual([]);
      x.s.close();
    });
  });
});
