# 12 — RouteStack.ai live inventory

**Status:** the provider is built and tested (`apps/server/src/providers/routestack/`, `apps/server/test/routestack.test.ts`). It is **not wired into the engine yet**: nothing calls it until the chart book does (see *Wiring plan*). With no keys it is off, and every function returns `null`.

## What it does

RouteStack.ai is a travel-inventory gateway ("MCP server") over the Alpha/CTS hotel, flight and car APIs. It serves both MCP JSON-RPC (`POST /mcp`, tools such as `hotel_search`) and plain **HTTP skill endpoints** under `/mcp/*`. We use the HTTP endpoints, which are simpler and billed the same way.

The provider gives the engine three calls:

| Export | Returns | Notes |
|---|---|---|
| `liveHotels({cityName, cityId?, lat, lng, checkIn, checkOut, guests, tripId?, max?})` | `LiveHotelOption[] \| null` | Cheapest first, at most 20. Each is a `HotelOption` plus `source:"routestack"`, `bookingRef`, `approxLocation`, `imageUrl?`, `freeCancellation?` |
| `liveFlights({origin, destinationIata, depart, return?, adults, cityId?, dateWindowId?, tripId?, max?})` | `LiveFlightOption[] \| null` | Cheapest first, at most 15, one per (airline, departure). Each is a `FlightOption` plus `source:"routestack"`, `bookingRef`, `currency:"USD"` |
| `routestackStatus()` | `{enabled, mode, host, keys, accountId, budget, cache, calls, lastOkAt, lastError}` | Contains no secrets. `/api/health` (dev detail) shows `routestack: enabled` |

**`null` means "use your fallback."** The calls never throw. They return `null` when RouteStack is off, the keys are missing, the input is bad, the token mint fails, a call times out, the spend cap is reached, a recent identical search timed out, or there is an HTTP error or an odd payload. An **empty array** means the search ran and found nothing. That answer was billed, so it is cached.

RouteStack has **no activities or rentals vertical**: it covers hotels, flights and cars only, and "rentals" means cars. So there is no `activities.ts`, and activities stay curated. Cars are not used, because a crew's plan has no car line.

## API facts (researched 2026-09-26)

Sources:
- the live gateway docs: `https://mcp.routestack.ai/mcp/docs/{openapi.yaml, SKILLS.md, capabilities.json, EXTERNAL_MCP_INTEGRATION.md, FLIGHT_SEARCH_FIELDS.md, AUTH_AND_DEVELOPER_USAGE.md, QUOTA.md}`. The sandbox `openapi.yaml` is byte-identical.
- github.com/mtorazzi/routestack-web: recorded payload fixtures and the timeout and billing rules.
- github.com/RouteStackAI/routestack-starters: MCP clients using the partner-token flow; `evolvemcp` *requires* it.
- two hackathon clients that call the HTTP endpoints: github.com/StijnRis/match-route (with an OpenAPI copy) and github.com/aperswal/motus.

`www.routestack.ai/docs` is a JavaScript single-page app, so WebFetch sees only its title. The gateway's own `/mcp/docs/*` is the authoritative source.

### Hosts
| | Base URL |
|---|---|
| Production | `https://mcp.routestack.ai` |
| Sandbox | `https://evolvemcp.routestack.ai` (tokens are limited; same API) |

