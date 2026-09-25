# Trace 2: Headset (WebXR + laptop fallback) and Gallery → net layer, plus server → scene return path

Repo `/Users/tejas/Downloads/untitled folder 3` (befc070). Read-only review. Nothing in the repo was edited.

**How it was verified**
- Static trace of `apps/web/src/{xr,gallery,scene,net}` against `packages/shared/src/{types,events}.ts`, `apps/server/src/realtime/io.ts` and `apps/server/src/trips/service.ts`.
- Live socket drive, script `scratchpad/tr2-drive.mjs` with log `scratchpad/tr2-drive.log`, on voyage KJJX2A. It paired over REST, then connected four sockets: headset (device token), Gallery, Maya's phone and Rae's phone. It sent every forbidden event from the headset, ran a full table, hailed, paused and resumed the clock, picked, voided (Maya `seal:cancel`), retried and booked. Three more headset sockets joined late (in DRY_RUN, VOIDED and BOOKED) to capture what the server replays.
- Live browser run on voyage CHSMNN. The pairing form at `/xr` was used with the value typed as `cv-2stf`. After that the laptop view at `/t/CHSMNN/xr` and the Gallery at `/t/CHSMNN/gallery` were tested with real `PointerEvent`s on the canvas, the `MouseInput` pick path, and JS calls through `window.__aa`. Tabs are closed and the test session was removed from localStorage.

Legend: ✅ works end to end · ⚠ works, with a UX or edge issue · ❌ broken

## A. Inventory: client → server

