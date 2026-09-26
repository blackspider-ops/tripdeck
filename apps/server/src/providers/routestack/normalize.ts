/**
 * RouteStack payloads → our HotelOption / FlightOption shapes (docs/12-routestack.md "Normalization").
 * Pure functions: no I/O, so the fixtures in test/routestack.test.ts pin every rule.
 */
import { createHash } from "node:crypto";
import type { FlightOption, HotelOption } from "@all-ayes/shared";
import { MAX_CREW } from "@all-ayes/shared";

// ---------- shapes we read (documented in RouteStack's openapi.yaml + FLIGHT_SEARCH_FIELDS.md) ----------
export interface RsHotel {
  id?: string | number; name?: string; providerName?: string; chain?: string; starRating?: number;
  ourprice?: number; publishedRate?: number; baseprice?: number; currency?: string;
  distance?: number; distancekm?: number; heroImage?: string;
  reviews?: { rating?: number; count?: number } | null;
  contact?: { address?: { line1?: string; city?: { name?: string }; country?: { code?: string; name?: string } } };
  options?: { freeCancellation?: boolean; refundable?: boolean; freeBreakfast?: boolean };
  mainamenity?: string[] | string;
  [k: string]: unknown;
}
export interface RsHotelPage {
  status?: string; nextResultsKey?: string; count?: number; token?: string; correlationId?: string; currency?: string;
  result?: RsHotel[]; hotels?: RsHotel[];
}
export interface RsSegment {
  airline?: string; departure?: string; arrival?: string; departureTime?: string; arrivalTime?: string;
  flightCode?: string; flightNumber?: string; stops?: number; legindicator?: number; cabin?: string; fareFamily?: string;
  [k: string]: unknown;
}
export interface RsItinerary {
  fareSourceCode?: string; stops?: number; flights?: RsSegment[]; currency?: string;
  ourprice?: number; showOurprice?: number | { amount?: number }; totalFare?: number; quantity?: number; paxType?: string;
  [k: string]: unknown;
}

/** Our additions on top of the shared option shapes (extra fields are ignored by the engine). */
export type LiveHotelOption = HotelOption & {
  source: "routestack"; bookingRef?: string;
  /** RouteStack's search list has no coordinates: lat/lng sit `distancekm` from the search centre on a stable bearing. */
  approxLocation?: boolean; imageUrl?: string; freeCancellation?: boolean;
};
export type LiveFlightOption = FlightOption & { source: "routestack"; bookingRef?: string; currency: "USD" };

// ---------- currency ----------
/**
 * USD per unit, a static table (Sept 2026 ballpark). We always ask RouteStack for USD, so this only matters when a
 * supplier answers in its own currency anyway; it is an estimate for ranking, not a quote (checkout re-prices).
 */
export const FX_TO_USD: Record<string, number> = {
  USD: 1, EUR: 1.1, GBP: 1.3, CAD: 0.73, AUD: 0.66, NZD: 0.6, CHF: 1.18, JPY: 0.0068, CNY: 0.14, HKD: 0.128,
  SGD: 0.77, INR: 0.0115, MXN: 0.054, BRL: 0.18, AED: 0.272, SEK: 0.095, NOK: 0.093, DKK: 0.147, PLN: 0.26,
  CZK: 0.044, HUF: 0.0028, TRY: 0.024, THB: 0.029, ZAR: 0.056, KRW: 0.00072, ISK: 0.0073, MAD: 0.1, COP: 0.00025,
};
/** An amount in `currency` → USD cents, or null when the currency is unknown or the amount isn't a positive number. */
export function toUsdCents(amount: unknown, currency: string | undefined): number | null {
  const n = typeof amount === "number" ? amount : typeof amount === "string" ? Number(amount) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const rate = FX_TO_USD[(currency || "USD").trim().toUpperCase()];
  return rate ? Math.round(n * rate * 100) : null;
}

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

// ---------- hotels ----------
/**
 * The rooming rule (one billable search per city × window): RouteStack prices the whole occupancy we send, for the
 * whole stay (`ourprice` = all rooms × all nights). We send 1–2 guests as one room, 3 guests as one triple room (only
 * properties that sleep 3 in a room or apartment come back), and 4+ as rooms of two (4 → 2×2, 5 → 2+2+1; a full crew
 * of MAX_CREW 12 → 6 rooms).
 * nightlyCents = ourprice / nights for that whole occupancy, so it is the group's nightly cost, and sleeps = guests.
 */
export function roomsFor(guests: number): { adults: number; children: number; childAges: number[] }[] {
  const g = Math.max(1, Math.min(MAX_CREW, Math.round(guests) || 1));
  if (g <= 3) return [{ adults: g, children: 0, childAges: [] }];
  const rooms: number[] = [];
  for (let left = g; left > 0; left -= 2) rooms.push(Math.min(2, left));
  return rooms.map((adults) => ({ adults, children: 0, childAges: [] }));
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`), b = Date.parse(`${checkOut}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(1, Math.round((b - a) / 86_400_000)) : 1;
}

