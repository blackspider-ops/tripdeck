# Traceability, layer 1: Phone UI → client net layer (and back)

Repo `/Users/tejas/Downloads/untitled folder 3` @ befc070. Read-only review. Paths below are relative to `apps/web/src/` unless prefixed.

**How this was checked**
- Read every file under `phone/**`, `net/*`, `router.tsx`, `packages/shared/src/*`, `apps/server/src/api/routes.ts`, `realtime/io.ts` and `trips/service.ts`. Also read docs 03 §3/§6.
- Ran two full voyages over socket.io-client against :8787 (scratchpad `review/drive.mjs`):
  - **happy path:** seed → add a 4th absent member → claim the invite twice → brief → double `table:start` → wait for the table to decide → hail after DECIDE → votes → pick → all seals → CAPTURED.
  - **cancel path:** seal → lift → VOIDED → Maya reloads (replay) → `booking:retry` → DRY_RUN.
- Probed the REST endpoints through the Vite proxy on :5173.
- Reproduced the Add-absent bug (TR1-001) in Chrome.

**Cleanup:** the browser tab is closed. I removed the `aa:session:Y5976G` key I created from localStorage. I also removed `aa:last`; if it pointed at an earlier voyage, Landing's "Back to voyage" link is gone until the next session is saved. The seeded voyages stay in the helm's memory; there is no delete API.

---

## A. Inventory: UI elements → calls

Legend: ✅ correct end to end · ⚠️ works with a defect (see issue) · ❌ broken

