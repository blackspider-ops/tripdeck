# Traceability Layer 4 (round 2): TripService ⇄ domain modules

Repo: `/Users/tejas/Downloads/untitled folder 3` @ `0430ef9`. This was a read-only review; the only file written is this report.
`cd apps/server && npx vitest run` passed: **308/308 tests in 29 files**. `npx tsc --noEmit` exited 0.
Paths are relative to `apps/server/src/`. `svc` means `trips/service.ts`, the facade. Every public method on it forwards one-to-one to a module in `trips/`, and the rows below cite the module that does the work.

**How this was checked.** I read every file in `trips/*` and every callee listed below. Then I ran four throwaway scripts from the scratchpad (`r2-t4/`), outside the repo.
- `walk.mts` and `walk2.mts` run the service in-process through `npx tsx`.
- `race.mts` and `race2.mts` probe races.
- `restart.probe.test.ts` runs a restart with vitest and `test/support/fakeDb.ts`.

Every run used `GEMINI_API_KEY= ELEVENLABS_API_KEY= BACKBOARD_API_KEY= MONGODB_URI= PACE_SCALE=0`, `PAYMENTS_MODE=sim` with SIM latency of 5–10 ms, and `DATA_DIR`/`CACHE_DIR` pointed at the scratchpad. So nothing paid or remote was called, and `apps/server/data` was never touched.

Legend: ✅ means the arguments, units, return value and error handling are all correct. ⚠️ means it works but has a gap. ❌ means a defect, with a link to its finding.

**Round-1 carry-over.** I re-checked TR4-001…TR4-020 against the new modules, and all 20 are fixed as described. Specifically:
- `requireActive` is used by every member action.
- Standing instructions come back with their original expiry.
- The chart book is 12 plans with one shared privacy context.
- `deferStanding` holds standing seals back until the booking is announced (TR1-015).
- The note reaches the member's own Advocate via `noteForPrompt`.
- The VOIDED memory note is written.
- `dryrunControl` only works in DRY_RUN.
- `sailWithout` is idempotent.

TR4-002 is only partly done: the `transition()` and `TRANSITIONS` table are in, but no caller passes `expectVersion` (doc 04 §5 now says so). TR4-020 has a new race hole, filed as L4-003.

---

## 1. Call graph

### 1a. Construction and the core (`trips/core.ts`)

| # | Caller | Callee (signature) | Args / units | Return use & errors | ✓ |
|---|---|---|---|---|---|
| 1 | core:28 field init | `data/loader.loadDataset(): Dataset` | – | cached dataset; a bad JSON throws at boot | ✅ |
| 2 | core:39 ctor | `payments/select.selectPaymentProvider(mode): PaymentProvider` | `config.payments.mode` | always SIM today (visaVic stub returns null → warns → SIM); `mode` reported honestly | ✅ |
| 3 | core:39 ctor | `new PaymentsOrchestrator(provider, events)` | events `{sealStatus, declinedPrivate, result, persist}` | `result` → abstract `onBookingResult` → `sealing.onBookingResult` (the field is initialised after `super()` but only called later) | ✅ |
| 4 | core:40 sealStatus cb | `orchestrator.publicSealStatus(s)` | SealStatus | DECLINED→VOIDED mask (the orchestrator already sends only public statuses) | ✅ |
| 5 | core:43 persist cb | `records.bookingDoc(b)` → `store/db.persist("bookings")` | BookingRec | strips `capCents`, bumps `version` | ✅ |
| 6 | core:57/62 `toTrip`/`toMember` | `bus.trip/member` + `log` → `db.append("events")` | typed `S2CPayload<K>` | `toTrip` throws for PRIVATE_EVENTS / `error` (runtime guard + compile-time `TripRoomEvent`) | ✅ |
| 7 | core:124 `save` | `db.persist("trips", tripDoc(t))` | TripRec without turns | `version++` and `updatedAt`, fire-and-forget | ✅ |
| 8 | core:126 `persistTurn` | `voice.audioKeyOf(turnId)` + `persist("turns")` | turnId | the audio cache key is stored with the turn (TR4-015) | ✅ |
| 9 | core:180/185 `memberByToken`/`deviceOk` | `util/ids.sameHash(plain, hashed?)` | token, sha256 hex | boolean; the device also expires, and dies with BOOKED | ✅ |
| 10 | core:212–213 `memKey`/`memoryFor` | `memory.personKey(crewKeyHash, name)` → `memory.recall(key): Promise<string[]>` | the crew-key hash, not name/origin | `recall` never rejects (local store and Backboard both catch) | ✅ |
| 11 | core:225 `sweep` (index.ts `setInterval`, unref) | `evictTrip` → `payments.standing.delete` | – | ⚠️ the voyage's bookings stay in `payments.bookings` (**L4-010**) | ⚠️ |
| 12 | core:111 `transition` | `TRANSITIONS[t.status]` | `from?`, `expectVersion?` (unused), `reason?` | throws `BAD_PHASE`; the same status is a no-op even if `from` excludes it | ⚠️ **L4-006** |

