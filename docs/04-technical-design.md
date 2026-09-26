# 04 — Technical Design

Scope: everything needed to build All Ayes in 36 hours with 2 people. Names here (collections, events, statuses) are canonical — docs 05/06/07 use the same ones.

---

## 1. Architecture

```
┌───────────────────────── Clients (one Vite + TS web app, route-split) ─────────────────────────┐
│                                                                                                 │
│  /xr → /t/:code/xr  iPhone in Gear VR shell · Safari   /t/:code/*   Phones   /t/:code/gallery    │
│  ├ three.js + webxr-polyfill (Quest: immersive-ar)     ├ React UI (logbook)          three.js    │
│  ├ scene/ (shared components, doc 02 §7)              ├ WebAuthn (passkey seal)     non-XR      │
│  ├ 3d-tiles-renderer (Dry Run cities)                 ├ MediaRecorder (hail audio)  orbit cam   │
│  ├ troika-three-text (SDF text)                       └ Audio playback (optional)               │
│  └ WebAudio (voices + sfx, spatialized per piece)                                               │
└──────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                           │ Socket.io over WSS  (+ REST for create/join/audio)
┌──────────────────────────────────────────▼──────────────────────────────────────────────────────┐
│  "The Helm" — Node.js 24 LTS + TypeScript, single process                                       │
│                                                                                                 │
│  api/        REST (express)          realtime/   socket.io rooms: trip:{id}, member:{id}        │
│  trips/      state machine (§5)      negotiation/ Advocates + Captain (doc 05), Gemini          │
│  fit/        pricing + fit (pure fn) payments/   all-or-nothing orchestrator (doc 06)            │
│  voice/      ElevenLabs TTS/STT      memory/     Backboard client (per member)                  │
│  dryrun/     day simulation builder  privacy/    output filter (budget/price guards)            │
│  data/       dataset loader (doc 07) store/      MongoDB repositories                           │
└──────┬──────────────┬───────────────────┬──────────────────┬──────────────────┬─────────────────┘
       │              │                   │                  │                  │
  MongoDB Atlas   Gemini API        ElevenLabs API      Backboard API     Visa Intelligent Commerce
  (state, logs)   (agents)          (TTS + STT)         (memory)          sandbox (or SIM mode)
                                                                           Google Map Tiles API (client)
```

**Design rules**
1. **Server is the source of truth.** Clients render `trip:state` + event stream; any client can reload and resume.
2. **LLMs never compute money or fit.** Pricing, shares, fit, fairness scores are pure deterministic TypeScript (`fit/`). LLMs only choose among and talk about tool results.
3. **Private data never enters a shared room.** Briefs, caps, shares, fit results only go to `member:{id}` rooms.
4. **Every external dependency has a fallback** (SIM payments, low‑poly city, captions‑only voice, cached demo lines).

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript everywhere | Shared types in `packages/shared` |
| Client bundler | Vite | HTTPS dev via tunnel (§10) |
| Phone UI | React 19 + React Router | Plain CSS with design tokens (doc 02); no UI kit |
| 3D | three.js (latest) | `renderer.xr.enabled = true`; a custom **Enter VR** button instead of stock `VRButton`/`ARButton` (styling) |
| XR features | **iPhone in a Gear VR shell (primary):** Safari has no WebXR, so the page loads `webxr-polyfill` (lazy chunk) in Cardboard mode: `immersive-vr` side by side with Cardboard lens distortion, head pose from `deviceorientation` (iOS motion permission asked in the **Enter VR** tap), a `local` reference space (3DoF), lens profiles for a Gear VR shell (narrow 58 / normal 62 / wide 66 mm, `?ipd=`). **Native `immersive-vr`** (e.g. Chrome for Android on a borrowed Galaxy) is used where offered. **Quest (optional):** `immersive-ar`; `local-floor` (required); `plane-detection`, `hit-test`, `anchors`, `hand-tracking` (optional) | The team has an iPhone 16 Pro and a Gear VR shell, no Galaxy phone and no Quest (doc 10). Mode order (`vrMode.ts detectXRMode`): AR if offered, else native VR, else the polyfill on a phone (or with `?vr=cardboard`), else the laptop view |
| Text in 3D | troika-three-text | SDF, Caslon/Source Serif/Plex Mono loaded as fonts |
| Fat lines | three `Line2` / `LineMaterial` | Ink lines with world‑space width |
| City tiles | `3d-tiles-renderer` (NASA‑AMMOS 3DTilesRendererJS) + Google Photorealistic 3D Tiles | Has WebXR guidance (override scheduling callback) |
| Server | Node.js 24 LTS (22+ works), Express, Socket.io | One process, in‑memory cache + Mongo persistence |
| DB | MongoDB Atlas (free/M0 fine) | Official `mongodb` driver; live state in memory with write‑through + reload on boot (`store/db.ts`) |
| LLM | Gemini (fast "Flash"‑class model available in AI Studio) via official `@google/genai` SDK | JSON‑schema structured outputs (P0); function calling for P1 "deeper" tools (doc 05 §6.3). Use a billing‑enabled key — free‑tier rate limits can stall a live demo. |
| Voice | ElevenLabs official JS SDK: streaming TTS (per‑crew voice), STT for hails | |
| Memory | Backboard REST API | Per‑member memory thread; confirm endpoints in their docs |
| Payments | Visa Intelligent Commerce sandbox (starter: `github.com/visa/mcp`, `github.com/visa/vic-reference-agent`) | SIM mode fallback (doc 06) |
| Passkeys | WebAuthn (`navigator.credentials`) with `@simplewebauthn/browser` + `/server` | Optional: a member adds one with **Add a passkey** (Wait/Brief); without one the confirm tap seals (LIVE-001) |
| Tests | Vitest | Pure logic + replay tests |
| Hosting | Any host with long‑lived WebSockets + HTTPS (Render / Railway / Fly / a VM) + `.tech` domain CNAME | WebXR and `deviceorientation` need a secure context (HTTPS) on the headset iPhone (motion sensors) and on a Quest |

---

## 3. Repository layout (monorepo, npm workspaces — as built)

```
all-ayes/
├─ docs/                      ← these docs (+ docs/review, docs/review-2: the review reports and task boards)
├─ scripts/bundle-budget.mjs  ← `npm run budget` (part of `npm run check`)
├─ packages/
│  └─ shared/                 ← the contract: types, socket events, constants (incl. shared copy), date labels
│     └─ src/{types.ts, events.ts, constants.ts, format.ts, index.ts}
├─ apps/
│  ├─ web/                    ← Vite app (phones, headset, gallery); tests: `vitest run src`
│  │  ├─ public/{favicon.svg, textures/type/*.woff}
│  │  └─ src/
│  │     ├─ main.tsx, router.tsx, styles/{tokens.css, phone.css}
│  │     ├─ net/{api.ts, session.ts, storage.ts, tripStore.ts, passkey.ts}  ← REST client, seats, socket store + outbox
│  │     ├─ phone/{TripContext.tsx, phase.ts, errors.ts, format.ts, memory.ts, seatClaims.ts, timing.ts,
│  │     │         useAsyncAction.ts, useNow.ts}
│  │     ├─ phone/screens/{Landing,Create,Demo,Join,TripShell,PhaseRoutes,Muster,Brief,Wait,
│  │     │                 Table,DryRun,Seal,Booked,Voided}.tsx
│  │     ├─ phone/components/{AddPasskey,BrassDial,crew,CrewMemberFields,Hail,JoinCrew,VoiceNote,SealRow,
│  │     │                    organizer,money,ui,icons,illustrations}.tsx, useRecorder.ts, useTwoTap.ts, voices.ts
│  │     ├─ shared-ui/{seating,labels}.ts  ← seat angles and labels shared by the phone chart and the 3D table
│  │     ├─ scene/                ← shared by XR + gallery
│  │     │  ├─ Stage.ts, ChartTable.ts, Globe.ts, CrewPiece.ts, Ribbon.ts, Instruments.ts, DryRun.ts,
│  │     │  ├─ SealChart.ts, CityTiles.ts, Buttons.ts, land.ts, geo.ts, text.ts, materials.ts, audio.ts, tween.ts
│  │     │  ├─ seats.ts, layout.ts, props.ts, billboard.ts, copy.ts
│  │     │  ├─ SceneDirector.ts   ← maps server events → animations
│  │     │  └─ director/{context, CrewSeating, TurnPlayer, PhaseController, SealCeremony}.ts
│  │     ├─ xr/{XRPage.tsx, PairPage.tsx, XRApp.ts, placement.ts, input.ts, wristMenu.ts, debugOverlay.ts}
│  │     └─ gallery/{GalleryPage.tsx, GalleryApp.ts}
│  └─ server/
│     ├─ scripts/{build.mjs, warm-voice-cache.ts, docker-entrypoint.mjs}   ← esbuild → dist/index.js (`npm run start:prod`)
│     ├─ test/                 ← vitest (per-file temp DATA_DIR/CACHE_DIR)
│     └─ src/
│        ├─ index.ts, config.ts, web.ts            ← boot, env config + mode, headers/static serving
│        ├─ api/{routes.ts, passkeyRoutes.ts, debug.ts, devAccess.ts, http.ts}
│        ├─ realtime/io.ts                         ← typed socket.io server, validation, acks, limits
│        ├─ trips/service.ts                       ← TripService facade (the helm), extends trips/core.ts
│        ├─ trips/{core, records, crew, identity, table, dryrun, sealing, replay, persistence}.ts
│        ├─ fit/{pricing.ts, fairness.ts}          ← pure functions, unit tested
│        ├─ negotiation/{engine.ts, rules.ts, prompts.ts, phrasing.ts, gemini.ts}
│        ├─ privacy/{filter.ts, guard.ts, context.ts}
│        ├─ dryrun/walking.ts
│        ├─ voice/voice.ts                         ← ElevenLabs TTS/STT + content-addressed mp3 cache
│        ├─ memory/{memory.ts, bands.ts}           ← Backboard + local store, keyed by crew key; budget bands
│        ├─ payments/{orchestrator.ts, provider.ts, sim.ts, visaVic.ts, select.ts}
│        ├─ passkeys/passkeys.ts
│        ├─ data/{loader.ts, dataset.json}
│        ├─ demo/seed.ts
│        ├─ store/{db.ts, writeQueue.ts, eventBuffer.ts, lease.ts, reconnect.ts, restoreRetry.ts, hooks.ts, normalize.ts}
│        └─ util/{limits.ts, errors.ts, ids.ts, text.ts, timeout.ts, jsonStore.ts}
```
**Server modules (OPT-031).** `TripService` (trips/service.ts, ~100 lines) is the one facade io.ts, routes.ts and the tests use. It extends `HelmCore` (trips/core.ts: record maps, emits and the debug/audit log, `transition`, `save`/`persistTurn`, O(1) indexes, auth, sweep) and delegates to: `crew.ts` (create, join, absent seats and invites, briefs, sail without them), `identity.ts` (headset pairing, demo handoffs), `table.ts` (chart book and privacy context, the meeting, hails, the Two Charts), `dryrun.ts` (votes, auto-pick, the shared clock), `sealing.ts` (pick, seals, call-off, retry, the outcome, memory notes), `replay.ts` (`trip:state` and replay) and `persistence.ts` (restore/repair, reconnect sync, `hydrate`). Types, constants and pure helpers are in `records.ts`.

---

## 4. Data model (MongoDB)

As built (WP-10, TR5-014). All money is **integer cents**. Times are ISO strings (UTC) unless marked *epoch ms*. IDs are `nanoid(12)` strings. Optional fields are **absent**, never `null` (the driver runs with `ignoreUndefined`, and restore strips `null`s written by older builds — TR5-010); the only fields whose "none" value is `null` are `trips.autoPick` (absent until the first vote in DRY_RUN; restore fills a missing one with `null`) and `dryrun.pausedAt`.