### Auth — `POST /mcp/auth/partner-token` (free)
```
timestamp = unix seconds (must be within ~5 min of server time)
nonce     = random string (we use a UUID)
hmac      = base64url( HMAC_SHA256(key = apiSecret, msg = `${apiKey}:${timestamp}:${nonce}`) )
body      = { apiKey, hmac, timestamp, nonce }
→ 200 { token: "<JWT>", expiresIn: "24h" }
```
- The JWT payload is `{accountId, iat, exp, iss:"cts-partner"}`. `expiresIn` follows the server's `PARTNER_TOKEN_EXPIRES_IN`. The docs say both "default 24h" and "default 1h", so we read `exp` from the JWT, then fall back to `expiresIn`, then to 1 hour.
- There is **no refresh endpoint.** You mint again before expiry or after a 401. Every other call sends **only** `Authorization: Bearer <JWT>`: no `x-api-key`, no `x-secret`, no `X-Correlation-Id`. The account id comes from the token, so `ROUTESTACK_ACCOUNT_ID` is informational. The alternative header mode (`X-Api-Key` + `X-Account-Id`) is not used.
- Errors: 401 means bad or expired credentials. 402 means the quota is exhausted. 503 means partner tokens aren't configured on that server.

### Hotels
1. `POST /mcp/hotel/search-destinations` (free). Send `{query:"Lisbon", type:"DESTINATION"}` (`type` can also be `HOTEL`). The response is `{success, code, message, result:[{id, type:"City"|"State"|"Airport"|…, fullName, country, coordinates:{lat, long}, referenceId, city}]}`.
2. `POST /mcp/hotel/search-hotels` (**billable**). The body is:
   ```
   {destinationId, destinationType, lat, long, checkIn:"YYYY-MM-DD", checkOut,
    roomCount, rooms:[{adults, children, childAges:[]}], currency:"USD",
    // paging: nextResultsKey + the same correlationId + token (each page is billed again); also page, limit
   }
   ```
   `roomCount` is required and must equal `rooms.length`.

   The response is `{success, code, message, result: page}`. Live responses have wrapped the page in a one-item array. The page is `{status:"InProgress"|"Complete", count, currency, token, correlationId, nextResultsKey, result:[hotel]}`, and each hotel is:
   `{id, name, providerName, chain, starRating, ourprice, publishedRate, baseprice, saving, savingratio, distance (mi), distancekm, heroImage, facilities[], mainamenity, options:{freeCancellation, refundable, freeBreakfast, …}, contact:{address:{line1, city:{name}, country:{code,name}}}, reviews:{rating,count}|null, payAtHotel, ratetype}`.

   **The list gives no coordinates and no neighbourhood.** No results comes back as `{success:false, code:204, result:null}`.

   **Price:** `ourprice` is the price for the **whole stay and the whole occupancy** sent. The recorded Rome example is 5 nights for 2 adults at €634 for an ibis Styles, which works out to about €127 a night.
3. The follow-ups are all free and not used yet. `get-hotel-details-and-rates`, **or** `get-hotel-details` + `get-rooms-and-rates` (never both), take `{hotelId, token, correlationId, checkIn, checkOut, rooms}`. The rooms come back in `groups[].rooms[]` with `recommendationId`, `ourprice`, `occupancies`, `maxGuestAllowed`. Then `revalidate` `{hotelId, recommendationId, token}`, then `get-payment-url`, which returns `{success, checkoutMode:"deeplink", url}` or an ACP session. `correlationId` + `token` from the search must be reused on every follow-up. They expire after about 2 hours.

### Flights
1. `POST /mcp/flight/session` (free). Send `{}`; the response is `{success, sessionId}`. The docs say search "may require" it, so we get one on each real search.
2. `POST /mcp/flight/locations` (free). Send `{term}`; the response is `{result:[{code, name, city, country, fullname}]}`. We don't need it, because our origins and ports are already IATA codes.
3. `POST /mcp/flight/search` (**billable**). The body is free-form (`Record<string, unknown>`) in the schema. What we send matches routestack-web's tool arguments and the hackathon clients:
   ```
   {sessionId, tripType:"RoundTrip"|"OneWay", type:<same>, origin:"ATL", destination:"LIS",
    departureDate:"YYYY-MM-DD", returnDate?, adults, children:0, infants:0, cabinClass:"Economy", currency:"USD"}
   ```
   Multi-city uses `destinations:[{origin, destination, departureDate}]`.

   The response is `{success, code, message, count, currency, currencyrate, searchFilterObj (string — pass to revalidate/payment), filters, correlationId, alphaSessionId, result:[itinerary]}`. Each itinerary is:
   `{fareSourceCode, stops, flights:[segment], baseFare, totalFare, taxes, ourprice, showOurprice, paxType:"ADT", quantity, penaltydetails, …}`.
   Each segment is `{airline, flightCode, flightNumber, departure, arrival (IATA), departureTime, arrivalTime ("2027-08-20T14:55:00", local), triptime (min), stops, cabin, fareFamily, legindicator (0 = outbound, 1 = return), checkInBaggage, cabinBaggage, remainingSeats}`.

   An error looks like `{success:false, code:"6010", message:"departure date should not be empty", result:null}`.