| # | Surface (file:line) | Element / gesture | Handler chain | Calls (api/emit) | Args (names+types) | Expected signature | Match? | Allowed for device token? | Issues |
|---|---|---|---|---|---|---|---|---|---|
| 1 | xr/PairPage.tsx:36-47 | Code input | onChange → strip `[^a-z0-9]`, take 6 chars, uppercase | – | – | 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (util/ids.ts:5) | ✅ (live: `cv-2stf`→`CV2STF`) | n/a | – |
| 2 | xr/PairPage.tsx:14-28,49 | "Pair this headset" submit | submit → `api.pairHeadset(c)` → `saveSession({tripId,joinCode,deviceToken})` → nav `/t/:joinCode/xr` | `POST /api/xr/pair` (api.ts:45) | `{code: string}` | routes.ts:75 `{code}` → `{tripId, joinCode, deviceToken}` | ✅ (live; a second pair with the same code → 403 BAD_CODE, single use) | public route | TR2-010, TR2-011 |
| 3 | xr/XRPage.tsx:61 | "Enter a headset code" link (no session) | `<Link to="/xr">` | – | – | – | ✅ | n/a | – |
| 4 | xr/XRPage.tsx:99 → XRApp.ts:127 | "Enter the chart room" (Quest) | `enter("ar")` → `sound.unlock()` → `app.enterAR()` → `requestSession("immersive-ar", local-floor + optional)` → `placement.start` | – | – | doc 04 §9.1 | ✅ (code matches spec; no Quest to test) | n/a | – |
| 5 | xr/XRPage.tsx:100,106 → XRApp.ts:151 | "Laptop view" / "Open the chart room" | `enter("desk")` → unlock → `preloadFonts` → `startDesk()` → `deskPlace()` | – | – | – | ✅ (live) | n/a | desk placement never sends `xr:placed` (analytics only, fine) |
| 6 | xr/XRPage.tsx:77 → XRApp.ts:116-120 | Toolbar "Hail the table" | `openHailCard()` → `openHail()` (only if status AT_TABLE) → card visible | – (card items emit) | – | – | ⚠ | n/a | Does nothing, with no feedback, outside AT_TABLE. Opens even when `negotiation.running=false` (TR2-004) |
| 7 | xr/XRPage.tsx:78 → XRApp.ts:178 | Toolbar "Menu" | `toggleMenu()` → `WristMenu.toggle(undefined, camera)` | – | – | – | ✅ (live) | n/a | – |
| 8 | scene/SceneDirector.ts:102 | Captain "Weigh anchor" tag (`tagHit`) | MouseInput.up / XRInput.release → `Interactable.onSelect` → `store.emit("table:start", {})` | `table:start` | `{}` | `(p: Record<string,never>)` | ❌ **never fires** (TR2-001). Payload ✅ when onSelect is called directly (live: BRIEFING→AT_TABLE) | ✅ requireOrganizer accepts deviceOk (service.ts:157-160, 312) | TR2-001, TR2-004 (tag shows with fewer than 2 crew) |
| 9 | scene/SceneDirector.ts:103 | Captain piece body | same as #8 | `table:start` | `{}` | same | ❌ (TR2-001) | ✅ | same |
| 10 | scene/SceneDirector.ts:104,116-119 | Clock pinch/click | `toggleClock()` → `dryrun:control {action: pausedAt ? "resume" : "pause"}` | `dryrun:control` | `{action:"pause"\|"resume"}` | `{action:"pause"\|"resume"\|"restart"}` (events.ts:14) | ❌ input (TR2-001); payload ✅ (live pause→resume) | ✅ (service.ts:446) | TR2-006 |
| 11 | scene/SceneDirector.ts:107-112 | Cloche dome (×2) | lift chosen / lower other locally → `plan:pick {planId}` | `plan:pick` | `{planId: string}` (PlanPublic.planId) | `{planId: string}` | ❌ input (TR2-001); payload ✅ (live DRY_RUN→SEALING) | ✅ (service.ts:467) | TR2-009 |
| 12 | scene/SceneDirector.ts:84-86 | "Back to the charts" card (VOIDED) | PaperMenu button → `booking:retry {}` | `booking:retry` | `{}` | `(p: Record<string,never>)` | ❌ input (TR2-001); payload ✅ (live VOIDED→DRY_RUN) | ✅ (service.ts:514) | – |
| 13–16 | xr/XRApp.ts:15-20,52-53 | Hail card presets (4) | PaperMenu → `director.hail(h)` → `table:hail {text}` → hide card | `table:hail` | `{text: string}` | `{text: string}` | ❌ input (TR2-001); payload ✅ (live: HAIL turn, speaker `{kind:"human", memberId: organizerId}`) | ✅ io.ts:65 maps device → organizerId | TR2-004 (SLOW_DOWN / CAPTAINS_CALLING are silent) |
| 17 | xr/XRApp.ts:54 | Hail card "Never mind" | hide card | – | – | – | ❌ (TR2-001) | n/a | – |
| 18 | xr/wristMenu.ts:58 | Brass wheel on the chart edge | `toggle()` | – | – | – | ❌ (TR2-001) | n/a | – |
| 19 | xr/wristMenu.ts:28 → XRApp.ts:62 | Menu "Recenter chart" | close menu → `placement.reset(session)`; desk: `deskPlace()` | – | – | – | ❌ (TR2-001) | n/a | – |
| 20 | xr/wristMenu.ts:29 → XRApp.ts:63-67 | Menu "Captions" | cycle `captionScale` → `caption.setScale` → relabel | – | – | S/M/L | ❌ (TR2-001) | n/a | TR2-008 |
| 21 | xr/wristMenu.ts:30 → XRApp.ts:68 | Menu "Reduce motion" | `tweens.speed` 2/1 | – | – | – | ❌ (TR2-001) | n/a | – |
| 22 | xr/wristMenu.ts:31 → XRApp.ts:69 | Menu "Sound" | mutes sfx **and** voices | – | – | spec: "Mute ambience" | ❌ (TR2-001) | n/a | TR2-013 |
| 23 | xr/wristMenu.ts:32 → XRApp.ts:70 | Menu "Debug" | toggle DebugOverlay | – | – | – | ❌ (TR2-001) | n/a | – |
| 24 | xr/wristMenu.ts:33 → XRApp.ts:181-184 | Menu "Exit" | XR: `session.end()`; desk: `onExit()` | – | – | – | ❌ (TR2-001), and a no-op in desk mode (TR2-007) | n/a | TR2-007 |
| 25 | xr/input.ts:86 → XRApp.ts:87 | Pinch/trigger on empty space (not placed) | `placement.place(xrCam)` → `onPlaced` → `xr:placed {}` | `xr:placed` | `{}` | `(p: Record<string,never>)` | ✅ (code) | ✅ (io.ts:69 no-op, allowed for anyone) | – |
| 26 | xr/input.ts:85 → XRApp.ts:88-91 | Pinch-hold ≥ 400 ms on empty space | place if not placed, else `openHail()` | – | – | doc 03 Q2: hold ≥ 400 ms | ✅ (code) | n/a | presets instead of the spec's free-form trumpet (TR2-013) |
| 27 | xr/input.ts:135 → XRApp.ts:167 | Laptop press-and-hold > 650 ms | `onLongPress` → `openHail()` | – | – | – | ⚠ (live: an **orbit drag** of 800 ms opened the hail card) | n/a | TR2-005 |
| 28 | xr/input.ts:56 → XRApp.ts:92 | Controller squeeze | `menu.toggle(undefined, xrCam)` | – | – | spec: menu button; grip = lift cloche | ✅ (code) | n/a | TR2-013 |
| 29 | xr/wristMenu.ts:80-104 | Left palm up for 600 ms | opens the menu above the wrist | – | – | Q5 | ✅ (code; not testable here) | n/a | its items are hit by TR2-001 |
| 30 | xr/debugOverlay.ts:13-28 | console.error/warn, window error, unhandledrejection | `client:log {level,msg}` | `client:log` | `{level:"warn"\|"error", msg:string≤500}` | `{level, msg, data?}` | ✅ (live: accepted from device) | ✅ (io.ts:78) | – |
| 31 | xr/XRApp.ts:46-50 | Placement done | `xr:placed {}` + paper sound + unroll | `xr:placed` | `{}` | same | ✅ | ✅ | – |
| 32 | gallery/GalleryPage.tsx:55-61,79 | "Take a seat (with sound)" | `sound.unlock()` raced against 600 ms → `setStarted` | – | – | – | ✅ (live) | n/a | – |
| 33 | gallery/GalleryPage.tsx:41 | `Space` | `toggleOrbit()` (and clears preset) | – | – | §5 pause orbit | ✅ (live) | n/a | – |
| 34 | gallery/GalleryPage.tsx:42 | `1` | `setPreset("overhead")` | – | – | §5 | ✅ (live) | n/a | – |
| 35 | gallery/GalleryPage.tsx:43 | `2` | `setPreset("organizer")` | – | – | §5 | ✅ (live) | n/a | – |
| 36 | gallery/GalleryPage.tsx:44 → GalleryApp.ts:32-45 | `3` | `setPreset("speaker")`, target from the `turn:new` tap (seat math duplicates SceneDirector) | – | – | §5 | ✅ (live; speakerPos set) | n/a | – |
| 37 | gallery/GalleryPage.tsx:45 | `0` (not in the on-screen help) | `setPreset(null)` | – | – | – | ✅ | n/a | – |
| 38 | gallery/GalleryPage.tsx:46 | `C` | toggle captions strip | – | – | §5 | ✅ (live) | n/a | – |