| # | Screen/Component (file:line) | UI element | Handler | Calls | Args passed | Expected signature | Match? | Response/State consumed | Issues |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Landing.tsx:17 | Start a voyage | onClick | navigate("/new") | — | route `/new` (router.tsx:21) | ✅ | — | |
| 2 | Landing.tsx:19 | Join with a code | onClick | navigate("/join") | — | route `/join` | ✅ | — | |
| 3 | Landing.tsx:23 | Back to voyage CODE | onClick | navigate(`/t/${last}`) | last = `aa:last` (upper-case) | `/t/:code/*` | ✅ | session.lastJoinCode() | |
| 4 | Create.tsx:24-37 | Set sail (form submit) | onSubmit, busy guard, button disabled | api.createTrip → saveSession → navigate(`/t/CODE/brief`) | {name:string, organizerName:string, band:Band, origin:Origin, cityIds:string[]} | api.ts:26 / routes.ts:40 body identical; returns {tripId, joinCode, memberId, memberToken} | ⚠️ | all 4 fields saved to Session; ApiError.message shown | TR1-012 (goes to P4, not P2) |
| 5 | Create.tsx:61-65 | Port chips (LIS/MEX/YUL) | onClick | local → cityIds | CityId[] ≥2 (min 2 enforced) | server: ≥2 known ids or BAD_INPUT | ✅ | — | |
| 6 | Create.tsx:46,50 | Band swatches / origin select | onChange | local | Band 1–4, Origin ATL/ORD/JFK | same unions | ✅ | — | |
| 7 | Create.tsx:77 | Back | onClick | navigate("/") | — | route `/` | ✅ | — | |
| 8 | Join.tsx:10 | `?code=` prefill | useSearchParams | — | code (upper-case, A-Z0-9, 6) | produced by TripShell.tsx:171 `/join?code=` | ✅ | — | |
| 9 | Join.tsx:17 | Come aboard (submit) | onSubmit | navigate(`/t/${clean}`) | 6-char code | `/t/:code/*` → JoinCrew | ✅ | — | |
| 10 | Join.tsx:26 | Back | onClick | navigate("/") | — | `/` | ✅ | — | |
| 11 | Demo.tsx:26-37 | Seed voyage | onClick, busy guard | api.seedDemo (POST `/demo/seed?key=`) | {} + `?key` from location | routes.ts:133; devAllowed reads `req.query.key` ✓; response {tripId, joinCode, organizer{memberId,memberToken}, maya, dev, headsetCode} (seed.ts:24) | ✅ | saveSession(organizer) | |
| 12 | Demo.tsx:47 | Open as Rae | Link | `/t/CODE` | — | TripShell | ✅ | session saved at #11 | |
| 13 | Demo.tsx:18-19,48,58 | Copy links (Rae/Maya/Dev) | CopyLine | clipboard | `?as=<memberToken>&m=<memberId>` | parsed at TripShell.tsx:40-41 | ✅ | — | |
| 14 | Demo.tsx:52 | Maya QR | QR | — | same link | same | ✅ | — | |
| 15 | Demo.tsx:66 | Open the gallery view | Link target=_blank | `/t/CODE/gallery` | — | router.tsx:26 | ✅ | — | |
| 16 | crew.tsx:50-53 | Copy (CopyLine) | onClick | navigator.clipboard | text | — | ✅ | "Copied" 1.6 s | |
| 17 | TripShell.tsx:47-65 | `?as&m` demo handoff (effect) | useEffect | api.tripByCode → saveSession → navigate(pathname, replace) | memberId=m, memberToken=as | tripByCode → {tripId, joinCode,…} | ✅ | Session {tripId, joinCode, memberId, memberToken} | |
| 18 | TripShell.tsx:53,96-105 | `?m&k` absent invite (effect) | useEffect + claimOnce | api.claimAbsent(tripId, memberId, inviteKey) | (string, string, string) → POST body {inviteKey} | routes.ts:67 → {memberToken} | ⚠️ | memberToken saved | TR1-002 |
| 19 | TripShell.tsx:73 | Keep my place | onClick | navigate(pathname, replace) | — | strips query | ✅ | — | |
| 20 | TripShell.tsx:74 | Open the invite on this phone | onClick | setSwapOk → claim | — | — | ✅ | overwrites this code's session (warned) | |
| 21 | TripShell.tsx:83 | Back to the start | onClick | navigate("/") | — | `/` | ✅ | — | |
| 22 | TripShell.tsx:171 | Join again | onClick | clearSession(code) → navigate(`/join?code=`) | code | Join.tsx:10 parses `code` | ✅ | — | |
| 23 | TripShell.tsx:124-156,177-182 | Phase guard + auto-advance | effect on trip.status / `<Navigate>` | navigate(`/t/CODE/<screen>`) | allowedScreens(status, briefSealed, organizer) | nested routes 193-201 (muster, brief, wait, table, dryrun, seal, booked, voided) all exist | ✅ | state.trip.status, me.briefSealed | |
| 24 | TripShell.tsx:189 / ui.tsx:41 | Dismiss (error margin note) | onClick | store.clearError() | — | tripStore.ts:144 | ✅ | state.error ← `error` event | |
| 25 | TripShell.tsx:218-222 | JoinCrew load | effect | api.tripByCode(code) | code | GET `/trips/by-code/:code` → {tripId, joinCode, name, status, crew, takenBands} | ✅ | takenBands → firstFreeBand; 404 → message | |
| 26 | TripShell.tsx:229 | Enter a different code | onClick | navigate("/join") | — | `/join` | ✅ | — | |
| 27 | TripShell.tsx:248-265 | Join the crew (submit) | onSubmit, busy guard | api.join(tripId, {name, band, origin}) → saveSession → onJoined → navigate(`/brief`) | tripId (not joinCode) ✓; Band, Origin | POST `/trips/:tripId/members` → {memberId, memberToken} | ✅ | on error, re-fetches takenBands | |
| 28 | TripShell.tsx:109-116 | Aboard: open socket | effect | new TripStore({tripId, memberToken, surface:"phone"}) → emit("trip:join") | tripId + memberToken (not deviceToken/joinCode) | events.ts:8 `trip:join` | ✅ | full replay (service.ts:570) | |
| 29 | Muster.tsx:16,26 | Invite QR / code | — | `${origin}/t/CODE` | joinCode | TripShell → JoinCrew | ✅ | — | |
| 30 | Muster.tsx:42 | Seal my terms | onClick | navigate(`/t/CODE/brief`) | — | allowed for organizer | ✅ | — | |
| 31 | Muster.tsx:52 | Re-read my terms | onClick | navigate(`/brief`) | — | allowed | ✅ | — | |
| 32 | Muster.tsx:77 | + Add an absent friend | onClick | open form | — | — | ✅ | — | |
| 33 | Muster.tsx:79-91 | Make their invite (submit) | onSubmit, busy guard | api.addAbsent(tripId, token, {name, band, origin}) | Bearer memberToken ✓ | POST `/trips/:tripId/absent` → {memberId, inviteKey, invitePath} | ❌ | invitePath → `${origin}${invitePath}` shown as QR/copy | **TR1-001** |
| 34 | Muster.tsx:102 | Cancel | onClick | local | — | — | ✅ | — | |
| 35 | Muster.tsx:73 | Done | onClick | local | — | — | ✅ | — | |
| 36 | Muster.tsx:71-72 | Invite QR / CopyLine | — | `/t/CODE/brief?m=&k=` (service.ts:228) | m, k | parsed at TripShell.tsx:41-42 | ✅ | — | |
| 37 | organizer.tsx:17 | Weigh anchor | onClick + useSendGuard | store.emit("table:start", {}) | {} | `Record<string,never>` ✓ | ⚠️ | success → AT_TABLE auto-nav; error resets guard | TR1-006 |
| 38 | organizer.tsx:46-53 | Show headset code | onClick, busy guard | api.headsetCode(tripId, memberToken) | Bearer | POST `/trips/:tripId/headset-code` → {code, expiresAt} (verified live) | ✅ | code shown; ApiError shown | |
| 39 | organizer.tsx:41 | Hide code | onClick | local | — | — | ✅ | — | |
| 40 | organizer.tsx:64-83 | Sail without them (2-min timer) | interval 5 s + onClick + guard | store.emit("table:sailWithout", {memberIds}) | string[] of unsealed non-organizer | events.ts:11 ✓ | ⚠️ | trip:state crew shrinks | TR1-007 |
| 41 | BrassDial.tsx:64-69 | Dial drag / arrow keys | pointer/key | onChange(cents) | cents snapped to 5,000; clamped 30,000–300,000 | constants CAP_* (cents) | ✅ | — | |
| 42 | BrassDial.tsx:106-107 | −50 / +50 | onClick | set(value ± CAP_STEP_CENTS) | cents | — | ✅ | — | |
| 43 | BrassDial.tsx:92-101 | Tap numeral → type $ | onBlur/Enter | set(Number(draft)*100) | dollars → cents ✓ | — | ✅ | — | |
| 44 | Brief.tsx:95 | Date chips | onClick | local dateWindowIds | trip.dateWindows[].id | server filters to known ids | ✅ | — | |
| 45 | Brief.tsx:106-110 | Must-have chips | onClick | local | Tag[] ≤3 | MAX_MUST_HAVES | ✅ | — | |
| 46 | Brief.tsx:120-124 | Won't-do chips | onClick | local | Dealbreaker ids (red_eye…) | DEALBREAKERS | ✅ | — | |
| 47 | Brief.tsx:132-135 | Anything else? textarea | onChange | local note | ≤200 | NOTE_MAX_CHARS | ✅ | — | |
| 48 | VoiceNote.tsx:37-83, Brief.tsx:138 | Say it instead | onClick toggle, 20 s timer | api.hailAudio(tripId, token, Blob) | raw Blob, Bearer | POST `/trips/:tripId/hail-audio` → {transcript} | ⚠️ | transcript → note, noteSource="voice" | TR1-005, TR1-016 |
| 49 | Brief.tsx:63-68,144 | Seal my terms / Reseal | onClick; submitted guard | store.emit("brief:submit", BriefInput) | {capCents (cents ✓), dateWindowIds, mustHaves, dealbreakers, note?, noteSource} | BriefInput types.ts:45 ✓ | ✅ | waits for brief:private.sealedAt ≠ prev AND trip:state me.briefSealed; error re-opens | |
| 50 | Brief.tsx:47-52 | Post-seal navigate | effect | navigate(`/muster` or `/wait`) | — | routes exist | ✅ | state.brief.sealedAt, me.briefSealed | |
| 51 | Brief.tsx:80-84 | Memory banner | render | — | — | spec: banner + pre-fill | ⚠️ | state.memory ← brief:private.memory | TR1-013 |
| 52 | Wait.tsx:28 | Re-read my terms | onClick | navigate(`/brief`) | — | allowed | ✅ | — | |
| 53 | Wait.tsx:27 | Organizer block (Weigh anchor / Sail / Headset) | render | — | — | organizer is never routed to `wait` | ⚠️ | — | TR1-007 (dead code) |
| 54 | Hail.tsx:115-121 | Hold to hail | pointerdown/up/leave/cancel, 10 s cap | api.hailAudio(tripId, token, Blob) | Blob, Bearer | {transcript} | ⚠️ | preview 1.5 s → onHail | TR1-005 |
| 55 | Hail.tsx:104-109,135-140 | Type a hail + Enter / Hail | onKeyDown/onClick | onHail → store.emit("table:hail", {text}) | {text:string ≤200} | events.ts:12 ✓ | ⚠️ | turn:new echoes as human turn | TR1-010 |
| 56 | Hail.tsx:97 | Voice-hail send timer | setTimeout 1.5 s | onHail(t) → table:hail | {text} | — | ⚠️ | — | TR1-004 |
| 57 | Table.tsx:59-61 / voices.ts | Play voices here | onChange | useVoicePlayback | turns, audio | state.audio ← turn:audioReady (`/api/audio/:id` route exists) | ✅ | — | |
| 58 | DryRun.tsx:41-46,106 | Chart A/B card | onClick | local selected | planId | — | ✅ | shortlist ← table:decided / trip:state; planPrivate[planId] ← plan:private | |
| 59 | DryRun.tsx:56-64 | Vote A / Vote B | onClick | store.emit("plan:vote", {planId}) | planId (not bookingId) ✓ | events.ts:15 | ⚠️ | state.votes ← plan:votes.tallies | TR1-009 |
| 60 | DryRun.tsx:71 | Pick <city> (organizer) | onClick + useSendGuard | store.emit("plan:pick", {planId}) | planId of selected chart | events.ts:16 | ✅ | → SEALING auto-nav | |
| 61 | DryRun.tsx:84-100 | Auto-pick countdown | interval 250 ms | — | autoPick.at (server ms) | plan:votes.autoPick / trip:state.autoPick | ⚠️ | state.autoPick | TR1-008 |
| 62 | DryRun.tsx:17-19,27,36 | Trip clock / timeline | interval 250 ms | store.dryrunMinute() | — | dryrun:script (skew-corrected), dryrun:control | ✅ | state.dryrun | |
| 63 | Seal.tsx:27-41,71 | Set your seal | onClick; approvingRef + useSendGuard | approveWithPasskey(tripId, memberToken) → store.emit("seal:set", {bookingId, assertionToken?}) | bookingId (not planId) ✓, memberToken ✓ | events.ts:17; passkey REST paths match routes.ts:98-124 | ⚠️ | booking.seals[me].status ← seal:status; sealPrivate ← seal:private | TR1-003 |
| 64 | Seal.tsx:81-85 | Lift my seal | onClick + guard | store.emit("seal:cancel", {bookingId}) | bookingId | events.ts:18 | ✅ | → VOIDED; declined ← seal:declinedPrivate (verified live) | |
| 65 | SealRow.tsx | Seal row | render | — | — | BookingPublic.seals[].status/standing | ✅ | state.booking | |
| 66 | Booked.tsx:54,73-97 | Save to your log (.ics) | onClick | local Blob download | trip.name, plan, window, memberId, ref | — | ✅ | — | |
| 67 | Booked.tsx:15-16 | Reference / your share | render | — | — | lastResult.reference ?? booking.reference (replayed) ✓; sealPrivate.amountCents | ✅ | | |
| 68 | Voided.tsx:45 | Back to the charts (organizer) | onClick + guard | store.emit("booking:retry", {}) | {} | events.ts:19 | ✅ | → DRY_RUN; shortlist/planPrivate/dryrun re-sent (verified live) | |
| 69 | Voided.tsx:49-53 | Adjust my terms (decline owner) | onClick | navigate(`/brief`) | — | VOIDED allows `brief`; server accepts brief:submit in VOIDED | ✅ | state.declined | |
| 70 | Voided.tsx:33-34 | Reason / public reason lines | render | — | — | declined (replayed ✓); lastResult (not replayed) | ⚠️ | | TR1-011 |