4. The follow-ups are free: `revalidate` `{fareSourceCode, searchFilterObj, searchListPrice}` and `get-payment-url` `{origin, destination, departureDate, adults, flight, …}`.

### Billing, timeouts, errors
- **Only three calls are billable:** `hotel/search-hotels` (every page), `flight/search` and `car/search`. Token, destinations, locations, session, details, rooms, revalidate and payment URL are all free. A 402 means the quota is spent.
- routestack-web uses a 60 s general timeout and a 180 s search timeout. A timed-out search is **never retried**, because it was probably billed.
- Pagination: hotels use `nextResultsKey`, and each page is billed. Flights come back as one list, with `count` and up to hundreds of fares. We take the **first hotel page only**.
- Currency: request with `currency:"USD"`. The response echoes `currency` on the hotel page or at the top level for flights.

## How the provider works

| File | Role |
|---|---|
| `client.ts` | `signPartnerHmac`, `RouteStackClient`, `configuredClient()`, the query cache (`cached`), `billable` (cooldown + spend), and `guard` (never throw) |
| `hotels.ts` | `liveHotels`: resolves the destination (cached 30 days), runs one billable search, and slims the page before caching |
| `flights.ts` | `liveFlights`: gets a session (free), runs one billable search, and slims the response |
| `normalize.ts` | Pure mapping to `HotelOption` / `FlightOption`, plus the FX table |
| `index.ts` | Public exports and `routestackStatus()` |

- **Token:** cached in memory and minted again **5 minutes before `exp`**. Concurrent callers share one mint. On a **401** the client mints once more and **retries the call once**; a second 401 returns `null`.
- **Timeouts:** billable searches use `ROUTESTACK_SEARCH_TIMEOUT_MS`, default **90 s** because a phone shouldn't wait RouteStack's full 180 s. Other calls use `ROUTESTACK_TIMEOUT_MS`, default 30 s. On a timeout the fetch is aborted and the call returns `null`. That exact search is then not sent again for **10 minutes**, because it was very likely billed.
- **Cache:** the key is the SHA-256 of `[endpoint, baseUrl, normalized request body]`. Entries live in memory (an LRU of 500) and on disk at `DATA_DIR/routestack/<sha>.json`, so they survive restarts. The TTL is **6 h** (`ROUTESTACK_CACHE_HOURS`); destination lookups last 30 days. Concurrent identical searches share one in-flight call. Empty answers are cached; errors are not. A cached answer spends nothing.
- **Spend cap:** each billable search on a cache miss calls `spend("routestack", tripId)` from `util/limits.ts`. The limits are `ROUTESTACK_DAILY_CAP` (default **200** a day, server-wide) and `ROUTESTACK_TRIP_CAP` (default **20** per voyage). The usual reserve applies: the last `SPEND_RESERVE_PCT` (20 %) of the daily cap is kept for voyages past the table. Counters are stored in Mongo's `spend` collection when Mongo is up. `/api/health` (dev) shows `budgets.routestack`: `ok`, `reserve` or `capped`.
- **Costs:** a voyage with 4 ports × 2 windows costs 8 hotel searches. Flights cost one search per (port × window × distinct member origin); 3 origins make 24. That's 32 in total, which is more than the trip cap of 20. So the wiring below searches only the shortlisted ports: 2 ports × 1 window × (1 hotel + 3 origins) = 8. The rest come from the cache.

