/**
 * Live hotels: search-destinations (free) → search-hotels (billable, first page only) → LiveHotelOption[].
 * docs/12-routestack.md "Hotels".
 */
import { config } from "../../config.js";
import { billable, cached, cacheKey, configuredClient, guard, RouteStackError, type RouteStackClient } from "./client.js";
import { normalizeHotels, roomsFor, type LiveHotelOption, type RsHotel, type RsHotelPage } from "./normalize.js";

export interface LiveHotelsQuery {
  /** Free text RouteStack resolves to a destination id ("Lisbon", "Mexico City"). */
  cityName: string;
  /** Our city id (stamped on each option); defaults to the city name. */
  cityId?: string;
  /** Search centre (the city's centre in our dataset). */
  lat: number;
  lng: number;
  /** YYYY-MM-DD */
  checkIn: string;
  checkOut: string;
  /** People sharing the stay (the whole crew). */
  guests: number;
  /** The voyage this search is for (per-voyage spend cap); defaults to the async scope's voyage. */
  tripId?: string;
  max?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEST_TTL_MS = 30 * 86_400_000;

interface Destination { id: string; type: string; lat: number | null; lng: number | null }

/** The best destination for a city name: a City near our centre, else the first City, else the first result. */
export function pickDestination(rows: unknown, lat: number, lng: number): Destination | null {
  const list = (Array.isArray(rows) ? rows : []).filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && (typeof r.id === "string" || typeof r.id === "number"));
  if (!list.length) return null;
  const coord = (r: Record<string, unknown>) => {
    const c = (r.coordinates ?? {}) as { lat?: unknown; long?: unknown; lng?: unknown };
    const la = Number(c.lat), lo = Number(c.long ?? c.lng);
    return Number.isFinite(la) && Number.isFinite(lo) ? { lat: la, lng: lo } : null;
  };
  const dist = (r: Record<string, unknown>) => { const c = coord(r); return c ? Math.hypot(c.lat - lat, c.lng - lng) : 99; };
  const cities = list.filter((r) => String(r.type ?? "").toLowerCase() === "city");
  const pool = cities.length ? cities : list;
  const best = [...pool].sort((a, b) => dist(a) - dist(b))[0];
  const c = coord(best);
  return { id: String(best.id), type: String(best.type ?? "City"), lat: c?.lat ?? null, lng: c?.lng ?? null };
}

async function resolveDestination(client: RouteStackClient, q: LiveHotelsQuery): Promise<Destination | null> {
  const key = cacheKey(["dest", config.routestack.baseUrl(), q.cityName.trim().toLowerCase(), Math.round(q.lat), Math.round(q.lng)]);
  return cached(key, DEST_TTL_MS, async () => {
    const res = await client.post<{ success?: boolean; result?: unknown }>("/mcp/hotel/search-destinations", { query: q.cityName.trim(), type: "DESTINATION" });
    return pickDestination(res?.result, q.lat, q.lng);
  });
}

/** Keeps what normalization reads, so the cache files stay small (a page carries ~60 facilities per hotel). */
function slimPage(body: unknown): { success: boolean; result: RsHotelPage | null } {
  const b = (body ?? {}) as { success?: boolean; code?: unknown; result?: unknown };
  const r = Array.isArray(b.result) ? b.result.find((x) => x && typeof x === "object") : b.result;
  if (!r || typeof r !== "object") {
    // success:false with code 204 (or a null result) is "no hotels for this query" — a billed, valid answer
    if (b.success === false && Number(b.code) !== 204) throw new RouteStackError("TOOL_ERROR", `search-hotels refused (code ${String(b.code ?? "?")})`);
    return { success: true, result: null };
  }
  const page = r as RsHotelPage;
  const rows = (Array.isArray(page.result) ? page.result : Array.isArray(page.hotels) ? page.hotels : []) as RsHotel[];
  const pick = (h: RsHotel): RsHotel => ({
    id: h.id, name: h.name, chain: h.chain, providerName: h.providerName, starRating: h.starRating, ourprice: h.ourprice,
    publishedRate: h.publishedRate, currency: h.currency, distance: h.distance, distancekm: h.distancekm, heroImage: h.heroImage,
    reviews: h.reviews ? { rating: h.reviews.rating, count: h.reviews.count } : null,
    options: h.options ? { freeCancellation: h.options.freeCancellation, refundable: h.options.refundable, freeBreakfast: h.options.freeBreakfast } : undefined,
  });
  return {
    success: true,
    result: { status: page.status, count: page.count, currency: page.currency, correlationId: page.correlationId, nextResultsKey: page.nextResultsKey, result: rows.slice(0, 200).map(pick) },
  };
}

/**
 * Live hotels for a city and stay, cheapest first; null (never a throw) when RouteStack is off, the budget is spent,
 * the search times out or fails, so the caller keeps its curated hotels. An empty array means "searched, nothing".
 */
export function liveHotels(q: LiveHotelsQuery): Promise<LiveHotelOption[] | null> {
  return guard("hotels", async () => {
    const client = configuredClient();
    if (!client) return null;
    if (!q?.cityName?.trim() || !DAY.test(q.checkIn) || !DAY.test(q.checkOut) || q.checkOut <= q.checkIn || !Number.isFinite(q.lat) || !Number.isFinite(q.lng)) {
      throw new RouteStackError("BAD_INPUT", "liveHotels needs a city name, lat/lng and checkIn < checkOut (YYYY-MM-DD)");
    }
    const dest = await resolveDestination(client, q);
    if (!dest) return [];
    const rooms = roomsFor(q.guests);
    const body = {
      destinationId: dest.id, destinationType: dest.type, lat: q.lat, long: q.lng,
      checkIn: q.checkIn, checkOut: q.checkOut, roomCount: rooms.length, rooms, currency: "USD",
    };
    const key = cacheKey(["hotels", config.routestack.baseUrl(), body]);
    const page = await cached(key, config.routestack.cacheTtlMs(), () =>
      billable(key, q.tripId, async () => slimPage(await client.post("/mcp/hotel/search-hotels", body, { billable: true }))));
    const guests = rooms.reduce((n, r) => n + r.adults, 0);
    return normalizeHotels(page, { cityId: q.cityId ?? q.cityName, lat: q.lat, lng: q.lng, checkIn: q.checkIn, checkOut: q.checkOut, guests }, q.max ?? 20);
  });
}
