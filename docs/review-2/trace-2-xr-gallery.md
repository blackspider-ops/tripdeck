# Trace 2 (round 2): Headset (WebXR + laptop view) and Gallery → net layer, plus server → scene return path

Repo `/Users/tejas/Downloads/untitled folder 3` at HEAD `0430ef9`. The working tree also has uncommitted edits in `apps/web/src/scene/CityTiles.ts` (the frame-gap fix for the 4 s tile deadline) and `apps/server/src/api/routes.ts`, and this review read both as they are on disk. This was a read-only review; the only file written is this report.

**How it was verified**
- **Static trace.** `apps/web/src/{xr,gallery,scene,scene/director,shared-ui}` was traced against `net/tripStore.ts`, `net/session.ts`, `net/api.ts`, `packages/shared/src/events.ts`, `apps/server/src/realtime/io.ts` and `apps/server/src/trips/{core,identity,table,dryrun,sealing,replay}.ts`.
- **Tests.** `cd apps/web && npx tsc --noEmit` exits 0, and `npx vitest run` passes 52/52 tests in 12 files, including `xr/input.test.ts` (3 tests).
- **Live browser run, one tab of my own, closed at the end.**
  - Seeded voyage **2T792L** through `POST /api/demo/seed`. The pair form was driven with `e43` (the error shows), then `e43a-ku59x`, which was normalised to `E43AKU59`. It paired and navigated to `/t/2T792L/xr`.
  - Tested the laptop view with synthetic `PointerEvent`s on the canvas at projected mesh positions. To avoid paid TTS, `table:start` was captured by wrapping `store.emit` and was not sent. Server refusals were then triggered for real at no cost: `dryrun:control` in BRIEFING and `table:hail` in BRIEFING.
  - Revoked the browser's pairing by minting and redeeming a second headset code over REST.
  - Observed existing voyages as a spectator only, with nothing accepted by the server: the Gallery on **T22K5M** (DRY_RUN) and **U75YNT** (BOOKED), and an unknown code **ZZZZZZ**. I also opened `/t/T22K5M/xr` with a fake device token and clicked a cloche and the clock. The server refused both with `NOT_ORGANIZER`, so that voyage did not change.
  - Afterwards I removed my `aa:headset:*` keys from localStorage.
- No table was run. Gemini is already over its free-tier quota in the server log, and ElevenLabs is live.

Legend: ✅ works end to end · ⚠️ works, with a UX or edge issue · ❌ broken

## A. Inventory: client → server

