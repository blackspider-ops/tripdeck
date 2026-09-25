/**
 * SEC-001 / TR2-015 / S2-002: the public plan (table:decided, trip:state.shortlist — what the Gallery and the
 * headset get) and the public crew list must not let anyone rebuild or narrow a member's share or must-haves.
 * Each member's own schedule and exact share travel only in plan:private.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  Object.assign(process.env, { PACE_SCALE: "0", ELEVENLABS_API_KEY: "", GEMINI_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" });
});
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { io as connect, type Socket } from "socket.io-client";
import { ORIGINS, TAGS, type CityId, type Dataset, type Dealbreaker, type Origin, type Plan, type PlanPublic, type Role, type Tag } from "@all-ayes/shared";
import { loadDataset } from "../src/data/loader.js";
import {
  buildChartBook, buildPlan, chooseFlight, choosePicks, publicTotalRange, toPrivate, toPublic, type PricingMember,
} from "../src/fit/pricing.js";
import { TripService } from "../src/trips/service.js";
import { apiRouter } from "../src/api/routes.js";
import { attachRealtime } from "../src/realtime/io.js";
import { SimProvider } from "../src/payments/sim.js";
import { EXPO_CREW } from "./fixtures.js";

const ds = loadDataset();
const FORBIDDEN_KEYS = ["attendees", "arrivals", "travel", "memberId", "landMin", "atStayMin"];

/** Every key name anywhere in a JSON value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

type CrewInfo = { memberId: string; origin?: string; role: string };

/**
 * Port of the security review's repro1.mts: join each member's public arrival minute to the unique
 * flight, add the lodging share and the public prices of the items they attend. Returns null for a
 * member when the public plan doesn't carry what the attack needs.
 */
function repro1(d: Dataset, pub: any, crew: CrewInfo[]): Record<string, number | null> {
  const win = d.dateWindows.find((w) => w.id === pub.dateWindowId)!;
  const hotel = d.hotels.find((h) => h._id === pub.hotelId)!;
  const lodging = hotel.nightlyCents * win.nights;
  const base = Math.floor(lodging / crew.length);
  const out: Record<string, number | null> = {};
  for (const m of crew) {
    const arrival = pub.days?.[0]?.arrivals?.find((a: any) => a.memberId === m.memberId);
    const items = (pub.days ?? []).flatMap((day: any) => day.items ?? []);
    if (!arrival || items.some((it: any) => !Array.isArray(it.attendees))) { out[m.memberId] = null; continue; }
    const flights = d.flights.filter((f) => f.cityId === pub.cityId && f.origin === m.origin && f.dateWindowId === pub.dateWindowId
      && Number(f.arriveLocal.split("T")[1].slice(0, 2)) * 60 + Number(f.arriveLocal.split("T")[1].slice(3, 5)) === arrival.landMin);
    if (flights.length !== 1) { out[m.memberId] = null; continue; }
    const acts = items.filter((it: any) => it.attendees.includes(m.memberId))
      .reduce((s: number, it: any) => s + d.activities.find((a) => a._id === it.activityId)!.priceCents, 0);
    out[m.memberId] = flights[0].priceCents + base + (m.role === "organizer" ? lodging - base * crew.length : 0) + acts;
  }
  return out;
}

/** Every share a member could have that is consistent with the public plan + public crew facts. */
function candidateShares(d: Dataset, pub: PlanPublic, m: CrewInfo, crewSize: number): Set<number> {
  const win = d.dateWindows.find((w) => w.id === pub.dateWindowId)!;
  const hotel = d.hotels.find((h) => h._id === pub.hotelId)!;
  const lodging = hotel.nightlyCents * win.nights;
  const base = Math.floor(lodging / crewSize) + (m.role === "organizer" ? lodging - Math.floor(lodging / crewSize) * crewSize : 0);
  const items = pub.days.flatMap((day) => day.items);
  const price = (id: string) => d.activities.find((a) => a._id === id)!.priceCents;
  const group = items.filter((it) => it.kind === "group").reduce((s, it) => s + price(it.activityId), 0);
  const picks = items.filter((it) => it.kind === "pick").map((it) => price(it.activityId));
  const flights = d.flights.filter((f) => f.cityId === pub.cityId && f.origin === m.origin && f.dateWindowId === pub.dateWindowId);
  const out = new Set<number>();
  for (const f of flights) {
    for (let mask = 0; mask < 1 << picks.length; mask++) {
      const p = picks.reduce((s, c, i) => s + (mask & (1 << i) ? c : 0), 0);
      out.add(f.priceCents + base + group + p);
    }
  }
  return out;
}

