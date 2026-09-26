/**
 * "Any city on Earth" (docs/11-world-cities.md), offline parts: the airports table and nearest lookup, the price
 * model, and OSM elements → city pack (fixture: a small, realistic Overpass answer around Porto). No network here.
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { REGIONS, type CityPack, type Tag } from "@all-ayes/shared";
import { validateCityPack } from "../src/data/loader.js";
import { filterAirports } from "../scripts/world-airports.mjs";
import { airportByCode, airportFor, airports, nearestAirports, type Airport } from "../src/world/airports.js";
import { COUNTRIES, countryInfo, regionFor, utcOffsetFor } from "../src/world/countries.js";
import { STAY_FACTOR, modelActivityCents, modelNightlyCents, modelRating } from "../src/world/model.js";
import {
  MIN_HOTELS, PRICE_FLAG, PackTooSparse, usState, buildCityPack, candidates, categoryOf, packFromElements, packIdFor,
} from "../src/world/pack.js";
import type { WorldPlace } from "../src/world/nominatim.js";
import type { OsmElement } from "../src/world/overpass.js";

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./support/world/${name}`, import.meta.url)), "utf8"));
const ELEMENTS: OsmElement[] = fixture("overpass-porto.json").elements;
const PORTO: WorldPlace = {
  osmId: "R3372453", name: "Porto", country: "Portugal", countryCode: "PT", state: "Porto",
  lat: 41.14945, lng: -8.61079, displayName: "Porto, Portugal", placeType: "city", importance: 0.71,
};
const NOW = new Date("2026-09-26T12:00:00Z");
const TAGS: Tag[] = ["beach", "food", "nightlife", "museums", "nature", "chill", "history", "music"];

describe("world airports", () => {
  it("the committed table: large/medium, scheduled, IATA, compact", () => {
    const file = fileURLToPath(new URL("../src/world/airports.json", import.meta.url));
    expect(statSync(file).size).toBeLessThan(600_000);
    const list = airports();
    expect(list.length).toBeGreaterThan(2_000);
    expect(new Set(list.map((a) => a.iata)).size).toBe(list.length);
    for (const a of list) {
      expect(a.iata).toMatch(/^[A-Z]{3}$/);
      expect(Math.abs(a.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(a.lng)).toBeLessThanOrEqual(180);
    }
    expect(airportByCode("spu")?.city).toBe("Split");
  });

  it("the CSV filter keeps only large/medium airports with scheduled service and an IATA code", () => {
    const csv = [
      '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"',
      '1,"LDSP","large_airport","Split Saint Jerome Airport",43.538898,16.298,79,"EU","HR","HR-17","Split","yes","LDSP","SPU","LDSP",,,,',
      '2,"XXXX","medium_airport","No Service Field",10,10,0,"AF","NG","NG-1","Nowhere","no",,"NSF",,,,,',
      '3,"YYYY","small_airport","Tiny Strip",10,10,0,"AF","NG","NG-1","Nowhere","yes",,"TNY",,,,,',
      '4,"ZZZZ","medium_airport","Quoted, ""Name"" Airport",-33.9,18.6,0,"AF","ZA","ZA-WC","Cape Town","yes",,"QNA",,,,,',
      '5,"WWWW","heliport","Pad",1,1,0,"AF","ZA","ZA-WC","X","yes",,"PAD",,,,,',
      '6,"VVVV","medium_airport","No IATA",1,1,0,"AF","ZA","ZA-WC","X","yes",,,,,,,',
    ].join("\n");
    expect(filterAirports(csv)).toEqual([
      ["QNA", 'Quoted, "Name" Airport', "Cape Town", "ZA", -33.9, 18.6, 1],
      ["SPU", "Split Saint Jerome Airport", "Split", "HR", 43.5389, 16.298, 2],
    ]);
  });

  it("nearest airport: Split → SPU, Porto → OPO, Lisbon → LIS; results are sorted and stable", () => {
    expect(airportFor(43.5081, 16.4402)?.airport.iata).toBe("SPU");
    expect(airportFor(PORTO.lat, PORTO.lng)?.airport.iata).toBe("OPO");
    expect(airportFor(38.712, -9.138)?.airport.iata).toBe("LIS");
    const near = nearestAirports(41.39, 2.17, 5);
    expect(near[0].airport.iata).toBe("BCN");
    expect(near.map((x) => x.km)).toEqual([...near.map((x) => x.km)].sort((a, b) => a - b));
    expect(airportFor(-60, -140)).toBeNull(); // the Southern Ocean: nothing within range
  });

  it("a large airport wins over a slightly closer medium one, not over a much closer one", () => {
    const pool: Airport[] = [
      { iata: "MED", name: "m", city: "m", country: "XX", lat: 0, lng: 0.2, large: false }, // ~22 km
      { iata: "BIG", name: "b", city: "b", country: "XX", lat: 0, lng: 0.5, large: true }, // ~56 km
    ];
    expect(airportFor(0, 0, pool)?.airport.iata).toBe("BIG");
    pool[1] = { ...pool[1], lng: 0.7 }; // ~78 km: the medium one is 56 km closer
    expect(airportFor(0, 0, pool)?.airport.iata).toBe("MED");
  });
});

describe("country table + price model", () => {
  it("covers 60+ countries with sane levels, offsets and a default", () => {
    expect(Object.keys(COUNTRIES).length).toBeGreaterThanOrEqual(60);
    for (const c of Object.values(COUNTRIES)) expect(c.level).toBeGreaterThan(0.2);
    expect(countryInfo("zz").level).toBe(0.8);
    expect(utcOffsetFor("PT", -8.6)).toBe(0);
    expect(utcOffsetFor("HR", 16.4)).toBe(1);
    expect(utcOffsetFor("US", -122.4)).toBe(-8); // multi-zone: from longitude
    expect(utcOffsetFor("ZZ", 139.7)).toBe(9);
    expect(regionFor("PT", 41, -8)).toBe("Europe");
    expect(regionFor("ZZ", -1.3, 36.8)).toBe("Africa");
  });

  it("nightly prices rise with the country level, the stay type and the stars", () => {
    const levels = [0.4, 0.8, 1.0, 1.35, 1.75];
    for (const seed of [undefined, "N1", "W42"]) {
      const byLevel = levels.map((level) => modelNightlyCents({ level, stayType: "hotel", seed }));
      expect(byLevel).toEqual([...byLevel].sort((a, b) => a - b));
      expect(new Set(byLevel).size).toBe(levels.length);
      const types = (Object.keys(STAY_FACTOR) as (keyof typeof STAY_FACTOR)[]).sort((a, b) => STAY_FACTOR[a] - STAY_FACTOR[b]);
      const byType = types.map((stayType) => modelNightlyCents({ level: 1, stayType, seed }));
      expect(byType).toEqual([...byType].sort((a, b) => a - b));
      expect(types[0]).toBe("hostel");
      const byStars = [1, 2, 3, 4, 5].map((stars) => modelNightlyCents({ level: 1, stayType: "hotel", stars, seed }));
      expect(new Set(byStars).size).toBe(5);
      expect(byStars).toEqual([...byStars].sort((a, b) => a - b));
    }
    expect(modelNightlyCents({ level: 1, stayType: "hotel" })).toBe(23000); // $200 × 1.15, the Spain ballpark
    expect(modelNightlyCents({ level: 1, stayType: "hotel" }) % 500).toBe(0);
  });

  it("jitter and rating are deterministic and bounded; activity prices scale with level", () => {
    expect(modelNightlyCents({ level: 1, stayType: "apartment", seed: "N9" })).toBe(modelNightlyCents({ level: 1, stayType: "apartment", seed: "N9" }));
    for (let i = 0; i < 200; i++) {
      const r = modelRating(`N${i}`, i % 5);
      expect(r).toBeGreaterThanOrEqual(4.0);
      expect(r).toBeLessThanOrEqual(4.5);
      const p = modelNightlyCents({ level: 1, stayType: "hotel", seed: `N${i}` });
      expect(p).toBeGreaterThanOrEqual(21000);
      expect(p).toBeLessThanOrEqual(25000);
    }
    expect(modelActivityCents("museum", 0.5)).toBeLessThan(modelActivityCents("museum", 1.5));
    expect(modelActivityCents("park", 1.5)).toBe(0);
  });
});

describe("OSM → city pack (Porto fixture)", () => {
  const pack = packFromElements(PORTO, ELEMENTS, { radiusKm: 3, now: NOW });

  it("has the curated city-file shape", () => {
    expect(pack.city).toMatchObject({
      _id: packIdFor("R3372453"), name: "Porto", country: "Portugal", region: "Europe",
      airport: { code: "OPO" }, utcOffset: 0,
    });
    expect(pack.city.state).toBeUndefined(); // city files carry `state` for US ports only
    expect(pack.city._id).toBe(`W-R${(3372453).toString(36).toUpperCase()}`);
    expect(pack.city.publicFlags).toContain(PRICE_FLAG);
    expect(pack.city.tileRadiusKm).toBeGreaterThanOrEqual(1);
    expect(pack.city.tileRadiusKm).toBeLessThanOrEqual(6);
    expect(Math.abs(pack.city.centerLat - PORTO.lat)).toBeLessThan(0.03);
    expect(pack.generated).toBe(true);
    expect(pack.meta).toMatchObject({ source: "openstreetmap", osmId: "R3372453", attribution: "© OpenStreetMap contributors", radiusKm: 3, builtAt: NOW.toISOString() });
    expect(pack.overrides).toEqual([]);
    expect(pack.hilly).toEqual([]);
    const ids = [...pack.hotels, ...pack.activities].map((x) => x._id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const x of [...pack.hotels, ...pack.activities]) {
      expect(x.cityId).toBe(pack.city._id);
      expect(x._id.startsWith(`${pack.city._id}-${x.kind === "hotel" ? "h" : "a"}-`)).toBe(true);
    }
  });

  it("5 stays across tiers, cheapest first, modelled prices", () => {
    expect(pack.hotels).toHaveLength(5);
    const types = pack.hotels.map((h) => h.stayType);
    for (const t of ["hostel", "guesthouse", "apartment", "hotel"]) expect(types).toContain(t);
    expect(pack.hotels.map((h) => h.nightlyCents)).toEqual([...pack.hotels.map((h) => h.nightlyCents)].sort((a, b) => a - b));
    expect(pack.hotels[0].stayType).toBe("hostel");
    expect(pack.hotels[0].name).toBe("Gallery Hostel (3 beds)");
    expect(pack.hotels[0].neighborhood).toBe("Cedofeita");
    const upscale = pack.hotels.find((h) => h.name.startsWith("The Yeatman") || h.name.startsWith("InterContinental"));
    expect(upscale?.name).toMatch(/\(triple room\)$/);
    for (const h of pack.hotels) {
      expect([3, 4]).toContain(h.sleeps);
      expect(h.rating).toBeGreaterThanOrEqual(4.0);
      expect(h.rating).toBeLessThanOrEqual(4.5);
      expect(h.nightlyCents % 500).toBe(0);
    }
    expect(pack.hotels.find((h) => h.stayType === "apartment")?.sleeps).toBe(4);
    expect(pack.hotels.map((h) => h.name).join()).not.toContain("Airport Inn"); // outside the radius
  });

  it("8 activities: 3 notable group moments, 5 picks across the tags", () => {
    expect(pack.activities).toHaveLength(8);
    const group = pack.activities.filter((a) => a.role === "group");
    const picks = pack.activities.filter((a) => a.role === "pick");
    expect(group).toHaveLength(3);
    expect(picks).toHaveLength(5);
    expect(group.map((a) => a.short)).toContain("Torre dos Clérigos");
    for (const a of pack.activities) {
      expect(a.tags.length).toBeGreaterThan(0);
      for (const t of a.tags) expect(TAGS).toContain(t);
      expect(a.startEarliest <= a.startLatest).toBe(true);
      expect(a.durationMin).toBeGreaterThan(0);
      expect(a.short.length).toBeLessThanOrEqual(25);
    }
    const covered = new Set(pack.activities.flatMap((a) => a.tags));
    for (const t of ["food", "nightlife", "history", "museums", "nature"] as Tag[]) expect(covered).toContain(t);
    const names = pack.activities.map((a) => a.name).join("|");
    expect(names).not.toContain("Serralves"); // 4 km out
    expect(names).not.toContain("Praia do Carneiro");
    expect(names.match(/Palácio da Bolsa/g)?.length ?? 0).toBeLessThanOrEqual(1); // the duplicate node folded
  });

  it("is deterministic for the same OSM data, in any order", () => {
    const shuffled = [...ELEMENTS].reverse();
    const rotated = [...ELEMENTS.slice(7), ...ELEMENTS.slice(0, 7)];
    const a = packFromElements(PORTO, shuffled, { radiusKm: 3, now: NOW });
    const b = packFromElements(PORTO, rotated, { radiusKm: 3, now: NOW });
    expect(a).toEqual(pack);
    expect(b).toEqual(pack);
    expect(JSON.stringify(a)).toBe(JSON.stringify(pack));
  });

  it("passes the loader's validateCityPack, but for the W- id (the engine widens its id rule: docs/11 §Wiring)", () => {
    const code = "WTST";
    const re = (s: string) => s.replace(pack.city._id, code);
    const renamed = {
      ...pack,
      city: { ...pack.city, _id: code },
      hotels: pack.hotels.map((h) => ({ ...h, _id: re(h._id), cityId: code })),
      activities: pack.activities.map((a) => ({ ...a, _id: re(a._id), cityId: code })),
    };
    const ok = validateCityPack(renamed);
    expect(typeof ok === "string" ? ok : "valid").toBe("valid");
    const asIs = validateCityPack(pack);
    expect(typeof asIs === "string" ? asIs : "valid").toMatch(/valid|_id/);
  });

  it("US ports carry the two-letter state code", () => {
    expect(usState({ countryCode: "US", state: "California", stateCode: "US-CA" })).toBe("CA");
    expect(usState({ countryCode: "US", state: "Hawaii" })).toBe("HI");
    expect(usState({ countryCode: "PT", state: "Porto", stateCode: "PT-13" })).toBeUndefined();
    for (const [lat, lng] of [[40.7, -74], [45.5, -73.6], [18.5, -69.9], [-12, -77], [-33.9, 151.2], [1.3, 103.8], [25.2, 55.3], [-1.3, 36.8], [48.8, 2.3]]) {
      expect(REGIONS).toContain(regionFor("ZZ", lat, lng));
    }
    for (const c of Object.values(COUNTRIES)) expect(REGIONS).toContain(c.region);
  });

  it("classifies OSM tags", () => {
    expect(categoryOf({ historic: "castle", tourism: "museum" })).toBe("castle");
    expect(categoryOf({ tourism: "museum" })).toBe("museum");
    expect(categoryOf({ amenity: "pub" })).toBe("bar");
    expect(categoryOf({ natural: "beach" })).toBe("beach");
    expect(categoryOf({ place: "square" })).toBe("square");
    expect(categoryOf({ amenity: "bank" })).toBeNull();
  });

  it("uses name:en for a non-Latin name", () => {
    const els: OsmElement[] = [{ type: "node", id: 1, lat: PORTO.lat, lon: PORTO.lng, tags: { tourism: "museum", name: "東京国立博物館", "name:en": "Tokyo National Museum" } }];
    expect(candidates(PORTO, els, 3).acts[0].name).toBe("Tokyo National Museum");
  });
});

describe("thin maps and the radius fallback", () => {
  const stays = ELEMENTS.filter((e) => e.tags?.tourism && ["hotel", "hostel", "guest_house", "apartment"].includes(e.tags.tourism));
  const acts = ELEMENTS.filter((e) => !stays.includes(e));

  it("refuses with fewer than 3 stays or 4 things to do", () => {
    expect(() => packFromElements(PORTO, [...stays.slice(0, MIN_HOTELS - 1), ...acts], { radiusKm: 3 })).toThrow(PackTooSparse);
    expect(() => packFromElements(PORTO, [...stays, ...acts.slice(0, 3)], { radiusKm: 3 })).toThrow(/Not enough on the map there yet/);
    try { packFromElements(PORTO, stays, { radiusKm: 3 }); } catch (e) { expect((e as PackTooSparse).status).toBe(409); }
  });

  it("a pack with just enough is still valid (3 stays, 4 things to do; 2 group + 2 picks)", () => {
    const p = packFromElements(PORTO, [...stays.slice(0, 3), ...acts.slice(0, 5)], { radiusKm: 3 });
    expect(p.hotels).toHaveLength(3);
    expect(p.activities).toHaveLength(4);
    expect(p.activities.filter((a) => a.role === "group")).toHaveLength(2);
    expect(p.city.publicFlags).toContain("only a few places to stay on the map");
  });

  it("a city tries 3 km, then 8 km when 3 km is too thin", async () => {
    const fetchElements = vi.fn(async (_lat: number, _lng: number, r: number) => (r <= 3000 ? stays.slice(0, 2) : ELEMENTS));
    const p: CityPack = await buildCityPack(PORTO, { fetchElements, now: NOW });
    expect(fetchElements.mock.calls.map((c) => c[2])).toEqual([3000, 8000]);
    expect(p.meta?.radiusKm).toBe(8);
    expect(p.activities.map((a) => a.name).join()).toContain("Serralves"); // in range now
  });

  it("a town starts at 8 km (one request) and a still-thin map is refused", async () => {
    const fetchElements = vi.fn(async () => stays.slice(0, 1));
    await expect(buildCityPack({ ...PORTO, placeType: "town" }, { fetchElements })).rejects.toBeInstanceOf(PackTooSparse);
    expect(fetchElements).toHaveBeenCalledTimes(1);
    expect(fetchElements.mock.calls[0]).toEqual([PORTO.lat, PORTO.lng, 8000]);
  });
});
