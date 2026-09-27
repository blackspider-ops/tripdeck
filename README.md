# All Ayes

**Everyone's in, or nobody pays.** *Send your mate to the table.*

Group trips die in the group chat: nobody wants to say "too expensive", and one person ends up fronting the money. In All Ayes each friend privately briefs their own **mate** (an AI advocate) with their real budget and wishes. The mates negotiate out loud around a paper globe in a VR chart room (an iPhone clamped into a Samsung Gear VR shell; on a Meta Quest 3 it sits on your real table in mixed reality), show the two best trips as miniature cities playing out a day (**Dry Run**), then book with an **all‑or‑nothing checkout**: each share is paid by a Visa agent card capped at that friend's private limit, and if any share fails, nobody is charged.

Built for HackGT 13. Full specs in [`docs/`](docs/00-README.md).

A crew is the organizer plus up to 11 friends (12 seats, absent friends included), each with their own colour band, mate and voice. Bigger crews book several rooms of one stay ("Casa Alfama ×3") and split the bill evenly; above 6, the table voices at most 6 lines a Watch so it still decides in about two minutes ([`docs/05`](docs/05-agent-spec.md) §2, §4.1).

## Run it

```bash
npm install
cp .env.example .env        # optional — runs without any keys; one root .env for server + Vite, blank line = default
npm run dev                 # helm on :8787, web on :5173 (localhost only; LAN: see dev:lan below)
```

Open **http://localhost:5173/demo** → *Seed a random voyage* (a fresh crew, ports and dates each time) or *Seed the scripted Expo voyage* (Rae, Maya and Dev on Lisbon / Mexico City / Montréal, the pitch script) → open the links (Rae on this device, Maya on a phone, the Gallery on a laptop). Each phone link carries a one-time handoff code in the fragment (`/t/CODE#as=…&m=…`), good for one open within 2 h; the member token itself never appears in a URL. On the headset iPhone (Safari, clamped into a Gear VR shell, no USB plug): open `https://<your-https-host>/xr/code`, type the 8-character headset code, tap **aA → Hide Toolbar**, tap **Enter VR**, allow motion access, turn the phone to landscape and clamp it into the shell. Selecting is by gaze (hold 1.6 s). Step by step: [`docs/10-gear-vr.md`](docs/10-gear-vr.md).

In production (and from any other machine, even in dev mode), seeding needs the dev key: open `/demo#key=<DEV_KEY>` once. Only the fragment works, because it never leaves the browser; `?key=` is ignored (it would already be in proxy and CDN request logs) and just wiped from the address bar. The page moves the key into this tab's `sessionStorage`, strips it from the address bar and sends it as the `X-Dev-Key` header.

### Running on a Quest (Quest-first)

A Quest 3 / 3S is a crew member's own seat. In Quest Browser open `https://<your-https-host>/xr` (HTTPS: the tunnel below):

- **Start a trip**: the phone's Create form, larger. Set sail and the headset is the organizer's seat *and* the voyage's headset (no code). The Enter card, and the **Trip** page of the side panel in the chart room, show the join **QR and code** big so friends scan with their phones without anyone taking the headset off.
- **Join a trip**: type the 6-character voyage code. **I'm new: take a seat** gives this headset its own seat. **I'm {name}** asks that seat's own phone (or headset) for a one-tap **Let this headset in?**. Say yes there and the headset becomes that seat, with that member's private terms and nobody else's. This works for an organizer who started on a phone, and for the `/demo` crews too: seed, then on the Quest pick **I'm Rae** and approve on the seeding device.
- If the browser can't hold a passkey, the member sets a **4–6 digit seal PIN** and approves their share with it in the headset. Face ID on their phone still works.
- In the chart room, **Enter the chart room** starts mixed reality. Pinch the centre of the real table to lay the chart down, then **pinch the table corner nearest you** so co-located crews line up (Skip is fine for a remote friend). The **Log book** tag on the table opens the side panel beside it: trip, crew, **My terms** (the whole brief, with an in-headset keyboard and keypad) and **My seal**. Drag the globe to spin it. A pinch pins the nearest port (the organizer, or the crew once *Crew can pin* is on), and a held pinch pins its whole region. Menu → **Recenter** brings the chart back in front of you; then pinch the table to set it down exactly.
- Any number of headsets can sit at one table. The old shared headset (the organizer's controls, never anyone's terms) is still at `/xr/code`, paired with the organizer phone's **Show headset code**.