**Device-token permission matrix** (live, headset socket at `tr2-drive.log` 1.23 s):

| Emit from headset | Server result | Headset UI ever sends it? |
|---|---|---|
| `table:sailWithout` | `NOT_ORGANIZER` "Sail without them from the organizer's phone." ✅ | no ✅ |
| `plan:vote`, `seal:set`, `seal:cancel`, `brief:submit` | `NOT_MEMBER` ✅ | no ✅ |
| `table:start`, `plan:pick`, `booking:retry`, `dryrun:control` | allowed through requireOrganizer via deviceOk ✅ | yes |
| `table:hail` | allowed, attributed to organizerId ✅ | yes |
| `dryrun:control` while in BRIEFING | **accepted and broadcast** (`{"action":"pause"}` reached the room) | could, see TR2-006 |
| private events received by headset / Gallery sockets (5 sockets, full voyage) | **0** ✅ | – |

## B. Return path: server → scene

| Server event | Store reducer (tripStore.ts) | Scene consumer | Fields read | In shared types? | Sent by server? (live) | Verdict |
|---|---|---|---|---|---|---|
| `trip:state` | :71-84 | SceneDirector.sync :135-180, Gallery Corner, EnterCard, DebugOverlay | status, crew[].{memberId,name,band,role,origin,briefSealed}, organizerId, candidateCities[].{cityId,name,lat,lng}, dateWindows[].{id,start,end}, negotiation.watch, shortlist, votes, booking, chosenPlanId | ✅ all | ✅ | ✅. But `negotiation.watch` is stale during AT_TABLE (TR2-002) |
| `table:watch` | :88 **dropped** (returns undefined) | nothing | watch | ✅ | ✅ at 10 s and 31 s | ❌ TR2-002 |
| `turn:new` | :89-90 dedup by turnId, sort by seq | animateTurn / applyTurnInstant, GalleryApp tap | turnId, seq, speaker.{kind,memberId}, act, cityId, text, ribbon, voiced, audioUrl | ✅ | ✅ keys: speaker, act, text, ribbon, voiced, redactions, turnId, tripId, seq, watch, createdAt (+ planId/cityId when set) | ✅. `planId`, `redactions` and `watch` are never read (the last could fix TR2-002) |
| `turn:audioReady` | :91 | SceneDirector.voice :311-320 → `playVoiceAt(url)` | turnId, audioUrl | ✅ | ✅ `/api/audio/:id` (routes.ts:126). Replay omits the optional durationMs. Not emitted in this environment (no TTS key) | ✅ (1.5 s wait, then speech fallback). `durationMs` never read (spec: ribbon write-on synced to duration) |
| `table:decided` | :92 | shortlist → buildDryRun, openSealChart, DECIDE circles | planId, label, cityId, cityName, hotelId, hotelName, hotelLat/Lng, cityCenter.{lat,lng}, tileRadiusKm (km×1000→m ✅), groupCents (cents → formatDollars ✅), fitsEveryone, publicFlags[].detail, cityNotes, dateWindowId, days[0].{label, items[].{activityId,name,startMin,endMin,attendees,lat,lng,travel[memberId].{fromId,minutes,flagged}}, arrivals[].{memberId,landMin,atStayMin}} | ✅ all (pricing.ts:237-246) | ✅ all keys present live | ✅ fields. ❌ timing vs the DECIDE turn (TR2-003). `neighborhood` is never read |
| `dryrun:script` | :94-100 skew-mapped startedAt/pausedAt | `store.dryrunMinute()` → clock + cloche beads (SceneDirector :382, :432-435) | dayStartMin, dayEndMin, minPerSec, startedAt, pausedAt, serverNow | ✅ | ✅ (480, 1380, 15, ms epoch) | ✅ units: minutes of day vs startMin/landMin (minutes) ✅; ms clocks ✅. `planIds` never read (the scene uses shortlist order, which is the same order) |
| `dryrun:control` | :101-108 uses local `Date.now()` and ignores `at` | dryrunMinute | action | ✅ | ✅ `{action, at}` | ⚠ TR2-006 |
| `plan:votes` | :109 | `cloche.setVotes(votes[planId])` | tallies[planId] (count) | ✅ | ✅ | ✅. `autoPick` is never shown on the headset or Gallery (phone only; OK) |
| `booking:created` | :110 | `syncSeals` | bookingId, seals[].{memberId,status} | ✅ | ✅ | ✅. `seals[].standing` is never read (SealChart uses `role==="absent"`) (TR2-012) |
| `seal:status` | :112-116 (ignored when bookingId ≠ store.booking) | `syncSeals` → `pressSeal` on AUTHORIZED/CAPTURED | bookingId, memberId, status | ✅ (DECLINED is masked to VOIDED on the server ✅) | ✅. The standing seal's first `AUTHORIZING` arrives **before** `booking:created` and is dropped, but the snapshot covers it | ✅ (TR2-012 note) |
| `booking:result` | :118 lastResult | `seal.tie(s.lastResult?.reference)` | reference | ✅ | ✅ `AA-MEX-LQSS` | ⚠ `tie()` ignores reference (`void reference`), and lastResult is not replayed on resume (trip:state.booking.reference is). TR2-012 |
| `error` | :119 | only DebugOverlay (hidden by default) | code | ✅ | ✅ | ❌ no user feedback on the headset (TR2-004) |
| private (`brief:private`, `plan:private`, `seal:private`, `seal:declinedPrivate`) | – | never read by scene/xr/gallery (grep) | – | – | 0 received by headset/Gallery | ✅ |

