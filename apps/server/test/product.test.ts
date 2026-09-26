/**
 * The full product: ports from city files, ~40 home airports, the flight model, ten date windows, the organizer's
 * course (named ports, regions, anywhere) and the random demo voyage. The Expo numbers stay exactly as they were.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { City, Dataset, Tag } from "@all-ayes/shared";
import { ORIGINS } from "@all-ayes/shared";
import {
  addCityPack, datasetRev, indexOf, loadDataset, mergePack, readCityFiles, validateCityPack, type CityPack,
} from "../src/data/loader.js";
import { baseFareUsd, flightsFor, isHomePort, modelFlights, publicFlights } from "../src/fit/flights.js";
import { buildChartBook, buildPlan, toPublic, type PricingMember } from "../src/fit/pricing.js";
import { buildPrivacyContext } from "../src/privacy/context.js";
import { pickPorts } from "../src/fit/prerank.js";
import { TripService } from "../src/trips/service.js";
import { HelmError } from "../src/util/errors.js";
import { randomVoyagePlan, seedExpo, seedRandom } from "../src/demo/seed.js";
import { travel } from "../src/dryrun/walking.js";
import { EXPO_CREW } from "./fixtures.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/cities/", import.meta.url));
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };

/** A fresh copy of the loaded dataset (so a test can add ports without touching the shared one). */
function copyDs(): Dataset {
  const ds = loadDataset();
  return {
    ...ds, cities: ds.cities.map((c) => ({ ...c })), dateWindows: [...ds.dateWindows], flights: [...ds.flights],
    hotels: [...ds.hotels], activities: [...ds.activities], overrides: [...ds.overrides],
  };
}

/** A small valid port at a given place (2 stays, 2 group moments, 2 picks). */
function makePack(id: string, at: { lat: number; lng: number; utcOffset: number; region?: City["region"]; country?: string; state?: string }): CityPack {
  const c = { lat: at.lat, lng: at.lng };
  const act = (slug: string, role: "group" | "pick", tags: Tag[], start: string, dLat: number) => ({
    _id: `${id}-a-${slug}`, kind: "activity" as const, cityId: id, name: slug, short: slug, tags, lat: c.lat + dLat, lng: c.lng,
    durationMin: 120, priceCents: 2000, startEarliest: start, startLatest: start === "20:00" ? "21:00" : "15:00", role,
  });
  return {
    city: {
      _id: id, name: `Port ${id}`, country: at.country ?? "Testland", region: at.region ?? "Europe", ...(at.state ? { state: at.state } : {}),
      airport: { code: id, lat: c.lat, lng: c.lng }, utcOffset: at.utcOffset, centerLat: c.lat, centerLng: c.lng, tileRadiusKm: 1.5, publicFlags: [],
    },
    hotels: [
      { _id: `${id}-h-flat`, kind: "hotel", cityId: id, name: "Flat", neighborhood: "Center", lat: c.lat, lng: c.lng, stayType: "apartment", nightlyCents: 20_000, sleeps: 4, rating: 4.4 },
      { _id: `${id}-h-inn`, kind: "hotel", cityId: id, name: "Inn", neighborhood: "Center", lat: c.lat, lng: c.lng + 0.005, stayType: "hotel", nightlyCents: 24_000, sleeps: 4, rating: 4.2 },
    ],
    activities: [
      act("walk", "group", ["history"], "10:00", 0.004), act("dinner", "group", ["food", "nightlife"], "20:00", 0.003),
      act("beach", "pick", ["beach", "chill"], "10:00", 0.006), act("gallery", "pick", ["museums", "music"], "11:00", 0.002),
    ],
  };
}