const crewInfo: CrewInfo[] = EXPO_CREW.map((m) => ({ memberId: m.memberId, origin: m.origin, role: m.role }));
const hotel = (id: string) => ds.hotels.find((h) => h._id === id)!;
const worked: Plan[] = [
  buildPlan(ds, EXPO_CREW, "LIS", "W1", hotel("LIS-h-casa-alfama")),
  buildPlan(ds, EXPO_CREW, "MEX", "W1", hotel("MEX-h-roma-flat")),
];

describe("public plan view (SEC-001 / TR2-015)", () => {
  it("the review's attack works on the old payload shape (sanity: the test can detect a leak)", () => {
    for (const p of worked) {
      const legacy = { ...toPublic(ds, p), days: p.days }; // what toPublic used to send
      const got = repro1(ds, legacy, crewInfo);
      for (const m of p.members) expect(got[m.memberId]).toBe(m.amountCents);
    }
  });

  it("the same attack reconstructs nothing from the public plan now", () => {
    for (const p of worked) {
      const got = repro1(ds, toPublic(ds, p), crewInfo);
      for (const m of p.members) expect(got[m.memberId]).toBeNull();
    }
  });

  it("no public plan in the chart book carries member ids, attendance, legs per member or arrivals", () => {
    for (const p of buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"], 50)) {
      const pub = toPublic(ds, p);
      const keys = keysOf(pub);
      for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `${p._id} has key ${k}`).toBe(false);
      const json = JSON.stringify(pub);
      for (const m of EXPO_CREW) expect(json, `${p._id} names ${m.memberId}`).not.toContain(`"${m.memberId}"`);
      for (const m of p.members) expect(json).not.toContain(String(m.amountCents));
    }
  });

  it("public data leaves every member's share ambiguous (several consistent values)", () => {
    for (const p of worked) {
      const pub = toPublic(ds, p);
      for (const m of crewInfo) {
        const c = candidateShares(ds, pub, m, crewInfo.length);
        const actual = p.members.find((x) => x.memberId === m.memberId)!.amountCents;
        expect(c.has(actual), `${p._id} ${m.memberId} model covers the truth`).toBe(true);
        expect(c.size, `${p._id} ${m.memberId}`).toBeGreaterThan(1);
      }
    }
  });

  it("each member gets exactly their own schedule, legs and arrival privately", () => {
    for (const p of worked) {
      for (const m of EXPO_CREW) {
        const priv = toPrivate(p, m.memberId)!;
        const json = JSON.stringify(priv);
        for (const other of EXPO_CREW) if (other.memberId !== m.memberId) expect(json).not.toContain(`"${other.memberId}"`);
        expect(keysOf(priv).has("attendees")).toBe(false);
        const want = p.days.map((d) => d.items.filter((it) => it.attendees.includes(m.memberId)).map((it) => it.activityId));
        expect(priv.days.map((d) => d.items.map((it) => it.activityId))).toEqual(want);
        for (const d of priv.days) for (const it of d.items) {
          const src = p.days.find((x) => x.day === d.day)!.items.find((x) => x.activityId === it.activityId)!;
          expect(it.travel).toEqual(src.travel[m.memberId]);
        }
        const a = p.days[0].arrivals!.find((x) => x.memberId === m.memberId)!;
        expect(priv.arrival).toEqual({ landMin: a.landMin, atStayMin: a.atStayMin });
      }
    }
  });

  it("the public schedule keeps what the Dry Run scene needs: every moment, a time, a place and a group leg", () => {
    const p = worked[0];
    const pub = toPublic(ds, p);
    const ids = (days: { items: { activityId: string }[] }[]) => days.flatMap((d) => d.items.map((it) => it.activityId)).sort();
    expect(ids(pub.days)).toEqual(ids(p.days));
    for (const d of pub.days) {
      expect(d.label).toBe(`Day ${d.day}`);
      for (const it of d.items) {
        expect(["group", "pick"]).toContain(it.kind);
        expect(it.leg).toBeDefined();
        expect(it.endMin).toBeGreaterThan(it.startMin);
      }
    }
    // group moments keep their real (dataset-fixed) times
    for (const it of pub.days[0].items.filter((x) => x.kind === "group")) {
      const real = p.days[0].items.find((x) => x.activityId === it.activityId)!;
      expect([it.startMin, it.endMin]).toEqual([real.startMin, real.endMin]);
    }
    // the fado walk is public (everyone has it): the group route is flagged too
    expect(pub.days[0].items.some((it) => it.kind === "group" && it.leg?.flagged)).toBe(true);
  });
});

