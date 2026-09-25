# Traceability Layer 3, round 2: client ⇄ server transport (REST + Socket.io)

Repo `/Users/tejas/Downloads/untitled folder 3` @ `0430ef9`. This was a read-only review. I checked everything live against the dev helm on `:8787` (and on `:5173` through the Vite proxy). The scratch scripts are in `…/scratchpad/r2-t3/` (`rest.mjs`, `sock.mjs`, and their `.out` files).

**Live runs**
- **REST probe voyage** `kHo1CTNhB9qG` / `W4N9BR`: create, join, absent, reissue, claim, pair, unpair and passkey routes, plus every error path.
- **Seeded demo voyage** `Qa9hKMUPi5dR` / `FF322A`, one table run. Path: BRIEFING → AT_TABLE → DRY_RUN → SEALING → VOIDED (Maya lifted her seal) → retry → DRY_RUN → SEALING → BOOKED.
- **Sockets:** 4 long-lived sockets (Rae, Maya, the headset, the Gallery) plus a bad-token spectator. A fresh socket joined in every phase to record the replay.
- **Tokens** came via the `/handoff` route.

**Tests**
- `apps/server` `test/contract.test.ts`: 8/8 ✅.
- `apps/web` `src/net/*` (contract, tripStore, api, session): 27/27 ✅.

**Paid APIs:** one table run only. Gemini falls back to templates; the hails I sent produced a few new TTS clips. STT was never called: hail-audio was tested on its refusal paths only.

Legend: ✅ matches end to end (live where marked "L") · ⚠️ matches, with a caveat (linked finding) · ❌ mismatch.

---

## Round-1 status (docs/review/trace-3-transport.md)

| R1 | Status in 0430ef9 | Evidence |
|---|---|---|
| TR3-001 passkey rpID split | **Fixed.** A single `originFor` (Origin → Referer → configured → X-Forwarded-Host → Host) is used for status, register and auth. The client treats `PASSKEY_EXISTS` as "go authenticate". There is a residual caveat, L3-007 | L: via Vite, Referer-only gives `rp.id=abc.trycloudflare.com` |
| TR3-002 `table:watch` dropped | Fixed: tripStore.ts:116 patches `trip.negotiation.watch` | L: `table:watch {1}`, `{2}` |
| TR3-003 `booking:result` not replayed | Fixed: replay.ts:86-89. `booking:created` keeps `lastResult` for the same booking | L: replay in VOIDED and BOOKED |
| TR3-004 untyped contract | Fixed. `ClientToServer`/`ServerToClient` are used by `Server<…>` (io.ts:58) and `Socket<…>` (tripStore.ts:43). `TripRoomEvent` excludes private events and `error`. The runtime name lists are checked with `satisfies` | contract tests |
| TR3-005 body-parse 500 | Fixed | L: `{bad` → 400 BAD_JSON, 40 KB → 413 TOO_LARGE, array → `{}` |
| TR3-006 HTML 404 / JSON.parse | Fixed: routes.ts:225 JSON 404, api.ts:17-27 guarded | L: `GET /api/nope` → 404 JSON |
| TR3-007 no correlation / room-wide error / silent no-ops | Fixed. Every C→S event gets exactly one ack. `error` carries `event`. `table:failed` goes to the room. Refusals are explicit (`SEAL_LOCKED`, `BAD_INPUT` for an unknown dryrun action) | L: ack matrix below |
| TR3-008 polling unused | Fixed: `tryAllTransports:true` | L: polling and WebSocket both work through `:5173` |
| TR3-009 unbounded outbox | Fixed: 20 entries, 30 s TTL, one per event, `client:log` never queued, flushed after the join ack | web tests |
| TR3-010 dryrun clock / phase | Fixed: phase guard, server clock in the payload, duplicate pause not broadcast | L |
| TR3-011 audio duration / stale booking | Fixed: `durationMs` persisted and replayed; `BOOKING_PHASES` gate | L |
| TR3-012 `seal:status` before `booking:created` | Fixed: `deferStanding` + `startStanding` after `booking:created` | L: pick order |
| TR3-013 HTTP semantics | Fixed: `HTTP_STATUS` map; missing trip → 404 before auth | L (small leftovers in L3-005) |
| TR3-014 hail-audio unguarded | Fixed: auth, phase, length, rate and budget checks happen before the body is read | L: 403, 413 |
| TR3-015 XFF spoof | Not re-tested live (it would lock the shared localhost IP out for everyone); `clientIp` + `TRUST_PROXY_HOPS` is in place | — |
| TR3-016 doc drift | Mostly fixed. doc 04 §6/§7 lists the new routes and events. One mis-statement remains: the `trip:join` ack order (L3-002) | — |

---

## A) REST matrix

**Client side:** `call()` (api.ts:9) sends `fetch('/api'+path)` with JSON Content-Type unless the body is a Blob, plus `Authorization: Bearer` when given a token. Any non-2xx becomes `ApiError(status, message, code)`. A non-JSON 2xx becomes `BAD_RESPONSE`.

**Server side:** the router applies `express.json({limit:"32kb"})`. The `/trips/:tripId` pre-middleware (routes.ts:95) hydrates the voyage and answers 404 NO_TRIP before any auth check. Errors go through `HTTP_STATUS[code] ?? err.status` (routes.ts:23-33, :228).