### 1b. Crew (`trips/crew.ts`)

| # | Caller | Callee (signature) | Args / units | Return use & errors | ✓ |
|---|---|---|---|---|---|
| 13 | `createTrip` :33–39 | `ids.newJoinCode/newId/nowIso`, `records.datasetHash(ds)` | – | join codes are de-duplicated through `findByCode`; a failed organizer seat removes the trip | ✅ |
| 14 | `addMember` :59–73 | `util/text.clean(s, NAME_MAX_CHARS)`, `memory.validCrewKey/crewKeyHash`, `ids.hash/newToken`, `persist("members")` | – | returns `{member, token, crewKey}`; `CREW_FULL / BAD_PHASE / BAD_INPUT / BAND_TAKEN` | ✅ |
| 15 | `claimAbsent` :135 | `sameHash(inviteKey, inviteKeyHash)`, `crewKeyHash` | invite key (256-bit) | `BAD_INVITE / OWN_INVITE`; single use | ✅ |
| 16 | `submitBrief` :160 | `validateBrief(input, ds)` → `loader.indexOf(ds).window`, `clean(note, NOTE_MAX_CHARS)` | `capCents` **cents** in 30 000–300 000 (rounded) | `BAD_INPUT` | ✅ |
| 17 | `submitBrief` :168 | `payments.createStanding(memberId, capCents, expiresAt)` | **cents**, **epoch ms** (`sealedAt + STANDING_TTL_MS`) | awaited and caught (the member then seals live); the phase is re-checked after the await | ⚠️ the seat is **not** re-checked after the await (**L4-003**) |
| 18 | `submitBrief` :184 | `transition(t,"BRIEFING",{from:["VOIDED"]})` + `table.clearCharts` | – | no owed-refund check on this edge (**L4-001**); any member can trigger it (**L4-002**) | ❌ |
| 19 | `submitBrief` :187 | `replayer.briefPrivate(m, briefOut(rec), send)` → `memoryFor` | – | `{later}` is awaited after `broadcastState` | ✅ |
| 20 | `sailWithout` :195–213 | `requireOrganizer`, `payments.standing.delete`, `evictSockets` | memberIds[] | skips sealed members, the organizer and repeats | ⚠️ races with the absent `submitBrief` (**L4-003**) |

### 1c. The table (`trips/table.ts`), with the engine callbacks

| # | Caller | Callee (signature) | Args / units | Return use & errors | ✓ |
|---|---|---|---|---|---|
| 21 | `chartBook` :50 | `fit/pricing.buildChartBook(ds, crew: PricingMember[], cityIds, limit=12): Plan[]` | limit **12** (CHART_BOOK_LIMIT) | stored `shortlistPlans` win over re-priced ones (TR5-022) | ✅ |
| 22 | `chartBook` :59 | `privacy/context.buildPrivacyContext(ds, priced, book)` | caps and shares in cents → dollars inside | built together with the book, so one context (TR4-012) | ✅ |
| 23 | 2nd order | `pricing.buildPlan` → `dryrun/walking.travel(ds, from: Point, to: Point)`; `fit/fairness.satisfaction/fairness/compareFairness` | lat/lng; minutes | pure; Expo prices reproduce exactly (§3) | ✅ |
| 24 | `publicShortlist` :83 | `pricing.toPublic(ds, plan, "A"\|"B")` | – | memoised per pair (WeakMap) | ✅ |
| 25 | `emitShortlist` :210 | `pricing.toPrivate(plan, memberId): PlanPrivate\|null` | – | only to that member (`toMember`) | ✅ |
| 26 | `datesLabel` :95 | `loader.indexOf(ds).window.get(id)` | – | `null` when there is no common window (TR4-005); verified in §3.5 | ✅ |
| 27 | `startTable` :127 | `util/settings.tableRunsMax()` | default 6 | `TOO_MANY_RUNS` 429; ⚠️ a restart or engine failure uses up a run (**L4-009**) | ⚠️ |
| 28 | `startTable` :129 | `transition(t,"AT_TABLE",{from:["BRIEFING"]})` | – | synchronous before any await, so a double tap gives `BAD_PHASE` (verified) | ✅ |
| 29 | `startTable` :145 | `memoryFor(m)` ×N (`Promise.all`) | – | recall never rejects, so the voyage can't get stuck in AT_TABLE | ✅ |
| 30 | `startTable` :147 | `new NegotiationEngine(ds, crew+band, plans, cityIds, datesLabel\|null, io, privacy)` | matches `engine.ts:58` in order and type | – | ✅ |
| 31 | engine → `io.emitTurn(e, watch)` :151 | `persistTurn`, `toTrip("turn:new")` | watch 0–3 | returns turnId; `seq` is shared with hails | ✅ |
| 32 | engine → `io.voice(turnId, text, key)` :159 | `voice.synthesize(turnId, text, voiceKey): Promise<number\|null>` | key `"captain"` or band `"1".."4"`; ms | `null` → captions; catches internally; re-persists the turn with `durationMs` | ✅ |
| 33 | engine → `io.onWatch(w)` :168 | `toTrip("table:watch")` | – | not saved (a restart resets the table anyway) | ✅ |
| 34 | engine → `io.takeHails()` :169 | drains `pendingHails` | – | parsed by `rules.parseHail` in `collectHails` | ✅ |
| 35 | engine → `io.cancelled()` :170 | `t.status !== "AT_TABLE"` | – | never true while an engine runs (no cancel path today); doesn't compare `round` | ✅ |
| 36 | engine → `io.memory(id)` :171 | prefetched map | – | fed to `prompts.advocateFacts` → `guard.memoryForPrompt` | ✅ |
| 37 | engine → `io.closeHails()` :150 | `hailsClosed.add` | – | called synchronously just before DECIDE, with no await between the last `collectHails` and it | ✅ |
| 38 | engine internals | `rules.*`, `phrasing.*`, `prompts.*`, `gemini.generateLine` (only when `features.gemini()`), `guard.sanitizeSpoken(out, privacy)` | – | the template path in these runs; 0 redactions in the Expo run | ✅ |
| 39 | `startTable` :177 `engine.run().then(ok, fail)` | – | – | guarded by status and `round`; `emitShortlist` in try/catch; the failure path → `resetTable` + `table:failed` | ✅ |
| 40 | `hail` :224–235 | `requireActive`, `clean(text,160)`, `guard.sanitizeHail(text, privacyOf(t))` | – | `CAPTAINS_CALLING / HAIL_WAITING / SLOW_DOWN / HAIL_AMOUNTS`; ⚠️ accepted during the Captain's OPEN (watch 0) (**L4-005**) | ⚠️ |