**How it is written** (`apps/server/src/store/`). The helm keeps live state in memory and writes through:
- `persist(col, doc)` is typed per collection. Writes are **ordered and coalesced per document**: one write in flight per `(collection, _id)`; persists arriving meanwhile mark it dirty and the latest snapshot (a `structuredClone` taken at dispatch) is written next, so an older state never lands after a newer one (TR5-005/OPT-041).
- Documents with a numeric `version` (`trips`, `bookings`) are written with the guard `{_id, version ≤ doc.version}`: an older snapshot of *this* helm is skipped, never replaces a newer one. The guard only orders one writer's snapshots; it doesn't make a second instance safe (that is the single-writer lease below).
- **Single writer (L5-002).** Restore voids every live booking and resets every running table, so exactly one helm may run against a database. Deploys keep the Render disk (no zero-downtime overlap) and one instance (DEPLOY.md). Backstop: a lease document (`helm_lease` `{_id:"helm", owner, expiresAt}`, 30 s TTL, renewed every 10 s, `store/lease.ts`); a new instance waits for it before restoring (or, after a failed boot connect, before merging), writes nothing without it, and an instance that loses it stops writing. A lost lease or any stale-skipped write reports `degraded`.
- Failed writes are retried with exponential backoff (250 ms → 30 s, 8 attempts), then parked; parked writes are retried after any later successful write, every 45 s while any are parked, on reconnect, and on the next persist of that document (L5-001). A shutdown logs every parked `(collection, _id)`. A unique-key clash other than `_id` is parked for good; a duplicate `joinCode` (an archived voyage holds it) gives the voyage a new code and saves it again (L5-010). `/api/health` → `persistence: {mode, degraded, reconnectAttempts, writes: {pending, inFlight, retrying, failed, totalWrites, totalFailures, staleSkipped, lastError}, eventErrors}`; `degraded` is the alarm.
- MongoDB unreachable at boot: the helm starts in memory, logs loudly and **retries the connect in the background** (1 s → 60 s backoff); when it connects it merges the stored voyages it doesn't hold and writes everything it holds (TR5-007). Index creation is separate from connecting: an index error is logged, persistence stays on. `NODE_ENV=production` without `MONGODB_URI` logs an error and reports `degraded`.
- **Restore (boot)** loads every AT_TABLE and SEALING voyage whatever its age, BRIEFING and DRY_RUN voyages touched within `VOYAGE_STALE_DAYS` (default 30), and any voyage updated in the last `RESTORE_RECENT_DAYS` (default 7) (R2-WP-11), with their members, briefs, bookings, the current round's turns, their Two Charts (`shortlists`) and recent events, plus every unsettled booking (so no hold is forgotten). Older voyages stay in MongoDB and load on demand (`TripService.hydrate`, by id or join code; a sync lookup that misses answers `503 LOADING` "try again" while it loads, a code the database doesn't know is a plain 404) (TR5-016). Each voyage restores on its own: one that can't be restored is logged and skipped (TR5-002).

### 4.1 `trips`
```ts
interface Trip {
  _id: string;                 // tripId
  joinCode: string;            // 6 chars from [A-HJ-NP-Z2-9] (no 0/O/1/I), unique
  name: string;                // ≤ 40 chars
  status: "BRIEFING"|"AT_TABLE"|"DRY_RUN"|"SEALING"|"BOOKED"|"VOIDED";   // §5 (created straight into BRIEFING)
  version: number;             // +1 on every save; the write guard above; transition() can check it (§5)
  organizerId: string;
  memberIds: string[];         // ordered = seating order
  removedMemberIds: string[];  // "sail without them" (not travelling, not priced)
  candidateCityIds: string[];  // the ports the organizer picked (2–3)
  negotiation: {               // the turn log itself is in `turns` (§4.6)
    watch: number; running: boolean; seq: number;
    round: number;             // table meetings so far; turns of an earlier (interrupted) meeting are never re-attached
  };
  tableRuns?: number;          // meetings started on this voyage; capped by TABLE_RUNS_MAX (default 6) → 429 TOO_MANY_RUNS
  shortlistIds?: [string, string];          // the Two Charts (planIds)
                                            // their plan bodies are in `shortlists` (§4.10, R2-WP-14); LEGACY docs embed
                                            // `shortlistPlans?: Plan[]` here, which still load (and move to `shortlists`)
  datasetHash?: string;                     // fingerprint of dataset.json when charted; a mismatch on restore is logged
  votes: Record<string, string>;            // memberId → planId (DRY_RUN)
  autoPick?: { planId: string; at: number /* epoch ms */ } | null;  // majority countdown (D5); absent before DRY_RUN
  dryrun?: { startedAt: number; pausedAt: number | null };          // Dry Run clock, epoch ms (TR5-011)
  chosenPlanId?: string;
  bookingId?: string;          // latest booking attempt
  attempt: number;             // booking attempts so far
  lastResult?: { bookingId: string; publicReason?: string };        // replayed as booking:result (TR3-003)
  tableReset?: { at: string; reason: string };                      // table interrupted → BRIEFING; told on join (TR5-021)
  headset?: { codeHash: string; expiresAt: number; deviceTokenHash?: string; deviceExpiresAt?: number };
                               // 8-char pairing code (HMAC under PAIRING_SECRET), 10 min, single use; device token 12 h (SEC-018/TR5-023)
  crewClosed?: boolean;        // organizer closed the crew to joins by code (SEC-010)
  createdAt: string; updatedAt: string;
}
```
Date windows and cities come from the dataset (doc 07), not the trip doc. R2-WP-14 (O2-036): the trip doc is small
(~0.8 kB) because it is rewritten on every save (votes, clock control, pick, seal outcome); the Two Charts' plan bodies
(~11 kB) are written once per decision, in `shortlists`.

### 4.2 `members`
```ts
interface Member {
  _id: string; tripId: string;
  name: string;                // ≤ 24 chars
  role: "organizer"|"member"|"absent";
  band: 1|2|3|4;               // color band (doc 02 §3.3); the Advocate's voice follows the band (config, not stored)
  origin: "ATL"|"ORD"|"JFK";   // home airport — server-only: never in CrewPublic or a prompt (S2-002)
  tokenHash: string;           // sha256 of the member session token
  inviteKeyHash?: string;      // absent-friend link (single use; cleared on claim or removal)
  crewKeyHash?: string;        // sha256 of the person's private crew key = their memory thread (doc 05 §9, SEC-003)
  briefSealed: boolean;
  standing?: { memberId: string; instructionRef: string; expiresAt: number /* epoch ms */ };
                               // absent member's standing instruction, restored with its ORIGINAL expiry (SEC-009); server-only.
                               // No limit (L5-007): restore re-derives it from the brief's cap; older docs that still carry
                               // `limitCents` are rewritten without it; a BOOKED voyage drops `standing` altogether
}
```
Passkeys live in `passkeys` (§4.10), memory threads are keyed by `crewKeyHash` (doc 05 §9); there is no `voiceId`, `backboardRef` or `webauthnCredentialId` on the member.

### 4.3 `briefs` (PRIVATE — never broadcast)
```ts
interface Brief {
  _id: string;                        // = memberId (one brief per member; re-sealing replaces it)
  tripId: string; memberId: string;
  capCents: number;                   // all-in cap — stored ONLY here (and as the limit of the provider instruction, doc 06 §3;
                                      // never in `members.standing` or a seal, L5-007 / TR5-015)
  dateWindowIds: string[];            // acceptable windows
  mustHaves: Tag[];                   // max 3
  dealbreakers: Dealbreaker[];        // max 3
  note?: string;                      // ≤ 200 chars
  noteSource?: "typed"|"voice";       // only with a note
  sealedAt: string;
}
type Tag = "beach"|"food"|"nightlife"|"museums"|"nature"|"chill"|"history"|"music";
type Dealbreaker = "red_eye"|"hostel"|"early_start"|"long_walks"|"layovers_2plus";
```

### 4.4 Options (dataset, not a collection)
Flights, hotels, activities, walk overrides and cities are read from `apps/server/src/data/dataset.json` (doc 07) at boot; nothing is seeded into MongoDB.
```ts
type Option = FlightOption | HotelOption | ActivityOption;
interface FlightOption  { _id; kind:"flight"; cityId; origin:"ATL"|"ORD"|"JFK"; dateWindowId;
  airline:string; departLocal:string; returnLocal:string; stops:0|1|2; redEye:boolean;
  priceCents:number; }
interface HotelOption   { _id; kind:"hotel"; cityId; name; neighborhood; lat; lng;
  stayType:"hotel"|"guesthouse"|"hostel"|"apartment"; nightlyCents:number; sleeps:number; rating:number; }
interface ActivityOption{ _id; kind:"activity"; cityId; name; tags:Tag[]; lat; lng;
  durationMin:number; priceCents:number; startEarliest:string; startLatest:string;
  role:"group"|"pick";           // group moment (everyone) vs pick (members whose must-haves match), doc 07 §6
  earlyStart?: boolean; }
interface WalkOverride  { fromId:string; toId:string; mode:"walk"|"tram"|"taxi"|"train"; minutes:number; note?:string; }
interface City          { _id:"LIS"|"MEX"|"YUL"; name; centerLat; centerLng; tileRadiusKm:number; publicFlags:string[]; }
```

### 4.5 Plans (computed, not a collection)
The chart book (top 12 plans, doc 05 §2.6) is **rebuilt deterministically** from the dataset and the crew's briefs when needed (`fit/pricing.ts`) and cached in memory. Only the Two Charts are stored, in the `shortlists` collection (§4.10; older trip docs embed them as `trips.shortlistPlans`), so a changed dataset can't re-price or lose them (TR5-022).
```ts
interface Plan {
  _id: string;                        // e.g. "LIS-W1-casa-alfama"
  cityId: string; dateWindowId: string; hotelId: string;
  days: PlanDay[];
  groupCents: number;                 // SERVER-ONLY exact total; the public view carries only `groupRange` (S2-002, §7.2)
  members: MemberPlanView[];          // PRIVATE per member when emitted: {memberId, flightId, amountCents, lines: ShareLine[], fits, reasons, covered, missing}
  fairness: { maximin: number; sum: number };
  fitsEveryone: boolean;
  publicFlags: PlanFlag[];            // internal: flags that apply to every member (the public view derives its own, S2-002)
}
interface ShareLine { label: string; amountCents: number; kind: "flight"|"lodging"|"activity"; }
type FitReason = "ok"|"over_cap"|"date_mismatch"|"no_flight"|"dealbreaker:red_eye"|"dealbreaker:hostel"|
                 "dealbreaker:early_start"|"dealbreaker:long_walks"|"dealbreaker:layovers_2plus";
```
Who backed which plan lives only in the engine's table state for that meeting (doc 05 §5); it isn't stored (OPT-007 dropped the write-only `advocatedBy` and `negotiation.endedReason`; older documents may still carry them, which is harmless).

### 4.6 `turns` (the log)
One document per turn, written when the turn is spoken (and again when its audio is ready), so the trip doc stays constant-size (TR5-012). Restore loads and attaches only the turns of the trip's current `negotiation.round` (older round-0 docs without `round` still match); replay sends the last 50. A new table round, and a table reset, delete the voyage's turns of earlier rounds (R2-WP-11, L5-008), so turns are not kept forever.
```ts
interface Turn {
  _id: string;                   // = turnId
  turnId: string; tripId: string;
  round: number;                 // trips.negotiation.round when spoken
  watch: 0|1|2|3; seq: number;   // seq restarts at 1 each round
  speaker: { kind:"advocate"; memberId:string } | { kind:"captain" } | { kind:"human"; memberId:string };
  act: "OPEN"|"PROPOSE"|"OBJECT"|"CONCEDE"|"SUPPORT"|"HAIL"|"DECIDE";
  planId?: string;
  cityId?: string;               // globe auto-rotates to this
  voiced: boolean;               // false for HAIL and whispers
  text: string;                  // after privacy filter
  ribbon: string;                // ≤ 8 words
  redactions: number;            // how many tokens the filter removed (for QA; asserted by the privacy tests)
  audioUrl?: string;             // /api/audio/:turnId, set with durationMs (TR4-015)
  durationMs?: number;
  audioKey?: string;             // SERVER-ONLY: the content-addressed mp3 in CACHE_DIR/tts; restore re-registers it, or clears audioUrl if it's gone
  createdAt: string;
}
```