// ---------- 1. loader: merge + validation ----------
describe("loader: city files merge into the dataset", () => {
  it("the fixture port validates; a bad one is refused with its reason; a broken file is skipped", () => {
    const files = readCityFiles(FIXTURES);
    const tst = files.find((f) => f.file === "TST.json")!;
    const bad = files.find((f) => f.file === "BAD.json")!;
    const v = validateCityPack(tst.pack);
    expect(typeof v).toBe("object");
    expect((v as CityPack).overrides?.[0].mode).toBe("transit");
    expect(validateCityPack(bad.pack)).toMatch(/region/);

    const dir = mkdtempSync(join(tmpdir(), "cities-"));
    writeFileSync(join(dir, "OK1.json"), JSON.stringify(makePack("OK1", { lat: 10, lng: 10, utcOffset: 1 })));
    writeFileSync(join(dir, "HALF.json"), "{ \"city\": { \"_id\": ");
    expect(readCityFiles(dir).map((f) => f.file)).toEqual(["OK1.json"]); // the half-written file is skipped
    expect(readCityFiles(join(dir, "nope"))).toEqual([]);
  });

  it("merging adds the port, its places, overrides and hills; duplicates and bad packs are refused", () => {
    const ds = copyDs();
    const before = datasetRev(ds);
    const n = ds.cities.length;
    expect(mergePack(ds, readCityFiles(FIXTURES).find((f) => f.file === "TST.json")!.pack)).toBeNull();
    expect(datasetRev(ds)).toBe(before + 1);
    const ix = indexOf(ds); // rebuilt for the new revision
    expect(ds.cities).toHaveLength(n + 1);
    expect(ix.city.get("TST")?.region).toBe("Europe");
    expect(ix.hotelsOf("TST").map((h) => h._id)).toEqual(["TST-h-river-flat", "TST-h-bunk"]);
    expect(ix.hilly.has("TST-a-fado")).toBe(true);
    // the override (transit) wins over the walking model; the hills slow a walk down
    const leg = travel(ds, { id: "TST-h-river-flat", lat: 41.1408, lng: -8.6131 }, { id: "TST-a-beach", lat: 41.1523, lng: -8.6766 });
    expect(leg).toMatchObject({ mode: "transit", minutes: 35 });
    expect(mergePack(ds, readCityFiles(FIXTURES).find((f) => f.file === "TST.json")!.pack)).toMatch(/already exists/);
    expect(mergePack(ds, { city: { _id: "lis" } })).toMatch(/_id/);
    const noAirport = makePack("NOA", { lat: 1, lng: 1, utcOffset: 0 }) as unknown as { city: Record<string, unknown> };
    delete noAirport.city.airport;
    expect(mergePack(ds, noAirport)).toMatch(/airport/);
    const wrongHotel = makePack("WRH", { lat: 1, lng: 1, utcOffset: 0 });
    wrongHotel.hotels[0]._id = "LIS-h-stolen";
    expect(mergePack(ds, wrongHotel)).toMatch(/hotel/);
  });

  it("Pacific is read as Oceania; generated (W-) ids are accepted; addCityPack throws on a bad pack", () => {
    const ds = copyDs();
    const hnl = makePack("PAC", { lat: 21.3, lng: -157.9, utcOffset: -10 }) as unknown as { city: Record<string, unknown> };
    hnl.city.region = "Pacific";
    expect(mergePack(ds, hnl)).toBeNull();
    expect(indexOf(ds).city.get("PAC")?.region).toBe("Oceania");
    const w = makePack("W-R6N2AL", { lat: 43.51, lng: 16.44, utcOffset: 1 });
    expect(addCityPack(w, ds)._id).toBe("W-R6N2AL");
    expect(() => addCityPack({ city: {} }, ds)).toThrow(/refused/);
  });

  it("the real dataset: the Three Ports carry airport, region, offset; Lisbon's hills come from the data", () => {
    const ds = loadDataset();
    const ix = indexOf(ds);
    expect(ix.city.get("LIS")).toMatchObject({ airport: { code: "LIS", lat: 38.7813, lng: -9.1359 }, utcOffset: 0, region: "Europe" });
    expect(ix.city.get("MEX")).toMatchObject({ airport: { code: "MEX" }, utcOffset: -6 });
    expect(ix.city.get("YUL")).toMatchObject({ airport: { code: "YUL" }, utcOffset: -5 });
    expect([...ix.hilly].filter((x) => x.startsWith("LIS-")).sort()).toEqual(
      ["LIS-a-bairro-night", "LIS-a-fado", "LIS-a-tram-castle", "LIS-h-bairro-hostel", "LIS-h-casa-alfama"]);
    // every city file that validates is in the dataset (the rest are logged and skipped)
    const dir = fileURLToPath(new URL("../src/data/cities/", import.meta.url));
    for (const { pack } of readCityFiles(dir)) {
      const v = validateCityPack(pack);
      if (typeof v !== "string") expect(ix.city.has(v.city._id)).toBe(true);
    }
    expect(ds.dateWindows.map((w) => w.id).slice(0, 2)).toEqual(["W1", "W2"]);
    expect(ds.dateWindows.length).toBeGreaterThanOrEqual(10);
  });
});