### Normalization rules
- **Hotels:** `_id = "RS-h-<id>"`, `kind:"hotel"`, `neighborhood:""` (the list has no area field).
  - **Rooming rule:** 1–3 guests are searched as one room (3 = a triple, so only properties that sleep 3 in one unit come back). 4 or more are searched as rooms of two (4 → 2×2, 5 → 2+2+1). RouteStack prices that whole occupancy for the whole stay, so `nightlyCents = USD(ourprice) / nights` is the **group's** nightly cost, and `sleeps = guests`. A hotel without a price is dropped.
  - **`stayType`** comes from the name or chain, because the list has no type field:
    - hostel / backpacker / dorm → `hostel`
    - apartment / flat / residence / loft / studio / villa → `apartment`
    - guest house / B&B / pension / pousada / casa / inn / lodge → `guesthouse`
    - anything else → `hotel`
  - **`rating`** (0–5) is the guest review score when present (a 10-point score is halved), else the star rating.
  - **`lat`/`lng`:** the list gives only `distancekm` from the search centre. The hotel is placed that far from the city centre on a bearing fixed by a hash of its id, and flagged `approxLocation:true`. This is good enough for "near the centre?" ranking, **not** for walking routes. A later step can call the free `get-hotel-details` for the chosen hotel.
- **Flights:** `_id = "RS-f-<cityId>-<origin>-<windowId>-<hash(fareSourceCode)>"`.
  - The outbound segments are those with `legindicator 0` and the return segments those with `1`. `departLocal` is the first outbound departure, `arriveLocal` the last outbound arrival, and `returnLocal` the first return departure. For a one-way search, `returnLocal` is the return date at 12:00. Times are trimmed to `YYYY-MM-DDTHH:MM`, the dataset's format.
  - `stops` is the larger leg's connections plus any segment `stops`, clamped to 0–2.
  - `airline` is the outbound carriers plus `(via EWR, …)`.
  - `redEye` is true when the flight departs 21:00–04:59 or lands on a later calendar day.
  - **`priceCents` is per person:** `showOurprice ?? ourprice ?? totalFare`. Alpha prices each itinerary per passenger type (`paxType:"ADT"`, `quantity` = travellers), which matches `FlightOption.priceCents` being per member. ⚠️ Verify this on the first live smoke with `adults: 3`: if the price is 3× the `adults: 1` price, divide by `quantity`.
  - Duplicate fare families of the same flight collapse to the cheapest.
- **Currency:** we always ask for USD. Anything else is converted with the static `FX_TO_USD` table in `normalize.ts` (September 2026 ballpark rates; an estimate for ranking, not a quote, since checkout re-prices). An unknown currency drops the option. Prices are stored as integer cents.

## Keys: sandbox vs live
1. In the RouteStack dashboard, create a partner key. Copy the **API key** and **API secret**; the account id is optional.
2. Add them to `.env`, which is never committed:
   ```
   ROUTESTACK_API_KEY=…
   ROUTESTACK_API_SECRET=…
   # ROUTESTACK_MODE=sandbox   (default once both keys are set)
   ```
   Sandbox uses `https://evolvemcp.routestack.ai`, whose tokens are limited. Keep the caps low there.
3. To go live, set `ROUTESTACK_MODE=live`. That makes the base URL `https://mcp.routestack.ai` unless `ROUTESTACK_BASE_URL` overrides it. Raise `ROUTESTACK_DAILY_CAP` to match the plan's quota.
4. `ROUTESTACK_MODE=off` is the kill switch; so is `ROUTESTACK_DAILY_CAP=0`.
5. Check the setup with `GET /api/health` and `X-Dev-Key`: look for `routestack: true` and `budgets.routestack`.

