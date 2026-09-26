// "Any city on Earth" (docs/11-world-cities.md): the wire shapes of /api/world and the generated city pack.
// A generated pack has the same shape as a hand-curated apps/server/src/data/cities/<ID>.json file, plus `generated`
// and `meta` (sources, attribution, how it was built).
import type { Tag } from "./types.js";

/** OpenStreetMap object ref: "N123" (node), "W123" (way) or "R123" (relation). OSM ids are unique per type only. */
export type OsmRef = string;

/** One row of GET /api/world/search. Curated cities come first; `cityId` is set on those. */
export interface WorldSearchResult {
  kind: "curated" | "world";
  /** Curated only: the dataset city id (e.g. "BCN"). */
  cityId?: string;
  /** World only: the OSM object the place comes from. */
  osmId?: OsmRef;
  name: string;
  country: string;
  /** ISO 3166-1 alpha-2, upper case ("" when unknown). */
  countryCode: string;
  state?: string;
  lat: number;
  lng: number;
  displayName: string;
}
export interface WorldSearchResponse {
  results: WorldSearchResult[];
  /** "unavailable" when the map search failed (the curated matches are still listed). */
  world: "ok" | "unavailable" | "skipped";
  attribution: string;
}

/** What CitySearch hands back when a row is chosen. */
export type CityPick =
  | { kind: "curated"; cityId: string }
  | { kind: "world"; osmId: OsmRef; name: string; country: string };

export type PackStayType = "hotel" | "guesthouse" | "hostel" | "apartment";

export interface PackCity {
  _id: string; name: string; country: string; region: string; state?: string;
  airport: { code: string; lat: number; lng: number };
  /** Standard-time offset from UTC in hours (the curated files use the March offset). */
  utcOffset: number;
  centerLat: number; centerLng: number; tileRadiusKm: number; publicFlags: string[];
}
export interface PackHotel {
  _id: string; kind: "hotel"; cityId: string; name: string; neighborhood: string; lat: number; lng: number;
  stayType: PackStayType; nightlyCents: number; sleeps: number; rating: number;
}
export interface PackActivity {
  _id: string; kind: "activity"; cityId: string; name: string; short: string; tags: Tag[]; lat: number; lng: number;
  durationMin: number; priceCents: number; startEarliest: string; startLatest: string;
  role: "group" | "pick"; earlyStart?: boolean;
}
export interface PackOverride { fromId: string; toId: string; mode: string; minutes: number; note?: string }

export interface PackMeta {
  /** Builder version: a pack built by an older builder may be rebuilt. */
  version: number;
  source: "openstreetmap";
  osmId: OsmRef;
  /** ODbL: show this wherever the pack's places are shown. */
  attribution: string;
  builtAt: string;
  radiusKm: number;
  /** The airport's distance from the centre, km. */
  airportKm: number;
  /** How many candidates the map had (hotels, activities) before picking. */
  candidates: { hotels: number; activities: number };
}

/** A city file (data/cities/<ID>.json) — curated, or generated from the map (`generated: true`, with `meta`). */
export interface CityPack {
  city: PackCity;
  hotels: PackHotel[];
  activities: PackActivity[];
  overrides: PackOverride[];
  hilly: string[];
  generated?: true;
  meta?: PackMeta;
}

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
