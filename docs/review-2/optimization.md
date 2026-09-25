# All Ayes: optimization and code-quality review, round 2 (HEAD 0430ef9)

Read-only review of `packages/shared`, `apps/server` and `apps/web` (about 21k LOC including tests), done after the round-1 fixes (docs/review/optimization.md) and the refactors that followed: the `trips/*` split, the `api/*` split, `negotiation/prompts.ts`, `scene/director/*`, the phone `TripShell` split, `util/*` and `store/*`. The only repo file written is this report. Scratch harnesses and raw output are in `scratchpad/r2-opt/{A,B,C,D}`.

**Baseline, verified during the review:**
- `apps/server` `npx vitest run`: **29 files, 308 tests, all pass**. Wall time 7.98 s (tests 21.9 s, collect 13.7 s, transform 1.2 s).
- `apps/web` `npx vitest run src`: **12 files, 52 tests, all pass** in 1.25 s.
- `npx vite build --outDir /tmp/aa-r2opt`: builds in 2.97 s with no chunk-size warnings.
- `npx ts-prune` was run on web and on a server config limited to src and scripts, then removed again.
- A tsx harness drove a real `TripService` through a full voyage with `PACE_SCALE=0`, no keys, and a counting fake db behind the real `WriteQueue`. It covered create → 3 joins → 4 briefs → table → dry run → 4 votes → pause/resume → pick → 4 seals → BOOKED.
- Micro-benchmarks covered `buildChartBook`, `filterLine`, memory `update`, and the payments persist count.

## Executive summary

1. **One real leak on the server.** `payments.bookings` is never evicted (`evictTrip` clears `standing` but not `bookings`), and on every Mongo reconnect the whole map is re-persisted (O2-035). The same pattern appears at a smaller scale in `SimProvider`, `bbCache` and `handoffs` (O2-041, O2-042).
2. **Mongo write volume is the main server cost, not CPU.** `state()` takes 1.3 µs, `buildChartBook` 0.55–1.2 ms, and a replay 0.28 ms. But once the table has met, every save rewrites an **11.9 kB** trip document, 93% of it the unchanging `shortlistPlans`. Every emit does its own `insertOne` (62 per voyage). One 4-seal booking causes 16 booking persists (O2-036 to O2-038).
3. **The headset client leaks on teardown.** Removed crew pieces are never disposed (O2-050). The module-global `tweens` outlives each Stage and keeps the old scene graph alive through pending `wait()` promises (O2-051). Voice mp3s keep playing after unmount (O2-052). Per-frame billboard and raycast work and roughly 65–70 MB of canvas textures on desktop (about 25–28 MB on Quest) are the next costs (O2-054 to O2-057).
4. **The refactors left compatibility layers behind.** `TripService` is 35 one-line forwarders kept "so io.ts, routes.ts and the tests don't change", plus test-only forwarders and re-exports. `engine.ts` re-exports `buildPrivacyContext`, and `seats.ts` and `XRApp.ts` re-export symbols (O2-001). Round-1 OPT-004 was only partly applied: `lerp`, `Flag`, `tweens.busy`, `CrewPiece.setName`, `CompassTimer.reset` and `SceneDirector.footprint` are all still present (O2-002).
5. **Duplication moved rather than disappeared.** The organizer/member phase guard is written 16 times across the trips modules (O2-010). Timeout wrappers appear 5 times, and the Gemini one never clears its timer (O2-011). Strings that are meant to be identical are copied instead of imported (O2-012). On the phone, the REST busy/error boilerplate appears 7 times and the crew-member form 3 times (O2-015, O2-016). The web app hard-codes server limits (24, 40, 160, 4, 2, 3) (O2-031).
6. **Tests.** Four full-voyage tests take 11.4 s of the 21.9 s test time because they run at `PACE_SCALE=0.05` (O2-062). Coverage gaps: the sweep and eviction path (which is how O2-035 slipped through), the negotiation rules 3–5, pricing failure reasons, the memory and voice backends, every web hook, and all scene/XR pure logic (O2-064 to O2-068).

## Summary by category and severity

| Category | High | Medium | Low | Total |
|---|---|---|---|---|
| Dead code / refactor leftovers | 0 | 1 | 8 | 9 |
| Duplication | 0 | 5 | 5 | 10 |
| Too long / too thin | 0 | 2 | 3 | 5 |
| Inconsistency | 0 | 2 | 4 | 6 |
| Magic numbers | 0 | 1 | 3 | 4 |
| Performance (server + web + 3D) | 1 | 12 | 12 | 25 |
| Bundle | 0 | 0 | 2 | 2 |
| Tests (speed + coverage) | 0 | 5 | 3 | 8 |
| **Total** | **1** | **28** | **40** | **69** |

**Top findings by value to effort:** O2-035, O2-026, O2-050, O2-051, O2-036, O2-062, O2-011, O2-010, O2-046, O2-012.

## Measurements

### Bundle

`vite build --outDir /tmp/aa-r2opt`. Sizes are min / gzip. Contents come from source-map attribution and are pre-minify source sizes.

| Chunk | Size | Contents | Loaded by |
|---|---|---|---|
| `three` | 636.3 / 163.2 kB | three 1,458 kB | XR, Gallery |
| entry `index-DO2f…` | 266.9 / 84.9 kB | react-dom 620 kB, react-router 367 kB, router/main 1.7 kB | every route |
| `3d-tiles` | 158.7 / 47.1 kB | 3d-tiles-renderer 285 kB | XR/Gallery, only when a tiles key is set (dynamic import) |
| `troika` | 116.6 / 43.1 kB | troika-three-text 191 kB, bidi-js 44 kB, webgl-sdf-generator 32 kB, troika utils 40 kB | XR, Gallery |
| `Stage` | 75.9 / 27.1 kB | app scene code 149 kB (DryRun.ts 21 kB, materials 14 kB, Globe 11 kB…) | XR, Gallery |
| `TripShell` | 59.9 / 19.9 kB | phone screens 110 kB | phone trip |
| `labels` (misnamed shared chunk) | 47.4 / 15.1 kB | socket.io/engine.io 125 kB, `net/tripStore.ts` 12.6 kB, `scene/labels.ts`, `shared-ui/seating.ts` | phone trip, XR, Gallery |
| `browser` | 25.8 / 10.0 kB | qrcode 71 kB (lazy) | invite QR only |
| `index-Ig1n…` | 9.1 / 3.0 kB | @simplewebauthn/browser (lazy) | passkey step only |
| `XRPage` | 19.2 / 6.7 kB | xr code 34 kB | XR |
| all other route chunks | 1–5 kB each | | |

- XR first load is about 1.20 MB min / 347 kB gz: entry + three + troika + Stage + labels + XRPage + constants.
- A phone trip page is about 390 kB min / 125 kB gz, with no three.js.
- Round 1's 774 kB `Stage` chunk is now split into cacheable `three`, `troika` and app `Stage` chunks. qrcode and webauthn are lazy. Fonts are self-hosted: 6 woffs, 168 kB, with one preloaded.

### Server

Harness in `scratchpad/r2-opt/A/harness.mts`. Crew of 4, rules mode, `PACE_SCALE=0`.

| Phase | `trip:state` sent (bytes each) | persist calls → db writes (bytes) | event inserts |
|---|---|---|---|
| create | 1 (703) | trips 2→1 (427), members 1 | 1 |
| join ×3 | 3 (817 / 918 / 1,019) | trips 3→1, members 3 | 3 |
| briefs ×4 | 4 (~1,016) | trips 4, members 4, briefs 4 | 8 |
| table → DRY_RUN | 2 (1,015 / 1,072) | trips 2 (**12,233**), turns 10 (4,006) | 24 |
| votes ×4 | 0 (`plan:votes` instead) | trips 4→1 (11,912) | 8 |
| pause + resume | 0 | trips 2→1 (11,912) | 2 |
| pick | 1 (1,590) | trips 1 (11,929), bookings 1 | 6 |
| seals ×4 → BOOKED | 1 (1,576) | bookings **16→10** (15,018), trips 1 (11,970) | 10 |

| Measurement | Value |
|---|---|
| `state()` | 1.27 µs (2.8 µs including `JSON.stringify`) |
| `buildChartBook` | 0.55 ms in the harness, 1.18 ms with the Expo crew; **62% of it (736 µs) is 24 `toLocaleDateString` calls** |
| `filterLine` | 24 µs with 0 crew names, 30 µs with 3, 96 µs with 12 |
| Rejoin `replay()` in DRY_RUN | member: 17 events / 11.8 kB / 0.28 ms; spectator: 13 events / 8.75 kB. `table:decided` is 3.8 kB of that |
| Trip document after the table | 11,970 B, of which `shortlistPlans` is 11,100 B (93%) |
| Static part of every `trip:state` | `dateWindows` 127 B + `candidateCities` 185 B = 31% of a 1,019 B state |
| Payments `persist()` per booking | 3 seals → 14, 4 → 17, 6 → 23 (3n+5) |
| memory `mongoLocal.update` per `remember()` | 0.16 ms with 100 threads, 1.28 ms with 1k, 8.5 ms with 5k |
| Voice cache | 15 mp3 files, 1.2 MB (47–121 kB each); fully async fs |

Round 1's `trip:state` was 7.5 kB, 87% of it the shortlist. It is now at most 1.6 kB. That fix held.

### Test suite

| Test | Time |
|---|---|
| e2e "seed → … → booked" | 2,923 ms |
| contract "full voyage + replay" | 2,922 ms |
| plan-privacy "Gallery at DRY_RUN" | 2,877 ms |
| e2e "lifted seal voids … retry" | 2,814 ms |
| payments SEC-002 decliner sequence | 939 ms |
| seal-integrity SEC-002 | 628 ms |
| everything else | < 350 ms each; 300 of 308 tests take < 250 ms |

The first four are the `PACE_SCALE=0.05` tests: 11.5 s of the 21.9 s of test time.

### 3D budgets (static count)

**Canvas textures (GPU memory including mipmaps):**

| Texture | Desktop | Quest (`LOW_TEX`) |
|---|---|---|
| Chart | 2048² ≈ 21.3 MB | 1024² ≈ 5.3 MB |
| Globe | 2048×1024 ≈ 10.7 MB | 2.7 MB |
| Street plates | 1024² ≈ 5.3 MB each (up to 6 cached) | 1.3 MB each |
| Cards | ≈ 15 MB | ≈ 5 MB |
| PMREM | ≈ 6.3 MB | ≈ 6.3 MB |
| **Total** | **≈ 65–70 MB** | **≈ 25–28 MB** |

**Draw calls, with 5 crew and 6 pins:** about 120 at AT_TABLE, 185 at DRY_RUN and 170 at SEALING. Troika Text accounts for roughly 40–60 of them.

---

## Dead code / refactor leftovers

### O2-001 — TripService facade and re-exports are compatibility shims from the refactor
- Severity: Medium
- Category: Dead code / refactor leftover
- Location:
  - apps/server/src/trips/service.ts:5-7 (the header says the method names stay "so io.ts, routes.ts and the tests don't change"), :29-31, :45-89
  - apps/server/src/api/http.ts:3; apps/server/src/api/routes.ts:4; apps/server/src/api/passkeyRoutes.ts:7; apps/server/src/realtime/io.ts:10
  - apps/server/src/negotiation/engine.ts:217
  - apps/web/src/xr/XRApp.ts:16; apps/web/src/scene/seats.ts:13; apps/web/src/scene/SceneDirector.ts:27
- Evidence:
  - `service.ts:45-89` has 35 one-line forwarders into the split modules.
  - `pricingCrew`, `chartBook`, `shortlist` and `datesLabel` (`:70-73`) are called only from tests (`hail.test.ts`, `persistence.test.ts`).
  - `service.ts:29-31` re-exports `HelmError`, `datasetHash` and `validateBrief` for tests. `HelmError` is re-exported twice (util/errors → records.ts:9 → service.ts:29), and all four API files import it from `trips/service`.
  - `export { buildPrivacyContext }` in engine.ts is used only by `test/negotiation.test.ts:6`. `table.ts:11` imports it from `privacy/context`.
  - `export { HAIL_PRESETS }` in XRApp has 0 importers.
  - The `seatAngle` re-export in seats.ts is only used by `CrewSeating.ts:6`, which could import `shared-ui/seating` directly.
  - The `DirectorOptions` re-export exists only for `Stage.ts:5`.