**Clock.** `TripStore.dryrunMinute()` (tripStore.ts:147-152) is the only clock source: SceneDirector :382 and :432, and `DryRunCloche.update(min)`. ✅

**Rebuild from state on reconnect** (late headset joins, see the log):
- **DRY_RUN:** replay is `trip:state > turn:new×N > table:decided > dryrun:script > plan:votes`. The scene rebuilt cloches, clock and rings. Checked live in the Gallery after a reload: 2 cloches, clock visible, minute 955, LIS/MEX rings on. ✅
- **VOIDED:** `trip:state > turns > table:decided > booking:created`. On resume there is no seal chart (only built when `this.seal` exists). The back card is shown. Acceptable. ✅
- **BOOKED:** `trip:state > turns > table:decided > booking:created(with reference)`. `openSealChart(instant)` + `tie`. The reference is not shown, as in the live flow. ✅
- **SEALING:** booking is in trip:state and booking:created. ✅
- All fields the rebuild reads (`trip.shortlist`, `trip.booking`, `trip.votes`, `trip.chosenPlanId`) are in `service.state()` (service.ts:549-565). ✅ The one exception is `negotiation.watch` mid-table (TR2-002).

**Private fields.** Neither the headset nor the Gallery reads `planPrivate`, `sealPrivate`, `brief`, `declined`, `amountCents` or `capCents` (grep over scene/xr/gallery). SealChart prints "— sealed —" only. ✅ One observation (TR2-015): the public `PlanPublic.days` carries per-member `arrivals.landMin` and `travel[memberId]`.

---

## C. Issues

