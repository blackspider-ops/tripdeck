/**
 * "Any city on Earth" (docs/11-world-cities.md), the network side with a MOCKED fetch (never the real Nominatim or
 * Overpass): Nominatim mapping + caching + polite headers, the throttle, Overpass busy/failure paths, the pack store
 * and loader hook, and the /api/world routes.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CityPack } from "@all-ayes/shared";
import { Throttle, UpstreamBusy, WORLD_USER_AGENT, setWorldFetch, type Fetcher } from "../src/world/net.js";
import { isOsmRef, lookupPlace, nominatimStats, nominatimThrottle, resetNominatimCache, searchPlaces, toPlace } from "../src/world/nominatim.js";
import { fetchOverpass, overpassQuery, overpassThrottle } from "../src/world/overpass.js";
import { packFor, readStoredPack, resetPackCache, restoreWorldPacks, setAddCityPack, adoptPack } from "../src/world/packs.js";
import { curatedMatches, worldSearch } from "../src/world/search.js";
import { packIdFor } from "../src/world/pack.js";
import { worldRouter } from "../src/api/worldRoutes.js";

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./support/world/${name}`, import.meta.url)), "utf8"));
const NOMINATIM = fixture("nominatim-porto.json");
const OVERPASS = fixture("overpass-porto.json");
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake OSM: Nominatim search/lookup from the fixture, Overpass from the fixture; every call recorded. */
function fakeOsm(over: Partial<{ overpass: () => Response | Promise<Response>; nominatim: () => Response }> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith("https://overpass-api.de/")) return over.overpass ? over.overpass() : json(OVERPASS);
    if (url.includes("/lookup?")) {
      const ref = new URL(url).searchParams.get("osm_ids");
      return json(NOMINATIM.filter((r: { osm_type: string; osm_id: number }) => `${r.osm_type[0].toUpperCase()}${r.osm_id}` === ref));
    }
    if (url.includes("/search?")) return over.nominatim ? over.nominatim() : json(NOMINATIM);
    throw new Error(`unexpected ${url}`);
  };
  return { f: vi.fn(f), calls };
}

/** The module throttles' spacing is tested on its own Throttle instances; here it would only slow the suite down. */
nominatimThrottle.intervalMs = 0;
overpassThrottle.intervalMs = 0;
const wipeDisk = () => rmSync(join(process.env.DATA_DIR!, "world"), { recursive: true, force: true });
beforeEach(() => { wipeDisk(); resetNominatimCache({ persist: false }); resetPackCache(); setAddCityPack(null); });
afterEach(() => { setWorldFetch(null); setAddCityPack(undefined); vi.useRealTimers(); });

describe("no real network in tests", () => {
  it("the default fetcher refuses under vitest", async () => {
    setWorldFetch(null);
    await expect(fetchOverpass(41, -8, 3000)).rejects.toBeInstanceOf(UpstreamBusy);
  });
});

describe("Throttle", () => {
  it("spaces calls by the interval in arrival order", async () => {
    let t = 1_000;
    const sleeps: number[] = [];
    const th = new Throttle(1_000, 5, () => t, async (ms) => { sleeps.push(ms); });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => th.run(async () => { order.push(i); })));
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(order).toEqual([1, 2, 3]);
    t += 10_000; // idle long enough: no wait
    await th.run(async () => undefined);
    expect(sleeps).toHaveLength(2);
  });

  it("refuses at once past maxQueue (no unbounded backlog)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const th = new Throttle(1_000, 2, () => 0, () => gate);
    const a = th.run(async () => 1); // the first call doesn't wait (at === now)
    expect(await a).toBe(1);
    const b = th.run(async () => 2);
    const c = th.run(async () => 3);
    expect(th.waiting).toBe(2);
    await expect(th.run(async () => 4)).rejects.toBeInstanceOf(UpstreamBusy);
    release();
    expect(await Promise.all([b, c])).toEqual([2, 3]);
  });
});

