/**
 * RouteStack live inventory (providers/routestack, docs/12-routestack.md). fetch is mocked: nothing here reaches the
 * network. Fixtures follow RouteStack's documented examples (openapi.yaml, FLIGHT_SEARCH_FIELDS.md) and the recorded
 * payload shapes in the public routestack-web repo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.js";
import { resetSpend } from "../src/util/limits.js";
import { RouteStackClient, jwtExpiryMs, parseExpiresIn, signPartnerHmac, TOKEN_REFRESH_EARLY_MS } from "../src/providers/routestack/client.js";
import { liveFlights, liveHotels, resetRouteStackClient, routestackStatus } from "../src/providers/routestack/index.js";
import { isRedEye, nightsBetween, normalizeFlights, normalizeHotels, roomsFor, stayTypeOf, toUsdCents } from "../src/providers/routestack/normalize.js";

const BASE = "https://rs.test";
const ENV = { ROUTESTACK_API_KEY: "pk_test", ROUTESTACK_API_SECRET: "sk_test", ROUTESTACK_BASE_URL: BASE, ROUTESTACK_MODE: "", ROUTESTACK_SEARCH_TIMEOUT_MS: "", ROUTESTACK_TIMEOUT_MS: "" };

/** A JWT-shaped token whose payload carries `exp` (unix seconds), like the partner-token example. */
const jwt = (expSec: number, n = 0) =>
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({ accountId: "536846", iat: expSec - 86400, exp: expSec, iss: "cts-partner", n })).toString("base64url")}.sig`;

// ---------- fixtures ----------
const DESTINATIONS = {
  success: true, message: "data retrieved", code: 5128,
  result: [
    { city: null, type: "State", referenceId: null, fullName: "Lisbon, Portugal", country: "PT", id: "900", coordinates: { lat: 38.9, long: -9.2 } },
    { city: null, type: "City", referenceId: null, fullName: "Lisbon, Lisbon District, Portugal", country: "PT", id: "2427", coordinates: { lat: 38.7223, long: -9.1393 } },
    { city: null, type: "Airport", referenceId: null, fullName: "Lisbon, Portugal (LIS-Humberto Delgado)", country: "PT", id: "3001", coordinates: { lat: 38.7742, long: -9.1342 } },
  ],
};
/** search-hotels: the page wrapped in a one-item array (as recorded live), prices = whole stay for all rooms. */
const HOTELS = {
  success: true, message: "data retrieved", code: 5128,
  result: [{
    status: "InProgress", nextResultsKey: "MF8xNDA=", count: 141, token: "38fac1d1", correlationId: "621b0b85", currency: "EUR",
    result: [
      { id: "41393487", name: "ibis Styles Lisboa Centro", providerName: "Priceline_CUG", starRating: 3, ourprice: 800, baseprice: 0, publishedRate: 820, distance: 1.2, distancekm: 1.93, heroImage: "https://i.travelapi.com/a.jpg", chain: "Accor", options: { freeCancellation: false }, contact: { address: { line1: "Rua X 1", city: { name: "Lisbon" }, country: { code: "PT", name: "Portugal" } } }, reviews: null, facilities: [{ name: "Free WiFi", id: 2390 }] },
      { id: "5550001", name: "Alfama Riverside Apartments", providerName: "Priceline_CUG", starRating: 4, ourprice: 1000, distancekm: 0.8, reviews: { rating: 9.2, count: 310 }, options: { freeCancellation: true } },
      { id: "5550002", name: "Lost Inn Lisbon Hostel", starRating: 2, ourprice: 400, distancekm: 0.5, reviews: { rating: 4.1, count: 90 } },
      { id: "5550003", name: "No Price Palace", starRating: 5 },
    ],
  }],
};
/** flight/search: round trip ATL→LIS, segments with legindicator 0 (outbound) / 1 (return), prices per adult in USD. */
const seg = (dep: string, arr: string, dt: string, at: string, leg: 0 | 1, airline = "Delta") => ({ triptime: 480, airline, cabin: "Economy", departure: dep, arrival: arr, departureTime: dt, arrivalTime: at, stops: 0, flightCode: "DL", flightNumber: "100", fareFamily: "MAIN CABIN", legindicator: leg });
const FLIGHTS = {
  count: 3, code: "6026", message: "data retrieved", success: true, currency: "USD", currencyrate: 1,
  searchFilterObj: '{"type":"RoundTrip","adult":3}',
  result: [
    { stops: 0, fareSourceCode: "FSC-direct", paxType: "ADT", quantity: 3, baseFare: 500, totalFare: 690, ourprice: 712.4, showOurprice: 712.4,
      flights: [seg("ATL", "LIS", "2027-03-12T18:10:00", "2027-03-13T07:55:00", 0), seg("LIS", "ATL", "2027-03-16T12:40:00", "2027-03-16T16:50:00", 1)] },
    { stops: 1, fareSourceCode: "FSC-via", paxType: "ADT", quantity: 3, ourprice: 615, showOurprice: 615,
      flights: [seg("ATL", "EWR", "2027-03-12T13:05:00", "2027-03-12T15:10:00", 0, "United"), seg("EWR", "LIS", "2027-03-12T19:00:00", "2027-03-13T08:30:00", 0, "United"), seg("LIS", "EWR", "2027-03-16T13:10:00", "2027-03-16T16:05:00", 1, "United"), seg("EWR", "ATL", "2027-03-16T18:00:00", "2027-03-16T20:20:00", 1, "United")] },
    { stops: 0, fareSourceCode: "FSC-direct-basic", paxType: "ADT", quantity: 3, ourprice: 690, showOurprice: 690,
      flights: [seg("ATL", "LIS", "2027-03-12T18:10:00", "2027-03-13T07:55:00", 0), seg("LIS", "ATL", "2027-03-16T12:40:00", "2027-03-16T16:50:00", 1)] },
    { stops: 0, fareSourceCode: "FSC-broken", ourprice: 100, flights: [] },
  ],
};

// ---------- a fake RouteStack gateway ----------
type Handler = (body: Record<string, unknown>, headers: Record<string, string>) => Promise<Response> | Response;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let routes: Record<string, Handler>;
let calls: { path: string; body: Record<string, unknown>; auth?: string }[];
let now = Date.UTC(2026, 8, 26, 12) / 1000;

function gateway() {
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    expect(u.origin).toBe(BASE); // never anything else, least of all the real gateway
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path: u.pathname, body, auth: headers.Authorization });
    const h = routes[u.pathname];
    if (!h) return json(404, { success: false });
    return h(body, headers);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const count = (path: string) => calls.filter((c) => c.path === path).length;

beforeEach(() => {
  Object.assign(process.env, ENV);
  rmSync(join(config.dataDir, "routestack"), { recursive: true, force: true });
  resetRouteStackClient();
  resetSpend();
  calls = [];
  let n = 0;
  routes = {
    "/mcp/auth/partner-token": () => json(200, { token: jwt(Math.floor(Date.now() / 1000) + 86400, ++n), expiresIn: "24h" }),
    "/mcp/hotel/search-destinations": () => json(200, DESTINATIONS),
    "/mcp/hotel/search-hotels": () => json(200, HOTELS),
    "/mcp/flight/session": () => json(200, { success: true, sessionId: "722243C3-FBF3-1910" }),
    "/mcp/flight/search": () => json(200, FLIGHTS),
  };
  gateway();
});
const savedCaps = JSON.parse(JSON.stringify(config.limits.spend)) as typeof config.limits.spend;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.assign(config.limits.spend.daily, savedCaps.daily);
  Object.assign(config.limits.spend.trip, savedCaps.trip);
  for (const k of Object.keys(ENV)) delete process.env[k];
  process.env.ROUTESTACK_API_KEY = "";
  process.env.ROUTESTACK_API_SECRET = "";
  resetRouteStackClient();
  resetSpend();
});

const LISBON = { cityName: "Lisbon", cityId: "LIS", lat: 38.7223, lng: -9.1393, checkIn: "2027-03-12", checkOut: "2027-03-16", guests: 3 };
const ATL_LIS = { origin: "ATL", destinationIata: "LIS", depart: "2027-03-12", return: "2027-03-16", adults: 3, cityId: "LIS", dateWindowId: "W1" };

describe("auth: the documented HMAC partner-token exchange", () => {
  it("signs base64url(HMAC-SHA256(secret, `apiKey:timestamp:nonce`))", () => {
    // vector computed independently: printf 'pk_test:1775476924:9L8s…' | openssl dgst -sha256 -hmac sk_test -binary | base64url
    expect(signPartnerHmac("pk_test", "sk_test", 1775476924, "9L8sYyY5gK664Tf6twSKiwSMYwmkbMco")).toBe("pfOujIjhcQShnywUBa5-sWyumP2OeRLOpftg2Gm19ro");
  });

  it("mints with {apiKey, hmac, timestamp (s), nonce (uuid)} and sends only the bearer token after", async () => {
    await liveHotels(LISBON);
    const mint = calls.find((c) => c.path === "/mcp/auth/partner-token")!;
    expect(Object.keys(mint.body).sort()).toEqual(["apiKey", "hmac", "nonce", "timestamp"]);
    expect(mint.body.apiKey).toBe("pk_test");
    expect(mint.auth).toBeUndefined();
    const ts = mint.body.timestamp as number;
    expect(Number.isInteger(ts) && Math.abs(ts - Date.now() / 1000) < 5).toBe(true);
    expect(mint.body.nonce).toMatch(/^[0-9a-f-]{36}$/);
    const expected = createHmac("sha256", "sk_test").update(`pk_test:${ts}:${String(mint.body.nonce)}`).digest("base64url");
    expect(mint.body.hmac).toBe(expected);
    for (const c of calls.filter((x) => x.path !== "/mcp/auth/partner-token")) expect(c.auth).toMatch(/^Bearer ey/);
  });

  it("reads the expiry from the JWT `exp`, else `expiresIn`", () => {
    expect(jwtExpiryMs(jwt(2_000_000_000))).toBe(2_000_000_000_000);
    expect(jwtExpiryMs("not-a-jwt")).toBeNull();
    expect(parseExpiresIn("24h")).toBe(86_400_000);
    expect(parseExpiresIn("30m")).toBe(1_800_000);
    expect(parseExpiresIn(3600)).toBe(3_600_000);
    expect(parseExpiresIn("soon")).toBeNull();
  });

  it("reuses the token until 5 minutes before it expires, then mints again", async () => {
    let t = now * 1000;
    routes["/mcp/auth/partner-token"] = () => json(200, { token: jwt(Math.floor(t / 1000) + 3600), expiresIn: "1h" });
    routes["/x"] = () => json(200, { ok: true });
    const c = new RouteStackClient({ apiKey: "pk_test", apiSecret: "sk_test", baseUrl: BASE, timeoutMs: 1000, searchTimeoutMs: 1000, now: () => t });
    await c.post("/x", {});
    t += 3600_000 - TOKEN_REFRESH_EARLY_MS - 1000; // 54 min later: still good
    await c.post("/x", {});
    expect(c.stats.tokenMints).toBe(1);
    t += 2000; // inside the 5-minute window
    await c.post("/x", {});
    expect(c.stats.tokenMints).toBe(2);
    expect(count("/x")).toBe(3);
  });

  it("concurrent callers share one mint", async () => {
    routes["/x"] = () => json(200, { ok: true });
    const c = new RouteStackClient({ apiKey: "pk_test", apiSecret: "sk_test", baseUrl: BASE, timeoutMs: 1000, searchTimeoutMs: 1000 });
    await Promise.all([c.post("/x", {}), c.post("/x", {}), c.post("/x", {})]);
    expect(count("/mcp/auth/partner-token")).toBe(1);
  });

  it("a 401 mints a new token and retries once; a second 401 gives up (null to the caller)", async () => {
    let n = 0;
    routes["/mcp/hotel/search-hotels"] = () => (++n === 1 ? json(401, { message: "jwt expired" }) : json(200, HOTELS));
    const got = await liveHotels(LISBON);
    expect(got?.length).toBeGreaterThan(0);
    expect(count("/mcp/auth/partner-token")).toBe(2);
    expect(count("/mcp/hotel/search-hotels")).toBe(2);
    const [a, b] = calls.filter((c) => c.path === "/mcp/hotel/search-hotels").map((c) => c.auth);
    expect(a).not.toBe(b);

    resetRouteStackClient();
    calls = [];
    routes["/mcp/hotel/search-hotels"] = () => json(401, {});
    expect(await liveHotels({ ...LISBON, guests: 4 })).toBeNull();
    expect(count("/mcp/hotel/search-hotels")).toBe(2);
    expect(routestackStatus().lastError?.code).toBe("UNAUTHORIZED");
  });

  it("a refused mint (bad keys) → null, no search", async () => {
    routes["/mcp/auth/partner-token"] = () => json(401, { message: "invalid hmac" });
    expect(await liveFlights(ATL_LIS)).toBeNull();
    expect(count("/mcp/flight/search")).toBe(0);
  });
});

describe("config: off unless keys are present", () => {
  it("no keys or ROUTESTACK_MODE=off → null without a single request", async () => {
    process.env.ROUTESTACK_API_SECRET = "";
    expect(config.routestack.mode()).toBe("off");
    expect(await liveHotels(LISBON)).toBeNull();
    process.env.ROUTESTACK_API_SECRET = "sk_test";
    process.env.ROUTESTACK_MODE = "off";
    expect(await liveFlights(ATL_LIS)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(routestackStatus()).toMatchObject({ enabled: false, mode: "off" });
  });

  it("keys → sandbox by default; base URL defaults follow the mode", () => {
    expect(config.routestack.mode()).toBe("sandbox");
    delete process.env.ROUTESTACK_BASE_URL;
    expect(config.routestack.baseUrl()).toBe("https://evolvemcp.routestack.ai");
    process.env.ROUTESTACK_MODE = "live";
    expect(config.routestack.baseUrl()).toBe("https://mcp.routestack.ai");
    const s = routestackStatus();
    expect(s).toMatchObject({ enabled: true, mode: "live", host: "mcp.routestack.ai", keys: true });
    expect(JSON.stringify(s)).not.toContain("sk_test");
    expect(JSON.stringify(s)).not.toContain("pk_test");
  });

  it("bad input → null (no billable call)", async () => {
    expect(await liveHotels({ ...LISBON, checkOut: "2027-03-10" })).toBeNull();
    expect(await liveFlights({ ...ATL_LIS, origin: "Atlanta" })).toBeNull();
    expect(count("/mcp/hotel/search-hotels") + count("/mcp/flight/search")).toBe(0);
  });
});

describe("requests follow the documented endpoints", () => {
  it("hotels: search-destinations then search-hotels with destinationId, lat/long, rooms, roomCount, USD", async () => {
    await liveHotels(LISBON);
    expect(calls.find((c) => c.path === "/mcp/hotel/search-destinations")?.body).toEqual({ query: "Lisbon", type: "DESTINATION" });
    expect(calls.find((c) => c.path === "/mcp/hotel/search-hotels")?.body).toEqual({
      destinationId: "2427", destinationType: "City", lat: 38.7223, long: -9.1393, checkIn: "2027-03-12", checkOut: "2027-03-16",
      roomCount: 1, rooms: [{ adults: 3, children: 0, childAges: [] }], currency: "USD",
    });
  });

  it("flights: session, then search with sessionId, IATA codes, dates, adults, Economy, RoundTrip", async () => {
    await liveFlights(ATL_LIS);
    expect(count("/mcp/flight/session")).toBe(1);
    expect(calls.find((c) => c.path === "/mcp/flight/search")?.body).toEqual({
      sessionId: "722243C3-FBF3-1910", tripType: "RoundTrip", type: "RoundTrip", origin: "ATL", destination: "LIS",
      departureDate: "2027-03-12", returnDate: "2027-03-16", adults: 3, children: 0, infants: 0, cabinClass: "Economy", currency: "USD",
    });
  });
});

describe("cache: the same search never bills twice", () => {
  it("a repeat is served from memory, and after a restart from DATA_DIR/routestack", async () => {
    const a = await liveHotels(LISBON);
    const b = await liveHotels(LISBON);
    expect(b).toEqual(a);
    expect(count("/mcp/hotel/search-hotels")).toBe(1);
    const dir = join(config.dataDir, "routestack");
    expect(existsSync(dir) && readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBeGreaterThanOrEqual(2);

    resetRouteStackClient(); // like a restart: memory gone, disk stays
    expect(await liveHotels(LISBON)).toEqual(a);
    expect(count("/mcp/hotel/search-hotels")).toBe(1);
    expect(count("/mcp/hotel/search-destinations")).toBe(1);

    await liveFlights(ATL_LIS);
    await liveFlights({ ...ATL_LIS, origin: "atl" }); // same query, different spelling
    expect(count("/mcp/flight/search")).toBe(1);
    await liveFlights({ ...ATL_LIS, depart: "2027-03-13" });
    expect(count("/mcp/flight/search")).toBe(2);
  });

  it("concurrent identical searches share one call", async () => {
    await Promise.all([liveFlights(ATL_LIS), liveFlights(ATL_LIS), liveFlights(ATL_LIS)]);
    expect(count("/mcp/flight/search")).toBe(1);
  });

  it("an empty answer (code 204) is cached too; errors are not", async () => {
    routes["/mcp/hotel/search-hotels"] = () => json(200, { success: false, message: null, code: 204, result: null });
    expect(await liveHotels(LISBON)).toEqual([]);
    expect(await liveHotels(LISBON)).toEqual([]);
    expect(count("/mcp/hotel/search-hotels")).toBe(1);

    routes["/mcp/flight/search"] = () => json(500, { message: "boom" });
    expect(await liveFlights(ATL_LIS)).toBeNull();
    routes["/mcp/flight/search"] = () => json(200, FLIGHTS);
    expect((await liveFlights(ATL_LIS))?.length).toBeGreaterThan(0);
    expect(count("/mcp/flight/search")).toBe(2);
  });
});

describe("spend caps (util/limits spend('routestack'))", () => {
  it("a daily cap of 0 → null, and nothing billable is sent", async () => {
    config.limits.spend.daily.routestack = 0;
    expect(await liveHotels(LISBON)).toBeNull();
    expect(await liveFlights(ATL_LIS)).toBeNull();
    expect(count("/mcp/hotel/search-hotels") + count("/mcp/flight/search")).toBe(0);
    expect(routestackStatus()).toMatchObject({ budget: "capped", lastError: { code: "CAP_REACHED" } });
  });

  it("the per-voyage cap stops a voyage's new searches; cached ones still answer", async () => {
    config.limits.spend.trip.routestack = 1;
    expect(await liveFlights({ ...ATL_LIS, tripId: "T1" })).not.toBeNull();
    expect(await liveFlights({ ...ATL_LIS, origin: "JFK", tripId: "T1" })).toBeNull();
    expect(await liveFlights({ ...ATL_LIS, tripId: "T1" })).not.toBeNull(); // cache hit, no spend
    expect(await liveFlights({ ...ATL_LIS, origin: "JFK", tripId: "T2" })).not.toBeNull();
    expect(count("/mcp/flight/search")).toBe(2);
  });
});

describe("timeouts → null", () => {
  const hang = (_b: unknown, _h: unknown) => new Promise<Response>(() => undefined);

  it("a search slower than ROUTESTACK_SEARCH_TIMEOUT_MS → null, and the same search isn't re-sent right away", async () => {
    process.env.ROUTESTACK_SEARCH_TIMEOUT_MS = "40";
    routes["/mcp/flight/search"] = hang;
    const t0 = Date.now();
    expect(await liveFlights(ATL_LIS)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(routestackStatus().lastError?.code).toBe("TIMEOUT");
    routes["/mcp/flight/search"] = () => json(200, FLIGHTS);
    expect(await liveFlights(ATL_LIS)).toBeNull(); // cooldown: a timed-out search was probably billed
    expect(count("/mcp/flight/search")).toBe(1);
  });

  it("a hung token mint → null", async () => {
    process.env.ROUTESTACK_TIMEOUT_MS = "40";
    routes["/mcp/auth/partner-token"] = hang;
    expect(await liveHotels(LISBON)).toBeNull();
  });

  it("the fetch is aborted when the timeout fires", async () => {
    process.env.ROUTESTACK_SEARCH_TIMEOUT_MS = "30";
    let aborted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/partner-token")) return json(200, { token: jwt(Math.floor(Date.now() / 1000) + 3600) });
      if (String(url).endsWith("/session")) return json(200, { sessionId: "S" });
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }));
    }));
    expect(await liveFlights(ATL_LIS)).toBeNull();
    expect(aborted).toBe(true);
  });
});

describe("normalization", () => {
  it("hotels: ids, nightly group price in USD cents, stay types, ratings, approximate location", async () => {
    const got = (await liveHotels(LISBON))!;
    expect(got.map((h) => h._id)).toEqual(["RS-h-5550002", "RS-h-41393487", "RS-h-5550001"]); // cheapest first; unpriced dropped
    const ibis = got.find((h) => h._id === "RS-h-41393487")!;
    expect(ibis).toMatchObject({
      kind: "hotel", cityId: "LIS", name: "ibis Styles Lisboa Centro", neighborhood: "", stayType: "hotel",
      nightlyCents: 22000, // €800 whole stay × 1.10 = $880 / 4 nights
      sleeps: 3, rating: 3, source: "routestack", bookingRef: "hotel:41393487", approxLocation: true, freeCancellation: false,
    });
    const km = Math.hypot((ibis.lat - LISBON.lat) * 111.32, (ibis.lng - LISBON.lng) * 111.32 * Math.cos((LISBON.lat * Math.PI) / 180));
    expect(km).toBeGreaterThan(1.8);
    expect(km).toBeLessThan(2.1);
    expect(got.find((h) => h._id === "RS-h-5550001")).toMatchObject({ stayType: "apartment", rating: 4.6, nightlyCents: 27500 });
    expect(got.find((h) => h._id === "RS-h-5550002")).toMatchObject({ stayType: "hostel", rating: 4.1 });
  });

  it("hotels: the documented un-wrapped page shape works too", () => {
    const page = { ...HOTELS.result[0], currency: "USD" };
    const got = normalizeHotels({ success: true, result: page }, { cityId: "LIS", lat: 38.72, lng: -9.14, checkIn: "2027-03-12", checkOut: "2027-03-14", guests: 4 });
    expect(got.find((h) => h._id === "RS-h-41393487")).toMatchObject({ nightlyCents: 40000, sleeps: 4 });
  });

  it("the rooming rule: ≤3 guests one room, 4+ in rooms of two", () => {
    expect(roomsFor(2).map((r) => r.adults)).toEqual([2]);
    expect(roomsFor(3).map((r) => r.adults)).toEqual([3]);
    expect(roomsFor(4).map((r) => r.adults)).toEqual([2, 2]);
    expect(roomsFor(5).map((r) => r.adults)).toEqual([2, 2, 1]);
    expect(roomsFor(12).map((r) => r.adults)).toEqual([2, 2, 2, 2, 2, 2]); // a full crew (MAX_CREW)
    expect(roomsFor(40)).toHaveLength(6);
    expect(nightsBetween("2027-03-12", "2027-03-16")).toBe(4);
  });

  it("stay types from the name", () => {
    expect(stayTypeOf({ name: "Casa do Bairro" })).toBe("guesthouse");
    expect(stayTypeOf({ name: "Generator Barcelona" })).toBe("hostel");
    expect(stayTypeOf({ name: "Lisbon Loft Flats" })).toBe("apartment");
    expect(stayTypeOf({ name: "Hotel Avenida Palace" })).toBe("hotel");
  });

  it("currency: USD cents via the static FX table; unknown currencies are dropped", () => {
    expect(toUsdCents(100, "USD")).toBe(10000);
    expect(toUsdCents(100, "eur")).toBe(11000);
    expect(toUsdCents(100, "XXX")).toBeNull();
    expect(toUsdCents(0, "USD")).toBeNull();
  });

  it("flights: per-person USD cents, outbound/return from legindicator, stops, via, red-eye, one per departure", async () => {
    const got = (await liveFlights(ATL_LIS))!;
    expect(got).toHaveLength(2); // the two Delta fare families collapse to the cheaper; the broken itinerary is dropped
    expect(got[0]).toMatchObject({
      kind: "flight", cityId: "LIS", origin: "ATL", dateWindowId: "W1", airline: "United (via EWR)",
      departLocal: "2027-03-12T13:05", arriveLocal: "2027-03-13T08:30", returnLocal: "2027-03-16T13:10",
      stops: 1, redEye: true, priceCents: 61500, source: "routestack", bookingRef: "fare:FSC-via",
    });
    expect(got[0]._id).toMatch(/^RS-f-LIS-ATL-W1-[0-9a-f]{10}$/);
    expect(got[1]).toMatchObject({ airline: "Delta", stops: 0, priceCents: 69000, departLocal: "2027-03-12T18:10", returnLocal: "2027-03-16T12:40" });
    for (const f of got) for (const t of [f.departLocal, f.arriveLocal, f.returnLocal]) expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("flights: a non-USD answer is converted; one-way keeps the return date's noon", () => {
    const got = normalizeFlights({ ...FLIGHTS, currency: "EUR", result: [FLIGHTS.result[0]] }, { cityId: "LIS", origin: "ATL", destinationIata: "LIS", dateWindowId: "W1", depart: "2027-03-12", return: "2027-03-16" });
    expect(got[0].priceCents).toBe(78364); // 712.40 × 1.10
    const oneWay = normalizeFlights({ result: [{ ...FLIGHTS.result[0], flights: [FLIGHTS.result[0].flights[0]] }] }, { cityId: "LIS", origin: "ATL", destinationIata: "LIS", dateWindowId: "W1", depart: "2027-03-12", return: "2027-03-16" });
    expect(oneWay[0].returnLocal).toBe("2027-03-16T12:00");
  });

  it("red-eye rule", () => {
    expect(isRedEye("2027-03-12T09:40", "2027-03-12T11:25")).toBe(false);
    expect(isRedEye("2027-03-12T22:10", "2027-03-12T23:55")).toBe(true);
    expect(isRedEye("2027-03-12T13:05", "2027-03-13T08:30")).toBe(true);
  });
});