### TR2-001 — Every 3D pickable is dead on the headset and in the laptop view: select compares fresh wrapper objects by identity
- Severity: Critical
- Link: Captain tag / body, clock, cloche domes, "Back to the charts", the 5 hail-card buttons, the brass wheel and the 6 wrist-menu items → `table:start` / `dryrun:control` / `plan:pick` / `booking:retry` / `table:hail` / menu actions. Pick sites: xr/input.ts:84 (`XRInput.release`: `if (p.downHit && now === p.downHit)`) and xr/input.ts:134 (`MouseInput.up`: `if (this.downHit && hit === this.downHit)`). Wrapper sources: scene/SceneDirector.ts:98-114 (the `get interactables()` getter builds new object literals on every call), scene/Buttons.ts:59-61 and xr/wristMenu.ts:56-61 (`.map(...)` / literals on every call).
- Expected vs actual: A press and release on the same object should call `onSelect`. In fact `live()` / `pick()` call `getTargets()` again on release, so the found `Interactable` is a different object from `downHit` and the equality is always false. Because `downHit` is non-null, the long-press and empty-select branches are skipped too, so nothing happens at all. Live proof on `/t/CHSMNN/xr`: `pick()` twice on the Captain tag gave `sameInteractable:false, sameObject:true`; `director.interactables[0]===director.interactables[0]` was `false`, and the same for `menu.interactables()`. Real pointerdown/up on the tag (and direct `mouse.down/up`) produced `emits: []`, and the status stayed BRIEFING. Calling the same `onSelect` directly sent `table:start` and moved the trip to AT_TABLE. On Quest this means the headset cannot weigh anchor, hail, pause the clock, pick a chart, retry after a void, or use any menu item. Only placement, squeeze-to-open-menu, and palm-up still work.
- Fix: Compare the underlying mesh, not the wrapper: `if (p.downHit && now?.object === p.downHit.object) p.downHit.onSelect()`, and the same in `MouseInput.up`. Better still, also build the interactable lists once and cache them (SceneDirector: rebuild only when cloches change), which also saves per-frame allocations in `XRInput.update`.
- Effort: S
- Scope: xr/input.ts (2 lines). Optionally SceneDirector/Buttons/WristMenu caching.
- Acceptance: In the laptop view, a real click on the Weigh-anchor tag emits `table:start` and the status goes to AT_TABLE. A click on the clock toggles pause, a click on a cloche emits `plan:pick`, a click on "Back to the charts" emits `booking:retry`, hail-card buttons emit `table:hail`, and menu buttons relabel. Add a unit test: `pick(e) === pick(e)` or the object-based comparison, with a press/release on the same mesh calling onSelect once.

### TR2-002 — Watch progress never reaches the scene: `table:watch` is dropped and `trip:state` is not re-broadcast
- Severity: High
- Link: server `table:watch` (service.ts:347) → tripStore.ts:88 `on("table:watch", () => undefined)` → SceneDirector.ts:149 `compass.setWatch(trip.negotiation.watch)`, GalleryPage.tsx:90-94 "Watch n/3", debugOverlay.ts:54
- Expected vs actual: The compass pointer should advance at each Watch, and the Gallery corner should show "Watch 1/3", then 2/3 (doc 03 §4 Q2, §5; doc 04 §9.3 `table:watch → compass pointer advance`). Live: `table:watch` arrived at 10.0 s (1) and 31.4 s (2), but every `trip:state` during AT_TABLE had `watch=0`, and the next one only came at DRY_RUN with watch=2. In the browser, turns had `watch` 0,1,1,1 while `store.state.trip.negotiation.watch` stayed 0, the compass stayed at 0, and the Gallery corner read "Spring Break '27 · At the table" with no Watch indicator.
- Fix: In tripStore, reduce `table:watch` into state: `on("table:watch", (p) => this.state.trip ? { trip: { ...this.state.trip, negotiation: { ...this.state.trip.negotiation, watch: p.watch } } } : undefined)`. Alternatively, `broadcastState` inside `onWatch`. For resilience, also take `max(turn.watch)` in SceneDirector.
- Effort: S
- Scope: net/tripStore.ts (and the phone table mirror benefits too)
- Acceptance: During a live table, the Gallery corner shows "Watch 1/3" within 1 s of the first PROPOSE and "2/3" at the first OBJECT/SUPPORT. `director.compass` advances. A reconnect mid-table shows the right watch.