### 4.7 `bookings` (seals embedded; see doc 06 for states)
Seals are embedded in their booking (one document per attempt, written atomically with it) rather than a separate `seals` collection: every seal transition and the booking status change are one write, and a booking has at most 4 seals. R2-WP-14 (O2-038): the changes of one synchronous step go out as one persist (a seal set with the booking's status; the settle point with every authorization intent, still queued before any provider answer), a seal change with no public effect (an authorization's answer) isn't written on its own (ALL_AUTHORIZED or ANY_DECLINED follows once every answer is in), and an announcement is written only when a public status changed.
```ts
interface Booking {
  _id: string; tripId: string; planId: string; cityId: string; attempt: number;
  status: "PENDING"|"AUTHORIZING"|"ALL_AUTHORIZED"|"CAPTURED"|"ANY_DECLINED"|"VOIDED";
  mode: "visa_sandbox"|"sim";
  groupCents: number;            // Σ seals.amountCents — SERVER-ONLY: never in BookingPublic (S2-002)
  reference?: string;            // "AA-LIS-4K2P"
  sealDeadlineAt?: string;       // seals not all set by then void the booking (SEC-011)
  settleAt?: string;             // S2-001: last seal set + SEAL_SETTLE_MS; authorizations start then, the outcome is published then
  needsAttention?: boolean;      // a release/refund the provider refused; re-driven on restore and retry (SEC-016)
  version: number;               // +1 on every write (the write guard); bumped only when written (not while MongoDB is off)
  seals: Seal[];
  createdAt: string; updatedAt: string;
}
interface Seal {
  memberId: string;
  amountCents: number;           // NO capCents: the cap stays in `briefs`; restore re-derives it for the instruction limit (TR5-015)
  status: "PENDING"|"AUTHORIZING"|"AUTHORIZED"|"DECLINED"|"CAPTURED"|"VOIDED";
  published?: string;            // last public status announced (SEC-002)
  standing: boolean;             // authorized by an absent member's standing instruction
  idempotencyKey: string;        // `${bookingId}:${memberId}`; provider calls append `:${op}` (doc 06 §5.3)
  instructionRef?: string; authRef?: string;          // provider refs
  declineReason?: "over_limit"|"timeout"|"provider_error"|"user_cancelled";   // private to the owner
  updatedAt: string;
  authorizeRequestedAt?: string; capturedAt?: string; releasedAt?: string; refundedAt?: string;   // durable intents (TR5-006)
}
```

