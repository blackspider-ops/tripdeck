/** GET /api/world/search: curated cities that match first, then Nominatim's (minus duplicates of a curated one). */
import { OSM_ATTRIBUTION, type WorldSearchResponse, type WorldSearchResult } from "@all-ayes/shared";
import { haversineKm } from "./airports.js";
import { UpstreamBusy } from "./net.js";
import { normQuery, searchPlaces, toResult } from "./nominatim.js";

/** What search needs from a curated city (the dataset's City, plus `country` once city files carry it). */
export interface CuratedCity { _id: string; name: string; centerLat: number; centerLng: number; country?: string; state?: string }

/** Lower case, no accents: "Montréal" and "montreal" match. */
export const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Curated cities matching the query's first part ("split, croatia" → "split"): id, name prefix, or name word. */
export function curatedMatches(q: string, cities: CuratedCity[]): WorldSearchResult[] {
  const [head, ...rest] = fold(q).split(",").map((s) => s.trim());
  const tail = rest.join(" ");
  if (head.length < 2) return [];
  const hits = cities.filter((c) => {
    const name = fold(c.name);
    const nameHit = c._id.toLowerCase() === head || name.startsWith(head) || name.split(/[\s-]+/).some((w) => w.startsWith(head));
    return nameHit && (!tail || !c.country || fold(c.country).startsWith(tail) || tail.length < 2);
  });
  return hits
    .sort((a, b) => Number(!fold(a.name).startsWith(head)) - Number(!fold(b.name).startsWith(head)) || a.name.localeCompare(b.name))
    .map((c) => ({
      kind: "curated" as const, cityId: c._id, name: c.name, country: c.country ?? "", countryCode: "",
      ...(c.state ? { state: c.state } : {}), lat: c.centerLat, lng: c.centerLng,
      displayName: c.country ? `${c.name}, ${c.country}` : c.name,
    }));
}

/** Within this distance and with the same name, a map result is the curated city again. */
const SAME_CITY_KM = 30;

export async function worldSearch(q: string, cities: CuratedCity[], search = searchPlaces): Promise<WorldSearchResponse> {
  const key = normQuery(q);
  const curated = curatedMatches(key, cities);
  if (key.length < 2) return { results: [], world: "skipped", attribution: OSM_ATTRIBUTION };
  let world: WorldSearchResult[] = [];
  let status: WorldSearchResponse["world"] = "ok";
  try {
    world = (await search(key)).map(toResult).filter((w) => !curated.some((c) =>
      fold(c.name) === fold(w.name) && haversineKm(c.lat, c.lng, w.lat, w.lng) < SAME_CITY_KM));
  } catch (e) {
    if (!(e instanceof UpstreamBusy)) console.warn("[world] search failed:", (e as Error).message);
    status = "unavailable";
  }
  return { results: [...curated, ...world].slice(0, 12), world: status, attribution: OSM_ATTRIBUTION };
}