### TR2-003 — The DECIDE animation reads the shortlist about 7 s before `table:decided` arrives, so the two-chart ink circles can be missed and every arc erased
- Severity: Medium
- Link: `turn:new` DECIDE → SceneDirector.ts:292-298 (`globe.circle(store.state.shortlist…)`, `eraseArcs(k => !shortlistCities.some(…))`) ← `table:decided` sent only after the Captain's line finishes (engine.ts:98-104 → service.ts:356-362)
- Expected vs actual: DECIDE should ring the two shortlisted pins and keep their arcs (doc 03 Q2 "two pins get ink circles"). Live gap: DECIDE turn at 50.08 s, `table:decided` at 57.32 s (7.2 s). When the animation queue is idle, which is the normal foreground case, `animateTurn(DECIDE)` runs at once: shortlist is `[]` (it was cleared by the fresh-table reset), so `circle([])` hides all rings and `eraseArcs` removes **all** arcs. Nothing re-circles when `table:decided` lands; onStatusChange(DRY_RUN) doesn't call `circle`. (In my browser run the headset tab was in the background, so its queue lagged and the rings happened to be correct. Resume is also correct, because `applyTurnInstant` runs after trip:state carries the shortlist.)
- Fix: Do the circle and erase in `onStatusChange(→DRY_RUN)` or on the `table:decided` tap, not in the DECIDE turn. Or send `table:decided` before the DECIDE line / include `planIds` in the DECIDE turn (the turn already carries `planId` for A).
- Effort: S
- Scope: scene/SceneDirector.ts (or engine/service ordering)
- Acceptance: With the Gallery in the foreground and PACE_SCALE=1, after DECIDE both shortlisted pins show rings and only arcs to those two cities remain, every time.

### TR2-004 — The headset never shows server rejections; the Weigh-anchor tag and hail card appear when the server will refuse
- Severity: Medium
- Link: `store.state.error` (tripStore.ts:119) is read only by DebugOverlay (debugOverlay.ts:56, hidden by default). Related: SceneDirector.ts:148 `showTag(status==="BRIEFING" && allSealed && controls)` vs service.ts:316 `TOO_FEW` (fewer than 2 crew); XRApp.ts:117 `openHail` checks only `status==="AT_TABLE"` vs service.ts:391 `!negotiation.running → CAPTAINS_CALLING`; `SLOW_DOWN` at service.ts:393.
- Expected vs actual: Rejections should get a short in-scene note. Doc 03 §6 says the "Captain's calling it" hail case is shown to the user. Live: a second hail within 5 s returned `SLOW_DOWN` (drive log 10.36 s) and the headset shows nothing. A solo organizer with a sealed brief sees "Weigh anchor", and pinching it silently fails with TOO_FEW. A pick after an auto-pick gives BAD_PHASE, silently.
- Fix: Subscribe XRApp/SceneDirector to `error` and show `message` on the caption card for about 3 s (then `store.clearError()`). Gate the tag on `crew.length >= 2`, and gate `openHail` on `trip.negotiation.running`.
- Effort: S
- Scope: xr/XRApp.ts, scene/SceneDirector.ts
- Acceptance: A rapid double hail shows "One hail every few seconds." on the caption card. A one-person voyage shows no tag. The hail card doesn't open after the Captain's DECIDE.

### TR2-005 — In the laptop view, dragging to orbit for more than 650 ms opens the hail card
- Severity: Medium
- Link: canvas pointerdown/up → xr/input.ts:131-137 `MouseInput.up` (`!downHit && held > 650 && button===0` → `onLongPress`) → XRApp.ts:167 `openHail()`
- Expected vs actual: A press and hold without moving should open the hail card. Live: pointerdown at (800,150), 8 pointermoves to x=560 over 800 ms, pointerup: `hailCardOpenedByOrbitDrag: true` during AT_TABLE. Anyone looking around the chart room during the meeting keeps popping the card.
- Fix: Track the pointerdown position; cancel the long press when it moves more than ~6 px (or when OrbitControls fires `start`/`change`).
- Effort: S
- Scope: xr/input.ts
- Acceptance: An orbit drag of any length never opens the card. A still press of 700 ms does.

### TR2-006 — Dry-run clock control: a duplicate pause moves a paused clock on every client; the client ignores `at`; the server accepts control outside DRY_RUN
- Severity: Medium
- Link: SceneDirector.ts:116-119 (`dryrun:control`) → io.ts:70-72 → service.ts:445-457 (no-op pause still broadcast; no phase check) → tripStore.ts:101-108 (`pause` always sets `pausedAt = Date.now()`)
- Expected vs actual: Every device should show the server's minute (doc 04 types: DryRunScript comment). Live on the headset: after a pause, a second `pause` (it can come from the organizer's phone at the same moment) was broadcast (drive log 60.03 s) and the local paused minute jumped 1090.9 → 1114.4 while the server kept its original `pausedAt`. After resume, all connected clients run about 1.5 real seconds (23 in-trip minutes) ahead of the server and of any late joiner. Also, `dryrun:control {pause}` sent in BRIEFING was accepted and broadcast (drive log 1.23 s), and it seeds a stray server clock.
- Fix: On the server, reject when `status !== "DRY_RUN"` and don't broadcast no-ops. Include the resulting `{startedAt, pausedAt, serverNow}` in the `dryrun:control` payload. In the client, apply those (skew-mapped) instead of `Date.now()`. Update the doc 04 §7.1 action list (`restart` vs `day`).
- Effort: S
- Scope: trips/service.ts, net/tripStore.ts, shared/events.ts, docs/04 §7
- Acceptance: pause, pause, resume from two devices leaves all clients and a fresh join within 1 in-trip minute. `dryrun:control` in BRIEFING returns BAD_PHASE.