// ---------- S2-002: the strong attacker (port of r2-sec/share-infer.mts) ----------
type Seen = { memberId: string; role: Role; origin?: Origin };
type Opt = { key: string; share: number; picks: string[]; persona: PricingMember };
const CHOICE_DBS: Dealbreaker[] = ["red_eye", "layovers_2plus", "early_start"];
const MUST_ORDERS: Tag[][] = (() => {
  const tags = TAGS.map((t) => t.id);
  const out: Tag[][] = [[]];
  for (const a of tags) { out.push([a]); for (const b of tags) if (b !== a) { out.push([a, b]); for (const c of tags) if (c !== a && c !== b) out.push([a, b, c]); } }
  return out;
})();

/** Every distinct (origin, flight, picks) the open-source builder can choose for someone flying from `origins`. */
const personaCache = new Map<string, { origin: Origin; flightId: string; price: number; picks: string[]; brief: PricingMember["brief"] }[]>();
function personas(cityId: CityId, windowId: string, origins: readonly Origin[]) {
  const key = `${cityId}|${windowId}|${origins.join(",")}`;
  const hit = personaCache.get(key);
  if (hit) return hit;
  const out = new Map<string, { origin: Origin; flightId: string; price: number; picks: string[]; brief: PricingMember["brief"] }>();
  for (const origin of origins) for (let mask = 0; mask < 8; mask++) {
    const dealbreakers = CHOICE_DBS.filter((_, i) => mask & (1 << i));
    for (const mustHaves of MUST_ORDERS) {
      const brief = { capCents: 10_000_000, dateWindowIds: [windowId], mustHaves, dealbreakers };
      const m: PricingMember = { memberId: "x", name: "x", role: "member", origin, brief };
      const f = chooseFlight(ds, m, cityId, windowId).flight;
      const picks = choosePicks(ds, cityId, m).map((a) => a._id);
      const k = `${origin}|${f?._id ?? "-"}|${picks.join(",")}`;
      if (!out.has(k)) out.set(k, { origin, flightId: f?._id ?? "-", price: f?.priceCents ?? 0, picks, brief });
    }
  }
  const list = [...out.values()];
  personaCache.set(key, list);
  return list;
}

/**
 * The attacker knows the dataset and the builder (open source), the crew list and the public plan. For each member
 * it tries every persona the builder can produce from what's public (their origin when published, else any), and
 * keeps only the worlds whose rebuilt public view equals the observed one — `view` renders a world the way the
 * public plan under test does (null: the listing floor, where only the set of picks on the schedule is known).
 * `total` is what the view says about the group total. Returns every share each member could still have.
 */
