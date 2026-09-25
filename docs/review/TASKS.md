# All Ayes — Task Board

Generated from the review in this folder (commit `befc070`). **191 findings → 17 work packages (WP).** Duplicates found by several reviewers are merged under one canonical ID (the others are listed as *also covers*). Full detail for any ID: `grep -n "### <ID>" docs/review/*.md`.

## Protocol for sub-agents

1. **Pick** a WP whose wave is open (all *Depends on* WPs are `done`) and whose status is `open`.
2. **Claim** it: change its status line to `claimed — <your name>, <date>` in this file and commit that one-line change first.
3. **Isolate**: work on branch `wp-XX` (ideally a git worktree). Touch **only** the paths in *Scope*. If a fix needs a file outside scope, stop and add a note under *Notes* instead.
4. **For each item**: read its detail section (`grep -n "### <ID>" docs/review/*.md`), implement the *Fix*, add the *Acceptance* test, tick the box. Items marked *also covers* are fixed by the same change — verify each of them too.
5. **Gates before merging** (all must pass):
   - `cd apps/server && npx tsc --noEmit && npx vitest run`
   - `cd apps/web && npx tsc --noEmit && npx vite build --outDir /tmp/aa-gate`
   - The Expo script must not change: `apps/server/test/negotiation.test.ts` and the shares in `pricing.test.ts` stay green (unless your item explicitly changes them — then update the docs too).
   - Privacy: `apps/server/test/e2e.test.ts` still proves the headset and Gallery receive **zero** private events.
6. **Finish**: commit with the IDs in the message (e.g. `WP-05: TR3-001, TR5-003 …`), set status to `done`, note anything deferred.

Status values: `open` · `claimed — who, when` · `done` · `blocked — why`. Severity is the worst item in the package.

## Waves

| Wave | Work packages | Can run in parallel? |
|---|---|---|
| 1 | WP-01, WP-02, WP-05 | Yes — scopes are disjoint (WP-01 excludes scene/DryRun.ts, which WP-02 owns). |
| 2 | WP-03, WP-04, WP-06, WP-07 | Yes, except WP-06 after WP-04 and WP-07 after WP-06 (shared files in service.ts / routes.ts). |
| 3 | WP-08, WP-09, WP-10, WP-11, WP-12, WP-13 | Mostly — respect each WP's *Depends on*; WP-13 after WP-02 + WP-05. |
| 4 | WP-14, WP-15, WP-16, WP-17 | After waves 1–3 are merged (these touch many files). |

## Overview

