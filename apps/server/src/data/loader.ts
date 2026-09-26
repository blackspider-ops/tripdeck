import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActivityOption, City, CityId, Dataset, DateWindow, FlightOption, HotelOption, Region, WalkOverride,
} from "@all-ayes/shared";
import { REGIONS, TAGS, parseRangeWindowId } from "@all-ayes/shared";

let cached: Dataset | null = null;

/**
 * A port as a city file (data/cities/<ID>.json) or a runtime pack (`addCityPack`) carries it: the city, its 5 stays,
 * its 8 activities (3 group moments + 5 picks), travel overrides and the ids of places on hills. Flights are optional:
 * without them the flight model (fit/flights.ts) prices every home airport → this port.
 */
export interface CityPack {
  city: City;
  hotels: HotelOption[];
  activities: ActivityOption[];
  overrides?: WalkOverride[];
  hilly?: string[];
  flights?: FlightOption[];
}

/** Where the city files live: data/cities next to this file (dist/cities in the bundle), or CITIES_DIR (tests). */
function citiesDir(): string {
  const env = process.env.CITIES_DIR;
  return env ? env : fileURLToPath(new URL("./cities/", import.meta.url));
}

/**
 * Loads dataset.json once, derives W2 flights (= W1 +8%, one day later) per doc 07 §2, and merges every city file in
 * data/cities (sorted by file name). A city file that doesn't parse or validate is skipped and logged: a half-written
 * or broken port never takes the helm down. The read is synchronous on purpose: the dataset is a bundled, read-only
 * asset every TripService needs in its constructor, so there is exactly one load and no window where two callers race
 * to build it. A missing or malformed dataset.json is a broken build, so it throws.
 */
export function loadDataset(): Dataset {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./dataset.json", import.meta.url)), "utf8")) as Dataset;
  for (const k of ["cities", "dateWindows", "flights", "hotels", "activities", "overrides"] as const) {
    if (!Array.isArray(raw?.[k])) throw new Error(`[data] dataset.json has no ${k} list`);
  }
  const ds: Dataset = { ...raw, flights: [...raw.flights, ...deriveW2(raw.flights)] };
  for (const c of ds.cities) c.region = normalizeRegion(c.region) ?? c.region;
  for (const { file, pack } of readCityFiles(citiesDir())) {
    const problem = mergePack(ds, pack);
    if (problem) console.warn(`[data] skipped city file ${file}: ${problem}`);
  }
  cached = ds;
  return cached;
}