// ---------- 2. the flight model ----------
describe("flight model", () => {
  const ds = copyDs();
  const places = {
    NEAR: { lat: 42.36, lng: -71.06, utcOffset: -5, region: "United States" as const, country: "United States", state: "MA" }, // ~300 km from JFK
    MID: { lat: 25.76, lng: -80.19, utcOffset: -5, region: "United States" as const, country: "United States", state: "FL" }, // ~1,750 km
    EUR: { lat: 48.86, lng: 2.35, utcOffset: 1, region: "Europe" as const, country: "France" }, // ~5,800 km
    FAR: { lat: 35.68, lng: 139.69, utcOffset: 9, region: "Asia" as const, country: "Japan" }, // ~10,800 km
    HOME: { lat: 40.71, lng: -74.0, utcOffset: -5, region: "United States" as const, country: "United States", state: "NY" }, // New York
  };
  for (const [id, at] of Object.entries(places)) expect(mergePack(ds, makePack(`Z${id.slice(0, 3)}`, at))).toBeNull();
  const Z = (k: keyof typeof places) => `Z${k.slice(0, 3)}`;
  const cheapest = (city: string, origin: string, w: string) => Math.min(...flightsFor(ds, city, origin, w).map((f) => f.priceCents));

  it("is deterministic: the same route and window always give the same options", () => {
    const a = modelFlights(ds, Z("EUR"), "ORD", "W4");
    const b = modelFlights(copyDsWith(Z("EUR"), places.EUR), Z("EUR"), "ORD", "W4");
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(a.length).toBeLessThanOrEqual(3);
    expect(b).toEqual(a);
  });

  it("prices rise with distance; fares sit on $5 and never on a round $50; stops cost less", () => {
    for (const w of ["W3", "W7", "W9"]) {
      const p = (["NEAR", "MID", "EUR", "FAR"] as const).map((k) => cheapest(Z(k), "JFK", w));
      expect(p[0]).toBeLessThan(p[1]);
      expect(p[1]).toBeLessThan(p[2]);
      expect(p[2]).toBeLessThan(p[3]);
    }
    for (const c of ["NEAR", "MID", "EUR", "FAR"] as const) for (const o of ORIGINS) for (const f of flightsFor(ds, Z(c), o, "W5")) {
      if (f.homePort) continue;
      expect(f.priceCents % 500).toBe(0);
      expect(f.priceCents % 5000).not.toBe(0);
      expect(f.modelled).toBe(true);
      expect(f.departLocal.startsWith("2027-08-07")).toBe(true); // leaves on the window's first day
      expect(f.returnLocal.startsWith("2027-08-14")).toBe(true); // comes back on its last
    }
    expect(baseFareUsd(500)).toBeLessThan(baseFareUsd(9000));
    // holiday windows cost more than fall break
    expect(cheapest(Z("EUR"), "ATL", "W9")).toBeGreaterThan(cheapest(Z("EUR"), "ATL", "W7"));
  });

  it("red-eyes: eastbound transatlantic flights are overnight; a short hop by day isn't", () => {
    for (const o of ["JFK", "ATL", "ORD", "BOS"]) for (const f of flightsFor(ds, Z("EUR"), o, "W3")) {
      expect(f.redEye, `${o} ${f.departLocal} → ${f.arriveLocal} ${f.airline}`).toBe(true);
      expect(f.arriveLocal.slice(0, 10)).toBe("2027-05-29"); // lands the next morning
    }
    for (const f of flightsFor(ds, Z("NEAR"), "JFK", "W3")) expect(f.redEye).toBe(false);
  });

  it("a home port: no flight, $0, no flight line, and the member still fits", () => {
    expect(isHomePort(ds, "JFK", Z("HOME"))).toBe(true);
    expect(isHomePort(ds, "ATL", Z("HOME"))).toBe(false);
    const [f, ...more] = flightsFor(ds, Z("HOME"), "LGA", "W1");
    expect(more).toEqual([]);
    expect(f).toMatchObject({ priceCents: 0, homePort: true, redEye: false, stops: 0 });
    const crew: PricingMember[] = [
      { memberId: "a", name: "A", role: "organizer", origin: "JFK", brief: { capCents: 200_000, dateWindowIds: ["W1"], mustHaves: ["food"], dealbreakers: ["red_eye"] } },
      { memberId: "b", name: "B", role: "member", origin: "ATL", brief: { capCents: 200_000, dateWindowIds: ["W1"], mustHaves: ["beach"], dealbreakers: [] } },
    ];
    const plan = buildPlan(ds, crew, Z("HOME"), "W1", indexOf(ds).hotelsOf(Z("HOME"))[0]);
    const a = plan.members.find((m) => m.memberId === "a")!;
    expect(a.lines.some((l) => l.kind === "flight")).toBe(false);
    expect(a.fits).toBe(true);
    const b = plan.members.find((m) => m.memberId === "b")!;
    expect(b.lines.find((l) => l.kind === "flight")?.label).toBe(`Flight ATL⇄${Z("HOME")}`);
    expect(plan.days[0].arrivals?.map((x) => x.memberId)).toEqual(["b"]); // the home-port member has no landing
    // the public range still holds the real total
    const r = toPublic(ds, plan).groupRange;
    expect(r.lowCents).toBeLessThanOrEqual(plan.groupCents);
    expect(r.highCents).toBeGreaterThanOrEqual(plan.groupCents);
  });

  it("curated flights stay exactly as listed; other windows and airports are modelled", () => {
    const real = loadDataset();
    const curated = real.flights.filter((f) => f.cityId === "LIS" && f.origin === "ATL" && f.dateWindowId === "W1");
    expect(flightsFor(real, "LIS", "ATL", "W1")).toEqual(curated);
    expect(curated.map((f) => f.priceCents).sort()).toEqual([61200, 69000]);
    expect(flightsFor(real, "LIS", "ATL", "W2").map((f) => f.priceCents).sort()).toEqual([66100, 74500]);
    expect(flightsFor(real, "LIS", "ATL", "W3").every((f) => f.modelled)).toBe(true);
    expect(flightsFor(real, "LIS", "SEA", "W1").every((f) => f.modelled)).toBe(true);
    expect(publicFlights(real, "YUL", "W1").some((f) => f.homePort && f.origin === "YUL")).toBe(true);
  });
});