### 4.8 `events` (append‑only audit; bounded)
`{ _id, tripId, type, audience: "trip"|"member:<memberId>", payloadRedacted, at: Date }` — one row per emitted event, inserted in batches (one unordered `insertMany` per 250 ms or 100 rows, flushed on shutdown; R2-WP-14 / O2-037). `payloadRedacted` is a short summary of **shared** payloads only (a turn's filtered text, or a status); member-room payloads are never recorded (`""`). Rows expire after 30 days (TTL index on `at`). On restore the recent rows re-fill the per-voyage debug log behind `/api/debug`. Insert failures are counted (`persistence.eventErrors`) and logged at most once a minute.

### 4.9 Indexes
`trips.joinCode` unique · `trips.{status, updatedAt}` · `members.tripId` · `briefs.{tripId,memberId}` unique · `bookings.tripId` · `bookings.status` · `turns.{tripId,round,seq}` unique · `events.{tripId,at}` · `events.at` TTL 30 d · `passkeys.memberId` · `spend.updatedAt` TTL 90 d (`store/db.ts ensureIndexes`)

### 4.10 `passkeys` and memory stores
- `passkeys`: `{ _id: credentialId (base64url), memberId, rpID, publicKey (base64url COSE), counter, transports?, createdAt }` — written on register and on every authentication (so the counter persists) (TR5-003). Also one passkey claim per member, `{ _id: "claim:<memberId>", kind: "claim", memberId, nonceHash, createdAt }` (S2-009). A seat reset tombstones both (no `publicKey` / `nonceHash`), and restore skips tombstones.
- `memories`, `backboard_assistants`: `{ _id: key, v }` — the local memory store when MongoDB is on (doc 05 §9). A booking's notes for the whole crew are one update (only the changed threads are written; R2-WP-14 / O2-041).
- `spend`: `{ _id: "day:<utcDay>" | "trip:<tripId>", gemini, tts, stt, backboard, tripId?, updatedAt }` — paid-call counters (§12 Limits, R2-WP-12); TTL 90 days on `updatedAt`.
- `helm_lease`: `{ _id: "helm", owner, expiresAt }` — the single-writer lease (§4 "Single writer", `store/lease.ts`).
- `shortlists` (R2-WP-14 / O2-036): `{ _id: tripId, tripId, round, planIds: [a, b], plans: Plan[], datasetHash?, at }` — SERVER-ONLY: the Two Charts as priced when the table decided (TR5-022; per-member shares, never broadcast). Written once per decision (a new decision replaces it). Restore attaches it only while `round` and `planIds` match the trip doc; otherwise the charts resolve from the chart book (and a voyage whose charts don't resolve goes back to BRIEFING).

### 4.11 Memory only, by design (L5-013)
Not stored, so a restart loses them on purpose: demo handoff codes (2 h; a restart means a re-seed) · passkey assertion challenges and assertion tokens (2 min) · pending hails and the per-member hail pacing · the engine's table state (who backed what) · rate-limit windows and the hydrate miss cache · the chart book and privacy context (rebuilt from briefs) · the per-voyage debug ring buffer and client logs (the audit rows in `events` refill it) · spend counters when MongoDB is off (with MongoDB they are in `spend`) · a pending headset code's secret when `PAIRING_SECRET` is unset. Live bookings don't survive a restart either: restore voids them (doc 06 §4.2).

---

## 5. Trip state machine (`transition()` in `trips/core.ts`, `TRANSITIONS` in `trips/records.ts`)

```
POST /trips ──create──► BRIEFING         (there is no DRAFT status: OPT-008 removed it)
BRIEFING ──organizer table:start, when every remaining member's brief is sealed──► AT_TABLE
          (members who never sealed can be removed first via "sail without them";
           at most TABLE_RUNS_MAX meetings per voyage, default 6 — then 429 TOO_MANY_RUNS)
AT_TABLE ──captain DECIDE (shortlist of 2)──► DRY_RUN
AT_TABLE ──table failed (engine error) / helm restarted mid-table──► BRIEFING   (recovery; tableReset set, told on join)
DRY_RUN ──plan:pick──► SEALING           (creates Booking attempt n, Seals PENDING)
DRY_RUN ──restore: a sealed brief is missing, or the Two Charts can't be resolved──► BRIEFING   (recovery)
SEALING ──booking CAPTURED──► BOOKED
SEALING ──booking VOIDED──► VOIDED     (a share didn't clear, the seal deadline passed, the organizer called it off,
                                        a capture failed and was refunded — doc 06 §5.2 — or the helm restarted
                                        mid-seal and nothing was left to capture: "nobody was charged")
BOOKED ──restore: the booking record says VOIDED──► VOIDED        (recovery; the booking is the source of truth)
VOIDED ──restore: the booking record says CAPTURED──► BOOKED      (recovery)
VOIDED ──"back to charts"──► DRY_RUN     (same shortlist)
VOIDED ──organizer edits brief──► BRIEFING  (re-negotiate; a new round, no old turns replayed. L4-002: another member's re-seal in VOIDED is refused BAD_PHASE, so "back to the charts" stays available)
VOIDED ──restore: a sealed brief is missing──► BRIEFING           (recovery)
```
Guards: every status change goes through `transition(t, to, {from?, expectVersion?})`, which checks the edge against this table (and the caller's expected current status); an illegal edge → `error {code:"BAD_PHASE"}` and nothing changes. `version` increments on every save; it guards persistence (§4) and `transition` rejects a stale `expectVersion` with `BAD_PHASE`. Clients don't send a version today: each action re-checks the current status on the server instead.

---

## 6. REST API

> As built (TR3-016: this table is checked row by row against `apps/server/src/api/{routes.ts, passkeyRoutes.ts, debug.ts}`; the code wins if they ever disagree). Organizer‑only operations take an **Actor** — `{memberId}` from an authenticated socket, `{token}` from a REST bearer header, or `{deviceToken}` from the paired headset — checked in one place (`requireOrganizer`, trips/core.ts). Every `/trips/:tripId/*` route first loads an archived voyage (`hydrate`) and answers `404 NO_TRIP` for an unknown one, before any auth check.

Base `/api`. JSON bodies ≤ 32 kB. Member auth = `Authorization: Bearer <memberToken>` (issued at create/join/claim/handoff; stored in `localStorage` under `aa:session:<CODE>`; a paired headset keeps its device token under `aa:headset:<CODE>`).

**Identity & sessions (WP-06).**
- **Crew key (SEC-003).** `POST /trips`, `POST /trips/:id/members` and the absent claim accept an optional `crewKey` and return `crewKey`: the one sent, if it is well formed (base64url, 32–128 chars), or a fresh 256-bit one. The phone keeps it in `localStorage` (`aa:crewKey`) and sends it on every later join. The server stores only `crewKeyHash`, and memory is keyed on it (doc 05 §9), never on name or airport.
- **Absent invites (SEC-004).** `invitePath` is `/t/CODE/brief#m=<id>&k=<key>`: a 256-bit key in the fragment, returned only once. The claim mints a member token that only the claimer holds, stores the claimer's crew key and burns the invite. A claim carrying the organizer's crew key is refused with `403 OWN_INVITE`, and the invite stays valid. A claim for a removed seat returns `BAD_INVITE`. The claim broadcasts `trip:state`: an invited seat carries `inviteOpen` in `CrewPublic` (`false` until claimed, then `true`), so the whole crew sees "opened" and Muster stops offering the spent link (L1-009, S2-012). The organizer still controls the channel the link travels over; delivering it out of band (email/SMS, or a key made on the friend's phone) is not built.
- **Seat reset (S2-009, S2-012).** `POST /trips/:id/members/:memberId/reset` (organizer, BRIEFING or VOIDED, never the organizer's own seat): the seat's member token stops working and its sockets are evicted, its passkeys and passkey claim are revoked (tombstoned in `passkeys`), and a fresh invite link is returned, which the rightful member claims like an absent friend's (any non-organizer seat). Sealed terms stay.
- **Passkey claim (S2-009).** Create, join, claim and handoff also set an HttpOnly, `SameSite=Strict` cookie `aa_pk_<memberId>` scoped to `/api/trips/<id>/passkey` (Secure over HTTPS): a 256-bit nonce, only its hash kept (`passkeys` doc `claim:<memberId>`), replaced at every claim. Registering a passkey needs it (`409 PASSKEY_UNBOUND` otherwise), so a member token alone (a screenshot, a copied link) can't bind someone else's authenticator; sealing is unchanged.
- **Demo handoff (SEC-004).** `/demo` links are `/t/CODE#as=<handoff>&m=<id>`. The handoff is a one-time code, 2 h TTL, held in server memory only and minted by `POST /demo/seed` (which needs `X-Dev-Key` in production). `POST /trips/:id/members/:memberId/handoff {code}` swaps it for that seat's member token. A wrong seat, reuse or expiry returns `403 BAD_HANDOFF`, and any failed attempt burns the code. A member token never appears in a URL.
- **Phone (SEC-019, TR1-002).** The phone reads a demo handoff only from the fragment (`#as=…&m=…`; a `?as=` query is ignored) and an absent invite from `#m=…&k=…` (older `?m=&k=` links still work), moves them into state and strips them from the address bar at once. If a phone already holds a different seat for that voyage, it asks before swapping ("Keep my place"). If it already holds that very seat, it just opens the voyage. A failed link never touches the saved seat. The `/demo#key=` dev key is read once, kept in `sessionStorage`, stripped from the URL and sent as `X-Dev-Key`; a `?key=` query is never stored (it would already be in request logs) and is only wiped from the address bar (S2-013).
- **Headset (SEC-018, TR2-010, TR5-023).** The headset code is 8 chars from `[A-HJ-NP-Z2-9]` (40 bits), single use and valid 10 min. It is stored as `HMAC-SHA256(PAIRING_SECRET, code)`. Without `PAIRING_SECRET` the secret is per process, so a pending code dies with a restart. The device token lasts 12 h, stops working when the voyage is BOOKED, and is revoked by a new pairing or by `DELETE /trips/:id/headset` (organizer phone; the old socket `headset:unpair` is gone, L3-004). The headset keeps its token under its own key, `aa:headset:<CODE>`, never the phone seat's.
- **Closing the crew (SEC-010).** Joins by code are refused once the table has met (`BAD_PHASE`) or once the organizer closed the crew (`403 CREW_CLOSED`; `trip:state.crewClosed`, `by-code.crewClosed`).
- **Removed members (TR4-001, TR4-020).** Every member action (`brief:submit`, `table:hail`, `plan:vote`, `seal:set`, `seal:cancel`) checks the seat is still held (`NOT_MEMBER` 403). `sailWithout` is idempotent. It drops the seat's vote, standing instruction, pending hail and unused invite, and evicts its sockets from `member:{id}`, so they stay as trip-room spectators with no member identity. Tallies count only seats still held.

| Method & path | Body | Returns | Notes |
|---|---|---|---|
| `POST /trips` | `{name, organizerName, band, origin, cityIds?, crewKey?}` | `{tripId, joinCode, memberId, memberToken, crewKey}` | Status → BRIEFING. `cityIds`: the ports (≥ 2 of `LIS`/`MEX`/`YUL`; omitted = all). 10/min per address |
| `GET /trips/by-code/:code` | — | `{tripId, joinCode, name, status, crew:[{memberId,name,role,band,briefSealed}], takenBands, crewClosed}` | Public info only. 60/min; 20 wrong codes/min |
| `POST /trips/:tripId/members` | `{name, band, origin, crewKey?}` | `{memberId, memberToken, crewKey}` | Join. `403 CREW_CLOSED`, `409 BAD_PHASE` once the table has met, `CREW_FULL`, `BAND_TAKEN` |
| `POST /trips/:tripId/absent` | `{name, band, origin}` (organizer) | `{memberId, inviteKey, invitePath}` | `invitePath` = `/t/CODE/brief#m=<id>&k=<key>`; shown once |
| `POST /trips/:tripId/absent/:memberId/invite` | — (organizer) | `{memberId, inviteKey, invitePath}` | Re-issue an unclaimed invite; the old link stops working (TR1-001). `404 NOT_FOUND`, `409 INVITE_CLAIMED` |
| `POST /trips/:tripId/absent/:memberId/claim` | `{inviteKey, crewKey?}` | `{memberToken, crewKey}` | Absent friend (or a reset seat) opens the link; sets the passkey-claim cookie. `403 OWN_INVITE` from the organizer's crew key, `403 BAD_INVITE` |
| `POST /trips/:tripId/members/:memberId/reset` | — (organizer phone) | `{memberId, inviteKey, invitePath}` | S2-009/S2-012 seat reset: token, sockets and passkeys revoked, fresh link. `404 NOT_FOUND` (organizer's own seat too), `409 BAD_PHASE` outside BRIEFING/VOIDED |
| `POST /trips/:tripId/members/:memberId/handoff` | `{code}` | `{memberToken}` | One-time `/demo` handoff (SEC-004); `403 BAD_HANDOFF` |
| `POST /trips/:tripId/headset-code` | — (organizer) | `{code, expiresAt}` | 8‑char code, valid 10 min, single use |
| `DELETE /trips/:tripId/headset` | — (organizer phone) | `{ok:true}` | Revoke the paired headset and any pending code (SEC-018) |
| `POST /xr/pair` | `{code}` | `{tripId, joinCode, deviceToken}` | Called from `<domain>/xr` on the headset (Safari on the headset iPhone, or Quest Browser); device token = organizer **controls**, no private data. 10 wrong codes/min per address |
| `POST /trips/:tripId/hail-audio[?kind=note]` | raw audio body (`Content-Type: audio/webm`…), `Content-Length` required, 1 byte … `HAIL_AUDIO_MAX_BYTES` (512 kB) | `{transcript}` (≤ 160 chars; ≤ 200 with `kind=note`, the Brief's dictated note, R2-WP-12 L1-005) | STT. Checked **before** the body is read: member, voice on (`501/503 NO_STT`), phase BRIEFING/VOIDED/AT_TABLE, length (`411`/`413`; empty `422 BAD_INPUT`), rate, budget. `502 STT_FAILED` |
| `GET /trips/:tripId/passkey` | — (member) | `{registered, required, canRegister}` | `registered` on this address; `required` = a passkey exists anywhere, so the seal gate will ask for one; `canRegister` = this phone holds the seat's passkey claim and nothing blocks adding one |
| `POST /trips/:tripId/passkey/register/options` / `…/register/verify` | — / `{response}` (+ claim cookie) | SimpleWebAuthn options / `{ok:true}` | One passkey per member per rpID: `409 PASSKEY_EXISTS`, `409 PASSKEY_ELSEWHERE` (production), `409 PASSKEY_UNBOUND` (no claim cookie: S2-009), `400 PASSKEY_FAILED` |
| `POST /trips/:tripId/passkey/auth/options` / `…/auth/verify` | — / `{response, bookingId}` | options / `{assertionToken}` | Token bound to member + booking + rpID, single use, 2 min; used by `seal:set`. `409 PASSKEY_MISSING`, `409 BAD_BOOKING` |
| `GET /audio/:turnId` | — | `audio/mpeg` | From the content-addressed TTS cache; 404 when gone (captions play) |
| `POST /demo/seed` | — (body ignored; `X-Dev-Key` outside dev mode) | `{tripId, joinCode, organizer, maya, dev: {memberId, memberToken, handoff}, headsetCode}` | The Expo voyage: 3 members, sealed briefs, Maya's memory, Dev's standing instruction; `handoff` = one-time link code |
| `GET /cities` | — | `[{cityId, name, notes}]` | The ports Create offers |
| `GET /health` | — | `{ok, eleven, degraded}`; with dev access also `mongo, persistence, gemini, backboard, payments, agentDecisions, expoMode, demoReplay, voyages, memory, budgets` | Public answer is liveness only (SEC-022) |
| `GET /debug/login` · `POST /debug/login` | — · form `{key, next}` | sign-in form · 303 + `aa_dev` cookie (1 h, HttpOnly, `Path=/api/debug`) | 10 failed sign-ins/min per address |
| `GET /debug/:tripId` | — (`X-Dev-Key` header or the `aa_dev` cookie; `?key=` is ignored) | HTML | By id or join code. Live event log, client logs, seals, and the helm summary (`debugSummary`: phase, watch, turns, table runs, booking status/reference, **needs attention**, **seal deadline**). Crew shown as `crew-xxxxxx`, no decline reasons |

There is no REST brief endpoint: terms are sealed with the socket event `brief:submit` (§7.1).

**Errors (WP-09).** Every error is JSON `{code, message}`, including an unknown `/api/*` route (`404 NOT_FOUND`, the router's last handler, before the SPA fallback). A voyage that doesn't exist is `404 NO_TRIP` before any auth check. One code → status map (`HTTP_STATUS` in `util/errors.ts`, TR3-013 / O2-025; `test/errors.test.ts` checks every code thrown in `src` is in it): `400` malformed request (`BAD_JSON` for unparsable JSON, `NOT_JOINED`, `PASSKEY_FAILED`) · `403` not allowed (`NOT_MEMBER`, `NOT_ORGANIZER`, `CREW_CLOSED`, `BAD_INVITE`, `BAD_HANDOFF`, `BAD_CODE`, `OWN_INVITE`, `FORBIDDEN`, `PASSKEY_REQUIRED`, `DEVICE_EXPIRED`; a member token is a capability, so a missing or wrong one is 403, not 401) · `404` `NO_TRIP`, `NOT_FOUND` · `409` conflicts with the voyage's state (`BAD_PHASE`, `CREW_FULL`, `BAND_TAKEN`, `INVITE_CLAIMED`, `CAPTURING`, `NEEDS_ATTENTION`, `SEAL_LOCKED`, `TOO_FEW`, `BRIEFS_PENDING`, `PASSKEY_MISSING` / `_EXISTS` / `_ELSEWHERE` / `_UNBOUND`, `BAD_BOOKING`, `CAPTAINS_CALLING`, `TABLE_OPENING`) · `411 LENGTH_REQUIRED` · `413 TOO_LARGE` · `422` invalid input (`BAD_INPUT`, `HAIL_AMOUNTS`) · `429` (`SLOW_DOWN`, `HAIL_WAITING`, `TOO_MANY_RUNS`) · `500 INTERNAL` · `502 STT_FAILED` · `503` (`NO_STT` — 501 when STT isn't configured —, `LOADING` = an archived voyage is still being loaded or MongoDB is reconnecting, try again; `HELM_FULL` = `MAX_LIVE_VOYAGES` reached). Socket-only codes (never an HTTP status): `TOKEN_REJECTED` on `trip:join` (§7.1), `UNKNOWN_EVENT`, `EXPIRED` (a queued action dropped by the client), `TABLE_INTERRUPTED`, `TABLE_FAILED`. A body that isn't a JSON object (text/plain, an array) is read as `{}`, never a 500. The web client's `api.*` always rejects with `ApiError(status, message, code)`, even for an HTML proxy page (502/504) or no network (`status 0`, `OFFLINE`).

---

## 7. Realtime protocol (Socket.io)

Namespace `/`. On connect the client sends `trip:join {tripId? | joinCode?, memberToken?, deviceToken?, surface:"phone"|"xr"|"gallery"}` (an archived voyage is loaded first).

**Source of truth (TR3-016).** `packages/shared/src/events.ts` is the contract; the tables below list every name in its exhaustive runtime lists `CLIENT_TO_SERVER_EVENTS` (14) and `SERVER_TO_CLIENT_EVENTS` (18), checked row by row. If they ever disagree, events.ts wins (and `contract.test.ts` fails first).
- **Phone** with `memberToken` → joins `trip:{tripId}` + `member:{memberId}`.
- **XR** with `deviceToken` → joins `trip:{tripId}` only, and is allowed organizer **control** events (`table:start`, `table:hail` as the organizer, `dryrun:control`, `plan:pick`, `booking:retry`, `booking:callOff`). It **never** joins a member room, so it can't receive anyone's private data — important because a judge wears it at Expo.
- **Gallery** (no token, usually by `joinCode`) → joins `trip:{tripId}` only, read‑only. There is no Gallery debug key: the debug view is `/api/debug/:tripId` (§6).

**Contract & transport (WP-09).**
- **Typed contract (OPT-062).** `packages/shared/src/events.ts` is the single source: the server is `Server<ClientToServer, ServerToClient, …, SocketData>`, the service's `Bus`/`toTrip`/`toMember`/`replay` take `keyof ServerToClient` with the matching payload, and `toTrip` only accepts `TripRoomEvent` (no `PRIVATE_EVENTS`, no `error`), so the privacy rule is a compile-time check as well as the runtime guard. `SERVER_TO_CLIENT_EVENTS` / `CLIENT_TO_SERVER_EVENTS` are the exhaustive runtime lists; `apps/server/test/contract.test.ts` checks every emitted event is in the contract, every client → server event has an io.ts handler and every server → client event a tripStore handler.
- **Acks and errors (TR3-007).** Every client → server event may carry a socket.io ack as its last argument. The server answers it exactly once: `{ok:true}` (also when the action changed nothing), or `{ok:false, code, message}`. A refusal is also sent to the caller as `error {code, message, event}`, where `event` names the action it answers. Payloads are validated in io.ts: a wrong type is `BAD_INPUT`, never a crash or a logged stack (SEC-020). An unknown `dryrun:control` action is `BAD_INPUT` (it used to be a silent no-op).
- **Transports (TR3-008).** The client tries WebSocket first and falls back to HTTP long-polling (`tryAllTransports: true`); the server accepts both. Both go through the Vite dev proxy (`/socket.io` with `ws: true` proxies the polling requests too) and through cloudflared.
- **Offline outbox (TR3-009, L3-003).** Actions tapped while disconnected **or connected but not yet joined** are queued, one per event name (a newer tap replaces the older), at most 20, each for 30 s. They are sent once the server has acknowledged this connection's `trip:join` (the store's `joined` flag, cleared on disconnect; the ack's `as` is kept as `role`); older ones are dropped and their ack answered `EXPIRED`. A refused join fails the queue with its refusal. `client:log` is never queued.
- **Join retries and reconnects (L1-002, L5-004, O2-049).** A join refused with `LOADING` (503: the voyage is being fetched, or MongoDB is reconnecting) is re-sent after 1, 2, 4, 8, then every 10 s while connected, keeping the queue; the `LOADING` notice is cleared when the join lands. The phone's by-code lookup retries `LOADING` the same way. `NO_TRIP` on the phone offers "Back to the start", which forgets that seat and Landing's "Back to voyage". Each new connection starts with no `error` (join-time notices arrive after it). socket.io's reconnect delay grows from 1 s to 10 s. REST calls time out after 15 s (`TIMEOUT`, 60 s for hail audio) and take an `AbortSignal` (`ABORTED`) (O2-048).
- **Unknown events (L3-004).** An event name outside `ClientToServer` that carries an ack is answered `{ok:false, code:"UNKNOWN_EVENT"}` (never left hanging). `trip:join` naming neither `tripId` nor `joinCode` is `BAD_INPUT` (L3-005).

### 7.1 Client → Server
| Event | Payload | Who | Effect |
|---|---|---|---|
| `trip:join` | `{tripId?, joinCode?, memberToken?, deviceToken?, surface}` | all | Join rooms, then the replay (§7.3); the ack follows the replay proper, before a slow memory recall's second `brief:private` (L3-002). Ack `{ok:true, as:"member"\|"device"\|"spectator", tokenRejected?:"member"\|"device"}` (R2-WP-07). A token that was sent but not accepted still joins as a spectator, but the caller first gets `error {code, event:"trip:join"}`: `TOKEN_REJECTED` (member token matches no seat; the phone shows its "Join again" card) or `DEVICE_EXPIRED` (headset replaced by a newer pairing, unpaired, or past its 12 h TTL; the headset forgets its key and shows the pairing card). Not sent for a headset once the voyage is BOOKED. A headset whose pairing ends mid-session gets `DEVICE_EXPIRED` (not `NOT_ORGANIZER` / `NOT_MEMBER`) on its next organizer action or hail. Copy: `JOIN_REFUSAL` in events.ts |
| `brief:submit` | `Brief` fields | member | Save; `brief:private` to the owner, then `trip:state` (its crew shows `briefSealed`, no content) |
| `table:start` | `{}` | organizer phone / xr | BRIEFING→AT_TABLE (if every remaining member sealed: `BRIEFS_PENDING`; ≥ 2 crew: `TOO_FEW`) and start engine. `TOO_MANY_RUNS` (429) after `TABLE_RUNS_MAX` meetings (default 6) |
| `table:sailWithout` | `{memberIds}` | organizer phone / xr (no headset UI) | Remove those members from the voyage (`trip.removedMemberIds`); not priced, not charged |
| `table:hail` | `{text}` (after STT if spoken) | member / xr (as organizer) | Queue HAIL turn (not voiced); amounts removed. Refused with a private `error` (`TABLE_OPENING` during the Captain's OPEN, Watch 0; `HAIL_WAITING` one still waiting; `HAIL_AMOUNTS` only an amount; `CAPTAINS_CALLING` Watch 3 / deciding; `SLOW_DOWN` within 5 s of the member's last hail, **refused ones included**). Every non-public amount is stripped whatever the secrets are (S2-003) — doc 05 §4, §7.1 rule 8 |
| `dryrun:control` | `{action:"pause"|"resume"|"restart"}` | organizer phone / xr | DRY_RUN only (else `BAD_PHASE`). Updates the shared clock and broadcasts it; a no-op (pause while paused, resume while running) is not broadcast. As built only the headset sends it (tap the carriage clock: pause ⇄ resume); `restart` is accepted but no UI sends it, and there is no day jump (TR2-013) |
| `plan:vote` | `{planId}` | member | Shared tally (counts only) |
| `plan:pick` | `{planId}` | organizer phone / xr | DRY_RUN→SEALING. `NEEDS_ATTENTION` while an earlier booking of the voyage is unsettled (L4-001) |
| `seal:set` | `{bookingId, assertionToken?}` | member | Put the member's instruction on file: the seal is "set". Nothing is authorized yet — every seal is authorized together once the last one is set (S2-001, doc 06 §4.2). `assertionToken` is required only once the member has added a passkey (`PASSKEY_REQUIRED`); without one the confirm tap is enough (LIVE-001). `SEAL_LOCKED` (409) when the seal isn't PENDING any more (incl. a double tap) |
| `seal:cancel` | `{bookingId}` | member | "Lift my seal" while seals are being gathered: recorded privately as DECLINED `user_cancelled` (the owner gets `seal:declinedPrivate`), shown publicly as "set"; nothing voids mid-gathering. When the last seal is set the booking settles and voids at the settle point, with no hold ever placed (S2-001). `SEAL_LOCKED` (409) once every seal is set (settling, ALL_AUTHORIZED, CAPTURED) |
| `booking:retry` | `{}` | organizer phone / xr | VOIDED→DRY_RUN. Refused with `NEEDS_ATTENTION` while any booking of the voyage still owes a refund or holds an unreleased authorization (doc 06 §5.2, S2-010). If the Two Charts no longer resolve, the voyage goes back to BRIEFING instead (a new round) and the retry answers `BAD_PHASE` (L4-007) |
| `booking:callOff` | `{bookingId}` | organizer phone / xr | SEALING→VOIDED while seals are still being gathered: every hold is released, `booking:result` VOIDED with "The organizer called it off, so nobody was charged." A second call-off while it voids is ok. Refused with `CAPTURING` ("…every seal is set and the booking is settling") once every seal is set, whatever the outcome will be (doc 06 §5.2) |
| `crew:setOpen` | `{open}` | organizer phone / xr | Close (`false`) or reopen the crew to joins by code (SEC-010); broadcast as `trip:state.crewClosed`. `open` must be a boolean, else `BAD_INPUT` (L3-004) |
| `client:log` | `{level:"log"|"warn"|"error", msg, data?}` | member / paired xr | Stored in the debug ring buffer (XR has no devtools), 5/s per socket, fields capped; `data` is not kept. Fire and forget: never acknowledged (a trailing ack function is ignored, L3-004), never queued offline |

### 7.2 Server → Client (room)
| Event | Room | Payload |
|---|---|---|
| `trip:state` | trip | `TripState` = `{tripId, joinCode, name, status, version, organizerId, crew:[{memberId,name,role,band,briefSealed,inviteOpen?}] (no home airport, S2-002; `inviteOpen` only on a seat sent an invite link, S2-012), crewClosed?, candidateCities:[{cityId,name,lat,lng}], dateWindows, negotiation:{watch,running}, shortlistIds?:[A,B], votes?, autoPick?, chosenPlanId?, booking?:BookingPublic, paymentsMode, serverNow}`. Sent on every phase change and after a join / sealed brief (there is no separate `member:joined` / `brief:received`). `shortlistIds` only from DRY_RUN on: the plan bodies travel once, in `table:decided`. `chosenPlanId`/`booking` only in SEALING, BOOKED, VOIDED (after "back to the charts" the voided attempt is history). `serverNow` maps `autoPick.at` onto the device clock. **Live broadcasts omit the static `candidateCities` and `dateWindows`** (`TripStateUpdate`, R2-WP-14 / O2-040); the (re)join replay always sends the full `TripState`, and the client keeps the static fields for the same trip id |
| `brief:private` | member | `{brief, memory?}` (echo to owner). Sent at once; if the member's memory lines aren't ready within a tick, a second `brief:private` follows with `memory` |
| `table:watch` | trip | `{watch:1|2|3}`. `trip:state` is not re-sent per Watch: clients patch `negotiation.watch` from this (a rejoin gets it in `trip:state`) |
| `turn:new` | trip | `Turn` = `{turnId, tripId, seq, watch, speaker, act, planId?, cityId?, text, ribbon, voiced, audioUrl?, durationMs?, redactions, createdAt}` |
| `turn:audioReady` | trip | `{turnId, audioUrl, durationMs?}` (also on replay: `durationMs` is stored on the turn) |
| `table:decided` | trip | `{shortlist:[planA, planB] public view}` public view (`PlanPublic`) = `{planId,label,cityId,cityName,hotelId,hotelName,neighborhood,hotelLat,hotelLng,cityCenter,tileRadiusKm,dateWindowId,groupRange:{lowCents,highCents},fitsEveryone:boolean,publicFlags:[public flags only, no memberId],cityNotes, days:[{day,label,items:[{activityId,name,startMin,endMin,lat,lng,kind:"group"|"pick",leg?}]}]}`. `days` is **group-level only**: no member ids, no attendance, no per-member legs, no arrivals (SEC-001). `kind:"pick"` means "some of the crew" — who is never said. `leg` is crew-independent (stay or the preceding group moment → here, from public geography). **S2-002 — nothing here depends on who the crew are beyond the set of picks:** `groupRange` is the lowest–highest total any crew of this size could have for this city, stay, window and pick set (`publicTotalRange`, widened to $50; the exact total never leaves the helm); pick times/days are a layout from public facts (dataset order, from 09:00 on day 1, as one party), group moments keep their real times; labels are `Day 1`, `Day 2`; `publicFlags` come from the group route and the listings (`publicPlanFlags`: a long walk on a group leg, a group moment before 8am, every flight overnight). Each member's real times and exact share are in `plan:private`. `trip:state` carries only `shortlistIds`; clients keep the bodies from this event. |
| `plan:private` | member | `PlanPrivate` = `{planId, amountCents, lines, fits, reasons, covered, missing, flags:[my flags], days:[{day,label,items:[{activityId,name,startMin,endMin,lat,lng,together,travel?}]}], arrival?:{landMin,atStayMin}}` — my own itinerary: only the items I attend, my own legs and my own arrival. `together` = a whole-crew moment. |
| `dryrun:script` | trip | `DryRunScript` = `{planIds, dayStartMin, dayEndMin, minPerSec, startedAt?, pausedAt?, serverNow?}` — a shared clock, not segments: each client animates both charts' public `days` (from `table:decided`) at `minPerSec` from `startedAt` (mapped with `serverNow`) |
| `dryrun:control` | trip | `{action, at, startedAt, pausedAt, serverNow}` — the resulting shared clock (server ms). Clients apply `startedAt`/`pausedAt` mapped with `serverNow`, like `dryrun:script`, never their receive time |
| `plan:votes` | trip | `{tallies:{[planId]:number}, autoPick?:{planId, at}|null, serverNow}` |
| `plan:myVote` | member | `{planId|null}` — the chart this member voted for; sent on each vote and on replay in DRY_RUN (private: listed in `PRIVATE_EVENTS`) |
| `booking:created` | trip | `BookingPublic & {serverNow}` = `{bookingId, planId, attempt, status, mode, reference?, seals:[{memberId,status,standing?}], sealDeadlineAt?, serverNow}` — no group total: the chosen chart's exact total would undo `groupRange` (S2-002). `sealDeadlineAt` only while seals can be set (PENDING/AUTHORIZING); the phone maps it onto its own clock with `serverNow` for the "Seals close in 9:41" countdown. Always precedes any `seal:status` for that booking: standing (absent-member) seals start only after it is sent |
| `seal:private` | member | `{bookingId, amountCents, lines, fits, cardLast4, mode}` (`cardLast4` falls back to "••••") |
| `seal:status` | trip | `{bookingId, memberId, status}` (no amounts). Public statuses carry no authorization outcome: `PENDING` → `AUTHORIZED` (= "set", sent when the member taps, lifts, or a standing seal starts) → `CAPTURED` or `VOIDED` for every seal together, in seat order, at the settle point (last set + 2.5 s, S2-001); `DECLINED`/`AUTHORIZING` are never sent (doc 06 §7, SEC-002). `trip:state.booking` follows the same rule: while the outcome is held it reads AUTHORIZING with every seal set (a momentary `ANY_DECLINED` reads `VOIDED`) |
| `seal:declinedPrivate` | member | `{bookingId, reason}` (owner only) |
| `booking:result` | trip | `{bookingId, status:"CAPTURED"|"VOIDED", reference?, publicReason?}` (replayed in BOOKED / VOIDED, after `booking:created`) |
| `table:failed` | trip | `{code:"TABLE_FAILED", message}` — the table failed and the voyage went back to BRIEFING (a `trip:state` follows). A neutral public notice: phones and the headset show it, the Gallery ignores it (TR3-007) |
| `error` | caller | `{code, message, event?}` — a refusal of the caller's own action; `event` names it (the same refusal also answers the ack). Never sent to a room (a failed table is `table:failed`). Also `TABLE_INTERRUPTED` on `trip:join` (no `event`) |

### 7.3 Reconnect/resume
On `trip:join`, the server first joins the rooms, then finishes every wait (one tick for the member's memory lines, their card digits), then sends the whole replay in one pass from the voyage as it is *then* (L3-002: a pick, void or retry during the wait is never replayed stale; the socket, already in its rooms, got it live), then the join ack. In order: `table:decided` (DRY_RUN and later, so the `shortlistIds` in the snapshot resolve at once) → `trip:state` → `error {code:"TABLE_INTERRUPTED"}` (BRIEFING within 6 h of an interrupted table, TR5-021) → last 50 `turn:new` (+ `turn:audioReady` with `durationMs`) → `dryrun:script` (if DRY_RUN) → `booking:created` (SEALING, BOOKED, VOIDED) → `booking:result` (BOOKED, VOIDED) → for a member only: `brief:private`, `plan:private`, `plan:myVote` (DRY_RUN), `seal:private`, `seal:declinedPrivate` → **the join ack** → (only if the memory recall took longer than a tick) a second `brief:private` with `memory`. Clients are idempotent on `turnId`/`seq`, and a replayed `booking:created` for the same booking keeps its result.

---

## 8. Key sequences

### 8.1 Negotiation (happy path)
```
Organizer(xr)   Server/Engine            Gemini              ElevenLabs          All clients
   │ table:start │                         │                    │                    │
   │────────────►│ status AT_TABLE ────────┼────────────────────┼──── trip:state ───►│
   │             │ Captain OPEN (JSON) ───►│                    │                    │
   │             │◄──── line (JSON) ───────│                    │                    │
   │             │ privacy.filter(line)    │                    │                    │
   │             │ persist Turn ───────────┼────────────────────┼──── turn:new ─────►│ (caption+ribbon now)
   │             │ tts(line, voice) ───────┼───────────────────►│                    │
   │             │◄──────── mp3 stream ────┼────────────────────│                    │
   │             │ cache /api/audio/:id ───┼────────────────────┼─ turn:audioReady ─►│ (XR plays spatial audio)
   │             │ for watch 1..3: for each advocate: act → filter → persist → emit → tts
   │             │ (next turn LLM call starts while current audio plays — pipelined)
   │             │ Captain DECIDE → fairness.rank → shortlist[2]
   │             │ status DRY_RUN ─────────┼────────────────────┼─ table:decided ───►│
   │             │                         │                    │  plan:private ──►  (each member room)
   │             │ dryrun.simulate(A,B) ───┼────────────────────┼─ dryrun:script ───►│
```
Pacing: the engine waits for `max(audioDuration, 2.5 s)` before emitting the next turn so speech never overlaps; while waiting it has already prefetched the next LLM output.

### 8.2 Seal (all‑or‑nothing, collect then settle) — detail in doc 06
```
plan:pick → Booking(attempt n, PENDING, sealDeadlineAt = now + SEAL_DEADLINE_MS) + Seals PENDING
   → booking:created {…, sealDeadlineAt, serverNow} + seal:private to each → standing (absent) seals are SET at once
member seal:set → passkey gate (only if the member added a passkey; else the confirm tap) → instruction on file
   → Seal "set" (public seal:status AUTHORIZED at once; nothing is authorized yet — S2-001)
member seal:cancel ("Lift my seal") → privately DECLINED user_cancelled; publicly still "set"
when the LAST seal is set → settleAt = now + SEAL_SETTLE_MS (2.5 s × PACE_SCALE)
   → provider.authorize(amount) for every seal at once (none if one was lifted), wait for every answer (15 s timeout)
   → all AUTHORIZED → ALL_AUTHORIZED → provider.capture(all) → CAPTURED → BOOKED
     (a failed capture refunds what was captured and voids the rest — doc 06 §5.2)
   → any DECLINED/timeout → ANY_DECLINED → provider.void(all held) → VOIDED
   → published at settleAt (or later for everyone if the provider is slower): every seal CAPTURED or VOIDED together,
     then booking:result; only the owner of a declined seal learns why (seal:declinedPrivate)
before every seal is set: the seal deadline or booking:callOff → void everything → VOIDED at once (not attributable)
```

---

## 9. Client implementation notes

### 9.1 XR bootstrap (`xr/XRApp.ts`)
The headset page picks its session in this order (doc 10 has the hardware side):

| Browser offers | Session | Used on |
|---|---|---|
| `immersive-ar` | MR on the real table (below) | Quest 3, if one turns up |
| `immersive-vr` (native) | VR chart room, `local` reference space, 3DoF | A browser with native WebXR VR, e.g. Chrome for Android on a borrowed Galaxy phone (doc 10 appendix) |
| neither, on a phone, or `?vr=cardboard` | `webxr-polyfill` Cardboard mode (`xr/cardboard.ts`): `immersive-vr` side by side with lens distortion, head pose from `deviceorientation` | **The iPhone 16 Pro in the Gear VR shell (primary)**; a laptop with the flag for testing (stereo, no head tracking) |
| none of the above, on a desktop | Laptop view (orbit camera, mouse) | Laptops |

**VR chart room (`immersive-vr`: the polyfill on the iPhone, or native)**
```ts
const session = await navigator.xr!.requestSession("immersive-vr", { optionalFeatures: ["local"] });
renderer.xr.setReferenceSpaceType("local");
await renderer.xr.setSession(session);
// opaque clear + the chart room around the table; the table sits at a fixed seated pose
```
- **Polyfill setup (`cardboard.ts`).** `webvr: false` (a stale WebVR display must not win), `cardboard: true`, the Cardboard settings/back‑arrow overlay off, the online device database off (the built‑in copy plus the modern iPhones added by screen resolution, e.g. iPhone 16 Pro 1206×2622 @ 460 dpi). Three viewer profiles model a Gear VR shell used as a plain Cardboard viewer (~100° lenses, the phone centred) at 58 / 62 / 66 mm lens spacing; distortion reuses Cardboard 2015's coefficients (the closest published profile, **not measured for Gear VR lenses**). `?ipd=<mm>` (50–75) replaces the *normal* profile; menu **Lens spacing** switches profiles mid‑session and is remembered. Framebuffer scale ≤ 0.75 and never above an effective pixel ratio of 2 (`vrBufferScale`: the 16 Pro's DPR‑3 panel renders at 2/3).
- **iPhone specifics.** No Fullscreen API: the polyfill presents in place, and the wearer hides Safari's toolbar (**aA → Hide Toolbar**). `DeviceOrientationEvent.requestPermission()` / `DeviceMotionEvent.requestPermission()` are called inside the **Enter VR** tap (`requestMotionPermission`); on denial the card shows `MOTION_DENIED` (*"Head tracking needs motion access…"*). No orientation lock: in portrait the page shows **"Turn your phone sideways"**. A Screen Wake Lock is taken where the browser has one (iOS 16.4+, Chrome 84+); older ones get the polyfill's video trick.
- **The room (`xr/vrRig.ts`).** No real table, so: a dark room (inward‑facing unlit cylinder in `PALETTE.room` #221C17), a walnut floor, a round walnut tabletop (r 0.64 m) on a pedestal, lit by the Gallery's warm hemisphere + key light (doc 02 §5). 4 extra draw calls. Opaque clear in `PALETTE.room`.
- **No placement.** The chart (scaled ×1.4 so it reads at phone‑VR resolution) sits 0.9 m ahead and 0.5 m below the eye at session start. **Recenter** (menu, or a 3.2 s gaze on the ship's wheel, `LONG_GAZE_MS`) re‑yaws the room to the current head direction. 3DoF only: no position, so nothing may need leaning in to read.
- **Input (`xr/gaze.ts`).** A gaze ray from the viewer pose drives a reticle and hover outline. In the shell the only input is a **1.6 s dwell** (`DWELL_MS`; a red ring fills) on the target; it acts on anything, including a cloche (a pick), so the organizer's phone is the recommended place for picks and seals. Also select: the session's `select` (screen tap, out of the shell), Enter/Space on a keyboard, and a Galaxy phone's touchpad when it's on the shell's plug. Leaving: dwell on the red **Exit VR** plaque below the table, menu → **Exit**, or Escape / Android Back → `session.end()`, back to the Enter card, pairing kept. VR‑only extras: the **Hail the table** tag on the table's near‑left edge (while hails are open) opens the HAIL THE TABLE card (four presets + Never mind), since a gaze can't pinch‑and‑hold.
- **Performance on a phone in a shell** (the iPhone 16 Pro has plenty of GPU; the limit is heat in a closed shell and the polyfill's extra distortion pass): target 60 fps in the Table, ≥ 45 in Dry Run. Keep draw calls < 100; framebuffer scale capped (above); low‑res textures (`?lowtex`, on with any `?vr=` and on phones); no real‑time shadows; instancing for beads/pins; **Photoreal cities off by default** (the paper city is cheap; tiles cost memory, network and heat); troika fonts preloaded before entry. The debug overlay shows fps so a hot phone is visible.
- The Gear VR shell's electronics (touchpad, Back, proximity sensor), its own browser (last updated 2018) and the Oculus runtime are not used: the iPhone can't connect to the plug, and neither the browser nor the runtime exposes WebXR.

**Quest (`immersive-ar`, optional)**
```ts
const session = await navigator.xr!.requestSession("immersive-ar", {
  requiredFeatures: ["local-floor"],
  optionalFeatures: ["plane-detection", "hit-test", "anchors", "hand-tracking"],
});
renderer.xr.setReferenceSpaceType("local-floor");
await renderer.xr.setSession(session);
renderer.setClearColor(0x000000, 0);   // transparent → passthrough visible
```
- Placement: `hit-test` source from viewer space; on select, create anchor (`frame.createAnchor`) if supported, else store pose.
- Plane detection used to snap chart height to table plane (y from detected plane).
- Frame budget: 72 Hz → ~13.8 ms; keep draw calls < 150 in Table, < 250 in Dry Run; use instancing for beads/pins; `renderer.xr.setFoveation(1)`.

**Both**
- Text: preload troika fonts before entering session (avoids hitch).
- Audio: `THREE.PositionalAudio` attached to each piece; unlock AudioContext on the **Enter VR** (or **Enter the chart room**) tap.

### 9.2 Dry Run tiles (`scene/CityTiles.ts`)
- `TilesRenderer` with Google Photorealistic 3D Tiles, from one of two sources chosen at build time: `VITE_GOOGLE_MAP_TILES_KEY` loads the root directly (`https://tile.googleapis.com/v1/3dtiles/root.json?key=...`, needs a Google Cloud billing account); otherwise `VITE_CESIUM_ION_TOKEN` (a free Cesium ion account, no card) asks `https://api.cesium.com` for ion asset 2275207 (the same Google tiles), and the tiles then load from `tile.googleapis.com`. Neither set → the paper city. The CSP allows both hosts. Place the tile set so the **city center** from the dataset (doc 07 §3, chosen to include the hotel and core stops) is at the cloche center.
- **Scale:** cloche inner radius is 12 cm → `metersToScene = 0.12 / (tileRadiusKm × 1000)`. Lisbon (1.5 km) → 8 cm per km; Mexico City (2.0 km) → 6 cm per km; Montréal (1.5 km) → 8 cm per km. A 30 m building ends up ~2 mm tall — a true miniature. Stops beyond the radius become rim arrows (doc 02 §7.6).
- Clip with a cylindrical clipping plane set (or shader discard by radius) to the cloche radius.
- Limit `errorTarget` (e.g. 20–40) and max memory; update tiles only when camera moves > 5 cm to save frames.
- In XR, override the tiles renderer scheduling callback to use the XR session's rAF (per library docs).
- **Attribution:** Google requires displaying tile attributions/logo — render a small paper tag under each cloche with the attribution text.
- Fallback `LowPolyCity.ts`: procedurally extrude blocks around dataset POIs on a paper disc with ink roads (a straight line between POIs, slightly jittered). Switch automatically if first tiles don't arrive in 4 s or on error.

### 9.3 Scene Director (`scene/SceneDirector.ts`)
Single place mapping server events → animation queue (so XR and Gallery behave identically). As built (OPT-033) the director keeps the store subscription, queue, interactables and caption, and hands the work to `scene/director/`: `CrewSeating` (pieces + seats), `TurnPlayer` (turns, voice, ribbons, shortlist marks), `PhaseController` (phase choreography, cloches, tiles, the void card) and `SealCeremony` (seal chart, pressed seals, standing seals, the tied roll with its reference tag). It reads only public state.
| Event | Animation |
|---|---|
| `trip:state` crew change | spawn pencil‑outline piece; outline → carved piece slides to seat once `briefSealed` |
| `table:watch` (→ `trip.negotiation.watch`) | compass pointer advance |
| `turn:new` | speaker tip + ribbon + caption; globe rotate to `cityId`; pencil arcs |
| `turn:audioReady` | play positional audio; ribbon text write‑on synced to duration |
| `table:decided` | bell; ink circles on 2 pins; cloches slide out |
| `dryrun:script/control` | clock + bead paths |
| `seal:status AUTHORIZED` | wax seal drop on member line (standing seals from `booking.seals[].standing`) |
| `booking:result` | CAPTURED → roll‑up + bell×2 + a paper tag with the reference; VOIDED → every set seal cracks together, then all lift (no seal singled out) |
| `error` (caller) | the refusal shows on the caption card in red for 3 s, then the previous line returns (controls surfaces only) |

### 9.4 Phone
- React screens keyed off `trip.status`; router redirect guard.
- Brass dial: SVG + pointer events; rotation angle → cents snapped to 5,000 (=$50).
- Hail audio: `MediaRecorder` (webm/opus) ≤ 10 s → `POST /hail-audio` → transcript → `table:hail {text}`.
- Passkey (optional, LIVE-001): sealing never registers one. A member without a passkey seals with the confirm tap. **Add a passkey** (Wait and Brief screens, only on phones with a platform authenticator, and only with the seat's passkey-claim cookie) registers one and never seals; once added, *Set your seal* asks for it (a cancelled prompt is a note, never a seal).

---

## 10. Dev workflow on the headset (no devtools assumption)

- WebXR needs a **secure context**. Recommended: tunnel a production-mode build — `npm run build`, `cloudflared tunnel --url http://localhost:8787`, then `APP_ENV=production SERVE_WEB=1 PUBLIC_BASE_URL=<tunnel URL> DEV_KEY=<32+ chars> npm run start:prod` (README *Run it*). For quick iteration a tunnel to Vite (`cloudflared tunnel --url http://localhost:5173` in front of `npm run dev`) also works: Vite proxies `/api` and `/socket.io`, binds to localhost only (`npm run dev:lan -w @all-ayes/web` = `vite --host` for a phone on the Wi-Fi), serves only `apps/web`, `packages/shared` and `node_modules` (`server.fs` strict + deny list, S2-005), and marks each proxied request with `x-dev-proxy-client` / `x-dev-proxy-host` so the helm can tell this machine from a tunnel or LAN client.
- Dev routes (`/api/demo/seed`, `/api/debug/*`, the `/api/health` details) open without `DEV_KEY` only to a loopback client (loopback socket and Host, no `Forwarded` / `Cf-*` headers, loopback proxy markers; `devAccess.ts isLoopbackRequest`). Through a tunnel or from the LAN they need the key: `/demo#key=<DEV_KEY>` (fragment only) or the debug sign-in.
- On the headset iPhone, Safari's Web Inspector works from a Mac over USB when the phone is out of the shell (iPhone: Settings → Apps → Safari → Advanced → **Web Inspector** on; Mac Safari: Develop menu → the iPhone). (A borrowed Galaxy: Chrome's `chrome://inspect` over USB.) In the shell there's no cable and no devtools. (A Quest would likely not be in developer mode either.) So:
  - `client:log` relays `console.*` from XR to server; view at `/api/debug/:tripId` on laptop.
  - In‑headset **debug overlay** (toggle in the menu): fps, draw calls, socket status, last event.
- Desktop iteration: Meta's **Immersive Web Emulator** Chrome extension fakes an XR session (pick a VR device for the native VR path); `?vr=cardboard` in a desktop browser shows the polyfill side‑by‑side view (no head tracking; `?ipd=` to test lens spacing); the Gallery view for scene logic.
- Not built: a `?fake=1` event-log replayer. Use a seeded Expo voyage (`/demo`) and the Gallery view instead; with no keys the whole table runs on templates in about a minute (`PACE_SCALE` shortens it).

---

## 11. Configuration (`.env`)
The full, commented list is `.env.example` (every key the code reads); DEPLOY.md explains the production ones. Everything is optional in development. There is one `.env`, at the repo root, for both apps: the server loads it itself (real env vars win), and Vite reads it with `envDir` set to the root (only `VITE_*` names reach the browser; `vite.config.ts` also reads `API_URL`, `VITE_ALLOWED_HOSTS`, `VITE_SOURCEMAP` and `PUBLIC_BASE_URL` from it). A blank line (`ELEVEN_VOICE_BAND1=`) means the default, the same as leaving the key out. The groups:
```
# Server & mode
PORT=8787
PUBLIC_BASE_URL=             # a real (non-localhost) host here ⇒ production mode (§12 "Production mode")
APP_ENV=                     # production | development (npm run dev counts as development)
DEV_KEY=                     # ≥ 32 chars in production; unlocks /api/demo/seed, /api/debug, /api/health details (X-Dev-Key)
CORS_ORIGINS=  SERVE_WEB=  WEB_DIST=
PAIRING_SECRET=              # HMAC key for headset pairing codes (random per process if unset)
WEBAUTHN_ORIGIN=  WEBAUTHN_RP_ID=     # passkeys; default PUBLIC_BASE_URL in production, the request origin in dev
# Storage
DATA_DIR=                    # default apps/server/data — local memory store when MongoDB is off (point at a persistent disk)
CACHE_DIR=                   # default apps/server/.cache — regenerable voice cache (tts/<sha1>.mp3)
RESTORE_RECENT_DAYS=7        # settled voyages younger than this are loaded at boot; older ones on demand
MONGODB_URI=  MONGODB_DB=all_ayes
# Providers
GEMINI_API_KEY=  GEMINI_MODEL=gemini-2.5-flash  AGENT_DECISIONS=rules   # rules | model (doc 05 §2.3)
ELEVENLABS_API_KEY=  ELEVEN_MODEL=  ELEVEN_STT_MODEL=scribe_v1
ELEVEN_VOICE_CAPTAIN=  ELEVEN_VOICE_BAND1..4=   # default George · Liam · Sarah · Chris · Jessica (premade, any plan; doc 05 §8)
BACKBOARD_API_KEY=  BACKBOARD_BASE_URL=
PAYMENTS_MODE=sim            # visa_sandbox falls back to sim (with a warning) until visaVic.ts is wired
VISA_VIC_API_BASE=  VISA_VIC_API_KEY=
SIM_DECLINE_MEMBER=  SIM_TIMEOUT_MEMBER=          # force a decline / timeout (tests, demo)
SEAL_DEADLINE_MS=600000      # seals not all set by then void the attempt (SEC-011)
TABLE_RUNS_MAX=6             # table meetings per voyage (TOO_MANY_RUNS)
# Demo
EXPO_MODE=true  PACE_SCALE=1  DEMO_REPLAY=live   # cached = replay the warmed Expo run (emergency only)
# Limits (§12 "Limits")
TRUST_PROXY_HOPS=  RATE_LIMITS=on  RATE_LIMIT_SCALE=1  HAIL_AUDIO_MAX_BYTES=524288
DAILY_CAP_GEMINI=3000  DAILY_CAP_TTS=1500  DAILY_CAP_STT=500  DAILY_CAP_BACKBOARD=3000
TRIP_CAP_GEMINI=150    TRIP_CAP_TTS=100    TRIP_CAP_STT=30    TRIP_CAP_BACKBOARD=60
VOYAGE_IDLE_HOURS=48  VOYAGE_DONE_DAYS=7  TTS_CACHE_MAX_FILES=3000  TTS_CACHE_MAX_DAYS=30
VOYAGE_LONE_HOURS=1  VOYAGE_STALE_DAYS=30  MAX_LIVE_VOYAGES=2000  CREATE_RATE_GLOBAL=60  CREATE_RATE_48=30   # R2-WP-11
SPEND_RESERVE_PCT=20  TRIP_MISS_RATE=20  PAIR_FAIL_RATE_48=30   # R2-WP-12
# Web (Vite)
VITE_GOOGLE_MAP_TILES_KEY=   # exposed to browsers (build time; restrict by referrer); needs a Google Cloud billing account
VITE_CESIUM_ION_TOKEN=       # exposed to browsers; the same Google tiles via Cesium ion asset 2275207 when no Google key is set
API_URL=  VITE_ALLOWED_HOSTS=  VITE_SOURCEMAP=   # dev proxy target, extra dev hosts, source maps (never shipped)
```
Settings that tests change at runtime (`SEAL_DEADLINE_MS`, `RESTORE_RECENT_DAYS`, `TABLE_RUNS_MAX`, `PAIRING_SECRET`, `VISA_VIC_*`) are read at call time (the function-valued entries in `config.ts`, e.g. `config.helm.sealDeadlineMs()`); everything else is read once at boot. `SEAL_SETTLE_MS` (2.5 s, doc 06 §4.2) is a constant in `payments/orchestrator.ts`, scaled by `PACE_SCALE`, not an env var.

---

## 12. Security & privacy
- Member tokens: 32 random bytes, only hash stored (`tokenHash`).
- Headset device token: separate from the Organizer's member token; control rights only, never joins a member room; expires after 12 h and when the voyage is BOOKED; revoked when a new headset code is paired or the organizer unpairs. Pairing codes are stored as an HMAC under `PAIRING_SECRET`.
- Crew keys (memory identity), invite keys and demo handoff codes: 256 random bits, hashes only on the server; links carry them in the URL fragment and the phone strips them on open (§6 "Identity & sessions").
- Private rooms enforced server‑side; unit test asserts no `trip:{id}` emit contains `capCents`, `amountCents`(per member), `fit`, `mustHaves`, `dealbreakers`.
- Server logs: redact briefs; never log caps.
- LLM prompts: Captain gets no caps; each Advocate gets only its own member's brief (doc 05 §3).
- Privacy output filter on every spoken line (doc 05 §7).
- Rate limits and resource bounds: see **Limits** below.

### Production mode (WP-08, `config.ts resolveMode()`)
The server is in production when `NODE_ENV=production` (the Dockerfile sets it), `APP_ENV=production`, or `PUBLIC_BASE_URL` names a non-localhost host; only `APP_ENV=development` can keep a tunnel URL out of it. Dev mode (open dev routes) needs an explicit signal: `APP_ENV=development`, `npm run dev`, or the test runner. In production the server refuses to start without `PUBLIC_BASE_URL` or with a `DEV_KEY` under 32 characters, sends HSTS, pins passkeys to `PUBLIC_BASE_URL`, rejects socket handshakes from foreign origins, hides source maps (404) and gates `/api/demo/seed`, `/api/debug/*` and the `/api/health` details behind `X-Dev-Key` (the debug page also accepts a 1 h sign-in cookie; `?key=` is never read). Every response carries the security headers from `web.ts` (CSP, `frame-ancestors 'none'`, nosniff, `Referrer-Policy: same-origin` — no Referer cross-origin, while the passkey status GET can still read its own origin (L3-007) —, COOP, Permissions-Policy). `npm run build` compiles the web app and the server (esbuild → `apps/server/dist/index.js`); `npm run start:prod` runs it and serves the web build.

### Limits (WP-07; `apps/server/src/util/limits.ts`)
One shared limiter (sliding window, state in a bounded LRU) keyed on the **real client address**: `X-Forwarded-For` counts only through `TRUST_PROXY_HOPS` trusted proxies (unset: 1 on Render/Fly, 0 elsewhere, so a bare host ignores the header). Express `trust proxy` and the socket limiter use the same rule. All limits scale with `RATE_LIMIT_SCALE`; `RATE_LIMITS=off` turns them off.

| Entry point | Limit (per client address unless noted) |
|---|---|
| `POST /trips` | 10/min per address (/64); `CREATE_RATE_48` (30)/min per IPv6 /48; `CREATE_RATE_GLOBAL` (60)/min for the server; `503 HELM_FULL` past `MAX_LIVE_VOYAGES` (see *Ceilings*) |
| `GET /trips/by-code/:code` | 60/min; 20 wrong codes/min |
| `POST /trips/:id/members` | 20/min |
| `…/absent/:id/claim`, `…/members/:id/handoff` | 10 failed tries/min each |
| `POST /xr/pair` | 10 wrong codes/min (right codes don't count, so venue NAT can't lock a valid code out); `PAIR_FAIL_RATE_48` (30) wrong codes/min per IPv6 /48. No global cap (R2-WP-12, S2-008: one let 30 /64s block every pairing) |
| `/trips/:id/*` (any voyage route) | `TRIP_MISS_RATE` (20) unknown voyage ids/min, counted before the MongoDB lookup (only misses count; a voyage in memory is never looked up); then `429 SLOW_DOWN` (R2-WP-12, S2-007). The hydrate miss cache is an LRU of 1,000 ids (1 min each) |
| `/trips/:id/passkey/*` | 30/min |
| `POST /trips/:id/hail-audio` | auth + phase (BRIEFING, VOIDED, AT_TABLE) + `Content-Length` ≤ `HAIL_AUDIO_MAX_BYTES` checked **before** the body is read; an empty clip is `422 BAD_INPUT` before any rate slot or STT budget (L1-010); `?kind=note` (the Brief's dictated note) keeps `NOTE_MAX_CHARS` (200) of the transcript, a hail `HAIL_MAX_CHARS` (160) (L1-005); 2 clips / 5 s and 6 / min per member; 2 uploads in flight |
| every other body | JSON ≤ 32 kB (413 before reading when `Content-Length` is larger); parser errors → 413/400, not 500 |
| socket connections | 120/min and 64 open; one message ≤ 64 kB |
| socket events | 60 per 10 s per socket |
| `trip:join` | 10/min per socket, 60/min per address, 20 wrong codes/ids per min per address |
| `table:hail` | 1 per 5 s per member, refused hails included (S2-003); one pending hail per member; none in Watch 0 (`TABLE_OPENING`) (service) |
| `table:start` | `TABLE_RUNS_MAX` meetings per voyage (default 6; `429 TOO_MANY_RUNS`), on top of the per-voyage spend caps |
| `client:log` | members and the paired headset only; 5/s per socket; level ∈ log/info/warn/error, fields capped; kept in the per-voyage debug ring buffer (400 lines), not persisted |

**Spend caps (SEC-005).** Each paid call is counted per voyage (`TRIP_CAP_*`) and per UTC day (`DAILY_CAP_*`) for Gemini, ElevenLabs TTS, ElevenLabs STT and Backboard; `0` switches a provider off. Over budget the call is not made and the no-key fallback takes over: template lines, captions + browser voice, "type your hail" (`NO_STT`), local memory. The voyage is carried through async work (socket handler → engine run → timers). `/api/health` shows only `budgets: {gemini, tts, stt, backboard}: "ok" | "reserve" | "capped"` (daily), never counts. STT calls time out after 15 s.

**Stored budgets and the reserve (R2-WP-12, L5-011 / S2-014).** With MongoDB the counters live in the `spend` collection: `{_id:"day:<utcDay>"}` for the whole server and `{_id:"trip:<tripId>", tripId}` per voyage, each `{gemini, tts, stt, backboard, updatedAt}`, replaced whole through the write queue and dropped by a TTL index 90 days after `updatedAt`. A set of counters is read once (today's at boot, a voyage's on its first paid call) and added to what was counted meanwhile; it is written only after that read, so a restart or a voyage's counters leaving the in-memory LRU carry on from the stored counts (a restart can let a few calls through while the read is in flight; the hail-audio gate waits for it, up to 2 s). `SPEND_RESERVE_PCT` (20 %) of each daily cap is held back for voyages past the table (DRY_RUN, SEALING, BOOKED): other voyages, and calls outside any voyage, stop at the cap minus the reserve (`budgets` then says `"reserve"`), so a burst of throwaway voyages can't switch voices and models off for a crew about to book. Without MongoDB the counters are in memory only.

**Bounded memory and disk (SEC-015, OPT-040).** Join codes and pending headset codes are indexed (O(1) lookups; a pairing guess is hashed once). A sweep every 15 minutes (`LIMITS.sweepIntervalMs`) evicts BRIEFING voyages idle for `VOYAGE_IDLE_HOURS` (a lone one — at most one seat, nothing sealed — after `VOYAGE_LONE_HOURS`), DRY_RUN ones idle for `VOYAGE_STALE_DAYS`, and BOOKED/VOIDED ones idle for `VOYAGE_DONE_DAYS` (with members, briefs, caches, debug lines, settled bookings, the SIM's records of them and the members' passkeys; a booking that still owes a release or refund stays until it clears; MongoDB copies stay and an evicted voyage opens again by link or code), and drops recomputable caches (chart book, privacy context, pending hails) of voyages settled for 2 h. The Dry Run clock itself is persisted on the trip (`trips.dryrun`, WP-10), so it survives both the sweep and a restart. Voice mp3s are written once to the content-addressed `CACHE_DIR/tts/<sha1>.mp3`; `/api/audio/:turnId` maps the turn to that file. The turn's `audioKey` is stored with it (server-only), so after a restart the audio still plays while the mp3 is cached; if it's gone, restore clears `audioUrl` and the turn plays as captions. The cache keeps at most `TTS_CACHE_MAX_FILES` files used within `TTS_CACHE_MAX_DAYS` (a hit refreshes a file), pruned at boot and hourly (the audio prune keeps its own hourly timer). HTTP requests must send headers within 10 s and finish within 60 s.

**Ceilings (R2-WP-11, S2-006 / L5-008).** At most `MAX_LIVE_VOYAGES` voyages are held in memory (`0` = no cap); past it `POST /trips` runs the sweep and, if still full, refuses with `503 HELM_FULL`. New voyages are rate-limited per address (/64, 10/min), per IPv6 /48 (`CREATE_RATE_48`/min) and for the whole server (`CREATE_RATE_GLOBAL`/min). Boot loads AT_TABLE and SEALING voyages whatever their age, BRIEFING and DRY_RUN ones touched within `VOYAGE_STALE_DAYS`, and anything touched within `RESTORE_RECENT_DAYS`; passkeys load per member with their voyage, and debug events per voyage. A new table round (and a table reset) deletes the voyage's turns of earlier rounds. A table cut short by a restart gives its run back (`TABLE_RUNS_MAX`); an engine failure still counts. The reconnect sync writes only what was in memory before the merge.
- Browser tile tokens (`VITE_GOOGLE_MAP_TILES_KEY`, `VITE_CESIUM_ION_TOKEN`) ship in the public bundle, so they must be restricted at the provider (Google: HTTP-referrer + Map Tiles API only + quota; Cesium ion: `assets:read`, asset 2275207, allowed URLs) — DEPLOY.md *Browser tile tokens* (S2-015; needs the account owner). Visa sandbox credentials are server‑only.

---

## 13. Performance & latency budgets

| Step | Budget | How |
|---|---|---|
| Gemini turn (text) | ≤ 2.5 s | Flash‑class model, short outputs (≤ 60 tokens), pipelining next turn during current audio |
| TTS first byte | ≤ 800 ms | Streaming endpoint; low‑latency model; cache |
| Whole negotiation (3 members + Captain: 8 voiced turns with early exit, 11 without) | ≤ 90 s; **Expo run ≤ 70 s** | Pipelining + 2.5 s min spacing; Expo mode ≤ 20 words/line at TTS speed 1.1 ≈ 6–7 s per line |
| Dry Run script build | ≤ 300 ms | Pure function |
| Seal auth per member | ≤ 3 s (timeout 15 s) | Parallel per member |
| XR fps | 72 (Table) / ≥ 60 (Dry Run) | Instancing, tile limits, foveation |

**Demo mode cache:** `apps/server/scripts/warm-voice-cache.ts` runs the expo scenario once, stores turns + mp3s; at Expo `DEMO_REPLAY=live|cached` lets us fall back to the cached run instantly if the network is bad. (Live is default; cached is the emergency button — be honest if asked.)

---

## 14. Testing strategy

| Layer | Tests |
|---|---|
| `fit/` pricing, shares, fit, fairness | Unit (Vitest): hand‑computed fixtures from dataset; rounding to cents; uneven room splits |
| `privacy/filter` | Unit: 40 adversarial lines ("they can only do $900", "nine hundred tops", "under eight hundred", "my friend's cap is 7-5-0"), must redact all; must not redact the public group-total ranges |
| State machine | Unit: every legal/illegal transition; version conflicts |
| Payments orchestrator | Unit with SIM provider: all approve; one decline; timeout; duplicate `seal:set` (`SEAL_LOCKED`); capture failure → refund + void; seal deadline; call-off; restore re-drive |
| Negotiation engine | Replay tests with recorded Gemini outputs (fixtures) → ends ≤ 3 Watches, shortlist has 2 distinct plans, no leaks |
| Socket privacy | Integration: spin server, connect 3 members + gallery + **xr device**, run seeded scenario, assert gallery and xr never receive `brief:private`, `plan:private`, `plan:myVote`, `seal:private`, `seal:declinedPrivate` (`PRIVATE_EVENTS`) |
| Contract | `contract.test.ts`: every emitted event is in `events.ts`, every client → server event has an io.ts handler, every server → client event a tripStore handler (web `net/contract.test.ts` too) |
| Web | `apps/web` vitest: tripStore reducers (skew mapping, replay, outbox, join state, static fields), routing policy (`phase.ts`), error copy, formatting, seating, labels, XR input picking, passkey flow (`net/passkey.test.ts`: sealing never registers), the dev server's `/@fs` deny list (`devServer.test.ts`); phone hooks and screens under happy-dom |
| E2E demo | `/demo` seed (`POST /api/demo/seed`) + manual checklist (doc 08 §7) |

As built (after round-2 fixes): `npm test` runs the server suite (40 files, 485 tests) and the web suite (33 files, 214 tests) — counts at commit `8adeee9`; `npm run check` = typecheck + tests + build + the bundle budget (`scripts/bundle-budget.mjs`). Web DOM tests (phone hooks and screens) run under happy-dom with `@testing-library/react`, opted in per file with `// @vitest-environment happy-dom`; every other web test runs in node. The table-running server test files set `PACE_SCALE=0` (no pacing; a hail is held for by event, not by time), so tables and the 2.5 s settle point run near-instantly; the S2-001 timing tests use real timers on purpose.