**Totals:** 70 elements · 55 ✅ · 14 ⚠️ · 1 ❌

### A.2 REST client (net/api.ts) vs server (routes.ts)

| api.ts | Method + path | Body | Auth | Response | Server | Match |
|---|---|---|---|---|---|---|
| cities | GET /cities | — | — | {cityId,name,notes}[] | routes.ts:138 | ✅ (unused by any UI) |
| createTrip | POST /trips | {name, organizerName, band, origin, cityIds?} | — | {tripId, joinCode, memberId, memberToken} | :40 | ✅ |
| tripByCode | GET /trips/by-code/:code | — | — | {tripId, joinCode, name, status, crew, takenBands} | :50 | ✅ |
| join | POST /trips/:tripId/members | {name, band, origin} | — | {memberId, memberToken} | :56 | ✅ |
| addAbsent | POST /trips/:tripId/absent | {name, band, origin} | Bearer | {memberId, inviteKey, invitePath} | :62 | ✅ |
| claimAbsent | POST /trips/:tripId/absent/:memberId/claim | {inviteKey} | — | {memberToken} | :67 | ✅ |
| headsetCode | POST /trips/:tripId/headset-code | {} | Bearer | {code, expiresAt} | :71 | ✅ |
| pairHeadset | POST /xr/pair | {code} | — | {tripId, joinCode, deviceToken} | :75 | ✅ (XR only) |
| hailAudio | POST /trips/:tripId/hail-audio | raw Blob (the Content-Type comes from blob.type) | Bearer | {transcript} | :80 | ✅ |
| seedDemo | POST /demo/seed[?key=] | {} | — | {tripId, joinCode, organizer, maya, dev, headsetCode} | :133 | ✅ |
| health | GET /health | — | — | object | :142 | ✅ (unused) |
| passkeyStatus | GET /trips/:tripId/passkey | — | Bearer | {registered} | :98 | ✅ shape (see TR1-003 for its semantics) |
| passkeyRegisterOptions / Verify | POST …/passkey/register/options · /verify | {} · {response} | Bearer | options · {ok} | :102/:108 | ✅ |
| passkeyAuthOptions / Verify | POST …/passkey/auth/options · /verify | {} · {response} | Bearer | options · {assertionToken} | :115/:119 | ✅ |