function copyDsWith(id: string, at: { lat: number; lng: number; utcOffset: number; region?: City["region"]; country?: string }) {
  const ds = copyDs();
  mergePack(ds, makePack(id, at));
  return ds;
}

// ---------- 3. the Expo numbers ----------
describe("the Expo scenario is unchanged", () => {
  it("Lisbon shares $1,038 / $868 / $963 ($2,869); Mexico City $1,975", () => {
    const ds = loadDataset();
    const book = buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"]);
    const lis = book.find((p) => p._id === "LIS-W1-casa-alfama")!;
    expect(lis.members.map((m) => m.amountCents)).toEqual([103_800, 86_800, 96_300]);
    expect(lis.groupCents).toBe(286_900);
    expect(book.find((p) => p._id === "MEX-W1-roma-flat")!.groupCents).toBe(197_500);
    // no public number can read as anyone's cap: range bounds sit on $25 / $75
    for (const p of book) {
      const r = toPublic(ds, p).groupRange;
      expect(r.lowCents % 5000).toBe(2500);
      expect(r.highCents % 5000).toBe(2500);
    }
  });
});

// ---------- 4. the course: ports, regions, windows ----------
describe("createTrip: the organizer's course", () => {
  const helm = new TripService();
  const base = { name: "x", organizerName: "Rae", band: 1 as const, origin: "ATL" };

  it("named ports: 2–4 known ones; windows: 1–3, in date order; defaults: 3 random ports and the next 2 windows", async () => {
    const four = helm.ds.cities.slice(0, 4).map((c) => c._id);
    expect(helm.createTrip({ ...base, cityIds: four }).trip.candidateCityIds).toEqual(four);
    expect(await code(() => helm.createTrip({ ...base, cityIds: ["LIS", "NOPE"] }))).toBe("BAD_INPUT");
    const t = helm.createTrip({ ...base, cityIds: ["LIS", "MEX"], windowIds: ["W4", "W3", "W3", "WX"] }).trip;
    expect(t.candidateWindowIds).toEqual(["W3", "W4"]);
    expect(t.destination).toEqual({ kind: "cities", cityIds: ["LIS", "MEX"] });
    expect(await code(() => helm.createTrip({ ...base, cityIds: ["LIS", "MEX"], windowIds: ["W3", "W4", "W5", "W6"] }))).toBe("BAD_INPUT");
    expect(await code(() => helm.createTrip({ ...base, cityIds: ["LIS", "MEX"], windowIds: ["WX"] }))).toBe("BAD_INPUT");
    const d = helm.createTrip(base).trip;
    expect(d.candidateCityIds).toHaveLength(Math.min(3, helm.ds.cities.length));
    expect(d.candidateWindowIds).toEqual(["W1", "W2"]);
    // the snapshot offers only the voyage's windows
    expect(helm.state(t).dateWindows.map((w) => w.id)).toEqual(["W3", "W4"]);
    expect(helm.state(t).destination).toMatchObject({ kind: "cities", label: "Lisbon and Mexico City", portsChosen: true });
  });

  it("regions and anywhere: ports are chosen at the table; unknown regions are refused", async () => {
    const eu = helm.createTrip({ ...base, destination: { kind: "regions", regions: ["Europe"] } }).trip;
    expect(eu.candidateCityIds).toEqual([]);
    const pub = helm.state(eu).destination!;
    expect(pub).toMatchObject({ kind: "regions", regions: ["Europe"], label: "Europe", portsChosen: false });
    expect(pub.scope.every((c) => c.region === "Europe")).toBe(true);
    expect(pub.scope.some((c) => c.cityId === "LIS")).toBe(true);
    expect(await code(() => helm.createTrip({ ...base, destination: { kind: "regions", regions: ["Atlantis" as never] } }))).toBe("BAD_INPUT");
    const any = helm.createTrip({ ...base, destination: { kind: "anywhere" } }).trip;
    expect(helm.state(any).destination).toMatchObject({ kind: "anywhere", label: "anywhere" });
  });

  it("briefs: only the voyage's windows count; loved / skipped places must be in scope", async () => {
    const { trip, member } = helm.createTrip({ ...base, cityIds: ["LIS", "MEX"], windowIds: ["W3"] });
    const brief = { capCents: 120_000, dateWindowIds: ["W1"], mustHaves: [], dealbreakers: [] };
    expect(await code(() => helm.submitBrief(trip._id, member._id, brief))).toBe("BAD_INPUT");
    await helm.submitBrief(trip._id, member._id, { ...brief, dateWindowIds: ["W1", "W3"], loves: ["LIS", "YUL", "Europe"], skips: ["LIS", "MEX"] });
    const b = helm.briefs.get(member._id)!;
    expect(b.dateWindowIds).toEqual(["W3"]);
    expect(b.loves).toEqual(["LIS", "Europe"]);
    expect(b.skips).toEqual(["MEX"]);
  });
});