- Suggested fix:
  - Import `HelmError` from `util/errors` everywhere.
  - Point tests at `helm.table.*` / `helm.crew.*` and delete the test-only forwarders.
  - Either keep the facade as the single public surface of `trips/` (and document it that way), or let io.ts and routes.ts call the modules directly and delete the forwarders.
  - Delete the three web re-exports and import from the source modules.
- Effort: M
- Scope: apps/server/src/trips, apps/server/src/api, apps/server/src/realtime, apps/server/src/negotiation, apps/server/test, apps/web/src/scene, apps/web/src/xr
- Acceptance: `grep -rn "from \"../trips/service\"" apps/server/src/api apps/server/src/realtime` only imports `TripService`. The facade has no test-only methods. tsc on both apps and vitest are green.

### O2-002 — Round-1 OPT-004 was only partly applied; the scene/XR code has new unused members
- Severity: Low
- Category: Dead code
- Location:
  - Carried over from round 1:
    - apps/web/src/scene/tween.ts:14 (`ease.spring`), :67 (`busy`), :72 (`lerp`)
    - apps/web/src/phone/components/icons.tsx:92 (`Flag`)
    - apps/web/src/scene/CrewPiece.ts:89 (`setName`)
    - apps/web/src/scene/Instruments.ts:70 (`CompassTimer.reset`)
    - apps/web/src/scene/SceneDirector.ts:200 (`footprint`)
    - apps/web/src/xr/placement.ts:69,93 (`camera` param, `void camera`)
  - New:
    - SceneDirector.ts:59 (`onStatus`, never set by any caller)
    - apps/web/src/scene/ChartTable.ts:114 (`captionScale` getter, which makes the `scale` field write-only)
    - apps/web/src/scene/materials.ts:169,182,183 (`M.paperDeep`, `M.inkSoft`, `M.redInk`)
    - apps/web/src/scene/director/context.ts:22 (`DirectorContext.table`, filled at SceneDirector.ts:71 and read by no part)
    - apps/web/src/scene/troika.d.ts:25 (`configureTextBuilder`, `curveRadius`, `whiteSpace`, `fillOpacity`, `textRenderInfo`)
  - Exported but used only in their own file: `CLOCHE_R`, `GLOBE_R`, `GLOBE_CENTER_Y`, `MAX_WRITE_MS`, `LOW_TEX`, `sheetPx`, `paperTexture`, `canvasTexture`, `contactShadow`, `PinSpec`, `FontKey`, `TextOpts`, `Globe.turnTo`, `DryRunCloche.lowPoly`, `SealChart.state`, `CrewPiece.absent`, `WristMenu.wheelHit`.
- Evidence: `ts-prune` on apps/web reports `lerp` and `Flag`. A grep over apps/web/src, tests included, finds 0 callers for the rest.
- Suggested fix: delete them, or make them private. `VoiceHandle.stop` (audio.ts:152) should stay: O2-052 needs it.
- Effort: S
- Scope: apps/web/src/scene, apps/web/src/xr, apps/web/src/phone/components
- Acceptance: `npx ts-prune -p apps/web/tsconfig.json | grep -v "used in module"` prints only intended test hooks. tsc and vite build pass.

### O2-003 — Unused exports in phone/net
- Severity: Low
- Category: Dead code
- Location:
  - apps/web/src/net/session.ts:65 (`clearHeadsetSession`, 0 callers)
  - Exported but used only in their own file:
    - apps/web/src/net/tripStore.ts:12,43 (`SealPrivate`, `TripSocket`)
    - session.ts:12 (`HeadsetSession`)
    - apps/web/src/net/passkey.ts:10 (`PasskeyResult`)
    - apps/web/src/phone/TripContext.tsx:17,72,83 (`TripView`, `shallowEqual`, `CrewView`)
    - apps/web/src/phone/memory.ts:9 (`MemoryPrefill`)
    - apps/web/src/phone/components/voices.ts:64,92 (`waitForAudio`, `speak`)
    - apps/web/src/gallery/GalleryApp.ts:12 (`Preset`)
    - apps/web/src/net/api.ts:112 (`captureDevKey`)
    - apps/web/src/phone/components/Hail.tsx:11 (`HAIL_MAX_CHARS`)
- Evidence: ts-prune plus grep of apps/web/src, tests included. `ORGANIZER_DEG`, `OUTBOX_MAX` and `OUTBOX_TTL_MS` are exported only for tests, which is fine.
- Suggested fix: delete `clearHeadsetSession` and drop `export` from the rest. Move `HAIL_MAX_CHARS` to shared (O2-031).
- Effort: S
- Scope: apps/web/src/net, apps/web/src/phone, apps/web/src/gallery
- Acceptance: tsc and web vitest pass.

### O2-004 — Unused server exports and test-only production surface
- Severity: Low
- Category: Dead code
- Location:
  - apps/server/src/store/writeQueue.ts:51 (`setWriter`, 0 callers)
  - apps/server/src/util/limits.ts:23,24,34 (`Lru.peek`, `has`, `entries`, 0 callers), :93 (`Concurrency.count`), :113 (`normalizeIp` exported but only used in its own file), :71 (`retryAfterMs`, tests only)
  - apps/server/src/store/reconnect.ts:43 (`running`, tests only)
  - packages/shared/src/events.ts:87 (`C2SPayload`, 0 uses)
  - apps/server/src/fit/pricing.ts:43,52,69,96,114,128,158,187,228,291,329: 11 step functions exported and never imported (`usableWindows`, `chooseFlight`, `choosePicks`, `arrivalsFor`, `placeGroupMoments`, `placePicks`, `legsAndFlags`, `memberView`, `sharedPublicFlags`, `publicDays`, `myDays`)
  - Types used only in their own file: `TableState`, `DatasetIndex`, `SealRec`, `PaymentEvents`, `PasskeyDoc`, `GenLine`, `LineRequest`, `Amount`
- Evidence: ts-prune with a src+scripts-only config lists 50 "used in module" exports on the server. Grep across apps/*/src, apps/*/test, packages and scripts confirms each item. The test hooks `__memoryTest`, `resetPasskeysForTests` and `resetSpend` are intentional.
- Suggested fix:
  - Delete the unused methods and `C2SPayload`.
  - Un-export the pricing steps. Better, keep them exported and give them unit tests (O2-065).
- Effort: S
- Scope: apps/server/src/store, apps/server/src/util, apps/server/src/fit, packages/shared/src
- Acceptance: tsc and vitest pass.

### O2-005 — `apiNotFound` is unreachable in production
- Severity: Low
- Category: Dead code
- Location: apps/server/src/index.ts:29; apps/server/src/web.ts:65-67; apps/server/src/api/routes.ts:225
- Evidence: `apiRouter` already ends with the same 404 handler, so the `app.use("/api", apiNotFound)` mounted after it never runs. Only `test/hardening.test.ts:68` mounts it on its own.
- Suggested fix: delete `apiNotFound` and both mounts, and point the hardening test at `apiRouter`.
- Effort: S
- Scope: apps/server/src, apps/server/test
- Acceptance: an unknown `/api/x` still returns a JSON 404 (hardening test).

### O2-006 — Legacy read paths from older document shapes
- Severity: Low
- Category: Refactor leftover
- Location: apps/server/src/trips/records.ts:58-59 (`LegacyEventDoc`); apps/server/src/trips/persistence.ts:255 (`e.event` / `e.summary` fallbacks), :247-248 (pre-TR5-015 `capCents`), :275-279 (`standing` derived from `sealedAt`), :319-331 (`normalizeTrip` `??=` defaults and pre-TR5-012 embedded turns)
- Evidence: events have a 30-day TTL index (`store/db.ts:61`), so no legacy event row can still exist. The trip-shape fallbacks still matter for older trip documents.
- Suggested fix:
  - Delete `LegacyEventDoc` and its fallbacks now.
  - Move the trip-shape upgrades into a one-time `migrate()` step with a removal date, so `loadVoyages` stops paying for them on every boot.
- Effort: S (events) / M (migration)
- Scope: apps/server/src/trips, apps/server/src/store, apps/server/test
- Acceptance: `restore.test.ts` "old docs load" still passes, via the migration.