No REST path, method, body-field or auth mismatches. Error bodies are `{code, message}`, which `ApiError` reads. See TR1-014 for the non-JSON case.

### A.3 Socket emits from the phone (ClientToServer)

`brief:submit`, `table:start`, `table:sailWithout`, `table:hail`, `plan:vote`, `plan:pick`, `seal:set`, `seal:cancel` and `booking:retry` all match `events.ts` and `realtime/io.ts:59-77` in event name and payload fields. The phone never emits `xr:placed`, `dryrun:control` or `client:log`; those come from the headset and the debug overlay.

The offline outbox (`tripStore.ts:48-59,123`) replays after `trip:join`. The server sets `socket.data` synchronously before its first `await` (io.ts:47-51), so the replayed actions are accepted.

---

## B. Return path: ServerToClient events → tripStore → screens

| Event | tripStore handler (tripStore.ts) | State written | Read by phone screens | Replayed on join (service.ts:570)? | Verdict |
|---|---|---|---|---|---|
| trip:state | :71-84 | trip, booking, shortlist (kept/reset), votes, autoPick; on DRAFT/BRIEFING/AT_TABLE entry it also resets turns/audio/planPrivate/dryrun | every screen (trip.*), Seal/Booked/Voided (booking), DryRun (votes, autoPick) | yes, first | ✅ |
| member:joined | :85 no-op | — | — (trip:state carries crew) | no | ✅ covered (TR1-017 info) |
| brief:received | :86 no-op | — | — (trip:state carries briefSealed) | no | ✅ covered |
| brief:private | :87 | brief, memory | Brief (prefill, sealedAt echo, memory banner) | yes | ✅ |
| table:watch | :88 no-op | — | Table uses `latest turn.watch` instead | no | ✅ covered (TR1-017) |
| turn:new | :89-90 (dedupe by turnId, sort by seq) | turns | Table (caption, log, chart highlight, hail disable on DECIDE) | yes (last 50) | ✅ |
| turn:audioReady | :91 | audio[turnId] | voices.ts (Play voices) | yes (when audioUrl) | ✅ |
| table:decided | :92 | shortlist | DryRun, Seal (plan), Booked (plan) | yes (DRY_RUN and later) | ✅ |
| plan:private | :93 | planPrivate[planId] | DryRun ChartCard (FitStamp, missing, own flags), Timeline note | yes | ✅ |
| dryrun:script | :94-100 (skew-corrected) | dryrun | DryRun clock/timeline via store.dryrunMinute() | yes (DRY_RUN) | ✅ |
| dryrun:control | :101-108 | dryrun.startedAt/pausedAt | DryRun clock | no (the script carries pausedAt) | ✅ |
| plan:votes | :109 | votes, autoPick | DryRun vote counts, AutoPickNote | via trip:state | ✅ |
| booking:created | :110 | booking; clears declined/lastResult/sealPrivate | Seal, Booked, Voided, Brief (declinedMine) | yes (SEALING/BOOKED/VOIDED) | ✅ |
| seal:private | :111 | sealPrivate | Seal (ledger, fit, card, mode), Booked (share) | yes | ✅ |
| seal:status | :112-116 (only if bookingId matches) | booking.seals[].status | Seal status line / Lift condition, SealRow | via trip:state snapshot | ✅ (TR1-015: can arrive before booking:created and be dropped; the snapshot covers it) |
| seal:declinedPrivate | :117 | declined | Voided reason line, Adjust-my-terms gate; Brief `locked` | yes (verified live) | ✅ |
| booking:result | :118 | lastResult | Booked (reference), Voided (publicReason) | **no** | ⚠️ TR1-011 |
| error | :119 | error | TripShell margin note, useSendGuard resets, Brief re-enable | n/a | ✅ (received live: BAD_PHASE, CAPTAINS_CALLING) |