Tests blank both keys (`test/setup/isolate.ts`) and stub `fetch`, so the suite never reaches RouteStack.

## Wiring plan (for the engine owners — not done here)

The engine files (`data/loader.ts`, `fit/**`, `trips/**`) are being edited by others, so this is the plan only.

1. **When:** as soon as a voyage's ports and windows are known, meaning the chart book or prerank has chosen the shortlist (the 2–4 ports) and the crew's date windows. In `trips/table.ts` or `trips/course.ts`, fire a **background prefetch** that nobody awaits (`void prefetchLive(trip)`), wrapped in `withTrip(trip._id, …)` so spend is counted per voyage:
   - For each shortlisted `city × window`, call `liveHotels({cityName: city.name, cityId: city._id, lat: city.lat, lng: city.lng, checkIn: window.start, checkOut: window.end, guests: crew.length})`.
   - For each `city × window × distinct member origin` (not the home port), call `liveFlights({origin, destinationIata: city.airport.code, depart: window.start, return: window.end, adults: <members from that origin>, cityId, dateWindowId: window.id})`.
   - Run at most 4 at a time; each result lands in the 6-hour cache.
2. **Where results live:** keep a per-voyage `live` map keyed by `city|window|origin` (flights) and `city|window` (hotels), in `trips/records.ts` or next to the voyage state. Don't put it in the shared `Dataset` (`loadDataset()` is global and cached per `datasetRev`). One more option: in `fit/flights.ts` `flightsFor`, merge in the order **live, then curated, then modelled**. Pass live options through a `LiveInventory` argument or a per-voyage overlay dataset, `{...ds, flights: [...liveFlights, ...ds.flights], hotels: [...liveHotels, ...ds.hotels]}`, built once per table run so the pricing code stays pure.
3. **Preference:** when live options exist for a `city × window`, the pricing (`fit/pricing.ts` `buildPlan`, and the hotel choice loop) should consider them first, but still apply the same dealbreakers and fit rules (`stayType === "hostel"`, stops, red-eye). A live hotel's `nightlyCents` is already the group's nightly cost (see the rooming rule), the same meaning as the curated hotels. If a live flight list comes back empty, or has no option within the rules, fall back to curated or modelled for that member only.
4. **Labels:** each plan gets `priceSource: "live" | "estimated"`. It is "live" only when its hotel and **every** member flight came from RouteStack (`source === "routestack"`); a mix shows "Estimated". The phone shows a **"Live prices"** chip with the fetch time, or **"Estimated"** otherwise. Modelled flights already carry `modelled: true`.
5. **Timing:** the table must never wait on RouteStack. If the prefetch hasn't landed when a plan is priced, price it as estimated. When results arrive, re-price in the background and push the update with the existing plan-update event, or apply them at the next table step. Searches in the prefetch take up to 90 s each.
6. **Booking:** the Visa payment stays **simulated** (`PAYMENTS_MODE=sim`). `bookingRef` (`hotel:<id>` / `fare:<fareSourceCode>`) is kept only for a later "open on RouteStack" deep link, via the free `get-payment-url`. We never book or charge through RouteStack.
7. **Budget math:** with the default trip cap of 20, prefetch only the top 2 ports × the crew's chosen window: 2 hotel searches + 2 × origins flight searches. Fetch other ports only when a crew member opens them. The cache and in-flight dedupe keep re-renders free.

## Live smoke

Not run: `.env` has no `ROUTESTACK_API_KEY` or `ROUTESTACK_API_SECRET`. Once the keys are set, run one sandbox hotel search (Lisbon, 2027-03-12 → 2027-03-16, 3 guests) and one flight search (ATL → LIS, same dates, 3 adults) through `liveHotels` / `liveFlights`. Then check the per-person flight price (see ⚠️ above) and whether the hotel page is wrapped in an array.