/** Every *.json in `dir`, parsed (a parse error is logged and skipped). A missing directory is no ports. */
export function readCityFiles(dir: string): { file: string; pack: unknown }[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: { file: string; pack: unknown }[] = [];
  for (const file of files) {
    try {
      out.push({ file, pack: JSON.parse(readFileSync(join(dir, file), "utf8")) });
    } catch (e) {
      console.warn(`[data] skipped city file ${file}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Hook for runtime-added ports (e.g. a world/ module that builds a port from open map data): validates the pack and
 * merges it into the loaded dataset in place. Throws with the reason when the pack is invalid or the port exists.
 * Every per-dataset cache (lookups, the flight model, the public option sets, the dataset hash) is keyed on the
 * dataset's revision, so they rebuild on their next use.
 */
export function addCityPack(pack: unknown, ds: Dataset = loadDataset()): City {
  const problem = mergePack(ds, pack);
  if (problem) throw new Error(`[data] city pack refused: ${problem}`);
  return (pack as CityPack).city;
}

/** Validates a pack and appends it to `ds` (bumping its revision). Returns the problem, or null when merged. */
export function mergePack(ds: Dataset, input: unknown): string | null {
  const v = validateCityPack(input);
  if (typeof v === "string") return v;
  if (ds.cities.some((c) => c._id === v.city._id)) return `port ${v.city._id} already exists`;
  const ids = new Set([...ds.hotels.map((h) => h._id), ...ds.activities.map((a) => a._id)]);
  const dup = [...v.hotels, ...v.activities].find((x) => ids.has(x._id));
  if (dup) return `id ${dup._id} already exists`;
  ds.cities.push({ ...v.city, hilly: v.hilly ?? v.city.hilly ?? [] });
  ds.hotels.push(...v.hotels);
  ds.activities.push(...v.activities);
  ds.overrides.push(...(v.overrides ?? []));
  if (v.flights?.length) ds.flights.push(...v.flights);
  // a generated port's pack is kept as given, so a voyage using it can carry it (trips/course.ts worldPacksFor)
  if (isGeneratedPort(v.city._id)) generatedPacks.set(v.city._id, input);
  bumpRev(ds);
  return null;
}

const generatedPacks = new Map<string, unknown>();
/** The pack a generated port was added from (for a voyage to store with itself), or undefined. */
export function generatedPackOf(cityId: string): unknown { return generatedPacks.get(cityId); }

// ---------- validation ----------
const STAY_TYPES = new Set(["hotel", "guesthouse", "hostel", "apartment"]);
const MODES = new Set(["walk", "tram", "taxi", "train", "transit"]);
const TAG_IDS = new Set<string>(TAGS.map((t) => t.id));
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A curated port's code ("LIS", "NYC"), or a generated port's id from OpenStreetMap ("W-R6N2AL", docs/11). */
export const PORT_ID = /^([A-Z0-9]{3,4}|W-[NWR][0-9A-Z]{1,14})$/;
/** A port generated from open map data (docs/11-world-cities.md), not a curated file. */
export const isGeneratedPort = (cityId: string) => cityId.startsWith("W-");
const LOCAL = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const isLat = (x: unknown) => isNum(x) && x >= -90 && x <= 90;
const isLng = (x: unknown) => isNum(x) && x >= -180 && x <= 180;
const isCents = (x: unknown) => isNum(x) && Number.isInteger(x) && x >= 0;

/** City files say "Pacific" for Hawaii and the islands; the pickers group those under Oceania. */
export function normalizeRegion(r: unknown): Region | undefined {
  if (typeof r !== "string") return undefined;
  if (r === "Pacific") return "Oceania";
  return (REGIONS as readonly string[]).includes(r) ? (r as Region) : undefined;
}

/**
 * A city file / pack, checked field by field. Returns the normalized pack (kind and cityId filled in where missing,
 * region normalized) or the first problem found. Places may be far from the center (a day trip): no distance check.
 */
export function validateCityPack(input: unknown): CityPack | string {
  if (!input || typeof input !== "object") return "not an object";
  const p = input as Record<string, unknown>;
  const c = p.city as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return "no city";
  const id = c._id;
  if (typeof id !== "string" || !PORT_ID.test(id)) return "city._id must be a 3–4 letter code (or a W- id for a generated port)";
  if (!isStr(c.name)) return "city.name missing";
  if (!isStr(c.country)) return "city.country missing";
  const region = normalizeRegion(c.region);
  if (!region) return `city.region "${String(c.region)}" is not one of ${REGIONS.join(", ")}`;
  const ap = c.airport as Record<string, unknown> | undefined;
  if (!ap || !isStr(ap.code) || !isLat(ap.lat) || !isLng(ap.lng)) return "city.airport needs code, lat, lng";
  if (!isNum(c.utcOffset) || Math.abs(c.utcOffset) > 14) return "city.utcOffset missing";
  if (!isLat(c.centerLat) || !isLng(c.centerLng)) return "city center missing";
  if (!isNum(c.tileRadiusKm) || c.tileRadiusKm <= 0) return "city.tileRadiusKm missing";
  if (!Array.isArray(c.publicFlags) || !c.publicFlags.every((f) => typeof f === "string")) return "city.publicFlags must be a list of strings";
  if (c.state !== undefined && typeof c.state !== "string") return "city.state must be a string";
  const city: City = {
    _id: id, name: String(c.name), country: String(c.country), region, ...(typeof c.state === "string" ? { state: c.state } : {}),
    airport: { code: String(ap.code).toUpperCase(), lat: Number(ap.lat), lng: Number(ap.lng) }, utcOffset: Number(c.utcOffset),
    centerLat: Number(c.centerLat), centerLng: Number(c.centerLng), tileRadiusKm: Number(c.tileRadiusKm), publicFlags: c.publicFlags as string[],
  };

  if (!Array.isArray(p.hotels) || p.hotels.length < 1) return "no hotels";
  const hotels: HotelOption[] = [];
  for (const h of p.hotels as Record<string, unknown>[]) {
    const where = `hotel ${String(h?._id)}`;
    if (!h || typeof h._id !== "string" || !h._id.startsWith(`${id}-h-`) || h._id.length <= id.length + 3) return `${where}: _id must be "${id}-h-<slug>"`;
    if ((h.cityId ?? id) !== id || (h.kind ?? "hotel") !== "hotel") return `${where}: wrong cityId or kind`;
    if (!isStr(h.name) || !isStr(h.neighborhood)) return `${where}: name/neighborhood missing`;
    if (!isLat(h.lat) || !isLng(h.lng)) return `${where}: lat/lng missing`;
    if (!STAY_TYPES.has(String(h.stayType))) return `${where}: stayType`;
    if (!isCents(h.nightlyCents) || h.nightlyCents === 0) return `${where}: nightlyCents`;
    if (!isNum(h.sleeps) || !Number.isInteger(h.sleeps) || h.sleeps < 1) return `${where}: sleeps`;
    if (!isNum(h.rating) || h.rating < 0 || h.rating > 5) return `${where}: rating`;
    hotels.push({ ...(h as unknown as HotelOption), kind: "hotel", cityId: id });
  }

  if (!Array.isArray(p.activities)) return "no activities";
  const activities: ActivityOption[] = [];
  for (const a of p.activities as Record<string, unknown>[]) {
    const where = `activity ${String(a?._id)}`;
    if (!a || typeof a._id !== "string" || !a._id.startsWith(`${id}-`)) return `${where}: _id must start "${id}-"`;
    if ((a.cityId ?? id) !== id || (a.kind ?? "activity") !== "activity") return `${where}: wrong cityId or kind`;
    if (!isStr(a.name) || !isStr(a.short)) return `${where}: name/short missing`;
    if (!Array.isArray(a.tags) || !a.tags.length || !a.tags.every((t) => TAG_IDS.has(String(t)))) return `${where}: tags must come from ${[...TAG_IDS].join(", ")}`;
    if (!isLat(a.lat) || !isLng(a.lng)) return `${where}: lat/lng missing`;
    if (!isNum(a.durationMin) || a.durationMin <= 0 || a.durationMin > 16 * 60) return `${where}: durationMin`;
    if (!isCents(a.priceCents)) return `${where}: priceCents`;
    if (typeof a.startEarliest !== "string" || !CLOCK.test(a.startEarliest) || typeof a.startLatest !== "string" || !CLOCK.test(a.startLatest)) return `${where}: start times must be HH:MM`;
    if (a.startLatest < a.startEarliest) return `${where}: startLatest before startEarliest`;
    if (a.role !== "group" && a.role !== "pick") return `${where}: role must be group or pick`;
    activities.push({ ...(a as unknown as ActivityOption), kind: "activity", cityId: id });
  }
  if (activities.filter((a) => a.role === "group").length < 1) return "needs at least one group activity";
  if (activities.filter((a) => a.role === "pick").length < 1) return "needs at least one pick";

  const places = new Set([...hotels.map((h) => h._id), ...activities.map((a) => a._id)]);
  const overrides: WalkOverride[] = [];
  for (const o of (Array.isArray(p.overrides) ? p.overrides : []) as Record<string, unknown>[]) {
    if (!o || !places.has(String(o.fromId)) || !places.has(String(o.toId))) return `override ${String(o?.fromId)}→${String(o?.toId)}: unknown place`;
    if (!MODES.has(String(o.mode)) || !isNum(o.minutes) || o.minutes <= 0) return `override ${String(o.fromId)}→${String(o.toId)}: mode/minutes`;
    overrides.push(o as unknown as WalkOverride);
  }
  if (p.overrides !== undefined && !Array.isArray(p.overrides)) return "overrides must be a list";

  const hilly = p.hilly === undefined ? [] : p.hilly;
  if (!Array.isArray(hilly) || !hilly.every((x) => typeof x === "string")) return "hilly must be a list of ids";
  // an unknown id in hilly is harmless (it just never matches); keep only this port's own
  const hillyIds = (hilly as string[]).filter((x) => places.has(x));

  let flights: FlightOption[] | undefined;
  if (p.flights !== undefined) {
    if (!Array.isArray(p.flights)) return "flights must be a list";
    flights = [];
    for (const f of p.flights as Record<string, unknown>[]) {
      const where = `flight ${String(f?._id)}`;
      if (!f || !isStr(f._id) || !isStr(f.origin) || !isStr(f.dateWindowId) || !isStr(f.airline)) return `${where}: _id/origin/dateWindowId/airline`;
      if (![f.departLocal, f.arriveLocal, f.returnLocal].every((x) => typeof x === "string" && LOCAL.test(x))) return `${where}: times must be YYYY-MM-DDTHH:MM`;
      if (![0, 1, 2].includes(Number(f.stops)) || typeof f.redEye !== "boolean" || !isCents(f.priceCents)) return `${where}: stops/redEye/priceCents`;
      flights.push({ ...(f as unknown as FlightOption), kind: "flight", cityId: id });
    }
  }
  return { city, hotels, activities, overrides, hilly: hillyIds, ...(flights ? { flights } : {}) };
}

/** W2 = every W1 flight one day later at +8%, rounded to the dollar (doc 07 §2). */
export function deriveW2(flights: FlightOption[]): FlightOption[] {
  return flights
    .filter((f) => f.dateWindowId === "W1")
    .map((f) => ({
      ...f,
      _id: f._id + "-w2",
      dateWindowId: "W2",
      departLocal: shiftDay(f.departLocal, 1),
      arriveLocal: shiftDay(f.arriveLocal, 1),
      priceCents: Math.round((f.priceCents * 1.08) / 100) * 100,
    }));
}

/** "2027-03-31T22:10" + 1 day → "2027-04-01T22:10" (the clock part is kept as written). */
export function shiftDay(local: string, days: number): string {
  const [date, time] = local.split("T");
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) + "T" + time;
}

// ---------- revisions: a runtime-added port invalidates every per-dataset cache ----------
const revs = new WeakMap<Dataset, number>();
/** How many times this dataset object has changed (0 as loaded). Caches keyed on a dataset compare it. */
export function datasetRev(ds: Dataset): number { return revs.get(ds) ?? 0; }
function bumpRev(ds: Dataset) { revs.set(ds, datasetRev(ds) + 1); }

/**
 * A cache per dataset object that forgets itself when the dataset changes (`addCityPack`). `build` makes the value.
 */
export function perDataset<T>(build: (ds: Dataset) => T): (ds: Dataset) => T {
  const m = new WeakMap<Dataset, { rev: number; v: T }>();
  return (ds) => {
    const rev = datasetRev(ds);
    const hit = m.get(ds);
    if (hit && hit.rev === rev) return hit.v;
    const v = build(ds);
    m.set(ds, { rev, v });
    return v;
  };
}

// ---------- OPT-029: lookups by id ----------
interface DatasetIndex {
  city: ReadonlyMap<string, City>;
  hotel: ReadonlyMap<string, HotelOption>;
  activity: ReadonlyMap<string, ActivityOption>;
  /**
   * The dataset's windows by id, and any window generated from an organizer's date range (`D20270312N4`: its id
   * carries its dates, so it resolves anywhere a dataset window does: pricing, the flight model, labels).
   */
  window: ReadonlyMap<string, DateWindow>;
  /** A port's stays / activities, in dataset order. */
  hotelsOf(cityId: CityId): readonly HotelOption[];
  activitiesOf(cityId: CityId): readonly ActivityOption[];
  /** Every place on a hill (each port's `hilly`). */
  hilly: ReadonlySet<string>;
  /** The travel override between two places, in either direction (the first listed wins, as `find` did). */
  override(fromId: string, toId: string): WalkOverride | undefined;
}

const pairKey = (a: string, b: string) => `${a}\u0000${b}`;
const byId = <T extends { _id: string }>(xs: T[]) => new Map(xs.map((x) => [x._id, x] as const));
function groupBy<T extends { cityId: string }>(xs: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) { const l = m.get(x.cityId); if (l) l.push(x); else m.set(x.cityId, [x]); }
  return m;
}

/** Dataset windows by id; a generated window's id (`D20270312N4`) resolves from the id itself (memoised). */
class WindowIndex extends Map<string, DateWindow> {
  private generated = new Map<string, DateWindow | null>();
  override get(id: string): DateWindow | undefined {
    const w = super.get(id);
    if (w || typeof id !== "string") return w;
    let g = this.generated.get(id);
    if (g === undefined) {
      g = parseRangeWindowId(id);
      if (this.generated.size > 10_000) this.generated.clear();
      this.generated.set(id, g);
    }
    return g ?? undefined;
  }
  override has(id: string): boolean { return this.get(id) !== undefined; }
}

/** Maps by id for a dataset, built once per dataset (revision) and cached with it. */
export const indexOf: (ds: Dataset) => DatasetIndex = perDataset((ds) => {
  const overrides = new Map<string, WalkOverride>();
  for (const o of ds.overrides) {
    for (const k of [pairKey(o.fromId, o.toId), pairKey(o.toId, o.fromId)]) if (!overrides.has(k)) overrides.set(k, o);
  }
  const hotels = groupBy(ds.hotels), activities = groupBy(ds.activities);
  return Object.freeze({
    city: byId(ds.cities), hotel: byId(ds.hotels), activity: byId(ds.activities),
    window: new WindowIndex(ds.dateWindows.map((w) => [w.id, w] as const)),
    hotelsOf: (cityId: CityId) => hotels.get(cityId) ?? [],
    activitiesOf: (cityId: CityId) => activities.get(cityId) ?? [],
    hilly: new Set(ds.cities.flatMap((c) => c.hilly ?? [])),
    override: (fromId: string, toId: string) => overrides.get(pairKey(fromId, toId)),
  });
});

export function cityName(ds: Dataset, cityId: string): string {
  return indexOf(ds).city.get(cityId)?.name ?? cityId;
}

/** A dataset lookup that must succeed (an id from our own plans); a miss is a bug, reported with the id. */
export function mustFind<T>(v: T | undefined, what: string, id: string): T {
  if (v === undefined) throw new Error(`[data] unknown ${what} ${id}`);
  return v;
}