| # | api.ts fn | Method + path, body/headers | Route (file:line) | Validation / auth | TripService call (arg order) | Response → client parse | Status codes seen live | ✔ |
|---|---|---|---|---|---|---|---|---|
| 1 | `cities` :47 (Create.tsx:24) | GET /cities | routes.ts:192 | none | `helm.ds.cities` | `[{cityId,name,notes}]` = type | 200 | ✅ L |
| 2 | `createTrip` :49 (Create.tsx:40) | POST /trips `{name,organizerName,band,origin,cityIds?,crewKey}` | :72 | 10/min/IP. `Number(band)`, `cityIds` must be an array, ≥2 known ids | `createTrip({name,organizerName,band,origin,cityIds,crewKey})` ✓ | `{tripId,joinCode,memberId,memberToken,crewKey}` → `withCrewKey` saves `crewKey` | 200 (band `"1"` ok), 422 BAD_INPUT (1 port, no name), 400 BAD_JSON, 413 TOO_LARGE | ✅ L |
| 3 | `tripByCode` :52 (TripShell:54, JoinCrew:22/69) | GET /trips/by-code/:code | :83 | 60/min lookups + 20/min misses per IP; hydrate first | `hydrate({joinCode})` ?? `tripByCode(code)`, `crewPublic(t)` | `{tripId,joinCode,name,status,crew,takenBands,crewClosed}` = type | 200 (lower-case ok), 404 NO_TRIP (JoinCrew branches on 404 ✓) | ✅ L |
| 4 | `join` :56 (JoinCrew:60) | POST /trips/:id/members `{name,band,origin,crewKey}` | :100 | 20/min/IP | `join(tripId,{name,band,origin,crewKey})` ✓ | `{memberId,memberToken,crewKey}` ✓ | 200, 409 BAND_TAKEN, 422 BAD_INPUT (SFO), 403 CREW_CLOSED, 404 NO_TRIP | ✅ L |
| 5 | `addAbsent` :59 (Muster:157) | POST /trips/:id/absent + Bearer | :107 | organizer (`requireOrganizer({token})`) | `addAbsent(tripId,{token},{name,band,origin})` ✓ | `{memberId,inviteKey,invitePath}` (the key is now in the fragment `#m=&k=`) | 200, 403 NOT_ORGANIZER (no token / member token) | ✅ L |
| 6 | `reissueInvite` :63 (Muster:108) | POST /trips/:id/absent/:m/invite `{}` + Bearer | :113 | organizer | `reissueInvite(tripId,{token},memberId)` ✓ | same shape as #5 | 200 (the old key then → 403), 404 NOT_FOUND (non-absent), 409 INVITE_CLAIMED | ✅ L |
| 7 | `claimAbsent` :66 (seatClaims:21) | POST …/absent/:m/claim `{inviteKey,crewKey}` | :117 | 10 failures/min/IP | `claimAbsent(tripId,memberId,inviteKey,crewKey)` ✓ | `{memberToken,crewKey}` → `withCrewKey` | 200, 403 BAD_INVITE (old key, second claim) | ✅ L |
| 8 | `redeemHandoff` :70 (seatClaims:26) | POST …/members/:m/handoff `{code}` | :123 | 10 failures/min/IP | `redeemHandoff(tripId,memberId,code)` ✓ | `{memberToken}` ✓ | 200, 403 BAD_HANDOFF | ✅ L |
| 9 | `headsetCode` :73 (organizer.tsx:55) | POST …/headset-code `{}` + Bearer | :128 | organizer | `headsetCode(tripId,{token})` ✓ | `{code,expiresAt}` ✓ | 200, 403 | ✅ L |
| 10 | `unpairHeadset` :80 (organizer.tsx:79) | DELETE …/headset + Bearer (no body, no Content-Type) | :133 | organizer, phone only (`memberId‖token`) | `unpairHeadset(tripId,{token})` ✓ | `{ok:true}` ✓ | 200 (idempotent), 403 | ✅ L |
| 11 | `pairHeadset` :76 (PairPage:21) | POST /xr/pair `{code}` | :138 | failure limits 10/min/IP + 300/min global | `pairHeadset(code)` ✓ (upper-cased, stripped) | `{tripId,joinCode,deviceToken}` ✓ | 200 (lower-case), 403 BAD_CODE (bad code, reuse) | ✅ L |
| 12 | `hailAudio` :82 (useRecorder:91) | POST …/hail-audio, raw Blob + Bearer | :146 gate → :168 | member → ElevenLabs on → phase ∈ {BRIEFING,VOIDED,AT_TABLE} → Content-Length → ≤ max → 2/5 s + 6/min per member → STT budget → 2 in-flight per IP | none (lookups only) → `transcribe` | `{transcript}` ≤160 chars ✓. `NO_STT` → `markVoiceOff` ✓ | 403 NOT_MEMBER, 413 TOO_LARGE. By code: 409/411/429/501/502/503. Success path not called (paid) | ✅ L (refusals) |
| 13 | `seedDemo` :85 (Demo.tsx:31) | POST /demo/seed + `X-Dev-Key` | :187 | `devAllowed` (open in dev; header or cookie in prod) | `seedExpo(helm)` | `{tripId,joinCode,organizer/maya/dev:{memberId,memberToken,handoff},headsetCode}` = type | 200 | ✅ L |
| 14 | `health` :94 (useRecorder:119) | GET /health | :196 | public view unless dev | — | public `{ok,eleven,degraded}`. The client reads `eleven` ✓ | 200 | ✅ L |
| 15 | `passkeyStatus` :98 (passkey.ts:33) | GET …/passkey + Bearer | passkeyRoutes.ts:41 | member; 30/min/IP | `passkeyStatus(id, originFor(req).rpID)` | `{registered,required}` ✓ | 200, 403 NOT_MEMBER | ⚠️ L3-007 |
| 16 | `passkeyRegisterOptions` :99 | POST …/register/options `{}` | :47 | member, `registrationBlock` → 409 PASSKEY_EXISTS/ELSEWHERE | — | creation options (rp.id from `originFor`) | 200 (`rp.id=localhost`; via tunnel Host + Origin/Referer → tunnel host) | ✅ L |
| 17 | `passkeyRegisterVerify` :100 | POST …/register/verify `{response}` | :53 | member, block re-checked | — | `{ok:true}` | 400 PASSKEY_FAILED (junk) | ✅ L |
| 18 | `passkeyAuthOptions` :101 | POST …/auth/options `{}` | :61 | member, a passkey on this rpID | — | request options | 409 PASSKEY_MISSING → client "blocked" ✓ | ✅ L |
| 19 | `passkeyAuthVerify` :103 | POST …/auth/verify `{response,bookingId}` | :69 | member, the booking is this voyage's and the member is on it | `helm.payments.bookings` | `{assertionToken}` (single use, bound to member + booking) | 409 BAD_BOOKING (thrown as 400, mapped to 409: L3-005) | ✅ L |

