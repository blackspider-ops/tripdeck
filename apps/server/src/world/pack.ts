/**
 * City pack builder: OpenStreetMap places around a Nominatim place → a city file in the curated shape
 * (data/cities/<ID>.json): 5 stays across tiers, 8 activities (3 "group" = the most notable, 5 "pick" covering as
 * many interest tags as possible), the nearest airport, a modelled price for everything. Pure and deterministic for
 * the same OSM data (`packFromElements`); `buildCityPack` adds the Overpass fetch and the radius fallback.
 */
import { OSM_ATTRIBUTION, US_STATES, type CityPack, type PackActivity, type PackHotel, type PackStayType, type Tag } from "@all-ayes/shared";
import { HelmError } from "../util/errors.js";
import { airportFor, haversineKm } from "./airports.js";
import { countryInfo, regionFor, utcOffsetFor } from "./countries.js";
import { CATEGORY, SLEEPS, hash32, modelActivityCents, modelNightlyCents, modelRating, parseStars, type ActivityCategory } from "./model.js";
import type { WorldPlace } from "./nominatim.js";
import { fetchOverpass, type OsmElement } from "./overpass.js";

export const PACK_VERSION = 1;
export const PRICE_FLAG = "Prices are estimates for this place";
export const MIN_HOTELS = 3;
export const MIN_ACTIVITIES = 4;
export const RADIUS_KM = 3;
export const WIDE_RADIUS_KM = 8;
/** Place types that start with the wide radius (a town's sights spread past its centre). */
const SMALL_PLACE = new Set(["town", "village", "hamlet", "municipality", "island", "suburb", "county", "district"]);

const TYPE_LETTER = { node: "N", way: "W", relation: "R" } as const;
const refOf = (e: OsmElement) => `${TYPE_LETTER[e.type]}${e.id}`;

/** "R2123456" → "W-R19ZSQ" (the OSM ref in base 36: short, unique across node/way/relation). */
export function packIdFor(osmId: string): string {
  const t = osmId[0];
  return `W-${t}${BigInt(osmId.slice(1)).toString(36).toUpperCase()}`;
}

/** Thrown when the map has too little there for a trip. */
export class PackTooSparse extends HelmError {
  constructor(what: string) { super("TOO_FEW", `Not enough on the map there yet (${what}).`); }
}

// ---------- element helpers ----------
const coords = (e: OsmElement) => (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lng: e.lon } : e.center ? { lat: e.center.lat, lng: e.center.lon } : null);
const NON_LATIN = /[^\u0000-ɏḀ-ỿ -⁯‘-‟\s]/;
/** The display name: `name`, or `name:en` when `name` isn't in Latin script. */
function nameOf(t: Record<string, string>): string {
  const n = (t.name ?? "").trim();
  const en = (t["name:en"] ?? "").trim();
  return (NON_LATIN.test(n) && en ? en : n).replace(/\s+/g, " ").slice(0, 80);
}
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
export function slug(s: string, fallback: string): string {
  const out = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "");
  return out || fallback.toLowerCase();
}
function shortOf(name: string, max = 24): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > 10 ? cut.slice(0, sp) : name.slice(0, max)).replace(/[\s,&–-]+$/, "") + "…";
}
const byRef = (a: { ref: string }, b: { ref: string }) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

// ---------- classification ----------
const STAY: Record<string, PackStayType> = { hotel: "hotel", hostel: "hostel", guest_house: "guesthouse", apartment: "apartment" };

/** Which activity an OSM place is (the first rule that matches wins), or null. */
export function categoryOf(t: Record<string, string>): ActivityCategory | null {
  const h = t.historic, to = t.tourism, l = t.leisure, a = t.amenity;
  if (h === "castle" || h === "archaeological_site" || h === "ruins") return h;
  if (to === "museum" || to === "gallery" || to === "zoo" || to === "theme_park" || to === "viewpoint") return to;
  if (t.natural === "beach" || l === "beach_resort") return "beach";
  if (l === "park" || l === "nature_reserve") return l;
  if (a === "theatre" || a === "marketplace" || a === "nightclub" || a === "restaurant") return a;
  if (a === "bar" || a === "pub") return "bar";
  if (h === "monument" || h === "memorial") return h;
  if (to === "attraction") return "attraction";
  if (t.place === "square") return "square";
  return null;
}