// ---------- 5. seeds and tables ----------
async function toDryRun(helm: TripService, tripId: string, organizerId: string) {
  await helm.startTable(tripId, { memberId: organizerId });
  for (let i = 0; i < 2000 && helm.trip(tripId).status !== "DRY_RUN"; i++) await new Promise((r) => setTimeout(r, 2));
  return helm.trip(tripId);
}
function quietHelm() {
  const helm = new TripService();
  const turns: string[] = [];
  helm.attachBus({ trip: (_t, ev, p) => { if (ev === "turn:new") turns.push((p as { text: string }).text); }, member: () => undefined });
  return { helm, turns };
}

describe("the random demo voyage", () => {
  afterEach(() => vi.useRealTimers());

  it("is deterministic for a seed and varied across seeds", () => {
    const ds = loadDataset();
    const ids = ds.cities.map((c) => c._id), wins = ds.dateWindows.map((w) => w.id);
    expect(randomVoyagePlan(42, ids, wins)).toEqual(randomVoyagePlan(42, ids, wins));
    const plans = Array.from({ length: 10 }, (_, i) => randomVoyagePlan(i, ids, wins));
    expect(new Set(plans.map((p) => p.ports.join())).size).toBeGreaterThan(1);
    for (const p of plans) {
      expect(p.crew.length).toBeGreaterThanOrEqual(3);
      expect(p.crew.length).toBeLessThanOrEqual(8);
      expect(p.crew.filter((c) => c.role === "absent")).toHaveLength(1);
      expect(p.crew[0].role).toBe("organizer");
      expect(new Set(p.crew.map((c) => c.name)).size).toBe(p.crew.length);
      expect(p.windows.length).toBeGreaterThanOrEqual(1);
      expect(p.windows.length).toBeLessThanOrEqual(3);
    }
  });

  it("20 seeds each run to DRY_RUN with two charts, and they don't all land on the same port", async () => {
    const { helm } = quietHelm();
    const winners = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const s = await seedRandom(helm, seed);
      const absent = s.crew.find((c) => c.role === "absent")!;
      expect(helm.payments.standing.has(absent.memberId)).toBe(true); // the away member's standing instruction
      const t = await toDryRun(helm, s.tripId, s.organizer.memberId);
      expect(t.status).toBe("DRY_RUN");
      expect(t.shortlistIds).toHaveLength(2);
      const [a] = helm.table.shortlist(t);
      expect(t.candidateCityIds).toContain(a.cityId);
      winners.add(a.cityId);
    }
    expect(winners.size).toBeGreaterThan(1);
  }, 120_000);

  it("the scripted Expo voyage keeps its three ports and windows", async () => {
    const { helm } = quietHelm();
    const s = await seedExpo(helm);
    const t = helm.trip(s.tripId);
    expect(t.candidateCityIds).toEqual(["LIS", "MEX", "YUL"]);
    expect(t.candidateWindowIds).toEqual(["W1", "W2"]);
    expect(s.crew.map((c) => c.name)).toEqual(["Rae", "Maya", "Dev"]);
  });
});