/** Our four stay types from the property's name / chain (the search list has no property-type field). */
export function stayTypeOf(h: Pick<RsHotel, "name" | "chain" | "providerName">): HotelOption["stayType"] {
  const s = `${h.name ?? ""} ${h.chain ?? ""}`.toLowerCase();
  if (/\bhostel|\bhostal\b|backpacker|\bgenerator\b|\bdorm/.test(s)) return "hostel";
  if (/apart|\bflat\b|\bflats\b|residence|residenz|\bloft\b|\bstudios?\b|\bsuites?\b.*\b(apt|residence)|\bvilla\b|holiday home|\bcondo/.test(s)) return "apartment";
  if (/guest ?house|\bb ?& ?b\b|bed and breakfast|\bpension|\bpensão|\bpousada|\bposada|\bcasa\b|\binn\b|\bgasthaus|\bgasthof|\blodge\b|\bryokan|\bmaison d/.test(s)) return "guesthouse";
  return "hotel";
}

/** A 0–5 rating: guest reviews when present (a 10-point scale is halved), else the star rating, else 0. */
export function ratingOf(h: Pick<RsHotel, "reviews" | "starRating">): number {
  const r = Number(h.reviews?.rating);
  const v = Number.isFinite(r) && r > 0 ? (r > 5 ? r / 2 : r) : Number(h.starRating) || 0;
  return Math.round(Math.max(0, Math.min(5, v)) * 10) / 10;
}

/** A point `km` from (lat, lng) on a bearing fixed by `seed` (stable across runs; the list only gives a distance). */
export function offsetPoint(lat: number, lng: number, km: number, seed: string): { lat: number; lng: number } {
  if (!(km > 0)) return { lat, lng };
  const bearing = (parseInt(shortHash(seed).slice(0, 6), 16) / 0xffffff) * 2 * Math.PI;
  const dLat = (km / 111.32) * Math.cos(bearing);
  const dLng = (km / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))) * Math.sin(bearing);
  return { lat: Math.round((lat + dLat) * 1e5) / 1e5, lng: Math.round((lng + dLng) * 1e5) / 1e5 };
}

/**
 * The hotel page inside a search-hotels response. The documented envelope is `{success, code, message, result}` where
 * `result` is the page object `{status, count, token, correlationId, currency, nextResultsKey, result: RsHotel[]}`;
 * live responses have also wrapped that page in a one-item array, and some clients see `hotels` instead of `result`.
 */
export function hotelPageOf(body: unknown): RsHotelPage | null {
  const r = (body as { result?: unknown } | null)?.result;
  const page = Array.isArray(r) ? (r.find((x) => x && typeof x === "object" && (Array.isArray((x as RsHotelPage).result) || Array.isArray((x as RsHotelPage).hotels))) ?? null) : r;
  return page && typeof page === "object" ? (page as RsHotelPage) : null;
}

export interface HotelCtx { cityId: string; lat: number; lng: number; checkIn: string; checkOut: string; guests: number }

