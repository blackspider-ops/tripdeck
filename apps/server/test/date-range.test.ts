/**
 * Organizer-chosen date ranges + member availability, at the helm (docs/03 P1/P4, docs/04 §4.12): createTrip and brief
 * validation, the older fixed windows still accepted, generated windows used for the chart book / Captain / live
 * prefetch, availability kept private (never in a trip-room payload), and a custom-range voyage reaching BOOKED.
 */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

vi.mock("../src/memory/memory.js", () => ({
  crewKeyHash: (k: string) => `h:${k}`,
  personKey: (keyHash: string, name: string) => `crew:${keyHash}|${name.trim().toLowerCase()}`,
  validCrewKey: (k: unknown) => typeof k === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(k),
  recall: async () => [],
  remember: async () => undefined,
  rememberAll: async () => undefined,
  budgetBand: () => "mid budget",
}));

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { addDays, daysOf, isGeneratedWindowId, parseRangeWindowId, type Availability, type BriefInput, type DateRange } from "@all-ayes/shared";
import { TripService } from "../src/trips/service.js";
import type { SimProvider } from "../src/payments/sim.js";
import type { HelmError } from "../src/util/errors.js";
import type { LiveProvider } from "../src/trips/live.js";
import { randomVoyagePlan, seedRandom, seedExpo } from "../src/demo/seed.js";
import { apiRouter } from "../src/api/routes.js";
import { attachRealtime } from "../src/realtime/io.js";
import { io as connect, type Socket } from "socket.io-client";
import { config } from "../src/config.js";
import { resetSpend } from "../src/util/limits.js";
import { until } from "./support/quiet.js";
import { filterLine, type PrivacyContext } from "../src/privacy/filter.js";
import { openLine } from "../src/negotiation/phrasing.js";

const todayUtc = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => addDays(todayUtc(), n);
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };

function helm() {
  const h = new TripService();
  const sim = (h.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const room: { ev: string; p: any }[] = [];
  const member: { id: string; ev: string; p: any }[] = [];
  h.attachBus({ trip: (_t, ev, p) => room.push({ ev, p }), member: (id, ev, p) => member.push({ id, ev, p }) });
  return { h, room, member };
}

/** A range starting in `from` days, `len` days long. */
const rangeIn = (from: number, len: number, minNights = 3, maxNights = 5): DateRange =>
  ({ start: inDays(from), end: inDays(from + len - 1), minNights, maxNights });
const terms = (availability: Availability | undefined, cap = 250_000): BriefInput =>
  ({ capCents: cap, dateWindowIds: [], availability, mustHaves: ["food"], dealbreakers: [] });

/** Organizer + members + one absent friend on LIS / MEX / YUL with the given range; nobody sealed yet. */
function voyage(h: TripService, dateRange: DateRange, n = 3) {
  const { trip, member: org } = h.createTrip({ name: "Range", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX", "YUL"], dateRange });
  const ids = [org._id];
  for (let i = 1; i < n - 1; i++) ids.push(h.join(trip._id, { name: `M${i}`, band: (i + 1) as 2, origin: i % 2 ? "ORD" : "SEA" }).member._id);
  const away = h.addAbsent(trip._id, { memberId: org._id }, { name: "Dev", band: n as 3, origin: "JFK" });
  ids.push(away.memberId);
  return { trip, ids };
}

async function toDryRun(h: TripService, tripId: string, organizerId: string) {
  await h.startTable(tripId, { memberId: organizerId });
  await until(() => h.trip(tripId).status === "DRY_RUN", 5_000);
  return h.trip(tripId);
}

describe("createTrip with a date range", () => {
  it("stores the range; no windows until the table meets (and none shown while briefing)", () => {
    const { h } = helm();
    const r = rangeIn(40, 20);
    const { trip } = voyage(h, r);
    expect(trip.dateRange).toEqual(r);
    expect(trip.candidateWindowIds).toEqual([]);
    const s = h.replayer.state(trip);
    expect(s.dateRange).toEqual(r);
    expect(s.dateWindows).toEqual([]);
  });

  it("validates: start ≥ tomorrow, within 12 months, long enough for the shortest trip, 1–14 nights", async () => {
    const { h } = helm();
    const make = (dateRange: unknown) => h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"], dateRange });
    expect(await code(() => make(rangeIn(1, 10)))).toBe("OK");
    expect(await code(() => make(rangeIn(-2, 10)))).toBe("BAD_INPUT");
    expect(await code(() => make({ ...rangeIn(30, 10), end: inDays(400) }))).toBe("BAD_INPUT");
    expect(await code(() => make(rangeIn(30, 3, 3, 5)))).toBe("BAD_INPUT"); // 3 days = 2 nights
    expect(await code(() => make(rangeIn(30, 4, 3, 5)))).toBe("OK");
    expect(await code(() => make(rangeIn(30, 20, 0, 3)))).toBe("BAD_INPUT");
    expect(await code(() => make(rangeIn(30, 20, 3, 15)))).toBe("BAD_INPUT");
    expect(await code(() => make(rangeIn(30, 20, 5, 3)))).toBe("BAD_INPUT");
    expect(await code(() => make({ start: "2027-02-30", end: "2027-03-10", minNights: 3, maxNights: 5 }))).toBe("BAD_INPUT");
    expect(await code(() => make({ ...rangeIn(30, 20), minNights: "3", maxNights: "5" }))).toBe("OK"); // numeric strings from a form
  });

  it("still accepts the older fixed windows; a range wins when both are sent", () => {
    const { h } = helm();
    const old = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"], windowIds: ["W2", "W1"] }).trip;
    expect(old.dateRange).toBeUndefined();
    expect(old.candidateWindowIds).toEqual(["W1", "W2"]);
    expect(h.replayer.state(old).dateWindows.map((w) => w.id)).toEqual(["W1", "W2"]);
    const both = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"], windowIds: ["W1"], dateRange: rangeIn(30, 20) }).trip;
    expect(both.dateRange).toBeDefined();
    expect(both.candidateWindowIds).toEqual([]);
  });

  it("over REST: POST /api/trips takes dateRange (and still windowIds)", async () => {
    const { h } = helm();
    const app = express();
    app.use("/api", apiRouter(h));
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://localhost:${(server.address() as AddressInfo).port}/api`;
    const post = (body: unknown) => fetch(`${base}/trips`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const seat = { name: "R", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"] };
      const ok = await post({ ...seat, dateRange: rangeIn(20, 15) });
      expect(ok.status).toBe(200);
      const { tripId } = await ok.json() as { tripId: string };
      expect(h.trip(tripId).dateRange).toEqual(rangeIn(20, 15));
      // yesterday: refused at any hour (today itself is still "tomorrow" somewhere in UTC−12 for the first 12 UTC hours)
      const bad = await post({ ...seat, dateRange: rangeIn(-1, 15) });
      expect(bad.status).toBe(422);
      expect((await bad.json() as { code: string }).code).toBe("BAD_INPUT");
      const legacy = await post({ ...seat, windowIds: ["W3"] });
      expect(h.trip((await legacy.json() as { tripId: string }).tripId).candidateWindowIds).toEqual(["W3"]);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("the brief's availability", () => {
  it("a date-range voyage needs days (inside the range) or `any`; fixed-window ids are ignored there", async () => {
    const { h, member } = helm();
    const r = rangeIn(40, 10);
    const { trip, ids } = voyage(h, r);
    expect(await code(() => h.submitBrief(trip._id, ids[0], terms(undefined)))).toBe("BAD_INPUT");
    expect(await code(() => h.submitBrief(trip._id, ids[0], terms({ days: [inDays(10), "nonsense"] })))).toBe("BAD_INPUT"); // none in range
    await h.submitBrief(trip._id, ids[0], { ...terms({ days: [inDays(43), inDays(41), inDays(41), inDays(10), "2027-02-30", inDays(49)] }), dateWindowIds: ["W1"] });
    const b = h.briefs.get(ids[0])!;
    expect(b.availability).toEqual({ days: [inDays(41), inDays(43), inDays(49)] });
    expect(b.dateWindowIds).toEqual([]);
    await h.submitBrief(trip._id, ids[1], terms({ any: true, days: [inDays(41)] } as Availability));
    expect(h.briefs.get(ids[1])!.availability).toEqual({ any: true });
    // the member's own sealed terms come back to them privately, with their days
    const mine = member.filter((e) => e.ev === "brief:private" && e.id === ids[0]).at(-1)!;
    expect(mine.p.brief.availability).toEqual({ days: [inDays(41), inDays(43), inDays(49)] });
  });

  it("a fixed-window voyage keeps its date chips; availability sent there is dropped", async () => {
    const { h } = helm();
    const { trip, member: org } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"], windowIds: ["W1", "W2"] });
    expect(await code(() => h.submitBrief(trip._id, org._id, terms({ any: true })))).toBe("BAD_INPUT"); // no window picked
    await h.submitBrief(trip._id, org._id, { ...terms({ any: true }), dateWindowIds: ["W1"] });
    expect(h.briefs.get(org._id)).not.toHaveProperty("availability");
    expect(h.briefs.get(org._id)!.dateWindowIds).toEqual(["W1"]);
  });
});

describe("generated windows at the table", () => {
  it("everyone free on a shared block: windows from the finder, a chart book on them, 'works for everyone'", async () => {
    const { h, room } = helm();
    const r = rangeIn(60, 21);
    const { trip, ids } = voyage(h, r);
    const block = daysOf(inDays(66), inDays(74));
    for (const id of ids) await h.submitBrief(trip._id, id, terms(id === ids[1] ? { any: true } : { days: block }));
    // generated when the last terms sealed (for the live prefetch), not shown yet
    expect(trip.candidateWindowIds!.length).toBeGreaterThan(0);
    expect(h.replayer.state(trip).dateWindows).toEqual([]);
    const t = await toDryRun(h, trip._id, ids[0]);
    const wins = t.candidateWindowIds!;
    expect(wins.length).toBeGreaterThanOrEqual(1);
    expect(wins.length).toBeLessThanOrEqual(3);
    for (const id of wins) {
      expect(isGeneratedWindowId(id)).toBe(true);
      const w = parseRangeWindowId(id)!;
      expect(w.start >= r.start && w.end <= r.end).toBe(true);
      expect(w.nights).toBeGreaterThanOrEqual(3);
      expect(w.nights).toBeLessThanOrEqual(5);
    }
    // the table-start snapshot carries them (a static field), labelled "Mar 12–16"-style
    const full = room.find((e) => e.ev === "trip:state" && e.p.status === "AT_TABLE" && e.p.dateWindows)!;
    expect(full.p.dateWindows.map((w: any) => w.id)).toEqual(wins);
    expect(full.p.dateWindows[0].label).toMatch(/^[A-Z][a-z]{2} \d{1,2}–/);
    expect(full.p.dateRange).toEqual(r);
    // the Two Charts are on a window inside everyone's block
    for (const p of h.table.shortlist(t)) {
      expect(wins).toContain(p.dateWindowId);
      const w = parseRangeWindowId(p.dateWindowId)!;
      expect(block).toContain(w.start);
      expect(block).toContain(w.end);
      expect(p.members.every((m) => !m.reasons.includes("date_mismatch"))).toBe(true);
    }
    const open = room.find((e) => e.ev === "turn:new" && e.p.act === "OPEN")!;
    expect(open.p.text).toMatch(/everyone/);
    expect(h.table.datesLabel(t)).toMatch(/^[A-Z][a-z]{2} \d{1,2} to /);
  }, 20_000);

  it("no window suits all: the most members win, the absentee's share says date_mismatch privately, the Captain says 'most of the crew'", async () => {
    const { h, room, member } = helm();
    const r = rangeIn(60, 14, 3, 3);
    const { trip, ids } = voyage(h, r, 4);
    const early = daysOf(inDays(60), inDays(66)), late = daysOf(inDays(68), inDays(73));
    await h.submitBrief(trip._id, ids[0], terms({ days: early }));
    await h.submitBrief(trip._id, ids[1], terms({ days: early }));
    await h.submitBrief(trip._id, ids[2], terms({ days: early }));
    await h.submitBrief(trip._id, ids[3], terms({ days: late })); // the absent friend can only do the end
    const t = await toDryRun(h, trip._id, ids[0]);
    const open = room.find((e) => e.ev === "turn:new" && e.p.act === "OPEN")!;
    expect(open.p.text).toMatch(/most of the crew/);
    expect(open.p.text).not.toContain("Dev");
    const [a] = h.table.shortlist(t);
    const w = parseRangeWindowId(a.dateWindowId)!;
    expect(early).toContain(w.start);
    expect(a.members.find((m) => m.memberId === ids[3])!.reasons).toContain("date_mismatch");
    expect(a.fitsEveryone).toBe(false);
    // only Dev hears it (his own plan:private); nobody else's private payload names his reason
    const privs = member.filter((e) => e.ev === "plan:private" && e.p.planId === a._id);
    expect(privs.find((e) => e.id === ids[3])!.p.reasons).toContain("date_mismatch");
    for (const e of privs.filter((x) => x.id !== ids[3])) expect(e.p.reasons).not.toContain("date_mismatch");
  }, 20_000);

  it("availability never reaches the trip room (live broadcasts, the full snapshot, turns, the Two Charts)", async () => {
    const { h, room, member } = helm();
    const r = rangeIn(60, 30);
    const { trip, ids } = voyage(h, r);
    const block = daysOf(inDays(70), inDays(78));
    const sentinel = inDays(85); // only Maya marks it, and it lies in no window anyone else can make
    await h.submitBrief(trip._id, ids[0], terms({ days: block }));
    await h.submitBrief(trip._id, ids[1], terms({ days: [...block, sentinel] }));
    await h.submitBrief(trip._id, ids[2], terms({ days: block }));
    const t = await toDryRun(h, trip._id, ids[0]);
    const roomDump = JSON.stringify(room) + JSON.stringify(h.replayer.state(t));
    expect(roomDump).not.toContain("availability");
    expect(roomDump).not.toContain(sentinel);
    // other members never get Maya's days either
    expect(JSON.stringify(member.filter((e) => e.id !== ids[1]))).not.toContain(sentinel);
    // the helm's debug/audit log never records a member payload
    expect(JSON.stringify(h.debugLog.get(trip._id) ?? [])).not.toContain(sentinel);
  }, 20_000);

  it("the live prefetch asks for the generated windows' exact dates", async () => {
    const { h } = helm();
    const asked: { kind: string; from: string; to: string; windowId?: string }[] = [];
    const fake: LiveProvider = {
      mode: () => "sandbox",
      hotels: async (q) => { asked.push({ kind: "hotels", from: q.checkIn, to: q.checkOut }); return null; },
      flights: async (q) => { asked.push({ kind: "flights", from: q.depart, to: q.return ?? "", windowId: q.dateWindowId }); return null; },
    };
    h.live.provider = fake;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network in a test"); }) as typeof fetch;
    const cap = config.limits.spend.trip.routestack;
    config.limits.spend.trip.routestack = 1_000;
    try {
      const { trip, ids } = voyage(h, rangeIn(60, 20));
      for (const id of ids) await h.submitBrief(trip._id, id, terms({ days: daysOf(inDays(63), inDays(72)) }));
      await h.live.settled(trip._id);
      const wins = trip.candidateWindowIds!.map((id) => parseRangeWindowId(id)!);
      expect(asked.length).toBeGreaterThan(0);
      for (const q of asked) expect(wins.some((w) => w.start === q.from && w.end === q.to), JSON.stringify(q)).toBe(true);
      for (const q of asked.filter((x) => x.kind === "flights")) expect(trip.candidateWindowIds).toContain(q.windowId);
    } finally {
      globalThis.fetch = realFetch;
      config.limits.spend.trip.routestack = cap;
      resetSpend();
    }
  });
});

describe("over the wire", () => {
  it("brief:submit carries availability (and loves); the room and a Gallery never see it", async () => {
    const { h } = helm();
    const app = express();
    app.use("/api", apiRouter(h));
    const server = createServer(app);
    attachRealtime(server, h);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const sockets: Socket[] = [];
    const client = (join: Record<string, unknown>) => {
      const s = connect(base, { path: "/socket.io", transports: ["websocket"], forceNew: true });
      sockets.push(s);
      const events: { ev: string; p: any }[] = [];
      s.onAny((ev, p) => events.push({ ev, p }));
      const joined = new Promise<void>((r) => s.on("connect", () => s.emit("trip:join", join, () => r())));
      return { s, events, joined };
    };
    try {
      const res = await fetch(`${base}/api/trips`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Wire", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"], dateRange: rangeIn(40, 12) }),
      });
      const org = await res.json() as { tripId: string; joinCode: string; memberToken: string; memberId: string };
      const rae = client({ tripId: org.tripId, memberToken: org.memberToken, surface: "phone" });
      const gallery = client({ joinCode: org.joinCode, surface: "gallery" });
      await Promise.all([rae.joined, gallery.joined]);
      const secret = inDays(47);
      const ack = await new Promise<any>((r) => rae.s.emit("brief:submit", { ...terms({ days: [inDays(42), secret] }), loves: ["LIS"] }, r));
      expect(ack).toMatchObject({ ok: true });
      await until(() => rae.events.some((e) => e.ev === "brief:private" && e.p.brief), 3_000);
      const mine = rae.events.find((e) => e.ev === "brief:private" && e.p.brief)!.p.brief;
      expect(mine.availability).toEqual({ days: [inDays(42), secret] });
      expect(mine.loves).toEqual(["LIS"]);
      // a bad shape is refused, not crashed on
      const bad = await new Promise<any>((r) => rae.s.emit("brief:submit", { ...terms(undefined), availability: "any" }, r));
      expect(bad).toMatchObject({ ok: false, code: "BAD_INPUT" });
      await until(() => gallery.events.filter((e) => e.ev === "trip:state").length >= 2, 1_000);
      const seen = JSON.stringify(gallery.events);
      expect(seen).toContain("dateRange"); // the range itself is public
      expect(seen).not.toContain("availability");
      expect(seen).not.toContain(secret);
    } finally {
      for (const s of sockets) s.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("the Captain may name the dates", () => {
  // a headroom of $28 is a secret; "Mar 27" is a date, not an amount near it
  const ctx: PrivacyContext = { sensitiveDollars: [28, 30, 1_100], allowedDollars: [], names: ["Maya"] };
  it("a day of the month with its month is not an amount (so a date near a secret value isn't a leak)", () => {
    for (const line of [
      openLine("Mar 27 to 31", ["Lisbon", "Porto"]).line,
      openLine("Dec 27 to Jan 2", ["Lisbon"], "Europe", "most of the crew").line,
      "Mar 27–29 works for most of the crew.",
      "Sept. 29 through Oct 3.",
    ]) expect(filterLine(line, ctx).leak, line).toBe(false);
    expect(openLine("Mar 27 to 31", ["Lisbon", "Porto"], undefined, "most of the crew").line).toMatch(/^Mar 27 to 31 works for most of the crew\./);
  });
  it("amounts still leak: a bare number, a currency, or a day-sized number without a month", () => {
    for (const line of ["It's 28 each.", "About $29 for my friend.", "We're 27 over.", "Maya can do 1,100."]) {
      expect(filterLine(line, ctx).leak || filterLine(line, ctx).invalidPrice, line).toBe(true);
    }
  });
});

describe("compatibility", () => {
  it("the Expo keeps W1/W2 exactly (and its numbers)", async () => {
    const { h } = helm();
    const s = await seedExpo(h);
    const t = h.trip(s.tripId);
    expect(t.dateRange).toBeUndefined();
    expect(h.replayer.state(t).dateWindows.map((w) => w.id)).toEqual(["W1", "W2"]);
    const lis = h.table.chartBook(t).find((p) => p._id === "LIS-W1-casa-alfama")!;
    expect(lis.members.map((m) => m.amountCents)).toEqual([103_800, 86_800, 96_300]);
    expect(lis.groupCents).toBe(286_900);
  });

  it("a stored voyage from an older build (no windows, no range) still offers W1 and W2", () => {
    const { h } = helm();
    const { trip } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"], windowIds: ["W3"] });
    delete trip.candidateWindowIds;
    expect(h.replayer.state(trip).dateWindows.map((w) => w.id)).toEqual(["W1", "W2"]);
  });
});

describe("random demo voyages on a date range", () => {
  it("a range 2–9 months out, lengths drawn, availability mostly overlapping (sometimes one gap)", () => {
    const today = "2026-09-26";
    let gaps = 0, anys = 0;
    for (let seed = 0; seed < 60; seed++) {
      const p = randomVoyagePlan(seed, ["LIS", "MEX", "YUL", "BCN"], ["W1", "W2"], undefined, today);
      expect(p).toEqual(randomVoyagePlan(seed, ["LIS", "MEX", "YUL", "BCN"], ["W1", "W2"], undefined, today));
      const r = p.dateRange;
      expect(r.start >= addDays(today, 61) && r.start <= addDays(today, 61 + 199)).toBe(true);
      expect(r.end <= addDays(today, 330)).toBe(true); // live fares are on sale
      expect(r.minNights).toBeGreaterThanOrEqual(2);
      expect(r.maxNights).toBeGreaterThanOrEqual(r.minNights);
      // everyone but (at most) one gapped member shares a block long enough for the shortest trip
      const sets = p.crew.map((c) => (c.availability.any ? null : new Set(c.availability.days)));
      anys += sets.filter((x) => x === null).length;
      const common = daysOf(r.start, r.end).filter((d) => sets.filter((x) => x && !x.has(d)).length === 0);
      if (common.length < r.minNights + 1) gaps++;
      const nearly = daysOf(r.start, r.end).filter((d) => sets.filter((x) => x && !x.has(d)).length <= 1);
      expect(nearly.length).toBeGreaterThanOrEqual(r.maxNights + 1);
    }
    expect(anys).toBeGreaterThan(0);
    expect(gaps).toBeLessThan(60);
  });

  it("seedRandom makes a date-range voyage whose table meets on generated windows", async () => {
    const { h } = helm();
    const s = await seedRandom(h, 11);
    const t = h.trip(s.tripId);
    expect(t.dateRange).toBeDefined();
    const d = await toDryRun(h, s.tripId, s.organizer.memberId);
    expect(d.status).toBe("DRY_RUN");
    expect(d.candidateWindowIds!.every(isGeneratedWindowId)).toBe(true);
    for (const p of h.table.shortlist(d)) expect(d.candidateWindowIds).toContain(p.dateWindowId);
  }, 20_000);

  it("a random voyage with a custom range reaches BOOKED in-process (PACE_SCALE=0)", async () => {
    const { h, room } = helm();
    const r = rangeIn(75, 25, 2, 6);
    const { trip, ids } = voyage(h, r, 4);
    const rnd = (() => { let a = 7; return () => ((a = (a * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); })();
    const days = daysOf(r.start, r.end);
    const core = days.slice(5, 13);
    for (const id of ids) {
      const extra = days.filter(() => rnd() < 0.3);
      await h.submitBrief(trip._id, id, terms({ days: [...new Set([...core, ...extra])] }, 300_000));
    }
    const t = await toDryRun(h, trip._id, ids[0]);
    const [a] = h.table.shortlist(t);
    expect(isGeneratedWindowId(a.dateWindowId)).toBe(true);
    await h.pick(trip._id, { memberId: ids[0] }, a._id);
    for (const id of ids.slice(0, -1)) await h.setSeal(trip._id, id, t.bookingId!);
    await until(() => t.status === "BOOKED" || t.status === "VOIDED", 5_000);
    expect(t.status).toBe("BOOKED");
    // the booked voyage's dates are the chosen window's (the memory note / .ics use these)
    expect(h.table.datesLabel(t)).toBe(`${fmt(parseRangeWindowId(a.dateWindowId)!.start)} to ${endFmt(parseRangeWindowId(a.dateWindowId)!)}`);
    expect(room.some((e) => e.ev === "booking:result")).toBe(true);
  }, 20_000);
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const endFmt = (w: { start: string; end: string }) => (w.start.slice(5, 7) === w.end.slice(5, 7) ? String(Number(w.end.slice(8, 10))) : fmt(w.end));
