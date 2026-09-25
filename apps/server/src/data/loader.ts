import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ActivityOption, City, Dataset, DateWindow, FlightOption, HotelOption, WalkOverride } from "@all-ayes/shared";

let cached: Dataset | null = null;

/**
 * Loads dataset.json once and derives W2 flights (= W1 +8%, one day later) per doc 07 §2.
 * The read is synchronous on purpose: the dataset is a bundled, read-only asset every TripService needs in its
 * constructor, so there is exactly one load and no window where two callers race to build it. A missing or malformed
 * file is a broken build, so it throws (util/jsonStore's `readJson` would silently fall back instead).
 */
export function loadDataset(): Dataset {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./dataset.json", import.meta.url)), "utf8")) as Dataset;
  for (const k of ["cities", "dateWindows", "flights", "hotels", "activities", "overrides"] as const) {
    if (!Array.isArray(raw?.[k])) throw new Error(`[data] dataset.json has no ${k} list`);
  }
  cached = { ...raw, flights: [...raw.flights, ...deriveW2(raw.flights)] };
  return cached;
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

// ---------- OPT-029: lookups by id ----------
interface DatasetIndex {
  city: ReadonlyMap<string, City>;
  hotel: ReadonlyMap<string, HotelOption>;
  activity: ReadonlyMap<string, ActivityOption>;
  window: ReadonlyMap<string, DateWindow>;
  /** The travel override between two places, in either direction (the first listed wins, as `find` did). */
  override(fromId: string, toId: string): WalkOverride | undefined;
}

const indexes = new WeakMap<Dataset, DatasetIndex>();
const pairKey = (a: string, b: string) => `${a}\u0000${b}`;
const byId = <T extends { _id: string }>(xs: T[]) => new Map(xs.map((x) => [x._id, x] as const));

/** Maps by id for a dataset, built once per dataset object and cached with it (datasets are never mutated). */
export function indexOf(ds: Dataset): DatasetIndex {
  let ix = indexes.get(ds);
  if (ix) return ix;
  const overrides = new Map<string, WalkOverride>();
  for (const o of ds.overrides) {
    for (const k of [pairKey(o.fromId, o.toId), pairKey(o.toId, o.fromId)]) if (!overrides.has(k)) overrides.set(k, o);
  }
  ix = Object.freeze({
    city: byId(ds.cities), hotel: byId(ds.hotels), activity: byId(ds.activities),
    window: new Map(ds.dateWindows.map((w) => [w.id, w] as const)),
    override: (fromId: string, toId: string) => overrides.get(pairKey(fromId, toId)),
  });
  indexes.set(ds, ix);
  return ix;
}

export function cityName(ds: Dataset, cityId: string): string {
  return indexOf(ds).city.get(cityId)?.name ?? cityId;
}

/** A dataset lookup that must succeed (an id from our own plans); a miss is a bug, reported with the id. */
export function mustFind<T>(v: T | undefined, what: string, id: string): T {
  if (v === undefined) throw new Error(`[data] unknown ${what} ${id}`);
  return v;
}