**Handled but never read:** `member:joined`, `brief:received` and `table:watch` are deliberate no-ops (trip:state carries the same data). `dryrun.planIds` and `trip.negotiation` are written but no phone screen reads them.

**Read but never written:** none. Every `ClientState` field a screen reads has a writer.

---

## C. Issues

### TR1-001 — The absent friend's invite link disappears when adding them fills the crew to 4
- Severity: High
- Link: Muster "Make their invite" → `api.addAbsent` (phone/screens/Muster.tsx:38,79-91 → net/api.ts:36 → routes.ts:62 → service.ts:221-229)
- Expected vs actual:
  - Expected: after "Make their invite", the organizer sees the QR and copy link `/t/CODE/brief?m=…&k=…`.
  - Actual: `<AddAbsent>` only renders while `trip.crew.length < 4` (Muster.tsx:38).
    - The server calls `broadcastState` inside `addMember` before it writes the REST response.
    - So `trip:state` with 4 crew reaches the phone first, the component unmounts, and `setInvite` runs on an unmounted component.
    - The invite key is returned only once and cannot be regenerated. The absent friend can never claim their seat, and the table cannot start because their terms are never sealed.
  - Verified live twice:
    - Socket driver: `stateCrew4Before REST resolved: true`.
    - Chrome, seeded voyage with 3 crew → add Zed: Zed appears in the crew list, but no invite text or link is rendered.
- Fix: keep the invite panel mounted regardless of crew size. Either render `AddAbsent` while it holds an invite (lift the `invite` state into Muster), or change the condition to `crew.length < 4 || inviteOpen`. Optionally add an organizer-only "re-issue invite" endpoint so a lost key can be recovered.
- Effort: S
- Scope: apps/web/src/phone/screens/Muster.tsx (optionally apps/server/src/trips, apps/server/src/api for re-issue)
- Acceptance: seed the demo (3 crew) → Muster → add a 4th absent friend → the QR and copy link stay visible → opening the link on another browser lands on that member's Brief.