describe("regions: the table pre-ranks the ports in scope", () => {
  it("a Europe voyage puts 4 European ports on the chart, and different crews get different ports", async () => {
    const { helm, turns } = quietHelm();
    const europe = new Set(helm.ds.cities.filter((c) => c.region === "Europe").map((c) => c._id));
    const charts = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) {
      const plan = randomVoyagePlan(seed, [...europe], helm.ds.dateWindows.map((w) => w.id));
      const [org, ...rest] = plan.crew;
      const { trip, member } = helm.createTrip({
        name: "EU", organizerName: org.name, band: org.band, origin: org.origin, destination: { kind: "regions", regions: ["Europe"] }, windowIds: plan.windows,
      });
      await helm.submitBrief(trip._id, member._id, org.brief);
      for (const c of rest) {
        const j = helm.join(trip._id, { name: c.name, band: c.band, origin: c.origin });
        await helm.submitBrief(trip._id, j.member._id, c.brief);
      }
      turns.length = 0;
      const t = await toDryRun(helm, trip._id, member._id);
      expect(t.status).toBe("DRY_RUN");
      expect(t.candidateCityIds.length).toBe(Math.min(4, europe.size));
      for (const id of t.candidateCityIds) expect(europe.has(id)).toBe(true);
      expect(turns[0]).toMatch(/We're looking at Europe\./);
      expect(helm.state(t).destination?.portsChosen).toBe(true);
      charts.add([...t.candidateCityIds].sort().join());
    }
    if (europe.size > 4) expect(charts.size).toBeGreaterThan(1);
  }, 60_000);

  it("loved places pull a port up; skipped ones push it down", () => {
    const ds = loadDataset();
    const europe = ds.cities.filter((c) => c.region === "Europe").map((c) => c._id);
    const crew = (loves?: string[], skips?: string[]): PricingMember[] => EXPO_CREW.map((m) => ({ ...m, brief: { ...m.brief, dateWindowIds: ["W3"], loves, skips } }));
    const plain = pickPorts(ds, crew(), europe, ["W3"], "salt", europe.length);
    const last = plain.at(-1)!;
    expect(pickPorts(ds, crew([last]), europe, ["W3"], "salt", europe.length).indexOf(last)).toBeLessThan(plain.indexOf(last));
    expect(pickPorts(ds, crew(undefined, [plain[0]]), europe, ["W3"], "salt", europe.length).indexOf(plain[0])).toBeGreaterThan(0);
  });
});

