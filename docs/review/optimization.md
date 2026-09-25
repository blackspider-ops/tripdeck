# All Ayes: code-quality and optimization review (commit befc070)

Read-only review of `packages/shared`, `apps/server` (≈2.4k LOC) and `apps/web` (≈6.5k LOC). No repo files were changed.

**Baseline, verified during the review:** `apps/server` tsc passes, `apps/web` tsc passes, and `npx vitest run` passes 73/73. `npx ts-prune` was run on both tsconfigs. `vite build --outDir /tmp/aa-build-opt` was built into a scratch folder, and its chunks were attributed with a source-map script. Server payloads and timings were measured with a scratch tsx harness (`scratchpad/review/measure.mts`), which drove a real `TripService` through a 4-person crew → table → dry run with PACE_SCALE=0 and no external keys.

## Executive summary

1. **Live bug:** the server's `table:watch` event is ignored by the client. The headset's compass Watch needles and the Gallery's "Watch n/3" never move during a live meeting (OPT-001). One cheap fix, plus a typed socket contract (OPT-062) so this kind of drift can't happen again.
2. **Privacy duplication:** privacy filtering and privacy-sensitive payloads are assembled in several places with different inputs. The service and the engine build two different `PrivacyContext`s (50-plan book vs 12 plans). Hails filter the line but hand-derive the ribbon. `seal:private` is built twice. Merge these into one guard and one builder each (OPT-013, 018).
3. **Server hot paths are not CPU-bound.** `buildChartBook` takes 1.0 ms and `state()` 1.2 µs. The real costs are I/O done per event: a memory recall (Backboard HTTP or sync file read) on every socket join, two sync mp3 writes per turn, whole-document Mongo upserts per turn/seal, and a 7.5 kB `trip:state` of which 87% is the shortlist that `table:decided` already sent.
4. **Headset client:** the biggest risk is procedural canvas textures. The 2048² chart plus the 2048×1024 globe plus per-card 512–1024 px canvases come to roughly 45 MB of GPU memory and about 15k gradient fills painted on the main thread. Per-frame allocation in XR input adds to it. The Stage chunk (774 kB / 217 kB gz, mostly three.js) is already route-split, so the bundle wins are small: vendor chunking, self-hosted fonts, and lazy qrcode/webauthn.
5. **Maintainability:** `TripService` (596 lines), `SceneDirector` (449), `buildPlan` (140) and the `DryRunCloche` constructor (180) should be split. Duplicate helpers should move into single homes: shared `format.ts` and `copy.ts`, a phone `useRecorder`, `scene/seats.ts`, and server `util/text.ts`, `util/rateLimit.ts` and `util/jsonFile.ts`. The web app has no tests, so a reducer/contract test suite is the cheapest safety net.

## Summary by category and impact

| Category | High | Medium | Low | Total |
|---|---|---|---|---|
| Dead code | 1 | 0 | 10 | 11 |
| Duplication | 1 | 5 | 13 | 19 |
| Too long / Too thin | 1 | 3 | 4 | 8 |
| Performance | 2 | 6 | 7 | 15 |
| Bundle | 0 | 2 | 4 | 6 |
| Type safety | 1 | 3 | 2 | 6 |
| Tests | 0 | 3 | 5 | 8 |
| **Total** | **6** | **22** | **45** | **73** |

**Top 10 by value to effort:** OPT-001, OPT-062, OPT-013, OPT-042, OPT-049, OPT-039, OPT-047, OPT-031, OPT-018, OPT-066.

## Measurements

**Bundle** (`vite build`, scratch outDir; sizes are min / gzip):

| Chunk | Size | Main contents (source-map attribution, pre-minify source) |
|---|---|---|
| `Stage` (XR + gallery only) | 774.1 kB / 216.6 kB | three/src 1,284 kB, troika-three-text 191 kB, app scene code 119 kB, bidi-js 44 kB, webgl-sdf-generator 32 kB |
| entry `index-dm6j7MxS` | 266.9 kB / 84.9 kB | react-dom 620 kB, react-router 367 kB |
| `index.plugins` (tiles key only) | 186.3 kB / 57.3 kB | 3d-tiles-renderer plugins barrel |
| `MemoryUtils` (tiles key only) | 65.5 kB / 20.1 kB | three/examples 139 kB, 3d-tiles 37 kB |
| `index-74MU…` (tiles key only) | 93.0 kB / 25.7 kB | 3d-tiles-renderer core |
| `index-B_mM…`, `index-vTTV…`, `index-hFNb…` (tiles key only) | 19.3 + 9.0 + 6.0 kB | fflate, pmtiles, pbf, @mapbox/vector-tile (pulled in by the plugins barrel) |
| `TripShell` | 58.3 kB / 18.7 kB | app phone code 81 kB, @simplewebauthn/browser 26 kB |
| `tripStore` | 45.3 kB / 14.3 kB | socket.io-client + engine.io |
| `XRPage` | 37.2 kB / 10.5 kB | OrbitControls etc. 31 kB, app 31 kB |
| `crew` | 27.2 kB / 10.6 kB | qrcode 71 kB source, loaded on every trip page |

- Phone routes never load three.js (verified: no three sources in TripShell, crew or tripStore).
- `build.sourcemap: true` emits a 2.84 MB `Stage` map that `express.static` serves publicly.
- Bundled fonts under `public/textures/type` total 157 kB. The same families are also fetched from Google Fonts by `index.html`.

**Server** (4 crew, windows W1+W2, 3 ports, rules mode):

| Measurement | Value |
|---|---|
| `buildChartBook` | 100 calls = 100.5 ms → **1.0 ms/call**; 12 plans (max possible 2×3×5 = 30, so `limit = 50` is never reached); book JSON 64.5 kB held per trip |
| `state()` | 1000 calls = 1.2 ms → **1.2 µs/call** |
| `trip:state` in DRY_RUN | **7,555 B**, of which `shortlist` is **6,576 B (87%)**; `dateWindows` 127 B |
| `table:decided` | 6,590 B (the same shortlist again) |
| Shared-room traffic, create → DRY_RUN | 10× `trip:state` = 15,652 B; 10× `turn:new` = 3,739 B; 4× `member:joined` = 404 B (each immediately followed by a `trip:state`) |
| Member rejoin `replay()` | 16 events, 20,374 B |
| TripRec document by end of table | 4,433 B, re-upserted whole on every turn |

**Checked and not an issue:**

- `JSON.stringify` appears only in Gemini prompt building and fetch bodies, never in logging.
- `DEMO_REPLAY` is live code (`features.cached` / `features.gemini`, `/api/health`).
- Canvas textures are never repainted per frame.
- `activeMembers` / `.includes` O(n²) is capped at 4 crew.
- The `debugLog` per trip is bounded at 400 entries, but the map itself is never evicted (see OPT-043).

---

## Dead code

### OPT-001: `table:watch` is emitted but ignored, so live Watch indicators never move
- Category: Dead code
- Impact: High. This is a user-visible bug: the headset compass-rose Watch timer (doc 02 §7.5) and the Gallery corner "Watch n/3" stay at watch 0 for the whole meeting.
- Location: apps/web/src/net/tripStore.ts:88 (`on("table:watch", () => undefined)`); apps/server/src/trips/service.ts:347 (`onWatch` only emits `table:watch`); apps/web/src/scene/SceneDirector.ts:149 (`compass.setWatch(Math.min(3, trip.negotiation.watch))`); apps/web/src/gallery/GalleryPage.tsx:90-94
- Evidence: during AT_TABLE the server emits only `turn:new`, `turn:audioReady` and `table:watch`. No `trip:state` is broadcast until the table ends, so `state.trip.negotiation.watch` on clients stays at the value from `startTable` (0). The phone Table screen is unaffected because it reads `latest.watch` from turns.
- Proposal: handle the event in tripStore: `on("table:watch", (p) => this.state.trip ? { trip: { ...this.state.trip, negotiation: { ...this.state.trip.negotiation, watch: p.watch } } } : undefined)`. Alternatively, drop the event and have `onWatch` call `broadcastState` (heavier; see OPT-042).
- Effort: S
- Scope: apps/web/src/net
- Risk / Acceptance: add a tripStore unit test (OPT-066). Manual check: the gallery corner shows "Watch 1/3" and then "2/3" during a run. tsc and vitest must stay green.

### OPT-002: `xr:placed` is a no-op round trip
- Category: Dead code
- Impact: Low. An extra socket message and a contract entry with no effect.
- Location: packages/shared/src/events.ts:12; apps/server/src/realtime/io.ts:69 (`socket.on("xr:placed", guard(() => undefined))`); apps/web/src/xr/XRApp.ts:47
- Evidence: the server handler body is `undefined`. Nothing is logged and no state changes.
- Proposal: remove it from `ClientToServer`, io.ts and XRApp. If placement telemetry is wanted, route it through `client:log` instead.
- Effort: S
- Scope: packages/shared/src, apps/server/src/realtime, apps/web/src/xr
- Risk / Acceptance: tsc on both apps, e2e test.

### OPT-003: `member:joined` and `brief:received` duplicate the `trip:state` that follows them
- Category: Dead code
- Impact: Low. Wasted events and log/Mongo `events` inserts. Client handlers are no-ops except for taps, and no tap uses them.
- Location: apps/server/src/trips/service.ts:212-213, 275-276; apps/web/src/net/tripStore.ts:85-86
- Evidence: `this.toTrip(..., "member:joined", …); this.broadcastState(t);` appears back to back. The client ignores both events. `GalleryApp` and `debugOverlay` taps only read `turn:new` or the event name.
- Proposal: stop emitting both and remove them from `ServerToClient`, or keep them only if the scene starts animating from them. Remove the no-op `on(...)` lines.
- Effort: S
- Scope: packages/shared/src, apps/server/src/trips, apps/web/src/net
- Risk / Acceptance: the e2e test still passes; if the tests listen for them, grep and update.