| WP | Wave | Title | Worst | Items (canonical / total) | Effort mix | Depends on | Status |
|---|---|---|---|---|---|---|---|
| [WP-01](#wp-01) | 1 | 3D controls & headset interaction | **Critical** | 10 / 10 | S×10 | — | done |
| [WP-02](#wp-02) | 1 | Public plan data leaks everyone's share | **Critical** | 2 / 2 | S×1 L×1 | — | done |
| [WP-03](#wp-03) | 2 | Live state & replay consistency | **High** | 10 / 20 | S×10 | WP-02 | done |
| [WP-04](#wp-04) | 2 | Payment & seal integrity | **High** | 9 / 12 | S×6 M×3 | — | done |
| [WP-05](#wp-05) | 1 | Passkeys that actually hold | **High** | 4 / 5 | S×1 M×3 | — | done |
| [WP-06](#wp-06) | 2 | Identity, sessions & seats | **High** | 10 / 12 | S×7 M×3 | WP-04 | done |
| [WP-07](#wp-07) | 2 | Abuse limits & resource bounds | **High** | 7 / 15 | S×4 M×3 | WP-06 | done |
| [WP-08](#wp-08) | 3 | Production hardening & bundle | **Medium** | 15 / 17 | S×14 M×1 | WP-07 | done |
| [WP-09](#wp-09) | 3 | Typed contract & error semantics | **High** | 8 / 12 | S×6 M×2 | WP-03, WP-07 | done |
| [WP-10](#wp-10) | 3 | Persistence integrity & restore | **High** | 14 / 16 | S×10 M×4 | WP-04, WP-06 | done |
| [WP-11](#wp-11) | 3 | Local file stores & test isolation | **High** | 5 / 7 | S×4 M×1 | WP-06 | done |
| [WP-12](#wp-12) | 3 | Privacy filter & negotiation quality | **High** | 7 / 8 | S×5 M×2 | WP-02 | done |
| [WP-13](#wp-13) | 3 | Phone UX fixes | **High** | 15 / 15 | S×12 M×3 | WP-02, WP-05 | done |
| [WP-14](#wp-14) | 4 | Server refactor (no behaviour change) | **High** | 26 / 26 | S×24 M×1 L×1 | WP-03, WP-04, WP-06, WP-07, WP-09, WP-10, WP-11, WP-12 | done |
| [WP-15](#wp-15) | 4 | 3D performance & scene refactor | **High** | 9 / 9 | S×5 M×4 | WP-01, WP-02 | done |
| [WP-16](#wp-16) | 4 | Web tests & client dead code | **Medium** | 3 / 3 | S×3 | WP-13, WP-15 | done |
| [WP-17](#wp-17) | 4 | Docs sync | **Low** | 2 / 2 | S×2 | WP-14, WP-15, WP-16 | done |

## WP-01

### 3D controls & headset interaction

- **Status:** done
- **Wave:** 1  ·  **Depends on:** —
- **Why:** Every pinch/click in the headset and laptop view is dead (Critical). Fix the input layer and the headset's feedback loops.
- **Scope (only touch these):** apps/web/src/xr/**, apps/web/src/scene/** (NOT scene/DryRun.ts — WP-02 owns it)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **TR2-001** | Critical | S | Every 3D pickable is dead on the headset and in the laptop view: select compares fresh wrapper objects by identity |  | `trace-2-xr-gallery.md` |
| [x] | **OPT-053** | Medium | S | XR input allocates target lists and closures every frame |  | `optimization.md` |
| [x] | **TR2-003** | Medium | S | The DECIDE animation reads the shortlist about 7 s before table:decided arrives, so the two-chart ink circles can be missed and every arc erased |  | `trace-2-xr-gallery.md` |
| [x] | **TR2-004** | Medium | S | The headset never shows server rejections; the Weigh-anchor tag and hail card appear when the server will refuse |  | `trace-2-xr-gallery.md` |
| [x] | **TR2-005** | Medium | S | In the laptop view, dragging to orbit for more than 650 ms opens the hail card |  | `trace-2-xr-gallery.md` |
| [x] | **OPT-026** | Low | S | Interactable lists and hit-filter logic duplicated in XR |  | `optimization.md` |
| [x] | **TR2-007** | Low | S | The "Exit" menu item does nothing in the laptop view, and the menu stays open |  | `trace-2-xr-gallery.md` |
| [x] | **TR2-008** | Low | S | The Captions size cycle has uneven steps and two different "L" sizes |  | `trace-2-xr-gallery.md` |
| [x] | **TR2-009** | Low | S | An optimistic cloche lift is not undone if plan:pick is rejected |  | `trace-2-xr-gallery.md` |
| [x] | **TR2-014** | Low | S | A new table after "Adjust my terms" keeps the last meeting's rings and arcs on the globe |  | `trace-2-xr-gallery.md` |

**Notes:**
- **TR2-001** — xr/input.ts: release/click now compare the picked mesh (`sameTarget(a,b)` → `a.object === b.object`, input.ts:83, :164), not the wrapper. SceneDirector.interactables is also cached (see OPT-053), so press/release get the same entry anyway. Unit test: apps/web/src/xr/input.test.ts (3 tests; web has no test script yet, run with `npx vitest run --root apps/web src/xr/input.test.ts`; WP-16 should wire it). Live-verified in the laptop view: a dispatched pointerdown/up on the Captain's tag emitted `table:start` → AT_TABLE; clock → pause/resume; cloche → `plan:pick` → SEALING; wheel opens the menu; hail-card buttons emit `table:hail`; menu buttons relabel.
- **OPT-053** — SceneDirector `interactables` is a lazily built, stable array, dropped only when the cloches change (buildDryRun/clearDryRun). Hail-card and menu lists are built once in XRApp; the combined list is rebuilt only when the director's array changes. `pickTarget` walks the list in place (no filter/map arrays per frame); MouseInput reuses a scratch Vector2 and skips picking while a button is held.
- **OPT-026** — one `targets()` in XRApp shared by XRInput and MouseInput; one `pickTarget(raycaster, targets)` in input.ts shared by `XRInput.hit` and `MouseInput.pick` (isAncestor lookup removed).
- **TR2-005** — MouseInput tracks the press position; moving > 6 px marks a drag, which cancels both the long press (hail card) and the click. Live: an 800 ms orbit drag left the card closed; a still 720 ms press opened it.
- **TR2-007** — XRApp.exit closes the menu and hail card and, in the laptop view, disposes orbit + mouse input; XRPage maps `in-desk` (and `in-ar`) back to the Enter card (ready-ar if AR is supported). Stage.addRoom is idempotent so the room can be reopened. Live: Exit → Enter card shown, toolbar gone, menu closed; reopening works and clicks still register.
- **TR2-008** — `CAPTION_SIZES` S/M/L = 0.85/1/1.3 cycled by index. Live: L 1.3 → S 0.85 → M 1 → L 1.3.
- **TR2-009** — SceneDirector sets `pickPending` on a cloche pick; any rejection while pending lowers both cloches; cleared on SEALING / clearDryRun. Checked the handler live with a synthetic BAD_PHASE (the real race needs an auto-pick).
- **TR2-004** — SceneDirector shows a server `error` (controls surfaces only, so not the Gallery) on the caption card in red for 3 s, then restores the previous line unless a newer one arrived, then `store.clearError()`. Weigh-anchor tag needs `crew.length >= 2`. XRApp `openHail` needs `AT_TABLE && negotiation.running`, and an open hail card closes itself when that stops being true. Live: a quick second hail showed "One hail every few seconds." and the line was restored; after DECIDE the card would not open.
- **TR2-003** — the DECIDE turn no longer rings/erases with an empty shortlist: `markShortlist()` (no-op until the shortlist is known) runs on DECIDE and again in onStatusChange(→DRY_RUN). Live: in DRY_RUN the MEX + LIS rings were visible and only their arcs were left (the test tab was in the background).
- **TR2-014** — entering BRIEFING/AT_TABLE from any phase other than BRIEFING (i.e. after a meeting, not on resume where prev is null) clears the rings and arcs. Not live-tested through a full VOIDED → re-brief cycle.
- Not changed: scene/DryRun.ts (WP-02). `apps/web` tsc currently fails only in WP-02's in-progress files (phone/screens/Booked.tsx, phone/screens/DryRun.tsx, scene/DryRun.ts: PublicScheduleItem/PublicDay). WP-01 files are clean and the vite build passes.

## WP-02

### Public plan data leaks everyone's share

- **Status:** done
- **Wave:** 1  ·  **Depends on:** —
- **Why:** Anyone with the join code (even the Gallery) can compute every member's exact share from the public Dry Run data (Critical). Move per-member schedules to private data.
- **Scope (only touch these):** packages/shared/src/types.ts, apps/server/src/fit/pricing.ts (toPublic/toPrivate), apps/server/src/trips/service.ts (emitShortlist/replay/state only), apps/web/src/phone/screens/DryRun.tsx, apps/web/src/scene/DryRun.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **SEC-001** | Critical | L | Public plan days let anyone reconstruct every member's secret share and infer must-haves/dealbreakers |  | `security.md` |
| [x] | **TR2-015** | Low | S | Public plan data exposes each member's arrival time and per-member legs to the headset and Gallery |  | `trace-2-xr-gallery.md` |

**Notes:**

- Public `PlanPublic.days` is now `PublicDay[]`: items carry `activityId,name,startMin,endMin,lat,lng,kind:"group"|"pick",leg?` only. No member ids, attendance, per-member `travel` or `arrivals`. `leg` is crew-independent (the stay, or the group moment just before → here). `publicFlags` are copied without `memberId`.
- `PlanPrivate` gains `days: MyDay[]` (only my items, `together`, my `travel` leg) and `arrival?: {landMin, atStayMin}`. Built by `myDays()` in pricing.ts, and sent through the existing `plan:private` emit and replay. service.ts needed no change.
- Internal `Plan.days` (`PlanDay`/`ScheduleItem`) is unchanged, so the Expo script and shares are identical.
- Web: the phone DryRun Timeline reads `planPrivate`. scene/DryRun.ts now draws a group route with N unlabeled ink beads (no band colours) and one neutral bead per pick. SceneDirector.ts was **not** touched. **Out of scope, needed for tsc:** phone/screens/Booked.tsx (itinerary + .ics) now reads `state.planPrivate[planId].days` (small change; WP-13 please keep).
- Tests: new apps/server/test/plan-privacy.test.ts. It ports repro1, proves the attack works on the old shape and returns nothing on the new one, checks for forbidden keys and member ids across the chart book, checks that shares stay ambiguous from public data, checks the private itinerary matches, and runs a wire test with a token-less Gallery plus a late joiner at DRY_RUN. e2e.test.ts also asserts that no `attendees/arrivals/travel/landMin` reach the headset or Gallery.
- Docs: 03 §2 visibility matrix rows plus rationale; 04 §7.2 `table:decided` / `plan:private` payloads.
- Residual (deferred, accepted): the public schedule still lists which picks exist (the anonymous union of must-haves). A day-1 pick's start time reflects the latest free-from among its unnamed attendees, rounded to 30 min. With `groupCents` and public origins, pick head-counts may be inferable in small crews, but not *who* attends.

## WP-03

### Live state & replay consistency

- **Status:** done
- **Wave:** 2  ·  **Depends on:** WP-02
- **Why:** Watch indicators never move; booking result/reference lost on reload; event ordering and the Dry Run clock drift between devices.
- **Scope (only touch these):** apps/web/src/net/tripStore.ts, packages/shared/src/events.ts, apps/server/src/trips/service.ts (state/replay/broadcast/dryrun), apps/web/src/scene/Instruments.ts (clock/compass read only)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **TR2-002** | High | S | Watch progress never reaches the scene: table:watch is dropped and trip:state is not re-broadcast | OPT-001, TR3-002, TR1-017 | `trace-2-xr-gallery.md` |
| [x] | **OPT-042** | Medium | S | trip:state re-sends the whole shortlist on every broadcast after the table |  | `optimization.md` |
| [x] | **TR2-006** | Medium | S | Dry-run clock control: a duplicate pause moves a paused clock on every client; the client ignores at; the server accepts control outside DRY_RUN | TR3-010, TR4-019 | `trace-2-xr-gallery.md` |
| [x] | **TR3-003** | Medium | S | booking:result is not replayed, and booking:created replay wipes lastResult, so reference and reason are lost after reload/reconnect | TR1-011, TR3-011, TR4-013 | `trace-3-transport.md` |
| [x] | **OPT-002** | Low | S | xr:placed is a no-op round trip |  | `optimization.md` |
| [x] | **OPT-003** | Low | S | member:joined and brief:received duplicate the trip:state that follows them |  | `optimization.md` |
| [x] | **TR1-008** | Low | S | The auto-pick countdown ignores clock skew between phone and server |  | `trace-1-phone.md` |
| [x] | **TR1-009** | Low | S | Your own vote highlight is lost on reload |  | `trace-1-phone.md` |
| [x] | **TR1-015** | Low | S | (layer 3 note) seal:status for standing seals is emitted before booking:created | TR3-012, TR4-009 | `trace-1-phone.md` |
| [x] | **TR2-012** | Low | S | Contract fields that are sent but never read, and one dropped event, in the scene |  | `trace-2-xr-gallery.md` |

**Notes:**
- Contract (docs/04 §7.1–7.3 and §9.3 updated): removed `xr:placed`, `member:joined`, `brief:received` (the `trip:state` that followed each already carries crew / `briefSealed`). `trip:state.shortlist` → `shortlistIds` (DRY_RUN and later), plus `serverNow`; `booking`/`chosenPlanId` only in SEALING/BOOKED/VOIDED. `dryrun:control` (S→C) now `{action, at, startedAt, pausedAt, serverNow}`; C→S is DRY_RUN-only (BAD_PHASE otherwise), no-ops aren't broadcast, action set stays `pause|resume|restart` (doc fixed). `plan:votes` + `serverNow`. New private `plan:myVote {planId|null}` (added to `PRIVATE_EVENTS`). `Turn.durationMs` stored and replayed. Replay order: `table:decided` → `trip:state` → turns → `dryrun:script` → `booking:created` → `booking:result` (new, BOOKED/VOIDED) → member privates (+ `plan:myVote`).
- TR2-002: tripStore patches `trip.negotiation.watch` from `table:watch` (Gallery corner, compass, debug overlay read it). Instruments.ts / GalleryPage.tsx needed no change.
- TR3-003: the last public reason is kept on `TripRec.lastResult` (set in `onBookingResult`; no orchestrator/BookingRec change). SceneDirector ties the knot with `lastResult?.reference ?? booking.reference`. tripStore keeps `lastResult`/`declined`/`sealPrivate` when `booking:created` re-announces the same booking.
- TR1-015 (**touches payments/orchestrator.ts, coordinate with WP-04**): `create(p, { deferStanding: true })` + new `startStanding(bookingId)`; `service.pick` calls it right after `booking:created`. Default `create()` behaviour unchanged, so payments/audit tests are untouched.
- TR1-008: `autoPick.at` stored in device-clock ms (mapped with `serverNow` from `trip:state` / `plan:votes`); DryRun.tsx unchanged there. TR1-009: DryRun.tsx shows `tapped ?? state.myVote`; tripStore clears `myVote` on any phase change.
- TR2-012: decided per field — `seal:status` drop fixed (TR1-015); `reference` now read by SceneDirector; `durationMs` now replayed; `Turn.planId` kept (engine sets it; cheap). **Deferred (out of scope → WP-15):** SealChart.ts should build WaxSeal from `seals[].standing` (not `role==="absent"`) and render the reference on the twine tag (`void reference` today); ribbon write-on synced to `durationMs`.
- Also deferred (docs outside docs/04 → WP-17): docs/01-PRD A2 and docs/03 P2 still name `member:joined` / `brief:received`.
- Tests: apps/server/test/live-state.test.ts (10: watch in snapshot + replay during the table, ids-only trip:state + replay order, no redundant events, booking:created before any seal:status, booking:result replay BOOKED/VOIDED + no booking after retry, duplicate pause/resume not broadcast + BAD_PHASE outside DRY_RUN, serverNow + private myVote live/replay). e2e.test.ts: `plan:myVote` reaches Maya only; `booking:created` precedes `seal:status` on phone/headset/gallery. plan-privacy.test.ts waits on `shortlistIds`. apps/web/src/net/tripStore.test.ts (5).
- Gate note: `apps/server/test/e2e.test.ts` "conceded" memory check is flaky when suites share `apps/server/data/memory.json` (WP-11); passes on rerun. At finish, server tsc showed one error in orchestrator.ts:257 from WP-04's in-progress work, not WP-03.

## WP-04

### Payment & seal integrity

- **Status:** done
- **Wave:** 2  ·  **Depends on:** —
- **Why:** Whose seal failed is still inferable; a booking can hang or get stuck in SEALING (also after restart); standing approvals renew forever; capture-failure path mislabels a refund.
- **Scope (only touch these):** apps/server/src/payments/**, apps/server/src/trips/service.ts (pick/setSeal/cancelSeal/retry/restore/onBookingResult/submitBrief standing), apps/server/test/**

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **SEC-002** | High | M | Public seal-status sequence reveals whose seal was declined |  | `security.md` |
| [x] | **TR5-001** | High | S | Restore leaves a voyage stuck in SEALING when its booking is already final | TR4-003 | `trace-5-persistence.md` |
| [x] | **SEC-009** | Medium | S | Absent member's standing payment authority is silently renewed on every restart | TR4-004, TR5-004 | `security.md` |
| [x] | **SEC-011** | Medium | S | A booking can hang in SEALING forever (no seal deadline, no organizer abort) |  | `security.md` |
| [x] | **SEC-016** | Medium | M | Capture-failure path "refunds" by voiding and tells the crew nobody was charged |  | `security.md` |
| [x] | **TR5-006** | Medium | M | Restore's abandon can miss provider holds in three crash windows (latent until Visa is wired) |  | `trace-5-persistence.md` |
| [x] | **TR4-016** | Low | S | pick() can report failure after the booking was created |  | `trace-4-service.md` |
| [x] | **TR4-017** | Low | S | submitBrief partial commit when createStanding fails |  | `trace-4-service.md` |
| [x] | **TR4-018** | Low | S | No memory write on VOIDED |  | `trace-4-service.md` |

**Notes:**
- Done by the WP-04 fixer (not committed, as the run asked). Gates: server `tsc` and `vitest` pass (13 files, 160 tests). WP-04 added 28 tests: payments.test +8, audit.test +4, restore.test +3, and the new seal-integrity.test with 10. Web `tsc` and `vite build` pass. WP-03 was editing service.ts, orchestrator.ts (`startStanding`/`deferStanding`), events.ts and docs/04 at the same time. Its changes are kept, and pick's emit order is unchanged.
- **SEC-002:** public seal statuses no longer carry an authorization outcome. A seal is `PENDING` until its member taps, or until a standing seal starts. It then goes `AUTHORIZED` (meaning "set") straight away, before the provider answers. When the booking settles, every seal goes `CAPTURED` or `VOIDED` together, in seat order. `AUTHORIZING` and `DECLINED` never reach the trip room, and in `trip:state` the momentary `ANY_DECLINED` reads `VOIDED`. This is done by `publicSealOf` and `announce()` in orchestrator.ts, which sends only public transitions (`seal.published`). The owner still learns a decline through `seal:declinedPrivate`. Phone copy: "Seal set — waiting on N seals". The scene still presses wax on `AUTHORIZED`, so seals press as members tap. Residual: a member who lifts a seal while it is still PENDING looks like any member who hasn't tapped, and an absent member whose standing seal is declined before anyone else taps is the only seal that was ever set (the timing is inherent).
- **SEC-011:** `booking.sealDeadlineAt` defaults to 10 min (`SEAL_DEADLINE_MS` env, or `payments.sealDeadlineMs`). While the booking is PENDING/AUTHORIZING, the deadline voids it with "Not every seal was set in time…". The new client→server event is `booking:callOff {bookingId}` (organizer phone or paired headset, via `requireOrganizer`). It voids the booking with "The organizer called it off…" and is refused with `CAPTURING` once every seal is set. The phone Seal screen has a "Call it off" button (confirm prompt) for the organizer. No XR button was added: the server allows the headset, but no UI was built for it. The deadline isn't re-armed on restore, because restore voids every live booking anyway. tripStore needed no change, since no new server→client event was added.
- **SEC-016:** `PaymentProvider.refund()` was added (SIM: captured → refunded; a SIM `void` no longer "voids" a capture). When a capture fails, captured seals are refunded and the rest are voided. Public reasons: "…Refunded — nobody ends up paying." or "…nobody was charged." when nothing was captured. A refused refund sets `booking.needsAttention` and is logged. `retry` is then refused with `NEEDS_ATTENTION`, which starts a re-drive, until the refund clears. Deferred: showing `needsAttention` in `/api/debug` and alerting on it (routes.ts is out of scope).
- **TR5-006:** intents are persisted before each provider call (`authorizeRequestedAt`; seals VOIDED plus booking ANY_DECLINED before the voids; `capturedAt` as each capture succeeds), and completion is recorded in `releasedAt`/`refundedAt`. `recover()` (with `abandon()` kept as an alias) re-drives with the same idempotency keys. It voids every seal that has an authRef and no releasedAt, whatever its recorded status. It re-asks an unanswered authorization with its original key and releases the hold if it was approved. For ALL_AUTHORIZED it re-drives the captures, which completes the booking or falls into the refund path. For final bookings, `redrive()` finishes any outstanding releases and refunds. A void the provider answers (ok or "nothing held") counts as released. A void that throws stays owed.
- **TR5-001/TR4-003:** `reconcileBooking()` in restore. A SEALING trip with a CAPTURED booking becomes BOOKED, and with a VOIDED booking it becomes VOIDED. A live booking is recovered, and a live booking that no trip references is voided. `onBookingResult` now applies only while the trip is SEALING/BOOKED/VOIDED, never after "back to the charts".
- **SEC-009/TR4-004/TR5-004:** the standing instruction is persisted on the member (`members.standing`, server-side only and never sent to clients). It is restored with its original expiry via `payments.restoreStanding()`. The SIM re-registers the record through the optional `provider.resumeInstruction`. It is never re-issued at boot. Expired instructions, and those of BOOKED voyages, are dropped. Legacy docs without `standing` derive the expiry as `brief.sealedAt + 24h`. Each step is wrapped in try/catch.
- **TR4-016:** pick validates the briefs before mutating the trip. It sends seal screens with `Promise.allSettled`, and `cardLast4` falls back to "••••". **TR4-017:** submitBrief calls `createStanding` before anything is persisted. On failure it logs, drops any older instruction, and the brief still seals and broadcasts (the member then seals live). **TR4-018:** on VOIDED, every active member gets the neutral note "voyage: <city>, <dates> · not booked (nobody was charged)", with no budget band and no attribution.
- **Docs:** 06 §3, §4.2 (deadline, call-off, durable intents), §4.3 (refund, resumeInstruction), §5.1/5.2, §5.3 invariants 7–8, §7 (the public "set" model, Voided headlines, Call it off), §9, §10. 04 §5 state-machine note, and §7.1/§7.2 `booking:callOff`, `seal:status` and `booking:retry` rows.
- **Out of scope / deferred:** `needsAttention` in `/api/debug` (routes.ts). `BookingPublic.sealDeadlineAt` for a countdown (types.ts). A headset call-off control (xr/**). Renaming `passkeyAssertion` (TR4-014 leftover, WP-14).

## WP-05

### Passkeys that actually hold

- **Status:** done
- **Wave:** 1  ·  **Depends on:** —
- **Why:** Passkey check uses a different origin than register/seal (lock-out on tunnels), credentials vanish on restart, first-come registration, token not bound to the booking.
- **Scope (only touch these):** apps/server/src/passkeys/**, apps/server/src/api/routes.ts (passkey routes only), apps/server/src/trips/service.ts (setSeal gate only), apps/web/src/net/passkey.ts, apps/web/src/phone/screens/Seal.tsx

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **TR3-001** | High | S | Passkey "registered?" check uses a different relying party than register/seal, which locks members out of sealing on a second attempt over a tunnel | TR1-003 | `trace-3-transport.md` |
| [x] | **TR5-003** | High | M | Passkey credentials are in memory only, so any restart silently downgrades seal approval |  | `trace-5-persistence.md` |
| [x] | **SEC-008** | Medium | M | Passkey step-up is optional, lost on restart, first-come and not bound to the booking |  | `security.md` |
| [x] | **TR4-014** | Low | M | Passkey gating details: consumed token forwarded to the provider, in-memory credentials, rpID-agnostic check |  | `trace-4-service.md` |

**Notes:**
- Done by the WP-05 fixer (not committed; the run said no git commits). Gates: server `tsc` and `vitest` pass (86 tests, 6 new in `apps/server/test/passkeys.test.ts`); web `tsc` and `vite build` pass.
- **Relying party (TR3-001/TR1-003):** `originOf()` resolves the RP in this order: pinned `WEBAUTHN_ORIGIN`/`PUBLIC_BASE_URL` (production only), then `Origin`, then `Referer` (same-origin GETs send no Origin), then the configured origin, then `X-Forwarded-Host`, and `Host` last, because the Vite proxy rewrites it. Status, register and auth all use this one resolver. `GET /passkey` now returns `{registered (here), required (anywhere)}`. vite.config.ts was out of scope and is unchanged (`changeOrigin` stays); Referer covers the proxy case.
- **Gate policy:** a member with no passkey anywhere can seal with the confirm tap (PRD E2 fallback). Once they have a passkey on any rpID, every seal needs an assertion token. The token records the rpID it was minted for, and the gate re-checks that the credential is still on file for that rpID. Each member gets one passkey per rpID, and it can't be replaced (409 `PASSKEY_EXISTS`). In dev, a passkey on a second rpID is allowed (localhost first, then a tunnel), so nobody gets locked out. In production (unpinned) that case returns 409 `PASSKEY_ELSEWHERE`, and the phone explains the limit. When pinned there is only one rpID. `auth/options` returns 409 `PASSKEY_MISSING` when this address has no passkey.
- **First-registration trust decision (SEC-008):** the first passkey is trusted to whoever holds the member's own bearer token (their phone session), per docs/06 §4.1 step 2. Adding a second passkey on the same rpID is not supported: it would need an assertion from the first passkey, which was deferred. Token theft before first registration is still WP-06's problem (SEC-004/SEC-019).
- **Token binding (SEC-008):** `auth/verify` requires `bookingId`, and the booking must be in this trip and include this member. The token is bound to member, booking, rpID and credential. It is single use (burned even on a mismatch) and lasts 2 min. Expired tokens are pruned. Challenges carry kind and rpID and expire after 5 min. The booking id is enough to cover the amount, because a retry always creates a new booking.
- **Persistence (TR5-003):** new `passkeys` collection (`_id` = credential id, memberId, rpID, publicKey base64url, counter, transports, createdAt). It is written on register and on every auth (so the counter persists), and loaded by `loadPasskeys()`. One line was added in `TripService.restore()` to call it (outside the "setSeal gate only" scope, needed for restore on boot). No Mongo index was added (the scope allowed the collection name only). WP-10 may add `{memberId:1}`.
- **TR4-014:** `setSeal` no longer forwards the spent token as `passkeyAssertion`. The orchestrator and provider parameter is still `passkeyAssertion?: string`, and renaming it to a verified flag or attestation ref is left to WP-04/WP-14 (outside this scope).
- **Client:** passes `bookingId` to auth verify. A 409 `PASSKEY_EXISTS` during registration goes on to Face ID instead of falling back. `PASSKEY_ELSEWHERE`/`PASSKEY_MISSING` and "no passkeys on this phone but one is required" show a clear margin note with no retry loop. A server `PASSKEY_REQUIRED` also shows a note. The `aa:passkeys=off` kill switch only works in dev builds.

## WP-06

### Identity, sessions & seats

- **Status:** done
- **Wave:** 2  ·  **Depends on:** WP-04
- **Why:** Memories keyed on a public name+airport; ?as= links work in production; removed members can still act; join code = instant membership; tokens live forever in localStorage/URLs.
- **Scope (only touch these):** apps/server/src/trips/service.ts (auth/member/claim/sailWithout), apps/server/src/memory/memory.ts (keying only), apps/server/src/realtime/io.ts (join/auth checks), apps/web/src/phone/screens/TripShell.tsx, apps/web/src/net/session.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **SEC-003** | High | M | Cross-voyage memory keyed on public name/origin: anyone can read or poison a person's history | TR4-007, TR5-018 | `security.md` |
| [x] | **SEC-004** | High | M | ?as=<token> handoff (and organizer-held absent invites) enable session fixation, secret capture and seat lock-out |  | `security.md` |
| [x] | **SEC-010** | Medium | M | Join code grants full membership with no organizer approval; the code is shown on public surfaces |  | `security.md` |
| [x] | **TR1-002** | Medium | S | Re-opening your own invite link on the phone that already claimed it shows "That link isn't valid" |  | `trace-1-phone.md` |
| [x] | **TR4-001** | Medium | S | Removed ("sail without them") members keep acting through a socket still connected from before removal: ghost votes, brief resubmits, hails |  | `trace-4-service.md` |
| [x] | **SEC-018** | Low | S | Headset pairing codes: 30-bit, global search space, device tokens never expire or revoke |  | `security.md` |
| [x] | **SEC-019** | Low | S | Long-lived bearer tokens in localStorage and URLs (?as=, ?k=, ?key=) |  | `security.md` |
| [x] | **TR2-010** | Low | S | Headset and organizer sessions share one localStorage key per join code |  | `trace-2-xr-gallery.md` |
| [x] | **TR4-020** | Low | S | sailWithout housekeeping |  | `trace-4-service.md` |
| [x] | **TR5-023** | Low | S | The headset pairing code hash is brute-forceable if the DB leaks |  | `trace-5-persistence.md` |

**Notes:**
- Done by the WP-06 fixer (not committed, as the run asked). Gates pass: server `tsc` and `vitest` (16 files, 188 tests), web `tsc`, `vite build` and `vitest src/net` (8). New tests: `apps/server/test/identity.test.ts` (12: in-process plus over HTTP and Socket.io) and `apps/web/src/net/session.test.ts` (3). The seal-integrity memory mock and its TR4-018 key assertion now use crew keys. The Expo script is unchanged, including Maya's "conceded" memory line (e2e, and identity.test checks it too). The e2e zero-private-events check is green. Smoke-tested on the running dev server: `/demo/seed` → handoff redeems once (a second try gets `BAD_HANDOFF`), and the 8-char headset code pairs.
- **SEC-003/TR4-007/TR5-018:** memory is keyed `crew:<sha256(crewKey)>|<name>` (memory.ts `crewKeyHash`/`personKey`/`validCrewKey`). The server mints the crew key (256 bits) at create/join/claim when the phone sends none (or a malformed one). The phone keeps it in `localStorage` `aa:crewKey`, and `api.ts` sends it and stores the reply for `createTrip`/`join`/`claimAbsent`, so Create.tsx needed no change. Only `members.crewKeyHash` is stored. A seat without one recalls nothing and writes nothing. Absent seats get the claimer's key, never the organizer's. seed.ts gives Maya a fresh crew key per seed and writes the "conceded" line under it. That also takes Maya's seeded memory out of the shared-`memory.json` flakiness noted under WP-03 (other threads still share the file; WP-11). Legacy `name|origin` threads are no longer read (not migrated: they held test/e2e pollution, not real people).
- **SEC-004:** `?as=<memberToken>` is gone. `/demo` links are `/t/CODE#as=<one-time handoff>&m=<id>`: the code has a 2 h TTL, lives in server memory only, is minted only by `POST /demo/seed` (DEV_KEY-gated in production), and is redeemed via `POST /trips/:id/members/:memberId/handoff` (rate-limited with the pair limiter). Any failed attempt burns it. So in production there is no token-in-URL path, and handoffs exist only after a DEV_KEY seed. The phone asks before swapping an existing seat for any link (`as` included). A failed link never touches the saved seat, and the error page offers "Open my voyage". Absent invites: a 256-bit key, shown once (the organizer can't fetch it again), in the fragment. Claim mints a fresh token only the claimer holds, and a claim with the organizer's crew key gets `403 OWN_INVITE` (the invite stays valid). Residual: an organizer who clears storage or uses another browser can still claim first. Closing that needs out-of-band delivery (email/SMS), which is deferred.
- **SEC-010:** the least disruptive option was chosen: a "Close the crew / Reopen the crew" toggle (socket `crew:setOpen`, organizer phone or headset; `TripRec.crewClosed` → `trip:state.crewClosed` and `by-code.crewClosed`), with joins refused `403 CREW_CLOSED`. Joins after the table has met are already refused (`BAD_PHASE`). Absent invites still work when closed. The Expo flow is unchanged (the crew stays open by default). UI: `CrewDoor` is rendered by TripShell under the Muster (organizer, BRIEFING), and JoinCrew shows "The organizer has closed this crew". No pending-approval state was added.
- **TR1-002:** TripShell treats a link for the seat this phone already holds as "open the voyage" (no claim).
- **TR4-001/TR4-020:** `requireActive()` in `submitBrief`, `hail`, `vote`, `setSeal` and `cancelSeal` throws `NOT_MEMBER` 403. `tallies()` counts only seats still held. `sailWithout` is idempotent, and it drops the seat's vote, standing instruction (`payments.standing` + `m.standing`), pending hail and unused invite key. It then calls the new optional `Bus.evict(memberId)`, and io.ts clears `socket.data.memberId` and leaves `member:{id}`, so the socket stays a trip-room spectator. It no longer saves or broadcasts when nothing changed.
- **SEC-018/TR5-023:** headset codes are 8 chars from `[A-HJ-NP-Z2-9]`, valid 10 min, single use. They are stored as `HMAC-SHA256(PAIRING_SECRET, code)`: set `PAIRING_SECRET` in env, otherwise it is per process and a pending code dies with a restart. The device token lasts 12 h (`deviceExpiresAt`; tokens from older builds without it must re-pair) and stops working when the voyage is BOOKED. Revoke with `DELETE /trips/:id/headset` or socket `headset:unpair` (organizer phone only). PairPage takes 8 chars. The join code is not additionally required to pair (40 bits plus the 10/min limiter).
- **SEC-019:** `#as=`/`#k=` (and older `?as=`/`?k=`) move into state and are stripped from the address bar via router `replace` on first effect. The `/demo?key=` dev key is captured when api.ts loads into `sessionStorage`, stripped with `history.replaceState`, and sent as `X-Dev-Key`. Member seats stay in `localStorage`, because the phone must come back to its voyage. There is no server-side member-token expiry.
- **TR2-010:** headset tokens are kept under `aa:headset:<CODE>` (`save/loadHeadsetSession`). `saveSession` never stores a device token, and `loadSession` ignores legacy headset-only records.
- **Files outside the listed scope (needed):** apps/web/src/phone/screens/Demo.tsx (the link builder only: handoff + fragment), apps/web/src/xr/PairPage.tsx (8 chars + headset key), apps/web/src/xr/XRPage.tsx (headset key only), apps/web/src/net/api.ts, packages/shared types.ts (`TripState.crewClosed?`) and events.ts (`crew:setOpen`, `headset:unpair`), apps/server/src/api/routes.ts (crewKey params, handoff, `DELETE headset`, by-code `crewClosed`), seed.ts. Docs: 04 (§4.1/4.2, §6 "Identity & sessions", §7.1/7.2, §11, §12), 05 §9, 03 P2/P5/headset entry, README Known limits.
- **Deferred:** an "Unpair headset" button in `phone/components/organizer.tsx` (WP-13 owns that file; the API and `api.unpairHeadset` are ready), and that file's comment still says "6-character". A "Leave this phone" action and server-side member-token expiry. Pending-approval joins (SEC-010's alternative). Emailed/SMS invites. Requiring the join code with the headset code. `devAllowed` still accepts `?key=` for the browser-opened `/debug` page (routes.ts, WP-08).

## WP-07

### Abuse limits & resource bounds

- **Status:** done
- **Wave:** 2  ·  **Depends on:** WP-06
- **Why:** No spend caps on paid APIs, 5 MB unauthenticated uploads, spoofable/missing rate limits, unbounded maps, logs and caches.
- **Scope (only touch these):** new apps/server/src/util/limits.ts, apps/server/src/api/routes.ts (non-passkey), apps/server/src/realtime/io.ts (rate limits, client:log), apps/server/src/voice/voice.ts, apps/server/src/index.ts (trust proxy)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **SEC-005** | High | M | Unbounded spend on paid APIs (ElevenLabs STT/TTS, Gemini, Backboard) |  | `security.md` |
| [x] | **SEC-006** | High | S | Unauthenticated 5 MB request bodies are buffered before auth (OOM on 512 MB instance) |  | `security.md` |
| [x] | **OPT-040** | Medium | S | Voice synthesis writes each mp3 twice with sync fs, and the audio dir grows without bound | TR5-020 | `optimization.md` |
| [x] | **SEC-007** | Medium | M | Rate limiting is spoofable and missing on most entry points (join-code enumeration, seat squatting, pairing brute force) | TR3-015, TR2-011, TR3-014, OPT-023 | `security.md` |
| [x] | **SEC-014** | Medium | S | client:log lets any unauthenticated socket write unbounded data into the debug buffer (and break it) | OPT-030 | `security.md` |
| [x] | **SEC-015** | Medium | M | Unbounded in-memory and on-disk growth with O(N) lookups (resource-exhaustion DoS) | OPT-043, OPT-044 | `security.md` |
| [x] | **OPT-046** | Low | S | mp3DurationMs scan bound grows with the loop index |  | `optimization.md` |

**Notes:**
- Shared utility: `apps/server/src/util/limits.ts` — `Lru`, `RateLimiter` (sliding window, LRU-bounded state), `Concurrency`, `clientIp` (X-Forwarded-For only through `TRUST_PROXY_HOPS` proxies), spend caps (`spend`, `withTrip` AsyncLocalStorage voyage scope, `spendFlags`). Env in `config.limits` (config.ts). Full limits table: docs/04 §12 *Limits*; env vars in DEPLOY.md and .env.example. Tests: `apps/server/test/limits.test.ts` (18).
- **SEC-005** — per-voyage (`TRIP_CAP_*`) and per-UTC-day (`DAILY_CAP_*`) counters; `0` = kill switch. Call sites: gemini.ts `generateLine` (→ null → template line), voice.ts `synthesize` only on a cache miss (→ captions), memory.ts `bb()` (→ local memory), hail-audio gate (→ 503 `NO_STT`, which hides voice controls). Socket handlers run in `withTrip(tripId)` so the engine run, timers and memory calls they start count against that voyage. `/api/health.budgets` = `"ok" | "capped"` per provider. STT has a 15 s AbortController timeout. Hail-audio: 2 clips / 5 s and 6 / min per member, phase BRIEFING/VOIDED/AT_TABLE. *Deferred:* hard `TOO_MANY_RUNS` refusal per voyage (the per-voyage budgets make extra runs fall back to templates instead; a hard cap needs service.startTable), Backboard assistant creation only on CAPTURED/never on recall (memory.ts storage, WP-11), counters are in memory (reset on restart).
- **SEC-006** — `express.json` 32 kB router-wide (Content-Length over it → 413 before reading); hail-audio runs `hailAudioGate` (auth → phase → Content-Length ≤ `HAIL_AUDIO_MAX_BYTES` 512 kB → rate → budget → 2 uploads in flight per IP) **before** `express.raw`. Body-parser errors map to 413/400, not 500. `http.headersTimeout` 10 s / `requestTimeout` 60 s (index.ts).
- **OPT-040 / TR5-020** — mp3 written once to content-addressed `CACHE_DIR/tts/<sha1>.mp3` with fs/promises; turn → key in a bounded in-memory LRU; `/api/audio/:turnId` sends that file (sendFile's 404, no existsSync). `pruneAudioCache` removes the legacy `CACHE_DIR/audio` dir and keeps ≤ `TTS_CACHE_MAX_FILES` used within `TTS_CACHE_MAX_DAYS` (hits refresh mtime); runs at boot and hourly. *Deferred:* after a restart, earlier turns' audio 404s (captions play) — persisting `audioKey` on the Turn needs service/shared changes (WP-14).
- **SEC-007 (+TR3-015, TR2-011, TR3-014, OPT-023)** — `trust proxy` = `config.limits.trustProxyHops` (unset: 1 when Render/Fly env is present, else 0); `clientIp` applies the same rule for REST keys and sockets, so rotating XFF on a bare host doesn't help. REST: create 10/min, by-code 60/min + 20 misses/min, join 20/min, claim/handoff 10 failures/min, pair 10 **failures**/min per IP (right codes don't count — TR2-011) + 300 failures/min global, passkey routes 30/min. Sockets: 120 connects/min + 64 open per IP, 64 kB max message, 60 events / 10 s per socket, `trip:join` 10/min/socket + 60/min/IP + 20 misses/min/IP. The two ad-hoc limiters are gone (service's hail 5 s interval stays; its map is pruned by the sweep). `RATE_LIMITS=off` / `RATE_LIMIT_SCALE` for load rigs; tests run with defaults (each test file builds its own router/limiters). *Deferred:* per-code pair attempt counter + PairPage countdown (web).
- **SEC-014 (+OPT-030)** — `client:log` only from a member socket or the paired headset, 5/s per socket, outside the general event budget; `TripService.clientLog()` whitelists level (log/info/warn/error), caps surface 16 / msg 300 chars, writes the service's bounded debug ring buffer (not persisted); `surface` coerced to phone/xr/gallery at join; `esc()` coerces with `String(s ?? "")`; debug page reads `debugLines()`.
- **SEC-015 (+OPT-043, OPT-044)** — service.ts: `codeIndex` (joinCode → trip) and `pairIndex` (pair-code HMAC → trip), maintained by createTrip/headsetCode/pairHeadset and rebuilt lazily when `trips.size` changes outside them (restore); `tripByCode`, createTrip's uniqueness check, `pairHeadset` (hash once) and the debug route are O(1). `sweep()` (hourly from index.ts) evicts BRIEFING voyages idle > `VOYAGE_IDLE_HOURS` (48) and BOOKED/VOIDED idle > `VOYAGE_DONE_DAYS` (7) with members, briefs, standing instructions, debug lines and caches, drops chartBook/privacy/dryrunClock/pendingHails of voyages settled > 2 h, prunes `lastHailAt` and stale pair-index entries. *Deferred:* Mongo TTL index (WP-10), SimProvider results and passkey challenge expiry (payments/passkeys are outside this scope; passkey challenges already expire via WP-05), memory.json async store (done by WP-11).
- **OPT-046** — `mp3DurationMs` computes `end` once (scans ≤ 4 kB past the ID3 header); exported and unit-tested.
- Gates (2026-09-25): server tsc clean; vitest 210/214 — the 4 failures are all in `test/restore.test.ts` (its `store/db.js` mock lacks WP-10's new `onDbConnected` export; WP-10 in progress, not WP-07). e2e green (privacy + pairing limiter), web tsc clean.

## WP-08

### Production hardening & bundle

- **Status:** done
- **Wave:** 3  ·  **Depends on:** WP-07
- **Why:** No security headers, NODE_ENV-only gating, root container with dev deps, health endpoint over-shares, source maps shipped, render-blocking fonts, uncacheable vendor chunk.
- **Scope (only touch these):** Dockerfile, .dockerignore, render.yaml, DEPLOY.md, .env.example, apps/server/src/index.ts (headers/static), apps/server/src/config.ts, apps/web/vite.config.ts, apps/web/index.html, package.json scripts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **OPT-054** | Medium | S | Stage chunk is 774 kB (217 kB gz); vendor code isn't separately cacheable |  | `optimization.md` |
| [x] | **OPT-058** | Medium | S | Render-blocking Google Fonts on every route, duplicating the bundled woffs |  | `optimization.md` |
| [x] | **SEC-012** | Medium | S | No HTTP security headers (CSP, frame-ancestors, HSTS, nosniff, Referrer-Policy) |  | `security.md` |
| [x] | **SEC-013** | Medium | S | Production hardening hinges on NODE_ENV alone; the documented Docker path turns it off | OPT-073 | `security.md` |
| [x] | **OPT-006** | Low | S | config.publicBaseUrl is dead; env vars are read around config; .env.example is incomplete |  | `optimization.md` |
| [x] | **OPT-055** | Low | S | The 3d-tiles plugins barrel drags in pmtiles, fflate, pbf and vector-tile |  | `optimization.md` |
| [x] | **OPT-056** | Low | S | qrcode is loaded on every trip page via crew.tsx |  | `optimization.md` |
| [x] | **OPT-057** | Low | S | @simplewebauthn/browser is bundled into TripShell eagerly |  | `optimization.md` |
| [x] | **OPT-059** | Low | M | Production serving and deploy leftovers | TR3-017 | `optimization.md` |
| [x] | **OPT-072** | Low | S | The root npm test runs only server tests; typecheck and build aren't gated |  | `optimization.md` |
| [x] | **SEC-021** | Low | S | Container runs as root with dev dependencies and a TS runtime; .dockerignore gaps |  | `security.md` |
| [x] | **SEC-022** | Low | S | /api/health publicly discloses configuration and usage |  | `security.md` |
| [x] | **SEC-024** | Low | S | Production bundle ships source maps; Vite dev server disables host checks |  | `security.md` |
| [x] | **SEC-025** | Low | S | Organizer and dev debug view reveals decline reasons by name; the dev key travels in query strings |  | `security.md` |
| [x] | **SEC-026** | Info | S | Socket.io reflects any Origin (cors: { origin: true }) |  | `security.md` |

**Notes:**
- **SEC-013 (+OPT-073)** — `config.ts resolveMode()`: production = `NODE_ENV=production` or `APP_ENV=production` or a `PUBLIC_BASE_URL` on a non-localhost host (only `APP_ENV=development` can keep a tunnel URL out of production; `NODE_ENV=development` can't). Dev mode (open dev routes) needs an explicit signal: `APP_ENV=development`, `npm run dev` (`npm_lifecycle_event=dev`) or the test runner; a bare `npm start` is neither (dev routes need the key). When production is derived, `process.env.NODE_ENV` is set to `production` so express and passkeys.ts agree. `productionProblems()` → index.ts exits 1 in production with `DEV_KEY` < 32 chars / `change-me` or without `PUBLIC_BASE_URL`. `.env.example` no longer ships `NODE_ENV`/`change-me`/a public URL. Startup log prints the mode. The .env loader now reads `KEY=   # comment` as empty (it used to yield "# comment" — which would have set e.g. `VITE_GOOGLE_MAP_TILES_KEY`/`TRUST_PROXY_HOPS` to garbage).
- **SEC-025** — new `api/devAccess.ts`: `devAllowed` = dev mode, or `X-Dev-Key` (constant-time) or a signed cookie; `?key=` is ignored. Browser flow: `/api/debug/<code>` without access returns the sign-in form (403); `POST /api/debug/login` (form) sets `aa_dev` (HMAC with a per-process secret, 1 h, HttpOnly, SameSite=Strict, Path=/api/debug, Secure in prod) and 303s back (redirect target whitelisted to `/api/debug/<id>`). Failed sign-ins: 10/min per IP, logged. The debug view shows `crew-<sha256 6>` instead of names (seals and member audiences) and no decline reasons.
- **SEC-022** — public `/api/health` = `{ ok, eleven, degraded }` (`eleven` stays because the phone's voice button reads it; `degraded` = WP-10's persistence alarm). Everything else (mongo, persistence block, gemini, payments, voyages, budgets …) only with dev access.
- **SEC-012** — hand-rolled `securityHeaders()` in new `src/web.ts` (no helmet): CSP `default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:` (troika's blob workers + importScripts), `connect-src 'self' wss://<PUBLIC_BASE_URL host> wss://<Host> https://tile.googleapis.com` (+ `ws://<Host>` outside prod), `img-src 'self' data: blob: tiles`, `media-src 'self' blob:`, `font-src 'self' data:`, `style-src 'self' 'unsafe-inline'` (debug page), `object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`; plus nosniff, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP same-origin, `Permissions-Policy: xr-spatial-tracking=(self), microphone=(self), camera=(), geolocation=(), payment=(), usb=()`, HSTS 1y+includeSubDomains in production. Headless Chrome against the production build (phone, /demo, gallery with three+troika, /xr): no CSP violations. troika's unicode-fallback CDN (jsdelivr) is intentionally not allowed (text.ts keeps text inside the bundled glyphs).
- **SEC-026** — io.ts: `cors.origin` + `allowRequest` via `web.ts originAllowed()`: no Origin (token clients) OK; same origin (Origin host = Host), `PUBLIC_BASE_URL`, `CORS_ORIGINS`; outside production also localhost/LAN/`.local`/`*.trycloudflare.com` (Vite's proxy rewrites Host). Foreign Origin in production → 403 at the handshake.
- **OPT-059 (+TR3-017)** — `web.ts mountWeb()`: serves the build only when `config.serveWeb` (production or `SERVE_WEB=1`; `WEB_DIST` overrides the path), `/assets/*` `public, max-age=31536000, immutable`, other public files 1 h, `index.html` `no-cache`, `*.map` 404 in production, a missing file with an extension → 404 (not index.html), SPA regex `^(?!\/(api|socket\.io)(\/|$))` (so `/apiary` is an app route). index.ts adds a JSON 404 for unknown `/api/*` after the router (WP-09's TR3-006 may add one inside the router; harmless). Server is compiled by `apps/server/scripts/build.mjs` (esbuild, deps external, `@all-ayes/shared` bundled, dataset.json copied) → `node apps/server/dist/index.js` (`npm run start:prod`); `npm start` still runs tsx for local use.
- **SEC-021** — multi-stage Dockerfile: build stage (full install, `npm run build`, deletes `*.map`), runtime stage `npm ci --omit=dev --workspace=@all-ayes/server` (verified locally: 128 packages, no vitest/tsx/typescript/vite/three), copies server dist + web dist, `NODE_ENV=production`, `USER node`, `CMD node apps/server/dist/index.js`. `.dockerignore` adds `.env*` (keeps `.env.example`), `**/dist`, `**/.cache`, logs, `apps/server/test`, web `*.test.ts`, `docs`, root `scripts`, `.claude`. Docker daemon wasn't running, so no `docker build`; the runtime install + compiled server + prod smoke were run by hand from a scratch copy.
- **SEC-024** — `sourcemap: "hidden"` (no `sourceMappingURL` in any chunk; `VITE_SOURCEMAP=off` skips maps), maps deleted in the image and 404 in production anyway. Vite `allowedHosts`: localhost, `.localhost`, 127.0.0.1, `.trycloudflare.com`, `PUBLIC_BASE_URL`'s host, `VITE_ALLOWED_HOSTS` (verified on the running :5173: `Host: evil.example` → 403, `*.trycloudflare.com` → 200).
- **OPT-054 / OPT-055 / OPT-056 / OPT-057 / OPT-058** — `manualChunks`: `three`, `troika` (+bidi-js, webgl-sdf-generator), `3d-tiles`; warning limit back to 800. CityTiles imports `3d-tiles-renderer/src/three/plugins/{GoogleCloudAuthPlugin,ReorientationPlugin}.js` instead of the plugins barrel. `qrcode` is `import()`ed inside `QR`'s effect; `@simplewebauthn/browser` inside `approveWithPasskey`. Google Fonts `<link>`/preconnects removed; `@font-face` (font-display: swap) in tokens.css on the bundled `/textures/type/*.woff`; `index.html` preloads `source-serif.woff` only. Missing weights/italics (Source Serif 600, italics) are browser-synthesised.
- Chunks (min / gzip), before → after: Stage 783.2/220.0 kB → Stage 75.1/26.6 + three 636.2/163.2 + troika 116.6/43.1 (three hash unchanged across builds with app-only changes); TripShell 67.0/22.2 → 58.4/19.4 (webauthn now a 9.1 kB lazy chunk); crew 27.2/10.6 → 1.8/0.9 (qrcode = lazy 25.8 kB `browser` chunk); XRPage 37.9 → 19.0; Google-tiles chunks (index.plugins 186.3 + MemoryUtils 65.5 + tiles 93.0 + fflate/pmtiles/pbf ≈ 380 kB) → one lazy 3d-tiles 117.0/33.4 kB; first paint no longer waits on fonts.googleapis.com.
- **OPT-072** — root `npm test` = server + web tests (web got `"test": "vitest run src"`); `typecheck`; `check` = typecheck + test + build; root `build` builds web and server; `start:prod`. No bundle-size guard script (the 800 kB Vite warning is the tripwire).
- **OPT-006** — `config.publicBaseUrl` (normalized origin) now drives the production switch, CSP and socket origins. `.env.example` documents every key the code reads (added `APP_ENV`, `CORS_ORIGINS`, `SERVE_WEB`, `WEB_DIST`, `PAIRING_SECRET`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID`, `DATA_DIR`, `CACHE_DIR`, `RESTORE_RECENT_DAYS`, `ELEVEN_STT_MODEL`, `SEAL_DEADLINE_MS`, `DEMO_REPLAY`, `API_URL`, `VITE_ALLOWED_HOSTS`, `VITE_SOURCEMAP`).
- Tests: new `apps/server/test/hardening.test.ts` (10: mode resolution, startup refusal, headers/HSTS, minimal health, header/cookie-only dev access + forged cookie + open-redirect guard, redacted debug view, JSON 404 + `/apiary`, cache headers/maps/missing assets, socket origin 403). Gates (2026-09-25): server tsc clean (excluding WP-09's scratch `src/_wp09_tmp.ts` when present), vitest 254/254; web tsc clean, vite build OK, web vitest 26/26. Production smoke (`NODE_ENV=production PORT=8799`, compiled server + scratch web build): `/` 200 html no-cache + all headers + HSTS; `/api/health` public `{ok,eleven,degraded}`; hashed asset immutable; `/api/nope` JSON 404; `/apiary` html; `.map` and missing asset 404; foreign-Origin socket 403; `?key=` 403; weak DEV_KEY / missing PUBLIC_BASE_URL → exit 1.
- **Deferred / for others:** passkeys.ts, visaVic.ts, orchestrator.ts (`SEAL_DEADLINE_MS`), service.ts (`RESTORE_RECENT_DAYS`, `PAIRING_SECRET`) still read `process.env` directly (outside this scope; passkeys' tests toggle env at runtime) → WP-14. The client still accepts legacy `?as=` seat links (session.ts, one-time server-side handoff codes; WP-16). esbuild is used via tsx/vite's copy (not a direct devDependency — lockfile left untouched while other WPs run). Render persistent disk + `USER node`: if the mounted `/var/data` is root-owned, `DATA_DIR` falls back to RAM with a `[store] … not writable` warning — check `degraded` after the first deploy (DEPLOY.md says so). The debug view's seal refs hash the member id while event-audience refs hash the name (the service log stores names), so the two don't match. `test/e2e.test.ts` TR1-015 ordering assertion is flaky (~1 in 6 runs: the gallery's `seal:status` arrives before the headset has seen `booking:created`) — a test race, unrelated to WP-08 (WP-16).

## WP-09

### Typed contract & error semantics

- **Status:** done
- **Wave:** 3  ·  **Depends on:** WP-03, WP-07
- **Why:** The socket contract isn't typed on the server (how the Watch bug slipped through); bad input gives 500s; errors can't be tied to the action that caused them.
- **Scope (only touch these):** apps/server/src/realtime/io.ts, apps/server/src/api/routes.ts (error handling), packages/shared/src/events.ts, apps/web/src/net/api.ts, apps/web/src/net/tripStore.ts (emit typing/outbox), new apps/server/test/contract.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **OPT-062** | High | M | The Socket.io contract is untyped on the server | TR3-004, OPT-065 | `optimization.md` |
| [x] | **OPT-067** | Medium | S | Event-contract test (server emits vs shared contract vs client handlers) |  | `optimization.md` |
| [x] | **TR3-005** | Low | S | Body-parse failures and non-JSON bodies return 500 INTERNAL instead of 4xx | SEC-020 | `trace-3-transport.md` |
| [x] | **TR3-006** | Low | S | api.ts parses error bodies as JSON unguarded, and unknown /api/* routes answer with HTML | TR1-014 | `trace-3-transport.md` |
| [x] | **TR3-007** | Low | M | Socket errors carry no event correlation; TABLE_FAILED goes to the whole room; some actions no-op with no reply |  | `trace-3-transport.md` |
| [x] | **TR3-008** | Low | S | The polling fallback is never used |  | `trace-3-transport.md` |
| [x] | **TR3-009** | Low | S | The offline outbox is unbounded, has no expiry, and queues debug logs |  | `trace-3-transport.md` |
| [x] | **TR3-013** | Low | S | HTTP status semantics |  | `trace-3-transport.md` |

**Notes:**
- Contract (packages/shared/src/events.ts): every C2S event takes an optional ack `(r: Ack) => void` (`{ok:true}` | `{ok:false,code,message}`); `error` payload gains `event?` (the C2S event it answers); new public S2C `table:failed {code:"TABLE_FAILED",message}` replaces the room-wide `error`. New types `Ack`, `AckFn`, `ErrorPayload`, `PrivateEvent`, `TripRoomEvent`, `S2CPayload`, `C2SPayload`; exhaustive runtime lists `SERVER_TO_CLIENT_EVENTS` / `CLIENT_TO_SERVER_EVENTS`. All existing names and payload shapes unchanged. `brief:private.brief` no longer carries `_id`.
- Server: `Server<C2S,S2C,…,SocketData>`; `Bus`/`toTrip`/`toMember`/`replay` generic over the contract (`toTrip` only `TripRoomEvent`). io.ts validates every payload (BAD_INPUT 422, no `[io]` stack) and answers acks; unknown dryrun action → BAD_INPUT. routes.ts: `jsonBody()` (never undefined), `HTTP_STATUS` code→status map, `/trips/:tripId` looked up first (404 NO_TRIP), JSON 404 as the router's last handler, `entity.parse.failed` → 400 BAD_JSON.
- Web: tripStore typed without `as never`, `tryAllTransports: true` (TR3-008: polling works through the Vite proxy and cloudflared; server already accepts both), bounded/expiring/deduped outbox flushed after the join ack, `table:failed` ignored on the Gallery, `handled` set. api.ts never throws SyntaxError (ApiError with status; network failure = status 0 OFFLINE); passkey option/response types from `@simplewebauthn/browser`.
- Tests: apps/server/test/contract.test.ts (8), apps/web/src/net/contract.test.ts (6), apps/web/src/net/api.test.ts (4).
- Deferred: (1) the phone's `useSendGuard` (phone/TripContext.tsx, out of scope) still re-opens on any `error`; it should resolve from its own ack (`store.emit(ev, p, ack)`) or filter on `error.event`. (2) passkey.ts `opts as never` casts are now removable (out of scope). (3) the orchestrator still silently no-ops `seal:set` on a non-PENDING seal / `seal:cancel` after ALL_AUTHORIZED; the ack now resolves `{ok:true}` so buttons don't hang, but a `SEAL_LOCKED` refusal belongs in WP-14. (4) 401 is not used: member tokens are capabilities, so a missing token is 403 (keeps limits.test's 403 expectation).

## WP-10

### Persistence integrity & restore

- **Status:** done
- **Wave:** 3  ·  **Depends on:** WP-04, WP-06
- **Why:** Boot can crash on a dangling reference; writes are unordered fire-and-forget; Mongo down at boot = silent memory-only; schemas drift from the spec.
- **Scope (only touch these):** apps/server/src/store/**, apps/server/src/trips/service.ts (save/restore), apps/server/test/restore.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **TR5-002** | High | S | Dangling references crash boot (restore) or every trip:join (state) |  | `trace-5-persistence.md` |
| [x] | **TR4-002** | Medium | M | Undocumented and unguarded trip transitions; no optimistic version check |  | `trace-4-service.md` |
| [x] | **TR5-005** | Medium | M | Fire-and-forget replaceOne of live objects has no ordering/version guard and swallows failures | OPT-041, OPT-063 | `trace-5-persistence.md` |
| [x] | **TR5-007** | Medium | S | Mongo unavailable at boot means permanent memory-only mode with no reconnect or alarm |  | `trace-5-persistence.md` |
| [x] | **TR4-015** | Low | S | Voice hop details: audioUrl isn't persisted immediately and replay drops durationMs |  | `trace-4-service.md` |
| [x] | **TR5-010** | Low | S | The driver stores undefined as null; restored docs diverge from the types and from the JSON-based restore test |  | `trace-5-persistence.md` |
| [x] | **TR5-011** | Low | S | Dry-run clock, void reason and debug log aren't persisted, so replay after restart differs from before |  | `trace-5-persistence.md` |
| [x] | **TR5-012** | Low | M | Turns are embedded in the trip doc (spec: turns collection), so each turn rewrites the whole voyage |  | `trace-5-persistence.md` |
| [x] | **TR5-013** | Low | S | The events collection drifts from spec, is unbounded, never read, and swallows errors |  | `trace-5-persistence.md` |
| [x] | **TR5-014** | Low | S | Persisted schemas diverge from docs/04 §4 (names, embedded vs separate collections) |  | `trace-5-persistence.md` |
| [x] | **TR5-015** | Low | S | Bookings duplicate each member's private cap |  | `trace-5-persistence.md` |
| [x] | **TR5-016** | Low | M | Restore loads all history into memory with no archival |  | `trace-5-persistence.md` |
| [x] | **TR5-021** | Low | S | AT_TABLE → BRIEFING reset on restore is neither persisted nor announced |  | `trace-5-persistence.md` |
| [x] | **TR5-022** | Low | S | Plans are rebuilt from the dataset on restore, but dataset drift isn't detected |  | `trace-5-persistence.md` |

**Notes:**
- **Write path (TR5-005/OPT-041/OPT-063):** `store/writeQueue.ts` — one write in flight per (collection,_id), later persists coalesce to the latest snapshot (`structuredClone` at dispatch), retry with backoff (250 ms→30 s, 8 tries, then parked and retried on reconnect / next persist), E11000 on a non-`_id` key parked at once. `db.ts` writes `trips`/`bookings` with `{_id, version ≤ doc.version}` (a stale snapshot is skipped, counted). `persist` is typed by a `Docs` map (`as never` casts gone from service.ts; `memories`/`backboard_assistants` are in `Docs`, so WP-11 can drop its `persistMem` cast). `/api/health` has `persistence: {mode, degraded, writes{…failed,lastError}, eventErrors}` (routes.ts, one line).
- **Reconnect (TR5-007):** `store/reconnect.ts`; boot connect failure → background retry 1 s→60 s; on connect the helm merges stored voyages it lacks and re-persists everything in memory (`syncAfterReconnect`). Index creation separate from connect (errors logged). Did **not** make production exit without Mongo (index.ts out of scope): it logs an error and reports `degraded`.
- **Schema changes:** `trips` loses `negotiation.turns` (new `turns` collection, `_id`=turnId, `{tripId,round,seq}` unique) and gains `negotiation.round`, `dryrun{startedAt,pausedAt}`, `shortlistPlans` (server-only snapshot of the Two Charts), `datasetHash`, `tableReset{at,reason}`. `bookings` gain `version`, seals lose `capCents` (re-derived from `briefs` on restore). `events` are `{tripId,type,audience:"trip"|"member:<id>",payloadRedacted,at}` with a 30-day TTL. New indexes: `passkeys.memberId`, `trips.{status,updatedAt}`, `bookings.status`, `events.at` TTL, `turns`. Older docs (embedded turns, caps in seals, legacy events) still restore.
- **State machine (TR4-002):** `TRANSITIONS` table + `transition()` in service.ts; the only `.status =` left (a test enforces it). Recovery edges added to docs/04 §5. `expectVersion` is supported by `transition()`, but clients don't send a version (io/routes out of scope). The doc says so.
- **Restore (TR5-002/016/021/022):** per-voyage try/catch; dangling member ids dropped; a sealed-without-brief member is unsealed, and a DRY_RUN/VOIDED voyage goes back to BRIEFING with `tableReset`. AT_TABLE→BRIEFING is saved and replayed as `error {code:"TABLE_INTERRUPTED"}` (6 h). Boot loads non-final voyages plus those updated in the last `RESTORE_RECENT_DAYS` (7), plus every unsettled/needsAttention booking. `hydrate({tripId|joinCode})` loads the rest on demand. **Follow-up (WP-14/WP-07):** `trip()`/`tripByCode()` stay sync, so a miss starts the load and throws `503 LOADING` ("try again"). routes.ts `by-code` and io.ts `trip:join` should `await helm.hydrate(...)` first, so the user never sees the retry. This also covers voyages WP-07's sweep evicted.
- **Docs:** docs/04 §4 is rewritten to the as-built schema (§4.1–4.10), with §5 edges and a §7.3 replay line. WP-07's §12 sentence "drops … dry-run clock" is now stale (the clock is persisted on the trip); leave it for WP-17.
- **Known:** `joinCode` uniqueness is checked in memory only, so an archived voyage's code could collide (1 in ~10⁹; the write is parked and shows in health). Passkeys aren't re-flushed by `syncAfterReconnect` (owned by passkeys.ts). `test/e2e.test.ts` "Expo run over the wire" is flaky (`booking:created` ordering, ~1 in 3 locally) and was flaky before WP-10 too.
- **Tests:** `test/persistence.test.ts` (13, one per item), `test/store.test.ts` (9: queue ordering/coalescing/retry/stale, reconnect, normalize, health), `test/support/fakeDb.ts` (BSON-semantics fake with filters). `restore.test.ts` now restores from what the helm actually persisted. The `passkeys.test.ts` mock gained `loadWhere`/`onDbConnected`/`dbHealth`.

## WP-11

### Local file stores & test isolation

- **Status:** done
- **Wave:** 3  ·  **Depends on:** WP-06
- **Why:** Container disk is wiped on deploy; JSON stores write non-atomically; tests pollute the real memory file that ships in the image; memory recall hits disk/network on every join.
- **Scope (only touch these):** apps/server/src/memory/memory.ts (storage), apps/server/src/config.ts (dataDir/cacheDir), apps/server/vitest config + test setup, new apps/server/src/util/jsonStore.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **OPT-039** | High | S | Memory recall (network or sync disk) on every member join and replay |  | `optimization.md` |
| [x] | **TR5-008** | Medium | M | Ephemeral disk loses the Backboard assistant mapping, local memory and turn audio on every deploy |  | `trace-5-persistence.md` |
| [x] | **TR5-009** | Medium | S | Local JSON stores use non-atomic read-modify-write, and assistantFor loses updates | OPT-024 | `trace-5-persistence.md` |
| [x] | **TR5-017** | Low | S | The Docker image ships test-polluted memory.json, and tests write the real data dir | TR4-008 | `trace-5-persistence.md` |
| [x] | **TR5-019** | Low | S | Read-only filesystem can crash boot or silently disable memory and voice |  | `trace-5-persistence.md` |

**Notes:**
- **OPT-039:** memory.ts serves recall from memory. The local store (file or Mongo) is loaded once per process, async. A Backboard thread is fetched once per person (30 min TTL, `remember` keeps it fresh), and concurrent recalls share one fetch. After a Backboard failure, recall uses the local copy for 60 s. service.ts is unchanged: `replay` still awaits `recall`, which is now a map lookup after the first join. Not done: sending `brief:private` before recall resolves (service.ts is out of scope).
- **TR5-008:** `DATA_DIR`/`CACHE_DIR` are configurable (config.ts). With MongoDB connected, local memory and the personKey → Backboard assistant map live in `memories`/`backboard_assistants` (`{_id: key, v}`, appended to db.ts `COLLECTIONS`, loaded once via `loadAll`). Without MongoDB they go in `DATA_DIR`. render.yaml mounts a 1 GB disk at `/var/data` (DATA_DIR=/var/data/data, CACHE_DIR=/var/data/cache), and DEPLOY.md has a *Storage* section. Turn audio is cache-only and regenerable. Not done: clearing `audioUrl` on restore when the mp3 is gone (voice.ts/service.ts, WP-07/WP-10).
- **TR5-009 / OPT-024:** new `util/jsonStore.ts`: atomic tmp+rename writes, serialized read-modify-write, corrupt file kept as `.corrupt-<ts>`, and an unreadable file is never overwritten. `assistantFor` has one in-flight creation per key and a serialized map update, so there are no duplicate assistants and no lost keys. Not done: `data/loader.ts` still has its own sync read (out of scope; WP-14 can reuse `readJson`).
- **TR5-017 / TR4-008:** `apps/server/vitest.config.ts` has a `globalSetup` (one temp root per run, removed at teardown) and a `setupFiles` step that gives each test file its own `DATA_DIR`/`CACHE_DIR`. Tests no longer touch `apps/server/data` or `.cache`: checksum and mtime of `memory.json` are unchanged after two full runs. `apps/server/data/memory.json` held 266 test-polluted threads and was reset to `{}` (the seed writes Maya's "conceded" line itself). `.dockerignore` excludes `apps/server/data`.
- **TR5-019:** memory.ts no longer creates a directory at import. The store creates it lazily. If a write fails, the store warns once and keeps the data in memory. `remember` still posts to Backboard when the local write fails. `memoryHealth()` in memory.ts reports `{store, local, degraded}`.
- **Hand-offs:** (1) `/api/health` should include `memory: memoryHealth()` (routes.ts is not in scope; WP-09/WP-14). (2) voice.ts still calls `mkdirSync(textCacheDir)` at import, and on a read-only FS that throws EROFS during boot. WP-07 owns voice.ts: wrap it in try/catch. voice.ts already reads `config.cacheDir`, so it honours `CACHE_DIR`. (3) db.ts `Docs` (WP-10) doesn't list the memory collections, so memory.ts casts `persist` (`persistMem`). Add `memories`/`backboard_assistants` to `Docs` and drop the cast. (4) `.gitignore` ignores only `memory.json`. Consider adding `apps/server/data/`.
- **Tests:** `test/storage.test.ts` (8 tests) covers temp-dir isolation, 50 concurrent updates (no lost update, no tmp files, one load), a truncated file kept as `.corrupt-*`, a read-only dir (one warning, no throw), local recall loaded once across 10 rejoins of 3 members, Backboard (one GET and one assistant per key under concurrent recalls, no GET after `remember`), MongoDB-backed memory surviving a fresh process, and an unwritable `DATA_DIR` still posting to Backboard.
- **Gate:** in a clean HEAD worktree plus only the WP-11 changes, `tsc` and `vitest run` passed twice in a row (17 files, 196 tests, including the e2e "conceded" check). The main tree's tsc currently fails in routes.ts/service.ts/db.ts because WP-07/WP-10 are mid-edit. Pre-existing flake: the TR1-015 check at e2e.test.ts:114-117 reads `xr.events` without waiting, and under heavy CPU load it can see neither event (`-1 < -1`). HEAD fails the same way. It should `waitFor` `seal:status` on each client first.

## WP-12

### Privacy filter & negotiation quality

- **Status:** done
- **Wave:** 3  ·  **Depends on:** WP-02
- **Why:** Privacy context built in 3 places from different plan sets; weak fallbacks; hail path gaps; the Brief note never reaches the mate; wrong dates line when no common window.
- **Scope (only touch these):** apps/server/src/privacy/**, apps/server/src/negotiation/**, apps/server/src/trips/service.ts (hail/datesLabel/privacy context)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **OPT-013** | High | M | Privacy filtering assembled in three places with different inputs | TR4-012 | `optimization.md` |
| [x] | **TR4-006** | Medium | S | Brief note / noteSource are validated and stored but never reach the Advocate |  | `trace-4-service.md` |
| [x] | **SEC-017** | Low | S | Privacy filter is bypassable and is a weak oracle for hails |  | `security.md` |
| [x] | **SEC-023** | Low | S | Prompt injection via your own hail or name steers your own mate's public line |  | `security.md` |
| [x] | **TR4-005** | Low | S | datesLabel asserts a common window that may not exist and ignores the chosen plan's window |  | `trace-4-service.md` |
| [x] | **TR4-010** | Low | M | Engine privacy fallback is act-agnostic, and the price validator discards lines instead of stripping amounts |  | `trace-4-service.md` |
| [x] | **TR4-011** | Low | S | Hail handling gaps: invented prices pass, the whole hail is replaced on leak, and extra or late hails are dropped silently |  | `trace-4-service.md` |

**Notes:**
- OPT-013 / TR4-012: one `buildPrivacyContext` in `privacy/context.ts`, built by `chartBook()` from the top-12 book (limit 50 → 12); passed into `NegotiationEngine` (new optional ctor arg) and used by `hail()`. Guards shared in `privacy/guard.ts` (`sanitizeSpoken`, `sanitizeHail`, `promptText`, `promptName`, `noteForPrompt`, `memoryForPrompt`). `io.ts client:log` (debugLog) not touched — outside scope.
- TR4-006: note → `wishes.private_note` for the member's own Advocate only (amount-free, sanitised); `noteSource` only with a note. Budget band dropped from memory in prompts (SEC-017).
- SEC-017: NFKC/zero-width/any-script digits/`_`, `$1 100`, `ninehundred`, `hundo`, `nine-oh-oh`, digit-by-digit words, arithmetic fold, per-member share talk, adverb name rewrite. Hails: every non-public amount is removed regardless of secrets (no oracle); only-an-amount hail → private `HAIL_AMOUNTS`.
- SEC-023: hail reaches the model as parsed tags only; names/notes/memory sanitised; facts labelled as data; impersonating output ("Captain:", "booking is confirmed") rejected → template.
- TR4-005: `datesLabel` → chosen plan's window, else common window, else null → OPEN "No dates suit everyone; we'll weigh the closest." (`writeMemories` gets the chosen plan's dates for free).
- TR4-010: retry prompt adds "Do not state any amount"; per-act `safeLine`; invented prices stripped (line kept); ribbons stripped too; rewrites counted.
- TR4-011: per-member single pending hail (`HAIL_WAITING`), late hails (`watch ≥ 3` or new `EngineIO.closeHails` before DECIDE) → `CAPTAINS_CALLING`; HAIL turn stamped with the Watch it's acted on. Errors go through the existing io `guard` → private `error`.
- Tests: `test/privacy-bypass.test.ts`, `test/engine-model.test.ts` (mocked Gemini), `test/hail.test.ts`, extra cases in `test/negotiation.test.ts`. Docs: 05 §3.1, §4, §7.1, §7.2, §11; 04 `table:hail` row.
- Deferred: phone copy for the new `HAIL_WAITING` / `HAIL_AMOUNTS` codes (web shows the server message generically); profanity post-filter (SEC-023 suggestion) not added.

## WP-13

### Phone UX fixes

- **Status:** done
- **Wave:** 3  ·  **Depends on:** WP-02, WP-05
- **Why:** Invite link vanishes when the crew hits 4 (High); stray late hails; voice buttons shown without STT; small flow gaps; duplicated recorder/voice code; whole-screen re-renders.
- **Scope (only touch these):** apps/web/src/phone/** (NOT Seal.tsx — WP-05; DryRun.tsx only after WP-02 lands)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **TR1-001** | High | S | The absent friend's invite link disappears when adding them fills the crew to 4 |  | `trace-1-phone.md` |
| [x] | **OPT-012** | Medium | S | Date-window formatting in six places |  | `optimization.md` |
| [x] | **OPT-014** | Medium | M | MediaRecorder logic copy-pasted in Hail.tsx and VoiceNote.tsx |  | `optimization.md` |
| [x] | **OPT-015** | Medium | S | Two speech/voice playback stacks; the phone one can hang |  | `optimization.md` |
| [x] | **OPT-047** | Medium | M | Whole-state subscriptions re-render every phone component on every socket event |  | `optimization.md` |
| [x] | **TR1-004** | Medium | S | A voice hail in its 1.5 s preview is sent after the Captain decides (or after leaving the Table), producing a stray error |  | `trace-1-phone.md` |
| [x] | **TR1-005** | Medium | S | The voice buttons stay visible when the server has no speech-to-text, and the server's reason is dropped |  | `trace-1-phone.md` |
| [x] | **OPT-027** | Low | S | Brief.tsx re-implements useSendGuard's error latch |  | `optimization.md` |
| [x] | **OPT-048** | Low | S | Dry Run screen ticks the whole screen at 4 Hz, with a second 4 Hz timer for a seconds countdown |  | `optimization.md` |
| [x] | **TR1-006** | Low | S | "Weigh anchor" is enabled with a crew of one and fails with TOO_FEW |  | `trace-1-phone.md` |
| [x] | **TR1-007** | Low | S | The "Sail without them" 2-minute timer is per mount; the organizer block on Wait is unreachable |  | `trace-1-phone.md` |
| [x] | **TR1-010** | Low | S | A typed hail is cleared before the server accepts it, and the length limits disagree |  | `trace-1-phone.md` |
| [x] | **TR1-012** | Low | S | Create goes to the Brief screen, not Muster (P2) |  | `trace-1-phone.md` |
| [x] | **TR1-013** | Low | M | Memory is shown as a banner but never pre-fills the Brief |  | `trace-1-phone.md` |
| [x] | **TR1-016** | Low | S | noteSource stays "voice" after the user hand-edits the transcript or clears the note |  | `trace-1-phone.md` |

**Notes:**
- **TR1-001** — phone/screens/Muster.tsx: invite links are held by Muster (`useInvites`, :80, sessionStorage `aa:invites:<tripId>`), not by the add-friend form, so the crew reaching 4 (which hides the form) no longer loses the link. Every absent friend who hasn't sealed gets an `AbsentInvite` block (:97) with the QR + copy line, or, if this tab doesn't have the link, "Make a new link for X". **Server addition (organizer only):** `TripService.reissueInvite(tripId, actor, memberId)` + shared `mintInvite` (service.ts, next to addAbsent) and `POST /api/trips/:tripId/absent/:memberId/invite` (routes.ts, above the claim route); the old key stops working; errors NOT_FOUND (not an absent member of this trip) / INVITE_CLAIMED (already opened). Client: `api.reissueInvite` (net/api.ts). Test: service.test.ts "TR1-001: the organizer can re-issue…". Live (Chrome, seeded Expo voyage): add Zed as 4th → form gone, "Send this to Zed" + QR + link shown; reload → "Show Zed's invite link"; cleared storage → "Make a new link" → new link claims 200; again → "They've already opened their link…".
- **OPT-012** — phone/format.ts `formatWindow(start,end,{year})` / `windowLabel(windows,id)` used by Brief, Seal, Booked (a cross-month window now reads "Mar 29–Apr 2"). Test: phone/format.test.ts. **Deferred:** scene/SceneDirector.ts `fmtWindow` (WP-15 scope) and server `datesLabel`/`labelFor` (WP-14; negotiation lines must not change) still have their own copies; moving the helper to packages/shared is left to them.
- **OPT-014** — phone/components/useRecorder.ts `useRecorder({maxMs,onBlob})` (hold or toggle, permission race, mic released on stop/unmount, cut-short takes dropped) + `transcribe`/`transcribeError`. Hail.tsx and VoiceNote.tsx are thin UIs now. (`api.hailAudio` kept as the transport; no new api.ts call.)
- **OPT-015** — phone/components/voices.ts: `speak()` (:92) has a word-count timeout cap (as scene/audio.ts), so a missing `onend` can't stall the queue; `waitForAudio(store, turnId, ms)` (:64) is a store subscription, not 120 ms polling. **Deferred:** a DOM-only shared `net/speech.ts` used by scene/audio.ts too (scene is WP-15's).
- **OPT-047** — TripContext.tsx: `useTripSelector(sel, isEqual)` (:56), `shallowEqual`, and memoised `useCrew()` (:94; stable until the crew changes). Converted: organizer widgets, HailDock, Table (reads only trip + turns; `turn:audioReady` no longer re-renders it; log split into memo'd `ShipsLog`), DryRun clock/timeline, Muster. `React.memo` on every screen's default export (the shell re-renders on every event; TripShell itself untouched — WP-06), `ChartCard`, `Row`, `TopDownChart`, `CrewList`, `SealRow`. `useTrip()` kept unchanged for TripShell.
- **TR1-004** — Hail.tsx: preview timer in a ref, cleared on unmount; the send re-checks `disabled` (ref) and a take in progress when the Captain decides is dropped, not sent. Note shown: "That one didn't go out: the Captain was already calling it." Server queueing not added (spec's "queued for next phase" stays unimplemented).
- **TR1-005** — `useVoiceAvailable()` (useRecorder.ts) asks `/api/health` once per page; both voice controls are hidden unless `eleven === true`; a NO_STT reply also turns them off. Catch blocks show `ApiError.message`. Live: eleven:false → no hail button, text box only.
- **OPT-027** — `useSendGuard<P>` now returns `[sent, mark(payload?), { payload, reset }]`; Brief uses it (payload = sealedAt before sending) instead of its own error latch.
- **OPT-048** — DryRun.tsx: `useDryrunMinute()` (:12) ticks only inside `<DryRunClock/>` and `<Timeline/>`, and only while the day runs (stops when paused or at dayEndMin); AutoPickNote ticks at 1 s (:107). Live: clock advances and "now" highlighting moves.
- **TR1-006** — organizer.tsx WeighAnchor: disabled until ≥ 2 crew; hint "Invite at least one friend first. A table needs two." (Muster's separate hint removed).
- **TR1-007** — organizer.tsx SailWithout: first-seen-unsealed time per member in localStorage `aa:unsealedSince:<tripId>` (:73), so navigation and reloads don't restart the 2 min; only members unsealed ≥ 2 min are offered. The unreachable organizer block on Wait.tsx is removed (Muster carries those controls). A server timestamp (e.g. joinedAt in CrewPublic) would also survive a device change — not added (server scope limited to TR1-001).
- **TR1-010** — Hail.tsx: box `maxLength` 160 (`HAIL_MAX_CHARS`, :11, matching the helm's truncation; local constant because packages/shared is being edited by another WP); the sent words are kept until my `turn:new` echo, and restored to the box if the helm refuses (SLOW_DOWN, HAIL_WAITING, HAIL_AMOUNTS, CAPTAINS_CALLING, BAD_INPUT). Live: two hails in 1 s → second text still in the box with the HAIL_WAITING copy.
- **TR1-012** — Create.tsx:32 goes to `/t/CODE/muster`.
- **TR1-013** — phone/memory.ts `prefillFromMemory()` reads the newest *booked* memory line (budget band → dial position, "liked:" activities → tag chips). Brief pencils these in once when no terms are on file, shows a `Pencil` icon (icons.tsx) on each pre-filled chip and a note under the dial, cleared when changed; banner shows the newest memory (was the oldest). Test: phone/memory.test.ts. Client-only parse of the existing memory string; structured memory from the server would be sturdier (deferred, server scope).
- **TR1-016** — Brief.tsx:151: noteSource is "voice" only while the text equals the last transcript; any edit or clearing → "typed"; an empty note is sent as typed.
- **Error copy** — phone/errors.ts: `errorCopy()` for HAIL_WAITING, HAIL_AMOUNTS, CAPTAINS_CALLING, SLOW_DOWN, CAPTURING, NEEDS_ATTENTION, TOO_FEW, NO_STT, INVITE_CLAIMED; `useInlineError(codes)` shows them by the control that caused them (Hail dock; Seal "Call it off" → CAPTURING; Voided "Back to the charts" → NEEDS_ATTENTION) and clears the shell's banner before paint so it isn't shown twice. **For WP-06:** TripShell.tsx still renders `state.error.message`; switching it to `errorCopy(state.error)` would give every other refusal the phone copy.
- **Booked.tsx** — WP-02's `planPrivate[planId].days` read is kept; only the date label moved to `formatWindow`.
- Gates: web tsc, vite build, `vitest run src` (4 files, 13 tests); server tsc + vitest (16 files, 188 tests).

## WP-14

### Server refactor (no behaviour change)

- **Status:** done
- **Wave:** 4  ·  **Depends on:** WP-03, WP-04, WP-06, WP-07, WP-09, WP-10, WP-11, WP-12
- **Why:** TripService is 596 lines with nine jobs; duplicated lookups/builders; casts and non-null assertions; dead exports.
- **Scope (only touch these):** apps/server/src/** (after waves 1–3 are merged)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **OPT-031** | High | L | TripService is a 596-line class with nine responsibilities |  | `optimization.md` |
| [x] | **OPT-018** | Medium | S | seal:private payload and the A/B public shortlist are built more than once |  | `optimization.md` |
| [x] | **OPT-019** | Medium | S | Text sanitizing, clamps and length limits scattered |  | `optimization.md` |
| [x] | **OPT-032** | Medium | M | buildPlan is 140 lines doing seven steps |  | `optimization.md` |
| [x] | **OPT-060** | Medium | S | Magic numbers and literals duplicating shared constants |  | `optimization.md` |
| [x] | **OPT-064** | Medium | S | Non-null ! on lookups that can fail |  | `optimization.md` |
| [x] | **OPT-070** | Medium | S | Hail privacy path and restore edge cases |  | `optimization.md` |
| [x] | **OPT-004** | Low | S | Unused exported symbols and methods |  | `optimization.md` |
| [x] | **OPT-007** | Low | S | Write-only fields | done by the final fixer | `optimization.md` |
| [x] | **OPT-008** | Low | S | The DRAFT trip status is unreachable | done by the final fixer | `optimization.md` |
| [x] | **OPT-009** | Low | S | The visa_sandbox provider path always falls back to SIM |  | `optimization.md` |
| [x] | **OPT-010** | Low | S | Unused parameters, no-op statements and ignored return values |  | `optimization.md` |
| [x] | **OPT-020** | Low | S | Plan-by-id lookup repeated at least eight times |  | `optimization.md` |
| [x] | **OPT-021** | Low | S | Backing tallies computed four ways | rules.ts half by the final fixer | `optimization.md` |
| [x] | **OPT-022** | Low | S | Crew lookups by linear find everywhere |  | `optimization.md` |
| [x] | **OPT-028** | Low | S | nanoid ref alphabet defined three times |  | `optimization.md` |
| [x] | **OPT-029** | Low | S | Dataset lookups by find scattered, with no index |  | `optimization.md` |
| [x] | **OPT-035** | Low | S | TripShell.tsx (283 lines) holds four components and routing policy | done by WP-16 | `optimization.md` |
| [x] | **OPT-036** | Low | S | routes.ts inlines a debug HTML page and all the passkey routes |  | `optimization.md` |
| [x] | **OPT-037** | Low | S | NegotiationEngine mixes orchestration with prompt construction |  | `optimization.md` |
| [x] | **OPT-038** | Low | S | Pointless thin wrappers |  | `optimization.md` |
| [x] | **OPT-045** | Low | S | Chart book limit and repeated crew mapping |  | `optimization.md` |
| [x] | **OPT-061** | Low | S | Env config casts are unchecked, and a script mutates config |  | `optimization.md` |
| [x] | **OPT-068** | Low | S | Shared helpers and input sanitization |  | `optimization.md` |
| [x] | **OPT-069** | Low | S | Dataset derivation, travel model and phrasing utilities |  | `optimization.md` |
| [x] | **OPT-071** | Low | S | Payload-budget and I/O-count regression tests |  | `optimization.md` |

**Notes:**

- **Part B (API / negotiation / data side)** — owns api/**, negotiation/**, fit/**, data/**, config.ts, passkeys/**, privacy/**, index.ts, web.ts, realtime/io.ts. New tests: `test/b-chartbook-snapshot.test.ts`, `test/b-prompts.test.ts` (+ `__snapshots__`), `test/b-helpers.test.ts`, `test/b-api.test.ts`. routes.ts 322 → 238 lines; engine.ts 272 → 219.
- Part B: **OPT-032** — `buildPlan` (140 → 24 lines) composes pure steps: `chooseFlights`, `arrivalsFor`, `placeGroupMoments`, `placePicks`, `legsAndFlags`, `memberView`, `sharedPublicFlags`. The "evening from the stay" rule is one `legFromStay()` shared with `publicDays`. Acceptance: `b-chartbook-snapshot` hashes the chart book + public/private views for 7 crews (taken before the change), plus pricing.test to the cent.
- Part B: **OPT-029** — `data/loader.ts` `indexOf(ds)`: frozen maps `city/hotel/activity/window` + `override(from,to)` (either direction, first listed wins, as `find` did), cached per dataset in a WeakMap. Used by pricing (`buildPlan`, `publicDays`, `toPublic`), phrasing (`highlights`, and group-moment names cached per dataset), rules (`offersTag`), prompts and `cityName`. *For Part A:* `dryrun/walking.ts:19` can use `indexOf(ds).override(from.id, to.id)`, and service.ts's `ds.cities.find` → `indexOf(ds).city.get`. Loading: kept one synchronous read (a bundled read-only asset every TripService needs in its constructor: one load, no race), now with a shape check that throws; `readJson` isn't used because it silently falls back, which is wrong for a required dataset.
- Part B: **OPT-069** — `b-helpers`: `shiftDay` (month/year/leap boundaries, negative), `deriveW2` (+8% rounded to $1, a day later), index lookups incl. a reversed override, the travel model (walk ≤ 2 km, ×1.4 hills, taxi beyond, reverse override), `clampToSentences`/`clampRibbon`, `parseHail`.
- Part B: **OPT-036** — `api/debug.ts` (`mountDebugRoutes`: login form/POST + the page), `api/passkeyRoutes.ts` (`mountPasskeyRoutes`, with its own rate limiter), `api/http.ts` (shared `bearer`, `h`, `jsonBody`, `ipOf`, `slow`, `param`, `esc`). routes.ts mounts both at the same points, so route order (voyage-exists check → routes → JSON 404) is unchanged.
- Part B: **OPT-037** — `negotiation/prompts.ts`: `advocateFacts`, `advocateLineRequest`, `captainLineRequest`, `openInstruction`, `decideInstruction`, `legalActs`, `modelChoiceRequest` (pure). The engine keeps orchestration; `engine.advocateFacts()` stays as a thin delegate (negotiation.test uses it). `safeLine` moved to phrasing.ts (it's a template). Dead `recent_lines: []` dropped from the facts — the prompt snapshot (taken before the move) differs by exactly that field and nothing else.
- Part B: **OPT-061** — `config.ts` `oneOf(key, allowed, default)` for `AGENT_DECISIONS`, `DEMO_REPLAY`, `PAYMENTS_MODE` (case-insensitive; an unknown value warns `[config] X=… is not one of …` and uses the default). `PORT`/`PACE_SCALE` use the checked `num()` (a non-number falls back to the default instead of NaN); `bool()` trims. `scripts/warm-voice-cache.ts` no longer mutates config: it sets `GEMINI_API_KEY=""`, `DEMO_REPLAY=live`, `PACE_SCALE=0` in the env and then imports config/service dynamically.
- Part B: **OPT-038** (my part) — `features.gemini` uses `features.cached()`; `phrasing.cityOf` removed (callers use `cityName`). `join`/`memoryFor` wrappers are service.ts (Part A).
- Part B: **OPT-004** (my part) — removed `NUMBER_WORD`/`mentionsNumbers` (filter.ts), `export type { Tag }` (engine.ts); un-exported module-internal `devKeyMatches`, `round1`, `favourite`, `np`, `withoutAmounts`, `contentSecurityPolicy`, `ASSERTION_TTL_MS`, `HTTP_STATUS`/`httpStatus`.
- Part B: **OPT-010** (my part) — `collectHails(_watch)` param dropped. **OPT-064** (my part) — no `!` left on lookups in fit/negotiation/api: `mustFind` (data/loader.ts; a miss names the id) in pricing/rules/prompts, `planById`/`view` exported from rules and reused by engine/phrasing/prompts; `apply()` no longer re-reads with `!`. (Dataset/plan misses are internal bugs, so a plain Error, not a HelmError; `util/errors.ts must()` is Part A's for socket-reachable sites.)
- Part B: **OPT-060** (my part) — pricing uses `clockToMin(EARLY_START_BEFORE)` (was `8 * 60` twice) and names `EVENING_MIN`/`NO_FLIGHT_FREE_FROM`. **OPT-019** (my part) — the hail transcript is cut to `HAIL_MAX_CHARS`, ribbons use `util/text` `clampWords(r, RIBBON_MAX_WORDS)`; phrasing's sentence-aware clamp is renamed `clampToSentences` so it isn't confused with util/text's `clampWords`. **OPT-068** (my part) — `b-helpers` tables for `formatCents` (negatives, thousands, padding), `formatDollars`, `minToClock` wrap, `clockToMin("7")`; `validateBrief` tests are service.ts (Part A).
- Part B follow-ups: **WP-10** routes `by-code`, every `/trips/:tripId` route (the voyage-exists middleware) and io `trip:join` first `await helm.hydrate(...)` (a DB error falls back to the old sync lookup), so an archived/swept voyage loads instead of 503 LOADING (b-api). **WP-11** `/api/health` detail view has `memory: memoryHealth()`. **WP-08** passkeys.ts reads `config.webauthn.origin()/rpId()/production()` (lazy getters, so passkeys tests that switch env at runtime still pass); `PasskeyDoc` is a type alias, so `persist("passkeys", toDoc(s))` needs no `as never`. The debug view resolves both the seal's member id and the event log's `member:<name>` to the member id, so one person has one `crew-xxxxxx` (b-api). **WP-10** `persistAllPasskeys()` (passkeys.ts) re-queues every in-memory credential and returns the count — for Part A's `syncAfterReconnect`. **WP-06** verified: `devAllowed` accepts only the `X-Dev-Key` header or the signed cookie; `/api/debug/…?key=` is 403 (hardening.test covers it).
- Part B deferred: the debug log itself could keep the member id instead of the name (service.ts `audienceLabel`, Part A) — then the view needs no name→id mapping. `/api/debug/:id` doesn't hydrate archived voyages (dev only).
- **Part A (service / payments / storage side)** — owns trips/**, payments/**, memory/**, voice/**, store/**, demo/**, util/**, dryrun/**, test/**. New test file `test/wp14-helm.test.ts` (16), plus 2 in `persistence.test.ts`. Server: 27 files / 304 tests, run twice; web tsc clean.
- Part A: **OPT-031** — service.ts 1384 → 106 lines: `TripService extends HelmCore` (trips/core.ts: records maps, emits + debug/audit log, `transition`, `save`/`persistTurn`, O(1) indexes, auth, sweep/evict) and delegates, with the same public names, to `crew.ts` (create/join/absent/invites/briefs/sail-without, `validateBrief`), `identity.ts` (headset pairing, demo handoffs), `table.ts` (chart book + privacy context, meeting, hails, Two Charts), `dryrun.ts` (votes, auto-pick, clock), `sealing.ts` (pick, seals, call-off, retry, outcome, memory notes), `replay.ts` (`state`, replay), `persistence.ts` (restore/repair/reconcile, reconnect sync, `hydrate`, `trip`/`tripByCode`). Types/constants/pure helpers are in `records.ts`; `HelmError`, `datasetHash`, `validateBrief` and the record types are re-exported from service.ts, so io.ts/routes.ts/db.ts/tests import as before. persistence.test's "one `.status =`" check now scans all of trips/*.ts.
- Part A: **OPT-018** — `table.publicShortlist(t)` (memoized per plan pair, WeakMap) feeds `table:decided` live and on replay; `sealing.sealPrivateFor(t, memberId)` is the one `seal:private` builder (pick + replay; replay now also falls back to "••••" if the card lookup fails). **OPT-020** `table.planOf(t, id)`; **OPT-022** `requireActive()` returns the member (no `members.get(id)!`); **OPT-021** (server side) one `tallies()` in records.ts, also used by `holdsSeat` — the rules.ts `backingCounts` half is negotiation (not done, left unticked for B/a follow-up).
- Part A: **OPT-019 / OPT-068** — new `util/text.ts`: `clean`, `clampWords`, `NAME_MAX_CHARS` 24, `TRIP_NAME_MAX_CHARS` 40, `HAIL_MAX_CHARS` 160, `RIBBON_MAX_WORDS` 8 (B imports it). Tests: clean/clampWords, formatCents/formatDollars/minToClock/clockToMin, validateBrief (dedupe, unknown ids, caps, `<script>`/control chars, cap range message). Moving the constants to packages/shared for the web `maxLength`s is left to WP-16.
- Part A: **OPT-060** — named constants in records.ts (`HAIL_MIN_INTERVAL_MS`, `PAIR_CODE_TTL_MS`/`_CHARS`, `DEVICE_TTL_MS`, `HANDOFF_TTL_MS`, `REPLAY_TURNS`, `MIN_TABLE_CREW`, `FIRST_HAIL_WATCH`, …), `MAX_CREW` in the "crew is full" copy, band ids from `BANDS`, origins from `ORIGINS`, the cap-range copy from `formatDollars(CAP_MIN/MAX_CENTS)`, `CHART_BOOK_LIMIT` (table.ts), orchestrator `LIVE_LIMIT_HEADROOM`/`LIVE_INSTRUCTION_TTL_MS`/`REFERENCE_CHARS`, voice.ts timeouts/pacing. **OPT-064** — `util/errors.ts` (`HelmError` moved here, `must()`); no `!` on lookups left in trips/**; `hail` builds a missing privacy context (`table.privacyOf`); `state()` skips an unknown city instead of crashing; `writeMemories` skips a member without a share. The three `!` left in orchestrator.ts are invariant-guarded (`authRef` after capture/authorize).
- Part A: **OPT-070** — tests: a hail stating a cap (redactions 1, no digits in text or ribbon), over-long hail cut to 160, `SLOW_DOWN` inside 5 s, hail with no privacy context in memory, a sailed-without member can't `submitBrief` (NOT_MEMBER).
- Part A: **OPT-004** — removed `abandon()` alias (orchestrator), `SEAL_DEADLINE_MS` export; un-exported `flushDb`, `publicSealOf`, `writeJsonAtomic`, `scopeTrip`, `haversineKm`, `CHART_BOOK_LIMIT`. (`Option` in shared types.ts is unused but left: types.ts is additive-only for this WP.) **OPT-010** — `hail()` returns void. **OPT-038** — `join` stays (facade), `memoryFor` is a real helper (memKey + recall), the `abandon` alias is gone.
- Part A: **OPT-028** — `util/ids.ts` `NO_LOOKALIKES` + `newRef(n)` (cached generators); join codes, pair codes, booking references and SIM refs use it. **OPT-045** — `startTable` prices the crew once and passes it to `chartBook`/`datesLabel`; the engine's bands come from the member list; memory notes build their "voyage: city, dates" head once (`table.voyageLine`).
- Part A: **OPT-009** — `payments/select.ts selectPaymentProvider(mode)`: `visa_sandbox` without `VISA_VIC_API_BASE`/`_KEY` warns and runs the SIM; with them, `createVisaProvider()` (visaVic.ts, a documented stub returning null) → warns "not wired" and runs the SIM. Either way `payments.mode` is `sim`, so phones/health label it Simulation. Test covers all three.
- Part A: **OPT-071** — tests: `trip:state` < 3 kB in BRIEFING/AT_TABLE/DRY_RUN/SEALING/BOOKED (Expo run); a table run persists each turn once (+1 when its audio lands), the trip doc exactly twice (start, decide), and no member/brief writes (persistence.test).
- Part A: **OPT-007 not done** — `endedReason`/`advocatedBy` are in the doc 04 §4.2 schema (analytics), kept and commented; `Brief.fromMemory` is also in doc 04 §4.4, and `Turn.redactions` is asserted by tests and read by the debug log — dropping them from the shared contract is a WP-17 docs decision. **OPT-008 not done** — the server never enters DRAFT (commented in `TRANSITIONS`), but the web still references it (TripShell.tsx, Brief.tsx, tripStore.ts, GalleryPage.tsx `Record<TripStatus,…>`), so removing it from `TripStatus` needs WP-16.
- Part A follow-ups: **WP-09** orchestrator `setSeal`/`cancelSeal` return `"ok" | "locked" | "none"`; the helm throws `SEAL_LOCKED` (409) for a tap on a seal that isn't PENDING (also a concurrent double tap, via an in-flight set) and for lifting a seal once the booking is ALL_AUTHORIZED/CAPTURED. **WP-04** the provider parameter is now `approvedWithPasskey?: boolean` (set when the passkey gate consumed an assertion; the token itself never leaves the gate; passkeys.test checks both); the wire field `assertionToken` is unchanged. `BookingPublic.sealDeadlineAt?` (shared types) is sent while the booking is PENDING/AUTHORIZING. `helm.debugSummary(tripId)` returns phase/watch/turns/tableRuns and the booking's `status`, `reference`, `needsAttention`, `sealDeadlineAt` (for the debug page). **WP-07** `startTable` refuses `TOO_MANY_RUNS` (429) after `TABLE_RUNS_MAX` (default 6) meetings per voyage (`TripRec.tableRuns`, persisted); test setup sets 1000. voice.ts creates its cache dir lazily on the first write (one warning, captions on failure); `persistTurn` stores the turn's `audioKey` (TurnDoc, server-only), and restore re-registers it when the mp3 is still cached, or clears `audioUrl`/`durationMs` when it isn't. **WP-11** `persistMem` cast removed; `brief:private` goes out at once and, if recall isn't ready within a tick, a second `brief:private` follows with the memory lines (submitBrief: brief → trip:state → memory; replay: brief first, memory after the private replay); e2e waits for the one with memory. `.gitignore` now ignores `apps/server/data/` (nothing there is tracked). **WP-10** `hydrate()` is documented on the facade (B wired it); `syncAfterReconnect` calls B's `persistAllPasskeys()`. **WP-08** no `process.env` reads left in orchestrator/visaVic/service: `util/settings.ts` reads `SEAL_DEADLINE_MS`, `RESTORE_RECENT_DAYS`, `TABLE_RUNS_MAX`, `PAIRING_SECRET`, `VISA_VIC_*` at call time (could move into config.ts).
- Part A deferred: web copy for `SEAL_LOCKED`/`TOO_MANY_RUNS` in `phone/errors.ts` (falls back to the server message) and a seal countdown from `sealDeadlineAt` (WP-16). `debugSummary` isn't shown on the debug page yet (api/debug.ts, B). The debug log still labels member audiences by name (B's view maps names to ids).
- **Final fixer (2026-09-25):** **OPT-008** — `DRAFT` removed from `TripStatus` (shared), `TRANSITIONS` (records.ts) and every web branch (tripStore, GalleryPage `STATUS_LABEL`, phase.ts + phase.test, Brief, JoinCrew); the server never entered it. **OPT-021** — `backingCounts(st)` in negotiation/rules.ts (plan → backers, first-backed order) now drives `mostBackedOther`, the hail candidates, the Watch 3 majority check, `consensus`, and the model prompt's `backed_by` (`modelChoiceRequest` takes the counts map); negotiation, b-prompts snapshots and the Expo script are unchanged. **OPT-007** — dropped the write-only `TripRec.negotiation.endedReason`, `TripRec.advocatedBy`, `EngineResult.advocatedBy` and `Brief.fromMemory` (shared + crew.ts). Kept: `EngineResult.endedReason` (negotiation.test reads it), the engine's in-meeting `TableState.advocatedBy` (the Captain's shortlist rule reads it), `Turn.redactions` (privacy tests and the debug log read it) and the client's `audio[].durationMs` (the ribbon write-on reads it since WP-15). Older documents may still carry the dropped fields, which is harmless. docs/04 §4 updated. **Part A deferred items:** `debugSummary` is now on the debug page (table runs, needs-attention banner, seal deadline with time left; test in b-api), phone copy for `SEAL_LOCKED` (by `error.event`: "Your seal is already set." / "Too late to lift — every seal is set.") and `TOO_MANY_RUNS` in phone/errors.ts (+ errors.test). `booking:created` now carries `serverNow`, and tripStore maps `sealDeadlineAt` onto the device clock (trip:state's booking too), so the Seal countdown is skew-free (tests in tripStore.test, wp14-helm, contract).

## WP-15

### 3D performance & scene refactor

- **Status:** done
- **Wave:** 4  ·  **Depends on:** WP-01, WP-02
- **Why:** ~45 MB of procedurally painted textures and paint hitches on Quest; draw-call heavy geometry; per-frame work; long classes.
- **Scope (only touch these):** apps/web/src/scene/**, apps/web/src/xr/** (after WP-01/WP-02)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **OPT-049** | High | M | Procedural canvas textures: large GPU memory and main-thread paint hitches on Quest |  | `optimization.md` |
| [x] | **OPT-033** | Medium | M | SceneDirector (449 lines) mixes state sync, turn playback, phase choreography and seals |  | `optimization.md` |
| [x] | **OPT-034** | Medium | M | DryRunCloche constructor is about 180 lines |  | `optimization.md` |
| [x] | **OPT-016** | Low | S | Seat geometry defined three times |  | `optimization.md` |
| [x] | **OPT-017** | Low | S | Speaker and act labels built in three places |  | `optimization.md` |
| [x] | **OPT-025** | Low | S | User-facing copy duplicated across server, phone and scene |  | `optimization.md` |
| [x] | **OPT-050** | Low | M | Draw-call heavy geometry in cloches and globe |  | `optimization.md` |
| [x] | **OPT-051** | Low | S | SceneDirector.sync() does work on every store event |  | `optimization.md` |
| [x] | **OPT-052** | Low | S | Per-frame string work in the carriage clock |  | `optimization.md` |

**Notes:**
- **Scope used:** apps/web/src/scene/** (new: `scene/director/{context,CrewSeating,TurnPlayer,PhaseController,SealCeremony}.ts`, `scene/{seats,labels,copy}.ts`), apps/web/src/xr/{XRApp,wristMenu}.ts (copy constants only), apps/web/src/gallery/GalleryApp.ts (speaker position), packages/shared/src/constants.ts (additive copy block). Not committed (per instructions).
- **OPT-049** — materials.ts: paper grain is one seamless 512² noise tile painted once and laid down as a pattern (`paintPaper`), so a 2048² sheet costs one fill instead of ~4.7k gradients + 7k strokes. Chart/globe/street plates are drawn in their designed logical px and scaled (`sheetTexture`); on Quest/Pico UA (or `?lowtex`) they are half-res (`LOW_TEX`/`sheetPx`). `sharedSheet` memoises chart, globe and street plates (per city seed, LRU 8) so DRY_RUN re-entry / void→retry / StrictMode remount never repaint. `paperCard` caps texels at 4096 px/m (2048 on headset) with the same drawing, and shares texture+material for identical cards (plain cards always; inked ones by `key`: buttons, weigh-anchor tag, letters, seal chart); ribbons use 5 mm width steps so they hit the cache. `disposeObject` skips shared textures/geometry; `Stage.dispose` calls `releaseSharedTextures()`; `SceneDirector.dispose` now disposes the whole root (chart/globe/pieces used to leak until context loss). Estimated GPU texture memory (all surfaces created, RGBA + mips): **before ≈72.5 MB** (sheets 44.1 + cards 28.4) → **after ≈61.7 MB desktop** (cards 17.6) / **≈17.8 MB headset** (sheets 12.1 + cards 5.7). Live Gallery at DRY_RUN: `renderer.info.memory.textures` = 8.
- **OPT-033** — SceneDirector 503 → 212 lines: it keeps the store subscription, queue, interactables, caption/rejection note and per-frame fan-out; CrewSeating (pieces + seats), TurnPlayer (instant/animated turns, voice, ribbon, shortlist marks), PhaseController (phase choreography, cloches, tiles, void card), SealCeremony (seal chart, pressed set, standing, tie). Shared state goes through `DirectorContext`.
- **OPT-034** — DryRunCloche constructor is ~15 lines calling `buildBase`, `places`, `buildCity`, `buildMarkers`, `buildRoutes`, `buildTag`; street texture moved to the shared-sheet cache.
- **OPT-016** — `scene/seats.ts` (`SEAT_R`, `CAPTAIN_POS`, `seatAngle`, `seatPoint`, `seatMap`); `SceneDirector.speakerPosition(turn)` used by GalleryApp (its copied angle table is gone; key 3 now follows the seat the piece actually uses, incl. the 0-others and fallback cases). Phone Table.tsx left alone (out of scope).
- **OPT-017** — `scene/labels.ts` `speakerLabel` + `drawsArcs` (no three import). Phone `who`/`actLabel` in Table.tsx not switched (phone screens are another WP's scope) — WP-13/16 can import it.
- **OPT-025** — shared (additive): `VOID_HEADLINE`, `BOOKED_HEADLINE`, `SEALING_FOOTER`, `BACK_TO_CHARTS`, `possessiveList`, `waitingOnTerms`. Scene copy lives in `scene/copy.ts` (`phaseCaption`, `CARD`, `HAIL_PRESETS`, `NARRATOR`); XRApp re-exports `HAIL_PRESETS`. The chart room's BRIEFING line now uses the phone's grammar ("Waiting on Ann's and Bo's terms…" instead of "Ann & Bo's"). **Deferred:** switch server orchestrator.ts `declined`, phone Voided/Booked/Wait/organizer (+ TripContext.possessiveList) and GalleryPage STATUS_LABEL to the shared constants — owned by the payments/phone fixers.
- **OPT-050** — DryRun: route legs merged into one vertex-coloured mesh per cloche (StripBuilder), stop needles/heads instanced, all beads one InstancedMesh (hidden = zero scale, updated only when the minute changes), shared geometries. Globe: pin needles + heads are 2 instanced meshes for all pins. Live Gallery DRY_RUN draw calls: 72. **Deferred:** pencil arcs stay one TubeGeometry each (per-arc draw-on animation needs its own draw range; ≤3 origins × few cities); troika labels not batched.
- **OPT-051** — `SceneDirector.sync` returns early unless `trip`/`turns`/`votes`/`booking`/`error` changed (audioReady, private events, connection flaps skip it); pins rebuilt only when `candidateCities` changes; seats recomputed only on roster change and crew sync skipped for the same `crew` array; `CaptainPiece.rise` returns before copy/lookAt when already standing; `CaptionStrip.set` short-circuits identical lines; the BRIEFING caption is re-set only when its text changes.
- **OPT-052** — `CarriageClock.setMinute` only formats/sets text when the 5-minute slot or day label changes.
- **WP-03 follow-ups** — SealChart: `WaxSeal.setStanding` driven from `booking.seals[].standing` via `SealCeremony.sync` (not `role === "absent"`; the "(away)" name suffix stays role-based); `tie(reference)` hangs a paper tag with the reference (mono) off the tied roll. InkRibbon: the paper unrolls in 400 ms, the handwriting is written on over `durationMs` (audioReady or `Turn.durationMs`, clamped 400–6000 ms) when voiced; roll-up mid-write just stops the write-on.
- **Invariants kept:** xr/input.ts untouched (input.test.ts green); interactables still a stable cached array (rebuilt only when cloches change); Weigh-anchor tag still needs ≥2 crew; scene reads only public state (no planPrivate/sealPrivate/declined); Dry Run beads unlabeled and unbanded.
- **Measurements:** 3D chunk `Stage-*.js` 775.37 kB (gzip 217.01) → 783.18 kB (gzip 219.95): +7.8 kB of scene code (director split, instancing/cache code, ref tag); three + troika dominate (~670 kB) and are unchanged.
- **Verified:** web tsc, vite build, `vitest run src` (16/16), server e2e (5/5; one earlier run hit a hook timeout while other fixers were running tests, re-run green). Live Gallery run (Chrome): BRIEFING → AT_TABLE (turns, arcs, captain rise, captions) → DRY_RUN (cloches, merged routes, instanced pins, bead cluster, clock) → SEALING (seal chart; Dev's standing seal pressed from `standing: true`) and a resume reload into SEALING; no console errors. BOOKED tie + reference tag not seen live (the phone seal needs a passkey) — typechecked only.
- **Visual note:** paper grain is now a tiled (seamless) 512² noise instead of unique noise per sheet — same density and contrast; cards/plates on the headset are lower resolution with identical drawing.

## WP-16

### Web tests & client dead code

- **Status:** done (WP-16 fixer, 2026-09-25)
- **Wave:** 4  ·  **Depends on:** WP-13, WP-15
- **Why:** The web app has zero tests; unused endpoints/CSS/dirs; Create hard-codes ports while /api/cities exists.
- **Scope (only touch these):** apps/web/** (tests + deletions), new apps/web/vitest config

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **OPT-066** | Medium | S | The web app has zero tests; add pure-logic tests with vitest |  | `optimization.md` |
| [x] | **OPT-005** | Low | S | /api/cities, api.cities and api.health are unused by the client, while Create.tsx hard-codes the ports |  | `optimization.md` |
| [x] | **OPT-011** | Low | S | Unused CSS and empty directories |  | `optimization.md` |

**Notes:**
- **OPT-066** — web tests 26 → 50 (7 → 12 files), all pure logic in node: `phone/phase.test.ts` (allowedScreens for every status × sealed × organizer, `screenOf`), `phone/errors.test.ts` (errorCopy), `shared-ui/seating.test.ts`, `scene/labels.test.ts`, `scene/copy.test.ts` (phaseCaption uses the shared headlines), `format.test.ts` +countdownLabel, `session.test.ts` +legacy `?as=` refused, `tripStore.test.ts` +7 (AT_TABLE→BRIEFING clears turns/audio/dryrun; duplicate/out-of-order turn:new; dryrun:script skew → same minute, pause/resume holds it, clamps at day end; seal:status patches only its booking; table:failed is a banner on phones not the Gallery; outbox: one per event + EXPIRED for the replaced tap, client:log dropped, cap, stale → EXPIRED on flush, refused join fails the queue). Root `npm test` already runs `npm test --workspace @all-ayes/web` (= `vitest run src`; WP-08) — verified. The reducer was not extracted into `net/reducer.ts`: the handler-feeding harness already tests it through the real store. vitest resolves from the root node_modules (no web devDependency added, lockfile untouched). Not covered: React hooks (useSendGuard, useTwoTap) — no DOM test env.
- **OPT-005** — Create.tsx loads the ports from `api.cities()` (all on by default; notes as the chip `title`; if /cities fails it sends no `cityIds` and the helm uses every port). The origin line comes from `ORIGINS`/`ORIGIN_COORDS`. The date label stays literal ("Mar 12–16, 2027"): /cities has no date windows. Every other client API fn is used (`api.health` now backs `useVoiceAvailable`, so it stays).
- **OPT-011** — removed `.smallcaps`, `.card.tight`, `--band-1..4`, `--graphite` (light + both dark blocks); deleted empty `apps/web/public/fonts` and `public/sfx`. Root `scripts/` was already gone.
- **OPT-035** — TripShell.tsx 323 → 111 lines (link/session bootstrap + Aboard). New: `phone/phase.ts` (`Screen`, `allowedScreens`, `screenOf`), `phone/seatClaims.ts` (claimOnce/redeemOnce), `screens/JoinCrew.tsx` (uses `MAX_CREW`), `screens/PhaseRoutes.tsx` (phase guard + routes); `CrewDoor` moved to components/organizer.tsx.
- **WP-13 follow-up** — PhaseRoutes shows `errorCopy(state.error)` (banner and pre-trip note); TripShell's link errors go through `errorCopy` too.
- **WP-06 follow-ups** — organizer.tsx HeadsetCodeCard has "Unpair headset" (`api.unpairHeadset`) with an inline two-tap confirm (`components/useTwoTap.ts`, 4 s); comment now says 8-character. Seal.tsx "Call it off" also uses the two-tap instead of `window.confirm`.
- **WP-09 follow-ups** — `useSendGuard(event, { reopenOnOk? })` returns `[sent, send(payload, p?), { payload, reset }]`: it emits with an ack and re-opens only on its own refusal (or EXPIRED from the outbox), or if the socket drops while its answer is outstanding — never on another action's error. `reopenOnOk` for Lift my seal and Sail without them; lifting also re-opens Set your seal (before, it stayed "Setting your seal…" after a lift). Callers: Brief, DryRun, Seal ×3, Voided, organizer ×2. passkey.ts `opts as never` casts removed.
- **WP-15 follow-ups** — pure seating split to `src/shared-ui/seating.ts` (`seatAngle`, `ORGANIZER_DEG`; scene/seats.ts re-exports it and keeps the three.js parts). Phone Table's top-down chart now seats the crew by `seatAngle` (same plan as the 3D table: 1 other → 335°, 3 → 205/335/355°; the Captain stays drawn at north on the phone) and names speakers with `scene/labels.ts` `speakerLabel` (hails keep the bare name). Phone copy → shared: Voided `VOID_HEADLINE` + `BACK_TO_CHARTS`, Booked `BOOKED_HEADLINE`, Seal `SEALING_FOOTER` (reads "If any share…" instead of "If anyone's share…"), Wait/organizer `waitingOnTerms`; `TripContext.possessiveList` deleted. GalleryPage `STATUS_LABEL` left: no shared status-label constant exists. Build: no three.js in phone chunks (TripShell 58.44 → 59.67 kB, gzip 19.38 → 19.79; the socket.io+tripStore chunk is now named `labels-*.js`, 46.47 → 47.24 kB, because it also carries seating/labels; Create 2.70 → 3.01 kB).
- **WP-08 follow-up** — `readSeatLink` reads a demo handoff only from the fragment (`#as=…&m=…`); `?as=` is ignored. Old absent-friend invites with `?m=&k=` still work.
- **WP-04 follow-up** — `BookingPublic.sealDeadlineAt` landed (WP-14): Seal.tsx shows "Seals close in 9:41" (own 1 s ticker, while gathering and seals are outstanding; "Seals are closing…" at 0). Uses the phone clock (booking:created has no `serverNow`), so a skewed phone can be off by its skew.
- Gates: web `tsc --noEmit`, `vite build`, `vitest run` (12 files, 50 tests). Live /demo in Chrome: Create lists ports from /cities; handoff link → Muster; Unpair two-tap → "Headset unpaired"; Close/Reopen crew; Weigh anchor → Table (new seating renders); Dry Run → Seal shows "Seals close in 9:54"; Call it off two-tap → Voided; Back to the charts → Dry Run; no console errors. (A server restart from WP-14's concurrent edits dropped one seeded voyage mid-test; reseeded.)
- **Deferred:** a server `serverNow` on booking:created for a skew-free countdown; hook tests need a DOM env (jsdom + testing-library); a shared status-label constant for GalleryPage.

## WP-17

### Docs sync

- **Status:** done (final fixer, 2026-09-25; uncommitted)
- **Wave:** 4  ·  **Depends on:** WP-14, WP-15, WP-16
- **Why:** Design docs drifted from the as-built contract and interactions.
- **Scope (only touch these):** docs/** (not docs/review)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **TR2-013** | Low | S | Headset interactions differ from doc 03 §4 and doc 04 §7.1 |  | `trace-2-xr-gallery.md` |
| [x] | **TR3-016** | Low | S | Design doc §6/§7 has drifted from the as-built contract |  | `trace-3-transport.md` |

**Notes:**
- **TR2-013** — docs were brought to the build (no input change): doc 03 §4 Q2/Q3/Q4/Q5 and a new as-built interaction table (select/pinch on things, pinch-hold ≥ 400 ms → hail card with four set lines, squeeze / palm-up / brass wheel → menu, Sound mutes voices and effects, clock pause/resume only, laptop-view column) plus a "not built" list (globe rotation, grab-and-lift, day jump, trumpet hail, headset call-off/crew-close UI); doc 04 §7.1 `dryrun:control` = `pause|resume|restart`, no day jump; doc 02 globe/cloche/seal-crack lines.
- **TR3-016** — doc 04 §6 REST table rewritten from `api/{routes,passkeyRoutes,debug}.ts` (origin/cityIds, invitePath + inviteKey, invite reissue, no REST brief, `/trips/:id/passkey/*` incl. `GET`, raw hail audio, `/cities`, `/health` public vs dev, debug login/cookie), error codes incl. `SEAL_LOCKED`/`TOO_MANY_RUNS`/`LOADING`; §7 checked row by row against `CLIENT_TO_SERVER_EVENTS` (15) and `SERVER_TO_CLIENT_EVENTS` (18): `trip:join` joinCode, full `TripState`, `Turn`, `DryRunScript` clock shape, `booking:created` with `sealDeadlineAt` + `serverNow`, `seal:private` cardLast4/mode, caller-only `error`, no Gallery `?dev=` key; events.ts named as the source of truth.
- **Other drift fixed:** doc 04 §3 layout (trips/* modules, api/*, util/*, web phone/scene/director), §4 (no DRAFT, `tableRuns`, dropped fields, `audioKey`, join-code alphabet), §5 (created into BRIEFING, table-run cap), §8.2 seal sequence (public "set" model, deadline, call-off, refunds), §9.3 director split, §10 (no `?fake=1`), §11 env list from `.env.example`, §12 production mode (APP_ENV, PUBLIC_BASE_URL, DEV_KEY) + dry-run clock is persisted + audio keys, `table:start` run cap, §14 contract/web tests and counts. Doc 01 A2/A3/E4, 00 headset code (8 chars), 03 lifecycle/P2 (`trip:state`, invite reissue)/edge cases (seal deadline, call-off, SEAL_LOCKED, TOO_MANY_RUNS, refused late hails), 06 two-tap call-off + seed path, 07 dataset loading + seed path, 08 health/debug checklist, 09 `/demo#key=`. Outside docs: README (commands, 305 + 52 tests, debug access, /demo key), `.env.example` and DEPLOY.md (`TABLE_RUNS_MAX`, `SEAL_DEADLINE_MS`), and REVIEW-REPORT "Status after fixes".

## No task

- **SEC-027** — Verified non-issues (for the record) (`security.md`)