function inferShares(pub: { cityId: CityId; dateWindowId: string; hotelId: string; days: { items: { activityId: string; kind: string }[] }[] },
  crew: Seen[], view: ((p: Plan) => string) | null, total: [number, number]): Record<string, number[]> {
  const win = ds.dateWindows.find((w) => w.id === pub.dateWindowId)!;
  const h = ds.hotels.find((x) => x._id === pub.hotelId)!;
  const lodging = h.nightlyCents * win.nights;
  const base = Math.floor(lodging / crew.length);
  const rem = lodging - base * crew.length;
  const acts = ds.activities.filter((a) => a.cityId === pub.cityId);
  const price = (id: string) => acts.find((a) => a._id === id)!.priceCents;
  const groupSum = acts.filter((a) => a.role === "group").slice(0, 2).reduce((s, a) => s + a.priceCents, 0);
  const pubPicks = new Set(pub.days.flatMap((d) => d.items).filter((it) => it.kind === "pick").map((it) => it.activityId));
  const [lo, hi] = total;
  const all: Opt[][] = crew.map((m) => personas(pub.cityId, pub.dateWindowId, m.origin ? [m.origin] : ORIGINS)
    .filter((p) => p.picks.every((x) => pubPicks.has(x))).map((p) => ({
      key: `${p.origin}|${p.flightId}|${p.picks.join(",")}`,
      share: p.price + base + (m.role === "organizer" ? rem : 0) + groupSum + p.picks.reduce((s, x) => s + price(x), 0),
      picks: p.picks,
      persona: { memberId: m.memberId, name: m.memberId, role: m.role, origin: p.origin, brief: p.brief },
    })));
  const minOf = all.map((o) => Math.min(...o.map((x) => x.share)));
  const maxOf = all.map((o) => Math.max(...o.map((x) => x.share)));
  const seenView = (pub as { __seen?: string }).__seen ?? "";
  const observed = new Map<string, boolean>();
  const consistent = (world: Opt[]) => {
    if (!view) return true;
    const key = world.map((w) => w.key).join("/");
    let ok = observed.get(key);
    if (ok === undefined) {
      ok = view(buildPlan(ds, world.map((w) => w.persona), pub.cityId, pub.dateWindowId, h)) === seenView;
      observed.set(key, ok);
    }
    return ok;
  };
  const exists = (i: number, v: number) => {
    const choice: Opt[] = [];
    const go = (j: number, sum: number): boolean => {
      if (j === crew.length) {
        if (sum < lo || sum > hi) return false;
        if (new Set(choice.flatMap((c) => c.picks)).size !== pubPicks.size) return false;
        return consistent(choice);
      }
      let restMin = 0, restMax = 0;
      for (let k = j + 1; k < crew.length; k++) { restMin += k === i ? v : minOf[k]; restMax += k === i ? v : maxOf[k]; }
      for (const o of all[j]) {
        if (j === i && o.share !== v) continue;
        const s = sum + o.share;
        if (s + restMin > hi || s + restMax < lo) continue;
        choice.push(o);
        if (go(j + 1, s)) return true;
        choice.pop();
      }
      return false;
    };
    return go(0, 0);
  };
  const out: Record<string, number[]> = {};
  crew.forEach((m, i) => { out[m.memberId] = [...new Set(all[i].map((o) => o.share))].sort((a, b) => a - b).filter((v) => exists(i, v)); });
  return out;
}

/** What the helm published before S2-002: exact pick times (from landing times), dated labels, exact total, origins. */
function legacyView(p: Plan): string {
  const role = (id: string) => ds.activities.find((a) => a._id === id)!.role;
  return JSON.stringify({
    groupCents: p.groupCents, publicFlags: p.publicFlags,
    days: p.days.map((d) => ({ day: d.day, label: d.label, items: d.items.map((it) => ({ id: it.activityId, s: it.startMin, e: it.endMin, kind: role(it.activityId) })) })),
  });
}
/** Today's public plan, minus what needs caps to use (fitsEveryone) and the A/B label. */
function currentView(p: Plan): string {
  const { fitsEveryone: _f, label: _l, ...rest } = toPublic(ds, p);
  return JSON.stringify(rest);
}

