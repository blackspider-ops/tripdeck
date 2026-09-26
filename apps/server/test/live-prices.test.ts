/**
 * docs/12 wiring: the per-voyage live (RouteStack) overlay. A fake provider stands in for RouteStack and fetch is
 * stubbed to fail, so nothing here reaches the network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import type { CityId, Plan } from "@all-ayes/shared";
import { TripService } from "../src/trips/service.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo, seedRandom } from "../src/demo/seed.js";
import { config } from "../src/config.js";
import { resetSpend } from "../src/util/limits.js";
import { flightsFor } from "../src/fit/flights.js";
import { buildChartBook, buildPlan, chooseFlight, publicTotalRange, toPrivate, toPublic, type PricingMember } from "../src/fit/pricing.js";
import { emptyInventory, liveBand, liveFlightKey, liveHotelKey, type LiveFlight, type LiveStay } from "../src/fit/live.js";
import { FLIGHT_HORIZON_DAYS, PREFETCH_CONCURRENCY, type LiveProvider } from "../src/trips/live.js";
import type { LiveFlightOption, LiveHotelOption } from "../src/providers/routestack/index.js";
import { EXPO_CREW } from "./fixtures.js";
import { until } from "./support/quiet.js";

// never the network: any fetch in this file is a test failure
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (async () => { throw new Error("network in a test"); }) as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });

const tripCap = config.limits.spend.trip.routestack;
afterEach(() => { config.limits.spend.trip.routestack = tripCap; resetSpend(); });

type Call = { kind: "hotels" | "flights"; cityId: string; window: string; origin?: string; adults?: number; guests?: number };

/** A fake RouteStack: stays at $150 a room-night, fares 3 % under the dataset's cheapest (always inside the live band). */
function fakeProvider(helm: TripService, opts: { delayMs?: number; nothing?: boolean; mode?: "off" | "sandbox"; gate?: Promise<void> } = {}) {
  const calls: Call[] = [];
  let inFlight = 0, maxInFlight = 0;
  const windowOf = (start: string) => helm.ds.dateWindows.find((w) => w.start === start)!.id;
  const slow = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.gate) await opts.gate;
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 2));
    } finally { inFlight--; }
  };
  const provider: LiveProvider = {
    mode: () => opts.mode ?? "sandbox",
    hotels: async (q) => {
      calls.push({ kind: "hotels", cityId: q.cityId!, window: windowOf(q.checkIn), guests: q.guests });
      await slow();
      if (opts.nothing) return null;
      return [0, 1, 2].map((i): LiveHotelOption => ({
        _id: `RS-h-${q.cityId}${900 + i}`, kind: "hotel", cityId: q.cityId!, name: `Live Stay ${i}`, neighborhood: "",
        lat: q.lat + 0.01, lng: q.lng + 0.01, approxLocation: true, distanceKm: 1.4 + i, stayType: i === 2 ? "hostel" : "hotel",
        nightlyCents: 15_000 * Math.ceil(q.guests / 2) + i * 2_000, sleeps: q.guests, rating: 4.3, stars: 3, source: "routestack", bookingRef: `hotel:${i}`,
      }));
    },
    flights: async (q) => {
      const window = q.dateWindowId!;
      calls.push({ kind: "flights", cityId: q.cityId!, window, origin: q.origin, adults: q.adults });
      await slow();
      if (opts.nothing) return null;
      const base = [...flightsFor(helm.ds, q.cityId!, q.origin, window)].sort((a, b) => a.priceCents - b.priceCents)[0];
      return [{ ...base, _id: `RS-f-${q.cityId}-${q.origin}-${window}-x`, modelled: undefined, redEye: false, priceCents: Math.round(base.priceCents * 0.97), source: "routestack", currency: "USD", bookingRef: "fare:x" } as LiveFlightOption];
    },
  };
  return { provider, calls, max: () => maxInFlight };
}

function helmWith(opts: Parameters<typeof fakeProvider>[1] = {}) {
  const helm = new TripService();
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const member: { id: string; ev: string; p: any }[] = [];
  const room: { ev: string; p: any }[] = [];
  helm.attachBus({ trip: (_t, ev, p) => room.push({ ev, p }), member: (id, ev, p) => member.push({ id, ev, p }) });
  const fake = fakeProvider(helm, opts);
  helm.live.provider = fake.provider;
  return { helm, fake, member, room };
}

