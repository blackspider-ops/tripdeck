# Deploying All Ayes to allayes.tech

The server serves the API, the sockets and the built web app from one origin — one container, one domain.

## 1. Keys (all optional)
Copy `.env.example` → `.env` locally, or set the same variables on your host. Check what's live at `/api/health` (the public answer is just `ok`, `eleven` and `degraded`; send `X-Dev-Key: $DEV_KEY` for the full configuration, budgets and storage state).

| Variable | Get it from | Unlocks |
|---|---|---|
| `GEMINI_API_KEY` | aistudio.google.com (enable billing so rate limits don't stall the demo) | Mates speak in their own words |
| `ELEVENLABS_API_KEY` (+ optional `ELEVEN_VOICE_*`) | elevenlabs.io (MLH promo). Default voices (George, Liam, Sarah, Chris, Jessica) work on any plan; blank `ELEVEN_VOICE_*` = default | A voice per crew member; spoken hails |
| `MONGODB_URI` | MongoDB Atlas M0 (MLH $50 credit) | Voyages (and mates' memory) survive restarts |
| `DATA_DIR` / `CACHE_DIR` | a path on a persistent disk (see *Storage*) | Local memory survives deploys without MongoDB |
| `BACKBOARD_API_KEY` | backboard.io (promo `13HACKGT`) | Mates remember you across voyages |
| `VITE_GOOGLE_MAP_TILES_KEY` | Google Cloud → Map Tiles API (needs a billing account; restrict to your domain) — **build-time** | Photoreal cities in the Dry Run |
| `VITE_CESIUM_ION_TOKEN` | ion.cesium.com → Access Tokens (free, no card) — **build-time**; used when no Google key is set | The same Google photoreal cities, via Cesium ion |
| `ROUTESTACK_API_KEY` / `ROUTESTACK_API_SECRET` (+ optional `ROUTESTACK_ACCOUNT_ID`, `ROUTESTACK_MODE`, `ROUTESTACK_BASE_URL`) | routestack.ai dashboard (partner API key + secret). `ROUTESTACK_MODE` = `off` / `sandbox` / `live`; blank = sandbox (`https://evolvemcp.routestack.ai`, limited tokens) when both keys are set. `live` uses `https://mcp.routestack.ai` unless `ROUTESTACK_BASE_URL` says otherwise | Live hotel and flight prices on the chart (see docs/12-routestack.md); without them, curated/modelled prices |
| `PAYMENTS_MODE` | `sim` until Visa sandbox credentials arrive (see `apps/server/src/payments/visaVic.ts`) | — |

`VITE_*` variables are baked in at build time — rebuild after changing them.

### Limits (optional; defaults are safe for the Expo)
| Variable | Default | What it does |
|---|---|---|
| `TRUST_PROXY_HOPS` | 1 on Render/Fly, else 0 | Proxies in front of the server. Rate limits key on the client address through exactly this many proxies, so a spoofed `X-Forwarded-For` doesn't help. Set it to your real hop count (e.g. 2 behind a CDN + load balancer); on a bare Docker host leave it at 0. |
| `DAILY_CAP_GEMINI` / `_TTS` / `_STT` / `_BACKBOARD` | 3000 / 1500 / 500 / 3000 | Paid calls per UTC day. Over it the app falls back (template lines, captions, typed hails, local memory). `0` switches that provider off. `/api/health` → `budgets` shows `"reserve"` / `"capped"`. With MongoDB the counts are stored (`spend` collection), so a restart or redeploy doesn't reset them. |
| `TRIP_CAP_GEMINI` / `_TTS` / `_STT` / `_BACKBOARD` | 150 / 100 / 30 / 60 | The same, per voyage. |
| `ROUTESTACK_DAILY_CAP` / `ROUTESTACK_TRIP_CAP` | 200 / 20 | Billable RouteStack searches (hotel + flight searches; token, destination lookup and flight session are free) per UTC day / per voyage. Over it the chart keeps curated/modelled prices. `/api/health` → `budgets.routestack`. |
| `ROUTESTACK_SEARCH_TIMEOUT_MS` / `ROUTESTACK_TIMEOUT_MS` / `ROUTESTACK_CACHE_HOURS` | 90000 / 30000 / 6 | How long a search / other call may take, and how long a search answer is reused (memory + `DATA_DIR/routestack/`). A timed-out search isn't re-sent for 10 minutes (it was probably billed). |
| `SPEND_RESERVE_PCT` | 20 | Share of each daily cap only voyages past the table (Dry Run, sealing, booked) may use, so a flood of new voyages can't switch voices and models off for a crew about to book. |
| `TRIP_MISS_RATE` | 20 | Unknown voyage ids per minute per address on `/api/trips/:id/*` (each is a MongoDB lookup); then `429`. |
| `PAIR_FAIL_RATE_48` | 30 | Wrong headset codes per minute per IPv6 /48 (per address it is 10; there is no server-wide cap). |
| `HAIL_AUDIO_MAX_BYTES` | 524288 | Largest voice clip accepted (≈ 20 s). |
| `RATE_LIMITS` / `RATE_LIMIT_SCALE` | on / 1 | `off` disables rate limits (load tests only); the scale multiplies every limit. |
| `VOYAGE_IDLE_HOURS` / `VOYAGE_DONE_DAYS` | 48 / 7 | Idle voyages leave server memory (MongoDB keeps them). |
| `VOYAGE_LONE_HOURS` / `VOYAGE_STALE_DAYS` | 1 / 30 | A BRIEFING voyage nobody joined, and an untouched Dry Run, leave memory sooner (they open again by code with MongoDB; without it they are gone). The sweep runs every 15 minutes. |
| `MAX_LIVE_VOYAGES` | 2000 | Voyages held in memory at once; past it new voyages get `503 HELM_FULL`. `0` = no cap. |
| `CREATE_RATE_GLOBAL` / `CREATE_RATE_48` | 60 / 30 | New voyages per minute for the whole server / per IPv6 /48 (per address it is 10). |
| `TTS_CACHE_MAX_FILES` / `TTS_CACHE_MAX_DAYS` | 3000 / 30 | Voice cache bound (a warmed Expo run stays warm while it's used). |
| `TABLE_RUNS_MAX` | 6 | Table meetings per voyage; after that `table:start` is refused with `TOO_MANY_RUNS`. |
| `SEAL_DEADLINE_MS` | 600000 | How long the crew has to set every seal before the attempt voids ("nobody was charged"). |

Full table of limits: docs/04 §12 *Limits*.

### Everything else the server reads (all optional)
| Variable | Default | What it does |
|---|---|---|
| `PORT` | 8787 | HTTP + socket port. |
| `PUBLIC_BASE_URL` / `APP_ENV` / `DEV_KEY` | — | Production mode and the dev key: see *Production mode* below. |
| `CORS_ORIGINS` | — | Extra browser origins allowed to open a socket (the page's own origin always is). |
| `SERVE_WEB` / `WEB_DIST` | off / `apps/web/dist` | Serve the built web app outside production too (the tunnel demo uses `SERVE_WEB=1`). |
| `PAIRING_SECRET` | random per process | HMAC key for headset codes; keep it stable across deploys. |
| `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_ID` | `PUBLIC_BASE_URL` / its host | Passkey relying party (only needed off `PUBLIC_BASE_URL`, e.g. a tunnel test). |
| `RESTORE_RECENT_DAYS` | 7 | Settled voyages touched this recently are loaded at boot; older ones load on demand. |
| `MONGODB_DB` | `all_ayes` | Database name. |
| `GEMINI_MODEL` / `AGENT_DECISIONS` | `gemini-2.5-flash` / `rules` | Model, and whether Gemini may pick moves (`model`) or only word them (`rules`, the demo default). |
| `ELEVEN_MODEL` / `ELEVEN_STT_MODEL` / `ELEVEN_VOICE_CAPTAIN` / `ELEVEN_VOICE_BAND1..12` | `eleven_flash_v2_5` / `scribe_v1` / premade voices | Voice models and voice IDs (blank = default). |
| `BACKBOARD_BASE_URL` | Backboard's API | Override the Backboard endpoint. |
| `VISA_VIC_API_BASE` / `VISA_VIC_API_KEY` | — | Visa sandbox, once `visaVic.ts` is wired (`PAYMENTS_MODE=visa_sandbox` falls back to `sim` until then). |
| `SIM_DECLINE_MEMBER` / `SIM_TIMEOUT_MEMBER` | — | Force a SIM decline / timeout for one member id (tests). |
| `EXPO_MODE` / `PACE_SCALE` / `DEMO_REPLAY` | `true` / 1 / `live` | Short lines + faster voices; pacing multiplier (also scales the 2.5 s seal settle point, which is not itself configurable); `cached` = replay the warmed Expo run. |
| `NODE_ENV` | `production` in the image | Set by the Dockerfile; don't set it in `.env`. `RENDER` / `FLY_APP_NAME` (set by those hosts) only pick the `TRUST_PROXY_HOPS` default. |
| `API_URL` / `VITE_ALLOWED_HOSTS` / `VITE_SOURCEMAP` | `http://localhost:8787` / — / hidden | Vite dev server only: proxy target, extra dev hosts, `off` = no source maps. Never shipped. |

The commented list of every key is `.env.example`.

## 2. Host
Any host with HTTPS and long-lived WebSockets works (Render, Railway, Fly, a VM). Vercel serverless is not a good fit for this single stateful Socket.io process.

**Render (Blueprint):** New → Blueprint → this repo (uses `render.yaml` + `Dockerfile`) → fill the secret env vars → deploy.
- `DEV_KEY` and `PAIRING_SECRET` are generated by Render (44 random chars; production refuses a `DEV_KEY` under 32). Copy `DEV_KEY` from the service's Environment tab for `/demo`. Keep `PAIRING_SECRET` stable, or headset pair codes stop matching after a redeploy.
- `VITE_CESIUM_ION_TOKEN` / `VITE_GOOGLE_MAP_TILES_KEY` are **build-time**: Render passes service env vars to `docker build` as build args, and the Dockerfile declares both `ARG`s before the web build. After changing one, use *Manual Deploy → Deploy latest commit* (a rebuild), not a restart.
- `MONGODB_URI`: in Atlas → Network Access, allow Render's outbound IPs (service → Connect → Outbound) or `0.0.0.0/0`. If Mongo is unreachable the server still starts, in memory (check the logs for `[db] MongoDB connected`).
- Health check: `/api/health` (public, minimal). `TRUST_PROXY_HOPS=1` (Render's load balancer).
- `PUBLIC_BASE_URL=https://allayes.tech`: the app also works on `https://all-ayes.onrender.com` before the domain is live (the page's own origin is always allowed for sockets and CSP), but passkeys only work on the `PUBLIC_BASE_URL` domain.

**Any Docker host:**
```bash
docker build -t all-ayes --build-arg VITE_GOOGLE_MAP_TILES_KEY=$VITE_GOOGLE_MAP_TILES_KEY --build-arg VITE_CESIUM_ION_TOKEN=$VITE_CESIUM_ION_TOKEN .
docker run -p 8787:8787 --env-file .env.docker -e PUBLIC_BASE_URL=https://allayes.tech -e DEV_KEY=$(openssl rand -hex 24) all-ayes
```
`docker --env-file` does **not** strip inline `# comments` the way the server's `.env` loader does (`EXPO_MODE=true   # …` would reach the server as `true   # …`, and `DATA_DIR=   # …` as a path). Give Docker a copy without comments, e.g. `sed -E 's/[[:space:]]+#.*$//; /^[[:space:]]*#/d; /=$/d' .env > .env.docker`.
The image is multi-stage: the runtime stage has production dependencies only, runs the compiled server (`apps/server/dist/index.js`, built by `npm run build`) as the unprivileged `node` user (uid 1000), with `NODE_ENV=production` baked in. The container starts as root only for `apps/server/scripts/docker-entrypoint.mjs`, which creates `DATA_DIR`/`CACHE_DIR` and chowns them to uid 1000 (only under `/var/data`, `/app/apps/server/data` or `/app/apps/server/.cache`; any other path, e.g. `DATA_DIR=/app`, stops the container before anything is chowned) (host disks such as Render's are mounted root-owned), then drops to `node` before the server loads. With `docker run --user node` that step is skipped and a mounted `DATA_DIR`/`CACHE_DIR` must already be writable by uid 1000; if it isn't, the server logs `[store] … not writable` and memory stays in RAM (`memory.degraded` in the `/api/health` details, sent with `X-Dev-Key`; the public `degraded` flag is about MongoDB persistence).

### Production mode (fail closed)
The server is in **production** when `NODE_ENV=production` (the Dockerfile sets it), or `APP_ENV=production`, or `PUBLIC_BASE_URL` names a real host (not localhost) — so an `--env-file` that says `NODE_ENV=development` can't switch it off. Only `APP_ENV=development` (or `npm run dev`) opens the dev conveniences, and never in production. In production:
- the server **refuses to start** without `PUBLIC_BASE_URL`, or with a `DEV_KEY` shorter than 32 characters (`change-me` included). An empty `DEV_KEY` is fine: the dev routes are simply off;
- `/api/demo/seed`, `/api/debug/*` and the `/api/health` details need the `X-Dev-Key` header (never `?key=`; the web app takes it from `/demo#key=…` only, since a query string lands in Render/Cloudflare request logs). In a browser, open `/api/debug/<code>`: it asks for the key once (a form POST) and keeps a 1-hour, HttpOnly cookie for `/api/debug` only. The debug view shows crew as `crew-xxxxxx` references keyed with a per-process server secret (they can't be recomputed from a member id and change on restart), seals by their public status (a decline reads `VOIDED`), no provider refs, and never decline reasons or who received one. Outside production (dev mode) these routes skip the key only for a client on the same machine: a tunnel Host, a LAN client (the Vite proxy passes `x-dev-proxy-client`), cloudflared's `Cf-*` headers or any `X-Forwarded-*` chain needs the key;
- security headers on every response: a CSP (`'self'` plus `blob:` workers for the 3D text, `https://tile.googleapis.com` for city tiles and `https://api.cesium.com` for the Cesium ion token exchange, `wss://` to this host), `frame-ancestors 'none'`, HSTS (1 year), `nosniff`, `Referrer-Policy: same-origin` (no Referer to other sites), and a `Permissions-Policy` that allows only WebXR and the microphone on this origin;
- sockets accept browser pages from this origin, `PUBLIC_BASE_URL` and `CORS_ORIGINS` only (outside production, localhost/LAN/`*.trycloudflare.com` pages too);
- hashed `/assets/*` are cached for a year (immutable), `index.html` is `no-cache`, source maps aren't served, and an unknown `/api/*` path is a JSON 404. Outside production the server doesn't serve the web build unless `SERVE_WEB=1` (use Vite on :5173).

### Storage (what survives a redeploy)
Container disks are wiped on every deploy. What the server keeps, and where:

| Data | With `MONGODB_URI` | Without MongoDB |
|---|---|---|
| Voyages, briefs, bookings, passkeys | MongoDB | in memory (lost on restart) |
| Mates' memory (local copy) and the Backboard assistant per person | MongoDB (`memories`, `backboard_assistants`) | `DATA_DIR/memory.json`, `DATA_DIR/backboard-assistants.json` |
| Voice audio (`CACHE_DIR/tts`, bounded by `TTS_CACHE_MAX_*`) | cache only: regenerated from ElevenLabs when missing | same |

- `DATA_DIR` (default `apps/server/data`) and `CACHE_DIR` (default `apps/server/.cache`) can point anywhere. Without MongoDB, mount a persistent disk and set `DATA_DIR` on it, or memories (and the mapping to each person's Backboard assistant) reset on every deploy. `render.yaml` mounts one at `/var/data` (root-owned; the entrypoint hands `DATA_DIR`/`CACHE_DIR` on it to the `node` user). On Render, a disk turns off zero-downtime deploys, which is what keeps the helm a single writer: **keep the disk even with MongoDB** (see below).
- **One helm at a time (single writer, L5-002).** On boot the helm restores from MongoDB and treats every live seal as abandoned (voided, "the helm restarted mid-seal") and every running table as interrupted. That is only right when the previous process is gone, so never run two instances against the same database: `render.yaml` pins `numInstances: 1` and keeps the disk (no zero-downtime overlap). As a safety net the helm holds a lease in MongoDB (`helm_lease`, renewed every 10 s, 30 s TTL): a new instance waits for it (released on SIGTERM, or expired) before it restores, logging `another helm holds the lease; waiting`, and an instance that loses it stops writing and reports `persistence.lease: "lost"` / `degraded` in `/api/health` (restart it). A version-guarded write that lost to another writer (`writes.staleSkipped > 0`) also raises `degraded`. If you remove the disk, a zero-downtime deploy will wait on the old instance's lease until Render's health-check timeout and fail, leaving the old instance serving.
- Nothing under `apps/server/data` ships in the image (`.dockerignore`).
- If `DATA_DIR` is read-only or full, memory still works. It stays in RAM for that process, the server logs one `[store] … not writable` warning, and the Backboard copy is still written.

## 3. Domain
1. Register `allayes.tech` with the MLH .Tech promo (turn auto-renew off).
2. At your host, add the custom domain and copy the DNS target.
3. At get.tech DNS: `CNAME www → <host target>` and the apex record your host asks for (ALIAS/ANAME or A).
4. Wait for HTTPS to issue, then open `https://allayes.tech/api/health`.

Passkeys are bound to the domain they were created on — register them on `allayes.tech`, not on a tunnel URL.

### A demo over a tunnel

Point a tunnel at a **production-mode build**, not at the dev servers: `npm run build`, start `cloudflared tunnel --url http://localhost:8787` to learn the URL, then `APP_ENV=production SERVE_WEB=1 PUBLIC_BASE_URL=<tunnel URL> DEV_KEY=<32+ random chars> npm run start:prod`. `npm run dev` binds Vite to localhost only (`dev:lan` opts into the LAN), restricts it to `apps/web`, `packages/shared` and `node_modules`, and keeps the dev routes behind `DEV_KEY` for anything that isn't this machine, but it still runs unminified source with dev tooling.

### Browser tile tokens (S2-015)

`VITE_CESIUM_ION_TOKEN` and `VITE_GOOGLE_MAP_TILES_KEY` are baked into the public bundle; anyone can copy them. Restrict them at the provider (the account owner has to do this):
- **Cesium ion** → Access Tokens: scope `assets:read` only, asset **2275207** (Google Photorealistic 3D Tiles) only, and allowed URLs = the production origin (`https://allayes.tech`, plus a tunnel origin only while a demo needs it).
- **Google Cloud** → Credentials → the Map Tiles key: *Application restriction* = HTTP referrers (`https://allayes.tech/*`), *API restriction* = Map Tiles API only; set a daily quota.
- If either token was ever deployed unrestricted, rotate it (new token → rebuild → revoke the old one).

## 4. Expo checklist
- `https://allayes.tech/demo#key=$DEV_KEY` → *Seed a fresh voyage*. The page keeps the key in this tab's sessionStorage, strips it from the address bar and sends it as the `X-Dev-Key` header.
- Headset iPhone (Safari) → `https://allayes.tech/xr` → headset code (**Show headset code** on the organizer's phone) → **aA → Hide Toolbar** → **Enter VR** → allow motion access → landscape → clamp it into the Gear VR shell (no USB plug; select by gaze). A Quest, if one turns up, uses the same URL in Quest Browser. Setup and fixes: `docs/10-gear-vr.md`.
- Optional: `npm run warm-voices --workspace @all-ayes/server` with the ElevenLabs key, then `DEMO_REPLAY=cached` is the emergency button if the Wi‑Fi dies (template lines, cached voices, no network calls).
