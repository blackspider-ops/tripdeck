/**
 * Live (RouteStack) inventory as the pricing code sees it (docs/12-routestack.md "Wiring"). Pure: the per-voyage
 * overlay is filled by trips/live.ts and handed to the chart book; nothing here touches the network or the shared
 * Dataset (which is global and cached per revision).
 *
 * Preference, per port × window: live > curated > modelled, for flights (per member) and stays. The same fit rules
 * and dealbreakers apply to live options; a member whose live fares all break a rule (or come back empty) falls back
 * to the curated / modelled options, and that plan is then "estimated".
 */
import type { CityId, Dataset, FlightOption, HotelOption } from "@all-ayes/shared";
import { ORIGINS } from "@all-ayes/shared";
import { flightsFor } from "./flights.js";
import { perDataset } from "../data/loader.js";

/** A live stay, ready for pricing: lat/lng are the port's centre when the supplier's location is approximate. */
export type LiveStay = HotelOption & { source: "routestack"; approxLocation?: boolean; stars?: number; distanceKm?: number; bookingRef?: string; imageUrl?: string };
export type LiveFlight = FlightOption & { source: "routestack"; bookingRef?: string };

/** One voyage's live options (never shared between voyages, never written into the Dataset). */
export interface LiveInventory {
  /** Stays by `liveHotelKey` (port, window, guests searched: the price is for that whole occupancy). */
  hotels: Map<string, LiveStay[]>;
  /** Fares by `liveFlightKey` (port, window, home airport), per person. */
  flights: Map<string, LiveFlight[]>;
  /** The gateway the prices came from. */
  feed: "sandbox" | "live";
  /** When the latest result landed (ms). */
  updatedAt: number;
}

export const liveHotelKey = (cityId: CityId, windowId: string, guests: number) => `${cityId}|${windowId}|${guests}`;
export const liveFlightKey = (cityId: CityId, windowId: string, origin: string) => `${cityId}|${windowId}|${origin}`;
export const emptyInventory = (feed: "sandbox" | "live" = "sandbox"): LiveInventory => ({ hotels: new Map(), flights: new Map(), feed, updatedAt: 0 });

export const isLiveOption = (o: object | null | undefined): boolean => (o as { source?: unknown } | null | undefined)?.source === "routestack";

/** At most this many live stays per port × window go on the chart book (the cheapest, then the best rated). */
export const LIVE_STAYS_PER_PORT = 6;
const CHEAPEST_STAYS = 4;

/** The live stays for this port, window and crew size, trimmed for the chart book; [] when there are none. */
export function liveStaysFor(live: LiveInventory | undefined, cityId: CityId, windowId: string, crewSize: number): LiveStay[] {
  const all = live?.hotels.get(liveHotelKey(cityId, windowId, crewSize)) ?? [];
  if (all.length <= LIVE_STAYS_PER_PORT) return [...all];
  const byPrice = [...all].sort((a, b) => a.nightlyCents - b.nightlyCents);
  const picked = byPrice.slice(0, CHEAPEST_STAYS);
  const rest = byPrice.slice(CHEAPEST_STAYS, 16).sort((a, b) => b.rating - a.rating || a.nightlyCents - b.nightlyCents);
  return [...picked, ...rest.slice(0, LIVE_STAYS_PER_PORT - CHEAPEST_STAYS)];
}

/**
 * The live fare band of a port and window, from public facts only (S2-002): every home airport's curated / modelled
 * fares there, LIVE_BAND_LOW × the cheapest to LIVE_BAND_HIGH × the dearest. Live fares exist only for the crew's own
 * home airports, so the public group range can't be built from them (it would say where the crew lives); instead a
 * plan with a live fare widens its public range to this band, and a live fare outside the band is treated as an
 * outlier and not used (the member keeps the curated / modelled fare). Null when the port has no flights at all.
 */
export const LIVE_BAND_LOW = 0.6;
export const LIVE_BAND_HIGH = 1.4;
const bandCache = perDataset(() => new Map<string, { lowCents: number; highCents: number } | null>());
export function liveBand(ds: Dataset, cityId: CityId, windowId: string): { lowCents: number; highCents: number } | null {
  const cache = bandCache(ds);
  const k = `${cityId}|${windowId}`;
  if (cache.has(k)) return cache.get(k)!;
  const prices = ORIGINS.flatMap((o) => flightsFor(ds, cityId, o, windowId)).filter((f) => !f.homePort && f.priceCents > 0).map((f) => f.priceCents);
  const band = prices.length
    ? { lowCents: Math.floor((Math.min(...prices) * LIVE_BAND_LOW) / 100) * 100, highCents: Math.ceil((Math.max(...prices) * LIVE_BAND_HIGH) / 100) * 100 }
    : null;
  cache.set(k, band);
  return band;
}

/** A member's live fares for this route, within the band, cheapest first ([] when there are none). */
export function liveFaresFor(ds: Dataset, live: LiveInventory | undefined, cityId: CityId, origin: string, windowId: string): LiveFlight[] {
  const list = live?.flights.get(liveFlightKey(cityId, windowId, origin));
  if (!list?.length) return [];
  const band = liveBand(ds, cityId, windowId);
  if (!band) return [];
  return list.filter((f) => f.priceCents >= band.lowCents && f.priceCents <= band.highCents).sort((a, b) => a.priceCents - b.priceCents);
}