### TR1-002 — Re-opening your own invite link on the phone that already claimed it shows "That link isn't valid"
- Severity: Medium
- Link: invite URL `?m&k` → `claimOnce` → `api.claimAbsent` (phone/screens/TripShell.tsx:46-65,96-105 → routes.ts:67 → service.ts:231-240)
- Expected vs actual:
  - Expected: a phone whose saved session is already member `m` opens the voyage.
  - Actual: `askSwap` is false because the memberId matches, so the effect claims again. Claims are single-use (`inviteKeyHash` is cleared), so the server returns 403 BAD_INVITE.
  - The phone shows the bootErr page with only "Back to the start", even though its session is valid. Verified live: claim1 200, claim2 403 BAD_INVITE.
- Fix: in the effect, if `session?.memberId === m && session.memberToken` and there is no `as`, skip the claim and just `navigate(location.pathname, {replace:true})`.
- Effort: S
- Scope: apps/web/src/phone/screens/TripShell.tsx
- Acceptance: open an invite link, then tap the same link again on that phone → you land on the voyage with no error.

### TR1-003 — A passkey registered on another origin makes sealing impossible
- Severity: Medium
- Link: Seal "Set your seal" → `approveWithPasskey` → `api.passkeyStatus` / `passkeyRegisterOptions` → `seal:set` (phone/screens/Seal.tsx:32-36 → net/passkey.ts:19-28 → routes.ts:98-107 → service.ts:501)
- Expected vs actual: each check uses a different scope.
  - `GET /passkey` answers per rpID: `hasPasskey(m, rpID)`.
  - `register/options` and `setSeal` check any origin: `hasPasskey(m)` with no rpID.
  - Sequence on a second origin (for example, sealed first on `localhost:5173`, now on a LAN IP or a tunnel):
    1. status says `registered:false`.
    2. register/options returns 409 PASSKEY_EXISTS, which passkey.ts treats as `fallback`.
    3. `seal:set` goes out without an assertion.
    4. The server throws PASSKEY_REQUIRED.
  - The user can never seal on that origin, and every retry repeats the same loop.
- Fix (either side):
  - Server (layer 3): make `register/options`, `register/verify` and `setSeal` use the same rpID scope as status; for `setSeal`, require a passkey only if one exists for the socket's origin.
  - Or client: when register fails with 409, try `auth/options`, and surface PASSKEY_REQUIRED as "Use the device you registered on".
- Effort: M
- Scope: apps/server/src/api/routes.ts, apps/server/src/trips/service.ts, apps/server/src/passkeys; apps/web/src/net/passkey.ts
- Acceptance: register a passkey on origin A, open the same member on origin B → "Set your seal" either succeeds after a passkey prompt or explains the constraint. It never loops on PASSKEY_REQUIRED.

### TR1-004 — A voice hail in its 1.5 s preview is sent after the Captain decides (or after leaving the Table), producing a stray error
- Severity: Medium
- Link: HailDock preview timer → `onHail` → `store.emit("table:hail")` (phone/components/Hail.tsx:97, 39-40 → phone/screens/Table.tsx:57 → service.ts:389-391)
- Expected vs actual:
  - Expected, per doc 03 §6: a hail during the Captain's closing line is "queued for next phase, not lost", and the phone shows "Captain's calling it."
  - Actual:
    - The `setTimeout` in `send()` is never cleared and ignores `disabled`.
    - After DECIDE, or after Table unmounts when DRY_RUN starts, it still emits `table:hail`. The server rejects with CAPTAINS_CALLING (verified live), and the red error note then appears on the Dry Run screen.
    - The comment at Hail.tsx:39 ("server queues it") is wrong: nothing is queued.
- Fix: keep the preview timer in a ref, clear it on unmount, and skip `onHail` if `disabled` has since become true (show "Captain's calling it." instead). If the spec's queue-for-next-phase behaviour is wanted, the server must accept and park the hail (layer 3).
- Effort: S
- Scope: apps/web/src/phone/components/Hail.tsx (server queueing: apps/server/src/trips/service.ts)
- Acceptance: start a voice hail so its preview overlaps DECIDE → no `error` event reaches the phone, and the Dry Run screen shows no error note.

### TR1-005 — The voice buttons stay visible when the server has no speech-to-text, and the server's reason is dropped
- Severity: Medium
- Link: "Hold to hail" and "Say it instead" → `api.hailAudio` (phone/components/Hail.tsx:42,113,98-101; phone/components/VoiceNote.tsx:34-35,78-79 → routes.ts:84)
- Expected vs actual:
  - `/api/health` reports `eleven:false` in the running environment, and `hail-audio` returns 501 NO_STT, "Voice hails need ElevenLabs — type your hail instead." (verified live).
  - The UI still shows both voice buttons, prompts for the mic, records up to 10 s or 20 s, and then shows a generic "Couldn't hear that one". It discards `ApiError.message`.