**Routes with no `api.ts` caller**

| Route | Used by | Verdict |
|---|---|---|
| GET /api/audio/:turnId (routes.ts:180) | `turn:audioReady.audioUrl` → `<audio src>` | ✅ live 404 for unknown ids and traversal; the body is empty, not JSON (L3-005) |
| GET /api/debug/login, POST /api/debug/login, GET /api/debug/:tripId (debug.ts:59-67) | dev browser only (dev key, header or cookie) | ✅ dev-only by design (live: dev mode → HTML 200) |
| Router fallthrough (routes.ts:225) | — | ✅ JSON 404 NOT_FOUND |

Every api.ts function has a live route, and no route drifts from its caller's field names or types.

---

## B) Client → server socket events

`TripStore` (tripStore.ts) behaves like this:
- `connect` → `emit("trip:join", opts, ack)`. The outbox is flushed only in the ack callback (:79, :180).
- `emit` sends straight away while `socket.connected`. Otherwise it queues: 20 max, 30 s TTL, one per event name.
- The server `guard` (io.ts:107) applies a 60 events / 10 s per-socket budget (not to `client:log`). A non-object payload becomes `{}`. The ack gets exactly one `{ok:true}` or `{ok:false,code,message}`. A refusal is also sent as a caller-only `error {code,message,event}`.