/** A voyage on LIS / MEX / YUL, W1 + W2, crew from ATL ×2, ORD, SEA; every brief sealed (the last seal starts the prefetch). */
async function voyage(helm: TripService, seal = true) {
  const { trip, member: org } = helm.createTrip({ name: "Live", organizerName: "Ann", band: 1, origin: "ATL", cityIds: ["LIS", "MEX", "YUL"], windowIds: ["W1", "W2"] });
  const others = [
    helm.join(trip._id, { name: "Bo", band: 2, origin: "ATL" }).member,
    helm.join(trip._id, { name: "Cy", band: 3, origin: "ORD" }).member,
    helm.join(trip._id, { name: "Di", band: 4, origin: "SEA" }).member,
  ];
  if (seal) {
    for (const m of [org, ...others]) {
      await helm.submitBrief(trip._id, m._id, { capCents: 300_000, dateWindowIds: ["W1", "W2"], mustHaves: ["food"], dealbreakers: [] });
    }
  }
  return { t: helm.trip(trip._id), org, others };
}

describe("the live prefetch", () => {
  it("runs when the last terms seal: stays per port × window, fares per port × window × home airport, ≤4 at once", async () => {
    const { helm, fake } = helmWith({ delayMs: 5 });
    const { t } = await voyage(helm);
    const report = await helm.live.settled(t._id);
    // 3 ports × 2 windows × (1 stay search + 3 distinct home airports) = 24 ≤ the default voyage cap? no: 24 > 20
    expect(report?.trimmed).toBe(true);
    expect(fake.max()).toBeLessThanOrEqual(PREFETCH_CONCURRENCY);
    expect(fake.max()).toBeGreaterThan(1);
  });

  it("fetches the full set when the voyage budget allows, with guests = crew size and adults per home airport", async () => {
    config.limits.spend.trip.routestack = 100;
    const { helm, fake } = helmWith();
    const { t } = await voyage(helm);
    await helm.live.settled(t._id);
    expect(fake.calls.filter((c) => c.kind === "hotels")).toHaveLength(6);
    expect(fake.calls.filter((c) => c.kind === "flights")).toHaveLength(18);
    expect(fake.calls.filter((c) => c.kind === "hotels").every((c) => c.guests === 4)).toBe(true);
    expect(fake.calls.find((c) => c.origin === "ATL")?.adults).toBe(2);
    expect(fake.calls.find((c) => c.origin === "ORD")?.adults).toBe(1);
    // a second prefetch (the table starting) doesn't search again
    await helm.live.prefetch(t, helm.table.pricingCrew(t));
    expect(fake.calls).toHaveLength(24);
  });

  it("respects the voyage cap: only the top 2 ranked ports × the common window, and never more than what's left", async () => {
    config.limits.spend.trip.routestack = 6;
    const { helm, fake } = helmWith();
    const { t } = await voyage(helm);
    const report = await helm.live.settled(t._id);
    expect(report).toMatchObject({ planned: 6, trimmed: true });
    expect(fake.calls).toHaveLength(6);
    expect(new Set(fake.calls.map((c) => c.cityId)).size).toBeLessThanOrEqual(2);
    expect(new Set(fake.calls.map((c) => c.window))).toEqual(new Set(["W1"]));
    expect(fake.calls[0].kind).toBe("hotels");
  });

  it("skips home ports (no flight search from the port's own airport)", async () => {
    config.limits.spend.trip.routestack = 100;
    const { helm, fake } = helmWith();
    const { trip, member: org } = helm.createTrip({ name: "Home", organizerName: "Ann", band: 1, origin: "JFK", cityIds: ["NYC", "LIS"].filter((c) => helm.ds.cities.some((x) => x._id === c)) as CityId[], windowIds: ["W1"] });
    if (trip.candidateCityIds.length < 2) return; // no NYC port in this dataset
    const b = helm.join(trip._id, { name: "Bo", band: 2, origin: "ORD" }).member;
    for (const m of [org, b]) await helm.submitBrief(trip._id, m._id, { capCents: 300_000, dateWindowIds: ["W1"], mustHaves: [], dealbreakers: [] });
    await helm.live.settled(trip._id);
    expect(fake.calls.some((c) => c.kind === "flights" && c.cityId === "NYC" && c.origin === "JFK")).toBe(false);
    expect(fake.calls.some((c) => c.kind === "flights" && c.cityId === "LIS" && c.origin === "JFK")).toBe(true);
  });

  it("skips fares past the airlines' sales horizon (stays are still searched)", async () => {
    config.limits.spend.trip.routestack = 100;
    const { helm, fake } = helmWith();
    const far = helm.ds.dateWindows.find((w) => Date.parse(w.start) - Date.now() > FLIGHT_HORIZON_DAYS * 86_400_000);
    if (!far) return; // every window is within the horizon today
    const { trip, member: org } = helm.createTrip({ name: "Far", organizerName: "Ann", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"], windowIds: [far.id] });
    await helm.submitBrief(trip._id, org._id, { capCents: 300_000, dateWindowIds: [far.id], mustHaves: [], dealbreakers: [] });
    const b = helm.join(trip._id, { name: "Bo", band: 2, origin: "ORD" }).member;
    await helm.submitBrief(trip._id, b._id, { capCents: 300_000, dateWindowIds: [far.id], mustHaves: [], dealbreakers: [] });
    await helm.live.settled(trip._id);
    expect(fake.calls.filter((c) => c.kind === "flights")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.kind === "hotels").length).toBeGreaterThan(0);
  });

  it("does nothing for the Expo seed (curated only) or with ROUTESTACK_MODE=off", async () => {
    const a = helmWith();
    const expo = await seedExpo(a.helm);
    await a.helm.live.settled(expo.tripId);
    await a.helm.startTable(expo.tripId, { memberId: expo.organizer.memberId });
    expect(a.fake.calls).toHaveLength(0);
    expect(a.helm.trip(expo.tripId).curatedOnly).toBe(true);
    const plain = new TripService();
    const t = a.helm.trip(expo.tripId);
    // the Expo chart book is exactly the curated one
    expect(JSON.stringify(a.helm.table.chartBook(t))).toBe(JSON.stringify(buildChartBook(plain.ds, a.helm.table.pricingCrew(t), t.candidateCityIds, 12)));
    expect(a.helm.table.chartBook(t).every((p) => p.priceSource === "estimated")).toBe(true);

    const b = helmWith({ mode: "off" });
    const r = await seedRandom(b.helm, 7);
    await b.helm.live.settled(r.tripId);
    expect(b.fake.calls).toHaveLength(0);
  });
});

describe("the chart book with the live overlay", () => {
  it("prefers live stays and fares (live > curated > modelled) and labels those plans live", async () => {
    config.limits.spend.trip.routestack = 100;
    const { helm } = helmWith();
    const { t } = await voyage(helm);
    await helm.live.settled(t._id);
    const book = helm.table.chartBook(t);
    expect(book.length).toBeGreaterThan(0);
    for (const p of book) {
      expect(p.hotelId).toMatch(/^RS-h-/); // every port × window had live stays
      expect(p.stay?.source).toBe("routestack");
      expect(p.priceSource).toBe("live");
      expect(p.priceFeed).toBe("sandbox");
      for (const m of p.members) expect(m.flightId).toMatch(/^RS-f-/);
      // approximate locations: legs and the public map use the port's centre
      const city = helm.ds.cities.find((c) => c._id === p.cityId)!;
      expect([p.stay!.lat, p.stay!.lng]).toEqual([city.centerLat, city.centerLng]);
    }
    // the shared dataset never sees a live option
    expect(helm.ds.hotels.some((h) => h._id.startsWith("RS-"))).toBe(false);
    expect(helm.ds.flights.some((f) => f._id.startsWith("RS-"))).toBe(false);
  });

  it("falls back to curated / modelled when the provider returns null", async () => {
    config.limits.spend.trip.routestack = 100;
    const { helm, fake } = helmWith({ nothing: true });
    const { t } = await voyage(helm);
    await helm.live.settled(t._id);
    expect(fake.calls.length).toBeGreaterThan(0);
    // a later prefetch (the table starting) doesn't send the searches that just fell back again
    const n = fake.calls.length;
    await helm.live.prefetch(t, helm.table.pricingCrew(t));
    expect(fake.calls).toHaveLength(n);
    const book = helm.table.chartBook(t);
    expect(book.every((p) => p.priceSource === "estimated" && !p.stay && !p.liveBand)).toBe(true);
    expect(JSON.stringify(book)).toBe(JSON.stringify(buildChartBook(helm.ds, helm.table.pricingCrew(t), t.candidateCityIds, 12)));
  });

  it("a live fare that breaks a dealbreaker, or sits outside the port's live band, falls back per member", () => {
    const ds = new TripService().ds;
    const m: PricingMember = { ...EXPO_CREW[0], brief: { ...EXPO_CREW[0].brief, dealbreakers: ["layovers_2plus"] } };
    const base = chooseFlight(ds, m, "LIS", "W1");
    const band = liveBand(ds, "LIS", "W1")!;
    const inv = emptyInventory();
    expect(base.violates).toEqual([]);
    const fare = (id: string, cents: number, twoStops: boolean): LiveFlight => ({ ...base.flight!, _id: id, priceCents: cents, stops: twoStops ? 2 : 0, source: "routestack", modelled: undefined });
    inv.flights.set(liveFlightKey("LIS", "W1", m.origin), [fare("RS-f-2stops", band.lowCents + 100, true)]);
    expect(chooseFlight(ds, m, "LIS", "W1", inv).flight?._id).toBe(base.flight?._id);
    inv.flights.set(liveFlightKey("LIS", "W1", m.origin), [fare("RS-f-cheap", band.lowCents - 100, false), fare("RS-f-dear", band.highCents + 100, false)]);
    expect(chooseFlight(ds, m, "LIS", "W1", inv).flight?._id).toBe(base.flight?._id);
    inv.flights.set(liveFlightKey("LIS", "W1", m.origin), [fare("RS-f-ok", base.flight!.priceCents + 5_000, false)]);
    expect(chooseFlight(ds, m, "LIS", "W1", inv).flight?._id).toBe("RS-f-ok"); // live wins even when dearer
  });

  it("public views stay public: the range holds the exact total, ignores the crew's home airports, and resolves the live stay", () => {
    const ds = new TripService().ds;
    const crewA = EXPO_CREW.map((m) => ({ ...m, brief: { ...m.brief, dateWindowIds: ["W1"] } }));
    const crewB = crewA.map((m, i) => ({ ...m, origin: ["SEA", "DEN", "BOS"][i] }));
    const stay: LiveStay = { _id: "RS-h-777", kind: "hotel", cityId: "LIS", name: "Live Stay", neighborhood: "1.2 km from the centre", lat: 38.72, lng: -9.14, stayType: "hotel", nightlyCents: 30_000, sleeps: 3, rating: 4.2, source: "routestack", approxLocation: true };
    const withFares = (crew: PricingMember[]) => {
      const inv = emptyInventory();
      inv.hotels.set(liveHotelKey("LIS", "W1", crew.length), [stay]);
      for (const m of crew) {
        const f = [...flightsFor(ds, "LIS", m.origin, "W1")].sort((a, b) => a.priceCents - b.priceCents)[0];
        inv.flights.set(liveFlightKey("LIS", "W1", m.origin), [{ ...f, _id: `RS-f-${m.origin}`, redEye: false, stops: 0, priceCents: Math.round(f.priceCents * 1.1), source: "routestack" }]);
      }
      return inv;
    };
    const pa = buildPlan(ds, crewA, "LIS", "W1", stay, withFares(crewA));
    const pb = buildPlan(ds, crewB, "LIS", "W1", stay, withFares(crewB));
    for (const p of [pa, pb]) {
      expect(p.priceSource).toBe("live");
      const r = publicTotalRange(ds, p);
      expect(r.lowCents).toBeLessThanOrEqual(p.groupCents);
      expect(r.highCents).toBeGreaterThanOrEqual(p.groupCents);
      const pub = toPublic(ds, p, "A");
      expect(pub).toMatchObject({ priceSource: "live", priceFeed: "sandbox", hotelId: "RS-h-777", hotelName: "Live Stay" });
      const json = JSON.stringify(pub);
      for (const m of p.members) {
        expect(json).not.toContain(`"${m.memberId}"`);
        expect(json).not.toContain(String(m.amountCents));
        expect(json).not.toContain(m.flightId);
        expect(json).not.toMatch(/"(SEA|DEN|BOS|ATL|ORD|JFK)"/);
      }
      expect(toPrivate(p, p.members[0].memberId)?.lines.some((l) => l.kind === "flight")).toBe(true);
    }
    const picks = (x: Plan) => x.days.flatMap((d) => d.items.map((it) => it.activityId)).sort().join();
    if (picks(pa) === picks(pb)) {
      expect(publicTotalRange(ds, pb)).toEqual(publicTotalRange(ds, pa)); // other home airports, same public range
      expect(toPublic(ds, pb).days).toEqual(toPublic(ds, pa).days);
    }
  });
});

/** Holds the engine on the first line matching `which` (its voice step, which the engine awaits) until released. */
function holdLine(helm: TripService, which: (turn: { act: string; watch?: number }) => boolean) {
  type Hooks = { voice(turnId: string, text: string, key?: string): Promise<number | null> };
  const table = helm.table as unknown as { engineHooks(t: { negotiation: { turns: { turnId: string; act: string; watch?: number }[] } }, m: unknown): Hooks };
  const original = table.engineHooks.bind(table);
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let held = false;
  table.engineHooks = (t, memories) => {
    const io = original(t, memories);
    const voice = io.voice.bind(io);
    io.voice = async (turnId, text, key) => {
      const turn = t.negotiation.turns.find((x) => x.turnId === turnId);
      if (!held && turn && which(turn)) { held = true; await released; }
      return voice(turnId, text, key);
    };
    return io;
  };
  return release;
}

describe("re-pricing: only before the Dry Run", () => {
  it("results landing while the Captain opens re-price the chart book; the Two Charts and the seals keep those prices", async () => {
    config.limits.spend.trip.routestack = 100;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { helm, member } = helmWith({ gate });
    const { t, org } = await voyage(helm);
    const release = holdLine(helm, (turn) => turn.act === "OPEN");
    // the table starts before anything lands: the chart book is estimated
    const started = helm.startTable(t._id, { memberId: org._id });
    expect(t.status).toBe("AT_TABLE");
    const book = helm.chartBooks.get(t._id)!;
    expect(book.every((p) => p.priceSource === "estimated")).toBe(true);
    // results land while the Captain is still opening (Watch 0): re-priced in place, the engine's own array
    open();
    await helm.live.settled(t._id);
    expect(helm.chartBooks.get(t._id)).toBe(book);
    expect(book.some((p) => p.priceSource === "live")).toBe(true);
    release();
    await started;
    await until(() => t.status === "DRY_RUN", 5_000);
    expect(t.status).toBe("DRY_RUN");
    const [a, b] = helm.table.shortlist(t);
    expect(t.shortlistPlans!.map((p) => p._id)).toEqual([a._id, b._id]);
    expect(t.shortlistPlans![0]).toBe(a);
    const before = JSON.stringify(t.shortlistPlans);
    // plan:private carried exactly the shortlisted shares
    for (const p of [a, b]) for (const m of p.members) {
      const sent = member.filter((x) => x.ev === "plan:private" && x.id === m.memberId && x.p.planId === p._id).at(-1);
      expect(sent?.p.amountCents).toBe(m.amountCents);
    }
    // anything landing now changes nothing (Dry Run)
    const inv = helm.liveInventory.get(t._id)!;
    for (const [k, list] of inv.flights) inv.flights.set(k, list.map((f) => ({ ...f, priceCents: f.priceCents - 1_000 })));
    expect(helm.table.repriceLive(t)).toBe(0);
    expect(JSON.stringify(t.shortlistPlans)).toBe(before);
    // … nor after the pick: the booking's shares are the Two Charts' shares
    await helm.pick(t._id, { memberId: org._id }, a._id);
    expect(helm.table.repriceLive(t)).toBe(0);
    const booking = helm.currentBooking(t)!;
    for (const m of a.members) expect(booking.seals.find((s) => s.memberId === m.memberId)?.amountCents).toBe(m.amountCents);
  });

  it("from Watch 1 on, a re-price keeps every plan's port, window and stay (only fares move)", async () => {
    config.limits.spend.trip.routestack = 100;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { helm } = helmWith({ gate });
    const { t, org } = await voyage(helm);
    const release = holdLine(helm, (turn) => turn.act !== "OPEN" && turn.watch === 1);
    const started = helm.startTable(t._id, { memberId: org._id });
    const ids = helm.chartBooks.get(t._id)!.map((p) => p._id);
    await until(() => t.negotiation.watch === 1 && t.negotiation.turns.some((x) => x.act !== "OPEN"), 5_000);
    expect(t.negotiation.watch).toBe(1);
    open();
    await helm.live.settled(t._id);
    const book = helm.chartBooks.get(t._id)!;
    expect(book.map((p) => p._id)).toEqual(ids);
    expect(book.some((p) => p.members.some((m) => m.flightId.startsWith("RS-f-")))).toBe(true);
    expect(book.every((p) => !p.hotelId.startsWith("RS-h-"))).toBe(true); // new live stays wait for the next meeting
    release();
    await started;
    await until(() => t.status === "DRY_RUN", 5_000);
  });
});