describe("Nominatim", () => {
  it("maps a jsonv2 row to a place", () => {
    expect(toPlace(NOMINATIM[0])).toEqual({
      osmId: "R3372453", name: "Porto", country: "Portugal", countryCode: "PT", state: "Porto", stateCode: "PT-13",
      lat: 41.14945, lng: -8.61079, displayName: "Porto, Portugal", placeType: "city", importance: 0.71,
    });
    expect(toPlace({ osm_type: "node", osm_id: 5, lat: "x", lon: "1", name: "n" })).toBeNull();
    expect(isOsmRef("R3372453")).toBe(true);
    expect(isOsmRef("R0")).toBe(false);
    expect(isOsmRef("X12")).toBe(false);
    expect(isOsmRef("R12; drop")).toBe(false);
  });

  it("searches with the policy's parameters and headers, drops non-settlements, caches the answer", async () => {
    const osm = fakeOsm();
    setWorldFetch(osm.f);
    const before = nominatimStats.calls;
    const ps = await searchPlaces("  Porto ");
    expect(ps.map((p) => p.osmId)).toEqual(["R3372453", "N251837123"]); // the road is dropped
    expect(osm.calls).toHaveLength(1);
    const u = new URL(osm.calls[0].url);
    expect(u.origin + u.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(Object.fromEntries(u.searchParams)).toEqual({ format: "jsonv2", featuretype: "city", q: "porto", addressdetails: "1", limit: "8" });
    const h = osm.calls[0].init.headers as Record<string, string>;
    expect(h["User-Agent"]).toBe(WORLD_USER_AGENT);
    expect(h.Referer).toMatch(/^https?:\/\//);
    // same query (any case / spacing) → the cache; the place is known for a pack without another call
    expect((await searchPlaces("PORTO")).length).toBe(2);
    expect(await lookupPlace("R3372453")).toMatchObject({ name: "Porto" });
    expect(osm.calls).toHaveLength(1);
    expect(nominatimStats.calls - before).toBe(1);
  });

  it("a busy Nominatim is UpstreamBusy with its Retry-After", async () => {
    setWorldFetch(fakeOsm({ nominatim: () => json({}, 429, { "retry-after": "12" }) }).f);
    const e = await searchPlaces("lisbon").catch((x) => x);
    expect(e).toBeInstanceOf(UpstreamBusy);
    expect(e.retryAfterS).toBe(12);
  });
});

describe("search: curated first, then the map", () => {
  const cities = [
    { _id: "LIS", name: "Lisbon", centerLat: 38.712, centerLng: -9.138 },
    { _id: "BCN", name: "Barcelona", country: "Spain", centerLat: 41.39, centerLng: 2.17 },
    { _id: "PRT", name: "Porto", country: "Portugal", centerLat: 41.15, centerLng: -8.61 },
  ];

  it("matches curated cities by name, word, id, accents folded", () => {
    expect(curatedMatches("lis", cities).map((c) => c.cityId)).toEqual(["LIS"]);
    expect(curatedMatches("BCN", cities).map((c) => c.cityId)).toEqual(["BCN"]);
    expect(curatedMatches("barcelona, spain", cities).map((c) => c.cityId)).toEqual(["BCN"]);
    expect(curatedMatches("barcelona, italy", cities)).toEqual([]);
    expect(curatedMatches("x", cities)).toEqual([]);
  });

  it("merges: curated rows first, the map's copy of a curated city dropped", async () => {
    setWorldFetch(fakeOsm().f);
    const r = await worldSearch("porto", cities);
    expect(r.world).toBe("ok");
    expect(r.attribution).toBe("© OpenStreetMap contributors");
    expect(r.results.map((x) => [x.kind, x.cityId ?? x.osmId])).toEqual([["curated", "PRT"], ["world", "N251837123"]]);
  });

  it("the map failing still lists curated matches", async () => {
    setWorldFetch(fakeOsm({ nominatim: () => json({}, 503) }).f);
    const r = await worldSearch("lisbon", cities);
    expect(r.world).toBe("unavailable");
    expect(r.results.map((x) => x.cityId)).toEqual(["LIS"]);
    expect((await worldSearch("l", cities)).world).toBe("skipped");
  });
});

describe("Overpass", () => {
  it("POSTs one query with the polite headers and a 25 s server timeout, de-duplicates elements", async () => {
    const osm = fakeOsm({ overpass: () => json({ ...OVERPASS, elements: [...OVERPASS.elements, OVERPASS.elements[0]] }) });
    setWorldFetch(osm.f);
    const els = await fetchOverpass(41.1494, -8.6108, 3000);
    expect(els).toHaveLength(OVERPASS.elements.length);
    const { init } = osm.calls[0];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(WORLD_USER_AGENT);
    const q = new URLSearchParams(String(init.body)).get("data")!;
    expect(q).toBe(overpassQuery(41.1494, -8.6108, 3000));
    expect(q).toContain("[timeout:25]");
    expect(q).toMatch(/\[bbox:41\.122\d\d,-8\.646\d\d,41\.176\d\d,-8\.575\d\d\]/); // the square around 3 km
  });

  it("busy (429/504), an error remark, or a hang → UpstreamBusy", async () => {
    setWorldFetch(fakeOsm({ overpass: () => json({}, 504) }).f);
    await expect(fetchOverpass(1, 1, 3000)).rejects.toBeInstanceOf(UpstreamBusy);
    setWorldFetch(fakeOsm({ overpass: () => json({ elements: [], remark: "runtime error: Query timed out in \"query\" at line 3 after 26 seconds." }) }).f);
    await expect(fetchOverpass(1, 1, 3000)).rejects.toBeInstanceOf(UpstreamBusy);
    setWorldFetch(async () => { throw new TypeError("fetch failed"); });
    await expect(fetchOverpass(1, 1, 3000)).rejects.toThrow(/overpass: fetch failed/);
  }, 15_000);
});

describe("pack store + loader hook", () => {
  it("builds once, stores on disk, serves from the store after a restart, registers with addCityPack", async () => {
    const osm = fakeOsm();
    setWorldFetch(osm.f);
    const added: CityPack[] = [];
    setAddCityPack((p) => { added.push(p); });
    const [a, b] = await Promise.all([packFor("R3372453"), packFor("R3372453")]); // one shared build
    expect(a?.pack).toBe(b?.pack);
    expect(a).toMatchObject({ cached: false, registered: true });
    expect(osm.calls.filter((c) => c.url.includes("overpass"))).toHaveLength(1);
    expect(osm.calls.filter((c) => c.url.includes("/lookup?"))).toHaveLength(1);
    expect(added.map((p) => p.city._id)).toEqual([packIdFor("R3372453")]);

    resetPackCache(); // "restart": memory gone, the file stays
    setAddCityPack((p) => { added.push(p); });
    const again = await packFor("R3372453");
    expect(again).toMatchObject({ cached: true, registered: true });
    expect(again?.pack).toEqual(a?.pack);
    expect(osm.calls.filter((c) => c.url.includes("overpass"))).toHaveLength(1);
    resetPackCache();
    setAddCityPack((p) => { added.push(p); });
    expect(await restoreWorldPacks()).toBe(1);
    expect(await readStoredPack(packIdFor("R3372453"))).toEqual(a?.pack);
  });

  it("without addCityPack the pack is just returned; an unknown place is null", async () => {
    setWorldFetch(fakeOsm().f);
    setAddCityPack(null);
    expect((await packFor("R3372453"))?.registered).toBe(false);
    expect(await packFor("R999")).toBeNull();
  });

  it("adoptPack takes a voyage's stored pack back without the network; junk is refused", async () => {
    setWorldFetch(fakeOsm().f);
    const p = (await packFor("R3372453"))!.pack;
    resetPackCache();
    setWorldFetch(null);
    const added: string[] = [];
    setAddCityPack((x) => { added.push(x.city._id); });
    expect(await adoptPack(p)).toEqual(p);
    expect(added).toEqual([p.city._id]);
    expect(await adoptPack({ city: { _id: "../../etc" } })).toBeNull();
  });
});

describe("/api/world routes", () => {
  let http: Server;
  let base = "";
  beforeAll(async () => {
    const app = express();
    app.use("/api/world", worldRouter({ ds: { cities: [{ _id: "LIS", name: "Lisbon", centerLat: 38.712, centerLng: -9.138 }] } }));
    http = createServer(app);
    await new Promise<void>((r) => http.listen(0, r));
    base = `http://localhost:${(http.address() as AddressInfo).port}/api/world`;
  });
  afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));
  const post = (body: unknown) => fetch(`${base}/packs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("GET /search", async () => {
    setWorldFetch(fakeOsm().f);
    const r = await fetch(`${base}/search?q=porto`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.results[0]).toMatchObject({ kind: "world", osmId: "R3372453", name: "Porto", countryCode: "PT" });
    expect((await fetch(`${base}/search?q=${"x".repeat(101)}`)).status).toBe(422);
  });

  it("POST /packs: bad id 422, busy map 503 LOADING + Retry-After, sparse 409, ok 200, GET /packs/:id", async () => {
    expect((await post({ osmId: "Z1" })).status).toBe(422);
    setWorldFetch(fakeOsm({ overpass: () => json({}, 429, { "retry-after": "30" }) }).f);
    const busy = await post({ osmId: "R3372453" });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("30");
    expect(await busy.json()).toMatchObject({ code: "LOADING", retryAfterS: 30 });

    setWorldFetch(fakeOsm({ overpass: () => json({ elements: OVERPASS.elements.slice(0, 2) }) }).f);
    const sparse = await post({ osmId: "N251837123" });
    expect(sparse.status).toBe(409);
    expect((await sparse.json()).message).toMatch(/Not enough on the map there yet/);

    setWorldFetch(fakeOsm().f);
    const ok = await post({ osmId: "R3372453" });
    expect(ok.status).toBe(200);
    const { pack } = await ok.json();
    expect(pack.meta.attribution).toBe("© OpenStreetMap contributors");
    expect((await fetch(`${base}/packs/${pack.city._id}`)).status).toBe(200);
    expect((await fetch(`${base}/packs/W-R1`)).status).toBe(404);
  }, 20_000);

  it("rate-limits pack requests per address (10/min)", async () => {
    setWorldFetch(fakeOsm().f);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post({ osmId: "R3372453" })).status);
    expect(codes).toContain(429);
  }, 20_000);
});