| # | Surface (file:line) | Element / gesture | Handler → call | Server target (io.ts → service) | Payload / auth | Visible result | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | xr/PairPage.tsx:37-48 | Code input | strip `[^a-z0-9]`, 8 chars, uppercase | – | – | live: `e43a-ku59x` → `E43AKU59` | ✅ |
| 2 | xr/PairPage.tsx:14-29,50 | "Pair this headset" | `<8` chars → local error; `api.pairHeadset(c)` → `saveHeadsetSession` (`aa:headset:<CODE>`) → nav `/t/:code/xr` | `POST /api/xr/pair` → identity.pairHeadset (single use, revokes the previous device, 12 h token; only failures count toward the limit) | `{code}` → `{tripId,joinCode,deviceToken}` | live: "The headset code has eight characters." then pairs; the member key is untouched (TR2-010 fixed) | ✅ |
| 3 | xr/XRPage.tsx:56-67 | "Enter a headset code" (no headset key) | `<Link to="/xr">` | – | – | – | ✅ |
| 4 | xr/XRPage.tsx:110 → XRApp.ts:150 | "Enter the chart room" (Quest) | `sound.unlock()` (not awaited) → `enterAR()` → `requestSession(immersive-ar)` → `placement.start` | – | – | no Quest available; the code keeps user activation | ✅ (code) |
| 5 | xr/XRPage.tsx:111,117 → XRApp.ts:174 | "Laptop view" / "Open the chart room" | unlock → fonts → `startDesk()` (idempotent `addRoom`, new Orbit and Mouse) | – | – | live; reopening after Exit works | ✅ |
| 6 | xr/XRPage.tsx:88 → XRApp.ts:139 | Toolbar "Hail the table" | disabled unless `AT_TABLE && negotiation.running`; `openHail()` re-checks | – | – | live: disabled in BRIEFING, with a tooltip | ⚠️ L2-005 (still offered in Watch 3) |
| 7 | xr/XRPage.tsx:91 → XRApp.ts:197 | Toolbar "Menu" | `menu.toggle(undefined, camera)` | – | – | opens, but the top two items are off-screen | ⚠️ L2-001 |
| 8 | SceneDirector.ts:98 | Captain "Weigh anchor" tag | MouseInput / XRInput → `sameTarget` → `emit("table:start", {})` | table.startTable (`requireOrganizer` accepts `deviceOk`; TOO_FEW, BRIEFS_PENDING, TOO_MANY_RUNS) | `{}` ✔ | live: a real click emitted `table:start {}`. A drag on the tag emitted nothing. Revoked device: `NOT_ORGANIZER` shown in red on the caption | ✅ (TR2-001 fixed) |
| 9 | SceneDirector.ts:99 | Captain piece body | same as #8 | same | same | same | ✅ |
| 10 | SceneDirector.ts:100,106-109 | Carriage clock | `dryrun:control {action: pausedAt ? "resume" : "pause"}` | dryrun.dryrunControl (BAD_PHASE outside DRY_RUN; no-ops are not broadcast) | ✔ | live on T22K5M: `{"action":"pause"}` sent. In BRIEFING the server answers BAD_PHASE "The clock only runs during the Dry Run." (ack and `error`) | ✅ |
| 11 | PhaseController.ts:65-76 | Cloche dome ×2 | lift chosen / lower other, `pickPending=true` → `plan:pick {planId}` | sealing.pick | `{planId}` = `PlanPublic.planId` ✔ | live: `{"planId":"MEX-W1-roma-flat"}`. On refusal `cancelPick()` lowered it (`pickPending=false`) and the caption showed the reason | ✅ (TR2-009 fixed) |
| 12 | PhaseController.ts:29-31 | "Back to the charts" (VOIDED) | `booking:retry {}` | sealing.retry | `{}` ✔ | static: shown only when `controls`, and enabled only while visible | ✅ (code) |
| 13-16 | XRApp.ts:59-60 | Hail card presets ×4 | `director.hail(h)` → `table:hail {text}` → hide card | table.hail (device → organizerId in io.ts:166) | `{text}` ✔ | live refusal: `CAPTAINS_CALLING` → "Captain's calling it." in red | ✅ |
| 17 | XRApp.ts:61 | Hail "Never mind" | hide card | – | – | – | ✅ (code) |
| 18 | wristMenu.ts:59 | Brass wheel | `toggle()` | – | – | live: a click opens the menu | ✅ |
| 19 | wristMenu.ts:29 → XRApp.ts:69 | "Recenter chart" | close → `placement.reset(session)`, `placed=false`; desk: `deskPlace()` | – | – | laptop view: the button is above the viewport (y ≈ −150 px) | ⚠️ L2-001 |
| 20 | wristMenu.ts:30 → XRApp.ts:70-75 | "Captions" | index cycle over S 0.85 / M 1 / L 1.3 | – | – | live: S → M → L → S (TR2-008 fixed); off-screen in the laptop view (y ≈ −51 px) | ⚠️ L2-001 |
| 21 | wristMenu.ts:31 → XRApp.ts:76 | "Reduce motion" | `tweens.speed` 2/1 | – | – | live: label changes to "Reduce motion: on" | ✅ |
| 22 | wristMenu.ts:32 → XRApp.ts:77 | "Sound" | mutes sfx and voices | – | – | live: label changes | ✅ (doc 03 now says "Sound") |
| 23 | wristMenu.ts:33 → XRApp.ts:78 | "Debug" | toggles DebugOverlay | – | – | live: the card appears | ✅ |
| 24 | wristMenu.ts:34 → XRApp.ts:200-210 | "Exit" | closes the menu and hail card; XR `session.end()`; desk disposes Mouse and Orbit → `onExit` → back to the Enter card | – | – | live: `menuOpen:false, mouse:false, orbit:false`, toolbar gone, Enter card back (TR2-007 fixed) | ✅ |
| 25 | input.ts:85 → XRApp.ts:92 | Pinch on empty space (not placed) | `placement.place(xrCam)` → `onPlaced` (paper sound + unroll) | – (no `xr:placed` event any more) | – | – | ✅ (code) |
| 26 | input.ts:84 → XRApp.ts:93-96 | Pinch-hold ≥ 400 ms on empty space | place if not placed, else `openHail()` (gated) | – | – | – | ✅ (code) |
| 27 | input.ts:158-172 → XRApp.ts:186 | Laptop press-and-hold > 650 ms | long press only if not dragged (> 6 px) and button 0 | – | – | live: a 30 px drag on the tag → no select; orbit drag ≠ hail (TR2-005 fixed) | ✅ (edge cases: L2-006) |
| 28 | input.ts:59 → XRApp.ts:97 | Controller squeeze | `menu.toggle(undefined, xrCam)` | – | – | – | ✅ (code; doc 03 §339 agrees) |
| 29 | wristMenu.ts:81-105 | Left palm up for 600 ms | opens the menu above the wrist | – | – | – | ✅ (code) |
| 30 | debugOverlay.ts:13-28 | console.error/warn, window error, unhandledrejection | `client:log {level,msg≤500}` via the live `relayStore` | io.ts:188 (member or `deviceOk` only, 5/s) | ✔ | – | ✅ |
| 31 | — | Seal call-off / crew close on the headset | not built | server accepts both from the device | – | doc 03 §339 says "only the phone has buttons" | ✅ (documented) |
| 32 | gallery/GalleryPage.tsx:55-61,79 | "Take a seat (with sound)" | `sound.unlock()` raced against 600 ms → `setStarted` | – | – | – | ✅ |
| 33 | GalleryPage.tsx:41 | `Space` | `toggleOrbit()` (and clears the preset) | – | – | live: orbiting false → true | ✅ |
| 34-37 | GalleryPage.tsx:42-45 | `1` / `2` / `3` / `0` | `setPreset("overhead" / "organizer" / "speaker" / null)` | – | – | live: each preset set; the speaker target is the Captain at (−0.3, 0.08, −0.03) from the last turn | ✅ (L2-008 timing) |
| 38 | GalleryPage.tsx:46 | `C` | toggles the caption strip | – | – | live: hide and show. **Cmd+C also toggles** | ⚠️ L2-004 |

