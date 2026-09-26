/**
 * Worldwide airports (OurAirports, public domain): large + medium airports with scheduled service and an IATA code,
 * compacted by scripts/world-airports.mjs into airports.json. Imported (not read from disk) so the server bundle
 * carries it without a copy step.
 */
import raw from "./airports.json" with { type: "json" };

export interface Airport { iata: string; name: string; city: string; country: string; lat: number; lng: number; large: boolean }

type Row = [string, string, string, string, number, number, number];
let list: Airport[] | null = null;
let byCode: Map<string, Airport> | null = null;

export function airports(): Airport[] {
  if (list) return list;
  list = (raw as { rows: unknown[] }).rows.map((r) => {
    const [iata, name, city, country, lat, lng, size] = r as Row;
    return { iata, name, city, country, lat, lng, large: size === 2 };
  });
  return list;
}

export function airportByCode(code: string): Airport | undefined {
  byCode ??= new Map(airports().map((a) => [a.iata, a]));
  return byCode.get(code.toUpperCase());
}

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The `n` nearest airports (a linear scan: ~3,200 rows, well under a millisecond; a cheap degree box skips the
 * haversine for far rows once `n` are found). Ties break on the IATA code, so the answer is stable.
 */
export function nearestAirports(lat: number, lng: number, n = 5, pool: Airport[] = airports()): { airport: Airport; km: number }[] {
  const best: { airport: Airport; km: number }[] = [];
  for (const a of pool) {
    if (best.length >= n) {
      const worst = best[best.length - 1].km;
      const degLat = worst / 111;
      if (Math.abs(a.lat - lat) > degLat) continue;
    }
    const km = haversineKm(lat, lng, a.lat, a.lng);
    if (best.length < n || km < best[best.length - 1].km || (km === best[best.length - 1].km && a.iata < best[best.length - 1].airport.iata)) {
      best.push({ airport: a, km });
      best.sort((x, y) => x.km - y.km || (x.airport.iata < y.airport.iata ? -1 : 1));
      if (best.length > n) best.pop();
    }
  }
  return best;
}

/** How much closer (km) a medium airport must be to win over a large one: large airports get the long-haul flights. */
export const LARGE_AIRPORT_BONUS_KM = 40;
/** Farther than this and there is no sensible airport for the place. */
export const MAX_AIRPORT_KM = 250;

/** The airport a trip to (lat, lng) flies into: the nearest, with large airports preferred within LARGE_AIRPORT_BONUS_KM. */
export function airportFor(lat: number, lng: number, pool: Airport[] = airports()): { airport: Airport; km: number } | null {
  const near = nearestAirports(lat, lng, 8, pool).filter((x) => x.km <= MAX_AIRPORT_KM);
  if (!near.length) return null;
  const score = (x: { airport: Airport; km: number }) => x.km - (x.airport.large ? LARGE_AIRPORT_BONUS_KM : 0);
  return [...near].sort((a, b) => score(a) - score(b) || (a.airport.iata < b.airport.iata ? -1 : 1))[0];
}
