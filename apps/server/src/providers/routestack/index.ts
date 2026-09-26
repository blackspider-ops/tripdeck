/**
 * RouteStack.ai live inventory (docs/12-routestack.md). What the engine calls:
 *   liveHotels({cityName, lat, lng, checkIn, checkOut, guests})   → LiveHotelOption[] | null
 *   liveFlights({origin, destinationIata, depart, return, adults}) → LiveFlightOption[] | null
 *   routestackStatus()                                             → coarse, secret-free status
 * Every call returns null instead of throwing (off / no keys / timeout / budget spent / error): keep curated or
 * modelled data then. RouteStack has no activities vertical (hotel, flight, car only), so activities stay curated.
 */
import { config } from "../../config.js";
import { spendFlags } from "../../util/limits.js";
import { cacheStats, configuredClient, outcomes } from "./client.js";

export { liveHotels, type LiveHotelsQuery } from "./hotels.js";
export { liveFlights, type LiveFlightsQuery } from "./flights.js";
export type { LiveFlightOption, LiveHotelOption } from "./normalize.js";
export { resetRouteStackClient } from "./client.js";

export interface RouteStackStatus {
  enabled: boolean;
  mode: "off" | "sandbox" | "live";
  /** Host only (no path, no keys). */
  host: string;
  keys: boolean;
  accountId: boolean;
  /** The daily search budget: "ok", "reserve" (only voyages past the table may search) or "capped". */
  budget: "ok" | "reserve" | "capped";
  cache: { hits: number; misses: number };
  calls: { tokenMints: number; calls: number; billableCalls: number };
  lastOkAt: string | null;
  lastError: { code: string; what: string; at: string } | null;
}

export function routestackStatus(): RouteStackStatus {
  const rs = config.routestack;
  const mode = rs.mode();
  let host = "";
  try { host = new URL(rs.baseUrl()).host; } catch { /* a malformed ROUTESTACK_BASE_URL */ }
  const client = mode === "off" ? null : configuredClient();
  return {
    enabled: mode !== "off" && Boolean(host),
    mode,
    host,
    keys: Boolean(rs.apiKey() && rs.apiSecret()),
    accountId: Boolean(rs.accountId()),
    budget: spendFlags().routestack,
    cache: { ...cacheStats },
    calls: client ? { ...client.stats } : { tokenMints: 0, calls: 0, billableCalls: 0 },
    lastOkAt: outcomes.lastOkAt ? new Date(outcomes.lastOkAt).toISOString() : null,
    lastError: outcomes.lastError ? { code: outcomes.lastError.code, what: outcomes.lastError.what, at: new Date(outcomes.lastError.at).toISOString() } : null,
  };
}