export function normalizeHotel(h: RsHotel, page: RsHotelPage, ctx: HotelCtx): LiveHotelOption | null {
  const id = h.id === undefined || h.id === null ? "" : String(h.id);
  const name = typeof h.name === "string" ? h.name.trim() : "";
  if (!id || !name) return null;
  const totalCents = toUsdCents(h.ourprice ?? h.publishedRate, h.currency ?? page.currency);
  if (totalCents === null) return null;
  const nights = nightsBetween(ctx.checkIn, ctx.checkOut);
  const km = Number(h.distancekm) || (Number(h.distance) ? Number(h.distance) * 1.609 : 0);
  const at = offsetPoint(ctx.lat, ctx.lng, km, id);
  return {
    _id: `RS-h-${id}`, kind: "hotel", cityId: ctx.cityId, name,
    neighborhood: "",
    lat: at.lat, lng: at.lng, approxLocation: true,
    stayType: stayTypeOf(h),
    nightlyCents: Math.round(totalCents / nights),
    sleeps: Math.max(1, Math.round(ctx.guests)),
    rating: ratingOf(h),
    source: "routestack",
    bookingRef: `hotel:${id}`,
    ...(typeof h.heroImage === "string" && /^https:\/\//.test(h.heroImage) ? { imageUrl: h.heroImage } : {}),
    ...(typeof h.options?.freeCancellation === "boolean" ? { freeCancellation: h.options.freeCancellation } : {}),
  };
}

/** Every priced hotel on the page, cheapest first, at most `max`. */
export function normalizeHotels(body: unknown, ctx: HotelCtx, max = 20): LiveHotelOption[] {
  const page = hotelPageOf(body);
  if (!page) return [];
  const rows = Array.isArray(page.result) ? page.result : Array.isArray(page.hotels) ? page.hotels : [];
  const seen = new Set<string>();
  return rows
    .map((h) => normalizeHotel(h, page, ctx))
    .filter((h): h is LiveHotelOption => h !== null && !seen.has(h._id) && Boolean(seen.add(h._id)))
    .sort((a, b) => a.nightlyCents - b.nightlyCents)
    .slice(0, max);
}

// ---------- flights ----------
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** "2027-08-20T14:55:00" → "2027-08-20T14:55" (the supplier's local time, as our dataset stores it). */
export const localMinute = (s: unknown): string | null => (typeof s === "string" && LOCAL.test(s) ? s.slice(0, 16) : null);

/**
 * Red-eye: the outbound departs 21:00–04:59 local, or lands on a later calendar day than it left (an overnight
 * flight, like every US→Europe hop in our dataset).
 */
export function isRedEye(departLocal: string, arriveLocal: string): boolean {
  const hour = Number(departLocal.slice(11, 13));
  return hour >= 21 || hour < 5 || arriveLocal.slice(0, 10) > departLocal.slice(0, 10);
}

/**
 * Price per person: `showOurprice` (display price) ?? `ourprice` ?? `totalFare`. Alpha's newsearch prices each
 * itinerary per passenger type (`paxType: "ADT"`, `quantity` = travellers of that type), so the fare is per adult
 * whatever `adults` we searched with; FlightOption.priceCents is per member too.
 */
export function farePrice(it: RsItinerary): number | null {
  const show = typeof it.showOurprice === "object" && it.showOurprice ? it.showOurprice.amount : it.showOurprice;
  for (const v of [show, it.ourprice, it.totalFare]) if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return null;
}

export interface FlightCtx { cityId: string; origin: string; destinationIata: string; dateWindowId: string; depart: string; return?: string }

export function normalizeItinerary(it: RsItinerary, currency: string | undefined, ctx: FlightCtx): LiveFlightOption | null {
  const segs = Array.isArray(it.flights) ? it.flights.filter((s) => s && typeof s === "object") : [];
  if (!segs.length) return null;
  const out = segs.filter((s) => (Number(s.legindicator) || 0) === 0);
  const back = segs.filter((s) => Number(s.legindicator) === 1);
  if (!out.length) return null;
  const departLocal = localMinute(out[0].departureTime);
  const arriveLocal = localMinute(out[out.length - 1].arrivalTime);
  if (!departLocal || !arriveLocal) return null;
  // A round trip's return leg gives returnLocal (its first departure); a one-way search leaves the return date's noon.
  const returnLocal = localMinute(back[0]?.departureTime) ?? (ctx.return ? `${ctx.return}T12:00` : null);
  if (!returnLocal) return null;
  const price = farePrice(it);
  const cents = toUsdCents(price, it.currency ?? currency);
  if (cents === null) return null;
  const legStops = (legs: RsSegment[]) => legs.length - 1 + legs.reduce((n, s) => n + (Number(s.stops) || 0), 0);
  const stops = Math.min(2, Math.max(legStops(out), back.length ? legStops(back) : 0)) as 0 | 1 | 2;
  const carriers = [...new Set(out.map((s) => (typeof s.airline === "string" ? s.airline.trim() : "")).filter(Boolean))];
  const via = out.slice(0, -1).map((s) => s.arrival).filter((c): c is string => typeof c === "string" && /^[A-Z]{3}$/.test(c));
  const airline = `${carriers.join(" / ") || "Airline"}${via.length ? ` (via ${via.join(", ")})` : ""}`;
  const ref = typeof it.fareSourceCode === "string" && it.fareSourceCode ? it.fareSourceCode : `${airline}|${departLocal}|${cents}`;
  return {
    _id: `RS-f-${ctx.cityId}-${ctx.origin}-${ctx.dateWindowId || ctx.depart}-${shortHash(ref)}`,
    kind: "flight", cityId: ctx.cityId, origin: ctx.origin, dateWindowId: ctx.dateWindowId,
    airline, departLocal, arriveLocal, returnLocal, stops, redEye: isRedEye(departLocal, arriveLocal),
    priceCents: cents, source: "routestack", currency: "USD",
    ...(typeof it.fareSourceCode === "string" ? { bookingRef: `fare:${it.fareSourceCode}` } : {}),
  };
}

/**
 * search response `{success, code, message, count, currency, result: RsItinerary[], searchFilterObj, filters, …}` →
 * FlightOptions, cheapest first, one per (airline, departure) so the list isn't twenty fare families of one flight.
 */
export function normalizeFlights(body: unknown, ctx: FlightCtx, max = 15): LiveFlightOption[] {
  const b = (body ?? {}) as { result?: unknown; currency?: string };
  const rows = Array.isArray(b.result) ? (b.result as RsItinerary[]) : [];
  const best = new Map<string, LiveFlightOption>();
  for (const it of rows) {
    const f = it && typeof it === "object" ? normalizeItinerary(it, b.currency, ctx) : null;
    if (!f) continue;
    const k = `${f.airline}|${f.departLocal}|${f.returnLocal}`;
    const had = best.get(k);
    if (!had || f.priceCents < had.priceCents) best.set(k, f);
  }
  return [...best.values()].sort((a, b2) => a.priceCents - b2.priceCents).slice(0, max);
}
