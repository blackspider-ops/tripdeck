/**
 * Live flights: flight/session (free) → flight/search (billable) → LiveFlightOption[] (per-person USD cents).
 * docs/12-routestack.md "Flights".
 */
import { config } from "../../config.js";
import { billable, cached, cacheKey, configuredClient, guard, RouteStackError } from "./client.js";
import { normalizeFlights, type LiveFlightOption, type RsItinerary, type RsSegment } from "./normalize.js";

export interface LiveFlightsQuery {
  /** Member's origin airport (IATA, e.g. "ATL"). */
  origin: string;
  /** The port's airport (IATA, e.g. "LIS"). */
  destinationIata: string;
  /** YYYY-MM-DD outbound. */
  depart: string;
  /** YYYY-MM-DD return; omitted = one way. */
  return?: string;
  /** Travellers searched together (seat availability). RouteStack prices the whole party; options carry per-person fares. */
  adults: number;
  /** Stamped on each option (defaults: destinationIata, ""). */
  cityId?: string;
  dateWindowId?: string;
  tripId?: string;
  max?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const IATA = /^[A-Z]{3}$/;

/** Keeps what normalization reads (itineraries carry tax break-ups, penalties, baggage per segment…). */
function slim(body: unknown): { currency?: string; count?: number; result: RsItinerary[] } {
  const b = (body ?? {}) as { success?: boolean; code?: unknown; message?: unknown; currency?: string; count?: number; result?: unknown };
  if (!Array.isArray(b.result)) {
    if (b.success === false) throw new RouteStackError("TOOL_ERROR", `flight search refused (code ${String(b.code ?? "?")})`);
    return { currency: b.currency, count: 0, result: [] };
  }
  const seg = (s: RsSegment): RsSegment => ({
    airline: s.airline, departure: s.departure, arrival: s.arrival, departureTime: s.departureTime, arrivalTime: s.arrivalTime,
    flightCode: s.flightCode, flightNumber: s.flightNumber, stops: s.stops, legindicator: s.legindicator, cabin: s.cabin, fareFamily: s.fareFamily,
  });
  const rows = (b.result as RsItinerary[]).filter((r) => r && typeof r === "object").slice(0, 300).map((r) => ({
    fareSourceCode: r.fareSourceCode, stops: r.stops, currency: r.currency, ourprice: r.ourprice, showOurprice: r.showOurprice,
    totalFare: r.totalFare, quantity: r.quantity, paxType: r.paxType,
    flights: Array.isArray(r.flights) ? r.flights.filter((s) => s && typeof s === "object").map(seg) : [],
  }));
  return { currency: b.currency ?? undefined, count: typeof b.count === "number" ? b.count : rows.length, result: rows };
}

/**
 * Live round-trip (or one-way) fares, cheapest first, one per (airline, departure). null (never a throw) when
 * RouteStack is off, the budget is spent, the search times out or fails; [] when it searched and found nothing.
 */
export function liveFlights(q: LiveFlightsQuery): Promise<LiveFlightOption[] | null> {
  return guard("flights", async () => {
    const client = configuredClient();
    if (!client) return null;
    const origin = String(q?.origin ?? "").trim().toUpperCase();
    const destination = String(q?.destinationIata ?? "").trim().toUpperCase();
    const ret = q.return?.trim() || undefined;
    if (!IATA.test(origin) || !IATA.test(destination) || origin === destination || !DAY.test(q.depart) || (ret && (!DAY.test(ret) || ret < q.depart))) {
      throw new RouteStackError("BAD_INPUT", "liveFlights needs IATA origin/destination and YYYY-MM-DD dates");
    }
    const adults = Math.max(1, Math.min(9, Math.round(q.adults) || 1));
    const tripType = ret ? "RoundTrip" : "OneWay";
    const search = {
      tripType, type: tripType, origin, destination, departureDate: q.depart, ...(ret ? { returnDate: ret } : {}),
      adults, children: 0, infants: 0, cabinClass: "Economy", currency: "USD",
    };
    const key = cacheKey(["flights", config.routestack.baseUrl(), search]);
    const page = await cached(key, config.routestack.cacheTtlMs(), async () => {
      // the session is free; RouteStack says search "may require" it, so ask for one on every real search
      const session = await client.post<{ sessionId?: unknown; result?: { sessionId?: unknown } }>("/mcp/flight/session", {}).catch(() => null);
      const sid = session?.sessionId ?? session?.result?.sessionId;
      const body = typeof sid === "string" && sid ? { sessionId: sid, ...search } : search;
      return billable(key, q.tripId, async () => slim(await client.post("/mcp/flight/search", body, { billable: true })));
    });
    return normalizeFlights(page, { cityId: q.cityId ?? destination, origin, destinationIata: destination, dateWindowId: q.dateWindowId ?? "", depart: q.depart, return: ret, adults }, q.max ?? 15);
  });
}
