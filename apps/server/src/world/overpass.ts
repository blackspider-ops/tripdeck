/**
 * Places around a point from the OpenStreetMap Overpass API (https://wiki.openstreetmap.org/wiki/Overpass_API):
 * one POST per pack (two when a small place needs the wider radius), a 25 s server timeout, one call at a time with
 * 2 s spacing for the whole process, and a polite User-Agent. Output counts are capped per group so a big city's
 * thousands of bars and restaurants never come back whole.
 */
import { Throttle, UpstreamBusy, politeFetch } from "./net.js";

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
/** WORLD_OVERPASS_URL points at another instance (a mirror, or a self-hosted one) when the main one is overloaded. */
export const overpassUrl = () => process.env.WORLD_OVERPASS_URL?.trim() || OVERPASS_URL;
export const overpassThrottle = new Throttle(2_000, 6);

export interface OsmElement {
  type: "node" | "way" | "relation"; id: number;
  lat?: number; lon?: number; center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * The Overpass QL for everything a pack can use within `radiusM` of (lat, lng). A global bounding box (the square
 * around the circle) with tag filters is much cheaper for Overpass than per-statement `around` filters; the builder
 * drops what's outside the circle itself.
 */
export function overpassQuery(lat: number, lng: number, radiusM: number): string {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const f = (x: number) => x.toFixed(5);
  const bbox = `${f(lat - dLat)},${f(lng - dLng)},${f(lat + dLat)},${f(lng + dLng)}`;
  return [
    `[out:json][timeout:25][bbox:${bbox}];`,
    `(nwr["tourism"~"^(hotel|hostel|guest_house|apartment)$"]["name"];)->.stay;`,
    `(nwr["tourism"~"^(museum|attraction|viewpoint|gallery|zoo|theme_park)$"]["name"];`,
    ` nwr["historic"~"^(castle|monument|memorial|ruins|archaeological_site)$"]["name"];`,
    ` nwr["leisure"~"^(park|nature_reserve|beach_resort)$"]["name"];`,
    ` nwr["natural"="beach"]["name"];`,
    ` nwr["amenity"~"^(theatre|marketplace)$"]["name"];`,
    ` nwr["place"="square"]["name"];)->.see;`,
    `(nwr["amenity"~"^(bar|pub|nightclub)$"]["name"];)->.night;`,
    `(nwr["amenity"="restaurant"]["cuisine"]["name"];)->.food;`,
    // wikidata-tagged places first (the notable ones), then the rest up to each cap
    ".stay out tags center 200;",
    "nwr.see[\"wikidata\"]; out tags center 250;",
    ".see out tags center 250;",
    "nwr.night[\"wikidata\"]; out tags center 40;",
    ".night out tags center 60;",
    "nwr.food[\"wikidata\"]; out tags center 40;",
    ".food out tags center 60;",
  ].join("\n");
}

export const overpassStats = { calls: 0 };

/** The elements around a point, de-duplicated (the wikidata pass repeats some). Throws UpstreamBusy when busy. */
export async function fetchOverpass(lat: number, lng: number, radiusM: number): Promise<OsmElement[]> {
  return overpassThrottle.run(async () => {
    overpassStats.calls++;
    const res = await politeFetch("overpass", overpassUrl(), {
      method: "POST",
      timeoutMs: 45_000, // [timeout:25] runs after Overpass's own queue
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: overpassQuery(lat, lng, radiusM) }).toString(),
    });
    const body = (await res.json()) as { elements?: OsmElement[]; remark?: string };
    // Overpass reports its own timeouts / memory limits as a 200 with a remark and partial (often empty) elements
    if (body.remark && /runtime error|timed out|out of memory/i.test(body.remark) && !(body.elements ?? []).length) {
      throw new UpstreamBusy("overpass", 60, body.remark);
    }
    const seen = new Set<string>();
    const out: OsmElement[] = [];
    for (const e of body.elements ?? []) {
      const k = `${e.type}/${e.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
  });
}
