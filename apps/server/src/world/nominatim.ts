/**
 * City search through OpenStreetMap Nominatim (https://operations.osmfoundation.org/policies/nominatim/): at most
 * 1 request/s for the whole server (one Throttle), a real User-Agent + Referer, and aggressive caching — an LRU in
 * memory backed by DATA_DIR/world/nominatim.json (answers for 7 days, places for 90), so the same query or place is
 * asked once. No autocomplete hammering: the phone debounces (400 ms, ≥ 2 chars) and the server caches.
 */
import { join } from "node:path";
import type { OsmRef, WorldSearchResult } from "@all-ayes/shared";
import { config } from "../config.js";
import { JsonStore } from "../util/jsonStore.js";
import { Lru } from "../util/limits.js";
import { Throttle, politeFetch } from "./net.js";

export const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const SEARCH_TTL_MS = 7 * 24 * 3600_000;
const PLACE_TTL_MS = 90 * 24 * 3600_000;
const MAX_QUERIES = 2_000;
const MAX_PLACES = 5_000;

/** The one throttle for every Nominatim call from this process (search and lookup). */
export const nominatimThrottle = new Throttle(1_000, 20);

/** A Nominatim place as we keep it (what a pack is built from). */
export interface WorldPlace {
  osmId: OsmRef; name: string; country: string; countryCode: string; state?: string;
  lat: number; lng: number; displayName: string;
  /** ISO 3166-2 subdivision ("US-CA"), when Nominatim gives one. */
  stateCode?: string;
  /** Nominatim's addresstype/type ("city", "town", "village", …): towns and villages search a wider radius. */
  placeType: string;
  importance: number;
}

interface NominatimRow {
  osm_type?: string; osm_id?: number; lat?: string; lon?: string; name?: string; display_name?: string;
  addresstype?: string; type?: string; category?: string; importance?: number;
  address?: Record<string, string | undefined>;
}

const TYPE_LETTER: Record<string, string> = { node: "N", way: "W", relation: "R" };
export const isOsmRef = (s: unknown): s is OsmRef => typeof s === "string" && /^[NWR][1-9]\d{0,14}$/.test(s);

/** Nominatim jsonv2 row → WorldPlace (null when it lacks an id or coordinates). */
export function toPlace(r: NominatimRow): WorldPlace | null {
  const t = TYPE_LETTER[r.osm_type ?? ""];
  const lat = Number(r.lat), lng = Number(r.lon);
  if (!t || !r.osm_id || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const a = r.address ?? {};
  const name = (r.name || a.city || a.town || a.village || a.municipality || (r.display_name ?? "").split(",")[0] || "").trim();
  if (!name) return null;
  return {
    osmId: `${t}${r.osm_id}`,
    name,
    country: (a.country ?? "").trim(),
    countryCode: (a.country_code ?? "").trim().toUpperCase(),
    ...(a.state || a.region || a.province ? { state: (a.state || a.region || a.province)!.trim() } : {}),
    ...(a["ISO3166-2-lvl4"] ? { stateCode: a["ISO3166-2-lvl4"].trim().toUpperCase() } : {}),
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
    displayName: (r.display_name ?? name).trim(),
    placeType: (r.addresstype || r.type || "city").trim(),
    importance: typeof r.importance === "number" ? r.importance : 0,
  };
}

export const toResult = (p: WorldPlace): WorldSearchResult => ({
  kind: "world", osmId: p.osmId, name: p.name, country: p.country, countryCode: p.countryCode,
  ...(p.state ? { state: p.state } : {}), lat: p.lat, lng: p.lng, displayName: p.displayName,
});

/** "  Split,  CROATIA " → "split, croatia" (the cache key; at most 100 chars). */
export const normQuery = (q: string) => q.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 100);

// ---------- cache (memory LRU + one JSON file) ----------
interface Stored { queries: Record<string, { at: number; ids: OsmRef[] }>; places: Record<string, { at: number; place: WorldPlace }> }
const queries = new Lru<string, { at: number; ids: OsmRef[] }>(MAX_QUERIES);
const places = new Lru<OsmRef, { at: number; place: WorldPlace }>(MAX_PLACES);
let store: JsonStore<Stored> | null = null;
let warmed: Promise<void> | null = null;
let persistOn = true;