**Device-token rules** (static, checked against io.ts and core.ts):
- `requireOrganizer` accepts `deviceOk` for `table:start`, `dryrun:control`, `plan:pick`, `booking:retry`, `booking:callOff` and `crew:setOpen`.
- `table:hail` is attributed to `organizerId`.
- `headset:unpair` refuses a device.
- `plan:vote`, `seal:*` and `brief:submit` require a member id.
- The headset UI only ever emits `table:start`, `dryrun:control`, `plan:pick`, `booking:retry`, `table:hail` and `client:log`. ✅
- `deviceOk` is re-checked on every action. It is false after the token expires (12 h), after another headset pairs, and in BOOKED. ✅ But the client is never told: see L2-002.

**Ack/error handling.** No headset or Gallery emit passes an ack. All refusals come back through the caller-only `error` → `store.state.error` → `SceneDirector.onRejected`. That path lowers any optimistic lift, shows the message in sounding-red on the caption card for 3 s (only when `controls`), then restores the previous line and runs `clearError()`. Verified live for `BAD_PHASE`, `CAPTAINS_CALLING` and `NOT_ORGANIZER`. ✅

## B. Return path: server → scene

| Server event | Store reducer (tripStore.ts) | Scene / Gallery consumer | Fields read | Shape OK? | Verdict |
|---|---|---|---|---|---|
| `trip:state` | :94-113. Keeps the shortlist while `shortlistIds` match; clears turns, audio and dryrun on a fresh BRIEFING/AT_TABLE; maps `booking.sealDeadlineAt` and `autoPick.at` with `serverNow` | SceneDirector.sync (pins, origins, crew, captain tag with ≥ 2 crew, compass), PhaseController, EnterCard, Gallery Corner, DeskToolbar, XRApp hail gate | status, crew[].{memberId,name,band,role,origin,briefSealed}, organizerId, candidateCities[].{cityId,name,lat,lng}, dateWindows[].{id,start,end}, negotiation.{watch,running}, shortlistIds, votes, chosenPlanId, booking | ✅ replay.ts:21-45 | ✅ |
| `table:watch` | :116-117 patched into `trip.negotiation.watch` | compass, Gallery "Watch n/3", debug | watch | ✅ | ✅ (TR2-002 fixed; static only, since no table was run) |
| `turn:new` | :118-119 dedup by id, sorted by seq | TurnPlayer.sync / animate / applyInstant; GalleryApp tap → speakerPos | turnId, seq, speaker, act, cityId, text, ribbon, voiced, audioUrl, durationMs | ✅ | ✅ (live replay: 8 turns on T22K5M) |
| `turn:audioReady` | :120 `audio[turnId]` | TurnPlayer.voice (1.5 s wait, then speech fallback) and ribbon `durationMs` | audioUrl, durationMs | ✅ | ✅ (TR2-012 durationMs is now used) |
| `table:decided` | :121 | PhaseController.buildDryRun (on the DRY_RUN status change), TurnPlayer.markShortlist, SealCeremony.openChart, CityTiles | planId, cityId, cityName, hotelName, cityCenter, dateWindowId, days[0].*, … | ✅. Sent **before** `trip:state` both live (table.ts:186-187, emitShortlist before broadcastState) and on replay (replay.ts:71-72) | ✅ live: 2 cloches, 2 CityTiles, rings on LIS and MEX only, YUL not circled (TR2-003 fixed via `markShortlist()` in DRY_RUN) |
| `dryrun:script` | :123-129 skew-mapped | `store.dryrunMinute()` per frame → cloches and clock | dayStartMin, dayEndMin, minPerSec, startedAt, pausedAt, serverNow | ✅ | ✅ live: clock visible, minute 1380 (day end) |
| `dryrun:control` | :130-135 uses the server's `startedAt/pausedAt` with `serverNow` | same | startedAt, pausedAt, serverNow | ✅ events.ts:58 | ✅ (TR2-006 fixed) |
| `plan:votes` | :136 tallies and skew-mapped autoPick | `phases.setVotes` → cloche tallies | tallies[planId] | ✅ | ✅ (autoPick is phone-only, by design) |
| `booking:created` | :138-143 | SealCeremony.sync → `setStanding(seal.standing)`, `pressSeal` | bookingId, seals[].{memberId,status,standing} | ✅ | ✅ live U75YNT: standing letter only on the `standing` seal (TR2-012 fixed) |
| `seal:status` | :145-149 (ignored when the booking id differs) | same | memberId, status | ✅ | ✅ |
| `booking:result` | :151 `lastResult` (replayed now: replay.ts:86-89) | PhaseController BOOKED → `seals.tie(lastResult ?? booking.reference)` → `hangTag` | reference | ✅ | ✅ live: tied chart, tag text `AA-LIS-FZSH` after reload (TR3-003 / TR2-012 fixed) |
| `table:failed` | :153 → `error` (not on the Gallery) | onRejected caption (headset) | code, message | ✅ | ✅ (code) |
| `error` | :154 | onRejected (headset caption, cancelPick); Gallery ignores it | code, message, event | ✅ | ⚠️ `event:"trip:join"` refusals are never shown (L2-003) |
| private (`brief:private`, `plan:private`, `plan:myVote`, `seal:private`, `seal:declinedPrivate`) | reducers exist | **never read** by scene/xr/gallery (grep: no `planPrivate`, `sealPrivate`, `brief`, `declined`, `myVote`, `memory` or amounts) | – | – | ✅ live Gallery: `planPrivate={}`, `brief=null`, `sealPrivate=null` |

