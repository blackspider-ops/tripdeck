# Traceability Layer 5: Persistence (write path → MongoDB → restore → replay)

Repo: `/Users/tejas/Downloads/untitled folder 3` @ befc070 · Paths relative to `apps/server/` unless noted.
Method: code reading plus a throwaway vitest probe (mocked `store/db.js` like `test/restore.test.ts`; persist calls captured; BSON round trip via the repo's `bson`/`mongodb@6.21.0`). The probe was deleted and `data/memory.json` restored afterwards. No local `mongod`, and no Docker images were available. Driver behaviour was checked in `node_modules/mongodb/lib`.

**Probe results used below (reproducible)**
- Seed (3 members, 3 briefs, headset code) makes 19 persist calls. Seed through DRY_RUN makes 18 whole-trip rewrites for 8 turns: 25.7 KB written for a 4.0 KB final doc. 35 `events` appended.
- `persist()` gets the **live** object. The snapshot taken at call time said `BRIEFING`, while the referenced object was already `DRY_RUN`.
- Driver: `ignoreUndefined` defaults to `false` (`mongodb/lib/bson.js:69`, `cmap/commands.js:57`), so `undefined` is stored as `null`. Checked: `{a:undefined}` becomes `{a:null}`. The driver serializes at `connection.command → toBin()` (`cmap/connection.js:385`), after async server selection and pool checkout.
- A trip doc in `SEALING` with a booking doc in `CAPTURED` stays **`SEALING`** after restore. `retry()` then refuses with "Only after a voided booking."
- A trip whose member doc is missing makes `restore()` **throw** `Cannot read properties of undefined (reading '_id')` for VOIDED and BOOKED trips.
- With a brief missing and `briefSealed:true`, `state()` in DRY_RUN **throws** `reading 'dealbreakers'`.
- After restore, the standing instruction `expiresAt` is reset to now + 24 h. The probe showed it pushed forward by the elapsed time.
- Replay after restore (DRY_RUN) sends `trip:state, turn:new×8, table:decided, dryrun:script`. The dry-run clock is new.

---

## 1. Write-path inventory

| # | Mutation (file:line) | Record + fields changed | persist() called? | Ordering/race risk | Issues |
|---|---|---|---|---|---|
| 1 | `createTrip` service.ts:179-194 | TripRec: all fields; `organizerId` set after addMember | ✅ `trips` full doc (twice: via addMember:211, then :194) | Low. The first write has `organizerId:""` and the second fixes it. | ✅ |
| 2 | `addMember` service.ts:207-211 | MemberRec new; TripRec.memberIds push | ✅ `members` full, then `trips` full | If the member write fails and the trip write lands, the trip points at a missing member. | TR5-002 |
| 3 | `addAbsent` service.ts:226-227 | MemberRec.inviteKeyHash | ✅ `members` full (2nd write of the same doc) | Two in-flight replaceOne calls on the same `_id`. Both serialize the live object, so it's benign in practice. | TR5-005 |
| 4 | `claimAbsent` service.ts:235-238 | MemberRec.tokenHash, inviteKeyHash=undefined | ✅ `members` full | `inviteKeyHash` is stored as `null` | TR5-010 |
| 5 | `headsetCode` service.ts:246-247 | TripRec.headset {codeHash, expiresAt(number), deviceTokenHash} | ✅ `trips` full | – | TR5-023 |
| 6 | `pairHeadset` service.ts:255-256 | TripRec.headset (device token hash; code burned) | ✅ `trips` full | – | ✅ (device survives restart) |
| 7 | `submitBrief` service.ts:266-273 | BriefRec (`_id`=memberId, capCents, note…), MemberRec.briefSealed, TripRec VOIDED→BRIEFING reset | ✅ `briefs`, `members`, `trips` (full) | 3 independent writes with an `await createStanding` between. A partial failure leaves `briefSealed:true` with no brief. | TR5-002 |
| 8 | `createStanding` orchestrator.ts:43-50 (called at service.ts:271) | `payments.standing` Map (instructionRef, limit, expiresAt) | ❌ **memory only** | – | TR5-004 |
| 9 | `sailWithout` service.ts:284-285 | TripRec.removedMemberIds | ✅ `trips` full | – | ✅ |
| 10 | `startTable` service.ts:318-324 | status AT_TABLE, negotiation reset, votes={} | ✅ `trips` full | – | ✅ |
| 11 | `startTable` service.ts:321 | `pendingHails` | ❌ memory (by design; the table is reset on restart) | – | ✅ |
| 12 | `emitTurn` service.ts:333-335 | negotiation.seq, turns.push | ✅ `trips` **full doc per turn** | O(n²) rewrites; 16 MB doc ceiling | TR5-012 |
| 13 | `voice` service.ts:343 | turn.audioUrl | ❌ no save; carried by the next turn/DRY_RUN save | Audio file lives on ephemeral disk | TR5-008, TR5-012 |
| 14 | `onWatch` service.ts:347 | negotiation.watch | ❌ no save; carried by the next save | Benign | ✅ |
| 15 | engine `.then` service.ts:355-360 | running=false, endedReason, shortlistIds, advocatedBy, status DRY_RUN | ✅ `trips` full | – | ✅ |
| 16 | engine `.catch` service.ts:365-367 | status BRIEFING | ✅ `trips` full | – | ✅ |
| 17 | `hail` service.ts:402-403 | turns.push, seq | ✅ `trips` full | – | ✅ |
| 18 | `hail` service.ts:394, 405-407 | `lastHailAt`, `pendingHails` | ❌ memory (rate limit plus the AT_TABLE queue, both reset on restart) | – | ✅ |
| 19 | `vote` service.ts:417-424 | votes[memberId], autoPick {planId, at:number}/null | ✅ `trips` full | – | ✅ |
| 20 | `armAutoPick`/`cancelAutoPick` service.ts:430, 442 | autoPick; timer in `autoPickTimers` | ✅ via caller save (vote/pick/retry). ❌ not saved when re-armed in restore:122 (benign) | – | ✅ |
| 21 | `dryrunControl` service.ts:449-453 | `dryrunClock` Map | ❌ **memory only** | – | TR5-011 |
| 22 | `dryrunScript` service.ts:461 | `dryrunClock` | ❌ memory only | – | TR5-011 |
| 23 | `pick` service.ts:471-480 | chosenPlanId, attempt++, bookingId, status SEALING, autoPick null | ✅ `bookings` (create:65) then `trips` full | The booking write is queued before the trip write. A crash between them leaves an orphan PENDING booking and a DRY_RUN trip. | TR5-001 |
| 24 | `startSeal` orchestrator.ts:121-124 | seal.instructionRef, setAt, status AUTHORIZING; booking AUTHORIZING | ✅ `bookings` full (setSealStatus:216, setBooking:222) | Live-object serialization | TR5-006 |
| 25 | `startSeal` orchestrator.ts:149-150 | seal.authRef, AUTHORIZED | ✅ `bookings` full | – | ✅ |
| 26 | `decline` orchestrator.ts:155-160 | seal.declineReason, DECLINED | ✅ `bookings` full | – | ✅ |
| 27 | `voidAll` orchestrator.ts:177-185 | booking ANY_DECLINED; **seals flipped to VOIDED at :181 before holds are voided at :182** | ✅ `bookings` full (:177 write serializes the post-:181 state) | A crash window persists "VOIDED + authRef" before the void happens | TR5-006 |
| 28 | `maybeCapture` orchestrator.ts:191-209 | ALL_AUTHORIZED, CAPTURED seals, reference, CAPTURED/VOIDED | ✅ `bookings` full | Partial capture isn't recorded until every capture has returned | TR5-006 |
| 29 | `onBookingResult` service.ts:528-529 | TripRec.status BOOKED/VOIDED | ✅ `trips` full | Queued **after** the final booking write. Lost write or crash → trip stuck SEALING | TR5-001 |
| 30 | `onBookingResult` service.ts:530 | `publicReason` (the "why voided" text) | ❌ only emitted, never stored | – | TR5-011 |
| 31 | `writeMemories` service.ts:544 → memory.ts:72-83 | memory.json and Backboard | local file (sync) plus Backboard (network) | Non-atomic read-modify-write | TR5-009, TR5-008 |
| 32 | `log` service.ts:90-97 | debugLog Map; `events` insert | `append("events")` ✅ (insertOne, errors swallowed); debugLog ❌ memory | Unbounded | TR5-013 |
| 33 | `client:log` io.ts:78-83 | debugLog only | ❌ | – | TR5-013 |
| 34 | `verifyRegistration` passkeys.ts:54, counter passkeys.ts:79 | WebAuthn credentials plus signature counter | ❌ **memory only** | – | **TR5-003** |
| 35 | passkeys.ts:44, 81 | challenges, assertion tokens | ❌ memory (short-lived; acceptable) | – | ✅ |
| 36 | SimProvider sim.ts:14-16 | instructions, auths, idempotency results | ❌ memory (SIM; acceptable) | Idempotency is lost across restart | TR5-006 (note) |
| 37 | `restore` service.ts:106 | AT_TABLE → BRIEFING, turns wiped | ❌ not saved (redone every boot) | – | TR5-021 |
| 38 | `restore` service.ts:121 | SEALING (no booking) → VOIDED | ✅ `trips` full | – | ✅ |
| 39 | `synthesize` voice.ts:51, 53 | `.cache/tts/<sha1>.mp3`, `.cache/audio/<turnId>.mp3` | local file (sync) | Unbounded, ephemeral | TR5-008, TR5-020 |

**Secrets and unneeded data in persisted docs**
- ✅ `members.tokenHash`, `inviteKeyHash`, `trips.headset.deviceTokenHash`: SHA-256 of 256-bit / 96-bit random tokens. Fine.
- ⚠️ `trips.headset.codeHash`: unsalted SHA-256 of a 6-char, 32-symbol code (about 30 bits, 10-min TTL). TR5-023.
- ✅ `briefs`: capCents, note, mustHaves, dealbreakers. This is private by design (spec §4.3) but is plaintext at rest.
- ⚠️ `bookings.seals[].capCents`: copies each member's private cap into a second collection. The spec's Seal has no cap. TR5-015.
- ✅ `bookings.seals[].instructionRef/authRef`: provider references (spec `providerRef`). Needed to void holds after a restart.
- ✅ `events.summary`: only `payload.text` (post-filter public turn text) or `payload.status`. Member-room emits pass `undefined`, so no caps or shares leak. ⚠️ `audience` is `member:<name>` rather than `<id>` (TR5-013).
- ✅ `memory.json` / Backboard hold only a budget band, never the cap (memory.ts:10, service.ts:544).

---

## 2. Schema check

| collection | doc shape actually written | docs/04 §4 schema | indexes created (db.ts:21-27) vs needed | Match? |
|---|---|---|---|---|
| `trips` | `_id` nanoid(12) string; joinCode; name; presetId; status; version:number; organizerId; memberIds[]; removedMemberIds[]; candidateCityIds[]; **negotiation {watch, running, seq, endedReason, turns: Turn[]}**; **shortlistIds** (top level); **advocatedBy** Record; **votes** Record; **autoPick {planId, at:number(epoch ms)}\|null**; chosenPlanId; bookingId; **attempt**; **headset {codeHash, expiresAt:number, deviceTokenHash}**; createdAt/updatedAt ISO strings. Undefined optional fields are written as **`null`** (driver default). | §4.1: `dateWindows` (not stored; derived from the dataset, which is fine), `negotiation {watch, shortlist, endedReason}`, `headsetCodeHash`, status includes `DRAFT` (never used). No votes/autoPick/attempt/turns. | `joinCode` unique ✅ (needed) | ⚠️ Drift (TR5-014). Turns are embedded instead of in a §4.6 `turns` collection (TR5-012). Epoch numbers where the spec says ISO strings. |
| `members` | `_id` nanoid; tripId; name; role; band; **origin**; tokenHash; inviteKeyHash (null after claim); briefSealed; joinedAt ISO | §4.2: `originAirport`, `voiceId`, `backboardRef`, `webauthnCredentialId` | `tripId` ✅ created, but no query uses it (loadAll scans everything) | ⚠️ Name drift. The missing `webauthnCredentialId` is why passkeys don't survive a restart (TR5-003). |
| `briefs` | `_id` = **memberId** (not nanoid); tripId; memberId; capCents; dateWindowIds; mustHaves; dealbreakers; note (null if absent); noteSource; fromMemory:false; sealedAt ISO | §4.3 identical fields | `{tripId,memberId}` unique ✅. Redundant with `_id`=memberId, but harmless. | ✅ (except `_id` convention and `note:null`) |
| `bookings` | `_id` nanoid; tripId; planId; **cityId**; attempt; status; mode; groupCents; reference (null until captured); createdAt/updatedAt ISO; **seals: SealRec[] embedded** {memberId, amountCents, **capCents**, status, idempotencyKey, instructionRef, authRef, declineReason, **standing**, setAt, updatedAt} | §4.7 Booking plus a separate `seals` collection {_id, bookingId, tripId, providerRef…} | `tripId` created (extra, fine). Spec's `seals.{bookingId,memberId}` unique doesn't apply (embedded). | ⚠️ Embedded seals is a sensible deviation but undocumented. `capCents` is extra private data (TR5-015). |
| `events` | `_id` **ObjectId** (driver-generated); tripId; **event**; audience `trip`\|`member:<name>`; **summary** (≤120 chars); **at: BSON Date** | §4.8 `{_id, tripId, type, audience:"member:<id>", payloadRedacted, at}` (ISO per §4 preamble) | `{tripId, at}` ✅. **No TTL.** | ⚠️ Field names, types and the audience format differ. Never read back (TR5-013). |
| `options`, `plans`, `turns`, `seals` | not written (dataset.json; chart book rebuilt deterministically; turns embedded; seals embedded) | §4.4-4.7 | §4.9 `options.{cityId,kind}`, `plans.tripId`, `turns.{tripId,seq}`, `seals.{bookingId,memberId}`: not created (N/A) | ⚠️ Doc/code mismatch (TR5-014) |

**Other schema notes**
- All `_id`s are string nanoid(12), except events (ObjectId) and briefs (= memberId). `persist` filters by `{_id}` with upsert, so `_id` never changes.
- **Duplicate key**: the only unique constraints are `trips.joinCode` and `briefs.{tripId,memberId}`. joinCode collisions are checked only against in-memory trips (service.ts:177). If a trip failed to load, or two instances ran, an upsert would hit E11000. `persist` then logs and swallows the error (db.ts:43), so that trip is **never** persisted again, with no signal (TR5-005).
- **Index build failure** (for example, existing duplicate joinCodes) sits inside the same try as `connect` (db.ts:21-33). The server then drops to memory-only mode even though it connected (TR5-007).
- **Map/Set**: no Map or Set reaches Mongo. `votes`/`advocatedBy` are plain objects, and memberIds are the keys (nanoid `[A-Za-z0-9_-]`, no `.`/`$`), so they're BSON-safe ✅.
- **Dates**: every record uses ISO strings, except `autoPick.at` and `headset.expiresAt` (epoch numbers, round-trip fine) and `events.at` (BSON Date). The code's own reads all work.
- **undefined → null**: affects TripRec.shortlistIds/chosenPlanId/bookingId/advocatedBy/negotiation.endedReason/headset.deviceTokenHash, MemberRec.inviteKeyHash, Brief.note, Turn.planId/cityId/audioUrl, Seal.instructionRef/authRef/declineReason/setAt, Booking.reference (TR5-010).
- Collection names: `trips, members, briefs, bookings, events` (db.ts:12). DB name `MONGODB_DB` defaults to `all_ayes` (config.ts:24). That variable isn't in the docs/04 §11 env list.

---

## 3. Read/restore path

Boot order is `connectDb()` → `helm.restore()` → HTTP/socket attach (index.ts:11-13, 27). The bus isn't attached during restore, so restore emits are dropped (fine).

| loadAll call | how rehydrated | fields defaulted | lost across restart |
|---|---|---|---|
| `loadAll("trips")` service.ts:102 | Raw doc into `trips` Map (same object shape). No schema validation. | memberIds, removedMemberIds, votes, attempt, autoPick, negotiation (:104-105) | AT_TABLE turns (deliberately wiped :106); dry-run clock; debugLog; pendingHails; lastHailAt; chartBooks/privacy (rebuilt lazily ✅) |
| `loadAll("members")` :109 | Into the `members` Map | none (older docs without `briefSealed`, for example, → undefined) | passkeys (separate module, TR5-003) |
| `loadAll("briefs")` :110 | Keyed by `b.memberId` | none | – |
| `loadAll("bookings")` :111 | Into `payments.bookings` | none | provider-side SIM state (instructions/auths/idempotency cache); `publicReason` |
| (none) | `payments.standing` is **re-created** for every absent member with a brief in every non-BOOKED trip (:113-117), with a **new 24 h expiry** | – | original instructionRef and expiry (TR5-004) |
| (none) `events` | never loaded | – | the entire audit/debug history is invisible to `/api/debug` after a restart (TR5-013) |
| memory.json / backboard-assistants.json | read on demand | – | the whole file on ephemeral disk (TR5-008) |
| `.cache/audio`, `.cache/tts` | served on demand | – | files on ephemeral disk; `audioUrl`s in turns point at 404s (TR5-008) |

**Behaviour per trip status after restart**

| Status in DB | Restore action | Result | Replay to phone / headset / gallery | Verdict |
|---|---|---|---|---|
| BRIEFING | none | resumes; tokens, headset device token and briefs intact | trip:state, brief:private (+memory), no turns | ✅ (but see TR5-003 passkeys) |
| AT_TABLE | → BRIEFING, turns/seq/watch wiped, **not saved** (:106) | organizer must "weigh anchor" again; briefs still sealed so startTable works | trip:state BRIEFING only. No event explains the reset, and clients that cached turns keep showing them | ⚠️ TR5-021 |
| DRY_RUN | autoPick re-armed with the remaining time (:122); shortlist resolved against the rebuilt chart book | votes, tallies and autoPick survive ✅; an overdue countdown fires at once ✅ (restore.test.ts) | trip:state, last 50 turns (+audioReady for 404 files), table:decided, **new** dryrun:script (clock restarted at day start), plan:private | ⚠️ TR5-011, TR5-008, TR5-022 |
| SEALING, booking non-final | `payments.abandon(b)` → voidAll → onBookingResult → trip VOIDED + save | holds released (SIM), crew can retry ✅ | trip:state VOIDED, booking:created (voided), seal:private, seal:declinedPrivate if any. **publicReason "helm restarted" isn't replayed** to anyone who connects later | ⚠️ TR5-006 (latent holds), TR5-011 |
| SEALING, booking **CAPTURED/VOIDED** (trip write lost) | `abandon` returns early (orchestrator.ts:82); nothing reconciles | **trip stuck in SEALING forever**; setSeal/cancel no-ops; retry refused (probe) | booking shows CAPTURED/VOIDED while the trip says SEALING | ❌ **TR5-001** |
| SEALING, no booking doc | → VOIDED + save (:121) | retry → DRY_RUN | ✅ | ✅ |
| DRY_RUN + orphan PENDING booking (booking write landed, trip write didn't) | none | trip is DRY_RUN; booking doc stays PENDING in the DB forever | not replayed (status gate :582) | ⚠️ minor, folded into TR5-001 |
| BOOKED | none; standing not re-issued | ✅ reference in state.booking | trip:state + booking:created + seal:private | ✅ (the memory write may be lost if the crash was right after capture; Low) |
| VOIDED | standing re-issued with a fresh 24 h | retry works (restore.test.ts) ✅ | booking:created (voided attempt) + seal:private + seal:declinedPrivate; no publicReason | ⚠️ TR5-004, TR5-011 |
| any, with a dangling member/brief ref | `activeMembers` returns `undefined` → TypeError in restore (:116 path) or later in state() | **boot crash** (top-level await in index.ts:13), crash loop on Render | – | ❌ **TR5-002** |

**Replay correctness (service.ts:570-595 vs docs/04 §7.3)**
- ✅ Phone: `memberByToken` uses the persisted `tokenHash`, so reconnects work across restart. Private replays (brief, plan, seal, declined) are rebuilt from persisted records.
- ✅ Headset: `deviceOk` uses the persisted `headset.deviceTokenHash`, so a paired Quest reconnects after a restart. A pending pairing code also survives (`codeHash` + `expiresAt`).
- ✅ Gallery: trip:state, turns and shortlist.
- ⚠️ `turn:audioReady` replay omits `durationMs` (the live event includes it, :344 vs :574) and points at files lost on redeploy.
- ⚠️ dryrun:script replays a new clock after restart (all clients agree, but the Dry Run restarts).
- ❌ After a restart, `hasPasskey` is false for everyone. Replay doesn't cause this, but the passkey status any phone gets afterwards (`GET /passkey`) is wrong (TR5-003).

---

## 4. Round-trip proof

| Record | write → read → use chain | Lossless? |
|---|---|---|
| TripRec | service.ts:126 `save` → db.ts:42 replaceOne(live obj, serialized at connection.js:385) → db.ts:56 find → service.ts:102-107 → `state()` :549 / `replay()` :570 / `trip()` :129 / `memberByToken` :145 | ⚠️ Mostly. Turns, votes, autoPick, headset and advocatedBy round-trip. `undefined` comes back as `null` (TR5-010). AT_TABLE turns are intentionally dropped. `version` isn't checked on write. |
| TripRec.negotiation.turns | :333-335 push+save → embedded array → :572 replay slice(-50) → client `turn:new` | ✅ for DRY_RUN and later (probe: 8 turns replayed). ❌ for AT_TABLE (wiped :106). `audioUrl` round-trips, but its target file may not (TR5-008). |
| MemberRec | :210/:227/:238/:270 persist → :109 → `memberByToken` :148 (tokenHash) / `claimAbsent` :233 (inviteKeyHash) / `crewPublic` :165 | ✅ (`inviteKeyHash:null` is still rejected by `sameHash` ids.ts:11) |
| BriefRec | :268 persist → :110 (keyed by memberId) → `pricingCrew` :293 → `chartBook` :298 → shortlist/pick; `replay` :586 brief:private | ✅ values. `note:null` reaches the client instead of being absent. A missing brief with `briefSealed:true` crashes (TR5-002). |
| BookingRec + seals | orchestrator.ts:65/160/216/222 → `events.persist` → service.ts:74 → db → :111 → `abandon` (restore :120), `toPublic`, `replay` :582-592, `/api/debug` | ⚠️ Fields round-trip (ISO strings, integer cents, embedded seals). The **state** can be inconsistent in crash windows (seals VOIDED before void, TR5-006), and the trip↔booking pair isn't reconciled (TR5-001). |
| Standing instruction | orchestrator.ts:49 Map only → re-derived from `briefs.capCents` at restore :116 | ❌ Not a round trip. A new instruction with a new expiry (TR5-004). |
| Passkey credential | passkeys.ts:54 Map only | ❌ Lost (TR5-003) |
| Dry-run clock | service.ts:453/461 Map only | ❌ Lost (TR5-011) |
| events | service.ts:97 `append` → never read | N/A (write-only) |
| Memory | memory.ts:76 writeFileSync / Backboard POST → memory.ts:69 / :60 → `brief:private.memory`, advocate prompts | ⚠️ Lossless on a persistent disk; lost on ephemeral disk (the Backboard mapping file is lost too, TR5-008) |

Tests: `test/restore.test.ts` fakes Mongo with `JSON.parse(JSON.stringify())`. That **drops** `undefined`, whereas the real driver writes `null`. It also never covers dangling refs or a final booking under a SEALING trip, so TR5-001/002/010 pass CI.

---

## 5. Non-Mongo stores

| Store | Path (config.ts:50-51) | Writer | Concurrency | Growth | Read-only FS / container behaviour |
|---|---|---|---|---|---|
| `memory.json` | `apps/server/data/memory.json` | memory.ts:74-76 sync read-modify-write | Safe within one process (no await between read and write). **Not atomic**: a torn write → `readJson` returns `{}` (:24) → the next `remember` overwrites the whole file (TR5-009). Unsafe across multiple instances. | ≤20 lines per personKey; keys unbounded | `mkdirSync` at import (:16). The dir exists in the image, so boot is OK. `writeFileSync` throws EROFS → `remember` throws **before** the Backboard write (:76-77), so memory is disabled even with Backboard (TR5-019). On Render the disk is ephemeral and the file resets each deploy to the **copy baked into the image** (not in .dockerignore; currently 60 test-generated lines) (TR5-017). |
| `backboard-assistants.json` | `apps/server/data/` | memory.ts:43-53 read → **await network** → write | **Lost update**: concurrent `assistantFor` calls for different keys each write their own stale map; the same key makes duplicate assistants (TR5-009) | one entry per person | Ephemeral on Render, so **each deploy creates new Backboard assistants and past memories are orphaned** (TR5-008). On RO FS the write fails after POST, so every recall creates another assistant. |
| `.cache/tts/<sha1>.mp3` | `apps/server/.cache/tts` | voice.ts:51 | Same-key concurrent writes produce identical content (benign) | unbounded (one per unique line/voice) | Dockerignored, so it's created at boot by `mkdirSync` (:13-14). **Boot crashes on a read-only rootfs** (TR5-019). Ephemeral on Render: `DEMO_REPLAY=cached` has no cache after a redeploy unless warmed in the running container. |
| `.cache/audio/<turnId>.mp3` | `apps/server/.cache/audio` | voice.ts:53 (a copy of the TTS bytes per turn) | unique per turn | **unbounded**, never cleaned (TR5-020) | Ephemeral, so `audioUrl` in persisted turns gives a 404 after a redeploy (TR5-008) |
| In-memory maps (passkeys, standing, dryrunClock, SIM provider, rate limits, debugLog) | – | – | – | debugLog capped at 400 per trip; trips/members/bookings Maps hold **all history** (TR5-016) | Lost on every restart |

Container notes: the Dockerfile runs as root on `node:22-slim` with `CMD ["npm","start"]`, which is npm → tsx → node. Graceful flush depends on SIGTERM reaching `process.on("SIGTERM")` (index.ts:38-40) through npm and tsx. Both relay signals in current versions, but this is unverified here. `render.yaml` declares no persistent disk and `MONGODB_URI` has `sync:false`. If it's left unset, production silently runs memory-only (TR5-007).

---

## Issues

### TR5-001: Restore leaves a voyage stuck in SEALING when its booking is already final
- Severity: High
- Link: service.ts:528-529 (trip save queued after the booking write) → orchestrator.ts:198/208/222 → service.ts:119-120 → orchestrator.ts:82 (`abandon` returns early on final bookings)
- Expected vs actual: A restart should reconcile trip.status with its booking (CAPTURED→BOOKED, VOIDED→VOIDED). Actually, if the final booking write landed but the trip write didn't (crash or kill in that window, lost/failed fire-and-forget write, or out-of-order apply), the trip stays `SEALING` forever. Seal actions are no-ops, `retry` is refused and, for CAPTURED, the crew was charged while the UI still shows sealing. The probe confirmed `SEALING+CAPTURED → trip SEALING`, "retry blocked". The inverse (booking PENDING written, trip still DRY_RUN) leaves an orphan booking doc.
- Fix: In `restore()`, for every trip with `bookingId`: if the booking is CAPTURED, set `t.status="BOOKED"`; if VOIDED, set `t.status="VOIDED"`; then `save(t)`. Only call `abandon` when the booking is non-final. Also mark orphan PENDING bookings (not referenced by `trip.bookingId`) as VOIDED.
- Effort: S
- Scope: service.ts `restore()`; test/restore.test.ts
- Acceptance: A restore test seeds (trip SEALING, booking CAPTURED) → trip BOOKED with reference in state, and (trip SEALING, booking VOIDED) → trip VOIDED and `retry()` succeeds.

### TR5-002: Dangling references crash boot (restore) or every trip:join (state)
- Severity: High
- Link: service.ts:210-211 / :268-273 (independent fire-and-forget writes) → service.ts:163 `this.members.get(id)!` → :114-116 restore → index.ts:13 top-level await; :293 `this.briefs.get(...)!` → :298 → `state()` :551
- Expected vs actual: Restore should tolerate or repair partial writes. Actually, a trip referencing a member doc that isn't in Mongo throws `Cannot read properties of undefined (reading '_id')` inside `restore()`, so the process exits and Render crash-loops. A member with `briefSealed:true` but no brief doc makes `state()` throw `reading 'dealbreakers'` for DRY_RUN/VOIDED trips, so every `trip:join` and broadcast for that voyage errors. Both confirmed by probe.
- Fix: Validate referential integrity in `restore()`: drop unknown memberIds (or move them to `removedMemberIds`), and reset `briefSealed=false` when the brief is missing (plus status → BRIEFING if past it). Wrap each trip's restore in try/catch so one bad voyage can't stop boot. Make `activeMembers` filter out undefined.
- Effort: S
- Scope: service.ts `restore`, `activeMembers`, `pricingCrew`
- Acceptance: A restore test with a deleted member doc and a deleted brief doc boots, logs a warning, and the voyage's `state()` works.

### TR5-003: Passkey credentials are in memory only, so any restart silently downgrades seal approval
- Severity: High
- Link: passkeys.ts:15 (`credentials` Map), :54, :79 (counter) → service.ts:501 `hasPasskey(memberId)` → routes.ts:105/110 (`PASSKEY_EXISTS` guard)
- Expected vs actual: A registered passkey (PRD E2, docs/06 §4.1/§9; docs/04 §4.2 `webauthnCredentialId`) should survive restarts. Actually, after any restart or deploy `hasPasskey` is false. `setSeal` then accepts a plain confirm tap, and anyone holding the member bearer token can register **their own** passkey, which is exactly what routes.ts:104 tries to prevent. The signature counter also resets, which defeats clone detection.
- Fix: Persist credentials in a `passkeys` collection (or on `members`: `{credentialId, publicKey (Binary), counter, transports, rpID}`), load them in `restore()`, and update the counter on each auth.
- Effort: M
- Scope: passkeys.ts, db.ts COLLECTIONS/indexes, service.ts restore
- Acceptance: Register a passkey, restart (restore), and `setSeal` without an assertion still fails with `PASSKEY_REQUIRED`. Register/options returns 409.

### TR5-004: Standing instructions aren't persisted, and restore re-issues them with a new 24 h expiry forever
- Severity: Medium
- Link: orchestrator.ts:43-50 (Map only) → service.ts:113-117
- Expected vs actual: Per docs/06 §3/§6, the absent member's standing permission expires 24 h after they sealed. Actually, every boot creates a **new** instruction with `expiresAt = now + 24h` (probe) for every absent member of **every non-BOOKED voyage ever stored**, including abandoned or old VOIDED ones. The spending permission never expires as long as the server restarts at least once a day. The provider calls run serially at boot, so one throw from a real provider (visa is a stub today) would crash boot. The old instructionRef isn't revoked.
- Fix: Persist `standing` (memberId, tripId, instructionRef, limitCents, expiresAt ISO) on the member or brief doc. On restore, keep the original expiry and skip expired or terminal trips (or re-issue only while `expiresAt > now`). Wrap each call in try/catch.
- Effort: S
- Scope: orchestrator.ts, service.ts restore/submitBrief
- Acceptance: A standing instruction created at T and restored at T+23 h still expires at T+24 h. After T+24 h the absent member's seal is not `standing` (docs/06 §9).

### TR5-005: Fire-and-forget replaceOne of live objects has no ordering/version guard and swallows failures
- Severity: Medium
- Link: db.ts:40-46 (and 48-52) ← every `persist`/`save` call (service.ts:126, orchestrator persist callback service.ts:74)
- Expected vs actual: Per docs/04 §4.1, `version` is for "optimistic concurrency", so writes should apply in order with failures surfaced. Actually, several replaceOne calls on the same `_id` can be in flight on different pool connections. Each serializes the live object when it's dispatched (connection.js:385), and the server may apply them out of order, so an older state can win. `version` is never used in the filter. Errors, including E11000 on `joinCode`, are logged once and dropped with no retry, and `/api/health` still reports `mongo: true`. A trip whose first upsert failed is never reconciled.
- Fix: Keep one in-flight write per (collection, _id). If more persists arrive meanwhile, set a dirty flag and write the latest snapshot once the current write finishes. Alternatively filter `{_id, version: {$lt: doc.version}}`, snapshot with `structuredClone`, and add `version` to bookings. Retry with backoff, and expose a failed-write counter in `/api/health`.
- Effort: M
- Scope: db.ts (plus `version` on BookingRec)
- Acceptance: A unit test with a fake collection that delays the first write sees the final DB doc equal to the last in-memory state. A write that keeps failing shows up in `/api/health`.

### TR5-006: Restore's `abandon` can miss provider holds in three crash windows (latent until Visa is wired)
- Severity: Medium
- Link: orchestrator.ts:177 (setBooking persists) + :181 (seals set to VOIDED before `safeVoid` at :182) → restore service.ts:120 → orchestrator.ts:83-85, :179 (`holds` filter requires AUTHORIZED\|DECLINED); orchestrator.ts:128/149 (authRef only stored after approval); :192-196 (captures not recorded until all return)
- Expected vs actual: Per docs/06 §5.3 invariant 3, nothing stays held after VOIDED. Actually: (a) a crash during `voidAll` persists `ANY_DECLINED` with seals already `VOIDED` but holds un-voided, and on restore the filter skips them; (b) seals `AUTHORIZING` at crash have no authRef, so a late approval's hold is never voided; (c) a crash mid-capture restores as ALL_AUTHORIZED → void, while some captures may have succeeded, and the booking is VOIDED over captured money. In SIM the provider state is gone anyway, so this is latent.
- Fix: In `abandon`, void every seal with an `authRef` whose status isn't CAPTURED, regardless of its recorded status (void is idempotent). Persist a `capturing` marker per seal before capture and, on restore, query the provider for the auth state. Record `authorizeRequestedAt` so orphaned AUTHORIZING instructions can be revoked.
- Effort: M
- Scope: orchestrator.ts, provider interface
- Acceptance: A test that restores a booking doc with `status:ANY_DECLINED` and seals `VOIDED` carrying `authRef` calls `provider.void` for each.

### TR5-007: Mongo unavailable at boot means permanent memory-only mode with no reconnect or alarm
- Severity: Medium
- Link: db.ts:15-35 (single attempt; index-build failure also sets `db=null`) → index.ts:12-13; render.yaml `MONGODB_URI sync:false`
- Expected vs actual: Per docs/04 §4, production should persist. Actually, one failed connect (Atlas blip, IP allow-list, 5 s timeout) or one failed `createIndex` (for example, an existing duplicate joinCode) leaves the process memory-only for its whole life. Voyages created then are lost at the next deploy, and nothing but `/api/health mongo:false` shows it. If `MONGODB_URI` is unset, a production deploy silently discards everything on each restart, including member tokens, so phones can't rejoin.
- Fix: In production (`config.production`), fail fast when `MONGODB_URI` is missing or unreachable, or retry connect with backoff and then run restore. Separate index creation from connect (log, don't disable). Surface the persistence mode prominently.
- Effort: S
- Scope: db.ts, index.ts
- Acceptance: With NODE_ENV=production and no reachable Mongo, the process exits non-zero (or keeps retrying and reports degraded health). An index error doesn't disable persistence.

### TR5-008: Ephemeral disk loses the Backboard assistant mapping, local memory and turn audio on every deploy
- Severity: Medium
- Link: memory.ts:17-18, :43-53; voice.ts:11-14, :53 → routes.ts:126-131; service.ts:343, :574; Dockerfile (no volume), render.yaml (no `disk:`)
- Expected vs actual: Advocate memory should persist "across voyages" (docs/05 §9). Actually, `backboard-assistants.json` resets on every Render deploy, so `assistantFor` creates a **new** assistant per person and all earlier Backboard memories become unreachable. `memory.json` resets to the image copy. Persisted turns keep `audioUrl`s whose mp3s are gone, so replay sends `turn:audioReady` for URLs that 404.
- Fix: Store the personKey→assistantId mapping (and local memory fallback) in Mongo (`memories` collection), or look up the assistant by name in Backboard. Serve audio from a blob store or Mongo GridFS, or clear `audioUrl` on restore when the file is missing (`existsSync(audioPath)`).
- Effort: M
- Scope: memory.ts, voice.ts, service.ts replay/restore
- Acceptance: After a redeploy (fresh container, same Mongo), `recall("maya|ORD")` returns the prior voyage lines, and replay emits no `turn:audioReady` for missing files.

### TR5-009: Local JSON stores use non-atomic read-modify-write, and assistantFor loses updates
- Severity: Medium
- Link: memory.ts:23-25 (parse error → `{}`), :74-76, :44-51
- Expected vs actual: A crash or interruption mid-write should never destroy history. Actually, `writeFileSync` truncates then writes, so a partial write → `readJson` returns `{}` → the next `remember` rewrites the file with a single entry and wipes everyone's memory. `assistantFor` reads the map, awaits the network, then writes the stale map. Two concurrent recalls (for example, a replay for two phones) drop each other's keys and create duplicate assistants.
- Fix: Write to a temp file then `renameSync`. On a parse error, back up the corrupt file instead of treating it as empty. Serialize `assistantFor` per key with an in-flight promise map, and re-read the file just before writing (or move to Mongo per TR5-008).
- Effort: S
- Scope: memory.ts
- Acceptance: A test that writes a truncated memory.json then calls `remember` keeps the old file as `.corrupt`. Parallel `recall` calls for two new keys produce both entries and one assistant per key.

### TR5-010: The driver stores `undefined` as `null`; restored docs diverge from the types and from the JSON-based restore test
- Severity: Low
- Link: db.ts:18 (MongoClient without `ignoreUndefined:true`) → mongodb/lib/bson.js:69 → service.ts:561 (`chosenPlanId` null in TripState), :586 (brief.note null), :574 (turn fields null), orchestrator.ts:92 (`reference` null)
- Expected vs actual: Optional fields should be absent. Actually they're `null` after restore (checked with bson `{ignoreUndefined:false}`). Current server reads use truthiness and still work. Clients typed `string | undefined` receive `null` (for example, `cityId: null` on turns, `note: null`). test/restore.test.ts JSON round trips drop them, so CI can't see this.
- Fix: `new MongoClient(uri, { ignoreUndefined: true, serverSelectionTimeoutMS: 5000 })`, and fake the restore test with `bson.deserialize(bson.serialize(doc, {ignoreUndefined:false}))` to match production.
- Effort: S
- Scope: db.ts, test/restore.test.ts
- Acceptance: Restored docs have no `null` optional fields, and the restore test uses BSON semantics.

### TR5-011: Dry-run clock, void reason and debug log aren't persisted, so replay after restart differs from before
- Severity: Low
- Link: service.ts:449-453, :459-464 (dryrunClock), :530 (`publicReason` only emitted), :64/:90-96 (debugLog)
- Expected vs actual: Per docs/04 §7.3, "current dryrun:script" should resume at the same minute, and a reconnecting phone should see why the booking was voided. Actually, a restart during DRY_RUN restarts the tour at day start, a paused tour becomes unpaused, `/api/debug` is empty, and the "helm restarted mid-seal, nobody was charged" reason only reaches sockets connected at boot. None are connected during restore, so nobody ever sees it.
- Fix: Store `dryrun {startedAt, pausedAt}` and `booking.publicReason` on the trip/booking docs, and include `publicReason` in `BookingPublic` or replay a `booking:result`. Optionally hydrate debugLog from `events`.
- Effort: S
- Scope: service.ts, orchestrator.ts, shared types
- Acceptance: A restore test shows dryrun:script `startedAt` equal to before the restart, and a replay for a VOIDED trip includes the public reason.

### TR5-012: Turns are embedded in the trip doc (spec: `turns` collection), so each turn rewrites the whole voyage
- Severity: Low
- Link: service.ts:333-335, :402-403 → db.ts:42; spec docs/04 §4.6, §4.9 `turns.{tripId,seq}`
- Expected vs actual: Per the spec, turns are append-only documents. Actually, every turn, hail and vote re-sends the whole TripRec, including all turns: 18 writes and 25.7 KB for 8 turns in the probe, growing O(n²), with a 16 MB doc ceiling for long voyages or retries. `audioUrl` (service.ts:343) is set without a save and depends on a later save.
- Fix: `append("turns", turn)` with a unique `{tripId, seq}` index. Keep only `seq`/`watch` on the trip, and load the last 50 turns per trip on restore/replay. Alternatively use `$push` updates instead of full replaces.
- Effort: M
- Scope: service.ts, db.ts
- Acceptance: A trip doc stays constant-size across a negotiation, and replay returns the same turns.

### TR5-013: The `events` collection drifts from spec, is unbounded, never read, and swallows errors
- Severity: Low
- Link: service.ts:97 → db.ts:48-52; spec docs/04 §4.8
- Expected vs actual: The spec shape is `{type, audience:"member:<id>", payloadRedacted, at(ISO)}` and it "powers resume + debug". Actually it's `{event, audience:"member:<name>", summary, at: Date}` with no TTL. Every `trip:state` broadcast adds a row (35 during one seed+table). Nothing ever reads it (restore and `/api/debug` use memory). `client:log` isn't recorded. Insert errors are fully silent.
- Fix: Align field names, use member ids in `audience`, add a TTL index (for example, 30 days) or capped collection, skip high-volume `trip:state` rows or store only the status, and hydrate debugLog on restore.
- Effort: S
- Scope: service.ts log, db.ts
- Acceptance: Event docs match §4.8 with a TTL index present, and `/api/debug` shows history after a restart.

### TR5-014: Persisted schemas diverge from docs/04 §4 (names, embedded vs separate collections)
- Severity: Low
- Link: service.ts:27-39, orchestrator.ts:14-22 vs docs/04 §4.1-4.7, §4.9
- Expected vs actual: The doc and code should agree. Actually: `origin` vs `originAirport`; no `voiceId`/`backboardRef`/`webauthnCredentialId`; `headset{}` vs `headsetCodeHash`; `shortlistIds`/`votes`/`autoPick`/`attempt`/`advocatedBy` undocumented; seals embedded in bookings (no `seals` collection or unique index); no `plans`/`options`/`turns` collections; `briefs._id` = memberId; epoch-number times.
- Fix: Update docs/04 §4 to the as-built schema (or rename fields), and document the embedded-seal choice and the deterministic chart-book rebuild.
- Effort: S
- Scope: docs/04 §4, §4.9
- Acceptance: Each persisted field appears in docs/04 §4 with its type.

### TR5-015: Bookings duplicate each member's private cap
- Severity: Low
- Link: orchestrator.ts:15, :59 (`capCents` in SealRec) → persisted via service.ts:74
- Expected vs actual: Caps should live only in `briefs` (private) and the provider instruction ("the member's cap never leaves their instruction or their own phone", docs/06 §3). Actually each booking attempt stores every member's cap again in `bookings`. It's needed only to compute the instruction limit at `setSeal`.
- Fix: Look up the cap from `briefs` at `setSeal` (orchestrator gets a resolver) and drop `capCents` from SealRec, or strip it in the persist callback.
- Effort: S
- Scope: orchestrator.ts, service.ts
- Acceptance: No `capCents` in any `bookings` doc, and payment tests still pass.

### TR5-016: Restore loads all history into memory with no archival
- Severity: Low
- Link: db.ts:54-57 (`find({})`) → service.ts:102-111; members.tripId/bookings.tripId indexes unused
- Expected vs actual: Only live voyages should be loaded. Actually every trip, member, brief and booking ever written is loaded on every boot and kept in Maps. `tripByCode`/`pairHeadset` do linear scans (service.ts:135, :252), and restore does provider calls for old trips (TR5-004).
- Fix: Load trips with `updatedAt` newer than N days or status not in BOOKED/VOIDED, plus their members/briefs/bookings by `tripId $in`. Lazy-load others by joinCode (using the unique index).
- Effort: M
- Scope: db.ts, service.ts
- Acceptance: Boot time and memory are independent of total historical voyages, and an old voyage still opens by code.

### TR5-017: The Docker image ships test-polluted memory.json, and tests write the real data dir
- Severity: Low
- Link: .dockerignore (no `apps/server/data/memory.json`; .gitignore has it) → Dockerfile `COPY . .`; memory.ts:16-17 used by tests (`seedExpo`, e2e)
- Expected vs actual: The image should start with an empty memory store, and tests should be isolated. Actually the local `data/memory.json` (currently 20 lines each for rae/maya/dev, mostly duplicates from test runs) is baked into the image, and every test run appends more.
- Fix: Add `apps/server/data/*.json` to .dockerignore. Make `dataDir` configurable (`DATA_DIR`), and point tests at a temp dir.
- Effort: S
- Scope: .dockerignore, config.ts, vitest setup
- Acceptance: `docker build` context has no memory.json, and `git status`/file mtime are unchanged after `npm test`.

### TR5-018: Memory identity `name|origin` collides across different people
- Severity: Low
- Link: memory.ts:21 → service.ts:289, :544
- Expected vs actual: Memory should belong to one person. Actually any traveller named "Maya" flying from ORD inherits another Maya's voyages and budget band. Those are shown in her `brief:private` and fed to her Advocate.
- Fix: Key memory by a stable user identity (for example, the passkey credential or an explicit opt-in link), or at least ask for confirmation before using recalled memory.
- Effort: M
- Scope: memory.ts, service.ts
- Acceptance: Two different members with the same name and origin in separate voyages don't see each other's memory.

### TR5-019: Read-only filesystem can crash boot or silently disable memory and voice
- Severity: Low
- Link: voice.ts:13-14 and memory.ts:16 (`mkdirSync` at import) ; memory.ts:76 (local write before the Backboard write); voice.ts:51-53
- Expected vs actual: The service should degrade gracefully. Actually, with a read-only root FS (for example, a hardened k8s pod) `.cache` doesn't exist in the image (dockerignored), so `mkdirSync` throws EROFS at import and the server doesn't boot. If directories exist but are read-only, `remember` throws before the Backboard POST (memory lost even with Backboard), and TTS returns null after a paid ElevenLabs call.
- Fix: Wrap `mkdirSync`/`writeFileSync` in try/catch, do the Backboard write regardless of the local write, and let `synthesize` return audio in memory when the cache write fails.
- Effort: S
- Scope: memory.ts, voice.ts
- Acceptance: Booting with `.cache` unwritable logs a warning and serves captions. `remember` with an unwritable dataDir still posts to Backboard.

### TR5-020: `.cache/audio` grows without bound
- Severity: Low
- Link: voice.ts:53 (a per-turn copy of the same bytes as `.cache/tts/<sha1>.mp3`)
- Expected vs actual: Audio should be bounded or deduplicated. Actually there's one mp3 per turn forever, duplicating the TTS cache.
- Fix: Store `turnId → sha1` and serve the TTS cache file directly (a symlink or a map persisted on the turn), and add LRU/age cleanup.
- Effort: S
- Scope: voice.ts, routes.ts:126-131
- Acceptance: Replaying the same Expo run N times doesn't grow `.cache/audio`.

### TR5-021: AT_TABLE → BRIEFING reset on restore is neither persisted nor announced
- Severity: Low
- Link: service.ts:106
- Expected vs actual: Clients should learn that the table was interrupted, and the DB should reflect the reset. Actually the DB keeps `AT_TABLE` with the old turns (redone each boot). Reconnecting clients get `trip:state BRIEFING` with no reason and may keep showing cached turns, since clients are idempotent on turnId but not told to clear.
- Fix: `save(t)` after the reset, and set a `resetReason` (surfaced in state, or replay an `error`/`table:reset` event) so clients clear their turn log.
- Effort: S
- Scope: service.ts, web clients
- Acceptance: After restore of an AT_TABLE trip, the DB status is BRIEFING and a reconnecting phone shows "the table was interrupted" with an empty log.

### TR5-022: Plans are rebuilt from the dataset on restore, but dataset drift isn't detected
- Severity: Low
- Link: service.ts:295-303, :373-377 (`filter(Boolean)`), :470 (`find(...)!` → `plan.cityId`); TripRec.presetId stored at :180 but never checked
- Expected vs actual: Persisted `shortlistIds`/`chosenPlanId`/`booking.planId` should resolve after a deploy. Actually, a changed dataset.json makes the shortlist silently empty. `pick()` then throws a TypeError on an undefined plan, and seal replays are skipped.
- Fix: Persist a dataset hash on the trip and compare it on restore (warn, and move the trip to BRIEFING or VOIDED on mismatch), or snapshot the two shortlisted plans into the trip doc.
- Effort: S
- Scope: service.ts, data/loader.ts
- Acceptance: A restore with an altered dataset produces a clear status and no exceptions.

### TR5-023: The headset pairing code hash is brute-forceable if the DB leaks
- Severity: Low
- Link: service.ts:245-246 → ids.ts:8 (unsalted SHA-256 of 6 chars from 32 symbols ≈ 2^30)
- Expected vs actual: Stored secrets should resist offline guessing. Actually, anyone reading `trips` during the 10-minute window can recover the code in seconds and pair a headset (organizer controls). Member and device tokens are fine (256-bit).
- Fix: Use HMAC with a server secret (or a random salt plus a slow hash) for short codes, or stop persisting the pending code (it's short-lived; accept loss on restart).
- Effort: S
- Scope: service.ts, ids.ts
- Acceptance: `trips.headset.codeHash` can't be reversed without the server secret.

---

## Summary counts
- Write-path rows: 39 (✅ 16, flagged 23). Schema rows: 6 (1 ✅, 5 drift). Restore status rows: 10.
- Issues: **23**. High 3 (TR5-001, 002, 003) · Medium 6 (TR5-004 to 009) · Low 14 (TR5-010 to 023).