/** Tests: forget the memory cache (and optionally stop writing the file). */
export function resetNominatimCache(opts: { persist?: boolean } = {}) {
  queries.clear(); places.clear(); store = null; warmed = null; persistOn = opts.persist ?? true;
}

function fileStore() {
  store ??= new JsonStore<Stored>(join(config.dataDir, "world", "nominatim.json"), () => ({ queries: {}, places: {} }));
  return store;
}
function warm(): Promise<void> {
  if (!persistOn) return Promise.resolve();
  warmed ??= fileStore().read().then((s) => {
    const now = Date.now();
    for (const [k, v] of Object.entries(s.queries ?? {})) if (now - v.at < SEARCH_TTL_MS && !queries.has(k)) queries.set(k, v);
    for (const [k, v] of Object.entries(s.places ?? {})) if (now - v.at < PLACE_TTL_MS && !places.has(k)) places.set(k, v);
  }).catch(() => undefined);
  return warmed;
}
function persist() {
  if (!persistOn) return;
  void fileStore().update(() => ({
    queries: Object.fromEntries([...queries.entries()].slice(-MAX_QUERIES)),
    places: Object.fromEntries([...places.entries()].slice(-MAX_PLACES)),
  })).catch(() => undefined);
}
function remember(ps: WorldPlace[], at: number) {
  for (const p of ps) places.set(p.osmId, { at, place: p });
}

/** A place we have seen (search or lookup) — no network. */
export async function cachedPlace(osmId: OsmRef): Promise<WorldPlace | undefined> {
  await warm();
  const hit = places.get(osmId);
  return hit && Date.now() - hit.at < PLACE_TTL_MS ? hit.place : undefined;
}

/** Nominatim calls made by this process (tests assert caching; /api/world health could show it). */
export const nominatimStats = { calls: 0 };

async function getJson(url: string): Promise<NominatimRow[]> {
  return nominatimThrottle.run(async () => {
    nominatimStats.calls++;
    const res = await politeFetch("nominatim", url, { method: "GET", timeoutMs: 10_000, headers: { "Accept-Language": "en" } });
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as NominatimRow[]) : [];
  });
}

const SETTLEMENT = new Set(["city", "town", "village", "municipality", "hamlet", "suburb", "borough", "island", "county", "state_district", "district", "province", "region"]);

/** Search cities/towns (featuretype=city). Cached per normalized query; throws UpstreamBusy when Nominatim is busy. */
export async function searchPlaces(q: string, limit = 8): Promise<WorldPlace[]> {
  const key = normQuery(q);
  if (key.length < 2) return [];
  await warm();
  const hit = queries.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    const ps = hit.ids.map((id) => places.get(id)?.place).filter((p): p is WorldPlace => Boolean(p));
    if (ps.length === hit.ids.length) return ps.slice(0, limit);
  }
  const url = `${NOMINATIM_BASE}/search?` + new URLSearchParams({ format: "jsonv2", featuretype: "city", q: key, addressdetails: "1", limit: "8" });
  const rows = await getJson(url);
  const seen = new Set<string>();
  const ps: WorldPlace[] = [];
  for (const r of rows) {
    const p = toPlace(r);
    if (!p || seen.has(p.osmId)) continue;
    if (r.category && r.category !== "place" && r.category !== "boundary") continue;
    if (!SETTLEMENT.has(p.placeType) && r.category !== "place") continue;
    seen.add(p.osmId);
    ps.push(p);
  }
  const at = Date.now();
  remember(ps, at);
  queries.set(key, { at, ids: ps.map((p) => p.osmId) });
  persist();
  return ps.slice(0, limit);
}

/** One place by OSM ref (Nominatim /lookup), cached. undefined when OSM has no such object. */
export async function lookupPlace(osmId: OsmRef): Promise<WorldPlace | undefined> {
  const cached = await cachedPlace(osmId);
  if (cached) return cached;
  const url = `${NOMINATIM_BASE}/lookup?` + new URLSearchParams({ format: "jsonv2", osm_ids: osmId, addressdetails: "1" });
  const p = (await getJson(url)).map(toPlace).find((x): x is WorldPlace => x?.osmId === osmId);
  if (p) { remember([p], Date.now()); persist(); }
  return p;
}
