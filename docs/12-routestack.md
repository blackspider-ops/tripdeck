# 12 — RouteStack.ai live inventory

**Status:** the provider is built, tested (`apps/server/test/routestack.test.ts`) and **wired into trip planning** (`apps/server/src/trips/live.ts`, `apps/server/src/fit/live.ts`, `apps/server/test/live-prices.test.ts`; see *Wiring*). It has been run against the sandbox (see *Live smoke*). With no keys, or `ROUTESTACK_MODE=off`, it is off: every function returns `null` and nothing is prefetched.

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
  - **Rooming rule:** 1–3 guests are searched as one room (3 = a triple, so only properties that sleep 3 in one unit come back). 4 or more are searched as rooms of two (4 → 2×2, 5 → 2+2+1, up to a full crew of 12 → 6 rooms). RouteStack prices that whole occupancy for the whole stay, so `nightlyCents = USD(ourprice) / nights` is the **group's** nightly cost, and `sleeps = guests`. A hotel without a price is dropped.
  - **`stayType`** comes from the name or chain, because the list has no type field:
    - hostel / backpacker / dorm → `hostel`
    - apartment / flat / residence / loft / studio / villa → `apartment`
    - guest house / B&B / pension / pousada / casa / inn / lodge → `guesthouse`
    - anything else → `hotel`
  - **`rating`** is a review-style 0–5 score, like the curated stays' 3.8–4.8. It is `reviews.rating` when present, normalized: a 10-point score is halved, a 100-point one divided by 20. The sandbox sends `reviews: null`, so the fallback derives it from the star class, which is not a review score: `3.5 + 0.25 × stars`, at most 4.8 (1★ → 3.8, 2★ → 4.0, 3★ → 4.3, 5★ → 4.8), or 3.5 with no stars. The star class is kept separately as `stars`, and the list's distance as `distanceKm`.
  - **`lat`/`lng`:** the list gives only `distancekm` from the search centre. The hotel is placed that far from the city centre on a bearing fixed by a hash of its id, and flagged `approxLocation:true`. This is good enough for "near the centre?" ranking, **not** for walking routes. A later step can call the free `get-hotel-details` for the chosen hotel.
- **Flights:** `_id = "RS-f-<cityId>-<origin>-<windowId>-<hash(fareSourceCode)>"`.
  - The outbound segments are those with `legindicator 0` and the return segments those with `1`. `departLocal` is the first outbound departure, `arriveLocal` the last outbound arrival, and `returnLocal` the first return departure. For a one-way search, `returnLocal` is the return date at 12:00. Times are trimmed to `YYYY-MM-DDTHH:MM`, the dataset's format.
  - `stops` is the larger leg's connections plus any segment `stops`, clamped to 0–2.
  - `airline` is the outbound carriers plus `(via EWR, …)`.
  - `redEye` is true when the flight departs 21:00–04:59 or lands on a later calendar day.
  - **The fare is for the whole party; `priceCents` is per person.** The fare is `showOurprice ?? ourprice ?? totalFare`. It covers every traveller searched: verified on the sandbox on 2026-09-26 for ATL→LIS, 12–16 Mar 2027. The same United itinerary via EWR came back at **$861.38 with `adults: 1`** (`quantity: 1`) and **$2,584.14 with `adults: 3`** (`quantity: 3`), exactly 3×. `perPersonFare` divides by `quantity`, or by the adults searched when `quantity` is missing, so `priceCents` is per member, which is what `FlightOption.priceCents` means.
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

## Wiring (implemented)

| File | Role |
|---|---|
| `trips/live.ts` | `LivePrices`: the background prefetch, per voyage, under `withTrip`; the swappable `provider` (tests use a fake) |
| `fit/live.ts` | The per-voyage `LiveInventory` overlay, `liveStaysFor`, `liveFaresFor`, and the public **live fare band** |
| `fit/pricing.ts` | `buildChartBook` / `buildPlan` / `chooseFlight` take the overlay; plans carry `priceSource`, `priceFeed`, `liveBand` and `stay` |
| `trips/table.ts` | The chart book is built with the overlay. `repriceLive` runs before the Dry Run. `onDecided` pins the decided plans |
| `trips/crew.ts` | Starts the prefetch when the last terms seal, for named ports with at least 2 crew |