### 1d. Dry Run and sealing (`trips/dryrun.ts`, `trips/sealing.ts`)

| # | Caller | Callee (signature) | Args / units | Return use & errors | ✓ |
|---|---|---|---|---|---|
| 41 | `vote` :19 | `records.tallies(t)` (only seats still held) | – | a strict majority arms, a split cancels | ✅ |
| 42 | `armAutoPick` :30 | `setTimeout(ms)` → `h.pick(tripId,{memberId: organizerId}, planId)` | **ms** (AUTOPICK_MS = 20 000, or the remaining time on restore) | `.catch` logs; re-checks DRY_RUN and the same plan | ✅ |
| 43 | `pick` :24–28 | `briefs.get(m.memberId).capCents` | shares: `amountCents` / `capCents` in **cents** | `BRIEFS_PENDING` before any mutation | ✅ |
| 44 | `pick` :32 | `payments.create({tripId, planId, cityId, attempt, shares}, {deferStanding:true}): BookingRec` | matches orchestrator:113 | ⚠️ doesn't check an earlier booking that still owes a refund (**L4-001**) | ❌ |
| 45 | `pick` :34–38 | `transition(SEALING,{from:[DRY_RUN]})`, `toTrip("booking:created", payments.toPublic(b))`, `payments.startStanding(id)` | – | the order is right: booking:created comes before any seal:status (verified) | ✅ |
| 46 | `pick` :40 / `sealPrivateFor` :55 | `payments.cardLast4(memberId)` → `provider.ensureAgentCard` | – | caught → `••••`; `allSettled` so pick can't fail after the booking exists | ✅ |
| 47 | `setSeal` :75–76 | `passkeys.hasPasskey(memberId)`, `passkeys.consumeAssertion(memberId, bookingId, token)` | the argument order matches `passkeys.ts:206` | `PASSKEY_REQUIRED` 403 | ✅ |
| 48 | `setSeal` :80 | `payments.setSeal(bookingId, memberId, {approvedWithPasskey}): Promise<"ok"\|"locked"\|"none">` | a flag, not the token (TR4-014) | `locked` → `SEAL_LOCKED`; `none` is ignored (unreachable after the helm's checks) | ✅ |
| 49 | `cancelSeal` :90 | `payments.cancelSeal(bookingId, memberId): SealOutcome` | – | `locked` → `SEAL_LOCKED` | ✅ |
| 50 | `callOff` :106 | `payments.callOff(bookingId): Promise<boolean>` | – | `false` → `CAPTURING`; ⚠️ also `false` while the booking is voiding (**L4-004**) | ⚠️ |
| 51 | `retry` :117–118 | `payments.owesRefund(b)`, `void payments.redrive(b).catch` | – | `NEEDS_ATTENTION` 409 | ✅ |
| 52 | `retry` :121–127 | `transition(DRY_RUN,{from:[VOIDED]})`, `cancelAutoPick`, `table.emitShortlist` | – | ⚠️ `emitShortlist` can throw after the transition and save (**L4-007**) | ⚠️ |
| 53 | orchestrator `events.result` → `onBookingResult` :130–142 | `transition(BOOKED\|VOIDED)` (no `from`), `toTrip("booking:result")` | – | stale attempts are ignored (a `bookingId` guard) | ⚠️ **L4-006** |
| 54 | `onBookingResult` :140 | `writeMemories` / `writeVoidedMemories` → `memory.remember(key, text)`, `memory.budgetBand(capCents)` | **cents** (80 000 / 130 000 thresholds) | `void …catch` logs; ⚠️ one note per voided attempt (**L4-008**) | ⚠️ |
| 55 | `voyageLine` | `loader.cityName(ds, cityId)`, `datesLabel(t)` (the chosen plan's window) | – | "voyage: Lisbon, Mar 12 to 16" | ✅ |

### 1e. Identity, replay and persistence

| # | Caller | Callee (signature) | Args / units | Return use & errors | ✓ |
|---|---|---|---|---|---|
| 56 | `identity.headsetCode/pairHeadset` | `ids.newRef(8)`, HMAC `settings.pairingSecret()`, `timingSafeEqual` | TTL 10 min / device 12 h (ms) | `BAD_CODE` 403 | ✅ |
| 57 | `identity.mint/redeemHandoff` | `ids.hash/newToken`, `memberByToken` | TTL 2 h (ms) | single use; `BAD_HANDOFF` | ✅ |
| 58 | `replayer.state` | `sealing.currentBooking`, `payments.toPublic`, `loader.indexOf(ds).city` | – | the booking only in SEALING/BOOKED/VOIDED (TR4-013) | ✅ |
| 59 | `replayer.replay` | `table.shortlist/publicShortlist`, `dryrun.script`, `pricing.toPrivate`, `sealing.sealPrivateFor` | – | the order matches doc 04 §7.3 | ✅ |
| 60 | `store.restore` :88–95 | `db.onDbConnected(fn)` (a single hook, not stacked), `db.loadWhere`, `passkeys.loadPasskeys()` | – | awaited; one voyage failing is logged and skipped | ✅ |
| 61 | `loadVoyages` :151 | `voice.restoreTurnAudio(turnId, key): Promise<boolean>` | a 40-hex key | false → `audioUrl` dropped | ✅ |
| 62 | `restoreStanding` :272/277 | `payments.restoreStanding(ins)` / `payments.createStanding(id, capCents, expiresAt)` | the original expiry (epoch ms) | caught per member | ✅ |
| 63 | `reconcileBooking` :290–311 | `payments.redrive(b)` / `payments.recover(b)` | – | `recover` → `voidAll` → `onBookingResult` (SEALING→VOIDED) | ✅ |
| 64 | `settleRestored` :171 | `dryrun.armAutoPick(t, planId, max(0, at−now))` | **ms** | re-armed; fires immediately if it lapsed while down | ✅ |
| 65 | `settleRestored` :180 | `payments.recover(orphan)` | – | `.catch` | ✅ |
| 66 | `syncAfterReconnect` | `restore({merge:true})`, `persist(*)`, `passkeys.persistAllPasskeys()` | – | memory wins on merge | ✅ |

Unhandled rejections seen across every scripted run: **none**.

---

## 2. Trip state-transition table (`TRANSITIONS`, records.ts:88)

Every status change goes through `HelmCore.transition()`. `grep` finds exactly one `t.status =` write (core.ts:120) and no status writes outside `trips/`. No `transition()` call site tries an edge that isn't in the table.

| Edge | Call site | Guards before the call | `from` | Verdict |
|---|---|---|---|---|
| (create) → BRIEFING | crew.ts:37 (literal) | – | – | ✅ |
| BRIEFING → AT_TABLE | table.ts:129 `startTable` | organizer/headset; BRIEFING; ≥2 active; all sealed; `tableRuns < 6` | `[BRIEFING]` | ✅ (double tap → BAD_PHASE, verified) |
| AT_TABLE → DRY_RUN | table.ts:179 engine success | still AT_TABLE and the same `round` | `[AT_TABLE]` | ✅ |
| AT_TABLE → BRIEFING | table.ts:111 `resetTable` (engine failure :194; restore persistence.ts:212) | AT_TABLE and the same round / boot | `[AT_TABLE]` | ✅; ⚠️ still counts a table run (L4-009) |
| DRY_RUN → SEALING | sealing.ts:34 `pick` (manual, headset, auto-pick) | organizer/headset; DRY_RUN; the plan is in the shortlist and resolves; every share has a brief | `[DRY_RUN]` | ❌ no owed-refund check (L4-001) |
| DRY_RUN → BRIEFING | persistence.ts:215 (terms missing), :236 (charts missing) | restore only | none | ✅ |
| SEALING → BOOKED | sealing.ts:135 `onBookingResult(CAPTURED)`; persistence.ts:304 | `t.bookingId === b._id`; status ∈ S/B/V | none | ⚠️ L4-006 |
| SEALING → VOIDED | sealing.ts:135 (declined, lifted, deadline, call-off, capture failure); persistence.ts:295/304/311 | same | none | ✅ |
| BOOKED → VOIDED | persistence.ts:304 (the booking record says so) | restore | none | ⚠️ also reachable from the live `onBookingResult` because it passes no `from` (L4-006) |
| VOIDED → DRY_RUN | sealing.ts:121 `retry` | organizer/headset; VOIDED; `!owesRefund(current)` | `[VOIDED]` | ⚠️ the charts aren't checked first (L4-007) |
| VOIDED → BRIEFING | crew.ts:184 `submitBrief` (**any** active member); persistence.ts:215 (restore) | VOIDED | `[VOIDED]` / none | ❌ skips the SEC-016 owed-refund gate (L4-001); any member can trigger it (L4-002) |
| VOIDED → BOOKED | persistence.ts:304; `onBookingResult` | restore / booking record | none | ⚠️ L4-006 |

Notes: `expectVersion` is never passed (documented in doc 04 §5 as "clients don't send a version today"). `transition()` returns early when `t.status === to`, before it checks `from`.

---

## 3. Expo walk-through (in-process, `walk.mts` / `walk2.mts`)

### 3.1 Happy path: seedExpo → startTable → hail → votes → pick → seals → BOOKED
| Step | Observed | Expected | |
|---|---|---|---|
| seed | BRIEFING, Rae✓ Maya✓ Dev✓, Dev has a standing instruction | same | ✅ |
| table (Rae hails the moment her mate PROPOSEs) | `OPEN@w0 PROPOSE@w1 ×3 HAIL@w2 OBJECT@w2 SUPPORT@w2 CONCEDE@w2 DECIDE@w2`; 8 voiced lines; 0 redactions | doc 05 §315 / e2e: the same 9 turns, 8 voiced | ✅ |
| memory line | Maya's PROPOSE: "…My friend gave up the city pick last time." | Expo line | ✅ |
| CONCEDE | "Heard you, Rae. Lisbon it is — as long as we keep the food tour." | "Heard you, Rae" opener | ✅ |
| Two Charts | `MEX-W1-roma-flat` / `LIS-W1-casa-alfama` | same | ✅ |
| **Lisbon** | group **$2,869**; Rae **$1,038**, Maya **$868**, Dev **$963** | $2,869; $1,038/$868/$963 | ✅ |
| **Mexico City** | group **$1,975**; Rae $708, Maya $598, Dev $669 | $1,975 | ✅ |
| Maya's `plan:private` | LIS 86 800 missing []; MEX 59 800 missing ["beach"] | e2e | ✅ |
| votes Maya+Dev → LIS | tallies `{LIS:2}`, auto-pick armed | D5 | ✅ |
| double `pick` | `ok / BAD_PHASE`; autoPick cleared; attempt 1 | a single booking | ✅ |
| booking | $2,869; seals Rae $1,038, Maya $868, Dev $963 (standing); `seal:private` amounts are the same | – | ✅ |
| ordering | `booking:created` before the first `seal:status` | TR1-015 | ✅ |
| Rae double seal tap | `ok / SEAL_LOCKED` | – | ✅ |
| result | trip BOOKED; booking CAPTURED; ref `AA-LIS-xxxx`; captured 3, held 0 | – | ✅ |
| after BOOKED | setSeal / callOff / retry → `BAD_PHASE` | – | ✅ |
| privacy | the trip room carried no private event and none of 103800/86800/96300/110000/90000/140000/`capCents` | – | ✅ |

### 3.2 Void → retry paths
| Step | Observed | |
|---|---|---|
| Maya lifts her seal (after Rae set hers) | VOIDED, held 0, "One share didn't clear, so nobody was charged."; `seal:declinedPrivate` only to Maya | ✅ |
| retry by Maya | `NOT_ORGANIZER` | ✅ |
| retry by Rae | DRY_RUN, votes `{}`, `state().booking` hidden; the old booking's seal → `BAD_PHASE` | ✅ |
| attempt 2, MEX $1,975, SIM declines Maya | VOIDED; public seal statuses only `AUTHORIZED, VOIDED` (no DECLINED); held 0 | ✅ |
| attempt 3, LIS | BOOKED, $2,869, captured 3, held 0 | ✅ |

### 3.3 Races (`walk.mts` §3, `race.mts`, `race2.mts`)
| Race | Observed | |
|---|---|---|
| last seal ∥ callOff | callOff wins; VOIDED; held 0, captured 0 | ✅ |
| seal deadline (50 ms) | VOIDED "Not every seal was set in time…"; held 0 | ✅ |
| double startTable | `ok / BAD_PHASE`, tableRuns 1 | ✅ |
| double callOff | `ok / CAPTURING: Every seal is set; the booking is being logged.` while the booking was voiding | ⚠️ L4-004 |
| hail in BRIEFING / after watch 3 / during DECIDE | `CAPTAINS_CALLING` | ✅ |
| hail during the Captain's OPEN (watch 0) | **accepted**, stamped `watch 2`, `seq` before the Watch-1 proposals | ⚠️ L4-005 |
| sailWithout(Dev) while Dev's absent `submitBrief` is awaiting the provider | submitBrief → ok; Dev is **removed yet briefSealed, with a brief and a live standing instruction** (in memory and in `m.standing`) | ❌ L4-003 |
| two concurrent absent submits | last wins everywhere (brief cap = standing limit = `m.standing`) | ✅ |
| Maya re-seals in VOIDED | → BRIEFING; the organizer's retry is now `BAD_PHASE` | ⚠️ L4-002 |
| capture fails + refund fails | VOIDED, needsAttention, retry → `NEEDS_ATTENTION` ✅; **Rae re-seals → BRIEFING → startTable → pick ok → SEALING while the old booking still owes a refund** | ❌ L4-001 |

### 3.4 Restart (`restart.probe.test.ts`, fakeDb)
| Case | Observed | |
|---|---|---|
| restart mid-table | BRIEFING, "The helm restarted while the table was meeting…", round 2, 0 turns attached; the next table is round 3 with 8 turns; **tableRuns went 1 → 2** | ✅ / ⚠️ L4-009 |
| restart after the L4-001 bypass | the old booking is loaded (needsAttention true) and re-driven as the voyage's current booking | ✅ |

### 3.5 No common date window (Rae W1, Maya W2)
`datesLabel` = null. OPEN: "No dates suit everyone; we'll weigh the closest…". The book has 12 plans and the Two Charts are `MEX-W2-condesa / YUL-W2-old-mtl`, both with `fitsEveryone=false`. That matches TR4-005 as designed ✅.

---

## 4. Findings

### L4-001 — The SEC-016 owed-refund gate can be bypassed by going VOIDED → BRIEFING → new table → pick
- **Severity:** High
- **Location:** `trips/crew.ts:159,184` (`submitBrief` VOIDED branch); `trips/sealing.ts:16–34` (`pick` has no refund check); `trips/persistence.ts:214–218` (the same edge on restore).
- **Evidence:** `walk.mts` §4. A capture fails and the refund fails, so the voyage is VOIDED with `needsAttention=true` and `owesRefund=true`. `retry` → `NEEDS_ATTENTION` ✅. But after `submitBrief(Rae)` → BRIEFING, `startTable` works, and then `pick` → **SEALING, attempt 2**, while `owesRefund(oldBooking)` is still `true`. Crew members are asked to pay again before their earlier capture is refunded, which is exactly what doc 04 §403 and doc 06 §5.2 (SEC-016) forbid. `pick` also overwrites `t.bookingId`, so the owing booking stops being the voyage's current booking. `debugSummary` and `retry` no longer see it, and it is re-driven only on the next restart, as an orphan.
- **Fix:** Enforce the gate at the single money choke point. In `pick`, before `payments.create`, check every booking of this voyage for `owesRefund` (by `t.bookingId`, or scan `payments.bookings` by `tripId`). If one owes, fire `void payments.redrive(b)` and throw `NEEDS_ATTENTION` 409. Optionally refuse the VOIDED→BRIEFING edge in `submitBrief` with the same code, so the crew doesn't run a table it can't book.
- **Effort:** S (about 10 lines plus 1 test)
- **Scope:** sealing.ts (plus optionally crew.ts)
- **Acceptance:** The new test fails capture and refund, then calls `submitBrief` → `startTable` → `pick`. `pick` rejects with `NEEDS_ATTENTION`, the voyage stays DRY_RUN, and no second booking exists. After the refund goes through, `pick` succeeds.

### L4-002 — Any crew member's re-seal in VOIDED throws away the Two Charts and the organizer's "back to the charts"
- **Severity:** Low (spec-conformant: doc 04 §5 "member edits brief → BRIEFING (re-negotiate; rare)")
- **Location:** `trips/crew.ts:159,184`
- **Evidence:** In `walk.mts` §3, Maya re-seals in VOIDED → BRIEFING, `clearCharts`, and the organizer's `retry` → `BAD_PHASE`. The crew must hold a new table, which costs a table run (max 6) plus model and voice spend. Nothing asks the organizer first, and any member can do it, including an absent friend with a claimed link.
- **Fix:** Pick one and document it: (a) re-sealing in VOIDED stores the new terms but keeps VOIDED until the organizer starts a new table (`startTable` accepting VOIDED); or (b) only the organizer's action moves VOIDED→BRIEFING.
- **Effort:** S
- **Scope:** crew.ts, table.ts, doc 04 §5
- **Acceptance:** After a member re-seals in VOIDED, the organizer can still choose "back to the charts" or "new table".

### L4-003 — "Sail without them" during an absent member's in-flight `submitBrief` leaves the removed seat sealed with a live standing instruction
- **Severity:** Medium (TR4-020 regression through a race)
- **Location:** `trips/crew.ts:164–183`. After `await createStanding` only the phase is re-checked (:173), not the seat. `sailWithout` (:202) skips members that are already `briefSealed`, but this member isn't sealed yet.
- **Evidence:** `race.mts`. `submitBrief(Dev)` is started without an await, then `sailWithout([Dev])` runs. Right after `sailWithout`: removed = true, standing = false. After `submitBrief` resolves ("ok"): removed = true, `briefSealed = true`, brief stored and persisted, `m.standing` set and persisted, and `payments.standing` holds a $1,400-limit instruction. A payment permission now exists for a seat that was released. It can't be charged, because plans only include active members, but it breaks the "nothing issued for a removed seat outlives it" invariant, and the persisted brief and member docs disagree with the crew.
- **Fix:** After the await, re-run `h.requireActive(t, memberId)` next to the phase check. On failure, restore `prev` / delete the new instruction and throw `NOT_MEMBER`. The same one-liner also covers a non-absent member (currently no await there).
- **Effort:** XS
- **Scope:** crew.ts
- **Acceptance:** With the interleaving above, `submitBrief` rejects `NOT_MEMBER`, `payments.standing` has no entry for Dev, and no brief is stored.

### L4-004 — A second or concurrent call-off gets `CAPTURING` ("the booking is being logged") while the booking is actually voiding
- **Severity:** Low
- **Location:** `trips/sealing.ts:103–106`; `payments/orchestrator.ts:162–166`. `callOff` returns `false` for `ANY_DECLINED` as well as for `ALL_AUTHORIZED`, and the trip stays SEALING until `voidAll` finishes its releases.
- **Evidence:** `race2.mts`: two `callOff`s → `ok / CAPTURING: Every seal is set; the booking is being logged.`, then the voyage goes VOIDED. The same happens for a call-off during a decline or deadline void. The organizer or headset is told the opposite of what is happening.
- **Fix:** Have `payments.callOff` return a tri-state (`"voided" | "voiding" | "capturing"`). Map `voiding` to success (idempotent) or to `BAD_PHASE` "Already calling it off".
- **Effort:** XS
- **Scope:** orchestrator.ts, sealing.ts
- **Acceptance:** A double call-off → second call gets ok or a voiding message, never `CAPTURING`.

### L4-005 — A hail during the Captain's OPEN (watch 0) is accepted and logged ahead of the Watch-1 proposals
- **Severity:** Low
- **Location:** `trips/table.ts:226,240`. The guard is `AT_TABLE && running && watch < 3 && !hailsClosed`, so watch 0 passes.
- **Evidence:** `walk.mts` §1: "hail during OPEN (watch 0): ok"; the turn log reads `OPEN@w0 HAIL@w2 PROPOSE@w1 …` (clients sort by `seq`, `web/src/net/tripStore.ts:119`). `scripts/warm-voice-cache.ts:20` says "hails before Watch 1 are refused", and the code doesn't match that comment. The hail does steer Watch 2 as doc 05 §108 describes, so the only problems are the order in the log and the comment.
- **Fix:** Either refuse while `watch < 1` (a new code such as `TABLE_OPENING`, "Wait for the mates to speak"), or hold the HAIL turn back and emit it when Watch 1 ends. Then fix whichever of the comment or the doc is wrong.
- **Effort:** XS
- **Scope:** table.ts, warm-voice-cache.ts comment
- **Acceptance:** A hail at watch 0 is refused (or appears after the Watch-1 turns), and a test pins that behaviour.

### L4-006 — `onBookingResult` transitions without `from`, so the restore-only edges are reachable live; `from` is ignored on a same-status call
- **Severity:** Low (defence in depth)
- **Location:** `trips/sealing.ts:134–135`; `trips/core.ts:115`
- **Evidence:** The guard accepts `status ∈ {SEALING, BOOKED, VOIDED}` and then calls `transition(t, BOOKED|VOIDED)` without `from`. TRANSITIONS documents BOOKED→VOIDED and VOIDED→BOOKED as "restore only", but a late or duplicate `events.result` for the current booking would take them live and would also write a second memory note. The orchestrator doesn't emit twice today, so this is latent. Separately, `transition()` returns before it checks `from` when `t.status === to`, so a caller's precondition is silently skipped.
- **Fix:** Use `from: ["SEALING"]` in `onBookingResult` and return early otherwise. The restore paths already go through `reconcileBooking`, and a live `recover` still arrives in SEALING. Move the `from` check above the same-status return, or document it.
- **Effort:** XS
- **Scope:** sealing.ts, core.ts
- **Acceptance:** A unit test calls `onBookingResult(b, "VOIDED")` on a BOOKED voyage: nothing changes and nothing is emitted.

### L4-007 — `retry()` commits DRY_RUN before it checks that the Two Charts still resolve
- **Severity:** Low
- **Location:** `trips/sealing.ts:121–127`; `trips/persistence.ts:234` (`checkCharts` only repairs DRY_RUN, not VOIDED).
- **Evidence:** A VOIDED voyage restored from an older doc (no `shortlistPlans`) after a dataset change can't resolve its charts. `retry` transitions to DRY_RUN and saves, then `emitShortlist` throws `the two charts don't resolve`. The organizer gets `INTERNAL`, and the voyage sits in DRY_RUN where `pick` answers "That chart is no longer on the table." until the next restart. `startTable` wraps the same call in try/catch; `retry` doesn't. (Found by reading the code. The trigger needs a legacy doc plus a dataset change.)
- **Fix:** Before the transition, `if (h.table.shortlist(t).length !== 2)` → transition to BRIEFING with `REASON_CHARTS_CHANGED` (VOIDED→BRIEFING is legal) and throw a clear `BAD_PHASE`. Also extend `checkCharts` to VOIDED.
- **Effort:** XS
- **Scope:** sealing.ts, persistence.ts
- **Acceptance:** A VOIDED voyage whose charts don't resolve answers retry with a clear error and ends up in BRIEFING, not DRY_RUN.

### L4-008 — Every voided attempt writes a memory note to every member, pushing real history out of the last-5 recall
- **Severity:** Low
- **Location:** `trips/sealing.ts:140,148–153`; `memory/memory.ts:161` (`slice(-5)`)
- **Evidence:** The 3-attempt walk in §3.2 writes 2 "not booked (nobody was charged)" notes and 1 booked note per member for a single voyage. Call-offs, deadline voids and restart voids count too. After a few retries, Maya's "conceded the city choice" line (the one the Advocate's `memoryNote` template matches with `/gave up|conceded/`) drops out of `recall`.
- **Fix:** Write at most one voided note per voyage (skip if `t.attempt > 1` or if a note for this `t._id` already exists), and write none on a restart void. Or write the voided note only when the voyage is left VOIDED at eviction.
- **Effort:** S
- **Scope:** sealing.ts
- **Acceptance:** A voyage with 2 voids and 1 capture leaves exactly one note per member (the booked one), or one voided plus one booked.

### L4-009 — An interrupted table (restart or engine failure) uses up one of the voyage's 6 table runs
- **Severity:** Low
- **Location:** `trips/table.ts:131` (the counter goes up before the engine runs); `resetTable` :110–115 doesn't give it back.
- **Evidence:** `restart.probe.test.ts`: `tableRuns` is 1 after a mid-table restart and 2 after the re-run. Deploys and crashes that the crew can't see use up their meeting budget (`TOO_MANY_RUNS` 429).
- **Fix:** In `resetTable` with `REASON_TABLE_RESTART`, decrement `tableRuns` (or keep a separate `tableRunsCompleted` for the cap). Engine failures can keep counting, since they cost spend.
- **Effort:** XS
- **Scope:** table.ts
- **Acceptance:** After a restart mid-table, `tableRuns` is unchanged.

### L4-010 — `sweep` evicts a voyage but leaves its bookings in `payments.bookings`
- **Severity:** Low (memory growth)
- **Location:** `trips/core.ts:253–263` (`evictTrip`)
- **Evidence:** `evictTrip` drops members, briefs, standing instructions and caches, but not `payments.bookings` entries whose `tripId` matches. On a long-running server every settled attempt stays in the map forever. `hydrate` then reuses the stale in-memory copy (`loadVoyages` skips known ids), which is consistent but never freed.
- **Fix:** In `evictTrip`, delete `payments.bookings` entries for the voyage that are final and not `needsAttention`.
- **Effort:** XS
- **Scope:** core.ts
- **Acceptance:** After `sweep()` evicts a BOOKED voyage, `payments.bookings` has no entries with its `tripId`.

---

## 5. Summary

- **Call graph:** 66 edges traced. **54 ✅, 10 ⚠️, 2 ❌.** Units are consistent throughout: cents for money, ms for timers, epoch ms for expiries, `"captain"` or a band string for voice keys. Every async domain call is awaited or `void …catch`-ed, and no unhandled rejection appeared in any run.
- **State machine:** 12 edges, all of them going through `transition()`. The one real guard gap is L4-001 (the refund gate on VOIDED→BRIEFING→…→pick).
- **Expo:** every figure checks out: Lisbon $2,869 (shares $1,038 / $868 / $963), Mexico City $1,975, the 9-turn / 8-voiced script, `AA-LIS-…` BOOKED, and no private data in the room. The lift, decline and retry paths book on the third attempt with 0 holds left.
- **Findings:** **10 in total: 1 High, 1 Medium, 8 Low.**
  1. **L4-001 (High):** the SEC-016 refund gate is bypassed through new terms → a new table → pick.
  2. **L4-003 (Medium):** "sail without them" racing an absent member's brief leaves a removed seat sealed, with a live standing instruction.
  3. **L4-004 / L4-006 (Low):** a call-off during voiding reports `CAPTURING`, and `onBookingResult` has no `from`, so the restore-only edges are reachable live.