### TR2-007 — The "Exit" menu item does nothing in the laptop view, and the menu stays open
- Severity: Low
- Link: wristMenu.ts:33 → XRApp.ts:181-184 `exit()` → `onExit` → XRPage.tsx:27 `setMode(m => m==="in-ar" ? "ready-ar" : m)`
- Expected vs actual: Exit should leave the chart room. Live (after working around TR2-001): mode stayed "in-desk", the toolbar stayed, and `menu.open` stayed true.
- Fix: In desk mode, handle it as `in-desk → ready-desk` (dispose orbit/mouse, or just navigate), and `menu.toggle(false)` on exit.
- Effort: S
- Scope: xr/XRPage.tsx, xr/XRApp.ts
- Acceptance: Exit in the laptop view returns to the Enter card.

### TR2-008 — The Captions size cycle has uneven steps and two different "L" sizes
- Severity: Low
- Link: wristMenu.ts:29 → XRApp.ts:63-67
- Expected vs actual: The cycle should be S → M → L. Live sequence from 1.0 ("M"): 1.225 (L), 1.45 (L), 0.85 (S), 1.075 (M), 1.30 (L), 0.85 (S). The first loop has a second, larger L with the same label, and the loop has no fixed period.
- Fix: Use `const SIZES = [0.85, 1, 1.3]` and cycle an index.
- Effort: S
- Scope: xr/XRApp.ts
- Acceptance: Repeated taps give exactly S/M/L scales 0.85/1/1.3, labelled correctly.

### TR2-009 — An optimistic cloche lift is not undone if `plan:pick` is rejected
- Severity: Low
- Link: SceneDirector.ts:108-111 (`lift(other===cl)` before emit) → service.ts:467-469 (BAD_PHASE if an auto-pick already fired, or if the status has changed)
- Expected vs actual: A rejected pick should leave both cloches at rest. Actually the chosen cloche stays lifted 5 cm with no feedback until the next status change.
- Fix: Lower both on `error` with code BAD_PHASE/NOT_ORGANIZER, or lift only on the SEALING transition (already done at SceneDirector.ts:341).
- Effort: S
- Scope: scene/SceneDirector.ts
- Acceptance: A pick sent after the auto-pick shows no lingering lift.

### TR2-010 — Headset and organizer sessions share one localStorage key per join code
- Severity: Low
- Link: PairPage.tsx:22 `saveSession({tripId, joinCode, deviceToken})` → session.ts:10 key `aa:session:<CODE>`
- Expected vs actual: Pairing a laptop fallback in a browser where the organizer is also signed in replaces the organizer's `memberToken` (their phone UI loses its identity). If a phone page later `saveSession`s without `deviceToken`, `/t/:code/xr` says "Pair the headset first".
- Fix: Merge (`{...loadSession(code), ...new}`) or use a separate key `aa:headset:<CODE>`.
- Effort: S
- Scope: net/session.ts, xr/PairPage.tsx, xr/XRPage.tsx
- Acceptance: In one browser, organizer join then headset pair keeps both tokens, and both pages work.