### OPT-004: Unused exported symbols and methods
- Category: Dead code
- Impact: Low. Noise that misleads readers (for example, `mentionsNumbers` looks like part of the privacy pipeline).
- Location: packages/shared/src/types.ts:34 (`Option`); apps/server/src/privacy/filter.ts:22,111 (`NUMBER_WORD`, `mentionsNumbers`); apps/server/src/negotiation/engine.ts:245 (`export type { Tag }`); apps/web/src/scene/tween.ts:67 (`busy`), :72 (`lerp`); apps/web/src/phone/components/icons.tsx:92 (`Flag`); apps/web/src/scene/CrewPiece.ts:88 (`setName`); apps/web/src/scene/Instruments.ts:70 (`CompassTimer.reset`); apps/web/src/scene/SceneDirector.ts:439 (`footprint`); apps/server/src/store/db.ts:59 (`flushDb` exported but used only by `closeDb`)
- Evidence: ts-prune reports `mentionsNumbers`, `lerp` and `Flag`. A grep across all workspaces finds zero references outside the defining file for the others.
- Proposal: delete them, and make `flushDb` module-private. Internal-only exports (`TripRec`, `EngineIO`, `usableWindows`…) can stay if tests are expected to import them.
- Effort: S
- Scope: packages/shared/src, apps/server/src, apps/web/src/scene, apps/web/src/phone/components
- Risk / Acceptance: tsc on both apps; `npx ts-prune` shows only "used in module" lines.

### OPT-005: `/api/cities`, `api.cities` and `api.health` are unused by the client, while Create.tsx hard-codes the ports
- Category: Dead code
- Impact: Low. The endpoint exists, yet the dataset is duplicated in the UI (see OPT-060).
- Location: apps/server/src/api/routes.ts:138-140; apps/web/src/net/api.ts:24,60; apps/web/src/phone/screens/Create.tsx:84-88 (`PORTS`), :71 ("Mar 12–16, 2027 · from Atlanta, Chicago, New York")
- Evidence: `grep api.cities` → 0 and `grep api.health` → 0. `/api/health` is still used by render.yaml:9, so keep the route.
- Proposal: either load ports via `api.cities()` in Create (it also returns `notes`) and derive the date label from `/cities` plus date windows, or delete `/cities` and `api.cities`. Delete `api.health` from the client.
- Effort: S
- Scope: apps/web/src/phone/screens, apps/web/src/net, apps/server/src/api
- Risk / Acceptance: create a voyage manually; `vite build`.

### OPT-006: `config.publicBaseUrl` is dead; env vars are read around config; `.env.example` is incomplete
- Category: Dead code
- Impact: Low. There are two sources of truth for the WebAuthn origin, and some env vars are undocumented.
- Location: apps/server/src/config.ts:20; apps/server/src/passkeys/passkeys.ts:24-25; apps/server/src/index.ts:16; apps/server/src/payments/visaVic.ts:15; .env.example
- Evidence: `config.publicBaseUrl` is never read. passkeys reads `process.env.PUBLIC_BASE_URL`, `WEBAUTHN_ORIGIN` and `WEBAUTHN_RP_ID` directly. `.env.example` lacks `DEMO_REPLAY`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, `TRUST_PROXY_HOPS` and `ELEVEN_STT_MODEL`.
- Proposal: add `webauthn: { origin, rpId }`, `trustProxyHops` and `visa` to `config`. Read them only there, and document every key in `.env.example`.
- Effort: S
- Scope: apps/server/src, .env.example
- Risk / Acceptance: vitest (the e2e passkey test); tsc.

### OPT-007: Write-only fields
- Category: Dead code
- Impact: Low. Bytes on the wire and in Mongo, plus reader confusion.
- Location: apps/server/src/trips/service.ts:34-35,356-358 (`negotiation.endedReason`, `advocatedBy`: persisted, never read); apps/server/src/trips/service.ts:266 (`Brief.fromMemory` always `false`); apps/web/src/net/tripStore.ts:18,91 (`audio[…].durationMs` stored, never read); `Turn.redactions` is sent to every client and read nowhere on the web.
- Evidence: grep shows no reads outside assignment, apart from the debug page for `version`.
- Proposal: drop `fromMemory` from `Brief`, `durationMs` from the client state, and `redactions` from the public `Turn` (keep it server-side for the debug log). Keep `advocatedBy`/`endedReason` only if doc 04 requires them for analytics; otherwise delete.
- Effort: S
- Scope: packages/shared/src/types.ts, apps/server/src/trips, apps/web/src/net
- Risk / Acceptance: tsc on both; restore test (old documents may still carry the fields, which is harmless).

### OPT-008: The `DRAFT` trip status is unreachable
- Category: Dead code
- Impact: Low. Five branches are dead.
- Location: packages/shared/src/types.ts:3; apps/web/src/phone/screens/TripShell.tsx:126,236; apps/web/src/phone/screens/Brief.tsx:72; apps/web/src/net/tripStore.ts:75; apps/web/src/gallery/GalleryPage.tsx:13
- Evidence: the server creates trips directly as `BRIEFING` (service.ts:180) and never assigns `DRAFT`.
- Proposal: remove `DRAFT` from `TripStatus` and delete the branches. `Record<TripStatus,…>` maps will flag any stragglers at compile time.
- Effort: S
- Scope: packages/shared/src, apps/web/src
- Risk / Acceptance: tsc on both apps.