- Fix: read `api.health().eleven` once (for example in TripShell or a small hook) and hide both voice controls when it is false. In the catch blocks, show `e instanceof ApiError ? e.message : fallback`.
- Effort: S
- Scope: apps/web/src/phone/components/Hail.tsx, VoiceNote.tsx, (optional) apps/web/src/phone/TripContext.tsx
- Acceptance: with ELEVENLABS unset, neither voice button renders. With it set, voice works as before.

### TR1-006 — "Weigh anchor" is enabled with a crew of one and fails with TOO_FEW
- Severity: Low
- Link: WeighAnchor → `table:start` (phone/components/organizer.tsx:13,17 → service.ts:316)
- Expected vs actual: `allSealed` only checks `crew.length > 0`. With one sealed organizer, the button is enabled and the server replies "You need at least two crew at the table."
- Fix: `crew.length >= 2 && every sealed`; show "Invite at least one friend" instead.
- Effort: S
- Scope: apps/web/src/phone/components/organizer.tsx
- Acceptance: a solo organizer who has sealed sees a disabled button with a hint, and no error event is produced.

### TR1-007 — The "Sail without them" 2-minute timer is per mount; the organizer block on Wait is unreachable
- Severity: Low
- Link: SailWithout timer → `table:sailWithout` (phone/components/organizer.tsx:66-75; phone/screens/Wait.tsx:27)
- Expected vs actual:
  - `since = Date.now()` at mount, so moving Muster → Brief → Muster restarts the 2 minutes, and a reload does too.
  - `allowedScreens` never routes the organizer to `wait` (TripShell.tsx:128-129), so Wait's organizer controls are dead code.
- Fix: base the timer on a server timestamp, for example the last `member:joined` or the trip's `updatedAt` exposed in TripState, or at least store `since` in the TripStore. Remove the organizer block from Wait, or route the sealed organizer there per doc 03 P5.
- Effort: S
- Scope: apps/web/src/phone/components/organizer.tsx, apps/web/src/phone/screens/Wait.tsx (optional shared TripState field)
- Acceptance: the button appears 2 minutes after the reference moment regardless of navigation or reload.

### TR1-008 — The auto-pick countdown ignores clock skew between phone and server
- Severity: Low
- Link: AutoPickNote ← `plan:votes.autoPick.at` (phone/screens/DryRun.tsx:94; net/tripStore.ts:109)
- Expected vs actual: `autoPick.at` is server epoch ms and is compared with the phone's `Date.now()`. A skewed phone shows the wrong seconds, or 0 s long before the pick. `dryrun:script` already carries `serverNow` for skew correction, but autoPick does not.
- Fix: add `serverNow` to the `plan:votes` payload (layer 3) and store `autoPick.at + skew`, or reuse the skew measured from `dryrun:script`.
- Effort: S
- Scope: apps/web/src/net/tripStore.ts (+ packages/shared/src/events.ts, apps/server/src/trips/service.ts)
- Acceptance: with the phone clock offset by 10 s, the countdown still matches the server-side pick time to within 1 s.

### TR1-009 — Your own vote highlight is lost on reload
- Severity: Low
- Link: Vote A/B → `plan:vote` (phone/screens/DryRun.tsx:13,58-60)
- Expected vs actual: `myVote` is component state only. After a reload, the tallies show but not which chart I voted for. The server stores `votes[memberId]` but sends only tallies.
- Fix: include `myVote` in a private replay, for example `brief:private` or a new private field, or keep it in the TripStore per trip.
- Effort: S
- Scope: apps/web/src/phone/screens/DryRun.tsx, apps/web/src/net/tripStore.ts (optional server replay)
- Acceptance: vote, reload → your vote button is still pressed.

### TR1-010 — A typed hail is cleared before the server accepts it, and the length limits disagree
- Severity: Low
- Link: Hail text → `table:hail` (phone/components/Hail.tsx:104-109,136 → service.ts:393,396)
- Expected vs actual: the text is cleared as soon as it is emitted. If the server replies SLOW_DOWN (5 s rate limit) or CAPTAINS_CALLING, the words are lost. The client allows 200 chars; the server silently truncates to 160.
- Fix: set `maxLength` to 160 (a shared constant). Restore the text when an `error` with code SLOW_DOWN arrives, or clear it only when the echoed `turn:new` from me arrives.
- Effort: S
- Scope: apps/web/src/phone/components/Hail.tsx, packages/shared/src/constants.ts
- Acceptance: two hails within 5 s → the second one's text is still in the field, with the error shown.

### TR1-011 — `booking:result` is not replayed, so the Voided public reason is lost on reload
- Severity: Low
- Link: Voided public-reason line ← `state.lastResult` (phone/screens/Voided.tsx:34; service.ts:570-595)
- Expected vs actual: after a reload in VOIDED, `lastResult` is null. Replay emits `booking:created`, which also clears it, and never re-emits `booking:result`. Booked is unaffected because it falls back to `booking.reference`.
- Fix: replay `booking:result` for BOOKED/VOIDED after `booking:created` (layer 3), or add `publicReason` to `BookingPublic`.
- Effort: S
- Scope: apps/server/src/trips/service.ts (replay), packages/shared/src/types.ts
- Acceptance: a void for provider_error, then reload → "The card network had a problem…" line still shows.