1. **When.** The prefetch starts as soon as the ports and windows are fixed. For named ports, that is when the last member seals their terms (at least 2 crew). On a date-range voyage (doc 04 §4.12) the helm generates the windows from everyone's availability at that same moment, and the searches use **those windows' exact dates** (check-in / depart = the window's first day, check-out / return = its last); a reseal that changes them just fetches the new dates. For regions or anywhere, it is when the table starts, after the pre-rank. The table start runs it again in every case, but it skips searches that already landed, are in flight, or fell back less than 10 minutes ago. Nothing awaits it.
   - **Stays:** one search per port × window, with `guests` = the crew size. The provider's rooming rule applies: rooms of two from 4 guests up.
   - **Fares:** one search per port × window × distinct home airport, with `adults` = the members flying from that airport. Home ports are skipped. So are windows more than `FLIGHT_HORIZON_DAYS` (330) days out: the sandbox refused every search 377 days out (`TOOL_ERROR`, see *Live smoke*), because airlines open sales about 330 days ahead.
   - **Limits:** at most 4 searches run at once. The full set is planned against what is left of the voyage cap (`ROUTESTACK_TRIP_CAP` minus what the voyage has spent). If the full set doesn't fit, only the **top 2 ranked ports** (`rankPorts`) × the crew's **common window** are fetched, trimmed to what's left. A search that fell back (`null`) isn't repeated for the voyage for 10 minutes, because a refused search may have been billed.
   - **Off:** there is no prefetch when `ROUTESTACK_MODE=off` or no keys are set. The Expo seed is marked `curatedOnly`, so it keeps its curated flights and stays exactly.
2. **Where results live.** `helm.liveInventory` holds a per-voyage `LiveInventory`. Stays are keyed `city|window|guests` and fares `city|window|origin`. It is never written to the shared `Dataset`. It is dropped with the voyage's other hot caches, and the provider's 6-hour cache makes a refetch free.
3. **Preference: live, then curated, then modelled.**
   - **Stays:** a port × window with live stays for this crew size is priced on them, and not on the curated ones. At most 6 are used: the 4 cheapest and the 2 best rated. `nightlyCents` is the group's nightly price, `sleeps` = the crew size, so there is one "room". The hostel dealbreaker still applies.
   - **Locations:** the provider places a stay only approximately (`approxLocation`). The plan's stay therefore uses **the port's centre** for walking legs and the public map. Its neighbourhood reads "1.4 km from the centre" (from `distanceKm`) or "Near the centre".
   - **Fares:** per member. The cheapest live fare that breaks no dealbreaker wins, even when a curated or modelled fare is cheaper. Next comes the cheapest curated or modelled fare that breaks none. Last is the cheapest of all, with what it breaks.
   - **Outliers:** a live fare outside the port's **live band** is ignored (see below).
4. **Privacy (S2-002).** Live fares exist only for the crew's own home airports, and the origins are private. So nothing public is built from them:
   - **Public range:** the group range of a plan with a live fare (`liveBand`) is widened to the port × window's **live band**. The band runs from `0.6 ×` the cheapest to `1.4 ×` the dearest curated or modelled fare from *every* home airport (`liveBand`, crew-independent). This is also the band a live fare must fall in to be used, so the range always holds the exact total.
   - **Public flags:** these still come from the curated and modelled listings.
   - **Privacy context:** live stay prices are allowed, since they depend only on port, window and crew size. Live fares are not added, because saying one would say where someone flies from.
   - **`priceSource`:** "live" when the stay and every member's flight (home ports aside) came from RouteStack, else "estimated". It is per plan and public-safe. `priceFeed` ("sandbox" or "live") goes with "live".
5. **Timing and re-pricing.** The table never waits. The chart book is built from whatever has landed; the rest is estimated. When a prefetch lands, `repriceLive` runs, but **only while `AT_TABLE`, the negotiation is running, and the Captain hasn't started deciding** (hails closed).
   - **Watch 0:** the Captain is still opening, and no plan has been named, so the whole book is rebuilt in place, live stays included. The engine holds the same array.
   - **Watch 1 on:** each plan is re-priced on the same port, window and stay, so only fares move. New live stays wait for the next meeting.
   - **Privacy context:** it is rebuilt in place and keeps every earlier secret.
   - **After the decision:** `onDecided` puts exactly the decided plans in the book. The Dry Run, the pick, the seals and the booking then use those shares. Nothing re-prices after DRY_RUN.
   - **Restores:** a live stay travels inside the plan (`plan.stay`), so the stored Two Charts resolve after a restart without the overlay.
6. **UI.** Phone chart cards (Dry Run) show a small **"Live prices"** or **"Estimated"** tag. Booked shows **"Prices from RouteStack sandbox"** when the chosen chart was live (just "RouteStack" in live mode).
7. **Booking.** The Visa payment stays **simulated** (`PAYMENTS_MODE=sim`). `bookingRef` (`hotel:<id>` / `fare:<fareSourceCode>`) is kept only for a later "open on RouteStack" deep link via the free `get-payment-url`. We never book or charge through RouteStack.
8. **Logs:** the server logs `[live] voyage <id>: …` for each search (answered / fell back, ms), each prefetch (answered, billed, trimmed), the chart book's live count, and each re-price.

## Live smoke

Run on 2026-09-26 against the sandbox (`evolvemcp.routestack.ai`):

- **Stays:** Lisbon, 12 → 16 Mar 2027, 3 guests: 20 stays in about 14 s. The page is wrapped in a one-item array, and `reviews` is `null`, so ratings come from the stars.
- **Fares:** ATL → LIS, same dates:
  - `adults: 1`: 15 options in about 17 s, cheapest $861.38 (United via EWR).
  - `adults: 3`: 15 options in 26 s, $2,584.14 for the same itinerary. That is the party's total, so the per-person rule above divides by `quantity`.
- **A random demo voyage on the dev server** (`POST /api/demo/seed?kind=random&crew=3`: Delhi, Medellín, St. Louis in W7, 8–12 Oct 2027; two home airports):
  - **Prefetch:** it started when the seed sealed the last brief and finished in 13.3 s. The 3 stay searches answered in 5.5–7.9 s each.
  - **Fares refused:** all 6 fare searches were refused (`TOOL_ERROR`) in 1.5–4.9 s. The departure was 377 days out; the March 2027 searches (167 days out) worked, so the sales horizon is the likely cause. So the chart book used live stays with modelled fares, and every plan was "Estimated". The table decided in 41 s.
  - **Retries:** the table start retried the 6 refused searches. That is now fixed (the 10-minute retry rule and the 330-day horizon).
  - **Spend:** 15 counted against the voyage: 3 answered and 12 refused (6, plus the 6 retries). A refused search may not be billed upstream; the cap counts it anyway.
- **In process, from the sandbox answers above** (Lisbon + Mexico City, W1, 3 crew from ATL): the Lisbon charts came back **"live" / sandbox**, with $861.38 per person and a live stay 3.2 km from the centre. The public range held the exact total. Mexico City stayed estimated. No network was used: the cache answered.