### OPT-009: The `visa_sandbox` provider path always falls back to SIM
- Category: Dead code
- Impact: Low. The `mode: "visa_sandbox"` unions and UI copy can't be reached today.
- Location: apps/server/src/payments/visaVic.ts:14-22 (both branches `return null`); apps/server/src/trips/service.ts:69; apps/web/src/phone/screens/Seal.tsx:9-12 (`FOOTER.visa_sandbox`)
- Evidence: `createVisaProvider()` returns `null` unconditionally.
- Proposal: keep it as a documented stub, but make that explicit: `createVisaProvider(): null` with a TODO, or gate it behind a `VISA_ADAPTER_READY` flag. Leave the unions (they're the contract), but add a test asserting that `mode` is `sim` when unconfigured.
- Effort: S
- Scope: apps/server/src/payments
- Risk / Acceptance: payments tests.

### OPT-010: Unused parameters, no-op statements and ignored return values
- Category: Dead code
- Impact: Low.
- Location: apps/server/src/negotiation/engine.ts:108 (`collectHails(_watch)`, called with `watch` / `watch + 1`); apps/server/src/trips/service.ts:447,454 (`const t = this.trip(tripId); … void t;`); service.ts:395,408 (`hail()` returns `m`, which io.ts ignores); service.ts:87 (`toMember` logs with `payload = undefined`); apps/web/src/xr/placement.ts:69,93 (`camera` param, `void camera`)
- Evidence: see the lines listed.
- Proposal: drop the params and `void` statements; replace `const t = this.trip(id)` with `this.trip(id)` as an existence assertion; make `hail` return `void`.
- Effort: S
- Scope: apps/server/src/negotiation, apps/server/src/trips, apps/web/src/xr
- Risk / Acceptance: tsc; vitest.

### OPT-011: Unused CSS and empty directories
- Category: Dead code
- Impact: Low.
- Location: apps/web/src/styles/phone.css (`.smallcaps`, `.tight`); apps/web/src/styles/tokens.css:5-6 (`--band-1..4` and `--graphite` are never referenced; bands use `BANDS[b].hex` inline); apps/web/public/fonts/, apps/web/public/sfx/ and the root scripts/ are empty.
- Evidence: a scripted selector-by-selector grep of .css classes against .ts/.tsx finds only these two classes.
- Proposal: delete them, or switch the inline band colors to `var(--band-N)` so dark mode can tune them.
- Effort: S
- Scope: apps/web/src/styles, apps/web/public, scripts/
- Risk / Acceptance: `vite build`; visual check of phone screens.

---

## Duplication

### OPT-012: Date-window formatting in six places
- Category: Duplication
- Impact: Medium. Six variants of the same "Mar 12–16" logic already disagree: "to" vs "–", with and without the year.
- Location: apps/web/src/phone/screens/Brief.tsx:12-17 (`windowLabel`); apps/web/src/phone/screens/Seal.tsx:95-101 (`windowOf`); apps/web/src/scene/SceneDirector.ts:45-51 (`fmtWindow`); apps/web/src/phone/screens/Booked.tsx:67-71 (`range`); apps/server/src/trips/service.ts:304-309 (`datesLabel`'s `f`); apps/server/src/fit/pricing.ts:214-218 (`labelFor`)
- Evidence: the three client copies are byte-for-byte the same algorithm: `new Date(x + "T12:00:00Z")`, `toLocaleDateString({month:"short", timeZone:"UTC"})`, `getUTCDate()`.
- Proposal: add `packages/shared/src/format.ts` exporting `formatWindow(w, { year?: boolean; sep?: "–" | " to " })` and `formatDayLabel(startDate, offset)`, re-exported from index. Replace all six.
- Effort: S
- Scope: packages/shared/src, apps/web/src/phone/screens, apps/web/src/scene, apps/server/src/trips, apps/server/src/fit
- Risk / Acceptance: add unit tests for `formatWindow` (OPT-068). Negotiation test lines must be unchanged (`openLine` uses `datesLabel`).

### OPT-013: Privacy filtering assembled in three places with different inputs
- Category: Duplication
- Impact: High. It is privacy-critical. The hail filter and the spoken-line filter use different `PrivacyContext`s, and the ribbon logic diverges.
- Location: apps/server/src/trips/service.ts:300 (context from the 50-plan chart book) vs apps/server/src/negotiation/engine.ts:58 (`buildPrivacyContext(ds, crew, plans)` with the 12 plans passed in); engine.ts:150-168 (filters line and ribbon, retries, falls back); service.ts:396-400 (filters the line only, then derives the ribbon by `split/slice(0,8)`); apps/server/src/realtime/io.ts:78-83 (`client:log` writes into `debugLog` without the guard)
- Evidence: `allowedDollars` differ between the two contexts (the 50-plan context allows group totals for plans that were never discussed). The hail ribbon is not run through `filterLine` separately. It is derived from already-filtered text, so it is currently safe, but only by coincidence.
- Proposal: add `privacy/guard.ts` with `sanitizeSpoken({ line, ribbon }, ctx): { line, ribbon, redactions } | null`, used by both `NegotiationEngine.phrase` and `TripService.hail`. Build the context once per table in `startTable`, from the same plan set the engine argues over, and pass it into `NegotiationEngine` (a constructor param instead of rebuilding).
- Effort: M
- Scope: apps/server/src/privacy, apps/server/src/negotiation, apps/server/src/trips
- Risk / Acceptance: privacy tests plus a new hail-privacy test (OPT-070); the e2e "privacy intact" assertion.

### OPT-014: MediaRecorder logic copy-pasted in Hail.tsx and VoiceNote.tsx
- Category: Duplication
- Impact: Medium. About 50 lines of subtle mic-lifecycle code (unmount, permission race, stream release) exist twice and must be fixed twice.
- Location: apps/web/src/phone/components/Hail.tsx:17-37,44-102; apps/web/src/phone/components/VoiceNote.tsx:14-32,37-83
- Evidence: identical refs (`rec`, `chunks`, `timer`, `stream`, `starting`, `unmounted`), an identical unmount cleanup, identical `getUserMedia → new MediaRecorder → ondataavailable/onstop` code and identical `send()` blob building. They differ only in `MAX_MS` (10 s vs 20 s), hold-vs-toggle and copy.
- Proposal: add `phone/components/useRecorder.ts`: `useRecorder({ maxMs, onBlob }) → { supported, phase, start(holdRef?), stop }`, plus `transcribe(tripId, token, blob)` in `net/api.ts`. Both components become thin UIs.
- Effort: M
- Scope: apps/web/src/phone/components, apps/web/src/net
- Risk / Acceptance: manual hold-to-hail and "Say it instead" on a phone (mic released on navigation); `vite build`; tsc.

### OPT-015: Two speech/voice playback stacks; the phone one can hang
- Category: Duplication
- Impact: Medium. The phone `speak()` has no timeout, so if `onend` never fires (hidden tab, no voices), `pump()` stalls forever and every later voice is lost. The scene copy already guards against this.
- Location: apps/web/src/phone/components/voices.ts:77-98 (`playUrl`, `speak`), :63-74 (`waitForAudio` polling 120 ms); apps/web/src/scene/audio.ts:175-192 (`speakFallback` with a timeout cap); apps/web/src/scene/SceneDirector.ts:311-320 (polling 100 ms)
- Evidence: `speakFallback` has `setTimeout(resolve, Math.max(3000, words*420+1500))`; `voices.ts speak()` has no timeout.
- Proposal: move `speakLine(text, { band })` and `waitForAudio(store, turnId, ms)` into a DOM-only module, `src/net/speech.ts` (it must not import three, so phones don't pull in the Stage chunk). Use it from both `voices.ts` and `audio.ts`. Implement `waitForAudio` as a store subscription instead of polling.
- Effort: S
- Scope: apps/web/src/net, apps/web/src/phone/components, apps/web/src/scene
- Risk / Acceptance: phone "Play voices here" with voices off; `vite build`, then verify that TripShell does not import three.

### OPT-016: Seat geometry defined three times
- Category: Duplication
- Impact: Low. In "follow the speaker", the gallery camera will drift from the pieces as soon as someone edits `OTHER_SEATS`.
- Location: apps/web/src/scene/SceneDirector.ts:28-34,206-210; apps/web/src/gallery/GalleryApp.ts:37-43 (copies `CAPTAIN_POS` −0.3/−0.03, `SEAT_R` 0.245 and the seat angles); apps/web/src/phone/screens/Table.tsx:115-121 (the 2D equivalent, with different angles)
- Evidence: `({ 1: [335], 2: [205, 335], 3: [205, 335, 355] })[others.length]` in GalleryApp duplicates `OTHER_SEATS`.
- Proposal: add `scene/seats.ts` exporting `seatAngle(crew, organizerId, memberId)` and `SEAT_R`/`CAPTAIN_POS`. Add `SceneDirector.speakerPosition(turn)` so GalleryApp can call `this.stage.director.speakerPosition(t)` (or read the piece's world position). Table.tsx can import the angle table if the 2D layout should match.
- Effort: S
- Scope: apps/web/src/scene, apps/web/src/gallery, apps/web/src/phone/screens
- Risk / Acceptance: gallery key "3" follows the right piece; `vite build`.

### OPT-017: Speaker and act labels built in three places
- Category: Duplication
- Impact: Low.
- Location: apps/web/src/phone/screens/Table.tsx:22-25 (`who`), :89-91 (`actLabel`); apps/web/src/scene/SceneDirector.ts:36-43 (`speakerLabel`); apps/web/src/gallery/GalleryApp.ts:32-45 (speaker kind switch)
- Evidence: "The Captain" and "`${name}'s mate`" appear in both the phone and the scene.
- Proposal: add `src/net/labels.ts` (no three import) with `speakerName(turn, crew)`, `speakerBand(turn, crew)` and `ACT_VERB`.
- Effort: S
- Scope: apps/web/src/net, apps/web/src/phone/screens, apps/web/src/scene
- Risk / Acceptance: tsc; visual check.

### OPT-018: `seal:private` payload and the A/B public shortlist are built more than once
- Category: Duplication
- Impact: Medium. Both are privacy-boundary payloads. Two builders for `seal:private` risk leaking extra fields in one path.
- Location: apps/server/src/trips/service.ts:486-495 (`sendSealPrivate`) vs :588-590 (the inline copy in `replay`); `[toPublic(ds,a,"A"), toPublic(ds,b,"B")]` at :381, :558 and :578
- Evidence: identical object literal `{ bookingId, amountCents, lines, fits, cardLast4, mode }` in both places.
- Proposal: add private `sealPrivateFor(t, memberId): Promise<SealPrivatePayload | null>` and `publicShortlist(t): PlanPublic[] | undefined` (memoized per `shortlistIds`, which also cuts the repeated `toPublic` in OPT-042). Use them in `emitShortlist`, `state`, `replay`, `pick` and `sendSealPrivate`.
- Effort: S
- Scope: apps/server/src/trips
- Risk / Acceptance: audit test "rejoining phone isn't replayed…"; e2e privacy assertions.

### OPT-019: Text sanitizing, clamps and length limits scattered
- Category: Duplication
- Impact: Medium. Client and server limits disagree. The hail input allows 200 characters but the server keeps 160; the transcript is sliced to 160 in a third place.
- Location: apps/server/src/trips/service.ts:599-601 (`clean`), :170 (40), :201 (24), :396 (160), :400 (8-word ribbon); apps/server/src/api/routes.ts:87 (`slice(0,160)`); apps/server/src/negotiation/phrasing.ts:112 (`split(" ").slice(0,8)`), :142 (`clampRibbon`); apps/web/src/scene/Ribbon.ts:20 (`slice(0,8)`); apps/web/src/phone/components/Hail.tsx:107,136 (200); TripShell.tsx:268, Muster.tsx:94, Create.tsx:40,43 (24/40)
- Evidence: four separate implementations of "max 8 words".
- Proposal: add shared constants `NAME_MAX_CHARS=24`, `TRIP_NAME_MAX_CHARS=40`, `HAIL_MAX_CHARS=160` and `RIBBON_MAX_WORDS=8`. Add `apps/server/src/util/text.ts` with `clean(s, max)` and `clampWords`/`clampRibbon` (moved from phrasing). Clients use the constants for `maxLength`.
- Effort: S
- Scope: packages/shared/src, apps/server/src/util, apps/server/src/trips, apps/server/src/negotiation, apps/server/src/api, apps/web/src
- Risk / Acceptance: negotiation "≤ 8 ribbon words" test; tsc.

### OPT-020: Plan-by-id lookup repeated at least eight times
- Category: Duplication
- Impact: Low. Readability, plus scattered `!` (see OPT-064).
- Location: apps/server/src/trips/service.ts:376,470,488,536,589; apps/server/src/negotiation/engine.ts:116; apps/server/src/negotiation/rules.ts:33-34
- Evidence: `this.chartBook(t).find((p) => p._id === id)` five times in the service.
- Proposal: cache the chart book as `{ list: Plan[]; byId: Map<string, Plan> }` and expose `planOf(t, id)` (throws a `HelmError` when missing). Pass `byId` to rules/engine instead of re-finding.
- Effort: S
- Scope: apps/server/src/trips, apps/server/src/negotiation
- Risk / Acceptance: vitest.

### OPT-021: Backing tallies computed four ways
- Category: Duplication
- Impact: Low.
- Location: apps/server/src/trips/service.ts:603-607 (`tallies`); apps/server/src/negotiation/rules.ts:63-69 (`mostBackedOther`), :117 (`rivalCount`), :142-145 (`consensus`); apps/server/src/negotiation/engine.ts:208 (`backed_by` filter per option)
- Evidence: each builds its own count from `st.backing.values()`.
- Proposal: add `backingCounts(st): Map<planId, n>` in rules.ts and derive `mostBackedOther`, `rivalCount`, `consensus` and `backed_by` from it. Put `tallyVotes(votes)` next to it, or in shared if the client ever recomputes.
- Effort: S
- Scope: apps/server/src/negotiation, apps/server/src/trips
- Risk / Acceptance: negotiation tests (their scripted shape must be identical).

### OPT-022: Crew lookups by linear `find` everywhere
- Category: Duplication
- Impact: Low.
- Location: apps/web/src/phone/TripContext.tsx:33-35 (`crewOf` is recreated every render); apps/web/src/phone/components/SealRow.tsx:9; apps/web/src/scene/SceneDirector.ts:39; apps/web/src/phone/screens/Table.tsx:112-113; server `this.members.get(id)!` at service.ts:264,284,330,395,585
- Evidence: `crew.find((c) => c.memberId === id)` appears in four web files.
- Proposal: in `useTrip`, `useMemo` a `crewById` map keyed on `state.trip?.crew`, and expose `crewOf`/`crewName` from it (stable identities; see OPT-047). On the server, add a `member(id)` helper that throws a `HelmError("NOT_MEMBER")`.
- Effort: S
- Scope: apps/web/src/phone, apps/web/src/scene, apps/server/src/trips
- Risk / Acceptance: tsc; vitest.

### OPT-023: Two ad-hoc rate limiters, and unguarded expensive endpoints
- Category: Duplication
- Impact: Low.
- Location: apps/server/src/api/routes.ts:26-38 (sliding window per IP); apps/server/src/trips/service.ts:63,392-394 (`lastHailAt`, 5000 ms, never pruned); `/trips/:id/hail-audio` (paid STT) and the passkey verify routes have no limiter.
- Evidence: two different implementations and error texts.
- Proposal: add `apps/server/src/util/rateLimit.ts` exporting `slidingWindow({ max, windowMs })` with pruning, used for create, pair, hail-audio (per member) and hails (`HAIL_MIN_INTERVAL_MS` constant).
- Effort: S
- Scope: apps/server/src/util, apps/server/src/api, apps/server/src/trips
- Risk / Acceptance: the e2e "rate limited per IP" test; the audit hail tests.

### OPT-024: JSON file read/write helpers duplicated, with non-atomic writes
- Category: Duplication
- Impact: Low. A crash mid-`writeFileSync` truncates `memory.json` or `backboard-assistants.json`, and `readJson` then silently returns `{}`, which loses every memory.
- Location: apps/server/src/memory/memory.ts:23-25,51,76; apps/server/src/data/loader.ts:10; apps/server/src/config.ts:5-13 (.env parse)
- Evidence: `readJson` is private to memory.ts, and loader re-implements the read.
- Proposal: add `apps/server/src/util/jsonFile.ts` with `readJson<T>(file, fallback)` and `writeJsonAtomic(file, data)` (write to tmp, then rename, async). Use it from memory and loader.
- Effort: S
- Scope: apps/server/src/util, apps/server/src/memory, apps/server/src/data
- Risk / Acceptance: vitest; manual memory write after a booking.

### OPT-025: User-facing copy duplicated across server, phone and scene
- Category: Duplication
- Impact: Low. Copy drifts, and the "Waiting on" grammar already differs.
- Location: "One share didn't clear, so nobody was charged." at apps/server/src/payments/orchestrator.ts:162, apps/web/src/phone/screens/Voided.tsx:17 and apps/web/src/scene/SceneDirector.ts:189. "Waiting on … terms" at SceneDirector.ts:185 (`join(" & ")+"'s"`), Wait.tsx:24 and organizer.tsx:20 (`possessiveList`). Status labels at GalleryPage.tsx:12-15.
- Evidence: see locations.
- Proposal: add `packages/shared/src/copy.ts` with `VOID_HEADLINE`, `waitingOnTerms(names)` (move `possessiveList` there) and `STATUS_LABEL`.
- Effort: S
- Scope: packages/shared/src, apps/web/src, apps/server/src/payments
- Risk / Acceptance: Voided.tsx compares `publicReason !== HEADLINE`, so keep the same string; tsc.

### OPT-026: Interactable lists and hit-filter logic duplicated in XR
- Category: Duplication
- Impact: Low.
- Location: apps/web/src/xr/XRApp.ts:81-85 vs :162-166 (the same three-part target list); apps/web/src/xr/input.ts:61-64 vs :121-129 (`filter(enabled && isShown)` then `find(isAncestor)`)
- Evidence: see locations.
- Proposal: one `private targets()` in XRApp, passed to both inputs. Add `pickTarget(raycaster, targets)` in input.ts, shared by `XRInput.hit` and `MouseInput.pick`. This combines well with OPT-053.
- Effort: S
- Scope: apps/web/src/xr
- Risk / Acceptance: desk mode click on the Captain tag and a cloche; XR pinch.

### OPT-027: Brief.tsx re-implements `useSendGuard`'s error latch
- Category: Duplication
- Impact: Low.
- Location: apps/web/src/phone/screens/Brief.tsx:53-58 vs apps/web/src/phone/TripContext.tsx:51-67
- Evidence: the same "`seenErr` state compared in render" pattern.
- Proposal: extend `useSendGuard` to return `reset()` and a `payload` (the `prev` `sealedAt`), and use it in Brief.
- Effort: S
- Scope: apps/web/src/phone
- Risk / Acceptance: seal, then reseal terms after a void.

### OPT-028: nanoid ref alphabet defined three times
- Category: Duplication
- Impact: Low.
- Location: apps/server/src/util/ids.ts:5; apps/server/src/payments/orchestrator.ts:12; apps/server/src/payments/sim.ts:10
- Evidence: `customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", n)` in all three.
- Proposal: export `newRef(n)` and a `NO_LOOKALIKES` alphabet from util/ids.ts.
- Effort: S
- Scope: apps/server/src/util, apps/server/src/payments
- Risk / Acceptance: payments tests.

### OPT-029: Dataset lookups by `find` scattered, with no index
- Category: Duplication
- Impact: Low. Micro-performance, but most of all readability. `highlights()` sorts with a comparator that does two `find`s per comparison.
- Location: apps/server/src/data/loader.ts:33 (`cityName`); apps/server/src/fit/pricing.ts:73,238-239; apps/server/src/negotiation/phrasing.ts:32,38; apps/server/src/negotiation/rules.ts:60; apps/server/src/dryrun/walking.ts:19; apps/server/src/negotiation/engine.ts:182; apps/server/src/trips/service.ts:306,555
- Evidence: `ds.activities.find((a) => a._id === it.activityId)` sits inside double loops in `offersTag`/`highlights`.
- Proposal: have `loadDataset()` also return a frozen `DatasetIndex { city, hotel, activity, window, override(from,to) }` of maps (cached with the dataset), and replace the `find`s.
- Effort: S
- Scope: apps/server/src/data, apps/server/src/fit, apps/server/src/negotiation, apps/server/src/dryrun, apps/server/src/trips
- Risk / Acceptance: pricing tests are exact to the cent, so outputs must be unchanged.

### OPT-030: `client:log` handler writes directly into `TripService.debugLog`
- Category: Duplication
- Impact: Low. The cap logic is duplicated (`shift()` at 400 vs `slice(-400)`), and io.ts reaches into service internals.
- Location: apps/server/src/realtime/io.ts:78-83 vs apps/server/src/trips/service.ts:90-98
- Evidence: see locations.
- Proposal: add `TripService.clientLog(tripId, surface, level, msg)` that reuses `log()`, and make `debugLog` private (a ring buffer).
- Effort: S
- Scope: apps/server/src/realtime, apps/server/src/trips
- Risk / Acceptance: `/api/debug/:id` still shows client lines.

---

## Too long / Too thin

### OPT-031: `TripService` is a 596-line class with nine responsibilities
- Category: Too long
- Impact: High. It is the main maintainability bottleneck: lifecycle, auth, persistence, restore, engine wiring, dry-run clock, auto-pick timers, payments glue, memory writes and snapshots/replay all live in one class with ten mutable maps.
- Location: apps/server/src/trips/service.ts:55-596
- Evidence: 30+ public and private methods; maps `trips`, `members`, `briefs`, `chartBooks`, `privacy`, `pendingHails`, `lastHailAt`, `debugLog`, `autoPickTimers` and `dryrunClock`.
- Proposal: split into `trips/registry.ts` (records, lookups, auth, `save`/`restore`), `trips/briefs.ts` (`submitBrief`, `validateBrief`, `sailWithout`), `trips/table.ts` (`startTable`, `hail`, engine wiring, privacy ctx), `trips/dryrun.ts` (vote, auto-pick, clock), `trips/sealing.ts` (pick, `setSeal`, `cancelSeal`, retry, `onBookingResult`, `writeMemories`) and `trips/snapshot.ts` (`state`, `replay`, `publicShortlist`, `sealPrivateFor`). Keep `TripService` as a thin facade with the same public method names, so io.ts, routes.ts and the tests don't change.
- Effort: L
- Scope: apps/server/src/trips
- Risk / Acceptance: all 73 vitest tests unchanged; tsc; e2e over the wire.

### OPT-032: `buildPlan` is 140 lines doing seven steps
- Category: Too long
- Impact: Medium. It is the money-critical function and the hardest to review.
- Location: apps/server/src/fit/pricing.ts:72-212
- Evidence: flights → arrivals → group placement → pick placement (with a nested `tryDay` closure) → travel legs and flags → shares, fit and satisfaction → public flags.
- Proposal: extract `arrivalsFor(crew, flights, win)`, `placeGroupMoments(...)`, `placePicks(...)`, `legsAndFlags(days, crew, hotelPt)`, `memberView(m, …)` and `sharedPublicFlags(members)`, each pure and testable. `buildPlan` composes them.
- Effort: M
- Scope: apps/server/src/fit
- Risk / Acceptance: pricing.test.ts (to the cent), negotiation tests, and a JSON snapshot of `buildChartBook` before and after.

### OPT-033: `SceneDirector` (449 lines) mixes state sync, turn playback, phase choreography and seals
- Category: Too long
- Impact: Medium.
- Location: apps/web/src/scene/SceneDirector.ts:53-449
- Evidence: `sync()` 45 lines; `onStatusChange` 40 lines; `animateTurn` 57 lines.
- Proposal: split into `scene/director/TurnPlayer.ts` (`applyTurnInstant`, `animateTurn`, `voice`, ribbon), `PhaseController.ts` (`onStatusChange`, `buildDryRun`, `openSealChart`, `syncSeals`) and `CrewSeating.ts` (`syncCrew` plus seats from OPT-016). `SceneDirector` keeps the queue, `interactables` and `update`.
- Effort: M
- Scope: apps/web/src/scene
- Risk / Acceptance: gallery run-through of a full voyage (resume mid-table, dry run, seal, void→retry); `vite build`.

### OPT-034: `DryRunCloche` constructor is about 180 lines
- Category: Too long
- Impact: Medium.
- Location: apps/web/src/scene/DryRun.ts:61-243
- Evidence: plate, dome, POIs, instanced city, markers, per-member routes and keyframes, and the tag card are all built in one constructor.
- Proposal: private builders `buildBase()`, `buildCity(places)`, `buildMarkers(places)`, `buildRoutes(crew, items) → beads`, `buildTag()`. Move `streetTexture` to materials with caching (OPT-049).
- Effort: M
- Scope: apps/web/src/scene
- Risk / Acceptance: visual check of both cloches; beads walk.

### OPT-035: TripShell.tsx (283 lines) holds four components and routing policy
- Category: Too long
- Impact: Low.
- Location: apps/web/src/phone/screens/TripShell.tsx:124-136 (`allowedScreens`), :207-283 (`JoinCrew`, which is exported but used only here)
- Evidence: see locations.
- Proposal: move `JoinCrew` to `screens/JoinCrew.tsx` and `allowedScreens` to `phone/phase.ts` (pure, unit-tested in OPT-066).
- Effort: S
- Scope: apps/web/src/phone
- Risk / Acceptance: tsc; `vite build`.

### OPT-036: routes.ts inlines a debug HTML page and all the passkey routes
- Category: Too long
- Impact: Low.
- Location: apps/server/src/api/routes.ts:90-124,157-170
- Evidence: a 14-line HTML template string inside the router factory.
- Proposal: add `api/debug.ts` (the debug page plus `devAllowed`) and `api/passkeyRoutes.ts`; routes.ts mounts them.
- Effort: S
- Scope: apps/server/src/api
- Risk / Acceptance: e2e REST guard tests.

### OPT-037: `NegotiationEngine` mixes orchestration with prompt construction
- Category: Too long
- Impact: Low.
- Location: apps/server/src/negotiation/engine.ts:171-225
- Evidence: `advocatePrompt`, `captainPrompt` and `modelChoice` build JSON prompts inline. `recent_lines: []` is a dead field (:187).
- Proposal: move the prompt builders to `negotiation/prompts.ts` (pure functions of facts), which makes them snapshot-testable. `run()` itself is a reasonable length.
- Effort: S
- Scope: apps/server/src/negotiation
- Risk / Acceptance: negotiation tests; add prompt snapshot tests.

### OPT-038: Pointless thin wrappers
- Category: Too thin
- Impact: Low.
- Location: apps/server/src/trips/service.ts:217-219 (`join` → `addMember`), :289 (`memoryFor`); apps/server/src/negotiation/phrasing.ts:23 (`cityOf` = `cityName(ds, p.cityId)`); apps/web/src/xr/XRApp.ts:178-179 (`toggleMenu`, `openHailCard` wrap private methods); apps/server/src/config.ts:57 (`features.cached` vs `config.demoReplay === "cached"` also inlined at :58)
- Evidence: one-line forwarding.
- Proposal: make `openHail` public and drop `openHailCard`. Inline `cityOf` or keep one of the two names. Keep `join` only if it is part of the facade from OPT-031. Use `features.cached()` inside `features.gemini`.
- Effort: S
- Scope: apps/server/src, apps/web/src/xr
- Risk / Acceptance: tsc.

---

## Performance

### OPT-039: Memory recall (network or sync disk) on every member join and replay
- Category: Performance
- Impact: High. Every socket (re)connect of a member phone runs `recall()`. With Backboard configured, that is an HTTP GET (up to 5 s timeout), plus a POST that creates an assistant the first time, before `brief:private` reaches the phone. Without Backboard, it is a sync `readFileSync` + `JSON.parse` of memory.json on the event loop. `startTable` also awaits recall for the whole crew before the Captain can speak.
- Location: apps/server/src/trips/service.ts:289,328,585-586 (`replay` → `memoryFor`); apps/server/src/memory/memory.ts:43-70
- Evidence: `replay()` awaits `this.memoryFor(m)` per member join; `assistantFor` reads backboard-assistants.json synchronously on every call.
- Proposal: in memory.ts, add an in-process `Map<personKey, { at, items }>` cache (TTL of a few minutes, invalidated by `remember`) and an in-memory assistants map loaded once. Make local reads async. In `replay`, send `brief:private` immediately with the cached or empty memory and follow up when recall resolves.
- Effort: S
- Scope: apps/server/src/memory, apps/server/src/trips
- Risk / Acceptance: add a test that recall is called at most once per member across N rejoins (OPT-071); restore and e2e tests.

### OPT-040: Voice synthesis writes each mp3 twice with sync fs, and the audio dir grows without bound
- Category: Performance
- Impact: Medium. Sync `existsSync`/`readFileSync`/`writeFileSync` (twice) per turn blocks the loop, and `.cache/audio/<turnId>.mp3` duplicates bytes already stored under `.cache/tts/<sha>.mp3` forever.
- Location: apps/server/src/voice/voice.ts:34-53; apps/server/src/api/routes.ts:126-131 (`existsSync` then `sendFile`)
- Evidence: `writeFileSync(cached, mp3)` and then `writeFileSync(audioPath(turnId), mp3)`.
- Proposal: keep only the content-addressed tts cache. Store `turnId → sha` in memory (or on the Turn as `audioKey`) and serve `/api/audio/:turnId` by resolving to the sha file. Use `fs/promises`, and let `sendFile`'s own 404 handling replace `existsSync`.
- Effort: S
- Scope: apps/server/src/voice, apps/server/src/api, apps/server/src/trips
- Risk / Acceptance: warm-voice-cache still works; audio plays after reconnect (`replay` sends `audioUrl`).

### OPT-041: Persistence write amplification: whole-document upserts per mutation
- Category: Performance
- Impact: Medium. `save()` re-upserts the entire TripRec, including all turns, on every turn, vote and hail, so bytes written grow O(turns²). Each seal transition persists the booking two or three times (`setSealStatus` plus `setBooking`, and `voidAll` loops). Every emit also inserts an `events` document with no TTL.
- Location: apps/server/src/trips/service.ts:126,335,403,424; apps/server/src/payments/orchestrator.ts:160,216,222; apps/server/src/store/db.ts:40-52; service.ts:97 (`append("events", …)` per emit)
- Evidence: the TripRec is 4,433 B after 10 turns and is written about 12 times during the table. `voidAll` on a 3-seat booking gives 3 `setSealStatus` + 2 `setBooking` = 5 `replaceOne`s for one logical change.
- Proposal: make `persist()` coalescing: mark `(col, _id)` dirty and flush once per microtask/tick (or every 250 ms), keeping the latest document. Move turns to a `turns` collection (append-only insert) and drop them from the TripRec upsert. Add a TTL index on `events.at` (for example 7 days).
- Effort: M
- Scope: apps/server/src/store, apps/server/src/trips, apps/server/src/payments
- Risk / Acceptance: restore test (read turns back from the new collection); `closeDb` must flush dirty documents; payments invariants tests.

### OPT-042: `trip:state` re-sends the whole shortlist on every broadcast after the table
- Category: Performance
- Impact: Medium. 7,555 B per `trip:state` in DRY_RUN, SEALING, BOOKED and VOIDED, of which 6,576 B (87%) is `shortlist` (full `days[]` with per-member travel legs). `table:decided` already delivered it (6,590 B), and replay sends it again.
- Location: apps/server/src/trips/service.ts:549-567 (`shortlist: short.length === 2 ? [toPublic…] : undefined`); apps/web/src/net/tripStore.ts:79
- Evidence: measured with the tsx harness; see Measurements.
- Proposal: replace `shortlist` in `TripState` with `shortlistIds?: [string, string]`, and rely on `table:decided` (live and replay) for the plan bodies. The client keeps `state.shortlist` from `table:decided`. Also memoize `publicShortlist(t)` per `shortlistIds` (OPT-018).
- Effort: S
- Scope: packages/shared/src, apps/server/src/trips, apps/web/src/net
- Risk / Acceptance: add a payload-budget test (`trip:state` < 1.5 kB in every phase; OPT-071); e2e; manual reload mid-dry-run shows both charts.

### OPT-043: Hot in-memory maps never evicted; SIM and passkey stores grow forever
- Category: Performance
- Impact: Medium. A long Expo-day process keeps every voyage's chart book (about 64.5 kB), privacy context, 400-line debug log, dry-run clock and hail timestamps. `SimProvider.results` keeps a promise per idempotency key forever. Passkey `challenges` are stored with `at` but never expire, and `assertions` are only deleted when consumed.
- Location: apps/server/src/trips/service.ts:57-64,412,459; apps/server/src/payments/sim.ts:14-16,34-39; apps/server/src/passkeys/passkeys.ts:15-17,44,65,81
- Evidence: no `delete` for `chartBooks`/`privacy`/`debugLog`/`dryrunClock`/`lastHailAt` outside `startTable`; the challenge `at` is never read.
- Proposal: add `sweep()` every 10 min. Drop hot caches (`chartBooks`, `privacy`, `debugLog`, `dryrunClock`, `pendingHails`) for BOOKED or VOIDED trips idle for more than 2 h, since they can be recomputed lazily. Expire challenges after 5 min and assertions after `exp`. Cap `SimProvider.results` by deleting finished keys after 10 min.
- Effort: S
- Scope: apps/server/src/trips, apps/server/src/payments, apps/server/src/passkeys
- Risk / Acceptance: payments idempotency tests (keep keys long enough); `restore` recomputes the book lazily.

### OPT-044: Linear scans for join codes and headset codes
- Category: Performance
- Impact: Low. O(trips) per `trip:join` by code, per REST by-code lookup and per debug lookup. `pairHeadset` does a SHA-256 plus `timingSafeEqual` for every trip with a headset on every guess.
- Location: apps/server/src/trips/service.ts:134-138,177,251-252; apps/server/src/api/routes.ts:159
- Evidence: `[...this.trips.values()].find(...)` in four places.
- Proposal: keep `byJoinCode: Map<string, tripId>` and `byHeadsetCodeHash: Map<hash, tripId>`. Hash the guess once and do an O(1) lookup, with expiry checked on the hit.
- Effort: S
- Scope: apps/server/src/trips, apps/server/src/api
- Risk / Acceptance: service tests "headset codes are single-use"; e2e pairing limiter.

### OPT-045: Chart book limit and repeated crew mapping
- Category: Performance
- Impact: Low. It is already cheap: 1.0 ms per `buildChartBook`. This is about correctness of intent more than speed.
- Location: apps/server/src/trips/service.ts:298 (`limit 50`), :293,300,305,323,330 (`pricingCrew(t)` built four times in `startTable`; `datesLabel` rebuilds it again and is recomputed per memory write at :544)
- Evidence: at most 30 candidate plans exist (2 windows × 3 cities × 5 hotels); 12 survive for the measured crew.
- Proposal: build `const crew = this.pricingCrew(t)` once per `startTable` and pass it down. Name the limits (`CHART_BOOK_LIMIT`, `TABLE_PLANS = 12`). Compute `datesLabel` once per table and store it on the TripRec.
- Effort: S
- Scope: apps/server/src/trips
- Risk / Acceptance: vitest.

### OPT-046: `mp3DurationMs` scan bound grows with the loop index
- Category: Performance
- Impact: Low. If no frame sync is found, the loop scans the whole buffer instead of 4 kB, and the header math is unreliable.
- Location: apps/server/src/voice/voice.ts:79 (`for (; i < Math.min(buf.length - 4, i + 4096); i++)`)
- Evidence: `i + 4096` is re-evaluated each iteration, so the bound never binds.
- Proposal: `const end = Math.min(buf.length - 4, i + 4096); for (; i < end; i++)`.
- Effort: S
- Scope: apps/server/src/voice
- Risk / Acceptance: add a unit test with a small synthetic buffer.

### OPT-047: Whole-state subscriptions re-render every phone component on every socket event
- Category: Performance
- Impact: Medium. `useTrip()` returns the entire `ClientState` through `useSyncExternalStore`, plus fresh `crewOf`/`crewName` closures each render. Every `turn:new`, `turn:audioReady` (on voiced turns, about 10 per table), `plan:votes` and `seal:status` re-renders PhaseRoutes, the active screen and every `WeighAnchor`/`SailWithout`/`HeadsetCodeCard` instance.
- Location: apps/web/src/phone/TripContext.tsx:28-45; apps/web/src/net/tripStore.ts:160-162
- Evidence: `useTripStore(ctx.store)` returns `state`; the components read only slices.
- Proposal: add `useTripSelector(sel, isEqual?)` (`useSyncExternalStoreWithSelector` from `use-sync-external-store/with-selector`, or a small hand-rolled version) and a memoized `useCrew()`. Convert the organizer widgets, SealRow and Table log to selectors, and `React.memo` the pure children (`ChartCard`, `Row`, `TopDownChart`, `CrewList`).
- Effort: M
- Scope: apps/web/src/phone, apps/web/src/net
- Risk / Acceptance: React Profiler: a `turn:audioReady` should re-render only the Table caption and log; tsc; manual pass through all screens.

### OPT-048: Dry Run screen ticks the whole screen at 4 Hz, with a second 4 Hz timer for a seconds countdown
- Category: Performance
- Impact: Low. It burns battery on phones during the dry run, and keeps ticking when paused or after the day ends.
- Location: apps/web/src/phone/screens/DryRun.tsx:14-20,84-91
- Evidence: `setInterval(() => tick(n+1), 250)` at screen level re-renders the ChartCards, the votes and the timeline. `AutoPickNote` has its own 250 ms interval but displays whole seconds.
- Proposal: move the clock into `<DryRunClock/>` and `<Timeline/>` components that own the interval. Stop the interval when `dryrun.pausedAt` is set or the minute is at `dayEndMin`. Use 1000 ms for `AutoPickNote`.
- Effort: S
- Scope: apps/web/src/phone/screens
- Risk / Acceptance: timeline "now/past" highlighting still advances; the countdown still decrements by 1 s.

### OPT-049: Procedural canvas textures: large GPU memory and main-thread paint hitches on Quest
- Category: Performance
- Impact: High for the headset. Estimated GPU memory with mipmaps: chart 2048² (about 22 MB), globe 2048×1024 (about 11 MB), two street plates at 1024² (about 5.6 MB each), plus one separate canvas per `paperCard` (1024 px default: menu backs, caption strip, dry-run tags; 512 px per button; 768 px per spoken ribbon). All of it is painted synchronously with `paintPaper` (w·h/900 radial gradients plus w·h/600 strokes): about 4.7k gradients and 7k strokes for the chart, about 3.2k and 3.5k for the globe, and about 1.2k and 1.7k per street plate. That happens at Stage construction and again on every entry into DRY_RUN, including after void→retry, because textures are disposed and repainted.
- Location: apps/web/src/scene/ChartTable.ts:12-13; apps/web/src/scene/Globe.ts:14-34; apps/web/src/scene/DryRun.ts:17-18,76,216; apps/web/src/scene/materials.ts:22-46,132-154; apps/web/src/scene/Ribbon.ts:22; apps/web/src/scene/Buttons.ts:22-25,46
- Evidence: the sizes are in the code; the counts come from the formulas in `paintPaper`.
- Proposal: (1) Cache `streetTexture(seed)` and the `paperCard` background textures by `(w,h,px,seed)`, and exclude them from `disposeObject`, as with `paperTex`. (2) Use the single shared 512² `paperTexture()` with UV repeat plus a shared deckle `alphaMap` for cards, instead of a canvas per card; draw only the unique ink (the button border) as a small overlay. (3) Cap the chart and globe at 1024 on Quest (`navigator.xr` present, or `renderer.capabilities.maxTextureSize` heuristics). (4) Optionally pre-bake the chart and globe to webp/KTX2 in `public/textures`.
- Effort: M
- Scope: apps/web/src/scene, apps/web/public/textures
- Risk / Acceptance: the debug overlay FPS during the DRY_RUN transition on Quest (currently expected to drop frames); `renderer.info.memory.textures` before and after; visual parity check.

### OPT-050: Draw-call heavy geometry in cloches and globe
- Category: Performance
- Impact: Low. Estimated from code, not measured; use the debug overlay's `draws` on the headset. Each route leg is its own `Mesh(PlaneGeometry)`, each POI has two or three meshes plus a troika text, each globe pin has five meshes, and each arc is its own `TubeGeometry`.
- Location: apps/web/src/scene/DryRun.ts:138-169,247-256; apps/web/src/scene/Globe.ts:103-131,175-195
- Evidence: 4 crew × about 5 legs × 2 cloches gives about 40 strip meshes, plus 2 × (1 + about 6 POIs) labels.
- Proposal: merge the route strips per cloche into one `BufferGeometry` with vertex colors (`mergeGeometries`), instance the pin needles and heads, and draw pencil arcs as one `LineSegments2`/merged tube per style.
- Effort: M
- Scope: apps/web/src/scene
- Risk / Acceptance: the debug overlay draw count drops; the look is unchanged.

### OPT-051: `SceneDirector.sync()` does work on every store event
- Category: Performance
- Impact: Low.
- Location: apps/web/src/scene/SceneDirector.ts:135-180 (runs for every patch, including `turn:audioReady` and `seal:status`); :173-174 → apps/web/src/scene/ChartTable.ts:95-99 (`speaker.sync()` is called unconditionally, forcing a troika re-layout during BRIEFING); :206-221 (`seatOf(c)` allocates two `Vector3`s per crew per sync); :147 (`captain.rise` → `lookAt` each sync)
- Evidence: `CaptionStrip.set` always sets the color and calls `sync()`, even when the text is unchanged.
- Proposal: short-circuit `CaptionStrip.set` when speaker, text and color are unchanged. Compute seats once per crew-roster change (key: memberIds joined). Guard `rise()` with `if (visible) return` before `copy`/`lookAt`. Early-return from `sync` when `s.trip`, `s.turns`, `s.votes` and `s.booking` are reference-equal to the last sync.
- Effort: S
- Scope: apps/web/src/scene
- Risk / Acceptance: gallery run; captions still update.

### OPT-052: Per-frame string work in the carriage clock
- Category: Performance
- Impact: Low.
- Location: apps/web/src/scene/SceneDirector.ts:434; apps/web/src/scene/Instruments.ts:101-104
- Evidence: every frame runs `label.toUpperCase()` and `coverText()` regex on two strings, then compares them in `setText`.
- Proposal: in `setMinute`, return early when `Math.floor(min/5)` and the label are unchanged (cache the last values).
- Effort: S
- Scope: apps/web/src/scene
- Risk / Acceptance: the clock still ticks.

### OPT-053: XR input allocates target lists and closures every frame
- Category: Performance
- Impact: Medium. GC churn at 72–90 Hz on Quest. `XRInput.update()` calls `getTargets()`, which rebuilds `SceneDirector.interactables` (a new array plus about 6 object literals and closures), the hail card (5) and the menu interactables, then `filter` and `map`, every frame. `MouseInput.pick` allocates a `Vector2` and the target list on every pointermove.
- Location: apps/web/src/xr/input.ts:61-64,91-95,121-126; apps/web/src/scene/SceneDirector.ts:98-114; apps/web/src/scene/Buttons.ts:59-61
- Evidence: the `get interactables()` getter builds a fresh list per call.
- Proposal: cache the interactables in SceneDirector and rebuild only when the cloches or back-card visibility change (a dirty flag set in `buildDryRun`, `clearDryRun` and `onStatusChange`). Cache `PaperMenu.interactables` once. Reuse a scratch `Vector2` in `MouseInput`.
- Effort: S
- Scope: apps/web/src/scene, apps/web/src/xr
- Risk / Acceptance: headset pinch on the Captain tag, cloches and menu; debug overlay FPS.

---

## Bundle

### OPT-054: Stage chunk is 774 kB (217 kB gz); vendor code isn't separately cacheable
- Category: Bundle
- Impact: Medium. It is the cold-load cost for the headset and gallery over venue Wi-Fi. three.js is 1.28 MB of source in that one chunk, and every app-code change invalidates it.
- Location: apps/web/vite.config.ts:18 (`chunkSizeWarningLimit: 2000` hides the warning); every `import * as THREE from "three"` in apps/web/src/scene, xr and gallery
- Evidence: see the bundle table: three/src 1,284 kB, troika 191 kB, app 119 kB.
- Proposal: add `build.rollupOptions.output.manualChunks = { three: ["three"], troika: ["troika-three-text"] }` so the vendor chunks are content-stable across deploys and shared by XRPage and GalleryPage. Lower `chunkSizeWarningLimit` back to about 800 so regressions show up. Named imports (`import { Mesh, … } from "three"`) give little extra with three r170 ESM and are optional.
- Effort: S
- Scope: apps/web/vite.config.ts
- Risk / Acceptance: `vite build` into a scratch outDir. The Stage app chunk should be about 120 kB and the three chunk stable across two builds with an app-only change; XR and gallery still load.

### OPT-055: The 3d-tiles plugins barrel drags in pmtiles, fflate, pbf and vector-tile
- Category: Bundle
- Impact: Low. Only when `VITE_GOOGLE_MAP_TILES_KEY` is set, but then about 380 kB (min) of chunks load, about half of them unused.
- Location: apps/web/src/scene/CityTiles.ts:34 (`import("3d-tiles-renderer/plugins")`)
- Evidence: the `index.plugins` chunk is 186 kB, plus separate fflate/pmtiles/pbf/vector-tile chunks (19 + 9 + 6 kB), plus MemoryUtils at 65 kB.
- Proposal: import only `GoogleCloudAuthPlugin` and `ReorientationPlugin` from their specific subpaths, if the package exposes them (check the `exports` of 3d-tiles-renderer 0.4); otherwise leave as is.
- Effort: S
- Scope: apps/web/src/scene
- Risk / Acceptance: `vite build` with a dummy key; confirm the chunk list shrinks.

### OPT-056: qrcode is loaded on every trip page via `crew.tsx`
- Category: Bundle
- Impact: Low. The `crew` chunk (27 kB / 10.6 kB gz) is needed only on Muster and Demo, but `CrewList` from the same module is imported by TripShell and Wait.
- Location: apps/web/src/phone/components/crew.tsx:2,33-43
- Evidence: source-map attribution: `crew` chunk = qrcode 71 kB source.
- Proposal: move `QR` to `components/QR.tsx` and load `const QRCode = (await import("qrcode")).default` inside the effect.
- Effort: S
- Scope: apps/web/src/phone/components
- Risk / Acceptance: `vite build`; the TripShell chunk graph no longer references qrcode; the QR still renders on Muster.

### OPT-057: @simplewebauthn/browser is bundled into TripShell eagerly
- Category: Bundle
- Impact: Low. About 26 kB of source is loaded for every phone screen but used only at seal time.
- Location: apps/web/src/net/passkey.ts:5; apps/web/src/phone/screens/Seal.tsx:3
- Evidence: source-map attribution of `TripShell`.
- Proposal: `const { startAuthentication, startRegistration, browserSupportsWebAuthn } = await import("@simplewebauthn/browser")` inside `approveWithPasskey`.
- Effort: S
- Scope: apps/web/src/net
- Risk / Acceptance: seal with a passkey on iOS or Android; `vite build`.

### OPT-058: Render-blocking Google Fonts on every route, duplicating the bundled woffs
- Category: Bundle
- Impact: Medium. The first paint of every page, including /xr and /gallery (which draw text with troika from `/textures/type/*.woff`), waits on a third-party CSS request with five families. On bad venue Wi-Fi or offline, phone text falls back to Georgia.
- Location: apps/web/index.html:10-12; apps/web/src/styles/tokens.css:7-11; apps/web/src/scene/text.ts:5-12; apps/web/public/textures/type/ (157 kB of woff)
- Evidence: the same families (Caslon Display/Text, Source Serif 4, Plex Mono, Homemade Apple) come from both sources.
- Proposal: declare `@font-face` in tokens.css pointing at the bundled woffs (add woff2 subsets if possible), with `font-display: swap`. Drop the Google Fonts `<link>` and preconnects. Preload only the body face on phone routes.
- Effort: S
- Scope: apps/web/index.html, apps/web/src/styles, apps/web/public/textures/type
- Risk / Acceptance: Lighthouse FCP before and after; the phone renders fonts offline (DevTools offline after first load).

### OPT-059: Production serving and deploy leftovers
- Category: Bundle
- Impact: Low.
- Location: apps/server/package.json (`start: tsx src/index.ts`, so tsx is a devDependency used in production); Dockerfile (single stage, dev deps and sources in the image); apps/web/vite.config.ts:18 (`sourcemap: true`, maps served publicly by express.static); apps/server/src/index.ts:22 (`maxAge: "1h"` even for hashed `/assets/*`)
- Evidence: see locations.
- Proposal: bundle the server with esbuild or `tsc` into `dist/` and run `node dist/index.js`. Use a multi-stage Dockerfile that runs `npm ci --omit=dev` in the runtime stage. Use `sourcemap: "hidden"` (upload maps elsewhere if needed). Serve `/assets` with `immutable, max-age=31536000` and `index.html` with `no-cache`.
- Effort: M
- Scope: Dockerfile, apps/server/package.json, apps/server/src/index.ts, apps/web/vite.config.ts
- Risk / Acceptance: `docker build` plus smoke test `/api/health`; Render deploy.

---

## Type safety

### OPT-060: Magic numbers and literals duplicating shared constants
- Category: Type safety
- Impact: Medium. Changing a constant silently desyncs behavior and copy.
- Location:
  - `EARLY_START_BEFORE` is exported but unused, while "8am" is hard-coded at apps/server/src/fit/pricing.ts:48,151 (`8 * 60`) and phrasing.ts:17.
  - `DRYRUN_DAY_START_MIN` vs `8 * 60` at apps/web/src/scene/SceneDirector.ts:382, and "08:00" at Instruments.ts:93.
  - `MAX_WATCHES` vs `Math.min(3, …)` at SceneDirector.ts:149 and GalleryPage.tsx:94 ("/3").
  - `MAX_CREW` vs `>= 4` at TripShell.tsx:235, "(4 aboard)" at :246, `< 4` at Muster.tsx:38, and "(4 max)" at service.ts:199.
  - The CAP range text "$300 and $3,000" at service.ts:611.
  - `[1,2,3,4]` band ids at service.ts:203 and ui.tsx:62,86.
  - The origin list at service.ts:205 (instead of `ORIGINS`).
  - The headset TTL `10 * 60_000` plus "10 minutes" at service.ts:246,253 and organizer.tsx:40.
  - The hail interval 5000 at service.ts:393.
  - The sail-without delay 120_000 at organizer.tsx:75.
  - PALETTE hex duplicated at crew.tsx:37 and Table.tsx:145.
  - The Create preset `PORTS` at Create.tsx:84-88.
- Evidence: see locations.
- Proposal: use `clockToMin(EARLY_START_BEFORE)`, `DRYRUN_DAY_START_MIN`, `MAX_WATCHES` and `MAX_CREW`. Add `BAND_IDS`, `HEADSET_CODE_TTL_MS`, `HAIL_MIN_INTERVAL_MS` and `SAIL_WITHOUT_AFTER_MS` to shared constants. Build copy from `formatDollars(CAP_MIN_CENTS)` etc. Use `ORIGINS.includes`. Use `PALETTE.ink`/`PALETTE.paper` for the QR.
- Effort: S
- Scope: packages/shared/src, apps/server/src, apps/web/src
- Risk / Acceptance: pricing and negotiation tests (unchanged outputs); tsc.

### OPT-061: Env config casts are unchecked, and a script mutates config
- Category: Type safety
- Impact: Low.
- Location: apps/server/src/config.ts:26,49 (`as "rules" | "model"`, `as "live" | "cached"`); apps/server/scripts/warm-voice-cache.ts:12-14 (mutates `config.gemini.apiKey`, `demoReplay` and `paceScale`)
- Evidence: `AGENT_DECISIONS=modle` silently means rules mode; any typo in `DEMO_REPLAY` means live.
- Proposal: add an `oneOf(k, allowed, default)` helper that warns on unknown values. Pass overrides to `TripService`/config through an explicit `withConfig({...})` or env instead of mutating the singleton.
- Effort: S
- Scope: apps/server/src/config.ts, apps/server/scripts
- Risk / Acceptance: tsc; run warm-voices with a key.

### OPT-062: The Socket.io contract is untyped on the server
- Category: Type safety
- Impact: High. This is the root cause of OPT-001, OPT-002 and OPT-003. `new Server(http, …)` has no generics; `Bus.trip/member` and `toTrip/toMember` take `event: string, payload: unknown`; io.ts handlers re-declare payload types that already drift from `ClientToServer` (`surface?` is optional on the server, required in the contract; `trip:join` accepts no-surface).
- Location: apps/server/src/realtime/io.ts:15,25-83; apps/server/src/trips/service.ts:42-45,81-89; packages/shared/src/events.ts
- Evidence: `this.toTrip(tripId, "turn:audioReady", {...})` compiles with any event name or payload.
- Proposal: `new Server<ClientToServer, ServerToClient, {}, SocketData>(…)`. Type the Bus as `trip<K extends keyof ServerToClient>(id, ev: K, p: Parameters<ServerToClient[K]>[0])`. Make `PRIVATE_EVENTS` a typed subset and give `toTrip` an `Exclude<keyof ServerToClient, PrivateEvent>` parameter type, so the privacy guard is compile-time as well as runtime. Handlers use `Parameters<ClientToServer[K]>[0]`.
- Effort: M
- Scope: packages/shared/src/events.ts, apps/server/src/realtime, apps/server/src/trips
- Risk / Acceptance: tsc (expect it to surface the drifts); e2e; a contract test (OPT-067).

### OPT-063: `as never` persistence casts and `as unknown as` in the DB layer
- Category: Type safety
- Impact: Medium. Eight casts hide the document shape from the compiler, so a wrong collection/type pair (for example persisting a MemberRec to "briefs") compiles.
- Location: apps/server/src/trips/service.ts:74,126,210,227,238,268,270; apps/server/src/store/db.ts:40-42,56
- Evidence: `persist("members", member as never)`.
- Proposal: in db.ts, add `interface Docs { trips: TripRec; members: MemberRec; briefs: BriefRec; bookings: BookingRec; events: EventDoc }` (types imported from `trips/types.ts`, a new file breaking the cycle). Then `persist<C extends keyof Docs>(col: C, doc: Docs[C])` and `loadAll<C>(col): Promise<Docs[C][]>` through `db.collection<Docs[C]>(col)`.
- Effort: S
- Scope: apps/server/src/store, apps/server/src/trips
- Risk / Acceptance: tsc; restore test.

### OPT-064: Non-null `!` on lookups that can fail
- Category: Type safety
- Impact: Medium. Twenty-six sites. Most are guarded by invariants, but several are reachable from socket input, and when they fail they become an opaque INTERNAL error or a crash in a timer.
- Location:
  - apps/server/src/trips/service.ts:396 (`this.privacy.get(tripId)!`, which exists only if `chartBook()` ran for this process).
  - service.ts:264 (`this.members.get(memberId)!` in `submitBrief`: no check that the member isn't in `removedMemberIds`, so a removed member can still reseal).
  - service.ts:476 (`briefs.get(...)!.capCents`).
  - service.ts:555 (`ds.cities.find(...)!`).
  - apps/server/src/fit/pricing.ts:73,238-239 (`dateWindows.find`/`hotels.find`/`cities.find` `!`).
  - apps/server/src/negotiation/rules.ts:33-34,75,104; apps/server/src/negotiation/engine.ts:116,173,207,217.
  - apps/server/src/payments/orchestrator.ts:67 (`standing.get(...)!`).
- Evidence: see locations.
- Proposal: add `util/must.ts`: `must<T>(v: T | undefined, code: string, msg: string): T` (throws a `HelmError`). Use it at the socket-reachable sites. In `submitBrief`, reject removed members explicitly. In `hail`, lazily build the privacy context (`this.chartBook(t)`) if it is missing.
- Effort: S
- Scope: apps/server/src
- Risk / Acceptance: new tests: a removed member can't submit a brief; hail after restore with no privacy context (OPT-070).

### OPT-065: Client-side casts that a type fix would remove
- Category: Type safety
- Impact: Low.
- Location: apps/web/src/net/passkey.ts:24,32 (`opts as never`); apps/server/src/api/routes.ts:111,121 (`{ response: never }`); apps/web/src/xr/XRApp.ts:110 and apps/web/src/xr/input.ts:45 (`e as unknown as { data: XRInputSource }`); apps/web/src/scene/ChartTable.ts:97 (`speaker as unknown as {color}`, which `troika.d.ts` should declare); apps/web/src/net/tripStore.ts:64-68 (`as never`); apps/web/src/scene/CityTiles.ts:96
- Evidence: see locations.
- Proposal: type the `api.passkey*Options` returns as `PublicKeyCredentialCreationOptionsJSON`/`…RequestOptionsJSON` (type-only import) and the server bodies as `RegistrationResponseJSON`/`AuthenticationResponseJSON`. Add `color` to `troika.d.ts`'s `Text`. Add a small `xrSource(e)` helper typed via three's `XRTargetRaySpace` event map.
- Effort: S
- Scope: apps/web/src/net, apps/web/src/xr, apps/web/src/scene, apps/server/src/api
- Risk / Acceptance: tsc on both.

---

## Tests

### OPT-066: The web app has zero tests; add pure-logic tests with vitest
- Category: Tests
- Impact: Medium. The client reducer holds tricky logic: the "fresh" reset on status regressions, turn dedupe and sort, the dry-run clock skew/pause/resume math and `seal:status` patching. `allowedScreens` decides navigation. None of it is covered, and OPT-001 would have been caught.
- Location: apps/web/src/net/tripStore.ts:71-152; apps/web/src/phone/screens/TripShell.tsx:124-136
- Evidence: no `apps/web/test` and no vitest devDependency in apps/web.
- Proposal: add vitest to apps/web (`environment: "node"`). Extract the `on(...)` bodies into a pure `reduce(state, event, payload, now)` in `net/reducer.ts` that `TripStore` calls. Test: trip:state AT_TABLE→BRIEFING clears turns; duplicate turn:new is ignored and out-of-order turns are sorted; a dryrun:script with `serverNow` skew yields an identical `dryrunMinute`; pause then resume keeps the minute; `table:watch` updates the watch; `allowedScreens` for every status × sealed × organizer.
- Effort: S
- Scope: apps/web/src/net, apps/web/src/phone, apps/web/test, apps/web/package.json
- Risk / Acceptance: `npx vitest run` in apps/web; add to the root `npm test`.

### OPT-067: Event-contract test (server emits vs shared contract vs client handlers)
- Category: Tests
- Impact: Medium. Cheap insurance against the drift class behind OPT-001/002/003.
- Location: packages/shared/src/events.ts; apps/server/src/realtime/io.ts; apps/web/src/net/tripStore.ts
- Evidence: currently one server handler is a no-op and three client handlers are no-ops.
- Proposal: a server test that records every `bus.trip`/`bus.member` event during a full e2e run and asserts each is in `ServerToClient` and none of `PRIVATE_EVENTS` hits the trip bus. A web test asserting that `TripStore` registers a non-noop handler for every `ServerToClient` key, or an explicit allowlist of ignored events.
- Effort: S
- Scope: apps/server/test, apps/web/test
- Risk / Acceptance: vitest in both.

### OPT-068: Shared helpers and input sanitization
- Category: Tests
- Impact: Low.
- Location: packages/shared/src/constants.ts:66-89 (`formatCents`, `formatDollars`, `minToClock`, `clockToMin`); apps/server/src/trips/service.ts:599-619 (`clean`, `validateBrief`)
- Evidence: no direct tests. `formatCents(-5)` gives "-$0.05" and `minToClock(-30)` gives "23:30", but neither is covered.
- Proposal: table-driven tests for `formatCents` (negatives, thousands, cents padding), `minToClock` wrap, `clockToMin("7")`, `formatWindow` (OPT-012), and `validateBrief` (dedupe, unknown tags dropped, `MAX_*` truncation, a note with `<script>` and control characters stripped, a cap outside the range rejected).
- Effort: S
- Scope: apps/server/test (or packages/shared/test)
- Risk / Acceptance: vitest.

### OPT-069: Dataset derivation, travel model and phrasing utilities
- Category: Tests
- Impact: Low.
- Location: apps/server/src/data/loader.ts:8-30 (W2 = W1 +8%, +1 day, rounded to $1); apps/server/src/dryrun/walking.ts:18-42 (the hill factor ×1.4, symmetric overrides, the walk→taxi threshold at 2 km); apps/server/src/negotiation/phrasing.ts:129-142 (`clampWords` sentence cut); apps/server/src/negotiation/rules.ts:54-57 (`parseHail` tags and cheaper)
- Evidence: covered only indirectly through pricing snapshots.
- Proposal: small unit tests per function, including a month-boundary `shiftDay` and an override matched in reverse direction.
- Effort: S
- Scope: apps/server/test
- Risk / Acceptance: vitest.

### OPT-070: Hail privacy path and restore edge cases
- Category: Tests
- Impact: Medium. Hails are the only human-authored text that reaches the shared room, and that path is not covered on its own.
- Location: apps/server/src/trips/service.ts:389-409
- Evidence: the privacy tests cover `filterLine`; the e2e test hails a safe phrase.
- Proposal: tests for these cases. A hail stating a member's cap ("Maya can do 900") is broadcast as the safe fallback with `redactions: 1` and a ribbon without digits. A hail over `HAIL_MAX_CHARS` is truncated. Two hails within 5 s give `SLOW_DOWN`. After `restore()` (Mongo-less: construct the TripService, set state manually), `hail` does not throw on a missing privacy context (see OPT-064). A removed member cannot `submitBrief`.
- Effort: S
- Scope: apps/server/test
- Risk / Acceptance: vitest.

### OPT-071: Payload-budget and I/O-count regression tests
- Category: Tests
- Impact: Low. Locks in OPT-039, OPT-041 and OPT-042.
- Location: apps/server/test (new)
- Evidence: the measurement harness in scratchpad/review/measure.mts already does this.
- Proposal: port the harness into a test. Assert `JSON.stringify(state(t)).length` is below 1,500 B in every phase after OPT-042, that `recall` is called at most once per member for three rejoins (spy), and that `persist` flushes at most once per document per tick (spy on the db module).
- Effort: S
- Scope: apps/server/test
- Risk / Acceptance: vitest.

### OPT-072: The root `npm test` runs only server tests; typecheck and build aren't gated
- Category: Tests
- Impact: Low.
- Location: package.json scripts (`test` runs only the server workspace; `typecheck` exists but isn't chained)
- Evidence: a web type error or a failing `vite build` wouldn't fail `npm test`.
- Proposal: add `"check": "npm run typecheck && npm test --workspaces --if-present && npm run build"` plus a bundle-size guard (for example a script that fails if any non-vendor chunk exceeds 300 kB or the three chunk grows by more than 5%).
- Effort: S
- Scope: package.json, scripts/
- Risk / Acceptance: `npm run check` passes locally.

### OPT-073: REST gating in production mode
- Category: Tests
- Impact: Low.
- Location: apps/server/src/api/routes.ts:16-19,126-136,157-170
- Evidence: the e2e test covers pairing and passkeys, but not `devAllowed` with `NODE_ENV=production` or the `/audio/:turnId` path sanitization.
- Proposal: tests with `config.production = true` and no or wrong `DEV_KEY` (`/demo/seed` → 403, `/debug/:id` → 403, the right key → 200), and `/api/audio/..%2F..%2Fetc` → 404 (`audioPath` strips non `[A-Za-z0-9_-]` characters).
- Effort: S
- Scope: apps/server/test
- Risk / Acceptance: vitest.