type Attack = { truth: Record<string, number>; got: Record<string, number[]>; floor: Record<string, number[]> };
function attackLegacy(p: Plan, crew: PricingMember[]): Attack {
  const pub = { ...toPublic(ds, p), __seen: legacyView(p), days: p.days.map((d) => ({ items: d.items.map((it) => ({ activityId: it.activityId, kind: ds.activities.find((a) => a._id === it.activityId)!.role })) })) };
  const seen = crew.map((m) => ({ memberId: m.memberId, role: m.role, origin: m.origin }));
  return {
    truth: Object.fromEntries(p.members.map((m) => [m.memberId, m.amountCents])),
    got: inferShares(pub, seen, legacyView, [p.groupCents, p.groupCents]),
    floor: inferShares(pub, seen.map(({ origin: _o, ...m }) => m), null, [-Infinity, Infinity]),
  };
}
function attackCurrent(p: Plan, crew: PricingMember[]): Attack {
  const pub = { ...toPublic(ds, p), __seen: currentView(p) };
  // what the room sees of the crew: whatever crewPublic carries (no origin since S2-002)
  const seen = crew.map((m) => ({ memberId: m.memberId, role: m.role }));
  return {
    truth: Object.fromEntries(p.members.map((m) => [m.memberId, m.amountCents])),
    got: inferShares(pub, seen, currentView, [pub.groupRange.lowCents, pub.groupRange.highCents]),
    floor: inferShares(pub, seen, null, [-Infinity, Infinity]),
  };
}
const span = (xs: number[]) => (xs.length ? xs[xs.length - 1] - xs[0] : 0);

/** 20 seeded random crews of 2 to 4, any origins, must-haves and dealbreakers. */
function randomCrews(): PricingMember[][] {
  let seed = 20260925;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const DBS: Dealbreaker[] = ["red_eye", "hostel", "early_start", "long_walks", "layovers_2plus"];
  return Array.from({ length: 20 }, () => {
    const n = 2 + Math.floor(rnd() * 3);
    return Array.from({ length: n }, (_, i): PricingMember => {
      const tags = TAGS.map((t) => t.id).sort(() => rnd() - 0.5).slice(0, Math.floor(rnd() * 4));
      return {
        memberId: `m${i}`, name: `m${i}`, role: i === 0 ? "organizer" : "member", origin: ORIGINS[Math.floor(rnd() * 3)],
        brief: { capCents: 150_000, dateWindowIds: ["W1"], mustHaves: tags, dealbreakers: DBS.filter(() => rnd() < 0.25) },
      };
    });
  });
}

