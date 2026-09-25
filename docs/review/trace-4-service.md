# Traceability Layer 4: TripService ⇄ domain modules

Repo: `/Users/tejas/Downloads/untitled folder 3` @ befc070. This was a read-only review. `npx vitest run` passed (73/73, 8 files) and `npx tsc --noEmit` was clean.
Paths are relative to `apps/server/src/` unless they say otherwise. `svc` means `trips/service.ts`.

**How this was checked:** I read every caller and callee listed below. I also ran two throwaway tsx scripts with `PACE_SCALE=0` and SIM latency set to 5–10 ms, then deleted them. `data/memory.json` was backed up before the runs and restored byte-for-byte afterwards.
1. **Expo scenario:** `seedExpo` → `startTable` → engine → DRY_RUN → votes → `pick(LIS)` → seals → BOOKED. The hop log is in §3.
2. **Edge cases:** a removed member keeps acting, and the crew has no common date window.

Legend: ✅ means the arguments, units and return value match and are consumed correctly. ⚠ means it works but deviates from the spec or has a gap. ❌ means a defect, linked to an issue ID.

---

## 1. Call graph

### 1a. TripService → domain modules

| # | Caller (file:line) | Callee (file:line) | Args passed (names, types, units) | Callee signature | Match? | Return / side effects used by caller | Correctly consumed? | Error handling | Issues |
|---|---|---|---|---|---|---|---|---|---|
| 1 | svc:56 field init | data/loader.ts:8 `loadDataset` | none | `(): Dataset` (cached; W2 flights = W1 ×1.08, +1 day) | ✅ | `this.ds` used everywhere | ✅ | sync; a bad JSON throws at boot (fail fast) | – |
| 2 | svc:69 | payments/visaVic.ts:14 `createVisaProvider` | none (reads env) | `(): PaymentProvider \| null` | ✅ | `?? new SimProvider()` fallback | ✅ | always returns null today (not wired) | – |
| 3 | svc:69 | payments/sim.ts:12 `new SimProvider()` | none | class, `mode="sim"` | ✅ | provider handed to orchestrator | ✅ | – | – |
| 4 | svc:70 | payments/orchestrator.ts:36 `new PaymentsOrchestrator(provider, events)` | provider; events `{sealStatus, declinedPrivate, result, persist}` | `(provider: PaymentProvider, events: PaymentEvents)` | ✅ | `this.payments` | ✅ | – | – |
| 5 | svc:71 (inside sealStatus cb) | orchestrator.ts:232 `publicSealStatus` | `status: SealStatus` | `(s) => DECLINED→VOIDED` | ✅ | masks the decliner in the trip room (doc 06 §7) | ✅ | pure | – |
| 6 | svc:97 `log` | store/db.ts:48 `append("events", …)` | `{tripId,event,audience,summary,at:Date}` | `(col:"events", doc)` | ✅ | fire-and-forget audit | ✅ | db errors swallowed | – |
| 7 | svc:126 `save` | store/db.ts:40 `persist("trips", t)` | TripRec | `(col, doc{_id})` | ✅ | write-through, `version++` | ✅ | swallowed (logged) | TR4-002 (version is never checked) |
| 8 | svc:102/109/110/111 `restore` | store/db.ts:54 `loadAll` | collection name | `<T>(col): Promise<T[]>` | ✅ | rebuilds maps | ✅ | awaited; a throw aborts boot | – |
| 9 | svc:116 `restore` | orchestrator.ts:43 `createStanding(m._id, brief.capCents)` | memberId (id), **capCents (cents)** | `(memberId: string, capCents: number)` | ✅ units | new instruction with a **fresh 24 h** expiry | ⚠ | awaited; a throw aborts boot | **TR4-004** |
| 10 | svc:120 `restore` | orchestrator.ts:81 `abandon(b)` | BookingRec | `(b, publicReason?)` | ✅ | voids holds → `events.result(VOIDED)` → trip VOIDED | ⚠ a booking already final returns early and the trip stays SEALING | awaited | **TR4-003** |
| 11 | svc:122 `restore` | svc:428 `armAutoPick(t, planId, ms)` | planId (plan `_id`), **ms remaining** `max(0, at-now)` | `(t, planId, ms=AUTOPICK_MS)` | ✅ ms | re-arms the D5 timer | ✅ | – | – |
| 12 | svc:148/154/233/252 | util/ids.ts:10 `sameHash(plain, hashed)` | plaintext token/code, stored sha256 hex | `(plain, hashed?) => boolean` | ✅ | auth decision | ✅ | a missing hash gives false | – |
| 13 | svc:176/180/206/207/225/245/254/255 | util/ids.ts:5–8 `newJoinCode/newId/newToken/hash` | – | nanoid / 32-byte base64url / sha256 hex | ✅ | ids and tokens; only hashes stored (doc 04 §12) | ✅ | – | – |
| 14 | svc:222/243/281/312/446/467/514 | svc:157 `requireOrganizer(tripId, actor)` | `Actor {memberId?, token?, deviceToken?}` | checks organizer role + trip, or `deviceOk` | ✅ | throws 403 `NOT_ORGANIZER` | ✅ | sync throw → io `guard` / express `h` | – |
| 15 | svc:265 `submitBrief` | svc:609 `validateBrief(input, ds)` | BriefInput: `capCents` (cents, 30 000–300 000), window ids, tags, dealbreakers, `note?`, `noteSource?` | `(BriefInput, Dataset) => BriefInput` | ✅ | note is cleaned to ≤200 chars and becomes `undefined` when empty; `noteSource` defaults to `"typed"` | ✅ optional fields | throws `BAD_INPUT` | TR4-006 (note is never used downstream) |
| 16 | svc:268/270 | db.ts:40 `persist("briefs"/"members")` | BriefRec (`_id = memberId`), MemberRec | – | ✅ | – | ✅ | swallowed | – |
| 17 | svc:271 `submitBrief` (absent) | orchestrator.ts:43 `createStanding(memberId, b.capCents)` | memberId, **capCents** | same as #9 | ✅ limit = cap (doc 06 §3) | standing instruction for the absent member | ✅ | awaited; throws **after** the brief is persisted and before the trip save/broadcast | **TR4-017** |
| 18 | svc:274 → svc:289 `memoryFor` | memory/memory.ts:21 `personKey(m.name, m.origin)` + :56 `recall(key)` | `"name\|ORIGIN"` | `(key) => Promise<string[]>` (last 5) | ✅ key consistent with #45 and with seed | `brief:private.memory` (owner only) | ✅ | recall catches Backboard errors and falls back to local | **TR4-007**, TR4-008 |
| 19 | svc:298 `chartBook` | fit/pricing.ts:221 `buildChartBook(ds, crew, cityIds, 50)` | PricingMember[] `{memberId,name,role,origin,brief}`, CityId[], **limit 50** | `(ds, crew, cityIds, limit=12) => Plan[]` | ⚠ doc 05 §2.6 says top 12 | cached per trip; the engine gets `.slice(0,12)` | ✅ | pure | TR4-012 |
| 20 | pricing.ts:229 (2nd order) | pricing.ts:72 `buildPlan` → dryrun/walking.ts:18 `travel(ds, from, to)` | Points `{id,lat,lng}` (hotel id / activity id) | `=> TravelLeg{minutes (min), mode, flagged}` | ✅ min; flagged = walk > 25 min | `long_walk` flags; `it.travel[memberId]` | ✅ (the Expo MEX/LIS numbers match doc 07 §9) | pure | – |
| 21 | pricing.ts:190/208 (2nd order) | fit/fairness.ts:6/20 `satisfaction`, `fairness` | `capCents`, `shareCents` (both cents; headroom ratio), flagCount, rating | doc 05 §5 formula | ✅ | `(maximin,sum)` sort via `compareFairness` :25 | ✅ | pure | – |
| 22 | svc:300 `chartBook` | negotiation/engine.ts:229 `buildPrivacyContext(ds, crew, book)` | crew briefs (`capCents` in **cents**), plans (`amountCents` in **cents**) | returns `{sensitiveDollars, allowedDollars, names}` in **dollars** (÷100) | ✅ units: caps/shares/headroom ÷100; listing prices ÷100; group totals rounded ÷100 | `this.privacy` used by `hail` | ⚠ built over the full book while the engine builds its own over 12 | pure | TR4-012 |
| 23 | svc:306 `datesLabel` | ds.dateWindows | crew dateWindowIds | – | ⚠ falls back to W1 when there is no common window | Captain OPEN text + memory text | ❌ | – | **TR4-005** |
| 24 | svc:323 `startTable` | svc:295 `chartBook(t).slice(0,12)` | – | – | ✅ | plans for the engine | ✅ | – | – |
| 25 | svc:328 `startTable` | memory.ts:56 `recall` ×crew (via `memoryFor`) | personKey | as #18 | ✅ | `memories` map → `EngineIO.memory` | ✅ | `Promise.all`; recall never rejects | – |
| 26 | svc:329 `startTable` | engine.ts:50 `new NegotiationEngine(ds, crew+band, plans, cityIds, datesLabel, io)` | `EngineCrew = PricingMember & {band: 1..4}`, `Plan[]`(12), `CityId[]`, string, EngineIO | matches ctor | ✅ | – | ✅ | – | – |
| 27 | svc:353 `startTable` | engine.ts:68 `run()` | – | `Promise<EngineResult{shortlist:[Plan,Plan], advocatedBy:Record<planId,memberId[]>, endedReason}>` | ✅ | `shortlistIds=[r.shortlist[0]._id, r.shortlist[1]._id]`, `advocatedBy`, `endedReason` stored; status DRY_RUN | ✅ shape consumed correctly (Expo: `consensus`, `[MEX-W1-roma-flat, LIS-W1-casa-alfama]`) | `void` + `.then/.catch`; catch resets to BRIEFING with **no status guard** | **TR4-002** |
| 28 | svc:340 (voice cb) | voice/voice.ts:27 `synthesize(turnId, text, key)` | turnId (nanoid), filtered line, voiceKey `"captain"\|"1".."4"` (band as string) | `=> Promise<number(ms) \| null>` | ✅ keys match `config.eleven.voices` and `SETTINGS` | null → return null (engine uses its estimate); ms → sets `turn.audioUrl`, emits `turn:audioReady{durationMs}`, returns ms | ✅ ms end to end | synthesize catches internally → null | TR4-015 (audioUrl not saved; replay drops durationMs) |
| 29 | svc:381/558/578 | pricing.ts:237 `toPublic(ds, plan, "A"\|"B")` | Plan, label | `=> PlanPublic` (no member views) | ✅ `hotelId` → ds.hotels lookup | `table:decided`, `trip:state.shortlist` | ✅ privacy (no `members`) | pure; `!` on the hotel lookup | – |
| 30 | svc:383/587 | pricing.ts:248 `toPrivate(plan, memberId)` | Plan, memberId | `=> PlanPrivate \| null` | ✅ | sent **only** via `toMember`/member emit | ✅ | null is skipped | – |
| 31 | svc:386/579 | svc:460 `dryrunScript` | planIds, fresh | returns `{planIds, dayStartMin, dayEndMin (min), minPerSec, startedAt/pausedAt/serverNow (ms epoch)}` | ✅ units (minutes of day, ms epoch); shape = shared `DryRunScript` | – | ✅ | – | ⚠ doc 04 §7.2 describes a segments payload (doc drift, shared type is the contract) |
| 32 | svc:396 `hail` | privacy/filter.ts:75 `filterLine(clean(text,160), this.privacy.get(tripId)!)` | text ≤160, PrivacyContext (dollars) | `=> {text, leak, invalidPrice, rewrites, reasons}` | ✅ | uses `f.leak` (replace all) and `f.text` (name rewrites applied); `redactions = leak?1:0` | ⚠ `invalidPrice` ignored; `rewrites` not counted | privacy ctx always present in AT_TABLE (built at #24) | TR4-011 |
| 33 | svc:419/421 `vote` | svc:603 `tallies`, `activeMembers` | planId (plan `_id`) | – | ⚠ tallies count votes from removed members | majority > crew/2 → `armAutoPick` | ❌ | – | **TR4-001** |
| 34 | svc:431–434 timer | svc:466 `pick(t._id, {memberId: t.organizerId}, planId)` | Actor with organizer memberId; planId | `(tripId, actor, planId)` | ✅ passes `requireOrganizer` | – | ✅ guards: DRY_RUN and `autoPick.planId===planId` | `.catch` → warn | – |
| 35 | svc:470 `pick` | svc:295 `chartBook(t).find(p._id===planId)!` | planId validated in `shortlistIds` | – | ✅ | the chosen Plan | ✅ | – | – |
| 36 | svc:474 `pick` | orchestrator.ts:52 `create({tripId, planId, cityId, attempt, shares})` | `shares = plan.members.map({memberId, amountCents: m.amountCents (cents, from chosen plan), capCents: briefs.get(memberId).capCents (cents)})` | `create(p:{…shares:{memberId,amountCents,capCents}[]}) => BookingRec` | ✅ shares from the **chosen plan**; caps from briefs; Σ = groupCents (Expo: 103 800 + 86 800 + 96 300 = 286 900 = $2,869 ✅ doc 07 §9.1) | `t.bookingId = booking._id`; status SEALING | ✅ | sync; standing seals start **inside** create (`void startSeal`) | TR4-009 |
| 37 | svc:481/562/583 | orchestrator.ts:88 `toPublic(b)` | BookingRec | `=> BookingPublic` (no seal amounts) | ✅ | `booking:created`, `trip:state.booking` | ✅ privacy | pure | TR4-013 |
| 38 | svc:482 → svc:486 `sendSealPrivate` → orchestrator.ts:40 `cardLast4(memberId)` | memberId | `=> Promise<string>` | ✅ | `seal:private{bookingId, amountCents, lines, fits, cardLast4, mode}` to the member room | ✅ | awaited in a loop; a reject aborts the remaining members' `seal:private` and the error reaches the organizer after SEALING | TR4-016 |
| 39 | svc:501 `setSeal` | passkeys/passkeys.ts:30 `hasPasskey(memberId)` | memberId (no rpID) | `(memberId, rpID?) => boolean` | ⚠ any-rpID match | gate | ✅ logic | in-memory credential store | TR4-014 |
| 40 | svc:501 `setSeal` | passkeys.ts:86 `consumeAssertion(memberId, assertionToken)` | memberId, single-use token | `=> boolean` (checks owner and 2-min expiry, deletes the token) | ✅ | 403 `PASSKEY_REQUIRED` on false | ✅ | – | – |
| 41 | svc:504 `setSeal` | orchestrator.ts:96 `setSeal(bookingId, memberId, assertionToken)` | bookingId (validated = `t.bookingId`), memberId, **already-consumed** token | `(bookingId, memberId, passkeyAssertion?)` | ⚠ | instruction limit = `min(capCents, ceil(amountCents×1.02))` (cents, doc 06 §3 ✅), 30 min expiry | ✅ | awaited; silent no-op when the seal isn't PENDING | TR4-014 |
| 42 | svc:510 `cancelSeal` | orchestrator.ts:109 `cancelSeal(bookingId, memberId)` | ids | sync | ✅ | decline `user_cancelled` → `voidAll` → `result(VOIDED)` | ✅ | voidAll errors caught | – |
| 43 | svc:521 `retry` | svc:379 `emitShortlist` | – | – | ✅ | re-sends `table:decided`, `plan:private`, fresh `dryrun:script` | ✅ | – | TR4-013 |
| 44 | svc:538/542 `writeMemories` | loader.ts:32 `cityName` | cityId | `=> string` | ✅ | memory text | ✅ | – | – |
| 45 | svc:544 `writeMemories` | memory.ts:72 `remember(personKey(m.name,m.origin), text)` + :86 `budgetBand(capCents)` | key consistent with #18; cap → band only (no raw number ✅ doc 05 §9) | `(key, text) => Promise<void>` | ✅ | local file + Backboard | ⚠ dates from `datesLabel` not `plan.dateWindowId`; nothing written on VOIDED | awaited in a loop; `void …catch` at svc:532 | TR4-005, TR4-018 |
| 46 | svc:549–564 `state` | `payments.mode`, `toPublic`, `crewPublic` | – | `TripState` | ✅ shape = shared `TripState` | `trip:state` | ⚠ includes a stale booking after retry | – | TR4-013 |
| 47 | svc:570–595 `replay` | `memoryFor`, `toPrivate`, `cardLast4`, `bookings.get` | memberId | – | ✅ private replays only when `memberId` is set; headset/gallery get none | – | ✅ | awaited in `trip:join` guard | TR4-015 |

### 1b. Callbacks and events coming back into TripService

| # | Caller (file:line) | Callee (file:line) | Args passed | Callee signature | Match? | Return / side effects | Correctly consumed? | Error handling | Issues |
|---|---|---|---|---|---|---|---|---|---|
| 48 | engine.ts:139 `say` | svc:332 `EngineIO.emitTurn(e, watch)` | `EmittedTurn{speaker, act, planId?, cityId?, text(filtered), ribbon, voiced:true, redactions}`, watch 0..3 | `(t, watch) => Promise<string>` | ✅ | Turn = e + `{turnId, tripId, seq:++seq (shared with hails), watch, createdAt}`; save; `turn:new` to the trip | ✅ turnId returned and used for voice | awaited; a throw rejects run → catch (#27) | – |
| 49 | engine.ts:144 `say` | svc:339 `EngineIO.voice(turnId, line, voiceKey)` | turnId, filtered line, `"captain"` or `String(band)` | `=> Promise<number \| null>` (ms) | ✅ | engine wait = `(max(2500, (ms ?? estimate)+400) − elapsed) × paceScale` (ms) | ✅ null → word-count estimate | awaited | – |
| 50 | engine.ts:79 | svc:347 `onWatch(watch)` | 1..3 | `(watch) => void` | ✅ | `t.negotiation.watch`, `table:watch` | ✅ (persisted on the next save) | sync | – |
| 51 | engine.ts:109 `collectHails` | svc:348 `takeHails()` | – | `=> {memberId, text}[]` | ✅ | drains `pendingHails`; engine → rules.ts:54 `parseHail(memberId, name, text)` | ✅ | – | TR4-011 (drops >2; hails after Watch 3 are discarded) |
| 52 | engine.ts:77/82 | svc:349 `cancelled()` | – | `=> boolean` (`status !== AT_TABLE`) | ✅ | loop break | ✅ (nothing moves AT_TABLE except the engine result, so this is effectively a guard) | – | – |
| 53 | engine.ts:122/177 | svc:350 `memory(id)` | memberId | `=> string[]` | ✅ | template `/gave up\|conceded/` → memoryNote; Gemini facts | ✅ | – | TR4-007/008 |
| 54 | engine.ts:153–155 `phrase` (2nd order) | filter.ts:75 `filterLine(line/ribbon, this.privacy)` | engine-local privacy (12 plans) | as #32 | ✅ | `f.leak \|\| f.invalidPrice \|\| r.leak` → reject; else `clampWords(f.text)` | ⚠ ribbon `invalidPrice` ignored; `rewrites` not counted in `redactions`; last-resort text is act-agnostic | – | TR4-010 |
| 55 | engine.ts:89 / :98 (2nd order) | phrasing.ts / rules.ts / gemini.ts | Decision, plans, hail | – | ✅ | Advocate facts omit cap ✅ privacy, but also omit `brief.note` | ⚠ | gemini has a 6 s timeout → null → template | TR4-006 |
| 56 | orchestrator.ts:215 `setSealStatus` | svc:71 `events.sealStatus(b, memberId, status)` | BookingRec, memberId, SealStatus | – | ✅ | `toTrip("seal:status", {bookingId, memberId, status: publicSealStatus})` (no amounts ✅ doc 06 §5.3.6) | ✅ | sync | TR4-009 (first emit precedes `booking:created`) |
| 57 | orchestrator.ts:161 `decline` | svc:72 `events.declinedPrivate(b, memberId, reason)` | reason ∈ DeclineReason | – | ✅ | `toMember(…, "seal:declinedPrivate")` owner only ✅ | ✅ | sync | – |
| 58 | orchestrator.ts:186/199/209 | svc:73 → svc:525 `onBookingResult(b, "CAPTURED"\|"VOIDED", publicReason?)` | – | – | ✅ | guard `t.bookingId === b._id`; status BOOKED/VOIDED; `booking:result{bookingId,status,reference,publicReason}`; memory write on CAPTURED | ✅ (no trip-status guard, but the bookingId guard is sufficient in practice) | sync; the memory write is `void`+catch | TR4-002 |
| 59 | orchestrator.ts:65/216/222/160 | svc:74 `events.persist(b)` → db.ts:40 | BookingRec | – | ✅ | write-through | ✅ | swallowed | – |
| 60 | svc:84 `toTrip` | realtime/io.ts:18 `bus.trip` | tripId, event, payload | `io.to("trip:"+id).emit` | ✅ | – | ✅ PRIVATE_EVENTS guard throws before emit (svc:82) | – | – |
| 61 | svc:88 `toMember` | io.ts:19 `bus.member` | memberId, event, payload | `io.to("member:"+id).emit` | ✅ | – | ✅ | – | – |

### 1c. io.ts / routes.ts / seed.ts → TripService (entry points and Actor objects)

| # | Caller (file:line) | Callee (file:line) | Args passed (Actor / ids) | Match? | Consumed / notes | Error handling | Issues |
|---|---|---|---|---|---|---|---|
| 62 | io.ts:17 | svc:78 `attachBus` | `{trip, member}` | ✅ | – | – | – |
| 63 | io.ts:45/48/52/56 `trip:join` | svc:129/134/139/152/570 | tripId or joinCode; memberToken → `memberByToken` (excludes removed); deviceToken → `deviceOk` | ✅ | sets `data.memberId` / `data.deviceToken` **once**, at join | `guard` → `error{code,message}` | TR4-001 (never re-validated) |
| 64 | io.ts:59 `brief:submit` | svc:261 `submitBrief(tripId(), memberId(), p)` | socket memberId | ⚠ no active-member check in svc | – | guard | **TR4-001** |
| 65 | io.ts:60 `table:start` | svc:311 `startTable(tripId, actor())` | Actor `{memberId, deviceToken}` | ✅ organizer phone or headset | – | guard (the engine runs detached) | – |
| 66 | io.ts:61 `table:sailWithout` | svc:279 `sailWithout(tripId, actor(), ids)` | Actor; svc rejects the headset (no memberId/token) ✅ doc 04 §7.1 | ✅ | – | guard | TR4-020 |
| 67 | io.ts:62–67 `table:hail` | svc:389 `hail(id, who, text)` | who = socket memberId, or `organizerId` for a valid device | ✅ | – | guard | TR4-001 |
| 68 | io.ts:71 `dryrun:control` | svc:445 `dryrunControl(tripId, actor(), action)` | Actor; action ∈ pause/resume/restart | ✅ | no phase guard | guard | TR4-019 |
| 69 | io.ts:73 `plan:vote` | svc:414 `vote(tripId, memberId(), String(planId))` | socket memberId, planId | ⚠ | ghost votes | guard | **TR4-001** |
| 70 | io.ts:74 `plan:pick` | svc:466 `pick(tripId, actor(), String(planId))` | Actor | ✅ | – | guard (awaited) | – |
| 71 | io.ts:75 `seal:set` | svc:497 `setSeal(tripId, memberId(), String(bookingId), assertionToken?)` | ids + optional token | ✅ | – | guard | – |
| 72 | io.ts:76 `seal:cancel` | svc:507 `cancelSeal(…)` | ids | ✅ | – | guard | – |
| 73 | io.ts:77 `booking:retry` | svc:513 `retry(tripId, actor())` | Actor | ✅ | – | guard | – |
| 74 | routes.ts:43 `POST /trips` | svc:169 `createTrip({name, organizerName, band:Number, origin, cityIds?})` | – | ✅ | returns `{trip, member, token}` → `{tripId, joinCode, memberId, memberToken}` | `h` → JSON error | – |
| 75 | routes.ts:51 / :58 | svc:134 `tripByCode`+`crewPublic`; svc:217 `join` | – | ✅ | `takenBands` derived from the public crew | `h` | – |
| 76 | routes.ts:64 `POST /absent` | svc:221 `addAbsent(tripId, {token: bearer}, …)` | Actor `{token}` | ✅ | `{memberId, inviteKey, invitePath}` | `h` | – |
| 77 | routes.ts:68 / :72 / :77 | svc:231 `claimAbsent`; svc:242 `headsetCode(tripId, {token})`; svc:251 `pairHeadset(code)` | Actor `{token}` (the headset can't mint codes ✅) | ✅ | – | `h`; pair is rate limited | – |
| 78 | routes.ts:82/93 | svc:139 `memberByToken(tripId, bearer)` | token | ✅ | STT and passkey endpoints | `h` | – |
| 79 | routes.ts:135 `POST /demo/seed` | demo/seed.ts:8 `seedExpo(helm)` | dev-key gated | ✅ | – | `h` | – |
| 80 | seed.ts:9–12 | svc:169/217/221/231 | `addAbsent(tripId, {memberId: rae._id}, …)` Actor by id ✅ | ✅ | Dev claimed immediately | throws propagate | – |
| 81 | seed.ts:14–16 | memory.ts:21/56/72 `personKey("Maya","ORD")`, `recall`, `remember` | key = `"maya\|ORD"`, the same as svc `memoryFor` | ✅ | seeded "conceded" line → Maya's PROPOSE "My friend gave up the city pick last time." ✅ (observed) | awaited | TR4-008 |
| 82 | seed.ts:19–21 | svc:261 `submitBrief` ×3 | caps 110 000 / 90 000 / 140 000 **cents** ✅ doc 05 §12 ($1,100 / $900 / $1,400); Dev absent → `createStanding(dev, 140000)` ✅ | ✅ | observed: `standing [Dev, 140000]` | awaited | – |
| 83 | seed.ts:23 | svc:242 `headsetCode(tripId, {memberId: rae._id})` | Actor by id | ✅ | – | – | – |

**Hop total: 83. Fully clean ✅ rows (no linked issue): 48. Rows linked to an issue (⚠/❌, or ✅ args with a side-effect gap): 35.**

---

## 2. Trip state-transition table (every `t.status =` assignment vs docs/04 §5)

| # | Location | From → To | Trigger | In docs/04 §5? | Guard in code | Verdict |
|---|---|---|---|---|---|---|
| S1 | svc:180 | (DRAFT) → BRIEFING | `createTrip` | ✅ `DRAFT ──create──► BRIEFING` (DRAFT is never persisted) | – | ✅ |
| S2 | svc:318 | BRIEFING → AT_TABLE | `startTable` (organizer, ≥2 active, all sealed) | ✅ | status + sealed + organizer | ✅ (no `version` check) |
| S3 | svc:359 | AT_TABLE → DRY_RUN | engine `run()` resolved | ✅ | `status === AT_TABLE` | ✅ |
| S4 | svc:366 | AT_TABLE (**or DRY_RUN**) → BRIEFING | engine rejected, **or the `.then` handler threw after S3** | ❌ undocumented | **none** | **TR4-002** |
| S5 | svc:479 | DRY_RUN → SEALING | `pick` (organizer / headset / auto-pick timer) | ✅ | status + planId ∈ shortlist | ✅ |
| S6 | svc:528 | SEALING → BOOKED | `result(CAPTURED)` | ✅ | `t.bookingId === b._id` (no status check) | ✅ |
| S7 | svc:528 | SEALING → VOIDED | `result(VOIDED)` (decline / cancel / timeout / capture fail / abandon) | ✅ | same as S6 | ✅ |
| S8 | svc:517 | VOIDED → DRY_RUN | `retry` ("back to the charts", same shortlist) | ✅ | status VOIDED + organizer | ✅ |
| S9 | svc:272 | VOIDED → BRIEFING | any **member** `submitBrief` | ✅ ("member edits brief") | status BRIEFING\|VOIDED; **no active-member check** | ⚠ TR4-001 |
| S10 | svc:106 | AT_TABLE → BRIEFING | `restore()` after a restart | ❌ undocumented (recovery) | – | TR4-002 |
| S11 | svc:121 | SEALING → VOIDED | `restore()`, no booking record | ❌ undocumented (recovery, no `booking:result`) | – | TR4-002 |
| S12 | svc:120 → S7 | SEALING → VOIDED | `restore()` → `abandon` → `voidAll` → result | ✅ via S7 | booking not final | ⚠ a booking that is already final leaves the trip **stuck in SEALING** (TR4-003) |

Other gaps against the docs:
- Doc 04 §5 says "every transition checks `version` (optimistic lock)". `version` is incremented but never compared anywhere.
- `trips/stateMachine.ts` (named in the doc) does not exist. Transitions are inline.
- There is no BOOKED → anything transition. That is correct, and `submitBrief`, `pick` and `retry` all reject BOOKED.

---

## 3. Expo scenario, hop by hop (observed run)

1. **Setup.**
   - `seedExpo` → `createTrip(Rae, ATL)` → `addMember` → `member:joined` and `trip:state v1`.
   - `join(Maya)` and `addAbsent({memberId: rae})`, then `claimAbsent(Dev)`.
   - Memory seed: `recall("maya|ORD")`, which already contains "conceded".
2. **Briefs.** `submitBrief` ×3. Each one sends `brief:private` to the owner only and `brief:received` plus `trip:state` to the trip. Dev's brief also calls `createStanding(Dev, 140000¢)`.
3. **Table start.** `startTable({memberId: Rae})` sets AT_TABLE (v9) and calls `chartBook`, which builds 11 plans and the privacy context.
   - Privacy context contents: sensitive $ includes 1100, 900, 1400 (caps) and 1038, 868, 963, 708, 598, 669 (shares). Allowed $ includes group totals 1975 and 2869.
4. **Meeting turns** (`turn:new`, redactions 0):
   - Captain OPEN (w0).
   - Watch 1:
     - Maya PROPOSE LIS (with the memory note).
     - Dev PROPOSE MEX.
     - Rae PROPOSE MEX (seconding).
   - Watch 2:
     - Maya OBJECT MEX ("no beach").
     - Dev SUPPORT LIS.
     - Rae CONCEDE LIS.
   - Early exit with `consensus`, then Captain DECIDE.
   - That makes 8 voiced turns, which matches doc 05 §12.
5. **Engine result.** `shortlist = [MEX-W1-roma-flat (A, $1,975), LIS-W1-casa-alfama (B, $2,869)]`, `advocatedBy` stored, DRY_RUN.
   - The trip gets `table:decided` (public).
   - Each member gets two `plan:private` messages (Rae 708/1038, Maya 598/868, Dev 669/963 dollars, all fits ✓, matching doc 07 §9).
   - The trip gets `dryrun:script` and `trip:state v18`.
6. **Votes.** `vote(Maya, LIS)` gives tally 1 with no auto-pick. `vote(Rae, LIS)` gives 2 of 3, which is a majority, so `autoPick{LIS, +20 000 ms}` is armed.
7. **Pick.** `pick(Rae, LIS)` cancels the auto-pick, sets attempt 1, and calls `payments.create`.
   - Shares: Rae 103 800 / cap 110 000, Maya 86 800 / 90 000, Dev 96 300 / 140 000 (standing).
   - Dev's standing seal starts immediately, so `seal:status AUTHORIZING` is emitted **before** `booking:created` (TR4-009).
   - Then `booking:created`, three `seal:private` messages (member rooms), and `trip:state SEALING`.
8. **Seals.**
   - Dev's standing seal goes AUTHORIZED.
   - `setSeal(Rae)`: no passkey, so the tap path; instruction limit = min(110 000, 105 876) = 105 876¢; AUTHORIZING → AUTHORIZED.
   - `setSeal(Maya)`: limit = min(90 000, 88 536) = 88 536¢; AUTHORIZED.
   - `maybeCapture` captures all three → CAPTURED ×3 → `result(CAPTURED)`.
   - `onBookingResult` sets BOOKED, emits `booking:result{AA-LIS-xxxx}` and `trip:state`, and calls `writeMemories` → `remember("rae|ATL"/"maya|ORD"/"dev|JFK", "… mid budget / comfortable budget …")`.

Privacy: no `trip:` emit carried `capCents`, per-member `amountCents`, `fits`, `mustHaves` or `dealbreakers`. Seal status went to the trip room without amounts.

Edge run (confirmed):
- A removed member (Bob) could still call `submitBrief`, and `briefSealed` became true.
- Bob's "ghost" vote plus one real vote armed auto-pick in a 2-person crew, where 1 real vote alone would not.
- With no common window (W1 vs W2), the Captain OPEN said "Mar 12 to 16 works for everyone." while the shortlist mixed `MEX-W1-condesa` and `LIS-W2-baixa-triple`.

---

## 4. Issues

### TR4-001: Removed ("sail without them") members keep acting through a socket still connected from before removal: ghost votes, brief resubmits, hails
- Severity: Medium
- Link: io.ts:42/59/62/73/75 (the `memberId()` captured at join) → svc:261 `submitBrief`, svc:389 `hail`, svc:414 `vote`, svc:497 `setSeal`
- Expected vs actual:
  - **Expected:** svc:144 says members removed via sail-without "lose their seat: no votes, hails or private replays". That is enforced only in `memberByToken` at `trip:join`.
  - **Actual:** a socket that joined before `sailWithout` keeps `data.memberId`, and the service methods take `memberId` on trust.
  - Verified: the removed member's `submitBrief` succeeds (and in VOIDED it would flip the whole trip VOIDED→BRIEFING, S9). Their `plan:vote` is stored and counted in `tallies`, while `crewSize` excludes them. So a ghost vote can create a "majority" and fire the D5 auto-pick (verified: 1 real + 1 ghost vote armed auto-pick in a 2-person crew).
- Fix:
  - Add an `activeMember(t, memberId)` guard used by `submitBrief`, `hail`, `vote`, `setSeal` and `cancelSeal`. It throws `NOT_MEMBER` when the id is in `removedMemberIds` or not in `memberIds`.
  - In `tallies`, count only active members' votes.
  - Optionally, have `sailWithout` make the removed members' sockets leave `member:{id}` via the bus.
- Effort: S
- Scope: svc (`vote`, `tallies`, `submitBrief`, `hail`, `setSeal`, `cancelSeal`, `sailWithout`); io.ts optional
- Acceptance: a unit test in which `sailWithout([B])` followed by `vote/submitBrief/hail(B)` throws `NOT_MEMBER`; a pre-existing ghost vote doesn't affect `tallies` or `autoPick`.

### TR4-002: Undocumented and unguarded trip transitions; no optimistic `version` check
- Severity: Medium
- Link: svc:363–370 (engine `.catch`), svc:106, svc:121 → docs/04 §5
- Expected vs actual:
  - **Expected:** only the documented transitions happen, each guarded by current status and `version`, with illegal ones giving `BAD_PHASE`.
  - **Actual:**
    - (a) `.catch` also catches exceptions thrown **inside the `.then` handler** after `t.status = "DRY_RUN"` (for example `emitShortlist` → `toPublic` hitting a missing hotel). It then forces DRY_RUN→BRIEFING with no status guard and leaves `shortlistIds` set.
    - (b) AT_TABLE→BRIEFING (engine failure or restore) and SEALING→VOIDED (restore with no booking) are not in the spec, and the latter emits no `booking:result`.
    - (c) `version` is bumped but never compared.
    - (d) `trips/stateMachine.ts` doesn't exist.
- Fix:
  - Use `engine.run().then(onOk, onErr)`, the two-argument form, so handler errors aren't treated as engine failure. Also guard `onErr` with `if (t.status !== "AT_TABLE") return`.
  - Centralise transitions in a `transition(t, from[], to)` helper that asserts legality.
  - Add the recovery edges (AT_TABLE→BRIEFING "table failed/restart", SEALING→VOIDED "restart") to docs/04 §5.
  - Either implement the version check on client mutations or remove the claim from the doc.
- Effort: M
- Scope: svc `startTable`/`restore`/all status writes; docs/04 §5
- Acceptance:
  - A test that makes `emitShortlist` throw keeps the trip in DRY_RUN and logs the error.
  - Every `t.status =` goes through `transition()`.
  - The doc lists every edge.

### TR4-003: Restore leaves the trip stuck in SEALING when its booking already reached CAPTURED/VOIDED
- Severity: Medium
- Link: svc:120 → orchestrator.ts:81–82 (`abandon` returns early when `isFinal`)
- Expected vs actual:
  - **Expected:** after a restart, trip status matches the final booking (CAPTURED→BOOKED, VOIDED→VOIDED).
  - **Actual:** `persist()` is fire-and-forget. A crash between the booking write (`setBooking CAPTURED/VOIDED`) and the trip write in `onBookingResult` reloads trip=SEALING with booking=final. `abandon` no-ops, no `result` event fires, and `setSeal`/`cancelSeal` are no-ops. The voyage is wedged, with no retry (status isn't VOIDED) and no booked screen.
- Fix: in `restore`, `if (t.status === "SEALING" && b && (b.status === "CAPTURED" || b.status === "VOIDED")) this.onBookingResult(b, b.status)`. Otherwise `abandon`.
- Effort: S
- Scope: svc `restore`
- Acceptance: a restore test with trip SEALING and booking CAPTURED ends BOOKED; with booking VOIDED it ends VOIDED.

### TR4-004: Every restart re-issues absent members' standing instructions with a fresh 24 h, for all non-BOOKED trips
- Severity: Medium
- Link: svc:114–117 → orchestrator.ts:43–49
- Expected vs actual:
  - **Expected (doc 06 §3/§9):** the standing instruction expires 24 h after the member seals it, and there are no dangling permissions.
  - **Actual:** `restore()` calls `createStanding` with `expiresAt = now + 24h` for every absent member with a brief, in every trip not BOOKED. That includes long-abandoned BRIEFING/DRY_RUN/VOIDED voyages. Each reboot extends the spending permission indefinitely, and on real VIC it would mint a new instruction on every boot.
- Fix:
  - Store the expiry. `brief.sealedAt` already exists; derive `expiresAt = Date.parse(sealedAt) + 24h`.
  - Pass it into `createStanding(memberId, capCents, expiresAt)` and skip it when it's in the past.
  - Also skip trips older than the window.
- Effort: S
- Scope: svc `restore`, orchestrator `createStanding` signature
- Acceptance: a restore test in which a brief sealed 25 h ago creates no standing instruction and the seal becomes live (`standing:false`); one sealed 1 h ago keeps its original expiry.

### TR4-005: `datesLabel` asserts a common window that may not exist and ignores the chosen plan's window
- Severity: Low
- Link: svc:304–309 → engine OPEN (engine.ts:71) and `writeMemories` (svc:544)
- Expected vs actual:
  - **Expected:** the Captain OPEN states only dates everyone can do (doc 05 §4 "group-level facts"), and memory records the booked plan's dates.
  - **Actual:** with no common window it falls back to `dateWindows[0]`, and the Captain says "Mar 12 to 16 works for everyone." (verified with W1 vs W2, where the shortlist mixed W1 and W2 plans). `writeMemories` records the label rather than `plan.dateWindowId`, so a W2 booking is remembered as "Mar 12 to 16".
- Fix:
  - Return `null` when there's no common window and use a template such as "No dates suit everyone; here are the closest." (as its own OPEN template).
  - In `writeMemories`, format from `ds.dateWindows.find(w => w.id === plan.dateWindowId)`.
- Effort: S
- Scope: svc `datesLabel`, `writeMemories`; phrasing `openLine`
- Acceptance: a disjoint-window crew doesn't hear "works for everyone"; the memory text for a W2 booking says "Mar 13 to 16".

### TR4-006: Brief `note` / `noteSource` are validated and stored but never reach the Advocate
- Severity: Medium
- Link: svc:618 (`validateBrief` keeps `note`) → engine.ts:174–188 (`advocatePrompt` facts include only `mustHaves`/`dealbreakers`)
- Expected vs actual:
  - **Expected (doc 05 §3.1, §7.0):** the Advocate's `sealed_terms` include `note`, which may be voiced only by the member's own Advocate, paraphrased.
  - **Actual:** `brief.note` is referenced nowhere after persistence (grep shows only seed/validate). The Expo notes ("I get tired walking hills", "Want at least one big night out") have no effect, and `noteSource` is stored as `"typed"` even when there is no note.
- Fix:
  - Add `note: c.brief.note` (under `wishes`) to the Advocate facts, with a system-prompt rule to paraphrase it and never quote it.
  - Set `noteSource` only when `note` is present.
  - Rules-mode templates can keep ignoring it.
- Effort: S
- Scope: engine `advocatePrompt`, gemini `ADVOCATE_SYSTEM`, svc `validateBrief`
- Acceptance: a prompt snapshot includes the note for that member only; another member's Advocate prompt never contains it; `noteSource` is undefined when `note` is.

### TR4-007: Memory key `name|origin` collides across unrelated people and voyages
- Severity: Medium
- Link: svc:289 / svc:544 → memory.ts:21 `personKey`
- Expected vs actual:
  - **Expected (doc 05 §9):** one thread per person, keyed by "name + band + a device-local id". Memory is Discreet or Secret-adjacent: it holds the budget band, likes and concessions.
  - **Actual:** the key is `name.toLowerCase()|origin`. Any user who joins any voyage as "Maya" from ORD gets the real Maya's memory in `brief:private.memory` and in her Advocate's prompt. For example "mid budget", "conceded the city choice (wanted Chicago)", and the Advocate then says "My friend gave up the city pick last time".
  - The key is at least consistent everywhere: recall, remember and seed all match.
- Fix:
  - Key memory by a stable device-local person id sent at join (for example a `personId` in localStorage) plus the name. Fall back to no memory rather than a name-only match.
  - Keep the Expo seed working by seeding Maya's `personId`.
- Effort: M
- Scope: memory.ts `personKey`, svc `memoryFor`/`writeMemories`, MemberRec, join/create API, web client, seed
- Acceptance: two voyages each with a "Maya|ORD" but different person ids get disjoint memories; the Expo seed still yields Maya's "gave up the city pick" line.

### TR4-008: The test suite writes into the runtime memory store (`apps/server/data/memory.json`)
- Severity: Low
- Link: tests (e2e/service) → svc:544 → memory.ts:17/76 (`config.dataDir` is fixed and not overridable)
- Expected vs actual:
  - **Expected:** tests are isolated from demo state.
  - **Actual:** `memory.json` holds 20 duplicated test entries for maya/rae/dev. Examples: Rae "conceded the city choice (wanted Mexico City)", Maya "conceded … (wanted Lisbon)".
  - This alters live Advocate lines: the template's `/gave up|conceded/` memory note can now fire for Rae whenever her mate isn't seconding.
  - The `seedExpo` check also looks only at the last 5 entries.
  - The file is gitignored, so this is local pollution only.
- Fix: make `dataDir`/`cacheDir` env-overridable (`DATA_DIR`) and point vitest at a temp dir (a `vitest.setup` that sets `process.env.DATA_DIR = mkdtemp`). Alternatively, mock `memory.ts` in the service/e2e tests.
- Effort: S
- Scope: config.ts, vitest config/setup
- Acceptance: `npx vitest run` leaves `apps/server/data/memory.json` unchanged (checksum before and after).

### TR4-009: A standing seal starts inside `payments.create()`, so `seal:status` goes out before `booking:created` and before the trip is SEALING
- Severity: Low
- Link: svc:474–481 → orchestrator.ts:67 → `startSeal` → :215 → svc:71
- Expected vs actual:
  - **Expected (doc 06 §4.2):** create booking, emit `booking:created` and `seal:private`, then start the standing seals.
  - **Actual:** `startSeal` runs synchronously up to its first await and emits `seal:status AUTHORIZING` for a bookingId clients haven't seen, while `t.status` is still DRY_RUN and `t.bookingId` is unset (observed order in §3). Clients self-heal from `booking:created` (status AUTHORIZING), but a strict client drops the first event.
- Fix: split it into `create()`, which records only, and `startStanding(b)`, which the service calls after `booking:created` and `save`.
- Effort: S
- Scope: orchestrator `create`, svc `pick`
- Acceptance: the event order in the e2e test is `booking:created` < first `seal:status`.

### TR4-010: Engine privacy fallback is act-agnostic, and the price validator discards lines instead of stripping amounts
- Severity: Low
- Link: engine.ts:150–167 → filter.ts:75
- Expected vs actual:
  - **Expected (doc 05 §7.1.5, §7.2):** regenerate once *with an added "state no amount" instruction*, then fall back to a safe template **for that act**. An invalid currency amount is stripped ("the cheaper hotel"). `redactions` counts removals.
  - **Actual:**
    - The retry reuses the identical prompt.
    - If the template also fails, every act (Captain OPEN/DECIDE, PROPOSE, SUPPORT) says "That one's past what my friend can do." This is both wrong for the act and an affordability hint.
    - `invalidPrice` rejects the whole line.
    - Ribbon `invalidPrice` is ignored.
    - `rewrites` (name→"one of us") is not counted.
- Fix:
  - Pass a `noAmounts` flag into `prompt()` on retry.
  - Use a per-act safe-template map.
  - Implement amount stripping for `invalidPrice`.
  - Set `redactions += f.rewrites`.
- Effort: M
- Scope: engine `phrase`, filter (strip helper)
- Acceptance: unit tests where an invented "$999" is stripped and the line is kept; a leaking Captain DECIDE falls back to the DECIDE template.

### TR4-011: Hail handling gaps: invented prices pass, the whole hail is replaced on leak, and extra or late hails are dropped silently
- Severity: Low
- Link: svc:396–407 → filter.ts:75; engine.ts:92 (hails taken after Watch 3 are never used)
- Expected vs actual:
  - **Expected (doc 05 §4, §7.1, §11):** hails are filtered like lines, extra hails (>2 per Watch) are queued for the next Watch, and the member's Advocate acknowledges it.
  - **Actual:**
    - `f.invalidPrice` is ignored, so "$1,234" reaches the shared log and `parseHail`.
    - `pendingHails.slice(-2)` drops the oldest without telling the sender.
    - Hails sent during Watch 3 are drained by `collectHails(watch+1)` and discarded.
    - The HAIL turn is stamped with the current `watch`, not the Watch it is inserted into.
- Fix:
  - Apply the price strip from TR4-010.
  - Keep a per-member queue (one per member) instead of a global last-2 window, and emit a `hail:noted` ack to the member.
  - After the final Watch, reject with `CAPTAINS_CALLING`.
- Effort: S
- Scope: svc `hail`, engine `collectHails`
- Acceptance: tests where a third hail inside one Watch is kept for the next, and a hail after Watch 3 returns `CAPTAINS_CALLING`.

### TR4-012: Two different privacy contexts, and a chart-book limit of 50 against a spec of 12
- Severity: Low
- Link: svc:298/300 (`buildChartBook(…, 50)` + context over 50 plans) vs svc:323 / engine.ts:58 (engine context over 12)
- Expected vs actual:
  - **Expected (doc 05 §2.6):** the chart book is the top 12, and a single allowed set means "exact public values in the chart book".
  - **Actual:** the hail filter's allowed set includes group totals of plans 13–50 that nobody discussed. This is more permissive, and an exact collision with a secret share would be let through. Agents see only 12.
  - Harmless in the Expo run (11 plans total), but inconsistent.
- Fix: build the book with `limit = 12`. Build one `PrivacyContext` in the service and pass it into the engine (a constructor argument), instead of the engine recomputing it.
- Effort: S
- Scope: svc `chartBook`/`startTable`, engine ctor
- Acceptance: `helm.privacy.get(id)` deep-equals the engine's context; `chartBook(t).length ≤ 12`.

### TR4-013: `state()` still carries the voided booking after "back to the charts" or VOIDED→BRIEFING
- Severity: Low
- Link: svc:550/562 (`booking: b ? …`) vs svc:582 (replay filters by status)
- Expected vs actual:
  - **Expected:** after `retry` (DRY_RUN) the voided attempt is history. `replay` says so explicitly and doesn't send `booking:created`.
  - **Actual:** every `trip:state` in DRY_RUN/BRIEFING still includes `booking{status:"VOIDED", seals…}` and a stale `chosenPlanId`, so clients can render old seal state.
- Fix: include `booking`/`chosenPlanId` in `state()` only when `status ∈ {SEALING, BOOKED, VOIDED}`. Clear `chosenPlanId` in `retry`.
- Effort: S
- Scope: svc `state`, `retry`
- Acceptance: the `trip:state` after `retry` has no `booking`.

### TR4-014: Passkey gating details: consumed token forwarded to the provider, in-memory credentials, rpID-agnostic check
- Severity: Low
- Link: svc:501–504 → passkeys.ts:30/86 → orchestrator.ts:96/104
- Expected vs actual:
  - **Expected (doc 06 §4.2/§9):** the verified passkey assertion authenticates the VIC instruction, and the passkey is bound to the RP ID.
  - **Actual:**
    - The service consumes the single-use token, then forwards the same opaque token as `passkeyAssertion`. It is not a WebAuthn assertion and is already spent, so it is meaningless to a real VIC adapter.
    - `hasPasskey(memberId)` ignores rpID. A member who registered on a tunnel origin is then required to present an assertion that `authenticationOptions` (rpID-filtered) can never produce, which locks them out of sealing.
    - Credentials live in process memory, so after a restart gating silently falls back to tap-to-confirm.
- Fix:
  - Pass the verified assertion payload, or an attestation reference, from `verifyAuthentication` into the orchestrator.
  - Gate on `hasPasskey(memberId, rpIdOfRequest)`, or store the rpID in the token.
  - Persist credentials (Mongo `members.webauthnCredentialId`, per doc 04 §4.2).
- Effort: M
- Scope: passkeys.ts, svc `setSeal`, orchestrator `setSeal`, db
- Acceptance: tests where a member with a passkey only on another rpID can still seal via tap, or gets a clear error; a restart keeps passkey gating.

### TR4-015: Voice hop details: `audioUrl` isn't persisted immediately and replay drops `durationMs`
- Severity: Low
- Link: svc:342–344 (sets `turn.audioUrl` without `save`) and svc:574 (replay `turn:audioReady` without `durationMs`)
- Expected vs actual:
  - **Expected:** the turn log is durable with `audioUrl`, and the replay payload equals the live one (`{turnId, audioUrl, durationMs}` per doc 04 §7.2).
  - **Actual:** `audioUrl` is persisted only on the next turn's save. The last line relies on the DRY_RUN save. Replayed `audioReady` lacks `durationMs`.
- Fix: `this.save(t)` after setting `audioUrl` (or batch it). Store `durationMs` on the turn and include it in replay.
- Effort: S
- Scope: svc `voice` callback, `replay`, the shared `Turn` type
- Acceptance: a restore-after-DECIDE test shows `audioUrl` on the last turn; the replay payload includes `durationMs`.

### TR4-016: `pick()` can report failure after the booking was created
- Severity: Low
- Link: svc:482 → orchestrator.ts:40 `cardLast4` (provider `ensureAgentCard`)
- Expected vs actual:
  - **Expected:** once the trip is SEALING, pick either succeeds or rolls back.
  - **Actual:** a provider rejection in `cardLast4` for member k aborts `seal:private` for members k..n and throws to the organizer (`error INTERNAL`). The trip is already SEALING with a booking, and the remaining members get no seal screen until they reconnect (replay re-sends it).
- Fix: send each `sendSealPrivate` in its own try/catch (`Promise.allSettled`), falling back to `cardLast4: "••••"`, and always `broadcastState`.
- Effort: S
- Scope: svc `pick`, `sendSealPrivate`
- Acceptance: a test with `ensureAgentCard` throwing for one member still delivers `seal:private` to the others, and `pick` resolves.

### TR4-017: `submitBrief` partial commit when `createStanding` fails
- Severity: Low
- Link: svc:267–271 → orchestrator.ts:43
- Expected vs actual:
  - **Expected:** a brief seal is atomic from the user's view.
  - **Actual:** the brief is persisted and `briefSealed=true`, then `createStanding` throws. The trip isn't saved, no `brief:received` or `trip:state` is emitted, and a VOIDED trip isn't moved to BRIEFING. The client sees an error even though its brief is stored.
- Fix: call `createStanding` before persisting, or catch it, log it, and continue (the absent member then seals live, as doc 06 §6 P1 allows).
- Effort: S
- Scope: svc `submitBrief`
- Acceptance: a test where a throwing provider still leaves a consistent state (either nothing persisted, or sealed and broadcast with `standing` absent).

### TR4-018: No memory write on VOIDED
- Severity: Low
- Link: svc:532 → memory.ts:72
- Expected vs actual:
  - **Expected (doc 05 §9):** write after BOOKED "and after VOIDED with a smaller note".
  - **Actual:** only CAPTURED writes.
- Fix: on VOIDED, `remember(key, "voyage: <city> · not booked (a share didn't clear)")` with no per-member attribution, since doc 06 §7 says nobody learns whose seal failed.
- Effort: S
- Scope: svc `onBookingResult`/`writeMemories`
- Acceptance: after a voided attempt, every active member's memory gains one neutral line.

### TR4-019: `dryrunControl` works in any phase, and the action set drifts from the doc
- Severity: Low
- Link: io.ts:70–72 → svc:445–456
- Expected vs actual:
  - **Expected:** clock control only in DRY_RUN. Doc 04 §7.1 lists `pause|resume|day` (with `day?`).
  - **Actual:** accepted in any status (it creates a clock and broadcasts `dryrun:control`). The code and shared type use `restart`, and `void t` shows the fetched trip is unused.
- Fix: `if (t.status !== "DRY_RUN") throw BAD_PHASE`, and update doc 04 §7.1/§7.2 to `restart`.
- Effort: S
- Scope: svc `dryrunControl`, docs/04
- Acceptance: `dryrun:control` in BRIEFING returns `BAD_PHASE`.

### TR4-020: `sailWithout` housekeeping
- Severity: Low
- Link: svc:284 → orchestrator standing map
- Expected vs actual:
  - **Expected:** removing a member is idempotent and revokes anything issued for them.
  - **Actual:** `removedMemberIds.push` has no dedupe (repeated calls grow the array). A removed absent member's standing instruction, if one existed, is not revoked. Unsealed members normally have none, but TR4-001 shows they can seal afterwards.
- Fix: dedupe with `includes`, `payments.standing.delete(id)` on removal, and fix TR4-001.
- Effort: S
- Scope: svc `sailWithout`
- Acceptance: `sailWithout([x])` twice leaves one entry; after removal there is no standing instruction for x.

---

## 5. Summary

- **Hops traced:** 83. 48 are fully clean ✅; 35 link to an issue.
- **State transitions:** 12 assignments. 8 are documented. 3 are undocumented recovery or fallback edges (S4, S10, S11), and S4 has no guard. S12 can leave a trip stuck in SEALING. The `version` optimistic lock isn't implemented.
- **Units:** all cents↔dollars conversions are correct. Privacy context is ÷100. `capCents` goes to the standing instruction (limit = cap) and to the live instruction (min(cap, 1.02×share)). Budget bands come from cents. Time units are consistent (AUTOPICK_MS, SEAL_TIMEOUT_MS and voice duration in ms; dry-run and walking in minutes).
- **IDs:** consistent throughout: planId = `CITY-W#-hotel`, memberId everywhere, personKey only in memory.
- **Issues by severity:** Critical 0 · High 0 · Medium 6 (TR4-001, 002, 003, 004, 006, 007) · Low 14 (TR4-005, 008–020).