| Event (events.ts) | Client emit sites | io.ts handler: payload validation | Auth | TripService call (signature) | Emits on success | Live acks (refusals) | ✔ |
|---|---|---|---|---|---|---|---|
| `trip:join` :18 | tripStore.ts:79 (every connect). Stores: TripShell:99 (phone, token), XRPage:26 (device), GalleryPage:28 (code) | :131 `optStr` on tripId/memberToken/deviceToken (≤200), joinCode (≤40); `asSurface`. Limits: 10/min/socket, 60/min/IP, 20 misses/min/IP | token → member room; valid device → controls; else spectator | `hydrate(q)` ?? `trip()`/`tripByCode()`, `memberByToken`, `deviceOk`, `replay(t, emit, memberId)` | replay (§C) to the socket, **then** the ack | ok. `NO_TRIP` (bad code, with `error{event:"trip:join"}`). `LOADING` for an empty payload (L3-005). Bad token → **ok as spectator, no signal** (L3-001) | ⚠️ L3-001/002/003 |
| `brief:submit` :19 | Brief.tsx:30 (`useSendGuard`) | :159 `briefInput`: cap number/string → Number; windows/tags/dealbreakers `strs` ≤16×64; note ≤2000; noteSource coerced; then `validateBrief` | member (`requireActive`) | `submitBrief(tripId, memberId, BriefInput)` ✓ | `brief:private` (member), `trip:state` (+ a second `brief:private` if memory is slow) | BAD_INPUT (cap `{}`; windows not an array) | ✅ L |
| `table:start` :20 | organizer.tsx:14 (ack), SceneDirector:98/99 | :160 — | organizer or headset | `startTable(tripId, actor)` ✓ | `trip:state`(AT_TABLE), `turn:new`*, `turn:audioReady`*, `table:watch`*, then `table:decided`/`plan:private`/`dryrun:script`/`trip:state`, or `table:failed` + `trip:state` | ok (headset). NOT_ORGANIZER (Maya), BAD_PHASE (again) | ✅ L |
| `table:sailWithout` :21 | organizer.tsx:137 | :161 `strs(memberIds, 8)` | organizer **phone** (`memberId‖token`) | `sailWithout(tripId, actor, ids)` ✓ | `trip:state`; evicts sockets from the member room | NOT_ORGANIZER (headset). BAD_INPUT (`[…,7]`). Ok no-op (unknown id) | ✅ L |
| `table:hail` :22 | Table.tsx:59 (via Hail dock), SceneDirector:111 | :162 `optStr(text, 2000)` | member, or the headset as the organizer | `hail(tripId, memberId, text)` ✓ | `turn:new`(HAIL) to the room | ok (amounts redacted, rest kept). HAIL_WAITING. NOT_MEMBER (Gallery, BOOKED headset). BAD_INPUT (`text:5`). CAPTAINS_CALLING (BRIEFING) | ✅ L |
| `dryrun:control` :23 | SceneDirector:108 | :170 whitelist → BAD_INPUT | organizer or headset | `dryrunControl(tripId, actor, action)` ✓ | `dryrun:control{action,at,startedAt,pausedAt,serverNow}` only when the clock changed | ok. Duplicate pause → ok with no broadcast ✓. NOT_ORGANIZER (Maya). BAD_PHASE (BRIEFING). BAD_INPUT (`rewind`) | ✅ L |
| `plan:vote` :24 | DryRun.tsx:78 (no ack, optimistic) | :175 `str(planId)` | member | `vote(tripId, memberId, planId)` ✓ | `plan:votes` (room) + `plan:myVote` (member room only) | ok. BAD_PHASE (unknown plan, BRIEFING). NOT_MEMBER (headset, bad token) | ✅ L |
| `plan:pick` :25 | DryRun.tsx:39 (ack), PhaseController:73 | :176 `str(planId)` | organizer or headset | `pick(tripId, actor, planId)` ✓ (async) | `booking:created` → `seal:status`(standing) → `seal:private`* → `trip:state`(SEALING) | ok. NOT_ORGANIZER (Maya). BAD_PHASE (second pick) | ✅ L |
| `seal:set` :26 | Seal.tsx:29/44/47 | :177 `str(bookingId)`, `optStr(assertionToken, 2000)` | member (`requireActive`) + passkey gate | `setSeal(tripId, memberId, bookingId, token?)` ✓ | `seal:status` (room), then `booking:result` + `trip:state` when all are set | ok. SEAL_LOCKED (second tap). BAD_PHASE (wrong id). NOT_MEMBER (headset) | ✅ L |
| `seal:cancel` :27 | Seal.tsx:30 ("Lift my seal") | :178 `str(bookingId)` | member | `cancelSeal(tripId, memberId, bookingId)` ✓ | decline `user_cancelled` → `seal:declinedPrivate` (member) → every seal VOIDED → `booking:result`(VOIDED, neutral reason) → `trip:state` (doc 04:402, by design) | ok. BAD_PHASE (after void, after capture) | ✅ L |
| `booking:retry` :28 | Voided.tsx:25, PhaseController:30 | :179 — | organizer or headset | `retry(tripId, actor)` ✓ | `table:decided` → `plan:private`* → `dryrun:script` → `trip:state`(DRY_RUN, no booking) | ok (headset). NOT_ORGANIZER (Maya). BAD_PHASE (BRIEFING) | ✅ L |
| `booking:callOff` :35 | Seal.tsx:31/33 (two taps) | :185 `optStr(bookingId)` | organizer or headset | `callOff(tripId, actor, bookingId?)` ✓ | `seal:status`* VOIDED → `booking:result`(calledOff) → `trip:state` | NOT_ORGANIZER (Maya). BAD_PHASE (wrong id, BRIEFING, after void/capture). Success path from code + seal-integrity.test.ts:95, not live | ✅ |
| `crew:setOpen` :37 | organizer.tsx:110 (no ack) | :181 `p.open === true` (anything else means "close") | organizer or headset | `setCrewOpen(tripId, actor, open)` ✓ | `trip:state{crewClosed}` only on change | ok → Gallery got `trip:state closed=true`. REST join → 403 CREW_CLOSED. NOT_ORGANIZER (Maya). `{open:"true"}` → ok and treated as close (L3-004) | ⚠️ L3-004 |
| `headset:unpair` :39 | **no web caller** (the phone uses REST DELETE, #10) | :183 — | organizer **phone** only | `unpairHeadset(tripId,{memberId})` ✓ | none (the next `deviceOk` fails) | NOT_ORGANIZER (headset, Maya) | ⚠️ L3-004 (dead duplicate) |
| `client:log` :41 | debugOverlay.ts:19 (XR) | :188 member or device only; 5/s; level whitelisted, msg capped by the service | authenticated sockets | `clientLog(tripId, surface, level, msg)` | debug buffer only | ok (answered even though the contract says "never acknowledged", L3-004) | ✅ |

Every declared C→S event has a handler, and io.ts has no undeclared handlers. An **undeclared** event sent with an ack is never answered (live: `foo:bar` timed out, L3-004).

---

## C) Server → client events

**Bus** (core.ts:56-65):
- `toTrip` goes to `trip:{id}`. It is typed `TripRoomEvent` and also refuses PRIVATE_EVENTS and `error` at runtime.
- `toMember` goes to `member:{id}`.
- `replay` emits to the joining socket only, via `emitTyped`.

| Event | Contract (events.ts) | Emit sites (payload built) | Room | tripStore handler → state | ✔ |
|---|---|---|---|---|---|
| `trip:state` | `TripState` :45 | `Replayer.state` replay.ts:21 (every TripState field, `serverNow`). Broadcast from crew.ts:75/97/188/213, table.ts:142/187/198, sealing.ts:44/127/139; replay :72 | trip / socket | :94 → `trip`, `booking` (clock-mapped), `shortlist` kept if the ids match, `votes`, `autoPick` (mapped), `myVote` cleared on a phase change; entering BRIEFING/AT_TABLE clears turns/audio/planPrivate/dryrun | ✅ L |
| `brief:private` | `{brief:Brief\|null, memory?}` :46 | crew.ts:187 (via `briefPrivate`); replay :92. `briefOut` strips `_id` (L: keys = BriefInput + memberId, tripId, sealedAt) | member / socket | :114 → `brief`, `memory` | ✅ L |
| `table:watch` | `{watch}` :47 | table.ts:168 | trip | :116 patches `trip.negotiation.watch` | ✅ L |
| `turn:new` | `Turn` :48 | table.ts:156 (engine), :245 (hail); replay :78 (last 50) | trip / socket | :118 dedupe + sort by seq | ✅ L (stale-turn caveat L3-006) |
| `turn:audioReady` | `{turnId,audioUrl,durationMs?}` :49 | table.ts:165; replay :79 **with** durationMs | trip / socket | :120 → `audio[turnId]` | ✅ L |
| `table:decided` | `{shortlist:PlanPublic[]}` :50 | table.ts:208 (`emitShortlist`); replay :71 (first) | trip / socket | :121 → `shortlist` | ✅ L |
| `plan:private` | `PlanPrivate` :51 | table.ts:211; replay :93 | member / socket | :122 → `planPrivate[planId]` | ✅ L |
| `dryrun:script` | `DryRunScript` :52 | table.ts:213; replay :81 (DRY_RUN only) | trip / socket | :123 → `dryrun` re-based with skew | ✅ L |
| `dryrun:control` | `{action,at,startedAt,pausedAt,serverNow}` :58 | dryrun.ts:58 | trip | :130 uses the server `startedAt`/`pausedAt` via `toLocal` | ✅ L |
| `plan:votes` | `{tallies,autoPick?,serverNow}` :63 | dryrun.ts:25 | trip | :136 → `votes`, `autoPick` (mapped) | ✅ L |
| `plan:myVote` | `{planId\|null}` :65 | dryrun.ts:26; replay :94 (DRY_RUN) | member / socket | :137 → `myVote` | ✅ L (only Maya received it; Rae, headset and Gallery got 0) |
| `booking:created` | `BookingPublic & {serverNow}` :67 | sealing.ts:36; replay :84 (BOOKING_PHASES) | trip / socket | :138 → `booking` (mapped). A different booking resets declined/lastResult/sealPrivate | ✅ L |
| `seal:private` | `{bookingId,amountCents,lines,fits,cardLast4,mode}` :68 | sealing.ts:42 (`sealPrivateFor`); replay :97 | member / socket | :144 → `sealPrivate` | ✅ L |
| `seal:status` | `{bookingId,memberId,status}` :69 | core.ts:40 (`publicSealStatus`; a decline is never singled out: live, every seal went VOIDED together) | trip | :145 patches `booking.seals` | ✅ L |
| `seal:declinedPrivate` | `{bookingId,reason}` :70 | core.ts:41 (orchestrator `decline`); replay :99 | member / socket | :150 → `declined` | ✅ L (replayed to Maya in VOIDED) |
| `booking:result` | `{bookingId,status,reference?,publicReason?}` :71 | sealing.ts:138; replay :88 (BOOKED/VOIDED; `publicReason` from `t.lastResult`) | trip / socket | :151 → `lastResult` | ✅ L |
| `table:failed` | `{code:"TABLE_FAILED",message}` :76 | table.ts:197 | trip | :153 → `error` (ignored on the Gallery) | ✅ (contract test) |
| `error` | `ErrorPayload` :78 | io.ts:116 (caller only, with `event`); replay :75 `TABLE_INTERRUPTED` (no `event`) | socket | :154 → `error` | ✅ L (copy caveat L3-008) |

- **Declared but never emitted:** none. **Emitted but undeclared:** none; the server is type-checked against the contract and every name is covered by `SERVER_TO_CLIENT_EVENTS`.
- **Private events** (PRIVATE_EVENTS = brief:private, plan:private, plan:myVote, seal:private, seal:declinedPrivate) go only through `toMember` or the joining member's own replay.
  - Live, the headset, the Gallery and the bad-token spectator sockets received **0** private events across the whole voyage, including 8 fresh replays.

### Replay order on (re)join (live, fresh socket, acked after the replay)

| Status | Member (Maya) | Headset / Gallery |
|---|---|---|
| BRIEFING | `trip:state` → `brief:private`(mem=1) | `trip:state` |
| AT_TABLE | `trip:state` → `turn:new`#1 → `turn:audioReady` → `brief:private` | same minus private |
| DRY_RUN | `table:decided` → `trip:state` → 10×`turn:new` (+ `audioReady` with durationMs) → `dryrun:script` → `brief:private` → 2×`plan:private` → `plan:myVote`(null) | `table:decided` → `trip:state` → turns → `dryrun:script` |
| SEALING | `table:decided` → `trip:state`(bk AUTHORIZING) → turns → `booking:created` → `brief:private` → 2×`plan:private` → `seal:private` | same minus private |
| VOIDED | … → `booking:created`(VOIDED) → `booking:result`(reason) → `brief:private` → 2×`plan:private` → `seal:private` → `seal:declinedPrivate` | … → `booking:created` → `booking:result` |
| DRY_RUN after retry | as DRY_RUN; **no** `booking:created` (`trip:state.booking` undefined) | as DRY_RUN |
| BOOKED | … → `booking:created`(CAPTURED, reference) → `booking:result` → `brief:private`(mem=2, the voyage memory written) → 2×`plan:private` → `seal:private` | same minus private. The headset's device token is no longer valid, so it becomes a spectator |

The order is correct for the store:
- `table:decided` precedes `trip:state`, so `shortlistIds` resolve at once.
- `booking:created` precedes `booking:result`/`seal:private`/`seal:declinedPrivate`, so the reset doesn't wipe them.
- Only caveat: the BRIEFING replay after "Adjust my terms" (L3-006).

### Live orders (for the store's phase logic)
- **Table decides:** `table:watch`… → `table:decided` → `plan:private`×2 (member) → `dryrun:script` → `trip:state`(DRY_RUN). ✅
- **Pick:** `booking:created`(PENDING) → `seal:status`(Dev standing, AUTHORIZED) → `seal:private` → `trip:state`(SEALING). ✅ (TR1-015/TR3-012)
- **Capture:** `seal:status` ×5 → `booking:result`(CAPTURED, `AA-LIS-38AS`) → `trip:state`(BOOKED). ✅

### Reconnect, outbox, transports, proxy
- **Reconnect** (tripStore.ts:73-80): `transports:["websocket","polling"]` with `tryAllTransports:true`, and a 1–2 s back-off. After the join ack, `flush(ack)` sends fresh queued actions. On a failed join it answers them with the join refusal; stale ones get `EXPIRED`. ✅ (web tests)
- **Pre-ack window:** actions tapped between `connect` and the join ack bypass the outbox (L3-003).
- **Vite proxy** (vite.config.ts:30-33):
  - live polling-only socket via `:5173` → transport `polling`, join ack ok, full replay ✅
  - WebSocket via `:5173` ✅
  - `:5173/api/*` ✅
- **Origin check** (`allowRequest` + CORS `originAllowed`): a foreign origin (`https://evil.example`) is refused at the handshake ✅.
- **Per-socket budget:** 62 rapid events → 59 answered + 3 `SLOW_DOWN` (join + 59 = 60 in 10 s) ✅.

---

## Findings

### L3-001: `trip:join` quietly turns a stale member or device token into a spectator. The phone and headset are never told, so every action fails with a misleading refusal.
- **Severity:** Medium
- **Location:** apps/server/src/realtime/io.ts:147-157. apps/server/src/trips/core.ts:180-187 (`deviceOk`: 12 h expiry, BOOKED, unpair). apps/web/src/net/tripStore.ts:79. apps/web/src/xr/XRPage.tsx:25-26. apps/web/src/scene/SceneDirector.ts:169-180.
- **Evidence:**
  - Live: a join with `memberToken:"nope"` → ack `{ok:true}`, replay = `trip:state` only, no `error`. Then `plan:vote` → `NOT_MEMBER`.
  - Live: the headset rejoining in BOOKED → ack `{ok:true}`. Then `table:hail` → `NOT_MEMBER "Only crew can hail."`.
  - After `DELETE /headset` or the 12 h device TTL, the headset keeps its controls. Each tap then shows the red caption "Only the organizer can do that." to the organizer who is wearing it, and nothing offers to re-pair.
  - The phone copes only when its memberId has left the crew (`PhaseRoutes` "not on the crew anymore"). A token that no longer authenticates while the seat still exists (for example a rotated or mis-restored token) gives a member UI where every action fails.
  - doc 04:393 documents "a wrong token joins as a spectator only", but the client has no way to see it happened.
- **Fix:**
  - Answer `trip:join` with the identity it resolved: `{ok:true, as:"member"|"device"|"spectator", tokenRejected?: "member"|"device"}`. That means extending `Ack` for `trip:join`, or emitting a caller-only `error {code:"TOKEN_REJECTED"|"DEVICE_EXPIRED", event:"trip:join"}` when a token was supplied but not accepted.
  - XRPage: on `DEVICE_EXPIRED`, clear the headset session and route to PairPage.
  - Phone: on `TOKEN_REJECTED`, show the existing "Join again" card.
- **Effort:** S–M (server ~10 lines, store and two UI hooks).
- **Scope:** io.ts, events.ts (Ack/ErrorPayload), tripStore.ts, XRPage.tsx, PhaseRoutes.tsx.
- **Acceptance:**
  - A socket test: join with a bad member token → ack `as:"spectator"` + `tokenRejected:"member"`; join after unpair → `DEVICE_EXPIRED`.
  - An XR smoke test: after unpair the headset shows the pairing card, not the controls.

### L3-002: The `trip:join` ack arrives after the whole replay, including a slow memory recall, and the rest of the replay emits snapshots taken before that wait
- **Severity:** Low
- **Location:** io.ts:107-112, 156. replay.ts:90-101 (`await briefPrivate`, `await sealPrivateFor`, `await later`). memory.ts:114 (5 s Backboard timeout). doc 04:393 ("ack {ok}, then the replay").
- **Evidence:**
  - The guard acks after `fn` resolves, and `fn` awaits `replay()`. Live, every captured replay arrived before the ack; joins took 0–2 ms because memory was warm. A cold Backboard recall holds the ack, and so the outbox flush, for up to 5 s (memory.ts:114).
  - `short` and `b` are computed before the awaits. A pick, void or retry that lands during the wait still gets the old `plan:private`/`seal:private` replayed after the live events.
  - The doc states the opposite order.
- **Fix:**
  - Ack once the rooms are joined and the synchronous part of the replay is sent. Let the memory follow-up be the second `brief:private` it already is.
  - Re-read `t`/booking after each await, or build every private payload before the first await.
  - Correct doc 04:393.
- **Effort:** S
- **Scope:** replay.ts, io.ts, doc 04 §7.
- **Acceptance:** with `recall` stubbed to take 3 s, the join ack arrives within 50 ms and a queued `plan:vote` is applied before the memory lines arrive; a test that picks during the recall sees no stale `seal:private`.

### L3-003: Actions tapped between `connect` and the join ack skip the outbox and can race the server's hydrate
- **Severity:** Low
- **Location:** tripStore.ts:161-162 (`if (this.socket.connected) return this.send(...)`); io.ts:136-147 (`data.tripId` and `memberId` are only set after `await helm.hydrate`).
- **Evidence:**
  - `emit` checks `socket.connected`, which is true from `connect`, not "joined". For a voyage that must be loaded from MongoDB (archived or swept), an action sent in that window runs `tripId()` before the join handler resumes → `NOT_JOINED`. The phone then shows "Join the voyage first."
  - Live, with an in-memory voyage, `trip:join` + `crew:setOpen` sent back to back both acked ok: the hydrate resolved in microtasks. So this needs an archived voyage to show.
- **Fix:** keep a `joined` flag, set in the join-ack callback and cleared on `disconnect`, and queue while `!joined`. The outbox already does the rest.
- **Effort:** XS
- **Scope:** tripStore.ts, tripStore.test.ts.
- **Acceptance:** a unit test: connect → emit before the join ack → the event is sent only after the ack.

### L3-004: Loose ends in the socket contract
- **Severity:** Low
- **Location:** events.ts:39/41; io.ts:181, 183, 188; organizer.tsx:79.
- **Evidence (live):**
  - `headset:unpair` has no web caller (the phone uses `DELETE /api/trips/:id/headset`). That leaves two unpair paths to keep in step.
  - `crew:setOpen {open:"true"}` → ok and treated as **close** (`p.open === true`). Any non-boolean closes the crew.
  - `client:log` with an ack → `{ok:true}`, though the contract says "never acknowledged".
  - An undeclared event with an ack (`foo:bar`) is never answered. Typed clients can't send one, but a mistyped or old client hangs its ack.
- **Fix:**
  - Drop `headset:unpair` from the contract, or make the phone use it.
  - In io.ts, `typeof p.open === "boolean"` else BAD_INPUT.
  - Don't pass `ack` to the `client:log` guard.
  - Add `socket.onAny`-style handling: for an event not in `CLIENT_TO_SERVER_EVENTS` with a trailing function, reply `{ok:false,code:"UNKNOWN_EVENT"}`.
- **Effort:** XS
- **Scope:** io.ts, events.ts (+ contract test).
- **Acceptance:** contract test cases for each of the four.

### L3-005: Small inconsistencies in REST and join error codes
- **Severity:** Low
- **Location:** routes.ts:95-98 (`/trips/:tripId` pre-middleware), routes.ts:180-185, passkeyRoutes.ts:76, persistence.ts:37-45 and 49-56.
- **Evidence (live):**
  - `POST /api/trips/by-code/W4N9BR` (wrong method) → 404 **NO_TRIP** "That voyage doesn't exist." The pre-middleware takes `by-code` as a tripId; it should be NOT_FOUND.
  - `GET /api/audio/<unknown>` → 404 with an empty, non-JSON body. That is harmless for `<audio>`, but it contradicts "every error is JSON" (doc 04:371).
  - `BAD_BOOKING` is thrown with status 400 but delivered as 409 via `HTTP_STATUS`. The code and its map disagree.
  - `trip:join` with an empty or `null` payload → `LOADING` (503 semantics, "Fetching that voyage…"). The cause: `hydrate({joinCode:""})` returns early without recording a miss, so `missing()` keeps answering LOADING forever instead of BAD_INPUT or NO_TRIP. Each attempt counts as a join miss.
- **Fix:**
  - Skip the pre-middleware for `by-code`.
  - `res.status(404).json(...)` in the audio route (or leave it and note the exception in doc 04).
  - Throw BAD_BOOKING with 409.
  - In io.ts `trip:join`, refuse with `BAD_INPUT` when neither `tripId` nor `joinCode` is given.
- **Effort:** XS
- **Scope:** routes.ts, passkeyRoutes.ts, io.ts.
- **Acceptance:** b-api tests for the four responses.

### L3-006: After "Adjust my terms" (VOIDED → BRIEFING), a rejoin in BRIEFING replays the previous meeting's turns and audio
- **Severity:** Low
- **Location:** crew.ts:184 (`transition → BRIEFING` + `clearCharts` only). table.ts:103-115 (`resetTable` resets `negotiation`, `clearCharts` doesn't). replay.ts:77-80 (turns replayed whatever the status). tripStore.ts:98-111 (the clearing only happens on a live phase change).
- **Evidence:**
  - A phone that is connected while this happens clears its log, since BRIEFING is `fresh`.
  - A phone, headset or Gallery that joins or reloads during that BRIEFING gets up to 50 old turns, including the old DECIDE. The store comment at tripStore.ts:95-96 says that old DECIDE turn "keeps the hail disabled".
  - `startTable` resets the turns, so the stale log only lasts until the next meeting.
  - Code evidence only: reproducing it live needs a second paid table run.
- **Fix:** in `submitBrief` on VOIDED → BRIEFING, reset `t.negotiation` the way `resetTable` does (a new round, empty turns), or have the replay send turns only for AT_TABLE and later phases.
- **Effort:** XS
- **Scope:** crew.ts or replay.ts.
- **Acceptance:** a service test: void → `submitBrief` → a fresh replay has no `turn:new`.

### L3-007: The passkey status GET still depends on a Referer that the app's own `Referrer-Policy: no-referrer` removes
- **Severity:** Low
- **Location:** passkeyRoutes.ts:17-20, 41-46; web.ts:55 (`Referrer-Policy: no-referrer`); passkeys.ts:65-76.
- **Evidence:**
  - Browsers send no `Origin` on a same-origin GET. When the helm serves the page (the built app on :8787, or through a tunnel), `no-referrer` also removes `Referer`. The status rpID then falls to configured → X-Forwarded-Host → Host.
  - Live via the Vite proxy with Host = tunnel: with Origin or Referer → `rp.id=abc.trycloudflare.com`. With neither → `rp.id=localhost`.
  - In dev (`WEBAUTHN_ORIGIN`/`PUBLIC_BASE_URL` empty) behind a Host-rewriting proxy, status can answer `registered:false` for a passkey that exists on the page's rp.
  - The client now recovers (register/options → 409 PASSKEY_EXISTS → auth), so there is no lock-out. It costs an extra round trip, and it only works because of that recovery path.
- **Fix:**
  - Set `Referrer-Policy: same-origin` (still no Referer cross-origin), or make status a POST (browsers send Origin), or send an explicit `X-Client-Origin: location.origin` header from api.ts that `originFor` prefers in non-production.
  - In production `WEBAUTHN_ORIGIN` pins it anyway.
- **Effort:** XS
- **Scope:** web.ts or api.ts + passkeyRoutes.ts.
- **Acceptance:** through a Host-rewriting proxy, with a passkey on the tunnel rp, `GET /passkey` → `registered:true` from the page's own request.

### L3-008: The hail-specific `SLOW_DOWN` copy is shown for every rate-limit refusal
- **Severity:** Low
- **Location:** apps/web/src/phone/errors.ts:16, 29-36, 40 (`HAIL_CODES` includes `SLOW_DOWN` and `BAD_INPUT`), 47-58 (`useInlineError` matches on code, not `event`). io.ts:100 and :134-135 (SLOW_DOWN on every event and on join). routes.ts:19 (`slow()` on REST).
- **Evidence:**
  - `COPY.SLOW_DOWN = "One hail every few seconds. Your words are still in the box."`. `errorCopy` applies it to *any* SLOW_DOWN: a `trip:join` "Too many joins", the 60/10 s socket budget on `seal:set`, or REST "Too many tries" from claim/handoff (TripShell:63 `errorCopy(e)`).
  - On the Table screen, the Hail dock also claims any `SLOW_DOWN`/`BAD_INPUT` whatever its `event`.
  - Now that `error.event` exists (TR3-007), both can be keyed on the event.
- **Fix:** move the hail copy to `COPY_BY_EVENT["SLOW_DOWN table:hail"]` and let a plain SLOW_DOWN use the server message; have `useInlineError` accept `(code, event)` pairs and pass `event:"table:hail"` from Hail.tsx.
- **Effort:** XS
- **Scope:** errors.ts, Hail.tsx.
- **Acceptance:** a unit test: `errorCopy({code:"SLOW_DOWN",event:"seal:set",message:m})` → `m`; the Hail dock ignores `SLOW_DOWN` from `trip:join`.

### L3-009: The client store keeps the voided attempt's private leftovers after "back to the charts"
- **Severity:** Low
- **Location:** tripStore.ts:94-113 (the `trip:state` handler sets `booking:null` when the snapshot has none, but leaves `lastResult`, `declined` and `sealPrivate`).
- **Evidence:**
  - Live: after `booking:retry`, the member gets `table:decided`/`plan:private`/`dryrun:script`/`trip:state`(DRY_RUN, no booking) and nothing clears these fields.
  - Screens guard on `bookingId` today (Voided.tsx:28/31, Brief.tsx:81), so nothing shows, but any new consumer of `lastResult` would read the old attempt.
- **Fix:** clear `lastResult`, `declined` and `sealPrivate` when `s.booking` is absent (or when the phase leaves BOOKING_PHASES).
- **Effort:** XS
- **Scope:** tripStore.ts (+ test).
- **Acceptance:** a tripStore test: VOIDED snapshot + result → DRY_RUN snapshot → all three are null.

---

## Summary

- **Matrices:**
  - REST: 19 client functions + 4 routes with no api.ts caller. 18 ✅ and 1 ⚠️; 0 ❌.
  - Client → server: 15 events. 12 ✅ and 3 ⚠️; 0 ❌.
  - Server → client: 18 events. All ✅, with 2 caveats noted in the table.
  - Replay was checked live in 7 status situations; private-room isolation held (0 leaks).
- **Findings:** 0 High, 1 Medium, 8 Low (L3-001 to L3-009).
- **Round 1:** 15 of 17 TR3 issues are fixed and checked live. TR3-015 wasn't re-tested; TR3-016 is fixed except the ack-order line (L3-002).