describe("S2-002: public plan + crew list can't narrow anyone's share", () => {
  const expoBook = buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"], 12);

  it("sanity: on the old public view the attack narrows every share, and pins the organizer's exactly", () => {
    let exactOrganizer = 0;
    for (const p of expoBook) {
      const a = attackLegacy(p, EXPO_CREW);
      for (const m of p.members) {
        const c = a.got[m.memberId];
        expect(c, `${p._id} ${m.memberId} model covers the truth`).toContain(a.truth[m.memberId]);
        expect(c.length, `${p._id} ${m.memberId}`).toBeLessThan(8);
        expect(c.length).toBeLessThan(a.floor[m.memberId].length);
      }
      if (a.got.rae.length === 1) exactOrganizer++;
    }
    expect(exactOrganizer).toBeGreaterThanOrEqual(4); // the YUL charts
  });

  it("the Expo chart book: every share keeps ≥ 15 candidates over ≥ $150, and nothing beyond the listings narrows it", () => {
    for (const p of expoBook) {
      const a = attackCurrent(p, EXPO_CREW);
      for (const m of p.members) {
        const c = a.got[m.memberId];
        expect(c, `${p._id} ${m.memberId} model covers the truth`).toContain(a.truth[m.memberId]);
        expect(c, `${p._id} ${m.memberId}: the public view adds nothing to the listings`).toEqual(a.floor[m.memberId]);
        expect(c.length, `${p._id} ${m.memberId}`).toBeGreaterThanOrEqual(15);
        expect(span(c), `${p._id} ${m.memberId}`).toBeGreaterThanOrEqual(15_000);
      }
    }
  });

  it("20 random 2- to 4-person crews: no share is ever pinned; each is only as narrow as the public listings allow", () => {
    for (const crew of randomCrews()) {
      for (const p of buildChartBook(ds, crew, ["LIS", "MEX", "YUL"], 6)) {
        const a = attackCurrent(p, crew);
        for (const m of p.members) {
          const c = a.got[m.memberId];
          expect(c, `${p._id} ${m.memberId}`).toContain(a.truth[m.memberId]);
          expect(c, `${p._id} ${m.memberId}`).toEqual(a.floor[m.memberId]);
          // the floor: the city's own flights from three airports (YUL has one each: $190 / $280 / $310)
          expect(c.length, `${p._id} ${m.memberId}`).toBeGreaterThanOrEqual(3);
          expect(span(c), `${p._id} ${m.memberId}`).toBeGreaterThanOrEqual(12_000);
        }
      }
    }
  }, 60_000);

  it("the public total is a range from public facts only: it holds the real total and ignores who the crew are", () => {
    const rotated = EXPO_CREW.map((m, i) => ({ ...m, origin: EXPO_CREW[(i + 1) % EXPO_CREW.length].origin }));
    for (const p of expoBook) {
      const r = publicTotalRange(ds, p);
      expect(r.lowCents).toBeLessThanOrEqual(p.groupCents);
      expect(r.highCents).toBeGreaterThanOrEqual(p.groupCents);
      expect(r.highCents - r.lowCents).toBeGreaterThanOrEqual(20_000);
      const q = buildPlan(ds, rotated, p.cityId, p.dateWindowId, ds.hotels.find((h) => h._id === p.hotelId)!);
      const picks = (x: Plan) => x.days.flatMap((d) => d.items.map((it) => it.activityId)).sort().join();
      if (picks(q) !== picks(p) || q.groupCents === p.groupCents) continue;
      // another crew with other flights, same picks: the same public schedule and range
      expect(publicTotalRange(ds, q)).toEqual(r);
      expect(toPublic(ds, q).days).toEqual(toPublic(ds, p).days);
    }
    // the Expo charts as the room sees them
    const [mex, lis] = [worked[1], worked[0]].map((p) => toPublic(ds, p).groupRange);
    expect(lis.lowCents).toBeLessThan(286_900);
    expect(lis.highCents).toBeGreaterThan(286_900);
    expect(mex.lowCents).toBeLessThan(197_500);
    expect(mex.highCents).toBeGreaterThan(197_500);
  });
});