**Fields the scene reads** (grep over `scene/ xr/ gallery/`):
- `state.trip`, `state.turns`, `state.audio`, `state.shortlist`, `state.dryrun` (via `dryrunMinute()`), `state.votes`, `state.booking`, `state.lastResult` and `state.error`.
- `trip.crewClosed` and `autoPick` are not read, which is right for the headset and the Gallery.

SceneDirector's `unchanged()` gate (trip, turns, votes, booking, error) skips a sync on shortlist-only or lastResult-only events. That is safe because phase work is enqueued and reads `store.state` when it runs, and `table:decided` always comes before the status change.

**Rebuild on resume** (live). DRY_RUN (T22K5M) rebuilt 2 cloches, the clock, rings and 6 arcs. BOOKED (U75YNT) rebuilt a tied chart with 3 seals pressed, the standing letter and the reference tag. The Gallery corner read "Dry run" and "Logged", and the strip showed the phase caption. ✅

**input.ts**
- `pickTarget` walks the list in place: nearest hit, enabled, and the whole ancestor chain visible.
- `sameTarget` compares `.object`.
- Director targets are cached until `targetsChanged()`, and `XRApp.targets` rebuilds only when the director array changes.
- The drag threshold is 6 px, the laptop long press 650 ms (button 0 only), and the XR hold 400 ms. Unit-tested: rebuilt wrappers, nearest/enabled/visible, and different meshes. Drag and long press are not unit-tested.