// ---------- 6. performance ----------
describe("performance", () => {
  it("4 ports × 3 windows × 5 stays for a crew of 4: the chart book, its public views and privacy context stay fast", () => {
    const ds = loadDataset();
    const ports = ["LIS", "MEX", "YUL", ...ds.cities.filter((c) => !["LIS", "MEX", "YUL"].includes(c._id)).slice(0, 1).map((c) => c._id)];
    const zed: PricingMember = { memberId: "zed", name: "Zed", role: "member", origin: "SEA",
      brief: { capCents: 150_000, dateWindowIds: ["W3", "W4", "W5"], mustHaves: ["nightlife", "music", "nature"], dealbreakers: ["red_eye"] } };
    const crew: PricingMember[] = [...EXPO_CREW, zed]
      .map((m) => ({ ...m, brief: { ...m.brief, dateWindowIds: ["W3", "W4", "W5"] } }));
    const t0 = performance.now();
    const book = buildChartBook(ds, crew, ports, 12);
    const t1 = performance.now();
    const views = book.map((p) => toPublic(ds, p));
    buildPrivacyContext(ds, crew, book);
    const t2 = performance.now();
    expect(book.length).toBeLessThanOrEqual(12);
    expect(views.length).toBe(book.length);
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, `buildChartBook ${(t1 - t0).toFixed(1)} ms · views + privacy ${(t2 - t1).toFixed(1)} ms · ${book.length} plans`);
    expect(t2 - t0).toBeLessThan(1500);
  });
});