// ---------- over the wire: what a token-less Gallery socket actually receives ----------
let http: Server;
let base = "";
beforeAll(async () => {
  const helm = new TripService();
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [5, 10];
  const app = express();
  app.use("/api", apiRouter(helm));
  http = createServer(app);
  attachRealtime(http, helm);
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://localhost:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));

function client(join: Record<string, unknown>) {
  const s: Socket = connect(base, { path: "/socket.io", transports: ["websocket"], forceNew: true });
  const events: { ev: string; p: any }[] = [];
  s.onAny((ev, p) => events.push({ ev, p }));
  s.on("connect", () => s.emit("trip:join", join));
  const waitFor = (pred: (e: { ev: string; p: any }) => boolean, ms = 8000) => new Promise<any>((resolve, reject) => {
    const hit = events.find(pred);
    if (hit) return resolve(hit.p);
    const t = setTimeout(() => reject(new Error("timeout; saw: " + events.map((e) => e.ev).join(","))), ms);
    s.onAny((ev, p) => { if (pred({ ev, p })) { clearTimeout(t); resolve(p); } });
  });
  return { s, events, waitFor };
}

describe("Gallery at DRY_RUN (SEC-001 acceptance)", () => {
  it("no trip-room plan payload names a member or carries per-member schedule data; members get theirs privately", async () => {
    const res = await fetch(base + "/api/demo/seed", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const seed = await res.json() as { tripId: string; joinCode: string; organizer: { memberId: string; memberToken: string }; maya: { memberId: string; memberToken: string }; dev: { memberId: string } };
    const rae = client({ tripId: seed.tripId, memberToken: seed.organizer.memberToken, surface: "phone" });
    const maya = client({ tripId: seed.tripId, memberToken: seed.maya.memberToken, surface: "phone" });
    const gallery = client({ joinCode: seed.joinCode, surface: "gallery" });
    await Promise.all([rae, maya, gallery].map((c) => c.waitFor((e) => e.ev === "trip:state")));
    rae.s.emit("table:start", {});
    await gallery.waitFor((e) => e.ev === "table:decided", 15000);
    await gallery.waitFor((e) => e.ev === "trip:state" && e.p.status === "DRY_RUN" && e.p.shortlistIds);
    const mayaPrivs = await Promise.all(["MEX-W1-roma-flat", "LIS-W1-casa-alfama"].map((id) =>
      maya.waitFor((e) => e.ev === "plan:private" && e.p.planId === id)));

    // a late Gallery joiner gets the replay too
    const late = client({ joinCode: seed.joinCode, surface: "gallery" });
    await late.waitFor((e) => e.ev === "table:decided");

    const memberIds = [seed.organizer.memberId, seed.maya.memberId, seed.dev.memberId];
    const roomCrew = gallery.events.find((e) => e.ev === "trip:state")!.p.crew as any[];
    for (const c of roomCrew) expect(c, "S2-002: no home airport in the crew list").not.toHaveProperty("origin");
    const crew: CrewInfo[] = roomCrew.map((c) => ({ memberId: c.memberId, origin: c.origin, role: c.role }));
    for (const c of [gallery, late]) {
      const plans: any[] = [
        ...c.events.filter((e) => e.ev === "table:decided").flatMap((e) => e.p.shortlist),
        ...c.events.filter((e) => e.ev === "trip:state" && e.p.shortlist).flatMap((e) => e.p.shortlist),
      ];
      expect(plans.length).toBeGreaterThanOrEqual(2);
      for (const pub of plans) {
        const keys = keysOf(pub);
        for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `${pub.planId} has ${k}`).toBe(false);
        const json = JSON.stringify(pub);
        for (const id of memberIds) expect(json).not.toContain(id);
        expect(pub).not.toHaveProperty("groupCents"); // S2-002: only the public range
        expect(json).not.toContain("286900");
        expect(json).not.toContain("197500");
        const got = repro1(ds, pub, crew);
        expect(Object.values(got).every((v) => v === null)).toBe(true);
      }
      expect(c.events.some((e) => e.ev === "plan:private")).toBe(false);
    }

    // Maya's own schedule arrives privately, with her arrival and legs, naming nobody else
    const lis = mayaPrivs[1];
    expect(lis.amountCents).toBe(86_800);
    expect(lis.arrival.landMin).toBeGreaterThan(0);
    expect(lis.days.flatMap((d: any) => d.items).length).toBeGreaterThan(0);
    for (const id of [seed.organizer.memberId, seed.dev.memberId]) expect(JSON.stringify(mayaPrivs)).not.toContain(id);
    const raeLis = await rae.waitFor((e) => e.ev === "plan:private" && e.p.planId === "LIS-W1-casa-alfama");
    expect(raeLis.days.flatMap((d: any) => d.items).map((it: any) => it.activityId))
      .not.toEqual(lis.days.flatMap((d: any) => d.items).map((it: any) => it.activityId));

    for (const c of [rae, maya, gallery, late]) c.s.close();
  }, 30000);
});
