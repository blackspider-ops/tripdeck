# Traceability Layer 5, round 2: Persistence (write path → MongoDB/local files → restore → replay)

Repo: `/Users/tejas/Downloads/untitled folder 3` @ 0430ef9 · Paths are relative to `apps/server/src/` unless noted.
Round 1: `docs/review/trace-5-persistence.md` (TR5-001…023, @ befc070).

**Method**
- Code reading of `store/{db,writeQueue,reconnect,normalize}.ts`, `trips/{core,crew,identity,table,dryrun,sealing,replay,persistence,records}.ts`, `payments/{orchestrator,sim}.ts`, `passkeys/passkeys.ts`, `memory/memory.ts`, `util/jsonStore.ts`, `voice/voice.ts`, `index.ts`, `config.ts`, the Dockerfile, the entrypoint, `render.yaml` and `DEPLOY.md`.
- The four suites pass: `restore`, `persistence`, `store` and `storage`, 36/36.
- Read-only inspection of the real Atlas db `all_ayes` with a scratch driver script. Nothing was written. The URI was never printed.
- Scratch vitest probes ran with `test/support/fakeDb.ts` and in-process `TripService` restarts. No dev server was touched and no paid call was made. The probes live in the session scratchpad `r2-t5/`, not in the repo.

**Probe results used below (reproducible)**
- **Per-status restore and replay.** I ran a restart for each status and checked what gallery and member clients receive. See §3. Every status restores without a crash. The replay matches docs/04 §7.3.
- **SEALING, trip write lost, booking already VOIDED.** The trip goes to VOIDED, but `lastResult` is missing, so `booking:result` replays with no `publicReason`.
- **SEALING with the booking at ALL_AUTHORIZED under SIM.** The voyage is voided with "The card network had a problem…" instead of the restart reason.
- **WriteQueue after a mid-run outage.** I failed two writes past `maxAttempts`, then brought the writer back and called `flush()`. Health stayed at `failed:2`, `totalWrites:0`, and **nothing was ever stored**.
- **Memory load failure.** `mongoLocal` whose first `loadAll` throws caches `{}`. A recall after the blip still returns `[]`. The next `remember(k,"new line")` stores `["new line"]` over the three stored lines.
- **Reconnect merge and passkeys.** With a passkey doc stored, `syncAfterReconnect()` (the path after a failed boot connect) leaves `hasPasskey(member)` **false**. A normal `restore()` gives true.

**Atlas snapshot (2026-09-25)**
- Documents: 12 trips (6 BRIEFING, 2 DRY_RUN, 4 BOOKED), 36 members, 31 briefs, 4 bookings (all CAPTURED, version set, no `capCents` in seals), 49 turns (all current round, 32 with `audioUrl`+`audioKey`), 337 events (all new shape, `at` BSON Date, TTL 30 d), 0 passkeys, 18 memories, 31 backboard_assistants.
- Nulls: the only stored `null` is `trips.autoPick` (7 docs).
- Integrity: no dangling members, no trip↔booking mismatch, no orphan bookings.
- Every index in docs/04 §4.9 exists, including the unique and TTL ones.
- All 12 `members.standing` docs have `limitCents` equal to the member's brief `capCents`. 5 of them belong to BOOKED voyages.

---

## 1. Write-path inventory

✅ = persisted in the right order. ◐ = persisted with a caveat. ❌ = not persisted. "mem (design)" = memory only by design.