### O2-007 — Server write-only fields, unused parameters and dead branches
- Severity: Low
- Category: Dead code
- Location:
  - apps/server/src/trips/identity.ts:16 (`mintHandoff(ttlMs)` is never passed)
  - apps/server/src/trips/crew.ts:37 (`TripRec.presetId`), :68 (`MemberRec.joinedAt`): written, never read
  - apps/server/src/api/debug.ts:42 (re-fetches the booking that `sum.booking` already holds), :50 (`sum?.payments ?? …` fallbacks can't fire)
  - apps/server/src/api/routes.ts:24 (`BAD_JSON` / `BAD_REQUEST` are never thrown as `HelmError`)
  - crew.ts:75 (`createTrip` → `addMember` broadcasts a `trip:state` with `organizerId: ""` to an empty room before crew.ts:50 sets the organizer)
  - apps/server/src/negotiation/gemini.ts:16,43 (`timeoutMs` option, never passed)
  - apps/server/src/passkeys/passkeys.ts:65-66 (`originOf` string overload, never used)
  - apps/server/src/payments/orchestrator.ts:430 and apps/server/src/trips/core.ts:40 (`publicSealStatus` can never change a status that came from `publicSealOf`)
  - orchestrator.ts:43,267 (`SealRec.setAt`, only copied)
  - apps/server/src/negotiation/engine.ts:48,84,103 (`EngineResult.endedReason`, read only by a test), :186 (`advocateFacts`, tests only)
  - apps/server/src/privacy/filter.ts:18,195-229 (`FilterResult.reasons` builds strings like `` `secret≈${a.value}` `` on every line and nobody reads them)
- Evidence: each one was grepped across src, test, scripts and packages.
- Suggested fix: remove them. Suppress the empty-room broadcast in `createTrip`. Keep `reasons` only behind a debug flag.
- Effort: S
- Scope: apps/server/src/trips, apps/server/src/api, apps/server/src/negotiation, apps/server/src/passkeys, apps/server/src/payments, apps/server/src/privacy
- Acceptance: tsc and vitest pass.

### O2-008 — Unused CSS rules, and one class with no CSS
- Severity: Low
- Category: Dead code
- Location: apps/web/src/styles/phone.css:7 (`--ease-physical`), :40 (`.hand`), :43 (bare `.ok`), :48 (`.wrap`), :51 (`hr.double`), :64 (`.card.flat`), :65 (`.card h3`); apps/web/src/phone/screens/Table.tsx:47 (emits `hand-quote`, which no CSS defines)
- Evidence: a scripted check of all 91 phone.css classes against string literals, including template-string classes (`scratchpad/r2-opt/C/css.py`), with manual confirmation. `tokens.css` and `xr.css` are clean.
- Suggested fix: delete the dead rules. Rename `.hand` to `.hand-quote` if a hail was meant to be set in the hand face; otherwise drop the class.
- Effort: S
- Scope: apps/web/src/styles, apps/web/src/phone/screens
- Acceptance: vite build passes. Visual check of the Table screen with a hail.

### O2-009 — Phone leftovers from the send-guard and TripShell split; `NO_STT` copy never shows
- Severity: Low
- Category: Dead code
- Location:
  - `store` destructured but unused: apps/web/src/phone/screens/Voided.tsx:21, Brief.tsx:16, Seal.tsx:20, apps/web/src/phone/components/organizer.tsx:13
  - organizer.tsx:2,4: duplicate `@all-ayes/shared` import
  - apps/web/src/phone/screens/PhaseRoutes.tsx:36,61: `allowedScreens` called twice; `me?.` right after an `if (!me)` guard
  - Stale comment "memo: the shell re-renders on every event" (it is `PhaseRoutes` now): Seal.tsx:143, Brief.tsx:168, Booked.tsx:95, Voided.tsx:66, Wait.tsx:36
  - apps/web/src/net/tripStore.ts:171 (comment claims the debug overlay reads `pending`; it doesn't), :225-226 (two stacked JSDoc blocks)
  - apps/web/src/phone/errors.ts:22 and apps/web/src/phone/components/useRecorder.ts:98-101: `transcribeError` returns `e.message`, so the `NO_STT` copy is never used
- Evidence: grep and reading the code. tsc doesn't flag these because apps/web/tsconfig.json has no `noUnusedLocals`.
- Suggested fix:
  - Clean these up and add `noUnusedLocals` and `noUnusedParameters` to both tsconfigs.
  - Have `transcribeError` return `errorCopy(e)`.
- Effort: S
- Scope: apps/web/src/phone, apps/web/src/net, apps/web/tsconfig.json
- Acceptance: tsc with the new flags passes on web.

---

## Duplication

### O2-010 — The organizer/member phase guard is written 16 times across trips modules
- Severity: Medium
- Category: Duplication
- Location:
  - Organizer form, `h.requireOrganizer(tripId, actor); const t = h.trip(tripId); if (t.status !== X) throw BAD_PHASE`, 11 copies: apps/server/src/trips/crew.ts:92,101,112,195; identity.ts:36,63; table.ts:120; dryrun.ts:48; sealing.ts:18,101,112
  - Member form, `const t = h.trip(tripId); h.requireActive(t, memberId); if (status…)`, 5 copies: crew.ts:157-159; table.ts:223-227; dryrun.ts:14-16; sealing.ts:69-71,86-88
  - Phone-only actor check: crew.ts:194 and identity.ts:62
- Evidence: `requireOrganizer` (core.ts:202) already resolves the trip through `memberByToken` → `trips.get`, and then every caller looks it up a second time.
- Suggested fix: add `organizerTrip(tripId, actor, phases?)` and `memberTrip(tripId, memberId, phases?)` to `HelmCore`. Both return the `TripRec` and throw `NOT_ORGANIZER` / `NOT_MEMBER` / `BAD_PHASE` in one place.
- Effort: S
- Scope: apps/server/src/trips
- Acceptance: vitest green (wp14-helm, e2e and identity cover these paths). Grep for `requireOrganizer(` outside core.ts returns 0.

### O2-011 — Timeout wrapper written 5 times; the Gemini one never clears its timer
- Severity: Medium
- Category: Duplication
- Location: apps/server/src/negotiation/gemini.ts:41-44; apps/server/src/payments/orchestrator.ts:202-205, :272-282; apps/server/src/voice/voice.ts:90-97, :117-131; apps/server/src/memory/memory.ts:113-121
- Evidence: gemini.ts does `Promise.race([call, new Promise(r => setTimeout(() => r(null), p.timeoutMs ?? 6000))])` with no `clearTimeout` and no `unref`. Every model line leaves a 6 s timer pending, which also keeps a process that is shutting down alive. The other copies each differ slightly (abort vs race, cleared vs not).
- Suggested fix: add `withTimeout(p, ms, onTimeout?)` and `fetchWithTimeout(url, init, ms)` (AbortSignal.timeout) in `util/`, both clearing and unref'ing, and use them at all five sites.
- Effort: S
- Scope: apps/server/src/util, apps/server/src/negotiation, apps/server/src/payments, apps/server/src/voice, apps/server/src/memory
- Acceptance: a unit test with fake timers checks that `withTimeout` clears its timer when the promise wins. vitest green.

### O2-012 — Strings that must match are copied instead of imported
- Severity: Medium
- Category: Duplication
- Location:
  - apps/server/src/payments/orchestrator.ts:31 (`REASONS.declined`) vs packages/shared/src/constants.ts:96 (`VOID_HEADLINE`)
  - apps/server/src/memory/memory.ts:198-200 (`budgetBand` words) vs apps/server/src/privacy/guard.ts:98 (a regex that hard-codes the same words to scrub them from prompts)
  - "Two charts. Run them dry.": apps/server/src/negotiation/engine.ts:197; apps/server/src/negotiation/phrasing.ts:147,175
- Evidence:
  - The shared constant's comment says it is "byte-for-byte equal to the server's `declined` reason", and the phone's `Voided.tsx` relies on that. The server doesn't import it.
  - If a band word in memory.ts is reworded, the guard stops scrubbing it and the band leaks into Gemini prompts. It is a privacy-relevant coupling with no test.
- Suggested fix:
  - `declined: VOID_HEADLINE`.
  - Export `BUDGET_BANDS` from memory.ts and build the guard regex from it.
  - Add a `DECIDE_RIBBON` constant.
  - Add a test that `withoutAmounts(budgetBand(x))` has no band words for every band.
- Effort: S
- Scope: apps/server/src/payments, apps/server/src/memory, apps/server/src/privacy, apps/server/src/negotiation, apps/server/test
- Acceptance: vitest green, including the new band-scrub test.

### O2-013 — State-reset and turn-append snippets are copy-pasted in trips modules
- Severity: Low
- Category: Duplication
- Location:
  - "Back to BRIEFING + clearCharts + tableReset": apps/server/src/trips/persistence.ts:215-218, :236-238; apps/server/src/trips/table.ts:110-115
  - Negotiation reset object: table.ts:112, :133
  - New Dry Run clock: table.ts:183; sealing.ts:124; dryrun.ts:52,63
  - Build turn → push → `persistTurn` → `toTrip("turn:new")`: table.ts:152-157, :238-245
  - Memory-note loops: sealing.ts:148-170
- Evidence: the blocks match line for line.
- Suggested fix: `backToBriefing(t, reason)`, `newRound(t)`, `startClock(t)` and `appendTurn(t, partial)` in core or table.
- Effort: S
- Scope: apps/server/src/trips
- Acceptance: vitest green (restore, persistence, e2e).

### O2-014 — Small helpers duplicated in the API and realtime layers
- Severity: Low
- Category: Duplication
- Location:
  - `esc`: apps/server/src/api/devAccess.ts:48, apps/server/src/api/http.ts:25
  - `slow`: apps/server/src/realtime/io.ts:100, http.ts:19
  - `MIN = 60_000`: io.ts:65, apps/server/src/api/routes.ts:42
  - "Something went wrong at the helm.": io.ts:115, routes.ts:237
  - Constant-time comparison, three times: util/ids `sameHash`, apps/server/src/trips/identity.ts:77-82 `samePairCode`, devAccess `same`
  - Count-failures limiter, three times: routes.ts:56-64, io.ts:134-144, devAccess.ts:61-64
  - "Member by bearer or 403": apps/server/src/api/passkeyRoutes.ts:35-39, routes.ts:149-150
  - Current booking: apps/server/src/api/debug.ts:42 repeats `sealing.currentBooking`
  - `"member:"` prefix sliced with a literal `7`: apps/server/src/trips/core.ts:80, debug.ts:26
- Evidence: grep.
- Suggested fix: one home each, in `api/http.ts` (esc, slow, INTERNAL copy, bearer guard) and `util/ids.ts` / `util/limits.ts` (`safeEqual`, `FailureLimiter`, `MINUTE`). Add a `memberRoom(id)` / `memberOfRoom(room)` pair.
- Effort: S
- Scope: apps/server/src/api, apps/server/src/realtime, apps/server/src/util, apps/server/src/trips
- Acceptance: vitest green (limits, e2e REST guards, passkeys).

### O2-015 — The name / band / origin form is written three times on the phone
- Severity: Medium
- Category: Duplication
- Location: apps/web/src/phone/screens/Create.tsx:49-61; apps/web/src/phone/screens/JoinCrew.tsx:73-82; apps/web/src/phone/screens/Muster.tsx:166-171 (`AddAbsent`)
- Evidence: all three have the same field markup, `maxLength={24}`, `BandSwatches`, a `<div style={{height:18}}/>` spacer and `OriginSelect`. The default origins differ for no stated reason: ATL, ORD and JFK.
- Suggested fix: one `<CrewMemberFields value onChange takenBands defaultOrigin>` component and a `.spacer` class.
- Effort: M
- Scope: apps/web/src/phone
- Acceptance: vite build passes. Manual check of create, join-by-invite and add-absent.

### O2-016 — The REST action boilerplate is written 7 times, and error copy is applied inconsistently
- Severity: Medium
- Category: Duplication
- Location:
  - The same `busy`/`err`/try/catch/fallback shape: apps/web/src/phone/screens/Create.tsx:38-46; JoinCrew.tsx:58-70; Muster.tsx:105-114, :152-164; apps/web/src/phone/components/organizer.tsx:53-57, :75-86; apps/web/src/phone/screens/Demo.tsx:28-37
  - Raw `e.message` shown: Create.tsx:44, JoinCrew.tsx:66, Muster.tsx:162, Demo.tsx:35, organizer.tsx:56, useRecorder.ts:100
  - `errorCopy` used: TripShell.tsx:64, Muster.tsx:112, organizer.tsx:83
- Evidence:
  - organizer.tsx does it both ways in the same file.
  - Errors are rendered four ways: `MarginNote`, `<p className="small red">`, `<div className="small red" role="alert">`, and a plain `<span>`.
- Suggested fix: add a `useAsyncAction(fn, fallbackCopy)` hook that returns `{busy, err, run}`, always maps errors through `errorCopy`, and renders them with `MarginNote` or `<InlineError>`.
- Effort: M
- Scope: apps/web/src/phone
- Acceptance: grep `e.message` in apps/web/src/phone returns 0. tsc and web vitest pass (add a hook test under O2-067).

### O2-017 — Smaller phone duplicates: tickers, speech fallback, storage JSON, literals
- Severity: Low
- Category: Duplication
- Location:
  - "Tick now every N ms", three copies: apps/web/src/phone/screens/DryRun.tsx:102-118; Seal.tsx:126-141; apps/web/src/phone/components/organizer.tsx:135-144
  - Browser speech fallback, two copies with the same `max(3000, words*420+1500)` cap: apps/web/src/phone/components/voices.ts:92-106; apps/web/src/scene/audio.ts:175-191
  - Hand-rolled local/session storage JSON, five places: apps/web/src/net/session.ts:18-33; Muster.tsx:80-91; organizer.tsx:121-129; apps/web/src/net/api.ts:118,126; apps/web/src/net/passkey.ts:29
    - `session.ts:39,49` write `aa:last` straight to localStorage, bypassing the module's in-memory fallback. In private mode the Landing "Back to voyage" link silently disappears.
    - `aa:unsealedSince:*` keys are never cleaned up.
  - Repeated literals and predicates:
    - `[1,2,3,4] as Band[]`: apps/web/src/phone/components/ui.tsx:62,86
    - "Seal is set": apps/web/src/phone/components/SealRow.tsx:11, Seal.tsx:60
    - Duplicate copy strings: Hail.tsx:66/84; organizer.tsx:26 and errors.ts:22; ui.tsx:56 and GalleryPage.tsx:89
    - `useTrip` and `useCrew` both derive `me`, `isOrganizer` and the "A friend" fallback: apps/web/src/phone/TripContext.tsx:31-43, :94-104
- Evidence: reading the code and grep.
- Suggested fix:
  - A `useNow(intervalMs, active)` hook.
  - A shared `speechCapMs(text)` helper, or have the phone call `speakFallback`.
  - A `net/storage.ts` with `readJSON`/`writeJSON`, a key registry and cleanup.
  - Constants for the copy strings.
  - Build `useTrip` on `useCrew`.
- Effort: S
- Scope: apps/web/src/phone, apps/web/src/net, apps/web/src/scene/audio.ts
- Acceptance: tsc and web vitest pass. A session.test case covers `aa:last` with localStorage throwing.

### O2-018 — Scene builders and the tween-from-to pattern are duplicated
- Severity: Low
- Category: Duplication
- Location:
  - Instanced pin needle and head: apps/web/src/scene/Globe.ts:76-79,143-157; apps/web/src/scene/DryRun.ts:61-62,206-215
  - Paper name flags: Globe.ts:124-130; apps/web/src/scene/CrewPiece.ts:54-61
  - Tag on twine: CrewPiece.ts:178-187; apps/web/src/scene/SealChart.ts:223-237
  - Folded letter: CrewPiece.ts:75-79; SealChart.ts:45-48
  - "Capture start, then `from + (to-from)*t`", about 12 copies: Globe.ts:181-192,241-248; CrewPiece.ts:114-121,218-225; DryRun.ts:357-381; apps/web/src/scene/Instruments.ts:53-54,62-65; SealChart.ts:84-87; apps/web/src/gallery/GalleryApp.ts:59-66
- Evidence: the pin builders differ only in radius (0.0007 vs 0.0006 for the needle, 0.0028 vs 0.0022 for the head). The flag widths use different character-count guesses. `lerp` exists and is unused (O2-002).
- Suggested fix: `pinInstances`, `paperFlag`, `hangingTag` and `foldedLetter` in a `scene/props.ts`, plus `tweens.prop(obj, key, to, ms, ease, key)`. Measure flag width from troika `textRenderInfo`.
- Effort: M
- Scope: apps/web/src/scene, apps/web/src/gallery
- Acceptance: vite build passes. Visual check of the globe, crew pieces and seal chart in the Gallery.

### O2-019 — Server duplication left over from the negotiation and passkey splits
- Severity: Low
- Category: Duplication
- Location:
  - apps/server/src/negotiation/gemini.ts:55-72 (`ADVOCATE_SYSTEM`, `CAPTAIN_SYSTEM` still live here), :15-17 (inline params type duplicating `prompts.ts` `LineRequest`); prompts.ts:10 imports from gemini.ts, so the prompt snapshot tests load `@google/genai`
  - apps/server/src/config.ts:48 `originOf` vs apps/server/src/passkeys/passkeys.ts:53 `originFromUrl` (the same job), plus a different exported `originOf` at passkeys.ts:65
  - apps/server/src/privacy/filter.ts:81 repeats `isNumWord` (:89); apps/server/src/privacy/guard.ts:41 and :85 use near-identical "strip amount" predicates
- Evidence: reading the code and grep.
- Suggested fix:
  - Move the system prompts and types into prompts.ts, so gemini.ts is transport only.
  - Reuse config's helper and rename the passkeys function to `relyingParty()`.
  - Name the shared predicates.
- Effort: S
- Scope: apps/server/src/negotiation, apps/server/src/passkeys, apps/server/src/privacy
- Acceptance: b-prompts snapshot tests pass unchanged.

---

## Too long / too thin

### O2-020 — `apiRouter` (206 lines) and `attachRealtime` (143 lines, with a 101-line connection callback)
- Severity: Medium
- Category: Too long
- Location: apps/server/src/api/routes.ts:35-240; apps/server/src/realtime/io.ts:55-197 (connection handler at :94)
- Evidence: routes.ts mixes trips, crew, headset pairing, hail audio upload and health, plus ten limiter instances. io.ts inlines every event handler, its limits and its field caps.
- Suggested fix:
  - Split into `tripsRouter`, `crewRouter`, `headsetRouter`, `hailAudioRouter` and `healthRouter`, composed in `apiRouter`.
  - In io.ts, a handler table `{ "table:hail": (ctx, p) => … }` with the join handler pulled out, so each handler is testable without a socket.
- Effort: M
- Scope: apps/server/src/api, apps/server/src/realtime
- Acceptance: vitest green (e2e, limits, b-api, contract). No file function is longer than 80 lines.

### O2-021 — Long phone components and store constructor
- Severity: Medium
- Category: Too long
- Location:
  - apps/web/src/phone/screens/Brief.tsx:15-166 (about 150 lines; five `useState`s, three near-identical chip groups at :103-141)
  - apps/web/src/phone/components/Hail.tsx:15-143 (`HailDock`, about 128 lines; four effects, three refs; takes `tripId` and `token` props although it already calls `useCrew()`)
  - apps/web/src/phone/screens/Seal.tsx:19-120 (about 100 lines)
  - apps/web/src/phone/screens/Create.tsx:10-95 (85 lines)
  - apps/web/src/net/tripStore.ts:69-155 (constructor, 86 lines of socket handlers)
- Evidence: line counts.
- Suggested fix:
  - Brief: a `useBriefDraft` hook and a generic `<ChipGroup>`.
  - HailDock: a `useHailSender`, and read the token from context.
  - Seal: pull out `<SealAction>`.
  - Create: pull out `<PortPicker>`.
  - TripStore: move the handlers into a pure `reducers` map, `(state, payload) => Partial<ClientState>`, which is unit-testable without a socket.
- Effort: M
- Scope: apps/web/src/phone, apps/web/src/net
- Acceptance: tsc and web vitest pass, with new reducer tests (O2-067).

### O2-022 — Long server functions: `startTable` (83 lines) and `decideResponse` (61 lines)
- Severity: Low
- Category: Too long
- Location: apps/server/src/trips/table.ts:118-200; apps/server/src/negotiation/rules.ts:85-145
- Evidence: `startTable` inlines the engine callbacks. `decideResponse` is five numbered rules in one function.
- Suggested fix:
  - `startTable`: `engineHooks(t)` with `onDecided` / `onFailed` methods.
  - `decideResponse`: split into `followHail`, `objectToRival`, `answerObjection`, `majority` and `nearlyAsGood`, which also makes them unit-testable (O2-065).
- Effort: S
- Scope: apps/server/src/trips, apps/server/src/negotiation
- Acceptance: the b-prompts "rules decisions unchanged" snapshot passes.

### O2-023 — Long scene functions
- Severity: Low
- Category: Too long
- Location:
  - apps/web/src/scene/audio.ts:58-143 (`SoundBank.play`, 86 lines)
  - apps/web/src/xr/XRApp.ts:44-122 (constructor, 79 lines)
  - apps/web/src/scene/DryRun.ts:247-315 (`buildRoutes`, 69 lines)
  - apps/web/src/scene/SealChart.ts:109-172 (constructor, 64 lines; the `makeText` + `rotation.x=-π/2` + `y=0.0008` block repeats 5 times)
  - apps/web/src/scene/ChartTable.ts:14-75 (`chartTexture`, 62 lines)
  - apps/web/src/scene/Globe.ts:15-73 (`globeTexture`, 59 lines)
- Evidence: line counts.
- Suggested fix:
  - `SoundBank.play`: a table of per-sound recipes.
  - XRApp: `buildHailCard`, `buildMenu` and `wireInput`.
  - SealChart: `buildRow(m)` plus a `flatText` helper.
  - The two texture painters: separate border, rose and cartouche painters.
- Effort: M
- Scope: apps/web/src/scene, apps/web/src/xr
- Acceptance: vite build passes. Visual check in the Gallery.

### O2-024 — Over-thin wrappers and modules
- Severity: Low
- Category: Too thin
- Location:
  - Server:
    - apps/server/src/trips/replay.ts:47 (`Replayer.broadcastState`, one line)
    - apps/server/src/trips/table.ts:66 (`must`, single caller)
    - apps/server/src/negotiation/engine.ts:125 (`plan()` just wraps `planById`)
    - apps/server/src/util/settings.ts (27 lines that duplicate config.ts env parsing: `positive` vs `num` at config.ts:20; its own comment says "these may move there")
  - Web:
    - apps/web/src/scene/SceneDirector.ts:111,113,116 (`hail`, `setCaptionScale`, `speakerPosition` forwarders)
    - apps/web/src/xr/XRApp.ts:198 (`openHailCard`, an alias of `openHail`)
    - apps/web/src/scene/director/SealCeremony.ts:51-53 (`tie` / `voidAll` pass-throughs)
    - SceneDirector.ts:67-77 (a `self` alias plus getters to build the context)
  - The 35 facade forwarders are covered in O2-001.
- Evidence: reading the code.
- Suggested fix:
  - Fold `settings.ts` into `config` as lazy getters, as `config.webauthn` already is.
  - Inline the single-use wrappers.
  - Pass `isResume: () => boolean` instead of aliased getters.
- Effort: S
- Scope: apps/server/src/util, apps/server/src/config.ts, apps/server/src/trips, apps/server/src/negotiation, apps/web/src/scene, apps/web/src/xr
- Acceptance: tsc and vitest on both apps pass.

---

## Inconsistency

### O2-025 — Two sources of truth for HTTP status
- Severity: Medium
- Category: Inconsistency
- Location: apps/server/src/api/routes.ts:23-33 (`HTTP_STATUS` overrides `HelmError.status`); throw sites such as apps/server/src/api/passkeyRoutes.ts:76 (`BAD_BOOKING` thrown with 400, served as 409) and 14 `BAD_PHASE` throws that use the default 400 and are served as 409
- Evidence:
  - The status passed to `new HelmError(code, msg, status)` is ignored whenever the code appears in the map. `OWN_INVITE` and `TOO_FEW` use the default and get remapped.
  - Codes missing from the map (`TOO_MANY_RUNS`, `SEAL_LOCKED`) keep whatever status they were thrown with.
  - Sockets never see a status at all.
- Suggested fix: one `code → status` table next to `HelmError` (util/errors.ts). The constructor takes its status from the table, and the per-site status argument goes away except for 411/413/5xx transport codes.
- Effort: S
- Scope: apps/server/src/util, apps/server/src/api, apps/server/src/trips
- Acceptance: a test asserts that every `new HelmError("X"…)` code in src has a table entry (grep-based). b-api and e2e statuses are unchanged.

### O2-026 — `PASSKEY_REQUIRED` is shown twice and never cleared on the Seal screen
- Severity: Medium
- Category: Inconsistency (user-visible)
- Location: apps/web/src/phone/screens/Seal.tsx:90; apps/web/src/phone/screens/PhaseRoutes.tsx:70-74
- Evidence: Seal reads `state.error?.code === "PASSKEY_REQUIRED"` directly instead of using `useInlineError`, which would consume the error. The error is never cleared, and `PhaseRoutes` also renders it as the page-level banner, so the member sees both the banner and Seal's inline note.
- Suggested fix: `const err = useInlineError(["PASSKEY_REQUIRED"])` in Seal.
- Effort: S
- Scope: apps/web/src/phone/screens
- Acceptance: manual check: cancel the passkey prompt on Seal and see one note, which clears on retry. Add a hook test (O2-067).

### O2-027 — Trips modules reach shared state two ways; the join/pair-code index is maintained three ways
- Severity: Low
- Category: Inconsistency
- Location:
  - The modules take the facade type `TripService` (a type cycle through service.ts)
  - apps/server/src/trips/persistence.ts:152,156 (writes `h.trips` directly)
  - apps/server/src/trips/core.ts:137 (rebuilds the index when the map size changes)
  - apps/server/src/trips/identity.ts:40 (`headsetCode` edits the index directly), :66 (`unpairHeadset` leaves a stale entry for the sweep)
  - apps/server/src/trips/dryrun.ts:36 (`h.pick`, through the facade)
- Evidence:
  - The modules touch core maps directly 75 times (`h.members`, `h.pendingHails`, `h.payments.standing`…).
  - They call siblings through the facade 33 times (`h.trip`, `h.pick`, `h.broadcastState`) and directly 24 times (`h.table.clearCharts`, `h.sealing.currentBooking`).
- Suggested fix:
  - Modules depend on `HelmCore` plus explicit sibling references, never the facade.
  - All index mutations go through `addTrip` / `removeTrip` / `setHeadset`, and the size-change heuristic is removed.
- Effort: M
- Scope: apps/server/src/trips
- Acceptance: tsc shows no import of `./service` from any trips module. vitest green.

### O2-028 — Server naming and style drift
- Severity: Low
- Category: Inconsistency
- Location:
  - `h` means three different things: the TripService in the trips modules, the async wrapper in apps/server/src/api/http.ts:10, and a handoff record in apps/server/src/trips/identity.ts:25
  - apps/server/src/trips/service.ts:40 (persistence is called `store`, next to the `store/` database directory)
  - apps/server/src/api/debug.ts:11 (re-derives `TripRec` instead of importing it)
  - apps/server/src/store/db.ts:20 (storage imports record types from `trips/service`)
  - service.ts:75,78,79,82,84,88 (some forwarders `return` their result, others drop it)
  - Phase sets written out inline instead of using `BOOKING_PHASES`: apps/server/src/trips/sealing.ts:134, apps/server/src/trips/crew.ts:159,173, apps/server/src/api/routes.ts:153
- Evidence: reading the code and grep.
- Suggested fix:
  - Rename to `helm`, `asyncRoute` and `handoff`, and rename the persistence module `archive`.
  - Import record types from `trips/records`.
  - Use `BOOKING_PHASES`.
- Effort: S
- Scope: apps/server/src
- Acceptance: tsc and vitest pass.

### O2-029 — Phone emit guards, inline styles and hard-coded colours
- Severity: Low
- Category: Inconsistency
- Location:
  - apps/web/src/phone/components/organizer.tsx:110 (`CrewDoor` emits `crew:setOpen` with no ack and no guard, so a double tap toggles twice)
  - 37 inline `style={{…}}` objects across 18 files, about 23 of them spacers (e.g. apps/web/src/phone/screens/DryRun.tsx:70,88,130,152,163; Brief.tsx:98,104,115,130,143)
  - Hard-coded paper and ink colours that ignore dark mode: apps/web/src/phone/components/crew.tsx:37, apps/web/src/phone/screens/Table.tsx:159, apps/web/src/styles/phone.css:184
  - apps/web/src/phone/screens/JoinCrew.tsx (the only named-export screen, and not a route)
- Evidence: grep.
- Suggested fix:
  - `useSendGuard(…, {reopenOnOk:true})` for the crew door.
  - `.mt-s`/`.mt-m`/`.spacer` utility classes.
  - Colours from CSS variables or `PALETTE`.
  - Move `JoinCrew` to `components/`.
- Effort: S
- Scope: apps/web/src/phone, apps/web/src/styles
- Acceptance: vite build passes. Visual check in dark mode.

### O2-030 — `SceneDirector` reaches into `PhaseController` internals
- Severity: Low
- Category: Inconsistency
- Location: apps/web/src/scene/SceneDirector.ts:95,96,101,163; apps/web/src/scene/director/PhaseController.ts:66
- Evidence:
  - The director reaches through `phases.backCard` and `phases.seals.sync(...)`, while cloche targets go through `phases.clocheTargets(c)`.
  - The `st()` status closure is duplicated in both files.
- Suggested fix: `PhaseController.targets(c)` and `syncBooking(b, instant)`, with `seals` and `backCard` made private.
- Effort: S
- Scope: apps/web/src/scene
- Acceptance: tsc passes. Gallery replay of a sealing phase looks unchanged.

---

## Magic numbers

### O2-031 — The web app hard-codes limits that live on the server or in shared constants
- Severity: Medium
- Category: Magic numbers
- Location:
  - `maxLength={24}`: apps/web/src/phone/screens/Create.tsx:53, JoinCrew.tsx:74, Muster.tsx:167; server has `NAME_MAX_CHARS`, apps/server/src/util/text.ts:8
  - `maxLength={40}`: Create.tsx:50; server has `TRIP_NAME_MAX_CHARS`, text.ts:10
  - `HAIL_MAX_CHARS = 160`: apps/web/src/phone/components/Hail.tsx:11; a copy of text.ts:12
  - `crew.length < 4`: Muster.tsx:53; JoinCrew uses `MAX_CREW`
  - `crew.length >= 2`: apps/web/src/phone/components/organizer.tsx:18; server has `MIN_TABLE_CREW`, apps/server/src/trips/table.ts:124
  - Watches, `Math.min(3, …)` / `i < 3`: apps/web/src/gallery/GalleryPage.tsx:94, apps/web/src/scene/SceneDirector.ts:156, apps/web/src/scene/Instruments.ts:29,49,61; the phone Table uses `MAX_WATCHES`
  - `DAY_START_MIN = 8*60`: apps/web/src/scene/director/PhaseController.ts:14 duplicates `DRYRUN_DAY_START_MIN`, packages/shared/src/constants.ts:18
  - Day label `"DAY 1"` at Instruments.ts:104 vs `"Day 1"` at PhaseController.ts:154
  - Join code length 6: apps/web/src/phone/screens/Join.tsx:11,17,24
- Evidence: grep. A server-side change to any of these would silently desynchronise the UI.
- Suggested fix: move `NAME_MAX_CHARS`, `TRIP_NAME_MAX_CHARS`, `HAIL_MAX_CHARS`, `MIN_TABLE_CREW` and `JOIN_CODE_LEN` into packages/shared/src/constants.ts, then use them and `MAX_CREW` / `MAX_WATCHES` / `DRYRUN_DAY_START_MIN` everywhere.
- Effort: S
- Scope: packages/shared/src, apps/server/src/util, apps/server/src/trips, apps/web/src
- Acceptance: grep for `maxLength={24}`, `Math.min(3` and `8 * 60` in apps/web/src returns 0. Both tsc runs pass.

### O2-032 — Server limits are scattered across seven places
- Severity: Low
- Category: Magic numbers
- Location:
  - Existing homes for constants: apps/server/src/trips/records.ts:97-132, apps/server/src/util/text.ts, `config.limits`, apps/server/src/util/settings.ts
  - Inline values in apps/server/src/realtime/io.ts:
    - :58, :67-70, :98-99: 64_000; 120/60/20/10 per minute; 64 sockets per IP; 60 per 10 s; 5 per second
    - Field caps 200 / 16 / 64 / 2_000 / 40, and 8 at :161, although `MAX_CREW` is 4. The note cap of 2_000 compares with `NOTE_MAX_CHARS` 200; the hail cap of 2_000 with `HAIL_MAX_CHARS` 160.
  - Other inline values:
    - apps/server/src/api/routes.ts:39,44-53,183: "32kb", ten limiter literals, `Concurrency(2)`, max-age 86400
    - apps/server/src/api/passkeyRoutes.ts:30
    - apps/server/src/api/devAccess.ts:18,20
    - apps/server/src/store/db.ts:107,172
    - apps/server/src/store/writeQueue.ts:46 (250 / 30_000 / 8), :123 (50 rounds)
    - apps/server/src/store/reconnect.ts:15-16
    - apps/server/src/index.ts:36-37,53
    - apps/server/src/trips/persistence.ts:89 (`86_400_000`)
    - apps/server/src/util/limits.ts:45,134,169
- Evidence: grep.
- Suggested fix: one `LIMITS` object in util/limits.ts. Text caps that the client also enforces go to packages/shared (O2-031).
- Effort: M
- Scope: apps/server/src, packages/shared/src
- Acceptance: tsc and vitest pass. limits.test imports from `LIMITS`.

### O2-033 — Negotiation, memory, simulator and dataset literals in code
- Severity: Low
- Category: Magic numbers
- Location:
  - apps/server/src/negotiation/engine.ts:52 (20/35 words), :154-155 (9000/2500/380/400 ms pacing)
  - apps/server/src/negotiation/rules.ts:121 (drop ≤ 25), :140 (−10)
  - apps/server/src/negotiation/prompts.ts:36 (`watch_of_3` instead of `MAX_WATCHES`), :84 (`slice(0, 6)`)
  - apps/server/src/negotiation/gemini.ts:34,43 (300 tokens, 6000 ms)
  - apps/server/src/privacy/context.ts:17 (2000 cents headroom)
  - apps/server/src/privacy/guard.ts:91,98 (200, which is shared `NOTE_MAX_CHARS`)
  - apps/server/src/memory/memory.ts:114,174,152/159/161 (`slice(-5)` ×3), :167/:188 (25 ×2), :199 (80_000 / 130_000 band limits)
  - apps/server/src/payments/sim.ts:9,17 (`newRef(4)` duplicates `REFERENCE_CHARS`; latency 600–1200)
  - apps/server/src/dryrun/walking.ts:8 (`HILLY` lists Lisbon place ids)
  - apps/server/src/negotiation/phrasing.ts:17 (`DEALBREAKER_PHRASE: Record<string>` instead of `FitReason`), :56 (`COMMON_FIRST`)
  - apps/server/src/fit/pricing.ts:253 (`hotel._id.split("-h-")[1]`)
- Evidence: reading the code. A new city would silently get wrong walking times and phrasing.
- Suggested fix:
  - Named constants (`RECALL_LINES`, `BB_PAGE`, `BB_TIMEOUT_MS`, `MODEL_TIMEOUT_MS`, `PACE`).
  - Move `hilly` and an article flag into dataset.json.
  - Type the phrase map on `FitReason`.
- Effort: M
- Scope: apps/server/src/negotiation, apps/server/src/privacy, apps/server/src/memory, apps/server/src/payments, apps/server/src/dryrun, apps/server/src/fit, apps/server/data
- Acceptance: the b-prompts and negotiation snapshots are unchanged.

### O2-034 — Web timings, colours and layout literals
- Severity: Low
- Category: Magic numbers
- Location:
  - Timings (phone):
    - apps/web/src/phone/screens/DryRun.tsx:20 (250 ms)
    - apps/web/src/phone/components/voices.ts:52,99 (1500 ms, 420 ms/word)
    - apps/web/src/phone/components/Hail.tsx:9,12 (10 s, 1500 ms)
    - apps/web/src/phone/components/VoiceNote.tsx:5 (20 s)
    - apps/web/src/phone/components/crew.tsx:52 (1600 ms)
    - apps/web/src/phone/screens/Booked.tsx:92 (2000 ms)
    - apps/web/src/gallery/GalleryPage.tsx:57 (600 ms)
    - apps/web/src/phone/components/organizer.tsx:46 ("10 minutes"), :115,142 (5 s, 120 s)
    - apps/web/src/net/tripStore.ts:75 (1000/2000 ms)
  - Timings (scene):
    - apps/web/src/scene/director/TurnPlayer.ts:101 (260 ms/word) vs apps/web/src/scene/audio.ts:188 (420 ms/word)
    - apps/web/src/scene/SceneDirector.ts:120 and TurnPlayer.ts:114 (two separate 1500 ms literals)
  - Values tied to a constant but not derived from it:
    - apps/web/src/phone/components/BrassDial.tsx:48,106-107 (±50 and the 50_000 tick, not derived from `CAP_STEP_CENTS`)
    - apps/web/src/phone/screens/Brief.tsx:21,55 (`90_000` default cap), :107 (max 9)
  - Colours:
    - `rgba(31,42,68,…)` (`PALETTE.ink`) hard-coded 15 times: apps/web/src/scene/ChartTable.ts, Globe.ts, DryRun.ts, SealChart.ts, CrewPiece.ts
    - apps/web/src/scene/SealChart.ts:33 (`#7e2a21` = `M.waxDark`)
    - apps/web/src/scene/Stage.ts:75 (`0x221c17`, also in apps/web/src/xr/xr.css:2)
  - Layout:
    - Camera target `(0,0.1,0)`: Stage.ts:39, apps/web/src/xr/XRApp.ts:180, apps/web/src/gallery/GalleryApp.ts:10
    - apps/web/src/scene/CityTiles.ts:14 (`CLIP_R = 0.113`, which is `CITY_R - 0.002`)
    - ChartTable.ts:29 (`0.8143`, hand-computed from `COMPASS_POS`)
- Evidence: grep.
- Suggested fix: a `phone/timing.ts`; `inkA(alpha)` and new PALETTE entries (`waxDark`, `room`, `twine`); a `scene/layout.ts` (`TABLE_TARGET`, `CLOCHE_REST`) with the ratios derived; one words-per-ms constant shared by phone and scene.
- Effort: S
- Scope: apps/web/src, packages/shared/src/constants.ts
- Acceptance: tsc and vite build pass. Visual check.

---

## Performance: server

### O2-035 — `payments.bookings` is never evicted and is re-persisted whole on reconnect
- Severity: High
- Category: Performance (memory leak)
- Location: apps/server/src/payments/orchestrator.ts:69 (`bookings = new Map`), :126; apps/server/src/trips/core.ts:253-263 (`evictTrip`); apps/server/src/trips/persistence.ts:110 (re-writes every booking on db reconnect), :137
- Evidence:
  - `evictTrip` deletes members, briefs, `lastHailAt` and `payments.standing`, but grep finds no `bookings.delete` anywhere in src.
  - Every settled booking (about 1–1.5 kB plus seal records) stays until restart, and each Mongo reconnect re-persists all of them.
  - Confirmed by two independent readers. The sweep test covers only BRIEFING idleness (O2-064).
- Suggested fix:
  - Add `payments.forget(tripId)`.
  - Call it from `evictTrip` for final bookings (BOOKED/VOIDED without `needsAttention`). Keep `needsAttention` bookings until resolved.
  - Limit `syncAfterReconnect` to dirty bookings.
- Effort: S
- Scope: apps/server/src/payments, apps/server/src/trips
- Acceptance: a new limits/sweep test runs a voyage to BOOKED, advances past `voyageDoneMs`, and asserts `payments.bookings.size === 0`.

### O2-036 — Each save rewrites the whole ~12 kB trip document, 93% of it the static shortlist
- Severity: Medium
- Category: Performance (Mongo writes)
- Location: apps/server/src/trips/core.ts:124 (`save` → `persist("trips", tripDoc(t))`); apps/server/src/store/db.ts:70 (whole-document `replaceOne`)
- Evidence:
  - The harness shows the trip document at 12,233 B at DRY_RUN, with `shortlistPlans` = 11,100 B.
  - Every vote, clock control, pick, seal outcome, `crew:setOpen` and headset code rewrites about 11.9 kB.
  - Four votes in separate ticks are 4 × 11.9 kB. In one tick they coalesce to 1 write.
- Suggested fix: persist `shortlistPlans` once, as its own document keyed by trip and round, when the table decides, and store only the plan ids on the trip. Alternatively, `$set` changed top-level fields.
- Effort: M
- Scope: apps/server/src/trips, apps/server/src/store
- Acceptance: the harness or test in O2-066 shows the trip document at 1.5 kB or less after the table. The restore and persistence tests pass.

### O2-037 — One Mongo `insertOne` per emit, including private member emits
- Severity: Medium
- Category: Performance (Mongo writes)
- Location: apps/server/src/trips/core.ts:77 (`log()`)
- Evidence: 62 event inserts per voyage (24 during the table), against about 20 trip writes. Private emits (`plan:private`, `seal:private`) store an empty `payloadRedacted` row.
- Suggested fix: buffer events and `insertMany` every 250 ms or every N rows, flushing on `closeDb`. Skip the audit rows for private emits, or store only the event name.
- Effort: S
- Scope: apps/server/src/trips, apps/server/src/store
- Acceptance: the fakeDb counts at most 1 `insertMany` per tick. The debug view still shows events after a restart (b-api test).

### O2-038 — Booking write amplification, and `bookingDoc` has a side effect
- Severity: Medium
- Category: Performance (Mongo writes)
- Location: apps/server/src/payments/orchestrator.ts:365, :397 (`announce` always persists), :406-411; apps/server/src/trips/records.ts:160-164 (`bookingDoc` bumps `b.version`); apps/server/src/trips/core.ts:43; apps/server/src/store/db.ts:163
- Evidence:
  - Persists per booking are 3n+5: 14 for 3 seals, 17 for 4, 23 for 6. For 4 seals, 16 persists coalesce to 10 writes (15 kB).
  - `bookingDoc` is built, and increments the version, even when there is no database, because `persist` returns early only after the document has been built.
- Suggested fix:
  - Make `bookingDoc` pure and bump the version inside the save.
  - Persist in `announce` only when the public status changed, and merge the back-to-back `setBooking` + `announce`.
  - Skip building the document when the db is off.
- Effort: M
- Scope: apps/server/src/payments, apps/server/src/trips, apps/server/src/store
- Acceptance: payments and audit tests pass. A spy shows at most n+3 persists per n-seal booking.

### O2-039 — Boot loads more history than it uses, and strips nulls twice
- Severity: Low
- Category: Performance
- Location: apps/server/src/trips/persistence.ts:128-129, :326 (turns for every round, then filtered to the current round), :117,131,132,134,140,142 (second `stripNulls`); apps/server/src/store/db.ts:187 (first `stripNulls`); apps/server/test/support/fakeDb.ts (`loadWhere` returns nulls, which is why the second pass exists)
- Evidence:
  - Turns for every round are loaded, then dropped in memory.
  - Events are loaded as `DEBUG_ROWS_PER_TRIP × N` sorted globally, so one busy voyage can use up another's share.
- Suggested fix:
  - Filter turns by `round` in the query.
  - Apply the debug-event limit per trip, or load debug rows lazily on `/debug`.
  - Make fakeDb strip nulls like the real loader and drop the second pass.
- Effort: S
- Scope: apps/server/src/trips, apps/server/src/store, apps/server/test/support
- Acceptance: the restore and persistence tests pass.

### O2-040 — `trip:state` resends static data on every broadcast
- Severity: Low
- Category: Performance (payload)
- Location: apps/server/src/trips/replay.ts:30-34
- Evidence: `dateWindows` (127 B) plus `candidateCities` (185 B) are 31% of a 1,019 B state, sent 12 times per voyage to every socket in the room. The total `trip:state` traffic is modest (about 12 kB per voyage).
- Suggested fix: send them in the join/replay state only, and let the client keep them. Alternatively, add a `staticVersion` and omit them when it is unchanged.
- Effort: S
- Scope: apps/server/src/trips, packages/shared/src, apps/web/src/net
- Acceptance: the contract test is updated. The phone and gallery still show dates and ports after a reconnect.

### O2-041 — Memory writes: sequential whole-file rewrites, full re-serialize on Mongo, unbounded recall cache
- Severity: Low
- Category: Performance (I/O, memory)
- Location: apps/server/src/trips/sealing.ts:152,160-169 (awaits `remember` per member in sequence); apps/server/src/util/jsonStore.ts:38 (pretty-printed whole-file rewrite); apps/server/src/memory/memory.ts:68-73 (`mongoLocal.update` re-serializes every thread), :87 (`bbCache`, a plain Map)
- Evidence:
  - `update` takes 0.16 ms with 100 threads, 1.28 ms with 1k and 8.5 ms with 5k, per `remember()`.
  - A 4-member booking rewrites `memory.json` 4 times.
  - `bbCache` checks a 30-minute TTL but never evicts entries; everything else in the server uses `Lru`.
- Suggested fix:
  - `Promise.all` plus a single store update per booking.
  - Drop the `null, 2` indentation.
  - Change the signature to `update(key, fn)` so only that key is written.
  - `bbCache = new Lru(…)`.
- Effort: S
- Scope: apps/server/src/memory, apps/server/src/util, apps/server/src/trips
- Acceptance: the identity and memory tests pass. A spy shows 1 store write per booking.

### O2-042 — Other unbounded maps and non-unref'd timers
- Severity: Low
- Category: Performance (memory)
- Location:
  - apps/server/src/payments/sim.ts:13-15 (`instructions`, `auths` and the idempotency `results` map are never trimmed)
  - apps/server/src/trips/dryrun.ts:33 (auto-pick timer not `unref`'d)
  - apps/server/src/trips/identity.ts:18 (`handoffs` pruned only inside `mintHandoff`)
  - apps/server/src/web.ts:26-46 (CSP string rebuilt on every request)
- Evidence: `sim.ts` grows by about 2 entries per seal per booking (6 for 3 seals, 12 for 6).
- Suggested fix: `Lru` for the SimProvider maps, `unref()`, prune on redeem, and memoize the CSP string per host.
- Effort: S
- Scope: apps/server/src/payments, apps/server/src/trips, apps/server/src/web.ts
- Acceptance: vitest green.

### O2-043 — The chart book spends 62% of its time formatting dates
- Severity: Low
- Category: Performance (CPU)
- Location: apps/server/src/fit/pricing.ts:263-267 (`labelFor`); apps/server/src/trips/table.ts:98 (`datesLabel`, same pattern)
- Evidence: `buildChartBook` takes 1.18 ms. Of that, 736 µs is 24 `toLocaleDateString` calls at about 74 µs each, against 2.8 µs with a cached `Intl.DateTimeFormat`.
- Suggested fix: one module-level `Intl.DateTimeFormat("en-US", {month:"short", timeZone:"UTC"})` in shared `format.ts`, used by both.
- Effort: S
- Scope: apps/server/src/fit, apps/server/src/trips, packages/shared/src
- Acceptance: the b-chartbook snapshot is unchanged, and the bench drops to about 0.45 ms.

### O2-044 — The privacy filter compiles regexes per line and re-scans the same text
- Severity: Low
- Category: Performance (CPU)
- Location: apps/server/src/privacy/filter.ts:200-207 (a name regex per crew name per line), :94 (`extractAmounts` re-normalizes text); apps/server/src/privacy/guard.ts:21-23,40-44,83-86 (up to 3 amount scans per line or hail)
- Evidence: `filterLine` takes 24 µs with 0 names, 30 µs with 3 and 96 µs with 12. The absolute cost is small at 4 crew, so this is Low.
- Suggested fix: cache the compiled name regexes in a `WeakMap<PrivacyContext, RegExp[]>`, and add internal variants that take already-normalized text or precomputed amounts.
- Effort: S
- Scope: apps/server/src/privacy
- Acceptance: the privacy, privacy-bypass and plan-privacy tests pass.

### O2-045 — `evict` scans every socket; the voice cache reads whole mp3s for a duration
- Severity: Low
- Category: Performance
- Location: apps/server/src/realtime/io.ts:85-91; apps/server/src/voice/voice.ts:81
- Evidence:
  - `evict` loops over `io.sockets.sockets` for each removed member.
  - Each voice cache hit reads the full 47–121 kB file, although `mp3DurationMs` needs only the first 4 kB plus the file size.
- Suggested fix: `io.in(\`member:${id}\`).fetchSockets()` / `socketsLeave`. For the voice cache, `stat` plus a 4 kB read, or keep durations in an LRU keyed by cache key.
- Effort: S
- Scope: apps/server/src/realtime, apps/server/src/voice
- Acceptance: the identity (remove member) test and the audio-route test pass.

## Performance: web and 3D

### O2-046 — `PhaseRoutes` and six screens still subscribe to the whole store (OPT-047 is only partly done)
- Severity: Medium
- Category: Performance (React re-renders)
- Location:
  - Whole-state `useTrip()`: apps/web/src/phone/screens/PhaseRoutes.tsx:22, DryRun.tsx:33, Seal.tsx:20, Brief.tsx:16, Booked.tsx:12, Voided.tsx:21, Wait.tsx:15
  - apps/web/src/gallery/GalleryPage.tsx:88 (`Corner`)
  - Table screen: apps/web/src/phone/components/Hail.tsx (`HailDock`, not memo'd, and gets a new inline `onHail` from Table.tsx); `ShipsLog` (re-copies and reverses `turns` and rebuilds every row)
- Evidence: traced for one `turn:new` at AT_TABLE:
  - Components that re-render: `PhaseRoutes`, `Table`, `HailDock`, `ShipsLog` with every `<li>`, and `TopDownChart` when the speaker changes.
  - Every subscriber's selector also runs: 7 selector evaluations.
  - `turn:audioReady`, `plan:votes` and `table:watch` each re-render `PhaseRoutes` and re-match `<Routes>`.
  - In DRY_RUN, every vote, audio or error event re-renders the whole `DryRun` screen, including the `ChartCard` flag filtering.
- Suggested fix:
  - `useTripSelector` for `status`, `connected`, `error`, `me.briefSealed` and `organizerId` in PhaseRoutes and the screens.
  - `memo(HailDock)` plus `useCallback`, and a memo'd `LogRow`.
  - Then delete `useTrip` and the defensive `memo(...)` wrappers.
- Effort: M
- Scope: apps/web/src/phone, apps/web/src/gallery
- Acceptance: React Profiler: a `turn:new` re-renders at most `Table`, `ShipsLog` and one new `LogRow`. grep `useTrip(` returns 0.

### O2-047 — Duplicate 250 ms tickers, an unstable context value, and a storage write during render
- Severity: Low
- Category: Performance (React)
- Location: apps/web/src/phone/screens/DryRun.tsx:20 (`DryRunClock` and `Timeline` each run `useDryrunMinute`); apps/web/src/phone/TripContext.tsx:14 (a new `{store, session}` each render); apps/web/src/phone/components/organizer.tsx:127 (`unsealedSince` writes localStorage during render, every 5 s)
- Evidence:
  - Two 250 ms intervals run at the same time, and `Timeline` re-renders the whole day four times a second.
  - `TripShell` re-renders on every in-trip navigation, so every context consumer re-renders with it.
- Suggested fix: one shared ticker, `useMemo` for the provider value, and move the storage write into an effect.
- Effort: S
- Scope: apps/web/src/phone
- Acceptance: Profiler: one interval, and `Timeline` renders at most once per minute change.

### O2-048 — REST calls have no timeout or abort, and one fetch has no stale-response guard
- Severity: Medium
- Category: Performance / robustness (network)
- Location: apps/web/src/net/api.ts:10 (`call()`); apps/web/src/phone/screens/JoinCrew.tsx:21-25; apps/web/src/phone/screens/Create.tsx:22-28
- Evidence:
  - A request that hangs (for example over venue Wi-Fi) leaves "Set sail", Join and the Seal passkey steps stuck on busy indefinitely.
  - `JoinCrew` sets state from `tripByCode` without an `alive` or abort guard.
  - `Create` checks an `alive` flag but never aborts the request.
- Suggested fix: `call(path, {signal, timeoutMs = 15_000})` using `AbortSignal.any([signal, AbortSignal.timeout(ms)])`, with effects passing an `AbortController`.
- Effort: S
- Scope: apps/web/src/net, apps/web/src/phone
- Acceptance: an api.test case with a never-resolving fetch mock rejects with a TIMEOUT `ApiError`.

### O2-049 — A stale error survives a reconnect; the reconnect delay never grows
- Severity: Low
- Category: Performance / robustness (network)
- Location: apps/web/src/net/tripStore.ts:75, :94-154
- Evidence: nothing clears `error` on `connect`, so an old refusal banner can come back after the replay. The reconnect delay is fixed at 1–2 s with no growth.
- Suggested fix: clear `error` on `connect`, or when a fresh `trip:state` arrives. Use exponential backoff capped at 10 s.
- Effort: S
- Scope: apps/web/src/net
- Acceptance: a tripStore.test case shows the error is cleared after a simulated reconnect.

### O2-050 — Removed crew pieces are never disposed
- Severity: Medium
- Category: Performance (GPU memory leak)
- Location: apps/web/src/scene/director/CrewSeating.ts:28; apps/web/src/scene/CrewPiece.ts:45-68
- Evidence:
  - `piece.group.removeFromParent(); this.pieces.delete(id)` never calls `disposeObject`.
  - Each `CrewPiece` owns a collar torus, pin cylinder, card plane, band-strip plane with a new `MeshBasicMaterial`, hourglass geometries and a troika `Text`.
  - Every roster change (remove member, sail without) leaks all of them. Cloches, the seal chart and ribbons do dispose.
- Suggested fix: `CrewPiece.dispose()`, which removes the piece and calls `disposeObject` while protecting shared resources. Call it here and from `CrewSeating.dispose`.
- Effort: S
- Scope: apps/web/src/scene
- Acceptance: `renderer.info.memory.geometries` returns to its baseline after a member is added and then removed in the Gallery.

### O2-051 — The module-global `tweens` outlives each Stage and holds old scene graphs
- Severity: Medium
- Category: Performance (memory leak) / correctness
- Location: apps/web/src/scene/tween.ts:70; apps/web/src/scene/Stage.ts:113-126; apps/web/src/xr/XRApp.ts:76; `tweens.wait()` in apps/web/src/scene/director/TurnPlayer.ts:105 and `SealChart.voidAll`
- Evidence:
  - `Stage.dispose` never cancels tweens.
  - After an unmount (route change, StrictMode remount), pending `wait()` promises never resolve because no Stage is ticking. The old director's `chain` and its whole scene graph stay reachable.
  - When a new Stage mounts, the old callbacks run against disposed objects.
  - `tweens.speed` (reduce motion) set in XR carries over into the Gallery.
- Suggested fix: give each Stage its own `Tweens`, passed through `DirectorContext`. At minimum, `tweens.clear()` in `Stage.dispose` should resolve all waits and reset `speed`.
- Effort: M
- Scope: apps/web/src/scene, apps/web/src/xr, apps/web/src/gallery
- Acceptance: a tween.test case checks that `clear()` resolves pending waits. A heap snapshot after navigating Gallery → home shows no `SceneDirector` left.

### O2-052 — Voice mp3s keep playing after the director is disposed
- Severity: Medium
- Category: Performance / correctness
- Location: apps/web/src/scene/director/TurnPlayer.ts:119; apps/web/src/scene/SceneDirector.ts:206; apps/web/src/scene/audio.ts:152
- Evidence: `playVoiceAt(...)` returns a `VoiceHandle` that is thrown away. Dispose cancels `speechSynthesis` but not a positional mp3 that is already playing through the shared listener.
- Suggested fix: keep the current handle in `TurnPlayer` and call `stop()` from `TurnPlayer.dispose()`.
- Effort: S
- Scope: apps/web/src/scene
- Acceptance: manual check: leave the Gallery mid-line and the audio stops.

### O2-053 — XR-only objects, RoomEnvironment and globe pins are never disposed
- Severity: Low
- Category: Performance (GPU memory)
- Location: apps/web/src/xr/XRApp.ts:91, :212-218; apps/web/src/scene/Stage.ts:45, :76-78; apps/web/src/gallery/GalleryApp.ts:33; apps/web/src/xr/debugOverlay.ts:42; apps/web/src/scene/Globe.ts:113-140, :167-177; apps/web/src/scene/SceneDirector.ts:145-149
- Evidence:
  - `XRApp.dispose` never frees the hail card, wrist menu, wheel, debug overlay, reticle or ray/dot meshes, and relies on `forceContextLoss`.
  - The `XRInput` instance isn't stored, so its listeners can't be removed.
  - `new RoomEnvironment()` isn't disposed after PMREM.
  - The `store.tap` unsubscribers in GalleryApp and debugOverlay are dropped.
  - `Globe.setPins` never removes pins that disappear, and `setOrigins` rebuilds its `Set` on every changed event.
- Suggested fix:
  - `disposeObject` on these groups.
  - Store `input` and give it a `dispose()`.
  - Dispose the RoomEnvironment right after PMREM.
  - Keep and call the `tap` unsubscribers.
  - Diff the pins and memoise the origins on `trip.crew`.
- Effort: S
- Scope: apps/web/src/xr, apps/web/src/scene, apps/web/src/gallery
- Acceptance: `renderer.info.memory` is stable across two XR sessions.

### O2-054 — Every billboard reads the camera's world position every frame
- Severity: Medium
- Category: Performance (per-frame)
- Location: apps/web/src/scene/Globe.ts:161-164; apps/web/src/scene/CrewPiece.ts:134-137, :211-215; apps/web/src/scene/DryRun.ts:415-419
- Evidence:
  - Each object calls `camera.getWorldPosition()` and then `lookAt`, and both walk the parent chain (6 ancestors per globe pin, about 8 labels per cloche).
  - With 5 crew, 6 pins and the Dry Run open, that is about 30 matrix-chain walks per frame on top of the renderer's own pass. On Quest that is 72–90 Hz × 2 eyes' worth of budget.
  - The same billboard code is written four times.
- Suggested fix: compute the camera position once in `SceneDirector.update` (SceneDirector.ts:192) and pass it down. Share a `billboard(obj, camPos)` helper. Skip the re-aim when the camera moved less than 1 mm.
- Effort: S
- Scope: apps/web/src/scene
- Acceptance: a Chrome performance profile of the Gallery at DRY_RUN shows `updateWorldMatrix` self-time down by at least 50%.

### O2-055 — Plain paper cards get large unique canvases (about 15 MB desktop, 5 MB Quest)
- Severity: Medium
- Category: Performance (GPU memory)
- Location: apps/web/src/scene/materials.ts:223-259 (called from apps/web/src/scene/Buttons.ts:46, apps/web/src/xr/debugOverlay.ts:42, apps/web/src/scene/ChartTable.ts:86, apps/web/src/scene/DryRun.ts:322); materials.ts:141-159 (street plates)
- Evidence:
  - Undrawn cards are cached by size, but each size paints its own canvas at up to 4096 px/m:

    | Card | Canvas | GPU memory |
    |---|---|---|
    | Wrist menu back | 778×1000 | ≈ 4.1 MB |
    | Hail card back | 983×860 | ≈ 4.5 MB |
    | Seal chart | 1024×860 | ≈ 4.7 MB |

  - The `cards` map is never trimmed; ribbons alone can create up to 54 widths.
  - Street plates stay resident after their cloches are disposed: up to 6 × 5.3 MB on desktop.
  - The plate seed is `cityId.charCodeAt(0)*7`, so cities with the same first letter share a plate.
- Suggested fix:
  - Give undrawn cards the shared tiled `M.paper()` texture plus one shared deckle alphaMap.
  - Put a size limit on `cards`.
  - `tex.dispose()` the street plates when the Dry Run clears, and hash the whole `cityId`.
- Effort: M
- Scope: apps/web/src/scene, apps/web/src/xr
- Acceptance: `renderer.info.memory.textures` drops, and the estimated card memory is under 3 MB on desktop.

### O2-056 — Geometry and materials are rebuilt per instance; about 120–185 draw calls
- Severity: Medium
- Category: Performance (draw calls)
- Location:
  - apps/web/src/scene/CrewPiece.ts:45,51,53,65-68 (collar, pin, band strip plus a new material, hourglass; bypasses the `bandInk` cache)
  - apps/web/src/scene/SealChart.ts:24,30,33 (2 seal halves, a ring and an "A" Text per row)
  - apps/web/src/scene/Globe.ts:131,170 (pin ring and rivet per pin)
  - apps/web/src/xr/wristMenu.ts:45 (8 spoke meshes)
  - apps/web/src/scene/ChartTable.ts:149-161 (4 weights × 3 meshes)
- Evidence:
  - Estimated draw calls: AT_TABLE about 120, DRY_RUN about 185, SEALING about 170. Troika Text is about 40–60 of them.
  - troika 0.52 ships `BatchedText`.
- Suggested fix:
  - Module-level shared geometries.
  - A double-sided band-ink material in the cache.
  - Merge the spokes and weights (`mergeGeometries`, or an `InstancedMesh`).
  - `BatchedText` for static labels (seal rows, cloche tags).
- Effort: M
- Scope: apps/web/src/scene, apps/web/src/xr
- Acceptance: `renderer.info.render.calls` at DRY_RUN in the Gallery is 130 or fewer.

### O2-057 — Raycasts every frame: a duplicated target, and tile grounding against the whole tileset
- Severity: Medium
- Category: Performance (per-frame)
- Location: apps/web/src/xr/input.ts:90-93; apps/web/src/scene/SceneDirector.ts:98-99; apps/web/src/scene/CityTiles.ts:71, :94-111
- Evidence:
  - `XRInput.update` raycasts both pointers every frame, even when idle.
  - `captain.tagHit` is a child of `captain.group`, and both are registered as targets. While the tag shows, the tag is cast twice per pointer per frame, and the recursive cast walks the whole Captain (lathe meshes plus troika text).
  - `CityTiles.ground()` casts a recursive ray against the whole photogrammetry group on up to 60 `load-model` events, allocating 4 `Vector3`s each time. The cost grows as tiles stream in, which can cause hitches.
- Suggested fix:
  - Register only `captain.group`.
  - Optionally raycast every other frame while no select is held.
  - Ground against the newly loaded tile scene only, stop after the first grounding at the finest level, and reuse scratch vectors.
- Effort: S
- Scope: apps/web/src/xr, apps/web/src/scene
- Acceptance: a profile of an XR session shows raycast time per frame halved. City tiles still sit on the ground.

### O2-058 — Small per-frame allocations and a double text layout
- Severity: Low
- Category: Performance (per-frame)
- Location: apps/web/src/gallery/GalleryApp.ts:43; apps/web/src/scene/tween.ts:38, :45; apps/web/src/scene/DryRun.ts:392-412; apps/web/src/scene/ChartTable.ts:102-104
- Evidence:
  - The "speaker" camera preset allocates 2 `Vector3`s per frame.
  - `Tweens.update` builds a `done` array and a filtered `running` array every frame.
  - `placeBeads` runs every frame while the clock moves (the `min === lastMin` check never matches a fractional minute) and sets `instanceMatrix.needsUpdate` each time.
  - The caption speaker is laid out twice: `setText` already calls `sync()`, then the colour is set through an `as unknown` cast and `sync()` runs again.
- Suggested fix:
  - Use scratch vectors.
  - Swap-remove in place in `Tweens.update`.
  - Round the minute to 0.1 before comparing, and use a `for` loop in `placeBeads`.
  - Set the colour before `setText`.
- Effort: S
- Scope: apps/web/src/scene, apps/web/src/gallery
- Acceptance: the Chrome allocation timeline in the Gallery is flat while idle.

### O2-059 — The headset preloads a font no 3D text uses
- Severity: Low
- Category: Performance (load)
- Location: apps/web/src/scene/text.ts:8, :36
- Evidence: `headingBold` is used by 0 `makeText` calls, yet `preloadFonts` fetches it and builds its glyphs on the Quest. `display` is used for a single "A".
- Suggested fix: preload only the faces the scene uses, and give `display` a minimal character set.
- Effort: S
- Scope: apps/web/src/scene
- Acceptance: the XR network panel shows no request for `headingBold` before its first use.

---

## Bundle

### O2-060 — The shared chunk is named `labels` because the phone imports a `scene/` module
- Severity: Low
- Category: Bundle / module placement
- Location: apps/web/src/phone/screens/Table.tsx:4 (`import { speakerLabel } from "../../scene/labels"`); apps/web/src/scene/labels.ts
- Evidence: rollup names the shared socket.io + `tripStore` chunk after its first module, so it is called `labels-*.js` (47.4 / 15.1 kB). It holds engine.io and socket.io (125 kB of source), `net/tripStore.ts`, `scene/labels.ts` and `shared-ui/seating.ts`. Nothing is wrong at runtime, but the phone reaching into `scene/` breaks the "phone never imports scene" rule that `shared-ui/` was created for, and it makes bundle attribution misleading.
- Suggested fix: move `labels.ts` (and its test) to `shared-ui/`. Optionally add a `manualChunks` rule `socket.io|engine.io → "socket"` so the socket vendor code gets a content-stable chunk.
- Effort: S
- Scope: apps/web/src/scene, apps/web/src/shared-ui, apps/web/src/phone/screens, apps/web/vite.config.ts
- Acceptance: the build output has a `socket-*.js` chunk and no `labels-*.js`. grep `scene/` in apps/web/src/phone returns 0.

### O2-061 — `npm run check` has no bundle-size guard
- Severity: Low
- Category: Bundle
- Location: package.json:18 (`check`); apps/web/vite.config.ts:38 (`chunkSizeWarningLimit: 800`, which is only a warning)
- Evidence: round-1 OPT-072 asked for a size guard; `check` now chains typecheck, test and build but no size check. The current sizes to lock in are three 636 kB, entry 267 kB, troika 117 kB, Stage 76 kB and TripShell 60 kB.
- Suggested fix: a `scripts/bundle-budget.mjs` that fails when an app chunk grows past its budget by more than 10%, or when any three.js reaches a phone chunk. Chain it into `check`.
- Effort: S
- Scope: scripts/, package.json
- Acceptance: `npm run check` fails when the budget is lowered artificially.

---

## Tests

### O2-062 — Four full-voyage tests spend 11.5 s waiting on real pacing
- Severity: Medium
- Category: Tests (speed)
- Location: apps/server/test/e2e.test.ts:8; apps/server/test/contract.test.ts:11; apps/server/test/plan-privacy.test.ts:8 (all `PACE_SCALE: "0.05"`)
- Evidence:
  - Each line still waits at least 2500 × 0.05 = 125 ms.
  - The four tests take 2,923 / 2,922 / 2,877 / 2,814 ms: 11.5 s of the 21.9 s of total test time, and they set the 8 s wall time.
  - Every other suite uses `PACE_SCALE=0`.
- Suggested fix: `PACE_SCALE=0` for contract and plan-privacy, which don't time hails. For e2e, send the hail when the PROPOSE `turn:new` arrives instead of relying on pacing.
- Effort: S
- Scope: apps/server/test
- Acceptance: each of those tests takes under 500 ms, and the server vitest wall time is under 5 s.

### O2-063 — Fixed sleeps in the payments tests; the same meeting runs three times
- Severity: Low
- Category: Tests (speed)
- Location: apps/server/test/payments.test.ts:26 (`settle()` = 80 ms, used 17 times); apps/server/test/audit.test.ts:36 (used 10 times); apps/server/test/negotiation.test.ts (the no-hail `runMeeting()` runs in 3 separate tests)
- Evidence: the SEC-002 test takes 939 ms, and there are about 2.2 s of fixed sleeps. Fixed sleeps are also a source of flakiness under CI load.
- Suggested fix: await a promise that resolves on the `result` / status event, and share one `runMeeting()` result through `beforeAll`.
- Effort: S
- Scope: apps/server/test
- Acceptance: payments and audit together take under 1 s. No `setTimeout(r, 80)` is left in the tests.

### O2-064 — Server coverage gaps in the sweep, memory notes, write queue and socket budgets
- Severity: Medium
- Category: Tests (coverage)
- Location: apps/server/test/limits.test.ts:285 (the sweep test); apps/server/src/trips/sealing.ts:148-170; apps/server/src/store/writeQueue.ts; apps/server/src/realtime/io.ts:98-99
- Evidence:
  - The sweep test covers only BRIEFING idleness. It does not cover BOOKED/VOIDED past `voyageDoneMs`, `dropHot` after 2 h, `lastHailAt` / pair-index pruning, or bookings. That is how O2-035 slipped through.
  - `writeMemories` for a booked voyage (budget band, liked, conceded) is not asserted; only the voided note is (seal-integrity.test.ts:220).
  - `WriteQueue.retryFailed`, the `syncAfterReconnect` flush, the per-socket 60-per-10 s budget and the connect/concurrency caps have no tests.
  - `checkCharts` is exercised only through the legacy-document path.
- Suggested fix: add these tests. Fake timers are enough for the sweep and the write queue.
- Effort: M
- Scope: apps/server/test
- Acceptance: the new tests pass, and the O2-035 test fails before its fix.

### O2-065 — Coverage gaps in negotiation, pricing, memory and voice logic
- Severity: Medium
- Category: Tests (coverage)
- Location: apps/server/src/negotiation/rules.ts:85 (`decideResponse` rules 3–5); apps/server/src/fit/pricing.ts (the 11 step functions from O2-004); apps/server/src/memory/memory.ts; apps/server/src/voice/voice.ts
- Evidence:
  - The Watch-3 majority, "nearly as good" and hail-"cheaper" rules only run through the scripted Expo meeting.
  - Pricing has no tests for `no_flight`, `date_mismatch`, the hostel dealbreaker, `long_walks`, or `shortlist()` with fewer than 2 plans.
  - Memory: Backboard failure → local fallback, the 60 s back-off, a Mongo load failure, and threads over 25 entries are untested. `page=1&page_size=25` may return the oldest page; worth checking the API's order.
  - Voice: a TTS non-OK response, a timeout, an unwritable cache dir and a cached-mode miss are untested. `transcribe` has no test at all.
- Suggested fix: unit tests for each, with fetch mocks and no network.
- Effort: M
- Scope: apps/server/test
- Acceptance: the new tests pass under the existing setup, which blanks all keys.

### O2-066 — Nothing guards write volume or payload size
- Severity: Low
- Category: Tests (regression guard)
- Location: apps/server/test (new); harness in scratchpad/r2-opt/A/harness.mts
- Evidence: no test pins per-mutation write counts or `trip:state` / replay / trip-document sizes, so regressions in O2-036 to O2-038 and O2-040 would pass unnoticed. Round 1 asked for this (OPT-071); only the `trip:state` size is covered indirectly.
- Suggested fix: port the harness to a vitest test that uses `fakeDb` `state.writes`. Assert at most 1 trip write per vote tick, a trip document of 2 kB or less after O2-036, `trip:state` of 1.6 kB or less in every phase, and event inserts batched.
- Effort: S
- Scope: apps/server/test
- Acceptance: the test passes after the fixes and fails if the shortlist is put back into the trip document.

### O2-067 — Web hooks and client logic untested; no jsdom setup
- Severity: Medium
- Category: Tests (coverage)
- Location:
  - apps/web/package.json:11 (`vitest run src`, node environment)
  - Hooks: `useSendGuard`, `useTripSelector`, `useInlineError`, `useTwoTap` (apps/web/src/phone/**)
  - apps/web/src/net/passkey.ts:24-57; apps/web/src/phone/seatClaims.ts; apps/web/src/phone/screens/Booked.tsx:70-93 (`downloadIcs`); apps/web/src/phone/components/organizer.tsx (`unsealedSince`)
- Evidence:
  - 52 web tests, all pure. No hook is tested: not the send-guard latch or stale acks, not selector caching, not error consumption (which would have caught O2-026).
  - Untested:
    - `approveWithPasskey`'s branch table
    - seat-claim dedupe
    - ICS escaping and date maths
    - `captureDevKey` URL stripping
  - The outbox and `table:failed` cases are duplicated between apps/web/src/net/contract.test.ts:46-94 and apps/web/src/net/tripStore.test.ts:143-196.
- Suggested fix:
  - Add `environment: "jsdom"` and `@testing-library/react` for hook tests.
  - Add pure tests for passkey (mock `api` and the dynamic import), seatClaims and the ICS builder.
  - Merge the duplicated store tests.
  - Once O2-021 lands, add reducer-map tests.
- Effort: M
- Scope: apps/web/src, apps/web/package.json, apps/web/vite.config.ts (test block)
- Acceptance: `npm test --workspace @all-ayes/web` runs the new hook tests in under 3 s.

### O2-068 — Scene and XR pure logic is untested
- Severity: Medium
- Category: Tests (coverage)
- Location: apps/web/src/scene/**, apps/web/src/xr/** (only `scene/copy.test.ts`, `scene/labels.test.ts` and `xr/input.test.ts` exist)
- Evidence: none of the following have tests.
  - Pure functions and small classes:
    - `text.coverText`, which guards against a CDN font fallback on venue Wi-Fi
    - `geo.ts` (`latLngToSphere`, `spinFor`, `metersFrom`, `arcPoints`)
    - `tween.ts` (keyed cancel, `speed`, `wait`; this would cover O2-051)
    - `seats.seatPoint` / `seatMap`
    - `SealCeremony.fmtWindow`
    - `CarriageClock.setMinute`
    - `CompassTimer.setWatch`
    - `DryRunCloche` place clamping
    - `sharedSheet` LRU eviction
  - Director logic that a fake context can drive:
    - `SceneDirector.unchanged`
    - `TurnPlayer` backlog catch-up (`MAX_BACKLOG`)
    - `CrewSeating` removal (this would cover O2-050)
    - `SealCeremony` pressed de-duplication
    - `PhaseController` transitions and `cancelPick`
  - XR:
    - `Placement.canFallback`
    - the `WristMenu` palm-up rule
- Suggested fix: node-environment tests. three.js runs headless for math and scene-graph code, with a stub canvas for `sharedSheet`.
- Effort: M
- Scope: apps/web/src/scene, apps/web/src/xr
- Acceptance: new tests pass in `vitest run src`.

### O2-069 — Stale test comment and duplicated store tests
- Severity: Low
- Category: Tests (hygiene)
- Location: apps/web/src/xr/input.test.ts:2; apps/web/src/net/contract.test.ts:46-94 and apps/web/src/net/tripStore.test.ts:143-196
- Evidence: input.test.ts:2 says "No web test script yet (WP-16)", but `apps/web/package.json:11` defines `"test": "vitest run src"` and the root `test` runs it. The outbox tests exist twice.
- Suggested fix: delete the comment and keep one copy of the outbox and `table:failed` tests.
- Effort: S
- Scope: apps/web/src/xr, apps/web/src/net
- Acceptance: web vitest passes with the same coverage.

---

## Verified fine

**Server**
- Every `ServerToClient` event (17 server-side, 18 including `error` on the client) is both emitted and handled in `tripStore.ts`. The server and web contract tests enforce this. There are no orphan events.
- Round-1 OPT-001 to OPT-003 hold.
- `trip:state` is at most 1.6 kB (7.5 kB in round 1). Votes send `plan:votes`, not a full state. `state()` takes 1.3 µs. Replay takes 0.28 ms with turns capped at 50.
- The write queue coalesces as designed (4 same-tick votes became 1 write) and is ordered per document. Retry and reconnect timers are `unref`'d and cleared on stop.
- Memory recall is cached: Backboard TTL plus in-flight dedupe, and the local store is loaded once. The voice cache uses async fs only, with no `existsSync` per turn, and is pruned by `pruneAudioCache`. The dataset (15.5 kB) is loaded once in 0.9 ms. `buildPrivacyContext` takes 4.7 µs. The privacy filter has no pathological regex: a 600-character glued number-word run takes 34 µs.
- Bounded structures: `debugLog` (400 × 200), `hydrateMisses` (1k), `perTrip` spend (LRU 5k), limiter state (LRU), turn-audio LRU (20k). Payment deadline timers are `unref`'d and cleared on final status.
- Environment variables: every one the server reads is documented in `.env.example`, except platform-set ones (`NODE_ENV`, `RENDER`, `FLY_APP_NAME`, `HOME`/`USER`). The documented `VITE_*` / `API_URL` names are read by vite.config.ts.
- The test setup blanks every paid key and `MONGODB_URI`, gives each file its own `DATA_DIR`/`CACHE_DIR`, and every server listens on port 0. The test-only exports `__memoryTest`, `resetPasskeysForTests` and `resetSpend` are intentional.

**Web**
- Phone routes never load three.js. qrcode and @simplewebauthn/browser are lazy, and every route is lazy. 3d-tiles is loaded only when a tiles key is set. The fonts are self-hosted, with one preload, and all 6 woffs plus `favicon.svg` are referenced. Hidden sourcemaps.
- `useTripSelector` caches correctly, and `useCrew` is memoized. `Table`, `Muster` and the organizer widgets use selectors, and the list rows are memo'd. The OPT-048 dry-run timers stop when paused. `waitForAudio` subscribes instead of polling. `useRecorder` releases the mic.
- The outbox is bounded and expires entries, and it flushes only after the join ack. `turn:new` dedupe and ordering and the server-to-device clock mapping are tested. `api.ts` turns non-JSON error pages into `ApiError`.

**3D**
- No shadow maps; pixel ratio capped at 2; foveation 1; default XR framebuffer scale.
- Segment counts are sane.
- Round-1 fixes OPT-049 to OPT-053 hold: shared sheets and `LOW_TEX`, instanced blocks/pins/beads, the `unchanged()` short-circuit with a roster key, clock strings built only when the slot changes, and a scratch array in `pickTarget`.
- `Stage.dispose` clears the loop, interval, ResizeObserver and `sessionend` listener. Cloches, the seal chart and ribbons dispose through `disposeObject`. `CityTiles` disposes cleanly. `setText` skips unchanged text.