**Disposal**
- XRPage cleanup runs `app.dispose()` (unsubscribes from the store, disposes mouse and orbit, ends the session, then `stage.dispose()`: director, shared textures, renderer, `forceContextLoss`), then `s.close()`.
- Minor leftovers are in L2-007.

**Re-pair.** A new pair replaces the device, and the old socket is refused on its next action. The old headset is never told (L2-002).

## C. Round-1 issues: status

| Round 1 | Status now | Evidence |
|---|---|---|
| TR2-001 dead pickables | **Fixed** | live: tag, cloche, clock, wheel and menu items all select |
| TR2-002 watch dropped | Fixed (static) | tripStore.ts:116 |
| TR2-003 DECIDE before table:decided | Fixed | `markShortlist()` again in DRY_RUN; live rings are correct |
| TR2-004 no rejection feedback; tag with 1 crew | Fixed | live red caption; SceneDirector.ts:155 `crew.length >= 2`; hail gated on `running` (see L2-005 for Watch 3) |
| TR2-005 orbit drag opens hail | Fixed | live |
| TR2-006 clock drift / BAD_PHASE | Fixed | live BAD_PHASE; server clock applied |
| TR2-007 Exit no-op in desk | Fixed | live |
| TR2-008 captions cycle | Fixed | live S/M/L |
| TR2-009 lift not undone | Fixed | live `pickPending` reset after the refusal |
| TR2-010 shared localStorage key | Fixed | `aa:headset:<CODE>` |
| TR2-011 pair limit counts successes | Fixed | routes.ts:140 counts failures only |
| TR2-012 standing / reference / durationMs | Fixed | live |
| TR2-013 spec drift | Fixed in docs | doc 03 §339 |
| TR2-014 old rings on a new meeting | Fixed (static) | PhaseController.ts:95 |
| TR2-015 public arrivals | Out of layer (WP-02) | – |

---

## D. Findings

### L2-001 — In the laptop view, the chart-room menu opens partly above the viewport, so "Recenter chart" and "Captions" can't be clicked
- **Severity:** Medium
- **Location:** xr/wristMenu.ts:65-78 (`placeInFront`: 0.45 m along the *horizontal* forward, 0.12 m below the eye) ← XRApp.ts:197 `toggleMenu()` (toolbar) and the wheel.
- **Evidence:**
  - The desk camera sits at (0, 0.62, 0.78) and pitches about 35° down (fov 45°). A card 0.244 m tall centred 15° below the horizon therefore sticks out of the top of the frame.
  - Live, 920×869 canvas: the button centres are at y = −150 (Recenter), −51 (Captions), 39, 121, 197 and 268 px. A screenshot shows only "Reduce motion / Sound / Debug / Exit", and the title is cut off.
  - The laptop view's only way to change caption size or recenter is therefore unreachable unless the user first orbits the camera. In XR the same placement is at head height, which is fine.
- **Fix:** Place along the camera's full forward vector, pitch included, when not presenting. For example, `if (!renderer.xr.isPresenting) group.position.copy(pos).addScaledVector(fwdWithPitch, 0.45)` with `group.quaternion.copy(camera.quaternion)`. Alternatively, use a small DOM menu in the laptop toolbar.
- **Effort:** S
- **Scope:** xr/wristMenu.ts (and XRApp.toggleMenu to pass a flag)
- **Acceptance:** In the laptop view at the default camera, every menu item's projected centre is inside the canvas. Clicking "Captions" with the mouse cycles S/M/L.

