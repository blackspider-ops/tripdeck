# All Ayes

**Everyone's in, or nobody pays.** *Send your mate to the table.*

Group trips die in the group chat: nobody wants to say "too expensive", and one person ends up fronting the money. In All Ayes each friend privately briefs their own **mate** (an AI advocate) with their real budget and wishes. The mates negotiate out loud around a paper globe on your real table (Meta Quest 3, mixed reality), show the two best trips as miniature cities playing out a day (**Dry Run**), then book with an **all‑or‑nothing checkout**: each share is paid by a Visa agent card capped at that friend's private limit, and if any share fails, nobody is charged.

Built for HackGT 13. Full specs in [`docs/`](docs/00-README.md).

## Run it

```bash
npm install
cp .env.example .env        # optional — runs without any keys; one root .env for server + Vite, blank line = default
npm run dev                 # helm on :8787, web on :5173 (localhost only; LAN: see dev:lan below)
```

Open **http://localhost:5173/demo** → *Seed the Expo voyage* → open the links (Rae on this device, Maya on a phone, the Gallery on a laptop). Each phone link carries a one-time handoff code in the fragment (`/t/CODE#as=…&m=…`), good for one open within 2 h; the member token itself never appears in a URL. On the Quest: open `https://<your-https-host>/xr` and type the 8-character headset code.

In production (and from any other machine, even in dev mode), seeding needs the dev key: open `/demo#key=<DEV_KEY>` once. Only the fragment works, because it never leaves the browser; `?key=` is ignored (it would already be in proxy and CDN request logs) and just wiped from the address bar. The page moves the key into this tab's `sessionStorage`, strips it from the address bar and sends it as the `X-Dev-Key` header.

Quest Browser needs HTTPS for WebXR. **For a demo, tunnel a production-mode build, not `npm run dev`:**

```bash
cloudflared tunnel --url http://localhost:8787      # prints https://<random>.trycloudflare.com; leave it running
npm run build
APP_ENV=production SERVE_WEB=1 PUBLIC_BASE_URL=https://<random>.trycloudflare.com DEV_KEY=$(openssl rand -hex 24) npm run start:prod
```

Then open `https://<random>.trycloudflare.com/demo#key=<that DEV_KEY>` to seed, and `/xr` on the Quest. For a quick look while developing, `cloudflared tunnel --url http://localhost:5173` in front of `npm run dev` also works: the Vite dev server serves only `apps/web`, `packages/shared` and `node_modules` (never `apps/server/data`, `docs/` or the rest of the repo), and the helm opens its dev routes (`/api/demo/seed`, `/api/debug/*`, the `/api/health` details) without the key only to a client on this machine. Through the tunnel or from the LAN they need `DEV_KEY` like in production.

| Command | What |
|---|---|
| `npm run dev` | server (tsx watch) + web (Vite on localhost); counts as development mode (dev routes open to this machine only; other clients need `DEV_KEY`) |
| `npm run dev:lan -w @all-ayes/web` | the Vite dev server on every interface (`vite --host`), for a phone on the same Wi-Fi |
| `npm test` | server + web: **485 server tests** (40 files: pricing, fairness, privacy filter, negotiation rules, payments invariants, service rules, restart/restore, persistence, sweep and write queue, socket budgets, memory/voice fallbacks, limits, hardening, contract, end‑to‑end sockets) and **214 web tests** (33 files: socket store, reducers, phone hooks and screens (happy-dom), routing, error copy, formatting, seating, labels, scene/director and XR logic) |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run check` | typecheck + tests + build + bundle budget (`scripts/bundle-budget.mjs`; run before pushing) |
| `npm run build` | web production build + server bundle (esbuild → `apps/server/dist/index.js`) |
| `npm run start:prod` | the compiled server; serves `apps/web/dist` (production mode, see DEPLOY.md) |
| `npm start` | the server from source via tsx (local use) |
| `GET /api/health` | public: `{ok, eleven, degraded}`; with `X-Dev-Key`: which integrations are live, storage, budgets |
| `GET /api/debug/<code>` | live event log, seals and booking state (needs attention, seal deadline) for a voyage. Open in dev mode from this machine, else send `X-Dev-Key` or sign in once in the browser (a 1-hour cookie); `?key=` is not accepted |

## What works without keys

| Integration | With key | Without key |
|---|---|---|
| Gemini | Every mate and the Captain speak in their own words | Protocol lines from templates (same decisions) |
| ElevenLabs | A voice per crew member (defaults George, Liam, Sarah, Chris, Jessica work on any plan; `ELEVEN_VOICE_*` to override); spoken hails | Captions + browser speech; typed hails |
| MongoDB Atlas | Voyages persist and resume after restart | In memory |
| Backboard | Mates remember you across voyages | Local memory in MongoDB, or `DATA_DIR/memory.json` (default `apps/server/data`) |
| Visa Intelligent Commerce | Agent card + capped instruction (wire `visaVic.ts`) | Simulated with the same contract, labeled "Sandbox simulation" |
| Google 3D Tiles (`VITE_GOOGLE_MAP_TILES_KEY`, or a free `VITE_CESIUM_ION_TOKEN`; build-time) | Photoreal cities under the cloches | Paper low‑poly cities |

## Layout

```
packages/shared   types, socket events, constants (the contract)
apps/server       the helm: pricing & fairness, negotiation engine, privacy filter, payments, voice, memory, REST + sockets
apps/web          phones (React), headset (WebXR/three.js), gallery
docs/             PRD, design language, UX, tech design, agent/payments/dataset specs, build plan, demo kit
```

## Deploy
See [`DEPLOY.md`](DEPLOY.md) — one Docker container (Render blueprint included) + the `allayes.tech` domain.

## Known limits
- Visa Intelligent Commerce needs credentials from Visa (token service, VIC, token requestor, MLE keys); until then payments run in a labeled simulation with the same contract (`apps/server/src/payments/visaVic.ts`).
- Needs a real Quest 3 to verify: immersive entry, table placement/anchors, hand input, 72 fps, in‑headset text legibility (some labels are below the 12 mm target in doc 02 §4.2).
- The Docker image is built and smoke-tested (full Expo voyage in the container). Render persistent disk ownership and the polling fallback with WebSockets blocked haven't been verified end to end (see `docs/review/REVIEW-REPORT.md`, "Still open").
- The browser tile tokens (`VITE_GOOGLE_MAP_TILES_KEY`, `VITE_CESIUM_ION_TOKEN`) ship in the bundle; restrict them at the provider (DEPLOY.md, *Browser tile tokens*). Everything else still open after the round-2 fixes is listed in `docs/review-2/REVIEW-REPORT.md`, *Still open / needs outside help*.
- Passkeys are optional: members seal with a tap unless they chose **Add a passkey** (Wait or Brief screen); then *Set your seal* asks for it.
- Memory identity is a private **crew key** kept in the phone's browser storage (no accounts). It is minted at the first join and sent on later joins; the server keeps only its hash. Clearing the browser or switching phones starts a fresh memory, and two people sharing one browser share a key (their threads stay apart only by name).

## Honesty notes
Trip inventory is curated sample data for three cities (prices are illustrative). Payments run in simulation unless the Visa sandbox is wired — no real money moves. The project was started before the HackGT hacking window.