/** The category's tags plus what the place's own tags add (live music, a seafood kitchen, a museum in a castle). */
export function tagsOf(cat: ActivityCategory, t: Record<string, string>): Tag[] {
  const tags = new Set<Tag>(CATEGORY[cat].tags);
  if (t.live_music === "yes" || t["music"] || t.theatre === "concert_hall" || t.theatre === "opera") tags.add("music");
  if (cat !== "museum" && t.tourism === "museum") tags.add("museums");
  if (t.historic && t.historic !== "yes" && cat !== "bar" && cat !== "restaurant") tags.add("history");
  if (t.heritage && cat !== "restaurant") tags.add("history");
  return [...tags].slice(0, 2);
}

/** OSM's own "is this famous" signals: wikidata/wikipedia, translations, heritage; minus distance from the centre. */
function notability(e: OsmElement, cat: ActivityCategory, km: number): number {
  const t = e.tags ?? {};
  const langs = Object.keys(t).filter((k) => /^name:[a-z]{2,3}$/.test(k)).length;
  return CATEGORY[cat].interest
    + (t.wikidata ? 3 : 0) + (t.wikipedia ? 2 : 0)
    + Math.min(langs, 20) / 5
    + (t.heritage ? 1 : 0)
    + (t.tourism === "attraction" && cat !== "attraction" ? 1 : 0)
    + (e.type !== "node" ? 0.3 : 0)
    - km * 0.3;
}

interface Cand { ref: string; e: OsmElement; name: string; lat: number; lng: number; km: number; score: number }
interface StayCand extends Cand { stayType: PackStayType; stars?: number }
interface ActCand extends Cand { cat: ActivityCategory; tags: Tag[] }

/** Stays and activities within `radiusKm`, named, de-duplicated by name (the better-scored one kept), sorted. */
export function candidates(place: Pick<WorldPlace, "lat" | "lng">, elements: OsmElement[], radiusKm: number) {
  const stays: StayCand[] = [];
  const acts: ActCand[] = [];
  const sorted = [...elements].sort((a, b) => byRef({ ref: refOf(a) }, { ref: refOf(b) }));
  for (const e of sorted) {
    const t = e.tags ?? {};
    const c = coords(e);
    const name = nameOf(t);
    if (!c || !name) continue;
    const km = haversineKm(place.lat, place.lng, c.lat, c.lng);
    if (km > radiusKm * 1.05) continue;
    const base = { ref: refOf(e), e, name, lat: round5(c.lat), lng: round5(c.lng), km };
    const stay = STAY[t.tourism ?? ""];
    if (stay) {
      if (t.disused || t.abandoned) continue;
      const stars = parseStars(t.stars);
      const score = (t.wikidata ? 1 : 0) + (stars !== undefined ? 0.5 : 0) + (t.website || t["contact:website"] ? 0.3 : 0) + (t["addr:street"] ? 0.2 : 0) - km * 0.5;
      stays.push({ ...base, stayType: stay, ...(stars !== undefined ? { stars } : {}), score });
      continue;
    }
    const cat = categoryOf(t);
    if (!cat) continue;
    acts.push({ ...base, cat, tags: tagsOf(cat, t), score: notability(e, cat, km) });
  }
  const dedupe = <T extends Cand>(xs: T[]) => {
    const best = new Map<string, T>();
    for (const x of xs) {
      const k = x.name.toLowerCase();
      const cur = best.get(k);
      if (!cur || x.score > cur.score || (x.score === cur.score && x.ref < cur.ref)) best.set(k, x);
    }
    return [...best.values()].sort((a, b) => b.score - a.score || byRef(a, b));
  };
  return { stays: dedupe(stays), acts: dedupe(acts) };
}

// ---------- picking ----------
/** 5 stays across tiers: a hostel, a guesthouse, an apartment, a plain hotel, an upscale hotel — then the best of the rest. */
export function pickStays(stays: StayCand[], n = 5): StayCand[] {
  const chosen: StayCand[] = [];
  const take = (pred: (s: StayCand) => boolean) => {
    const s = stays.find((x) => !chosen.includes(x) && pred(x));
    if (s && chosen.length < n) chosen.push(s);
  };
  take((s) => s.stayType === "hostel");
  take((s) => s.stayType === "guesthouse");
  take((s) => s.stayType === "apartment");
  take((s) => s.stayType === "hotel" && (s.stars ?? 3) <= 3);
  take((s) => s.stayType === "hotel" && (s.stars ?? 0) >= 4);
  for (const s of stays) if (chosen.length < n && !chosen.includes(s)) chosen.push(s);
  return chosen;
}

const TAG_ORDER: Tag[] = ["food", "nightlife", "history", "museums", "nature", "beach", "music", "chill"];
/** Too close to count as another place (a castle and its own museum, a square and its monument). */
const SAME_SPOT_KM = 0.12;