### TR1-012 — Create goes to the Brief screen, not Muster (P2)
- Severity: Low
- Link: Set sail → navigate (phone/screens/Create.tsx:32)
- Expected vs actual: doc 03 P1 says "Set sail → creates trip, goes to P2" (Muster). The code navigates to `/brief`. That screen is allowed, so it works, but the organizer sees the invite QR only after sealing.
- Fix: navigate to `/t/CODE/muster`, or update the doc if this is intended.
- Effort: S
- Scope: apps/web/src/phone/screens/Create.tsx (or docs/03)
- Acceptance: after Set sail, the organizer lands on Muster with the QR.

### TR1-013 — Memory is shown as a banner but never pre-fills the Brief
- Severity: Low
- Link: brief:private.memory → Brief banner (phone/screens/Brief.tsx:80-84)
- Expected vs actual: doc 03 P4 says banner plus pre-fill, with a pencil mark on pre-filled chips. Only the raw memory string (e.g. "voyage: Nashville · booked · mid budget…") is shown. `Brief.fromMemory` is never used.
- Fix: have the server send structured memory (cap band, liked tags) and pre-fill with pencil marks, or adjust the spec.
- Effort: M
- Scope: apps/web/src/phone/screens/Brief.tsx; apps/server/src/memory, packages/shared
- Acceptance: a returning member sees chips pre-filled and marked.

### TR1-014 — `api.call` throws SyntaxError (not ApiError) on non-JSON error bodies; two API methods are unused
- Severity: Low
- Link: every `api.*` (net/api.ts:13-15)
- Expected vs actual: `JSON.parse(text)` runs before the `res.ok` check. A proxy HTML/text error (for example the helm is down behind Vite, or `/debug` returns 404 text) throws SyntaxError, so callers show their generic fallback and lose the HTTP status. `api.cities` and `api.health` are never called.
- Fix: wrap the parse in try/catch and fall back to `{message: text}`, then throw ApiError(status). Use `health` for TR1-005; drop `cities` or use it on Create.
- Effort: S
- Scope: apps/web/src/net/api.ts
- Acceptance: stop the helm, submit Create → an ApiError with status 502/500 and a readable message.

### TR1-015 — (layer 3 note) `seal:status` for standing seals is emitted before `booking:created`
- Severity: Low
- Link: server `payments.create` → startSeal → `seal:status` before `booking:created` (service.ts:474-481, orchestrator.ts:67) → tripStore.ts:112-116
- Expected vs actual: observed live, `seal:status AUTHORIZING` for absent members reaches phones before `booking:created`. tripStore drops it because the bookingId does not match. The snapshot inside `booking:created` currently compensates, so nothing is visible, but it relies on ordering.
- Fix: emit `booking:created` before starting standing seals (server), or have tripStore buffer `seal:status` for unknown bookingIds.
- Effort: S
- Scope: apps/server/src/trips/service.ts, apps/server/src/payments/orchestrator.ts (or apps/web/src/net/tripStore.ts)
- Acceptance: event log per phone shows `booking:created` before any `seal:status` for that booking.

### TR1-016 — `noteSource` stays "voice" after the user hand-edits the transcript or clears the note
- Severity: Low
- Link: Brief note textarea / VoiceNote → `brief:submit.noteSource` (phone/screens/Brief.tsx:31,134,138)
- Expected vs actual: once set to "voice", typing never resets it, so edited or fully retyped notes are reported as voice.
- Fix: in the textarea onChange, `setNoteSource("typed")` when the text diverges from the last transcript (or when it is cleared).
- Effort: S
- Scope: apps/web/src/phone/screens/Brief.tsx
- Acceptance: dictate, then retype the note → `brief:private.brief.noteSource === "typed"`.

### TR1-017 — (info) No-op handlers for `member:joined`, `brief:received` and `table:watch`
- Severity: Low
- Link: tripStore.ts:85-88
- Expected vs actual: these events are subscribed but write nothing. The phone relies on `trip:state` (crew, briefSealed) and on `turn.watch`. `state.trip.negotiation.watch` goes stale during the table because the server does not re-broadcast `trip:state` on `onWatch`. No screen reads it today, so there is no visible bug.
- Fix: either patch `trip.negotiation.watch` on `table:watch`, or document the events as tap-only (the SceneDirector uses them).
- Effort: S
- Scope: apps/web/src/net/tripStore.ts
- Acceptance: `state.trip.negotiation.watch` equals the last `table:watch.watch` during AT_TABLE.

---

## Summary
- 70 elements: 55 ✅, 14 ⚠️, 1 ❌.
- 17 issues: High 1 · Medium 4 · Low 12.
- The REST contract (paths, methods, bodies, Bearer auth, response shapes) and every socket event name and payload match with no mismatches. Every ServerToClient event has a handler, and all state that screens read is written.