| # | Mutation (file:line) | Fields | Persist call → collection | Status / notes |
|---|---|---|---|---|
| 1 | `createTrip` crew.ts:25-52 | whole TripRec; organizer member | `persist members` (addMember:73) + `save` ×2 → `trips` (coalesced by the queue) | ✅ (L5-010: joinCode unique only in memory) |
| 2 | `join`/`addMember` crew.ts:55-77 | MemberRec; `memberIds` | `members` then `trips` | ✅ |
| 3 | `setCrewOpen` crew.ts:91-98 | `crewClosed` | `trips` | ✅ |
| 4 | `addAbsent`/`reissueInvite`/`mintInvite` crew.ts:100-128 | `inviteKeyHash` | `members` | ✅ |
| 5 | `claimAbsent` crew.ts:135-152 | `tokenHash`, `crewKeyHash`, `inviteKeyHash` removed | `members` (`ignoreUndefined` → field removed) | ✅ |
| 6 | `submitBrief` crew.ts:155-190 | BriefRec, `briefSealed`, `m.standing` (provider call first), VOIDED→BRIEFING + `clearCharts` | `briefs`, `members`, `trips` | ✅ Three docs; partial writes are repaired on restore (TR5-002). ◐ `standing.limitCents` = cap (L5-007) |
| 7 | `sailWithout` crew.ts:192-214 | `removedMemberIds`, votes; `standing`/`inviteKeyHash` cleared | `members`, `trips` | ✅ |
| 8 | `mintHandoff`/`redeemHandoff` identity.ts:15-31 | demo handoff codes | – | mem (design, SEC-004): /demo links die on restart ("seed again") |
| 9 | `headsetCode`/`pairHeadset`/`unpairHeadset` identity.ts:35-68 | `headset {codeHash (HMAC), expiresAt, deviceTokenHash, deviceExpiresAt}` | `trips` | ✅ A paired device and a pending code survive a restart when `PAIRING_SECRET` is set (render.yaml generates it) |
| 10 | `startTable` table.ts:118-141 | AT_TABLE, `tableRuns`, `round+1`, `datasetHash`, `tableReset` cleared | `trips` (before any turn) | ✅ |
| 11 | `emitTurn` table.ts:151-158; `hail` table.ts:238-245 | Turn (seq shared by hails and engine turns) | `persistTurn` → `turns` (`_id`=turnId, round) | ✅ Unique `{tripId,round,seq}` holds |
| 12 | `voice` table.ts:159-167 | `audioUrl`, `durationMs`, `audioKey` | `turns` again | ✅ (L5-012: pruning) |
| 13 | `onWatch` table.ts:168; `negotiation.seq` | watch, seq | carried by the DRY_RUN save | ✅ Benign: an AT_TABLE restore resets anyway |
| 14 | `pendingHails`, `lastHailAt`, `hailsClosed` | – | – | mem (design) |
| 15 | engine success / failure table.ts:177-199 | DRY_RUN, `shortlistIds`, `shortlistPlans`, `dryrun` / resetTable | `trips` | ✅ |
| 16 | `vote` dryrun.ts:12-27 | votes, autoPick | `trips` | ✅ The timer is re-armed on restore (persistence.ts:171) |
| 17 | `dryrunControl` dryrun.ts:47-59 | `dryrun {startedAt, pausedAt}` | `trips` | ✅ TR5-011 fixed (probe: paused stays paused) |
| 18 | `script()` dryrun.ts:62-65 | lazily creates `t.dryrun` on older docs | – | ◐ Not saved (trivial) |
| 19 | `pick` sealing.ts:16-45 | booking created, `chosenPlanId`, `attempt`, `bookingId`, SEALING | `bookings` (orchestrator:127) then `trips` | ✅ Different slots, so no cross-doc order. Restore voids an orphan PENDING booking (persistence.ts:177-181) |
| 20 | seal flow orchestrator.ts:264-387 | intent (`authorizeRequestedAt`) before the provider call; `authRef`, `capturedAt`, `releasedAt`, `refundedAt`, statuses, `needsAttention`, `published` | `bookingDoc()` → `bookings` (version +1 per persist) | ✅ TR5-006 fixed (durable intents, recover/redrive) |
| 21 | `armDeadline` orchestrator.ts:150-159 | seal-deadline timer | – | mem. Restore voids every non-final booking, so a re-arm isn't needed |
| 22 | `retry` sealing.ts:110-128 | DRY_RUN, votes cleared, new clock | `trips` | ✅ |
| 23 | `onBookingResult` sealing.ts:130-142 | BOOKED/VOIDED, `lastResult` | `trips`; memory notes → `memories` (+ Backboard) | ✅ Live. ◐ The restore reconcile path skips `lastResult` and the memories (L5-006) |
| 24 | `createStanding`/`restoreStanding` orchestrator.ts:87-107 + persistence.ts:264-283 | `members.standing` (original expiry) | `members` | ✅ TR5-004 fixed. ◐ Kept on BOOKED voyages; holds the cap (L5-007) |
| 25 | SIM provider state sim.ts:13-15 | instructions, auths, idempotency results | – | mem (SIM only). Instructions are resumed; auths aren't, see L5-006 |
| 26 | `verifyRegistration` / counter passkeys.ts:157-194 | credential, counter | `passkeys` (base64url publicKey) | ✅ TR5-003 fixed. ❌ Not reloaded on reconnect merge (L5-003) |
| 27 | challenges / assertion tokens passkeys.ts:44-45 | – | – | mem (design, ≤5 min) |
| 28 | `remember`/`assistantFor` memory.ts:125-196 | thread lines, personKey→assistant id | `memories` / `backboard_assistants` (Mongo), else `DATA_DIR/*.json` (JsonStore) | ◐ The store kind is fixed at first use (L5-003). A failed load overwrites threads (L5-005) |
| 29 | `log` core.ts:72-78 | debug row; `events` insert | `append events` (not queued, counted on failure) | ✅ TR5-013 fixed. The debug log re-fills from events on restore |
| 30 | `clientLog` core.ts:99-103 | debug row | – | mem (documented) |
| 31 | `spend` util/limits.ts:156-168 | daily and per-voyage paid-call counters | – | ❌ Reset on every restart (L5-011) |
| 32 | `sweep`/`evictTrip` core.ts:225-263 | drops voyages from memory | – | Design (reloaded by `hydrate`). ◐ While Mongo is unreachable, an evicted voyage is lost (L5-001/L5-003) |
| 33 | `repairTrip`/`checkCharts`/`reconcileBooking` persistence.ts:190-312 | repairs | `trips`, `members` | ✅ The TR5-021 reset is now saved and announced |
| 34 | `syncAfterReconnect` persistence.ts:101-112 | re-persists everything in memory | all collections except `memories` | ◐ L5-003 |
| 35 | `synthesize` voice.ts:73-109 | `CACHE_DIR/tts/<sha1>.mp3` (content-addressed, no per-turn copy) | file | ✅ TR5-020 fixed (pruned hourly: ≤3000 files, ≤30 d) |