### L2-002 — A replaced, expired or unpaired headset silently becomes a spectator: controls stay, every tap says "Only the organizer can do that.", and there is no way to re-pair
- **Severity:** Medium
- **Location:**
  - Server: io.ts:148-155 (`trip:join` with a bad `deviceToken` joins the room as a spectator with no notice); core.ts:183-190 (`deviceOk` false after 12 h, after another pair, or after `headset:unpair`).
  - Client: XRPage.tsx:16,25,56 (only a *missing* key shows "Pair the headset first"); SceneDirector opts `controls: true` is fixed at construction.
- **Evidence:**
  - Live: paired 2T792L in the browser, then redeemed a second code over REST (the "second headset" case in identity.pairHeadset).
  - Clicking the Weigh-anchor tag gave `NOT_ORGANIZER` and the red caption "Only the organizer can do that.", and the tag stayed.
  - After a reload the Enter card again offered "Open the chart room" with the full crew. `store.state.error` was null, because the join itself succeeded, and `aa:headset:2T792L` was still stored.
  - The same happens when the 12 h token expires in the middle of a voyage, or when the organizer taps Unpair. The person wearing the headset sees working-looking controls that always refuse, with a message that blames them for not being the organizer.
- **Fix:**
  - Server: when a join carries a `deviceToken` that fails `deviceOk`, emit a caller-only `error {code:"HEADSET_UNPAIRED", event:"trip:join", message:"This headset isn't paired any more. Enter a new code from the organizer's phone."}`. For an already-joined socket, refuse device actions with that code instead of `NOT_ORGANIZER`.
  - Client: on `HEADSET_UNPAIRED`, call `clearHeadsetSession(code)`, end or exit the chart room, and show the "Pair the headset first" card with the `/xr` link. Make `controls` a getter (`() => paired`) so the tag and back card hide.
