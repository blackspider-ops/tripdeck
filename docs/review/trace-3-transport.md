# Traceability Layer 3: transport contract (client net layer ⇄ REST + Socket.io)

Repo `/Users/tejas/Downloads/untitled folder 3` @ befc070. This was a read-only review. I checked everything live against `localhost:8787` (and `:5173` through the Vite proxy) using curl, Python urllib and a throwaway `socket.io-client` script that has since been deleted. The live run seeded a demo voyage and took it through join → brief → table (the real engine ran) → vote → pause → pick → seal ×2 (with Dev on a standing instruction) → CAPTURED, then did a fresh reconnect as Maya.

Legend: ✅ match · ⚠️ matches the code but has a caveat (see the linked issue) · ❌ mismatch.

---

## A) REST matrix

Base: `fetch('/api'+path)` at api.ts:5. Content-Type is JSON unless the body is a Blob. `Authorization: Bearer <memberToken>` is sent when a token is passed. Server: `app.use('/api', apiRouter)` (index.ts:18), router-wide `express.json({limit:'64kb'})` (routes.ts:23), and an error handler that returns `{code,message}` + `HelmError.status` (routes.ts:173-177).

| client fn (api.ts:line) | method+path sent | body/query/headers sent | server route (routes.ts:line) | body fields read + validation | auth | response sent | client expects | Match? |
|---|---|---|---|---|---|---|---|---|
| `cities` :24 | GET /cities | — | :138 | — | none | `[{cityId,name,notes}]` (live ✔) | same | ✅ (the web app never calls it) |
| `createTrip` :26 | POST /trips | `{name,organizerName,band,origin,cityIds?}` | :40 | `name` (clean 40, default "Our voyage"), `organizerName` (clean 24, must be non-empty), `band`→`Number()` ∈1..4, `origin` ∈ ATL/ORD/JFK, `cityIds` array filtered to known ids, needs ≥2 if present (live: `["LIS"]` → 400 BAD_INPUT). Limited to 10/min/IP | none | `{tripId,joinCode,memberId,memberToken}` 200 (live ✔, `band:"1"` accepted) | same | ✅ ⚠️ TR3-005/015 |
| `tripByCode` :29 | GET /trips/by-code/:code | encodeURIComponent(code) | :50 | code upper-cased (live: lower-case ok) | none | `{tripId,joinCode,name,status,crew:CrewPublic[],takenBands}` (live ✔) | same | ✅ |
| `join` :33 | POST /trips/:tripId/members | `{name,band,origin}` | :56 | same as addMember: CREW_FULL, BAD_PHASE, BAND_TAKEN (live 400), BAD_INPUT origin (live `SFO` → 400) | none | `{memberId,memberToken}` (live ✔) | same | ✅ ⚠️ TR3-013 |
| `addAbsent` :36 | POST /trips/:tripId/absent | `{name,band,origin}` + Bearer | :62 | requireOrganizer({token}), then addMember | organizer | `{memberId,inviteKey,invitePath}` (live ✔; `/t/CODE/brief?m=&k=`) | same | ✅ ⚠️ TR3-013 (a missing trip gives 403, not 404) |
| `claimAbsent` :39 | POST /trips/:tripId/absent/:memberId/claim | `{inviteKey}` | :67 | `String(inviteKey??"")`, hash compare, single use (live second claim → 403 BAD_INVITE) | invite key | `{memberToken}` | same | ✅ |
| `headsetCode` :42 | POST /trips/:tripId/headset-code | `{}` + Bearer | :71 | requireOrganizer | organizer | `{code,expiresAt}` (live ✔; no token → 403) | same | ✅ |
| `pairHeadset` :45 | POST /xr/pair | `{code}` | :75 | `String(code).trim()`, upper-cased, 10-min expiry, single use; 10/min/IP | code | `{tripId,joinCode,deviceToken}` | same | ✅ ⚠️ TR3-015 (the IP limit can be dodged with a spoofed XFF) |
| `hailAudio` :48 | POST /trips/:tripId/hail-audio | raw Blob; browser sets Content-Type from `blob.type`; Bearer | :80 (`express.raw`, 5 MB) | memberByToken → 403; `features.eleven()` → 501 NO_STT (live); STT fail → 502 | member | `{transcript}` (≤160 chars) | same | ✅ ⚠️ TR3-014 |
| `seedDemo` :51 | POST /demo/seed[?key=] | `{}` + `?key` from location | :133 | `devAllowed`: non-prod, or `x-dev-key`/`?key` == DEV_KEY | dev key in prod | `{tripId,joinCode,organizer,maya,dev,headsetCode}` (live ✔) | same | ✅ |
| `health` :60 | GET /health | — | :142 | — | none | `{ok,mongo,gemini,eleven,backboard,payments,agentDecisions,expoMode,demoReplay,voyages}` | `Record<string,unknown>` | ✅ (never called by the app) |
| `passkeyStatus` :63 | GET /trips/:tripId/passkey | Bearer | :98 | memberOf; `hasPasskey(id, rpID)` **scoped to rpID** | member | `{registered}` | same | ❌ TR3-001 |
| `passkeyRegisterOptions` :64 | POST …/passkey/register/options | `{}` + Bearer | :102 | `hasPasskey(id)` **unscoped** → 409 PASSKEY_EXISTS | member | SimpleWebAuthn options (live rp.id = request host) | `Record` → `startRegistration` (`as never`) | ❌ TR3-001 |
| `passkeyRegisterVerify` :65 | POST …/passkey/register/verify | `{response}` + Bearer | :108 | `response` passed through; failure → 400 PASSKEY_FAILED (live) | member | `{ok:true}` | same | ✅ |
| `passkeyAuthOptions` :66 | POST …/passkey/auth/options | `{}` + Bearer | :115 | allowCredentials filtered by rpID | member | options | `Record` | ✅ ⚠️ TR3-001 |
| `passkeyAuthVerify` :67 | POST …/passkey/auth/verify | `{response}` + Bearer | :119 | verify → single-use token (2 min); failure → 400 (live) | member | `{assertionToken}` | same | ✅ |
| (no client fn; the URL arrives inside `turn:audioReady.audioUrl`) | GET /audio/:turnId | — | :126 | turnId sanitised `[^a-zA-Z0-9_-]` | none | audio/mpeg or empty 404 (live) | `<audio src>` | ✅ |
| (none) | GET /debug/:tripId | `?key` | :157 | devAllowed | dev | HTML | — | ✅ |
| (none) | any unknown /api/* | — | Express finalhandler | — | — | **text/html 404** (live `Cannot GET /api/trips/by-code/`) | JSON | ❌ TR3-006 |

**REST error shape.** Every thrown `HelmError` becomes `{code,message}` with its HTTP status. That is consistent with the socket `error` payload. The exceptions are body-parse failures and unknown routes (TR3-005, TR3-006).

## B) Client → Server events

`TripStore.emit` (tripStore.ts:122) queues into `outbox` while disconnected and flushes after `trip:join` on `connect` (:55-60). Every server handler is wrapped in `guard` (io.ts:25): `p ?? {}`, and exceptions become `socket.emit("error",{code,message})` to the caller only. I confirmed live that the reserved-looking `"error"` event does reach the client on socket.io 4.8.3.

| event | client payload type (events.ts) | web-app emit sites | io.ts handler | fields read + coercion | service call | authz | error codes (live) | Match? |
|---|---|---|---|---|---|---|---|---|
| `trip:join` | `{tripId?,joinCode?,memberToken?,deviceToken?,surface}` :8 | tripStore.ts:54 (every connect); stores in TripShell.tsx:110, XRPage.tsx:25, GalleryPage.tsx:28 | :44 | `tripId` wins, else `String(joinCode)` (upper-cased); leaves old rooms; `surface ?? "gallery"` (not validated) | `trip()`/`tripByCode()`, `memberByToken`, `deviceOk`, `replay()` | token → member room; device token → controls; none → gallery | NO_TRIP (live: bad code, `null` payload) | ✅ |
| `brief:submit` | `BriefInput` :9 | Brief.tsx:66 | :59 | `validateBrief`: cap rounded to 30k–300k, windows filtered, tags/dealbreakers de-duplicated/filtered/capped at 3, note cleaned to 200, noteSource | `submitBrief(tripId, memberId, p)` | member | NOT_JOINED, NOT_MEMBER (xr/gallery), BAD_PHASE, BAD_INPUT | ✅ |
| `table:start` | `Record<string,never>` :10 | organizer.tsx:17, SceneDirector.ts:102/103 | :60 | — | `startTable(tripId, actor)` | organizer or headset | NOT_ORGANIZER (live, Maya), BAD_PHASE, TOO_FEW, BRIEFS_PENDING | ✅ |
| `table:sailWithout` | `{memberIds}` :11 | organizer.tsx:79 | :61 | `memberIds ?? []`; ids silently filtered (organizer, unknown, sealed) | `sailWithout` | organizer **phone only** (headset refused, live) | NOT_ORGANIZER, BAD_PHASE | ✅ ⚠️ TR3-007 (silent partial no-op) |
| `table:hail` | `{text}` :12 | Table.tsx:57, SceneDirector.ts:121 | :62 | `String(text)`, clean 160, privacy filter | `hail(id, member or organizer-for-headset, text)` | member, or headset acting as organizer | NOT_MEMBER, CAPTAINS_CALLING, SLOW_DOWN (5 s) | ✅ |
| `xr:placed` | `Record<string,never>` :13 | XRApp.ts:47 | :69 | — | none (no-op) | any | — | ✅ |
| `dryrun:control` | `{action:"pause"\|"resume"\|"restart"}` :14 | SceneDirector.ts:118 | :70 | an action outside the whitelist is **ignored silently** | `dryrunControl` | organizer or headset (live headset pause ✔) | NOT_ORGANIZER. **No phase guard** | ✅ ⚠️ TR3-010 |
| `plan:vote` | `{planId}` :15 | DryRun.tsx:60 | :73 | `String(planId)` | `vote(tripId, memberId, planId)` | member | NOT_MEMBER (live, headset), BAD_PHASE | ✅ |
| `plan:pick` | `{planId}` :16 | DryRun.tsx:71, SceneDirector.ts:110 | :74 | `String(planId)` | `pick(tripId, actor, planId)` | organizer or headset | NOT_ORGANIZER, BAD_PHASE | ✅ |
| `seal:set` | `{bookingId,assertionToken?}` :17 | Seal.tsx:34, :36 | :75 | `String(bookingId)`, `assertionToken` passed through | `setSeal` → passkey gate → `payments.setSeal` | member | BAD_PHASE, PASSKEY_REQUIRED (403). **Silent no-op** if the seal is not PENDING | ⚠️ TR3-001, TR3-007 |
| `seal:cancel` | `{bookingId}` :18 | Seal.tsx:83 | :76 | `String(bookingId)` | `cancelSeal` | member | BAD_PHASE. **Silent no-op** after ALL_AUTHORIZED | ⚠️ TR3-007 |
| `booking:retry` | `Record<string,never>` :19 | Voided.tsx:45, SceneDirector.ts:85 | :77 | — | `retry(tripId, actor)` | organizer or headset | NOT_ORGANIZER, BAD_PHASE | ✅ |
| `client:log` | `{level,msg,data?}` :20 | debugOverlay.ts:19 | :78 | `level ?? "log"`, `msg` sliced to 300, `data` **ignored** | writes the debugLog buffer (last 400) | any joined socket | none (silently dropped before join) | ✅ ⚠️ TR3-009 (queued unbounded while offline) |

Every declared C→S event has a handler, and the server has no undeclared handlers.

## C) Server → Client events

Bus: `toTrip` goes to room `trip:{id}` and throws on a `PRIVATE_EVENTS` name (service.ts:81-85). `toMember` goes to room `member:{id}` (:86-89). `replay()` emits straight to the joining socket (io.ts:56).

| event | declared payload (events.ts) | server emit sites + payload built | room | tripStore handler → state | Match? | Private rule |
|---|---|---|---|---|---|---|
| `trip:state` | `TripState` :24 | `broadcastState` service.ts:567 (called at :213, :276, :286, :325, :362, :369, :483, :522, :531); replay :571. Built by `state()` :549 with every TripState field; optional fields dropped when undefined | trip / socket | :71 → trip, booking, shortlist (kept unless the phase restarts), votes, autoPick; clears turns/audio/planPrivate/dryrun on a phase restart | ✅ ⚠️ TR3-011 (keeps the stale voided booking in DRY_RUN) | public ✅ |
| `member:joined` | `CrewPublic` :25 | service.ts:212 `{memberId,name,role,band,origin,briefSealed:false}` | trip | :85 no-op (roster comes from trip:state) | ✅ | ✅ |
| `brief:received` | `{memberId}` :26 | service.ts:275 | trip | :86 no-op | ✅ | ✅ |
| `brief:private` | `{brief:Brief\|null, memory?}` :27 | service.ts:274 `{brief: BriefRec, memory}`; replay :586 | member / socket | :87 → brief, memory | ⚠️ extra `_id` field (TR3-004) | private ✅ (live: gallery/xr received 0) |
| `table:watch` | `{watch}` :28 | service.ts:347 (live `{watch:1}`, `{watch:2}`) | trip | :88 **no-op** | ❌ TR3-002 (the watch never reaches state) | ✅ |
| `turn:new` | `Turn` :29 | engine turns service.ts:333-336 (all Turn fields; live sample ✔); human hail :398-404; replay :573 (last 50) | trip / socket | :89 dedupe on turnId, sort by seq | ✅ | ✅ |
| `turn:audioReady` | `{turnId,audioUrl,durationMs?}` :30 | service.ts:344 `{turnId,audioUrl:"/api/audio/:id",durationMs}`; replay :574 **without durationMs** | trip / socket | :91 → audio[turnId] | ⚠️ TR3-011 | ✅ |
| `table:decided` | `{shortlist:PlanPublic[]}` :31 | service.ts:381 `toPublic(...,"A"/"B")` (all PlanPublic fields, pricing.ts:240); replay :578 | trip / socket | :92 → shortlist | ✅ | ✅ (publicFlags only when every member shares them) |
| `plan:private` | `PlanPrivate` :32 | service.ts:384 `toPrivate` (pricing.ts:251, exact fields); replay :587 | member / socket | :93 → planPrivate[planId] | ✅ | private ✅ |
| `dryrun:script` | `DryRunScript` :33 | service.ts:386 via `dryrunScript()` :463 `{planIds,dayStartMin,dayEndMin,minPerSec,startedAt,pausedAt,serverNow}` (ms); replay :579 (DRY_RUN only) | trip / socket | :94 → dryrun, re-based with the server/client skew | ✅ | ✅ |
| `dryrun:control` | `{action,at}` :34 | service.ts:455 `{action, at: now}` | trip | :101 uses **local** `Date.now()` and ignores `at` | ⚠️ TR3-010 | ✅ |
| `plan:votes` | `{tallies, autoPick?}` :36 | service.ts:425 | trip | :109 → votes, autoPick | ✅ (not replayed, but carried in trip:state) | ✅ counts only |
| `booking:created` | `BookingPublic` :37 | service.ts:481 `payments.toPublic` (orchestrator.ts:88; DECLINED shows publicly as VOIDED); replay :583 | trip / socket | :110 → booking; **resets declined/lastResult/sealPrivate** | ⚠️ TR3-003, TR3-012 | ✅ |
| `seal:private` | `{bookingId,amountCents,lines,fits,cardLast4,mode}` :38 | service.ts:491; replay :590 | member / socket | :111 → sealPrivate | ✅ | private ✅ |
| `seal:status` | `{bookingId,memberId,status}` :39 | service.ts:71 (from orchestrator `setSealStatus` :212; `publicSealStatus` hides DECLINED) | trip | :112 patches `booking.seals` when bookingId matches | ✅ ⚠️ TR3-012 | ✅ no amounts; decliner hidden |
| `seal:declinedPrivate` | `{bookingId,reason}` :40 | service.ts:72 (orchestrator :161); replay :592 | member / socket | :117 → declined | ✅ | private ✅ |
| `booking:result` | `{bookingId,status,reference?,publicReason?}` :41 | service.ts:530 (orchestrator :186/:199/:209). **Not replayed** | trip | :118 → lastResult | ❌ TR3-003 | ✅ |
| `error` | `{code,message}` :42 | io.ts:30 (caller only); **service.ts:368 broadcast to the trip room** (TABLE_FAILED) | socket / trip | :119 → error | ⚠️ TR3-007 | ✅ |

- Declared but never emitted: none.
- Emitted but undeclared: none. Every emit site uses a declared name, but nothing enforces that at type level (TR3-004).
- Private-event rule: honoured. `toTrip` throws on the 4 private names, private data only ever goes via `toMember` or the joining member's own socket, and the headset/gallery never join a member room. Live, the gallery and XR sockets received 0 `*private*` events across a full voyage.

### Replay sequence (live, fresh Maya socket, status BOOKED)
`trip:state` → 9×`turn:new` → `table:decided` → `booking:created`(CAPTURED) → `brief:private` → 2×`plan:private` → `seal:private`.

This ordering is correct: state first, then public history, then booking, then private data. `booking:created` comes before `seal:private`/`seal:declinedPrivate`, so the store's reset in `booking:created` doesn't wipe the replayed private data. What's missing:
- `booking:result` (TR3-003)
- `durationMs` on the replayed `turn:audioReady` (TR3-011)
- `dryrun:script` outside DRY_RUN (fine, it isn't needed)

### Reconnect
- socket.io auto-reconnects (1–2 s). `connect` → `trip:join` → flush the outbox, in that order. Server handlers run in order and `trip:join` sets `socket.data.tripId` synchronously, so the queued actions are authorised.
- A server restart turns `AT_TABLE` into `BRIEFING` with the turns reset, and the client clears its log when it sees the phase change.
- Caveats: TR3-008 (transport fallback) and TR3-009 (outbox).

### Paths, proxy, production
- Client uses `io({path:"/socket.io"})`, relative origin, and `fetch('/api…')`. The server uses `new Server(http,{path:"/socket.io", cors:{origin:true}})` and mounts `/api`. Vite proxies `/api` and `/socket.io` (ws) to `API_URL ?? :8787`; live `:5173/api/health` → 200 ✔.
- Production: `express.static(webDist)` plus an SPA fallback on `^(?!\/api|\/socket\.io)` (index.ts:21-23). Same origin, so no CORS is needed for REST. Live: `/socket.io/?EIO=4&transport=polling` → 200, `/t/ABC` → index.html 200.
- Note: `apps/web/dist` exists, so the dev server on :8787 also serves a possibly stale build.

---

## Issues

### TR3-001: Passkey "registered?" check uses a different relying party than register/seal, which locks members out of sealing on a second attempt over a tunnel
- **Severity:** High
- **Link:** apps/web/src/net/passkey.ts:19-27, api.ts:63-64 ⇄ apps/server/src/api/routes.ts:97-106, passkeys/passkeys.ts:22-31, trips/service.ts:501; apps/web/vite.config.ts:12 (`changeOrigin:true`)
- **Expected vs actual:**
  - **Expected:** `GET /passkey` answers for the same rpID the phone registers and authenticates with.
  - **Where the rpID comes from:** `originOf()` takes it from the `Origin` header, falling back to `https://${Host}`. Browsers don't send `Origin` on a same-origin GET, and the Vite proxy rewrites `Host` to `localhost:8787`. So the status check computes rpID `localhost`, while the POSTs (which do carry `Origin`) use the tunnel host.
  - **Live, via :5173 with Host = tunnel:** with `Origin` → `rp.id = abc.trycloudflare.com`. Without `Origin` → `rp.id = localhost`.
  - **Resulting chain:**
    1. The status check `hasPasskey(id,"localhost")` returns `registered:false` even after a successful registration.
    2. The client then calls `register/options`, which checks `hasPasskey(id)` **unscoped** and returns 409 PASSKEY_EXISTS.
    3. The client's `catch` returns `fallback`, so it sends `seal:set` without an assertion.
    4. The server's `hasPasskey(memberId)` (unscoped) is true, so it returns `error PASSKEY_REQUIRED`. Repeating the tap gives the same result.
  - **When it hits:** the first seal works. Every later seal by that member fails: attempt 2 after "Back to the charts", or a new tab. The booking then sits in SEALING because PENDING seals never time out.
  - Phones need HTTPS for WebAuthn, so any non-production phone uses a tunnel. Production is only safe when `WEBAUTHN_ORIGIN`/`PUBLIC_BASE_URL` pins the rpID.
- **Fix:**
  1. Derive the origin from `Origin || Referer || X-Forwarded-Host` (and drop `changeOrigin`, or set `xfwd:true`).
  2. Make the checks consistent: scope `register/options` and `setSeal` by rpID, or leave status unscoped.
  3. Client: treat 409 PASSKEY_EXISTS as "registered" and go on to auth.
- **Effort:** S
- **Scope:** passkeys.ts, routes.ts, passkey.ts, vite.config.ts
- **Acceptance:** Through a tunnel: register, seal (attempt 1), void, retry, seal (attempt 2) prompts Face ID and succeeds. `GET /passkey` returns `registered:true` after registration regardless of Host rewriting.

### TR3-002: Watch progress (1/3, 2/3, 3/3) never reaches client state, so the headset compass and gallery corner stay at 0 during the table
- **Severity:** Medium
- **Link:** apps/web/src/net/tripStore.ts:88 ⇄ apps/server/src/trips/service.ts:347
- **Expected vs actual:** The server emits `table:watch {watch}` (live: 1, 2) but doesn't re-broadcast `trip:state`. The store's `table:watch` handler is a no-op. `trip.negotiation.watch` stays at its AT_TABLE-entry value (0) until the DRY_RUN state arrives. SceneDirector.ts:149 (`compass.setWatch`), SceneDirector.ts:176 and GalleryPage.tsx:90 all read it. Phones are unaffected because Table.tsx:20 uses the latest turn's `watch`.
- **Fix:** in the store, `on("table:watch", p => this.state.trip && { trip: {...this.state.trip, negotiation: {...this.state.trip.negotiation, watch: p.watch}} })`. Alternatively, have the server call `broadcastState` in `onWatch`.
- **Effort:** S
- **Scope:** tripStore.ts (or service.ts)
- **Acceptance:** During a live table, the gallery corner shows "Watch 1/3 → 2/3 → 3/3" and the compass needles advance per watch.

### TR3-003: `booking:result` is not replayed, and `booking:created` replay wipes `lastResult`, so reference and reason are lost after reload/reconnect
- **Severity:** Medium
- **Link:** apps/web/src/net/tripStore.ts:110, :118; SceneDirector.ts:350; phone/screens/Voided.tsx:34 ⇄ apps/server/src/trips/service.ts:570-595 (no `booking:result`), :530
- **Expected vs actual:**
  - Live replay in BOOKED ends `booking:created → brief:private → plan:private → seal:private`, with no `booking:result`.
  - The headset/gallery resumed into BOOKED calls `seal.tie(s.lastResult?.reference)`, which is `undefined`, so the reference is never shown. Booked.tsx has a fallback to `booking.reference`; SceneDirector does not.
  - On the phone, the VOIDED `publicReason` ("One share didn't clear…" / "The helm restarted mid-seal…") disappears on reconnect, because `booking:created` sets `lastResult:null` and nothing re-sends it. `publicReason` is not stored anywhere server-side.
- **Fix:** persist `publicReason` on `BookingRec`. In `replay()`, emit `booking:result {bookingId,status,reference,publicReason}` after `booking:created` when the booking is final. SceneDirector should fall back to `trip.booking?.reference`.
- **Effort:** S
- **Scope:** orchestrator.ts, service.ts, SceneDirector.ts
- **Acceptance:** Reload the headset after CAPTURED and the knot shows `AA-XXX-XXXX`. Reload a phone after VOIDED and it shows the same publicReason as before the reload.

### TR3-004: The socket contract isn't enforced on the server; the client hides it with casts
- **Severity:** Medium
- **Link:** apps/web/src/net/tripStore.ts:59, :68, :124 (`as never` / `as (e:string,…)=>void`); passkey.ts:24/32 (`opts as never`) ⇄ apps/server/src/realtime/io.ts:15 (`new Server(...)` untyped), :44-83 (hand-written payload types); trips/service.ts:42-45 (`Bus` = `event:string, payload:unknown`), :81/:86; routes.ts:111/:121 (`response: never`)
- **Expected vs actual:** `ServerToClient`/`ClientToServer` exist but no server code is checked against them. Drift that has already slipped through:
  - `brief:private.brief` carries an extra `_id` (BriefRec).
  - Replayed `turn:audioReady` omits `durationMs`.
  - `trip:join.surface` accepts any string.
  - `error` is broadcast to a room although it is documented as caller-only.
  - A renamed field would compile cleanly on both sides.
- **Fix:**
  - `new Server<ClientToServer, ServerToClient, {}, SocketData>`.
  - Make `Bus` generic: `trip<K extends Exclude<keyof ServerToClient, typeof PRIVATE_EVENTS[number]>>(id, ev: K, p: Parameters<ServerToClient[K]>[0])` and `member<K extends typeof PRIVATE_EVENTS[number] | …>`. That also makes the privacy guard a compile-time check.
  - Type the `replay` `emit`.
  - Strip `_id` from `brief:private`.
  - Validate `surface`.
- **Effort:** M
- **Scope:** io.ts, service.ts, tripStore.ts
- **Acceptance:** `tsc` fails if a server emit's payload doesn't match events.ts, or if a private event is passed to `toTrip`. The `as never` casts are gone from tripStore.

### TR3-005: Body-parse failures and non-JSON bodies return 500 INTERNAL instead of 4xx
- **Severity:** Low
- **Link:** apps/web/src/net/api.ts:8-11 ⇄ apps/server/src/api/routes.ts:23, :42, :57, :63, :68, :77, :173-177
- **Expected vs actual:** Live results:
  - Malformed JSON → `500 {"code":"INTERNAL"}`.
  - `Content-Type: text/plain` to `/trips`, `/members` or `/xr/pair` → 500. In Express 5, `req.body` is `undefined`, so `b.name` throws a TypeError.
  - A 70 KB body → 500 instead of 413.
  - Each of these also writes a `console.error` stack trace.
- **Fix:** `const b = (req.body ?? {})`. In the error handler, map `err.type==="entity.parse.failed"` → 400 BAD_JSON and `"entity.too.large"` → 413 TOO_LARGE.
- **Effort:** S
- **Scope:** routes.ts
- **Acceptance:** The three curl cases return 400/400/413 with a `{code,message}` body and no stack in the logs.

### TR3-006: `api.ts` parses error bodies as JSON unguarded, and unknown `/api/*` routes answer with HTML
- **Severity:** Low
- **Link:** apps/web/src/net/api.ts:13-15 ⇄ apps/server/src/api/routes.ts (no 404 handler), index.ts:18-23
- **Expected vs actual:** Live, `GET /api/trips/by-code/` returns `404 text/html "Cannot GET …"`. A proxy 502/504 HTML page does the same kind of thing. `JSON.parse` throws a `SyntaxError`, so callers get a non-`ApiError` and the status is lost. For example, TripShell.tsx:221's `status === 404` check can't fire.
- **Fix:**
  - Client: `let data; try { data = text ? JSON.parse(text) : {} } catch { data = {} }`, then throw `ApiError(res.status, …)`.
  - Server: `r.use((_req,res)=>res.status(404).json({code:"NOT_FOUND",message:"No such route."}))` before the error handler.
- **Effort:** S
- **Scope:** api.ts, routes.ts
- **Acceptance:** An unknown `/api` path returns JSON 404, and `api.*` always rejects with `ApiError` carrying the HTTP status.

### TR3-007: Socket errors carry no event correlation; TABLE_FAILED goes to the whole room; some actions no-op with no reply
- **Severity:** Low
- **Link:** apps/web/src/net/tripStore.ts:119; phone/TripContext.tsx:51-57 ⇄ apps/server/src/realtime/io.ts:30, trips/service.ts:368, payments/orchestrator.ts:99, :114, io.ts:71, service.ts:284
- **Expected vs actual:**
  - The payload is `{code,message}` with no event name or request id. Any error, including another phone's broadcast `TABLE_FAILED`, re-opens every `useSendGuard` latch on every screen, and gallery/xr store it too.
  - Some requests get no error and no state change, so the button stays latched:
    - `seal:set` on a seal that isn't PENDING
    - `seal:cancel` after ALL_AUTHORIZED
    - `dryrun:control` with an unknown action
    - `table:sailWithout` of already-sealed members
- **Fix:**
  - Use socket.io acks: `emit(ev, p, ack)`, with `guard` calling `ack({ok:true} | {ok:false,code,message})`.
  - Emit a dedicated `table:failed` event to the room.
  - Have the orchestrator throw `HelmError("SEAL_LOCKED")` instead of silently returning.
- **Effort:** M
- **Scope:** io.ts, service.ts, orchestrator.ts, tripStore.ts, TripContext.tsx
- **Acceptance:** Each action's button resolves from its own ack. A table failure doesn't show an error banner on the gallery.

### TR3-008: The `polling` fallback is never used
- **Severity:** Low
- **Link:** apps/web/src/net/tripStore.ts:53 ⇄ io.ts:15
- **Expected vs actual:** `transports:["websocket","polling"]` implies a fallback, but engine.io-client 6.6 only moves to the next transport when `tryAllTransports` is true (engine.io-client build/esm socket.js:489), and that defaults to false. On a network or tunnel that blocks WebSocket, the client retries WebSocket forever.
- **Fix:** add `tryAllTransports: true`, or use the default `["polling","websocket"]` upgrade order.
- **Effort:** S
- **Scope:** tripStore.ts
- **Acceptance:** With WebSocket blocked (e.g. a proxy with `ws:false`), the client connects over polling.

### TR3-009: The offline outbox is unbounded, has no expiry, and queues debug logs
- **Severity:** Low
- **Link:** apps/web/src/net/tripStore.ts:49, :58-59, :123 ⇄ io.ts:78
- **Expected vs actual:**
  - Every emit made while offline is replayed on reconnect, including a `plan:pick` or `seal:set` from minutes earlier. By then the phase may have moved on, which produces BAD_PHASE banners, or it may act on a stale decision.
  - `client:log` from the XR debug overlay grows without limit while the headset is offline.
- **Fix:** don't queue `client:log`. Give queued actions a TTL (~30 s) and de-duplicate by event name. Cap the queue at ~20.
- **Effort:** S
- **Scope:** tripStore.ts
- **Acceptance:** After 2 minutes offline, reconnecting sends only fresh actions and nothing from before the TTL.

### TR3-010: `dryrun:control` ignores the server timestamp, and the control has no phase guard
- **Severity:** Low
- **Link:** apps/web/src/net/tripStore.ts:101-107 ⇄ apps/server/src/trips/service.ts:445-456, :455
- **Expected vs actual:** The server sends `{action, at}` (ms, server clock). The client applies pause/resume at its own receive-time `Date.now()`, while `dryrun:script` is skew-corrected with `serverNow`. Devices drift by their network latency until the next reload, which re-syncs from `dryrun:script`. The server also accepts the control in any status and creates a clock outside DRY_RUN.
- **Fix:** add `serverNow` to `dryrun:control` and apply `at + skew`. Guard `t.status === "DRY_RUN"` → BAD_PHASE.
- **Effort:** S
- **Scope:** service.ts, tripStore.ts, events.ts
- **Acceptance:** After pause, every device shows the same in-trip minute to ±1. A control sent outside DRY_RUN returns BAD_PHASE.

### TR3-011: Replay and snapshot inconsistencies (audio duration; stale booking in DRY_RUN)
- **Severity:** Low
- **Link:** apps/web/src/net/tripStore.ts:78, :91 ⇄ apps/server/src/trips/service.ts:343, :562, :574, :582
- **Expected vs actual:**
  - (a) Replayed `turn:audioReady` has no `durationMs`, because it isn't stored on `Turn`.
  - (b) After `booking:retry` (VOIDED → DRY_RUN), `trip:state.booking` still carries the voided attempt, since `state()` ignores status. Meanwhile `replay()` deliberately skips `booking:created` in DRY_RUN, so `store.booking` is stale and the two sources disagree.
- **Fix:** store `durationMs` on the turn and replay it. In `state()`, include `booking` only when the status is SEALING, BOOKED or VOIDED.
- **Effort:** S
- **Scope:** service.ts, types.ts (Turn.durationMs?)
- **Acceptance:** After a retry, `trip:state.booking` is absent. Replayed audio entries carry `durationMs`.

### TR3-012: `seal:status` for standing (absent-member) seals is emitted before `booking:created`
- **Severity:** Low
- **Link:** apps/web/src/net/tripStore.ts:112-116 ⇄ apps/server/src/payments/orchestrator.ts:67, :123; trips/service.ts:474-481
- **Expected vs actual:** Live order: `seal:status {Dev, AUTHORIZING}` → `booking:created {status:"AUTHORIZING"}`. The store drops the first event because there's no booking or the bookingId doesn't match. It's harmless today only because the `booking:created` snapshot is built afterwards and already says AUTHORIZING. Any await added between `create()` and the emit would lose the update.
- **Fix:** have `create()` return before starting standing seals (e.g. `startStanding(b)` called by `pick()` after `booking:created`), or queue `seal:status` for unknown bookings in the store.
- **Effort:** S
- **Scope:** orchestrator.ts, service.ts
- **Acceptance:** In the event log, `booking:created` always comes before any `seal:status` for that booking.

### TR3-013: HTTP status semantics
- **Severity:** Low
- **Link:** apps/web/src/net/api.ts:36, :42, :63 ⇄ apps/server/src/trips/service.ts:157-161, :199-204; routes.ts:91-96
- **Expected vs actual:**
  - A missing trip returns 403 instead of 404, because authz runs before the lookup. Live: `POST /trips/nope/absent` → 403 NOT_ORGANIZER, `GET /trips/nope/passkey` → 403 NOT_MEMBER.
  - CREW_FULL, BAND_TAKEN and BAD_PHASE are 400; they are conflicts, so 409 fits.
- **Fix:** look up the trip first. Use 409 for conflict codes.
- **Effort:** S
- **Scope:** service.ts
- **Acceptance:** Nonexistent trip → 404 NO_TRIP; taken band → 409.

### TR3-014: `hail-audio` has no rate limit or phase guard
- **Severity:** Low
- **Link:** apps/web/src/phone/components/Hail.tsx:92, VoiceNote.tsx:75, api.ts:48 ⇄ apps/server/src/api/routes.ts:80-88
- **Expected vs actual:** Any member can post unlimited 5 MB clips to paid STT in any phase. The design doc says ≤10 s, and hails are limited to 1 per 5 s.
- **Fix:** add a per-member limiter (e.g. 6/min) and a ~1 MB cap. Allow only BRIEFING (voice note) and AT_TABLE.
- **Effort:** S
- **Scope:** routes.ts
- **Acceptance:** The 7th clip in a minute gets 429 SLOW_DOWN, and an oversized clip gets 413.

### TR3-015: IP rate limits can be bypassed with a spoofed `X-Forwarded-For`
- **Severity:** Low
- **Link:** apps/web/src/net/api.ts:27, :46 ⇄ apps/server/src/index.ts:16 (`trust proxy` defaults to 1), routes.ts:26-38
- **Expected vs actual:** Live: 12 `/xr/pair` calls with varying XFF all returned 403 (never 429). Without XFF, calls 11 and 12 returned 429. When :8787 is reached directly with no proxy in front, clients choose their own `req.ip`.
- **Fix:** default `TRUST_PROXY_HOPS` to 0 and set it only in deployment. Also cap pair attempts per code globally.
- **Effort:** S
- **Scope:** index.ts, config
- **Acceptance:** With hops = 0, spoofed XFF calls hit 429 on the 11th.

### TR3-016: Design doc §6/§7 has drifted from the as-built contract
- **Severity:** Low
- **Link:** docs/04-technical-design.md:282-357 ⇄ packages/shared/src/events.ts, routes.ts
- **Expected vs actual:**
  - **§6 REST:**
    - `originAirport`/`presetId` → `origin`/`cityIds`
    - `inviteUrl` → `invitePath`
    - `PUT /trips/:id/brief` is **not implemented**
    - `/webauthn/*` → `/trips/:id/passkey/*`, plus an undocumented `GET /passkey`
    - headset-code returns `{code,expiresAt}`
    - the demo seed body is ignored, and it returns named tokens
    - health returns `payments`, not `visaMode`
    - `multipart` → raw body
  - **§7 events:**
    - `dryrun:control` `"day"` → `"restart"`, returns `{action,at}`
    - `dryrun:script` has a clock shape, not segments
    - `plan:private` is flat (`amountCents,lines,fits,reasons,covered,missing,flags`)
    - `table:decided` uses `publicFlags` plus geo fields
    - `trip:state` uses `candidateCities[]` and has `organizerId/votes/autoPick/paymentsMode`
    - `booking:created` is the full `BookingPublic`
    - `seal:private` adds `cardLast4/mode`
    - `error` can be room-wide
    - `trip:join` accepts `joinCode`
    - the gallery `?dev=` key isn't implemented
  - **§5:** the `version` optimistic lock is not implemented.
- **Fix:** regenerate the §6/§7 tables from events.ts and routes.ts, or state that events.ts is the source of truth.
- **Effort:** S
- **Scope:** docs/04
- **Acceptance:** Every row in the doc matches events.ts and routes.ts.

### TR3-017: Production static serving edge cases
- **Severity:** Low
- **Link:** apps/web (relative `/api`, `/socket.io`) ⇄ apps/server/src/index.ts:21-23, config.ts:52
- **Expected vs actual:**
  - The SPA fallback regex `^(?!\/api|\/socket\.io)` also excludes paths like `/apiary` or `/api-docs`, which then 404.
  - Serving is gated only on `existsSync(webDist)`. `apps/web/dist` is present locally, so the dev :8787 serves a stale build (live: `/t/ABC` → 200 html). That's confusing next to Vite on :5173.
- **Fix:** use the regex `^(?!\/(api|socket\.io)(\/|$))`, and gate static serving on `config.production || SERVE_WEB=1`.
- **Effort:** S
- **Scope:** index.ts
- **Acceptance:** `/apiary` serves index.html in prod, and :8787 serves no web app in dev by default.

---

## Counts
- **Matrix A (REST):** 16 client fns + 2 server-only routes + unknown-route row = 19 rows. 16 ✅ (6 with a ⚠️ caveat) · 3 ❌ (2 passkey rows, TR3-001; unknown route, TR3-006). Unused client fns: `api.cities`, `api.health`.
- **Matrix B (C→S):** 13 events, all handled. 11 ✅ (3 with a ⚠️ caveat: `table:sailWithout`, `dryrun:control`, `client:log`) · 2 ⚠️ (`seal:set`, `seal:cancel`). No undeclared handlers.
- **Matrix C (S→C):** 18 events, all emitted and all handled. 13 ✅ (some with caveats) · 3 ⚠️ (`brief:private`, `turn:audioReady`, `dryrun:control`) · 2 ❌ (`table:watch`, `booking:result`). Private-event rule honoured (verified live).
- **Issues:** 17 in total. Critical 0 · High 1 · Medium 3 · Low 13.