/** 3 group moments (the most notable, one per spot) + 5 picks chosen to cover the most tags not yet covered. */
export function pickActivities(acts: ActCand[], n = 8): { group: ActCand[]; pick: ActCand[] } {
  const groupN = acts.length >= 6 ? 3 : 2;
  const chosen: ActCand[] = [];
  const clashes = (a: ActCand) => chosen.some((c) => haversineKm(c.lat, c.lng, a.lat, a.lng) < SAME_SPOT_KM);
  const catCount = (cat: ActivityCategory) => chosen.filter((c) => c.cat === cat).length;
  const group: ActCand[] = [];
  // group: notability first, at most one per spot and per category (a crew outing, not three churches)
  for (const a of acts) {
    if (group.length >= groupN) break;
    if (clashes(a) || catCount(a.cat) >= 1) continue;
    group.push(a); chosen.push(a);
  }
  for (const a of acts) { if (group.length >= groupN) break; if (!chosen.includes(a)) { group.push(a); chosen.push(a); } }
  // picks: greedily the candidate adding the most uncovered tags (then notability); categories at most twice
  const pick: ActCand[] = [];
  const covered = new Set<Tag>(group.flatMap((g) => g.tags));
  while (chosen.length < Math.min(n, acts.length)) {
    let best: ActCand | undefined;
    let bestGain = -Infinity;
    for (const a of acts) {
      if (chosen.includes(a)) continue;
      const spotPenalty = clashes(a) ? 2 : 0;
      const catPenalty = catCount(a.cat) >= 2 ? 2 : 0;
      const newTags = a.tags.filter((t) => !covered.has(t));
      const firstTagRank = newTags.length ? TAG_ORDER.indexOf(newTags[0]) : TAG_ORDER.length;
      const gain = newTags.length * 10 - spotPenalty * 5 - catPenalty * 5 - firstTagRank * 0.01;
      if (gain > bestGain || (gain === bestGain && best && (a.score > best.score || (a.score === best.score && a.ref < best.ref)))) {
        best = a; bestGain = gain;
      }
    }
    if (!best) break;
    pick.push(best); chosen.push(best);
    for (const t of best.tags) covered.add(t);
  }
  return { group, pick };
}

// ---------- the pack ----------
/** City files carry `state` for US ports only, as the two-letter code ("CA"). */
export function usState(place: Pick<WorldPlace, "countryCode" | "state" | "stateCode">): string | undefined {
  if (place.countryCode !== "US") return undefined;
  const code = place.stateCode?.match(/^US-([A-Z]{2})$/)?.[1];
  if (code && US_STATES[code]) return code;
  return Object.entries(US_STATES).find(([, name]) => name.toLowerCase() === (place.state ?? "").toLowerCase())?.[0];
}
export interface PackOptions { radiusKm: number; now?: Date }