- **Effort:** S–M
- **Scope:** realtime/io.ts, trips/core.ts (message), xr/XRPage.tsx, scene/director/context.ts
- **Acceptance:** Pair headset A, then pair B with a fresh code. Within one action (or on A's next reload), A shows "This headset isn't paired any more…" with a link to `/xr`, and no Weigh-anchor tag. The same holds after `headset:unpair` and after the token expires.

### L2-003 — The Gallery (and the headset's Enter card) show "Finding the voyage…" forever when the join is refused
- **Severity:** Low
- **Location:** gallery/GalleryPage.tsx:87-89 (Corner reads only `trip` and `connected`); xr/XRPage.tsx:105 (the same for EnterCard). tripStore.ts:154 stores the `error {event:"trip:join"}`, but nobody reads it.
- **Evidence:** Live `/t/ZZZZZZ/gallery`: `connected:true`, `error:{code:"NO_TRIP", event:"trip:join", message:"No voyage with that code."}`, and the corner still said "Finding the voyage…" after 3 s. A voyage that was swept or deleted, or a mistyped Gallery link on the venue TV, looks as if it is loading forever.
- **Fix:** In Corner and EnterCard, `if (!s.trip && s.error?.event === "trip:join") show s.error.message` (plus a "Check the code" hint).
- **Effort:** S
- **Scope:** gallery/GalleryPage.tsx, xr/XRPage.tsx
- **Acceptance:** `/t/ZZZZZZ/gallery` shows "No voyage with that code." within 1 s.

### L2-004 — Gallery shortcuts ignore modifier keys
- **Severity:** Low
- **Location:** gallery/GalleryPage.tsx:38-47
- **Evidence:** Live: `keydown {key:"c", metaKey:true}` hid the caption strip. So Cmd/Ctrl+C (copying a caption) toggles captions, and Cmd/Ctrl+1/2/3 (switching browser tabs during a demo) moves the Gallery camera.
- **Fix:** `if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;` at the top of `onKey`.
- **Effort:** S
- **Scope:** gallery/GalleryPage.tsx
- **Acceptance:** Cmd+C and Cmd+1 change nothing, and the plain keys still work.

### L2-005 — The hail card and toolbar button are still offered in Watch 3, when the server always refuses
- **Severity:** Low
- **Location:** xr/XRApp.ts:134-137 `canHail()` and XRPage.tsx:84 (`AT_TABLE && running`) vs table.ts:226 (also refuses when `watch >= MAX_WATCHES` or `hailsClosed`)
- **Evidence:** Static. During the last Watch, before the Captain decides, `running` is still true. The card opens, and each preset comes back as "Captain's calling it." (the refusal is shown, so the only harm is a wasted gesture).
- **Fix:** Add `trip.negotiation.watch < MAX_WATCHES` (from `@all-ayes/shared`) to both gates. The store subscription already closes an open card.
- **Effort:** S
- **Scope:** xr/XRApp.ts, xr/XRPage.tsx
- **Acceptance:** Once the Gallery corner reads "Watch 3/3", the toolbar hail is disabled and a long press does nothing.

### L2-006 — MouseInput edge cases: a right or middle click selects, and a release outside the canvas leaves the press stuck
- **Severity:** Low
- **Location:** xr/input.ts:158-172
- **Evidence:**
  - Static: `up()` checks `e.button === 0` only for the long press, so a right-click (OrbitControls pan) without movement on a cloche emits `plan:pick`.
  - There is no `pointercancel` or `pointerleave` handling. A drag released over the toolbar never reaches `up`, and `pressed` stays true, so hover cursors stop updating until the next press.
  - Drag and long-press behaviour has no unit test.
- **Fix:** Return early in `up` when `e.button !== 0`. Listen for `pointercancel` (and use `setPointerCapture` on down) to reset `pressed`. Add tests for "drag > 6 px → no select" and "still 700 ms → onLongPress".
- **Effort:** S
- **Scope:** xr/input.ts, xr/input.test.ts
- **Acceptance:** A right-click on a cloche emits nothing. After a drag released off-canvas, hover shows the pointer cursor again. New tests pass.

### L2-007 — Small listener and object leftovers on unmount
- **Severity:** Low
- **Location:**
  - gallery/GalleryApp.ts:33 and xr/debugOverlay.ts:42: `store.tap(...)` return values are dropped, so they are never unsubscribed.
  - XRApp.dispose (XRApp.ts:212-218) does not dispose the hail card, wrist menu, debug card, placement reticle or XRInput rays and dots. All of these live outside `director.root`, so `disposeObject(root)` misses them.
- **Evidence:** Static. GPU memory is released anyway by `forceContextLoss`, and the store is closed. What remains is JS garbage per remount (StrictMode, route changes) plus taps on a dead store.
- **Fix:** Keep the unsubscribe functions and call them in `dispose()`. Call `disposeObject` on `hailCard.group`, `menu.group`, `menu.wheel`, `debug.group` and `placement.reticle`.
- **Effort:** S
- **Scope:** gallery/GalleryApp.ts, xr/XRApp.ts, xr/debugOverlay.ts
- **Acceptance:** After mounting and unmounting `/t/X/xr` and `/t/X/gallery` 5 times, `store.taps.size` is 0 on the closed stores and the renderer.info geometry count does not grow.

### L2-008 — Gallery "follow the speaker" turns to the next speaker when the line arrives, not when it plays
- **Severity:** Low
- **Location:** gallery/GalleryApp.ts:33-37 (tap on `turn:new`) vs TurnPlayer.animate (queued behind the line being spoken)
- **Evidence:** Static. When a voiced line is still playing and the next `turn:new` lands, which happens with TTS latency or after a hidden-tab catch-up, preset 3 swings to the next speaker while the previous voice is still speaking.
- **Fix:** Add `onSpeaker?(t)` to SceneDirector, called at the start of `TurnPlayer.animate` (and from `applyInstant` for the last turn), and use it in GalleryApp instead of the raw tap.
- **Effort:** S
- **Scope:** scene/SceneDirector.ts, scene/director/TurnPlayer.ts, gallery/GalleryApp.ts
- **Acceptance:** With preset 3 on, the camera reaches each speaker as that speaker's caption appears.

---

**Summary:** 38 elements traced: 33 ✅ and 5 ⚠️ (#6, #7, #19, #20, #38), with no ❌. All 17 round-1 ❌ items (TR2-001) now work live, and 14 of the 15 round-1 issues are fixed; TR2-015 was not re-checked here because it is outside this layer. Event names and payloads all match `ClientToServer`. The headset only emits events its device token may send, and scene, xr and gallery never read private fields. Issues: 0 High, 2 Medium (L2-001, L2-002), 6 Low.