**Persisted but never read back:** `events._id`/`audience` (only the debug log reads them), `trips.createdAt`, `bookings.createdAt`, `seals.updatedAt`, `seals.setAt`, and `seals.published`. `published` *is* read after a restore (announce diffing), which is correct. `members.joinedAt`, `briefs.noteSource` (replayed to its owner) and `passkeys.createdAt` are informational. None of these is a problem.

---

## 2. Schema check (actual Atlas docs vs docs/04 §4)

| Collection | Actual (Atlas) | docs/04 | Indexes (actual = §4.9) | Match |
|---|---|---|---|---|
| `trips` | Every §4.1 field. `negotiation {watch,running,seq,round}` has no turns (0 embedded). `version` on all. `autoPick` is **absent** on 5 BRIEFING docs (never set by `createTrip`) and `null` on 7. `headset` is an HMAC `codeHash` plus the device fields. `shortlistPlans` holds per-member shares (server-only). No legacy `advocatedBy`/`endedReason` | §4.1 types `autoPick` as required `…\|null` | `joinCode` unique ✅, `{status,updatedAt}` ✅ | ✅ Minor: `autoPick` is optional in practice; `normalizeTrip` fills it (L5-013) |
| `members` | §4.2. `standing {memberId, instructionRef, limitCents, expiresAt}` on 12 absent seats. `inviteKeyHash` only while unclaimed. No nulls | §4.2 | `tripId` ✅ | ✅ Schema. ⚠ `limitCents` = cap, and §4.3 says the cap is stored only in briefs (L5-007) |
| `briefs` | §4.3. `_id`=memberId. `note`/`noteSource` absent when empty (no nulls) | §4.3 | `{tripId,memberId}` unique ✅ | ✅ |
| `turns` | §4.6 including `round` and `audioKey`. 0 docs without round | §4.6 | `{tripId,round,seq}` unique ✅ | ✅ (no TTL, no cleanup of old rounds: L5-008) |
| `bookings` | §4.7. `version` on all. Seals have no `capCents`. Durable-intent timestamps present | §4.7 | `tripId` ✅, `status` ✅ | ✅ |
| `events` | `{_id:ObjectId, tripId, type, audience:"trip"\|"member:<id>", payloadRedacted, at:Date}`. 0 member-audience rows carry a payload | §4.8 | `{tripId,at}` ✅, `at` TTL 2592000 ✅ | ✅ |
| `passkeys` | empty on dev. Code shape `{_id:credId, memberId, rpID, publicKey:b64url, counter, transports?, createdAt}` | §4.10 | `memberId` ✅ | ✅ |
| `memories` / `backboard_assistants` | `{_id:"crew:<sha256>\|<lowercased name>", v}` | §4.10 | `_id` only | ✅ (the `_id` embeds the lower-cased first name, which is acceptable) |

**`normalize()` and null/undefined handling.**
- The client runs with `ignoreUndefined:true` (db.ts:107), so no new nulls are written. Atlas confirms this: the only null is `autoPick`.
- `stripNulls` recurses into objects and keeps Dates and array elements. It turns non-plain BSON values (ObjectId, Binary) into plain objects. Today that only touches `events._id`, which is never used. Passkeys are stored as base64url strings, so they're safe.
- `normalizeTrip` (persistence.ts:318-332) re-applies `autoPick=null` and `dryrun.pausedAt=null`, and defaults the arrays, `version`, `negotiation` and `round`.
- `bookingFromDoc` re-derives `capCents` from the brief.
- Members, briefs and passkeys don't get field defaults, which is fine for docs this build writes.

**Duplicate keys and versions.**
- `writeDoc` (db.ts:63-83) writes with `{_id, version ≤ doc.version}`. A newer stored version makes the upsert hit E11000 on `_id`, which counts as **stale** (skipped). Any other E11000 (joinCode) is a `PermanentWriteError`, parked at once.
- `transition({expectVersion})` exists (core.ts:111) but no caller uses it, so a version conflict never reaches a client (L5-002).

---

## 3. Restore per status, and what a (re)joining client receives

Boot order: `connectDb()` → `helm.restore()` → HTTP/sockets (index.ts:20-21). Restore emits reach the debug log and `events` only, because the bus isn't attached yet. Replay order matches docs/04 §7.3. In the table, "G" is gallery/headset and "M" is a member phone.

