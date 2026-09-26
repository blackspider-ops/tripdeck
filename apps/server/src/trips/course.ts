/**
 * Where a voyage may go and when (A4, docs/03 P1): the organizer names 2–4 ports, or picks regions / US states, or
 * "anywhere"; and offers 1–3 date windows. Pure functions over the dataset: crew.ts validates with them, replay.ts
 * shows them, table.ts pre-ranks the ports in scope when the table meets.
 */
import type { City, CityId, Dataset, DateRange, DateWindow, Destination, DestinationPublic, Region, TripState } from "@all-ayes/shared";
import {
  addDays, addMonths, checkDateRange, RANGE_MAX_MONTHS,
  DEFAULT_PORTS, DEFAULT_WINDOWS, MAX_PLACES, MAX_PORTS, MAX_WINDOWS, MIN_PORTS, MIN_WINDOWS, REGIONS, US_STATES, stateName,
} from "@all-ayes/shared";
import { generatedPackOf, indexOf, isGeneratedPort } from "../data/loader.js";
import { HelmError } from "../util/errors.js";
import { tripWindowIds, type TripRec } from "./records.js";

const list = (xs: string[], joiner = "and") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${joiner} ${xs.at(-1)}`);

/** Is this port in the destination's scope? ("United States" takes in every port with a US state, Hawaii included.) */
export function inScope(c: City, d: Destination): boolean {
  if (d.kind === "anywhere") return true;
  if (d.kind === "cities") return (d.cityIds ?? []).includes(c._id);
  if (c.region && d.regions?.includes(c.region)) return true;
  if (c.state && d.regions?.includes("United States")) return true;
  return Boolean(c.state && d.states?.includes(c.state));
}

/** Every port the destination takes in, in dataset order. */
export function scopeOf(ds: Dataset, d: Destination): City[] {
  if (d.kind === "cities") {
    const ix = indexOf(ds).city;
    return (d.cityIds ?? []).map((id) => ix.get(id)).filter((c): c is City => Boolean(c));
  }
  // generated ports (docs/11) only ever come in by name: a region or "anywhere" takes the curated ports
  return ds.cities.filter((c) => !isGeneratedPort(c._id) && inScope(c, d));
}

/** The packs of the generated ports on this voyage's chart, to store with it (a restart on a fresh disk keeps them). */
export function worldPacksFor(t: TripRec): unknown[] {
  return t.candidateCityIds.filter(isGeneratedPort).map(generatedPackOf).filter((p) => p !== undefined);
}

/** "Europe", "Europe or the Caribbean", "California", "anywhere", or the named ports. */
export function destinationLabel(ds: Dataset, d: Destination): string {
  if (d.kind === "anywhere") return "anywhere";
  if (d.kind === "cities") return list(scopeOf(ds, d).map((c) => c.name));
  const parts = [...(d.regions ?? []).map((r) => (r === "Caribbean" || r === "Middle East" || r === "United States" ? `the ${r}` : r)), ...(d.states ?? []).map(stateName)];
  return list(parts, "or");
}

/** The course anyone in the voyage may see (no crew facts). A voyage from an older build had named ports. */
export function destinationPublic(ds: Dataset, t: TripRec): DestinationPublic {
  const d: Destination = t.destination ?? { kind: "cities", cityIds: t.candidateCityIds };
  return {
    ...d, label: destinationLabel(ds, d),
    scope: scopeOf(ds, d).map((c) => ({ cityId: c._id, name: c.name, region: c.region, ...(c.state ? { state: c.state } : {}) })),
    portsChosen: d.kind === "cities" || t.candidateCityIds.length > 0,
  };
}

/** The voyage's windows, as the Brief's date chips show them. */
export function tripWindows(ds: Dataset, t: TripRec): TripState["dateWindows"] {
  const ix = indexOf(ds).window;
  return tripWindowIds(t).map((id) => ix.get(id)).filter((w): w is DateWindow => Boolean(w));
}

/** Windows that haven't started yet, soonest first (all of them, soonest first, once every one is past). */
export function upcomingWindows(ds: Dataset, today = new Date().toISOString().slice(0, 10)): DateWindow[] {
  const byStart = [...ds.dateWindows].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const ahead = byStart.filter((w) => w.start > today);
  return ahead.length >= DEFAULT_WINDOWS ? ahead : byStart.slice(-DEFAULT_WINDOWS);
}

/** `n` distinct items of `xs`, drawn with `random` (kept in their original order). */
export function sample<T>(xs: readonly T[], n: number, random: () => number): T[] {
  const idx = xs.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, Math.min(n, xs.length)).sort((a, b) => a - b).map((i) => xs[i]);
}

export interface CourseInput {
  /** The older API: named ports. */
  cityIds?: unknown;
  destination?: unknown;
  /** Fixed windows (the Expo, older clients): 1–3 dataset window ids. */
  windowIds?: unknown;
  /** A date-range voyage: earliest departure, latest return, trip length (wins over windowIds). */
  dateRange?: unknown;
}

const isoAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/**
 * The helm's bounds for a new range. The organizer's phone checks "starts tomorrow, ends within 12 months" on its own
 * calendar; the helm allows for every time zone: tomorrow where it is earliest (UTC−12), 12 months from today where
 * it is latest (UTC+14).
 */
export function helmRangeBounds(now = Date.now()): { tomorrow: string; lastDay: string } {
  return { tomorrow: addDays(isoAt(now - 12 * 3_600_000), 1), lastDay: addMonths(isoAt(now + 14 * 3_600_000), RANGE_MAX_MONTHS) };
}

/** A date range from a request, validated (docs/03 P1), or a BAD_INPUT naming what's wrong. */
export function resolveDateRange(x: unknown, now = Date.now()): DateRange {
  const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const range = { start: r.start, end: r.end, minNights: Number(r.minNights), maxNights: Number(r.maxNights) } as DateRange;
  const problem = checkDateRange(range, helmRangeBounds(now));
  if (problem) throw new HelmError("BAD_INPUT", problem);
  return { start: range.start, end: range.end, minNights: range.minNights, maxNights: range.maxNights };
}

/**
 * The course a new voyage sets, validated. Named ports: 2–4 known, distinct. Regions / states: known ones, at least
 * two ports in scope. Nothing named: 3 ports at random ("Surprise me" — never every port: the chart book holds 12
 * plans). Dates: a date range (docs/03 P1: start ≥ tomorrow, end within 12 months, room for the shortest trip), or
 * the older fixed windows: 1–3 known, distinct, in date order; neither named: the next 2.
 */
export function resolveCourse(ds: Dataset, p: CourseInput, random: () => number = Math.random):
  { destination: Destination; candidateCityIds: CityId[]; candidateWindowIds: string[]; dateRange?: DateRange } {
  const known = indexOf(ds).city;
  const ids = (x: unknown) => (Array.isArray(x) ? x : []).filter((c): c is string => typeof c === "string");
  const d = (p.destination && typeof p.destination === "object" ? p.destination : undefined) as Partial<Destination> | undefined;
  let destination: Destination;
  let candidateCityIds: CityId[];
  if (d?.kind === "regions") {
    const regions = [...new Set(ids(d.regions))].filter((r): r is Region => (REGIONS as readonly string[]).includes(r));
    const states = [...new Set(ids(d.states).map((s) => s.toUpperCase()))].filter((s) => s in US_STATES);
    if (!regions.length && !states.length) throw new HelmError("BAD_INPUT", "Pick at least one region.");
    destination = { kind: "regions", ...(regions.length ? { regions } : {}), ...(states.length ? { states } : {}) };
    if (scopeOf(ds, destination).length < MIN_PORTS) throw new HelmError("BAD_INPUT", "There aren't enough ports charted there yet. Add another region.");
    candidateCityIds = [];
  } else if (d?.kind === "anywhere") {
    destination = { kind: "anywhere" };
    candidateCityIds = [];
  } else {
    const named = d?.kind === "cities" ? d.cityIds : p.cityIds;
    if (named !== undefined) {
      const picked = ids(named).filter((c, i, a) => known.has(c) && a.indexOf(c) === i);
      if (picked.length < MIN_PORTS) throw new HelmError("BAD_INPUT", "Put at least two ports on the chart.");
      if (picked.length > MAX_PORTS) throw new HelmError("BAD_INPUT", `At most ${MAX_PORTS} ports on one chart.`);
      candidateCityIds = picked;
    } else {
      candidateCityIds = sample(ds.cities.filter((c) => !isGeneratedPort(c._id)).map((c) => c._id), DEFAULT_PORTS, random);
    }
    destination = { kind: "cities", cityIds: candidateCityIds };
  }

  // a date range: the windows are generated from the crew's availability when the table meets (fit/windows.ts)
  if (p.dateRange !== undefined && p.dateRange !== null) {
    return { destination, candidateCityIds, candidateWindowIds: [], dateRange: resolveDateRange(p.dateRange) };
  }
  let candidateWindowIds: string[];
  if (p.windowIds !== undefined) {
    const win = indexOf(ds).window;
    const picked = ids(p.windowIds).filter((w, i, a) => win.has(w) && a.indexOf(w) === i);
    if (picked.length < MIN_WINDOWS) throw new HelmError("BAD_INPUT", "Offer at least one set of dates.");
    if (picked.length > MAX_WINDOWS) throw new HelmError("BAD_INPUT", `Offer at most ${MAX_WINDOWS} sets of dates.`);
    candidateWindowIds = picked.map((id) => win.get(id)!).sort((a, b) => a.start.localeCompare(b.start)).map((w) => w.id);
  } else {
    candidateWindowIds = upcomingWindows(ds).slice(0, DEFAULT_WINDOWS).map((w) => w.id);
  }
  return { destination, candidateCityIds, candidateWindowIds };
}

/**
 * A brief's "Places I'd love / skip": port ids or regions (or US state codes) from the voyage's scope, deduped, at
 * most MAX_PLACES each; a place can't be on both lists (loved wins). Unknown entries are dropped, like unknown tags.
 */
export function cleanPlaces(ds: Dataset, t: TripRec, loves: unknown, skips: unknown): { loves?: string[]; skips?: string[] } {
  const scope = destinationPublic(ds, t).scope;
  const ok = new Set<string>([
    ...scope.map((c) => c.cityId), ...scope.flatMap((c) => (c.region ? [c.region] : [])), ...scope.flatMap((c) => (c.state ? [c.state] : [])),
  ]);
  const clean = (x: unknown) => [...new Set((Array.isArray(x) ? x : []).filter((v): v is string => typeof v === "string" && ok.has(v)))].slice(0, MAX_PLACES);
  const l = clean(loves);
  const s = clean(skips).filter((x) => !l.includes(x));
  return { ...(l.length ? { loves: l } : {}), ...(s.length ? { skips: s } : {}) };
}

/** Does a love/skip entry name this port (its id, region or state)? */
export const namesPort = (entry: string, c: City) => entry === c._id || entry === c.region || entry === c.state;
