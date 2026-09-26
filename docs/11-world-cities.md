# 11 — "Any city on Earth"

The curated ports (`data/dataset.json` + `data/cities/<ID>.json`) are hand-written. This layer lets an organizer pick
**any** city: it searches OpenStreetMap, then builds a *city pack* for the place in the curated file shape (5 stays,
8 activities, an airport, modelled prices). The flight model (`fit/flights.ts`) then prices flights to the pack's
airport like any other port.

Status: self-contained and tested. **Not wired yet**: see [Wiring](#wiring-for-the-engine).

## Files

| Path | What |
|---|---|
| `packages/shared/src/world.ts` | Wire types: `WorldSearchResult`, `WorldSearchResponse`, `CityPick`, `CityPack` (+ `PackCity`/`PackHotel`/`PackActivity`/`PackMeta`), `OSM_ATTRIBUTION`. Re-exported from the shared index. |
| `apps/server/src/world/airports.json` | 3,244 airports (large + medium, scheduled service, IATA code), 236 kB. Rows `[iata, name, city, iso2, lat, lng, size]` (size 2 = large). |
| `apps/server/scripts/world-airports.mjs` | Regenerates `airports.json` from the OurAirports CSV (see the file header). |
| `apps/server/src/world/airports.ts` | `nearestAirports`, `airportFor` (the nearest one, but a large airport wins if it is less than 40 km farther; nothing past 250 km). |
| `apps/server/src/world/countries.ts` | 88 countries: price level (1.0 ≈ Spain), standard UTC offset (null = several zones, so it is estimated from longitude), region (the pickers' `REGIONS`). |
| `apps/server/src/world/model.ts` | Price and rating model, activity category defaults. |
| `apps/server/src/world/net.ts` | Polite fetch (User-Agent, Referer, timeout), `Throttle`, `UpstreamBusy`, `setWorldFetch` (tests). |
| `apps/server/src/world/nominatim.ts` | City search and place lookup, with a cache in memory and on disk. |
| `apps/server/src/world/overpass.ts` | The Overpass query and fetch. |
| `apps/server/src/world/pack.ts` | `packFromElements` (pure, deterministic) and `buildCityPack` (fetch + radius fallback). |
| `apps/server/src/world/packs.ts` | Pack store (memory + `DATA_DIR/world/packs/<id>.json`), in-flight dedupe, loader hook, `restoreWorldPacks`, `adoptPack`. |
| `apps/server/src/world/search.ts` | Curated matches first, then Nominatim (minus duplicates of curated cities). |
| `apps/server/src/api/worldRoutes.ts` | `worldRouter(helm)`. Not mounted yet. |
| `apps/web/src/phone/components/CitySearch.tsx` (+ `citySearch.css`) | The standalone picker. |
| Tests | `apps/server/test/world-pack.test.ts`, `apps/server/test/world-net.test.ts` (fixtures in `test/support/world/`), `apps/web/src/phone/components/CitySearch.test.tsx` |

## API

```
GET  /api/world/search?q=split%2C%20croatia
  → { results: WorldSearchResult[], world: "ok" | "unavailable" | "skipped", attribution: "© OpenStreetMap contributors" }
     WorldSearchResult = { kind: "curated" | "world", cityId?, osmId?, name, country, countryCode, state?, lat, lng, displayName }
     Curated rows come first. world = "unavailable" means Nominatim failed; the curated rows are still returned.
     "skipped" means q was shorter than 2 characters. 422 when q is over 100 characters; 429 over 30/min per address.

POST /api/world/packs   { "osmId": "R11153757" }        (osmId = N|W|R + OSM id)
  → 200 { pack: CityPack, cached: boolean, registered: boolean }   (registered = handed to the loader's addCityPack)
    422 BAD_INPUT (bad osmId) · 404 NOT_FOUND (no such OSM place) · 429 SLOW_DOWN (10/min per address)
    409 TOO_FEW "Not enough on the map there yet (…)" · 503 LOADING + Retry-After (Overpass/Nominatim busy)

GET  /api/world/packs/:id    → a stored CityPack (never builds) · 404
```

`CityPack` has the shape of a curated city file, plus `generated: true` and
`meta: { version, source: "openstreetmap", osmId, attribution, builtAt, radiusKm, airportKm, candidates }`.

## How a pack is built

1. **Place.** From the search cache or a Nominatim `/lookup` (osmId, name, country, ISO code, subdivision, lat/lng, place type).
2. **Map data.** One Overpass POST with `[timeout:25]` and a global bbox around a 3 km circle, or 8 km for towns and
   villages. The query asks for:
   - stays: `tourism=hotel|hostel|guest_house|apartment` with a name
   - sights: `tourism=museum|attraction|viewpoint|gallery|zoo|theme_park`, `historic=castle|monument|memorial|ruins|archaeological_site`,
     `leisure=park|nature_reserve|beach_resort`, `natural=beach`, `amenity=theatre|marketplace`, `place=square`
   - nightlife: `amenity=bar|pub|nightclub`
   - food: `amenity=restaurant` with `cuisine`

   Output is capped per group, with wikidata-tagged places first. If a city has too few places at 3 km, the query
   runs once more at 8 km.
3. **Candidates.** Elements are sorted by OSM ref, and anything outside the circle is dropped. Duplicate names fold
   into the best-scored copy. `name:en` is used when `name` is not in Latin script.
4. **Stays (5).** One hostel, one guesthouse, one apartment, a hotel of 3 stars or fewer, and a hotel of 4+ stars.
   Any empty slot is filled with the best remaining stay (a website, stars or wikidata count for it; distance from
   the centre counts against it). The result is sorted cheapest first.
   - Names get " (3 beds)" (hostel) or " (triple room)" (hotel).
   - Neighbourhood: `addr:suburb`, `addr:neighbourhood` and similar tags, else "Central X", else the street.
   - Nightly price = $200 × country level × stay type (hostel 0.6, guesthouse 0.85, apartment 1.1, hotel 1.15)
     × stars (1★ 0.7 … 5★ 1.8) × jitter (±8 %, hashed from the OSM ref). Rounded to $5.
   - Sleeps: 3, or 4 for an apartment. Rating: 4.0–4.5, hashed from the OSM ref.
5. **Activities (8).**
   - Each place gets a category from its tags (see `categoryOf`), plus tags in the app vocabulary (`tagsOf`: live
     music, museum-in-a-castle, heritage, …).
   - Notability = category interest + wikidata (3) + wikipedia (2) + translated names (up to 4) + heritage, minus
     0.3 per km from the centre.
   - **3 group moments** are the most notable places, at most one per category and one per spot (120 m).
   - **5 picks** are chosen greedily for the most tags not yet covered, then by notability.
   - Duration, start window and price come from the category defaults; price is multiplied by the country level.
   - With only 4 or 5 activities there are 2 group moments.
6. **City.**
   - Centre = centroid of the chosen places. `tileRadiusKm` = 75th-percentile spread × 1.2, in 0.5 km steps, 1–6 km.
   - Airport = `airportFor(place)`. `utcOffset` comes from the country table, else longitude / 15.
   - `region` is one of the pickers' `REGIONS`. `state` is set for US places only, as the two-letter code.
   - `publicFlags` always include "Prices are estimates for this place", plus a note when the airport is over
     60 km away or when there are fewer than 5 stays.
   - `id = "W-" + <N|W|R> + base36(osm id)`, e.g. `W-R6N2AL` for Split. Hotel and activity ids are
     `<id>-h-<slug>` / `<id>-a-<slug>`.
7. **Refusals.** Fewer than 3 stays, fewer than 4 activities, or no airport within 250 km gives
   409 TOO_FEW "Not enough on the map there yet (…)".

The pack is **deterministic** for the same OSM data (the tests shuffle the input). Only `meta.builtAt` changes.

## Data sources and licences

- **OpenStreetMap** (Nominatim + Overpass): © OpenStreetMap contributors, under the
  [ODbL](https://opendatacommons.org/licenses/odbl/). Every search response and pack carries
  `"© OpenStreetMap contributors"` (`attribution` / `meta.attribution`). **Show it wherever pack places or map
  search results are shown.** CitySearch already does, under map rows. A stored pack is a derived database, and
  ODbL share-alike applies if packs are ever published as a dataset.
- **OurAirports** (`airports.csv`): public domain (https://ourairports.com/data/). Downloaded once on 2026-09-26.
  To refresh it, rerun `scripts/world-airports.mjs`.
- **Prices, ratings, durations** are a model, not data. Every pack flags this.

## Usage-policy compliance

- **Nominatim** ([policy](https://operations.osmfoundation.org/policies/nominatim/)):
  - One process-wide throttle: at most 1 request/s, with at most 20 waiting (past that, requests are refused at once).
  - `User-Agent: AllAyes/1.0 (hackathon demo)` and a Referer (`PUBLIC_BASE_URL`).
  - Answers are cached for 7 days and places for 90, in memory and in `DATA_DIR/world/nominatim.json`.
  - No per-keystroke calls: the client debounces 400 ms and needs 2 characters; the server caches and allows
    30 searches/min per address.
- **Overpass**:
  - One call at a time, 2 s apart, at most 6 waiting.
  - `[timeout:25]`, a 45 s client timeout, and capped output.
  - Each place is built **once per server** (stored on disk; concurrent requests share the build).
  - 10 builds/min per address.
  - Busy answers (429/502/503/504, a timeout, or an error "remark") become 503 LOADING with Retry-After. There is
    no retry loop.
- These are **server-side fetches only**. The browser CSP doesn't change.
- **Tests never reach the network.** Under vitest the default fetcher throws unless `WORLD_LIVE=1`, and tests use
  `setWorldFetch(mock)`.

Env: `WORLD_OVERPASS_URL` sets another Overpass instance (e.g. `https://overpass.kumi.systems/api/interpreter`) for
when overpass-api.de is overloaded. `DATA_DIR` sets where packs and the search cache are stored.

## Limits and known gaps

- OSM coverage varies. Small towns can lack named hotels (refused), and big cities have more than the caps (the
  wikidata-first pass keeps the notable ones).
- `overrides` and `hilly` are empty. Walking times come from coordinates. Day trips beyond the radius aren't found.
- UTC offset is the standard offset: DST isn't modelled (the curated files use the March offset the same way).
- Countries not in the table use level 0.8.
- Neighbourhood names are only as good as the `addr:*` tags.
- Packs don't expire. When the builder changes enough to matter, bump `PACK_VERSION` (older stored packs are rebuilt
  on request).

## Wiring (for the engine)

1. **Accept `W-` port ids.**
   - In `data/loader.ts` `validateCityPack`, change the id rule to
     `/^([A-Z0-9]{3,4}|W-[NWR][0-9A-Z]{1,14})$/`.
   - Today `addCityPack` refuses a generated pack for this reason only. Everything else already validates
     (`world-pack.test.ts` checks this against the real `validateCityPack`).
   - If `CityId` or any picker assumes 3–4 characters, widen it too.
   - Hotel and activity ids are already `<id>-h-…` / `<id>-a-…`.
2. **Mount the router.** In `api/routes.ts` `apiRouter`, before the JSON 404:
   ```ts
   import { worldRouter } from "./worldRoutes.js";
   r.use("/world", worldRouter(helm));   // helm.ds.cities → curated matches
   ```
   It answers its own errors (same `{code, message}` JSON and status table), so it also works mounted directly on
   the app.
3. **Boot.** After the dataset loads, call `await restoreWorldPacks()` (from `world/packs.js`). It re-registers every
   stored pack with `addCityPack`, so ports built before a restart exist again without the network. Registration
   happens once per id, and the loader's "already exists" refusal counts as success.
4. **Create screen.**
   - Add `<CitySearch onPick={…} />` to `PortPicker` (e.g. under the chips, as "Add any city").
   - On `{kind:"curated", cityId}`, add that id to `ports`.
   - On `{kind:"world", osmId}`:
     - `POST /api/world/packs {osmId}`, show `<Plotting label="Charting {name}…" />`, and add `pack.city._id` to
       `ports`.
     - On 503 LOADING, show "The map is busy — try again in a minute" (`retryAfterS` is in the body).
     - On 409 TOO_FEW, show the message.
   - Show `pack.meta.attribution` wherever the pack's places are listed.
   - The organizer-only gate can be added later (the route is per-address limited now).
5. **Voyage persistence.** A trip whose ports include a `W-` id must survive a restart on a fresh disk (e.g. Render
   without a persistent disk). Either:
   - **(recommended)** store the generated packs with the trip record (e.g. `trip.worldPacks: CityPack[]`, about
     8 kB each), and on restore call `await adoptPack(p)` for each before rebuilding plans. It validates, stores
     and registers without the network. Or:
   - store just `meta.osmId` and call `packFor(osmId)` on restore. This rebuilds from Overpass, which is slower and
     can fail, and prices can drift if OSM changed. That is why (1) is recommended.
6. **Build.** Nothing to add: `airports.json` is imported (bundled by esbuild), and packs live under `DATA_DIR`.

## Live smoke (2026-09-26, 3 real requests)

1. Nominatim search "Split, Croatia" (1 request) returned `R11153757 Split (city, HR) 43.51164, 16.43997` and
   `R2826807 Grad Split (municipality)`. The place was cached to disk.
2. Overpass, first try (1 request) hit the client timeout, which became `UpstreamBusy` (the route answers 503 LOADING).
   After that the query switched from per-statement `around` to a global bbox (cheaper for Overpass), and the
   client timeout went to 45 s.
3. Overpass, second try (1 request) got HTTP 504 from overpass-api.de (overloaded), which became `UpstreamBusy`
   with retryAfter 60.

No Split pack was built live. The request budget was spent on a busy public instance. The full pack pipeline is
covered offline by the Porto fixture, and the Split place and airport lookup (SPU) are verified. To try again:
`WORLD_LIVE=1`, or just run the server, then `POST /api/world/packs {"osmId":"R11153757"}` (optionally with
`WORLD_OVERPASS_URL` pointing at a mirror).