| Status in DB | Restore action | After restart (probe) | Replay G / M (probe) | Same as before the restart? |
|---|---|---|---|---|
| BRIEFING | Load; standing restored with its original expiry | BRIEFING | G: `trip:state`. M: + `brief:private` (memory lines, maybe a follow-up) | ✅ |
| AT_TABLE | `resetTable` → BRIEFING, round+1, `tableReset`, **saved** | BRIEFING | G/M: `trip:state(BRIEFING)`, `error TABLE_INTERRUPTED`, no turns; M: + `brief:private`. The client clears its turns on AT_TABLE→BRIEFING | ✅ Intended difference (the table has to run again; TR5-021 fixed) |
| DRY_RUN | autoPick re-armed with the remaining ms; charts from `shortlistPlans` | DRY_RUN; votes kept, clock kept (paused stays paused) | `table:decided`, `trip:state`, `turn:new ×8` (+`audioReady` with `durationMs` if the mp3 is in CACHE_DIR), `dryrun:script` (same `startedAt`/`pausedAt`); M: + `brief:private`, `plan:private ×2`, `plan:myVote` | ✅ TR5-011 fixed |
| SEALING + PENDING / AUTHORIZING / ANY_DECLINED | `recover` → release every `authRef`, settle orphan auths → `voidAll` → trip VOIDED, `lastResult = restarted` | VOIDED / VOIDED | + `booking:created`, `booking:result(VOIDED, "The helm restarted mid-seal…")`; M: + `seal:private` (+`seal:declinedPrivate` if theirs) | ✅ Intended (nobody is charged) |
| SEALING + ALL_AUTHORIZED | `recover` → `captureAll` with the same keys | **SIM:** captures fail (the new process doesn't know the auths) → VOIDED "The card network had a problem…" | as above, with that reason | ◐ L5-006 (a real provider would capture) |
| SEALING + CAPTURED (trip write lost) | reconcile → BOOKED + save; `redrive` | BOOKED / CAPTURED | `booking:result(CAPTURED, ref)` | ✅ TR5-001 fixed. ◐ No memory notes are written (L5-006) |
| SEALING + VOIDED (trip write lost) | reconcile → VOIDED + save | VOIDED | `booking:result(VOIDED, **no reason**)` | ◐ L5-006 |
| SEALING, no booking doc | → VOIDED, `lastResult=restarted`, save | VOIDED | reason replayed | ✅ |
| DRY_RUN + orphan PENDING booking | `recover(orphan)` → voided; `onBookingResult` ignores it (wrong bookingId) | DRY_RUN | unchanged | ✅ |
| BOOKED | `redrive` (no-op); the standing Map entry is dropped (the member doc keeps it, L5-007) | BOOKED | `booking:created`, `booking:result(CAPTURED, ref)` | ✅ Device tokens end with BOOKED (by design) |
| VOIDED | standing restored (original expiry); `redrive` releases/refunds | VOIDED; retry works | `booking:result(VOIDED, stored reason)` | ✅ |
| Archived (BOOKED/VOIDED older than `RESTORE_RECENT_DAYS`, or swept) | not loaded; `hydrate` on REST `/trips/:id*`, by-code and `trip:join` | loaded on demand | identical to the above | ✅ (a sync lookup that misses → 503 LOADING) |

**Everything else across a restart**

| Item | Where it lives | After a restart |
|---|---|---|
| Member tokens, crew keys | `members.tokenHash` / `crewKeyHash` | ✅ Phones rejoin. Memory threads keep their keys |
| Headset device / pending code | `trips.headset` (HMAC under `PAIRING_SECRET`) | ✅ With the secret set (render.yaml). Without it a pending code dies (documented) |
| Demo handoffs, passkey challenges and assertions, hails queue, rate limits | memory (design) | Lost. Acceptable: short-lived, or "seed again" |
| Passkeys | `passkeys` | ✅ Normal boot. ❌ After a failed boot connect + reconnect (L5-003) |
| Standing instructions | `members.standing` | ✅ Original expiry, never re-issued (SEC-009) |
| Dry-run clock | `trips.dryrun` | ✅ |
| Turn audio | `turns.audioKey` → `CACHE_DIR/tts` | ✅ When the file exists (Render disk at `/var/data/cache`). Otherwise `audioUrl` is dropped and clients show captions. ◐ Pruning after restore (L5-012) |
| Memories | Mongo `memories` when connected at first use, else `DATA_DIR/memory.json` | ✅ Normal. ◐ L5-003, L5-005 |
| Backboard assistant map | Mongo `backboard_assistants` / `DATA_DIR/backboard-assistants.json` | ✅ Normal (no duplicate assistants). ◐ L5-003 |
| Debug log | re-filled from `events` (last 400×N rows) | ✅ Client lines are gone (documented) |
| Spend caps | memory | ❌ Reset (L5-011) |

**Round-1 status**

| Finding | Status |
|---|---|
| TR5-001, 002, 004, 005, 006, 009, 010, 011, 012, 013, 014, 017, 018, 019, 020, 021, 022, 023 | fixed (probe and Atlas confirm) |
| TR5-003 | fixed on normal boot; reconnect gap (L5-003) |
| TR5-007 | fixed for boot; mid-run outages aren't covered (L5-001) |
| TR5-008 | fixed (Mongo stores, and the Render disk for the cache) |
| TR5-015 | fixed for bookings; the cap is now in `members.standing` (L5-007) |
| TR5-016 | partly fixed: non-final voyages of any age still load (L5-008) |

---

## 4. Failure modes

| Mode | Behaviour | Verdict |
|---|---|---|
| Mongo down at boot | Memory mode, background reconnect 1 s→60 s, `/api/health.persistence.degraded=true`. On connect: merge the stored voyages, then re-persist everything held | ◐ Passkeys aren't loaded, memory stays on file (L5-003). Stored voyages answer 404 while it's down (L5-004) |
| Mid-run disconnect | The driver fails each write after 5 s of server selection. The queue retries 8× (about 70 s in total), then **parks**. `db` never becomes null and no reconnector runs, so `retryFailed()` never happens | ❌ L5-001 |
| Write failures / retries / parking | Ordered per document, coalesced, and a `structuredClone` snapshot at dispatch (store.test.ts). A parked write is retried only on a fresh persist of that same doc | ◐ L5-001 |
| Duplicate keys | joinCode E11000 → parked at once (permanent). Turn and brief uniques are safe by construction | ◐ L5-010 |
| Version conflicts | The write guard drops stale snapshots, counted as `staleSkipped`, which isn't part of `degraded`. Nothing reconciles two live writers | ◐ L5-002 |
| Read-only disk | The voice cache degrades to captions. JsonStore degrades to memory with one warning (`memoryHealth.degraded`). With Mongo, the file stores are unused. The entrypoint chowns `DATA_DIR`/`CACHE_DIR`, then drops to uid 1000 | ✅ |
| Corrupt JSON | Renamed to `.corrupt-<ts>` and the store starts empty. The write is atomic (tmp + rename) | ✅ |
| Corrupt or unreadable Mongo docs | A bad trip doc is skipped per voyage. A bad booking doc, or any `find` error during restore, rejects the top-level await, so boot crashes | ◐ L5-009 |
| SIGTERM | `closeDb()` flushes the queue (fires retry timers early), skips parked writes, then exits | ◐ With Mongo down, the flush can take about 40 s, longer than the platform grace period. Parked writes are dropped silently (L5-001) |

---

## 5. Findings

### L5-001: Writes parked during a mid-run MongoDB outage are never retried, so the voyage's final state is lost at the next restart
- **Severity:** High
- **Location:** `store/writeQueue.ts:86-92` (park after `maxAttempts`), `:113-119` (`retryFailed`); `store/db.ts:132-137` (the only caller is the boot reconnector); `store/db.ts:193-196` (`flushDb` skips parked writes)
- **Evidence:** Probe: a trip write and a booking write failed past 8 attempts. The writer then came back and `flush()` ran. Health stayed `{failed:2, totalWrites:0}` and nothing was stored. In production, an Atlas outage over about 70 s (5 s server selection × 8 plus 250 ms→16 s backoff) parks every doc written in that window. A doc that isn't touched again is never written. That includes a BOOKED trip's final save and the CAPTURED booking with its `capturedAt`/reference, as well as briefs, members and passkey counters. `/api/health` stays `degraded` until the process exits, and then the data is gone. On the next boot, restore sees the older state: for example SEALING + AUTHORIZING. It then **voids a booking that was captured** ("nobody was charged"). With SIM that is only a wrong message. With a real provider it would release/refund against captured money and tell the crew the wrong thing.
- **Fix:**
  1. When any write succeeds, call `queue.retryFailed()` for the other parked slots. This is cheap: hook it in `pump`'s success branch when `health().failed > 0`.
  2. Also add a low-frequency (30-60 s) `retryFailed()` timer while `failed > 0`.
  3. Don't let `retryFailed` reset the backoff of a `PermanentWriteError` slot. Keep a `permanent` flag.
  4. On `closeDb`, log a summary listing each parked `(col,_id)`.
- **Effort:** S
- **Scope:** `store/writeQueue.ts`, `store/db.ts`, `test/store.test.ts`
- **Acceptance:** A WriteQueue test fails a doc past `maxAttempts`, restores the writer, and without a new `enqueue` the doc is stored within the retry interval and `failed` returns to 0. A permanent (joinCode) slot stays parked.

### L5-002: Restore assumes it is the only writer: an overlapping instance voids live seals and resets live tables, and the version guard silently drops the loser
- **Severity:** Medium
- **Location:** `trips/persistence.ts:290-312` (`reconcileBooking` → `recover` on every non-final booking), `:211-213` (AT_TABLE reset); `store/db.ts:63-83`, `:150-156` (stale isn't in `degraded`); docs/04 §4 line 128; `DEPLOY.md:71` ("If you run with MongoDB, you can remove the disk")
- **Evidence:** Removing the Render disk, as DEPLOY.md suggests, turns zero-downtime deploys back on. The new instance boots while the old one is still serving. Its restore then:
  - calls `recover()` on the booking the old instance is sealing (voidAll, "The helm restarted mid-seal");
  - resets an AT_TABLE voyage to BRIEFING and saves it, while the old engine keeps emitting turns and later saves DRY_RUN.

  Both processes bump their own `version`. Whichever is higher wins, and the other's writes become `staleSkipped`. That counter doesn't raise `degraded`, and the losing instance keeps acting on state that is no longer stored. docs/04 claims the guard handles "a second instance during a deploy". It only orders snapshots. `transition({expectVersion})` has no callers.
- **Fix:**
  1. Document and enforce a single writer. Keep the disk, or set `maxInstances`/no overlap in DEPLOY.md and render.yaml, and correct the docs/04 sentence.
  2. Better: a lease document (`{_id:"helm", owner, expiresAt}`, renewed every 10 s). The new instance waits for or takes over the lease before `restore()`, and the old one stops writing when it loses the lease.
  3. Treat `staleSkipped > 0` as `degraded`.
- **Effort:** M
- **Scope:** `store/db.ts`, `index.ts`, `DEPLOY.md`, `render.yaml`, docs/04 §4
- **Acceptance:** Two in-process helms share a fake db that enforces the version filter. The second helm's `restore()` doesn't void the first helm's live booking until the lease is released. A stale write shows `degraded:true`.

### L5-003: Reconnecting after a failed boot connect doesn't load passkeys, and memory stays on local files for the life of the process
- **Severity:** Medium
- **Location:** `trips/persistence.ts:92` (`if (!opts.merge) await loadPasskeys()`), `:101-112`; `memory/memory.ts:81-83` (`local()` is chosen once, at first use)
- **Evidence:** Probe: after `syncAfterReconnect()`, `hasPasskey(member)` is false for a member whose passkey is stored. A normal boot gives true. Until the next restart:
  - `setSeal` accepts a plain confirm tap for that member (the SEC/WP-05 gate is downgraded);
  - `registrationBlock` lets them register a second credential on the same rpID, and `persistAllPasskeys` then writes it.

  Memory: a join during the outage makes `local()` pick the file store (`dbConnected()` is false), and it never switches back. Threads and Backboard assistant ids written in this process stay in `DATA_DIR/*.json`. The next boot (Mongo up) reads the Mongo collections, so those lines disappear and new Backboard assistants are created for the same people. Their old memories are orphaned.
- **Fix:**
  1. In the merge path, call `loadPasskeys()`. It is already idempotent per credential id. Load *before* `persistAllPasskeys()`.
  2. In `onDbConnected`, if `locals?.kind === "file"`, migrate the file maps into Mongo (upsert per key, merging thread arrays), then set `locals = null` so the next call picks Mongo.
- **Effort:** S
- **Scope:** `trips/persistence.ts`, `memory/memory.ts`, `test/persistence.test.ts`, `test/storage.test.ts`
- **Acceptance:** In the reconnect test, `hasPasskey` is true after the merge. A remembered line written while offline is recalled after a restart with Mongo up. No second assistant is created for that key.

### L5-004: While MongoDB is unreachable after boot, every stored voyage answers 404 NO_TRIP, and phones don't rejoin once it's back
- **Severity:** Medium
- **Location:** `trips/persistence.ts:39-45` (`missing()` → `notFound` when `!dbConnected()`); `apps/web/src/net/tripStore.ts:76-80` (join only on socket `connect`)
- **Evidence:** When the boot connect fails, no voyage is in memory. Every `trip:join` and `/trips/:id` gets `404 "That voyage doesn't exist."` instead of a retryable error. The phones stay connected to the running socket, so after the reconnect merge they never send `trip:join` again. They keep showing the error until someone reloads. The docs promise `503 LOADING` only for archived loads.
- **Fix:**
  1. In `missing()`, when `dbHealth().mode` is `reconnecting`/`unavailable`, throw `HelmError("LOADING", …, 503)` rather than NO_TRIP.
  2. Have the client retry `trip:join` with backoff on `LOADING` (it already handles an ack error). Optionally broadcast nothing and rely on the retry.
- **Effort:** S
- **Scope:** `trips/persistence.ts`, `apps/web/src/net/tripStore.ts`
- **Acceptance:** With the fake db disconnected at boot, a join answers 503 LOADING. After `fake.state.connected=true` and the hook, the retried join replays the voyage.

### L5-005: A failed first load of `memories`/`backboard_assistants` is cached as empty, and the next `remember` overwrites the person's thread
- **Severity:** Medium
- **Location:** `memory/memory.ts:55-65` (`data ??=` caches the failure), `:68-73` (persists every key that differs from the empty snapshot)
- **Evidence:** Probe: `loadAll` threw once, so recall returned `[]`, and still returned `[]` after Mongo recovered. `remember(k,"new line")` then stored `v:["new line"]` over the three stored lines. The same pattern applies to the assistant map: an empty map creates a duplicate Backboard assistant and overwrites the stored id. The trigger is one transient `find` error at the first recall of the process, for example during an Atlas failover.
- **Fix:**
  1. Don't cache a failed load: set `data = null` on error and return a transient `{}` for that call only.
  2. In `update`, if the load failed, skip the persist, or write with `$push`/`$slice` instead of replacing `v`.
- **Effort:** S
- **Scope:** `memory/memory.ts`, `test/storage.test.ts`
- **Acceptance:** A test where the first `loadAll` throws: after recovery, recall returns the stored lines, and `remember` appends (4 lines) rather than replacing them.

### L5-006: The restore reconcile path settles the trip but skips the outcome's side effects
- **Severity:** Low
- **Location:** `trips/persistence.ts:301-308`; `payments/orchestrator.ts:178-186` with `sim.ts:57-65`
- **Evidence:** There are three gaps:
  - **SEALING + VOIDED (trip write lost):** the replay's `booking:result` has no `publicReason`, because `lastResult` isn't set (probe).
  - **SEALING + CAPTURED:** BOOKED is correct, but `writeMemories` never runs, so the booked voyage leaves no memory note.
  - **SEALING + ALL_AUTHORIZED under SIM:** `captureAll` fails, because the new process has no auths. The crew is told "The card network had a problem" when the helm restarted.
- **Fix:**
  - Route the final-booking branch through `sealing.onBookingResult(b, status, reason)`. The trip is still SEALING, so the transition, `lastResult`, save and memory write come for free. Use `REASONS.restarted` for a VOIDED booking without a stored reason.
  - For SIM, give `recover` a `publicReason` override for capture failures that follow a restart.
- **Effort:** S
- **Scope:** `trips/persistence.ts`, `payments/orchestrator.ts`, `test/restore.test.ts`
- **Acceptance:**
  - A SEALING+VOIDED restore replays `booking:result` with a reason.
  - SEALING+CAPTURED writes one memory line per member with a crew key.
  - SIM ALL_AUTHORIZED gives the restart reason.

### L5-007: The absent member's cap is duplicated in `members.standing.limitCents`, and it's never cleared once the voyage is booked
- **Severity:** Low
- **Location:** `trips/crew.ts:168-177`, `payments/orchestrator.ts:93`, `trips/persistence.ts:270`; docs/04 §4.3 ("capCents … stored ONLY here")
- **Evidence:** Atlas: 12 of 12 `standing` docs have `limitCents` equal to the brief's `capCents`, and 5 of them sit on BOOKED voyages. This reopens the private-cap duplication TR5-015 closed for bookings. Restore drops the in-memory instruction for BOOKED voyages (persistence.ts:270), but the member doc keeps it.
- **Fix:**
  - Persist only `{instructionRef, expiresAt}` and re-derive `limitCents` from the brief on restore, as `bookingFromDoc` does.
  - Unset `standing` when the voyage books, or when the instruction expires at restore.
- **Effort:** S
- **Scope:** `trips/crew.ts`, `trips/persistence.ts`, `trips/sealing.ts`
- **Acceptance:** No `members` doc carries `limitCents`. A BOOKED voyage's absent member has no `standing`. The restore test still seals with the original limit.

### L5-008: Unbounded growth remains: old table rounds, abandoned live voyages, and wholesale loads of passkeys and memories
- **Severity:** Low
- **Location:** `trips/table.ts:110-115,133` (`round+1`, old turns stay); `store/db.ts:94-96` (no TTL on `turns`); `trips/persistence.ts:90` (every non-final voyage, any age); `trips/core.ts:225-236` (DRY_RUN/SEALING never swept); `passkeys/passkeys.ts:105-111`; `memory/memory.ts:58`; `persistence.ts:129` (events limit shared across voyages)
- **Evidence:**
  - Turns of interrupted rounds are never read or deleted. The cap is 6 rounds per voyage, so it's bounded but forever.
  - An abandoned DRY_RUN voyage is loaded at every boot and never swept.
  - Passkeys, memories and assistants are loaded in full at boot or first use.
  - At restore, a busy voyage's events can crowd the others out of the shared `400×N` limit.
- **Fix:**
  - Delete `turns` of `round < current` in `resetTable`/`startTable` (a `deleteMany` in the queue, or a TTL on `createdAt` for non-current rounds).
  - Add an idle cut-off for DRY_RUN (for example 30 d) to the restore query and the sweep.
  - Load passkeys and memory entries per member when needed.
  - Fetch events per voyage.
- **Effort:** M
- **Scope:** `trips/*`, `store/db.ts`, `passkeys/passkeys.ts`, `memory/memory.ts`
- **Acceptance:** After two interrupted tables, only the current round's turns remain. A DRY_RUN voyage idle for more than N days isn't loaded at boot and still opens by code.

### L5-009: A malformed booking doc, or a `find` error during restore, still crashes boot
- **Severity:** Low
- **Location:** `trips/persistence.ts:121-140` (loads plus the booking loop, outside the per-voyage try); `index.ts:21` (top-level `await helm.restore()`)
- **Evidence:** `bookingFromDoc` does `d.seals.map(...)` with no guard. One doc without `seals` throws out of `loadVoyages`. So does any rejected `loadWhere` (a network blip after `connect`). Either one rejects the top-level await, and on Render that means a crash loop until the data or network is fixed. Trips are protected per voyage (TR5-002); bookings, turns and members are not.
- **Fix:**
  - Wrap each booking conversion in try/catch (log and skip).
  - Wrap `restore()` in index.ts: on failure, start in the reconnecting mode (L5-004) and schedule `restore({merge:true})`.
- **Effort:** S
- **Scope:** `trips/persistence.ts`, `index.ts`
- **Acceptance:** A fake db holding a booking without `seals` boots and warns. A `loadWhere` that throws once at boot leads to a later successful merge.

### L5-010: joinCode uniqueness is checked only in memory, so a clash with an archived voyage parks the new voyage forever
- **Severity:** Low
- **Location:** `trips/crew.ts:33-34`; `store/db.ts:74-79` (E11000 on joinCode → `PermanentWriteError`)
- **Evidence:** Archived voyages aren't in memory, so `findByCode` can't see their codes. If a new voyage draws one, its every save is E11000 and parked. The voyage lives in memory only while its members and briefs persist, and after a restart those docs are orphans. Lookups by that code then hydrate the *old* voyage. The chance is about N/32⁶ per creation, which is tiny.
- **Fix:** On a joinCode E11000 for `trips`, regenerate the code and re-persist, or check `loadWhere("trips",{joinCode})` in `createTrip` when Mongo is on.
- **Effort:** S
- **Scope:** `trips/crew.ts`, `store/db.ts`
- **Acceptance:** With a stored archived trip holding code X and `newJoinCode` stubbed to return X then Y, the new voyage persists with Y.

### L5-011: Paid-call spend caps reset on every restart
- **Severity:** Low
- **Location:** `util/limits.ts:132-168`
- **Evidence:** `daily` and `perTrip` counters are memory only. A crash loop, or a few redeploys in one day, multiplies the SEC-005 daily budgets. Each voyage's per-voyage TTS/Gemini budget also restarts. `tableRuns` is persisted and bounds meetings, but not hails or STT.
- **Fix:** Persist the daily counters (one `{_id:"spend:<utcDay>", …}` doc via `$inc`, loaded at boot). Per-voyage counters can ride on the trip doc.
- **Effort:** S
- **Scope:** `util/limits.ts`, `store/db.ts`
- **Acceptance:** Spend a budget to its cap, restart with the fake db, and `spend()` still refuses.

### L5-012: The audio cache pruner can delete an mp3 that a restored turn still points at
- **Severity:** Low
- **Location:** `voice/voice.ts:155-172`; `index.ts:48-54`; `trips/persistence.ts:339-347`
- **Evidence:** Restore registers `turnId → key` when the file exists. `pruneAudioCache()` runs at boot and hourly, and removes files older than 30 days or beyond 3000. `restoreTurnAudio` doesn't refresh the mtime, so an old voyage's lines are deleted *after* being registered. `audioUrl` stays on the turn, and replay then emits `turn:audioReady` for a 404.
- **Fix:** `utimes` the file in `restoreTurnAudio`, or have `audioFile()` check existence and drop the mapping.
- **Effort:** S
- **Scope:** `voice/voice.ts`
- **Acceptance:** A restored turn whose file is then pruned is served as 404 at most once, and replay stops sending its `audioReady`. Or the file survives the prune.

### L5-013: docs/04 §4 drifts from the stored data in a few places
- **Severity:** Low
- **Location:** docs/04 §4 preamble (line 128), §4.1 (`autoPick` required), §4.3 (cap "stored ONLY here"), §4.6/§4.9 (no word on turn retention)
- **Evidence:**
  - Atlas: `autoPick` is absent on BRIEFING docs.
  - The cap is also in `members.standing` (L5-007).
  - The version guard is described as protecting a second instance (L5-002).
  - Old-round turns are kept forever (L5-008).
  - Nothing documents that handoffs, challenges, spend caps and hail state are memory only.
- **Fix:** Update §4.1, §4.3 and the preamble, and add a short "memory only by design" list to §4.
- **Effort:** S
- **Scope:** `docs/04-technical-design.md`
- **Acceptance:** The docs match the Atlas snapshot and the code in this report.

---

**Counts:** 13 findings (High 1, Medium 4, Low 8). 19 of the 23 round-1 findings are fully fixed. TR5-003, 007, 015 and 016 are partly fixed; the remaining gaps are L5-003, L5-001, L5-007 and L5-008.