Head tracking (the phone's motion sensors) and WebXR need HTTPS, on the headset iPhone and on a Quest. **For a demo, tunnel a production-mode build, not `npm run dev`:**

```bash
cloudflared tunnel --url http://localhost:8787      # prints https://<random>.trycloudflare.com; leave it running
npm run build
APP_ENV=production SERVE_WEB=1 PUBLIC_BASE_URL=https://<random>.trycloudflare.com DEV_KEY=$(openssl rand -hex 24) npm run start:prod
```

Then open `https://<random>.trycloudflare.com/demo#key=<that DEV_KEY>` to seed, and `/xr` on the headset iPhone. For a quick look while developing, `cloudflared tunnel --url http://localhost:5173` in front of `npm run dev` also works: the Vite dev server serves only `apps/web`, `packages/shared` and `node_modules` (never `apps/server/data`, `docs/` or the rest of the repo), and the helm opens its dev routes (`/api/demo/seed`, `/api/debug/*`, the `/api/health` details) without the key only to a client on this machine. Through the tunnel or from the LAN they need `DEV_KEY` like in production.

| Command | What |
|---|---|
| `npm run dev` | server (tsx watch) + web (Vite on localhost); counts as development mode (dev routes open to this machine only; other clients need `DEV_KEY`) |
| `npm run dev:lan -w @all-ayes/web` | the Vite dev server on every interface (`vite --host`), for a phone on the same Wi-Fi |
| `npm test` | server + web: **657 server tests** (51 files: Quest-first headset seats, approvals and seal PINs, pricing, multi-room lodging and 12-person crews, city files + flight model + course + random voyages, fairness, privacy filter, negotiation rules, payments invariants, service rules, restart/restore, persistence, sweep and write queue, socket budgets, memory/voice fallbacks, limits, hardening, contract, end‑to‑end sockets) and **327 web tests** (48 files: the Quest start screens, the side panel, globe pins, MR recenter and alignment, socket store, reducers, phone hooks and screens (happy-dom), routing, error copy, formatting, seating, labels, scene/director and XR logic) |
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
| ElevenLabs | A voice per crew member (13 premade defaults — Captain George and a distinct mate per band 1–12 — work on any plan; `ELEVEN_VOICE_*` to override); spoken hails | Captions + browser speech; typed hails |
| MongoDB Atlas | Voyages persist and resume after restart | In memory |
| Backboard | Mates remember you across voyages | Local memory in MongoDB, or `DATA_DIR/memory.json` (default `apps/server/data`) |
| Visa Intelligent Commerce | Agent card + capped instruction (wire `visaVic.ts`) | Simulated with the same contract, labeled "Sandbox simulation" |
| Google 3D Tiles (`VITE_GOOGLE_MAP_TILES_KEY`, or a free `VITE_CESIUM_ION_TOKEN`; build-time) | Photoreal cities under the cloches | Paper low‑poly cities |

## Layout

```
packages/shared   types, socket events, constants (the contract)
apps/server       the helm: pricing & fairness, negotiation engine, privacy filter, payments, voice, memory, REST + sockets
apps/web          phones (React), headset (three.js + WebXR / webxr-polyfill: VR on an iPhone in a Gear VR shell, MR on a Quest), gallery
docs/             PRD, design language, UX, tech design, agent/payments/dataset specs, build plan, demo kit
```

## Deploy
See [`DEPLOY.md`](DEPLOY.md) — one Docker container (Render blueprint included) + the `allayes.tech` domain.

## Known limits
- Visa Intelligent Commerce needs credentials from Visa (token service, VIC, token requestor, MLE keys); until then payments run in a labeled simulation with the same contract (`apps/server/src/payments/visaVic.ts`).
- The headset is an **iPhone 16 Pro in a Samsung Gear VR shell** used as a plain lens viewer: 3DoF, no passthrough, and no USB link, so the shell's touchpad and Back button do nothing. Safari has no WebXR, so the page runs webxr-polyfill's Cardboard mode (side by side, head pose from the motion sensors; iOS asks for motion access on **Enter VR**). All input is gaze: a centre reticle and a 1.6 s dwell, which selects whatever it rests on (so picks and seals are safer on the organizer's phone). The chart room is VR only, the table at a fixed seated pose. The lens distortion uses Cardboard values, not measured for Gear VR lenses; **Lens spacing** in the menu or `?ipd=<mm>` fixes a double image. *Photoreal cities* is off by default in VR (heat, frame rate). A Galaxy phone on the shell's plug would add the touchpad. Setup and fixes: `docs/10-gear-vr.md`.
- The Quest mixed-reality path (`immersive-ar`, table placement/anchors, hand input, the side panel, globe spin and pins, the corner alignment, the MR recenter) is built and unit-tested but still to be verified on a Quest. The side panel's text is sized for ~15 mm at arm's length; some older in-scene labels are below the 12 mm target in doc 02 §4.2.
- The Docker image is built and smoke-tested (full Expo voyage in the container). Render persistent disk ownership and the polling fallback with WebSockets blocked haven't been verified end to end (see `docs/review/REVIEW-REPORT.md`, "Still open").
- The browser tile tokens (`VITE_GOOGLE_MAP_TILES_KEY`, `VITE_CESIUM_ION_TOKEN`) ship in the bundle; restrict them at the provider (DEPLOY.md, *Browser tile tokens*). Everything else still open after the round-2 fixes is listed in `docs/review-2/REVIEW-REPORT.md`, *Still open / needs outside help*.
- Passkeys are optional: members seal with a tap unless they chose **Add a passkey** (Wait or Brief screen); then *Set your seal* asks for it.
- Memory identity is a private **crew key** kept in the phone's browser storage (no accounts). It is minted at the first join and sent on later joins; the server keeps only its hash. Clearing the browser or switching phones starts a fresh memory, and two people sharing one browser share a key (their threads stay apart only by name).

## Honesty notes
- Trip inventory is curated sample data: the three original ports plus dozens of city files (stays and activities written by hand, prices are ballparks). Nothing is live inventory.
- **Flights are modelled**, except the original Lisbon / Mexico City / Montréal table from Atlanta, Chicago and New York: every other route and date window is priced by a deterministic formula (great-circle distance, a season factor per window, a hashed ±8 %), with plausible airlines and local times ([`docs/07`](docs/07-dataset-spec.md) §2b). They are illustrative, never quotes. A crew member within 150 km of a port has no flight ($0).
- Ports built from OpenStreetMap ("any city", [`docs/11`](docs/11-world-cities.md)) have modelled prices too, and carry the © OpenStreetMap contributors attribution.
- Payments run in simulation unless the Visa sandbox is wired — no real money moves.
- The scripted Expo voyage always leads to Lisbon by design (its numbers are pinned by tests); `/demo` seeds a random voyage by default to show the engine is generic.
- The project was started before the HackGT hacking window.