/** OSM elements around `place` → a city pack. Throws PackTooSparse (< 3 stays or < 4 activities, or no airport). */
export function packFromElements(place: WorldPlace, elements: OsmElement[], opts: PackOptions): CityPack {
  const { stays, acts } = candidates(place, elements, opts.radiusKm);
  if (stays.length < MIN_HOTELS) throw new PackTooSparse(`${stays.length} places to stay`);
  if (acts.length < MIN_ACTIVITIES) throw new PackTooSparse(`${acts.length} things to do`);
  const near = airportFor(place.lat, place.lng);
  if (!near) throw new PackTooSparse("no airport with scheduled flights nearby");

  const id = packIdFor(place.osmId);
  const country = countryInfo(place.countryCode);
  const level = country.level;
  const chosenStays = pickStays(stays);
  const { group, pick } = pickActivities(acts);

  // centre = centroid of the chosen places; radius from their spread (75th percentile × 1.2, 0.5 km steps, 1–6 km)
  const all = [...chosenStays, ...group, ...pick];
  const cLat = all.reduce((s, x) => s + x.lat, 0) / all.length;
  const cLng = all.reduce((s, x) => s + x.lng, 0) / all.length;
  const dists = all.map((x) => haversineKm(cLat, cLng, x.lat, x.lng)).sort((a, b) => a - b);
  const p75 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.75))];
  const tileRadiusKm = Math.min(6, Math.max(1, Math.ceil((p75 * 1.2) / 0.5) * 0.5));

  const used = new Set<string>();
  const uniqueId = (kind: "h" | "a", c: Cand) => {
    let s = `${id}-${kind}-${slug(c.name, c.ref)}`;
    if (used.has(s)) s += `-${hash32(c.ref).toString(36).slice(0, 4)}`;
    used.add(s);
    return s;
  };
  const neighborhoodOf = (c: Cand) => {
    const t = c.e.tags ?? {};
    const n = t["addr:suburb"] || t["addr:neighbourhood"] || t["addr:quarter"] || t["addr:city_district"] || t["addr:district"];
    if (n) return n.trim().slice(0, 40);
    return haversineKm(cLat, cLng, c.lat, c.lng) <= 0.8 ? `Central ${place.name}` : t["addr:street"]?.trim().slice(0, 40) || place.name;
  };

  const hotels: PackHotel[] = chosenStays.map((s) => ({
    _id: uniqueId("h", s),
    kind: "hotel",
    cityId: id,
    name: s.stayType === "hotel" ? `${s.name} (triple room)` : s.stayType === "hostel" ? `${s.name} (3 beds)` : s.name,
    neighborhood: neighborhoodOf(s),
    lat: s.lat, lng: s.lng,
    stayType: s.stayType,
    nightlyCents: modelNightlyCents({ level, stayType: s.stayType, stars: s.stars, seed: s.ref }),
    sleeps: SLEEPS[s.stayType],
    rating: modelRating(s.ref, s.stars),
  }));
  hotels.sort((a, b) => a.nightlyCents - b.nightlyCents || (a._id < b._id ? -1 : 1));

  const toActivity = (a: ActCand, role: "group" | "pick"): PackActivity => {
    const d = CATEGORY[a.cat];
    const name = d.label ? d.label.replace("{name}", a.name) : a.name;
    return {
      _id: uniqueId("a", a),
      kind: "activity",
      cityId: id,
      name,
      short: shortOf(a.name),
      tags: a.tags,
      lat: a.lat, lng: a.lng,
      durationMin: d.durationMin,
      priceCents: modelActivityCents(a.cat, level),
      startEarliest: d.startEarliest,
      startLatest: d.startLatest,
      role,
    };
  };
  const activities = [...group.map((a) => toActivity(a, "group")), ...pick.map((a) => toActivity(a, "pick"))];

  const publicFlags = [PRICE_FLAG];
  if (near.km > 60) publicFlags.push(`nearest airport (${near.airport.iata}) is ${Math.round(near.km)} km away`);
  if (hotels.length < 5) publicFlags.push("only a few places to stay on the map");

  return {
    city: {
      _id: id,
      name: place.name,
      country: place.country || place.countryCode,
      region: regionFor(place.countryCode, place.lat, place.lng),
      ...(usState(place) ? { state: usState(place) } : {}),
      airport: { code: near.airport.iata, lat: near.airport.lat, lng: near.airport.lng },
      utcOffset: utcOffsetFor(place.countryCode, place.lng),
      centerLat: round5(cLat), centerLng: round5(cLng),
      tileRadiusKm,
      publicFlags,
    },
    hotels,
    activities,
    overrides: [],
    hilly: [],
    generated: true,
    meta: {
      version: PACK_VERSION,
      source: "openstreetmap",
      osmId: place.osmId,
      attribution: OSM_ATTRIBUTION,
      builtAt: (opts.now ?? new Date()).toISOString(),
      radiusKm: opts.radiusKm,
      airportKm: Math.round(near.km),
      candidates: { hotels: stays.length, activities: acts.length },
    },
  };
}

export interface BuildDeps { fetchElements?: (lat: number, lng: number, radiusM: number) => Promise<OsmElement[]>; now?: Date }

/**
 * Builds the pack for a place: Overpass at 3 km (8 km for towns and villages), and once more at 8 km when 3 km
 * wasn't enough. Throws UpstreamBusy (Overpass busy) or PackTooSparse.
 */
export async function buildCityPack(place: WorldPlace, deps: BuildDeps = {}): Promise<CityPack> {
  const fetchElements = deps.fetchElements ?? fetchOverpass;
  const first = SMALL_PLACE.has(place.placeType) ? WIDE_RADIUS_KM : RADIUS_KM;
  const els = await fetchElements(place.lat, place.lng, first * 1000);
  try {
    return packFromElements(place, els, { radiusKm: first, now: deps.now });
  } catch (e) {
    if (!(e instanceof PackTooSparse) || first === WIDE_RADIUS_KM) throw e;
  }
  const wide = await fetchElements(place.lat, place.lng, WIDE_RADIUS_KM * 1000);
  return packFromElements(place, wide, { radiusKm: WIDE_RADIUS_KM, now: deps.now });
}