### TR2-011 — The pairing rate limit is per IP and counts successful and failed attempts, so shared IPs lock out a valid code
- Severity: Low
- Link: PairPage submit → routes.ts:75-76 `limitPair(req)` (10/min per `req.ip`, routes.ts:26-35)
- Expected vs actual: A valid, fresh code should pair. Live: with other clients on localhost, the form showed "Too many headset codes tried — wait a minute." four times in a row (about 24 s) before pairing, and my scripted pair was refused the same way. At a venue behind NAT (Quest and judges' laptops on one public IP) the same thing can happen.
- Fix: Count only failed attempts (`BAD_CODE`) toward the limit, or key by IP plus code prefix. Show a countdown in PairPage.
- Effort: S
- Scope: api/routes.ts, xr/PairPage.tsx
- Acceptance: 10 successful pairs from one IP in a minute are not throttled; 10 wrong codes are.

### TR2-012 — Contract fields that are sent but never read, and one dropped event, in the scene
- Severity: Low
- Link: `BookingPublic.seals[].standing` (orchestrator.ts:91) vs SealChart.ts:138 `new WaxSeal(m.role === "absent")`. `booking:result.reference` / `trip:state.booking.reference` vs SealChart.ts:200-208 (`void reference`) and SceneDirector.ts:350 (`s.lastResult?.reference`, which is null on resume because `booking:result` is not replayed). `turn:audioReady.durationMs` (doc 04 §9.3 "ribbon write-on synced to duration") not used. `Turn.planId` unused. The standing seal's first `seal:status AUTHORIZING` is emitted before `booking:created` (drive log 62.94 s) and dropped by tripStore.ts:114.
- Expected vs actual: The scene should use the canonical fields. `standing` is the payments truth (a present member could also have a standing seal). The reference is never shown on the tied chart.
- Fix: Pass `booking.seals.find(...)?.standing` into WaxSeal. Use `s.booking?.reference ?? s.lastResult?.reference` and render it on the twine tag. On the server, emit `booking:created` before starting standing authorizations.
- Effort: S
- Scope: scene/SealChart.ts, scene/SceneDirector.ts, payments/orchestrator.ts
- Acceptance: The tied chart shows `AA-XXX-XXXX` live and after reload. The standing letter follows `standing`.

### TR2-013 — Headset interactions differ from doc 03 §4 and doc 04 §7.1
- Severity: Low
- Link: XRApp.ts:92 (squeeze → menu), XRApp.ts:15-20/52-55 (hail presets), XRApp.ts:69 (Sound mutes voices too), SceneDirector.ts:118 (`pause`/`resume` only), events.ts:14 (`restart`) vs doc 04 §7.1 (`day`)
- Expected vs actual: The spec says: menu on the controller menu button (grip is used for "pick cloche: grip + lift" and "rotate globe"); hail as a speaking trumpet with free text or voice; "Mute ambience"; clock swipe to jump days; `dryrun:control {action:"pause"|"resume"|"day", day?}`. The build has grip → menu, 4 canned hails, Sound mutes everything, no day jump, and `restart` (which no UI sends).
- Fix: Either update docs 03/04 to match the build, or bind the menu to the menu button (`XRInputSource.gamepad` buttons[12]/thumbstick press, or `select` on the wheel) and keep grip free.
- Effort: S (docs) / M (input)
- Scope: docs, xr/input.ts, shared/events.ts
- Acceptance: The docs and the code list the same controls and action enum.

### TR2-014 — A new table after "Adjust my terms" keeps the last meeting's rings and arcs on the globe
- Severity: Low
- Link: SceneDirector.ts:327-333 (BRIEFING/AT_TABLE branch clears the dry run and seal but not `globe.circle` or `eraseArcs`)
- Expected vs actual: Each meeting should start with a clean globe. Actually the old two-chart rings and ink/pencil arcs stay visible into the new meeting.
- Fix: In that branch, call `this.globe.circle([]); this.globe.eraseArcs();`.
- Effort: S
- Scope: scene/SceneDirector.ts
- Acceptance: VOIDED → re-brief → a new table shows no rings or arcs until new PROPOSE lines.

### TR2-015 — Public plan data exposes each member's arrival time and per-member legs to the headset and Gallery
- Severity: Low
- Link: pricing.ts:92 and :149 → `PlanPublic.days[].arrivals[{memberId,landMin}]`, `items[].travel[memberId]`, `attendees` → DryRun.ts:175-211 (used only to animate beads)
- Expected vs actual: By contract this is public, and the scene uses it only to animate beads, never as text. But the Gallery and a judge's headset get each member's exact landing minute, which together with the public dataset can point to a member's flight and so their fare tier (doc 03 §2 visibility matrix spirit). Live sample: `landMin` 685 / 715 / 700 keyed by memberId.
- Fix: Confirm this with the privacy owner. If it's not OK, round `landMin` to 30 min or send the arrival order only.
- Effort: S
- Scope: fit/pricing.ts (toPublic)
- Acceptance: The privacy test (doc 04 §14) explicitly covers `days[].arrivals`.

---

**Summary:** 38 interactive elements traced: 19 ✅, 2 ⚠ (#6, #27), 17 ❌ (#8–24, all from TR2-001). The emitted names and payloads all match `ClientToServer`, and the headset only emits events its device token is allowed to send (`table:sailWithout` is never sent). Issues: 1 Critical, 1 High, 4 Medium, 9 Low.
