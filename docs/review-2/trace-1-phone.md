# Traceability round 2, layer 1: Phone UI → client net layer (and back)

Repo `/Users/tejas/Downloads/untitled folder 3` @ 0430ef9. Read-only review; the only file written is this report. Paths are relative to `apps/web/src/` unless they start with `apps/` or `packages/`. Round-1 report: `docs/review/trace-1-phone.md`.

**How this was checked**
- Read every file under `phone/**`, all of `net/{api,tripStore,session,passkey}.ts` and `router.tsx`. On the server side: `packages/shared/src/events.ts` and `types.ts`, `apps/server/src/api/{routes,passkeyRoutes}.ts`, `realtime/io.ts`, and `trips/{replay,crew,table,dryrun,sealing,identity}.ts`.
- `cd apps/web && npx tsc --noEmit` passes (exit 0). `npx vitest run src/net src/phone` passes: 8 files, 41 tests, including the S2C/C2S contract test.
- Live probe against web :5173 → helm :8787 with a socket.io-client driver (scratchpad `r2-t1/drive.mjs`, output in `drive.out`). It ran:
  - seed the demo, then look up by code (upper and lower case);
  - redeem the Maya handoff twice;
  - join as Rae and record the replay;
  - add an absent 4th crew member (timing of `trip:state` against the REST reply);
  - re-issue the invite, then claim with the old key and with the new key (twice);
  - join as a 5th crew member (refused, crew full);
  - send `table:hail`, `plan:vote` and `booking:retry` in BRIEFING;
  - `crew:setOpen` both ways, `sailWithout`, and `table:start` while someone is unsealed;
  - headset code as the organizer and as Maya, then unpair;
  - passkey status;
  - hail-audio with an empty body;
  - an unknown `/api` route;
  - `trip:join` to a voyage that doesn't exist.

  I did not start a table, so no Gemini or TTS calls were made. The empty hail-audio probe did reach the STT step; see L1-010.
- Leftovers: two seeded voyages remain in the helm (the latest is `9G4SW8`). No browser tab was used, and no localStorage was touched.

**Round-1 issues, re-verified:** TR1-001 through TR1-017 are all fixed or addressed in the code at HEAD.
- **TR1-001:** Muster now owns the invite links and adds a re-issue endpoint. Verified live: the crew-of-4 `trip:state` still arrives before the REST reply, and the link now survives it.
- **TR1-002:** the `mine` short-circuit.
- **TR1-003:** handled by the `required` flag, `PASSKEY_EXISTS` → auth, and `blocked`.
- **TR1-004:** the preview timer is cleared and checked against `disabledRef`.
- **TR1-005:** `useVoiceAvailable`, and the server's message is now shown.
- **TR1-006:** at least 2 crew are required.
- **TR1-007:** the timer is kept per voyage in localStorage, and the Wait organizer block is removed.
- **TR1-008:** handled by the `serverNow` mapping.
- **TR1-009:** `plan:myVote`.
- **TR1-010:** the limit is 160, and the text is restored on refusal.
- **TR1-011:** `booking:result` is replayed.
- **TR1-012:** Create now goes to `/muster`.
- **TR1-013:** memory pre-fill with pencil marks.
- **TR1-014:** `api.call` no longer throws on non-JSON bodies.
- **TR1-015:** `booking:created` is now sent before standing seals.
- **TR1-016:** `noteSource` follows the text.
- **TR1-017:** `table:watch` patches `trip.negotiation`.

The findings below are new.

---

## A. Inventory: UI element → handler → net call → server → result handling

Legend: ✅ correct end to end · ⚠️ works, with a defect (see finding) · ❌ broken

| # | Screen / component (file:line) | Element | Handler | Net call (signature as called) | Server target | Result / failure handling | Status |
|---|---|---|---|---|---|---|---|
| 1 | Landing.tsx:17 | Start a voyage | onClick | navigate("/new") | router.tsx:21 | — | ✅ |
| 2 | Landing.tsx:19 | Join with a code | onClick | navigate("/join") | router.tsx:22 | — | ✅ |
| 3 | Landing.tsx:21-23 | Back to voyage CODE | onClick | session.lastJoinCode() → navigate(`/t/${last}`) | `/t/:code/*` | hidden when no `aa:last` | ✅ (see L1-002 if that voyage is gone) |
| 4 | Create.tsx:22-28 | Port list load | effect | api.cities() → `{cityId,name,notes}[]` | GET /api/cities (routes.ts:192) | all ports on by default; on failure "Every port goes on the chart" and `cityIds` omitted | ✅ |
| 5 | Create.tsx:70-80 | Port chips | onClick | local `ports` (string[]) | server needs ≥2 known ids (crew.ts:31) | the last two can't be turned off | ✅ |
| 6 | Create.tsx:49-61 | Voyage name / your name / band swatches / origin | onChange | local; Band 1-4, Origin ATL/ORD/JFK | same unions | — | ✅ |
| 7 | Create.tsx:34-47,90 | Set sail (submit) | onSubmit, `busy`, disabled while busy or name empty | api.createTrip({name, organizerName, band, origin, cityIds?}); api adds `crewKey` | POST /api/trips (routes.ts:72) → {tripId, joinCode, memberId, memberToken, crewKey} | saveCrewKey; saveSession(4 fields); navigate(`/t/CODE/muster`); ApiError.message shown, busy reset | ✅ |
| 8 | Create.tsx:91 | Back | onClick | navigate("/") | `/` | — | ✅ |
| 9 | Join.tsx:10 | `?code=` prefill | useSearchParams | — | written by PhaseRoutes.tsx:54 | upper-cased | ✅ |
| 10 | Join.tsx:17-24 | Code input + Come aboard | onSubmit, disabled unless 6 chars | navigate(`/t/${clean}`) | `/t/:code/*` → JoinCrew | lookup is case-insensitive (verified) | ✅ |
| 11 | Join.tsx:26 | Back | onClick | navigate("/") | `/` | — | ✅ |
| 12 | api.ts:112-130 | `/demo?key=` capture | module init | stored in sessionStorage, sent as `X-Dev-Key` | devAccess.ts (header only) | key stripped from the URL | ✅ |
| 13 | Demo.tsx:27-40 | Seed voyage | onClick, `busy` | api.seedDemo() | POST /api/demo/seed → {tripId, joinCode, organizer/maya/dev{memberId, memberToken, handoff}, headsetCode} (verified) | saveSession(organizer); ApiError shown | ✅ |
| 14 | Demo.tsx:48 | Open as Rae | `<Link>` | `/t/CODE` | TripShell (session saved in #13) | — | ✅ |
| 15 | Demo.tsx:19-20,49,54,59 | Copy Rae/Maya/Dev links | CopyLine | `…/t/CODE#as=<handoff>&m=<id>` | read by session.ts:85 `readSeatLink` (fragment) | "Copied" 1.6 s | ✅ |
| 16 | Demo.tsx:53 | Maya QR | QR | same link | same | — | ✅ |
| 17 | Demo.tsx:67 | Open the gallery view | `<Link target=_blank>` | `/t/CODE/gallery` | router.tsx:27 | — | ✅ |
| 18 | TripShell.tsx:32-39 | Seat link in URL (effect) | useEffect | readSeatLink(search, hash) → state; navigate(pathname, replace) strips the secret | — | — | ✅ |
| 19 | TripShell.tsx:55 / seatClaims.ts:25 | Demo handoff | effect → redeemOnce | api.tripByCode(code) → api.redeemHandoff(tripId, memberId, code) | POST …/members/:memberId/handoff → {memberToken}; single use (verified 200 then 403 BAD_HANDOFF) | saveSession; on error bootErr = errorCopy (server message) | ✅ |
| 20 | TripShell.tsx:55 / seatClaims.ts:20 | Absent-friend invite | effect → claimOnce | api.claimAbsent(tripId, memberId, inviteKey), with crewKey added | POST …/absent/:id/claim → {memberToken, crewKey} (verified; the 2nd claim gets 403 BAD_INVITE; the organizer's own phone gets 403 OWN_INVITE) | saveCrewKey + saveSession; errors → bootErr | ✅ |
| 21 | TripShell.tsx:42,49 | Re-open my own link | effect | skips the claim (TR1-002) | — | goes straight aboard | ✅ |
| 22 | TripShell.tsx:76 | Keep my place | onClick | setLink(null) | — | stays on this phone's seat | ✅ |
| 23 | TripShell.tsx:77 | Open the link on this phone | onClick | setSwapOk → #19/#20 | — | replaces this phone's seat | ✅ |
| 24 | TripShell.tsx:86-88 | Open my voyage / Back to the start | onClick | setBootErr(null) / navigate("/") | — | — | ✅ |
| 25 | TripShell.tsx:96-105 | Aboard: open socket | useMemo + effect | new TripStore({tripId, memberToken, surface:"phone", autoConnect:false}); open() → emit("trip:join", {tripId, memberToken, surface}, ack) | io.ts:139 → replay (replay.ts:66) | ack flushes the offline outbox; close() on unmount | ✅ |
| 26 | JoinCrew.tsx:21-25 | Load voyage | effect | api.tripByCode(code) → {tripId, joinCode, name, status, crew, takenBands, crewClosed} | GET /api/trips/by-code/:code (verified shape) | 404 → "No voyage with that code" | ✅ |
| 27 | JoinCrew.tsx:32 | Enter a different code | onClick | navigate("/join") | — | — | ✅ |
| 28 | JoinCrew.tsx:38-52 | Full / late / closed notice | render | trip.crew.length, status, crewClosed | server refuses with CREW_FULL / BAD_PHASE / CREW_CLOSED (verified CREW_FULL) | — | ✅ |
| 29 | JoinCrew.tsx:54-71 | Join the crew (submit) | onSubmit, `busy` | api.join(tripId, {name, band, origin}), with crewKey added | POST …/members → {memberId, memberToken, crewKey} | saveSession → onJoined → navigate(`/brief`); on error: message, then reload takenBands | ✅ |
| 30 | PhaseRoutes.tsx:60-65,84 | Phase guard | `<Navigate>` | allowedScreens(status, sealed, organizer) | all 8 nested routes exist (76-83); the switch covers all 6 TripStatus values (TS-checked) | wrong or unknown segment → phase's first screen | ✅ |
| 31 | PhaseRoutes.tsx:30-39 | Auto-advance on phase change | effect on trip.status | navigate(`/t/CODE/<first>`) | — | not on the first snapshot, so a deep link is kept | ✅ |
| 32 | PhaseRoutes.tsx:41-47 | No trip yet | render | state.connected / state.error | trip:join refusal → `error` | spinner, or error note with **no way out** | ⚠️ L1-002 |
| 33 | PhaseRoutes.tsx:48-58 | Join again (seat gone) | onClick | clearSession(code) → navigate(`/join?code=CODE`) | — | — | ✅ |
| 34 | PhaseRoutes.tsx:70-73 | Error banner Dismiss | onClick | store.clearError() | — | — | ✅ |
| 35 | organizer.tsx:102-113 | Close / Reopen the crew | onClick | store.emit("crew:setOpen", {open}) | io.ts:176 → crew.ts:91 (verified; `trip:state.crewClosed` and by-code follow) | trip:state re-renders the label | ✅ |
| 36 | Muster.tsx:18,30-39 | Invite QR + code | render | `${origin}/t/CODE` | TripShell → JoinCrew | — | ✅ |
| 37 | Muster.tsx:63-65 | Seal my terms | onClick | navigate(`/brief`) | allowed | — | ✅ |
| 38 | Muster.tsx:72-74 | Re-read my terms | onClick | navigate(`/brief`) | allowed | — | ✅ |
| 39 | Muster.tsx:148 | + Add an absent friend | onClick | open the form; band = firstFreeBand | — | — | ✅ |
| 40 | Muster.tsx:150-164 | Make their invite (submit) | onSubmit, `busy` | api.addAbsent(tripId, token, {name, band, origin}) | POST …/absent (Bearer) → {memberId, inviteKey, invitePath `/t/CODE/brief#m=&k=`} | onInvite → Muster keeps the URL (sessionStorage) and opens it, even though the form unmounts at 4 crew (verified race) | ✅ |
| 41 | Muster.tsx:175 | Cancel | onClick | local | — | — | ✅ |
| 42 | Muster.tsx:118-127 | Show/Hide X's invite link, QR, CopyLine | onClick | local | — | shown for any unsealed absent friend, even after they claimed | ⚠️ L1-009 |
| 43 | Muster.tsx:105-114,130 | Make a new link for X | onClick, `busy` | api.reissueInvite(tripId, token, memberId) | POST …/absent/:id/invite → {memberId, inviteKey, invitePath} (verified; old key → BAD_INVITE; after claim → 409 INVITE_CLAIMED) | errorCopy (INVITE_CLAIMED copy) | ✅ |
| 44 | organizer.tsx:12-29 | Weigh anchor | onClick + useSendGuard | store.emit("table:start", {}, ack) | io.ts:161 (verified BRIEFS_PENDING refusal) | disabled unless all sealed and ≥2 crew; refusal re-opens | ✅ |
| 45 | organizer.tsx:52-61 | Show headset code | onClick, `busy` | api.headsetCode(tripId, token) → {code, expiresAt} | POST …/headset-code (verified 8 chars; non-organizer 403) | code shown; ApiError shown | ⚠️ L1-006 (Muster only) |
| 46 | organizer.tsx:47 | Hide code | onClick | local | — | — | ✅ |
| 47 | organizer.tsx:71-96 | Unpair headset (two-tap) | useTwoTap | api.unpairHeadset(tripId, token) | DELETE …/headset → {ok:true} (verified) | "Headset unpaired"; errorCopy on failure | ⚠️ L1-006 (Muster only) |
| 48 | organizer.tsx:131-157 | Sail without them (after 2 min) | 5 s interval + onClick + useSendGuard(reopenOnOk) | store.emit("table:sailWithout", {memberIds}) | io.ts:162 → crew.ts:192 | trip:state crew shrinks; clock kept in localStorage per device | ✅ |
| 49 | BrassDial.tsx:64-69 | Dial drag / arrow keys | pointer / key | onChange(cents), snapped to 5,000 and clamped 30,000-300,000 | CAP_* constants (cents) | — | ✅ |
| 50 | BrassDial.tsx:106-107 | −50 / +50 | onClick | set(value ± CAP_STEP_CENTS) | cents | — | ✅ |
| 51 | BrassDial.tsx:92-101 | Tap the numeral to type dollars | onBlur / Enter | set(Number(draft) * 100): dollars → cents | — | — | ✅ |
| 52 | Brief.tsx:105-110 | Date chips | onClick | local dateWindowIds from trip.dateWindows[].id | validateBrief keeps only known ids | — | ✅ |
| 53 | Brief.tsx:116-126 | Must-have chips (≤3, pencil marks) | onClick | local Tag[]; clears the pencil mark | MAX_MUST_HAVES | — | ✅ |
| 54 | Brief.tsx:131-140 | Won't-do chips (≤3) | onClick | local Dealbreaker[] | MAX_DEALBREAKERS | — | ✅ |
| 55 | Brief.tsx:143-153 | Anything else? (≤200) | onChange | local note; noteSource "voice" only while the text equals the transcript | NOTE_MAX_CHARS 200 on both sides | — | ✅ |
| 56 | VoiceNote.tsx:15-47 / useRecorder.ts:90 | Say it instead (≤20 s) | onClick toggle | api.hailAudio(tripId, token, Blob) → {transcript} | POST …/hail-audio (raw body, Bearer) | transcript → note; server message on failure; NO_STT hides voice | ⚠️ L1-005, L1-007 |
| 57 | Brief.tsx:73-78,161 | Seal my terms / Reseal | onClick + useSendGuard(payload = prev sealedAt) | store.emit("brief:submit", {capCents, dateWindowIds, mustHaves, dealbreakers, note?, noteSource}, ack) | io.ts:160 → crew.ts:156 (BRIEFING or VOIDED; VOIDED → BRIEFING) | waits for a newer `brief:private.sealedAt` and `me.briefSealed`; refusal re-opens | ✅ |
| 58 | Brief.tsx:61-68 | Move on after sealing | effect | navigate(`/muster` or `/wait`) | allowed in BRIEFING | — | ✅ |
| 59 | Brief.tsx:36-58,90-100 | Adopt replayed brief / memory banner + pre-fill | effects | state.brief, state.memory ← `brief:private` | memory line format matches sealing.ts:168 | pencil marks | ✅ |
| 60 | Brief.tsx:81-82,158-161 | Locked (the table met, or VOIDED and not my decline) | render | state.declined, state.booking | — | only the Seal button is disabled | ⚠️ L1-007 |
| 61 | Wait.tsx:31 | Re-read my terms | onClick | navigate(`/brief`) | allowed | — | ✅ |
| 62 | Hail.tsx:114-128 | Hold to hail (≤10 s) | pointerdown/up/leave/cancel | transcribe → api.hailAudio(...) | POST …/hail-audio | 1.5 s preview → onHail; dropped if the Captain is deciding or on unmount | ✅ |
| 63 | Hail.tsx:100-107,134-139 | Type a hail + Enter / Hail (≤160) | onKeyDown / onClick | onHail → store.emit("table:hail", {text}) (Table.tsx:59) | io.ts:163 → table.ts:220 (verified CAPTAINS_CALLING carries `event:"table:hail"`) | words kept in `pending`, restored on refusal | ✅ |
| 64 | Hail.tsx:39-45 / errors.ts:47 | Inline hail refusal | useInlineError(HAIL_CODES) | `error` event | — | matches by code only, ignoring `event` | ⚠️ L1-008 |
| 65 | Hail.tsx:59-68 | Captain calls it during a take or preview | effect on `disabled` | — | — | take dropped, note shown | ✅ |
| 66 | Table.tsx:61-64 / voices.ts | Play voices here | onChange | useVoicePlayback ← state.audio (`turn:audioReady`) | GET /api/audio/:turnId | speechSynthesis fallback after 1.5 s | ✅ |
| 67 | DryRun.tsx:59-65,124 | Chart A/B card | onClick | local selected | — | — | ✅ |
| 68 | DryRun.tsx:74-83 | Vote A / B | onClick | store.emit("plan:vote", {planId}), no ack | io.ts:170 → dryrun.ts:12 → `plan:votes` + `plan:myVote` | optimistic `tapped` wins over the server's `myVote` for good | ⚠️ L1-003 |
| 69 | DryRun.tsx:89 | Pick <city> (organizer) | onClick + useSendGuard | store.emit("plan:pick", {planId}, ack) | io.ts:171 → sealing.ts:15 | → SEALING auto-nav; refusal re-opens | ✅ |
| 70 | DryRun.tsx:102-118 | Auto-pick countdown | 1 s interval | state.autoPick.at (mapped to device clock) | plan:votes / trip:state + serverNow | — | ✅ |
| 71 | DryRun.tsx:12-29,141-173 | Trip clock / my day | 250 ms tick while running | store.dryrunMinute(); state.planPrivate[planId] | dryrun:script / dryrun:control / plan:private | — | ✅ |
| 72 | Seal.tsx:37-52,85 | Set your seal | onClick; approvingRef + useSendGuard | approveWithPasskey(tripId, memberToken, bookingId) → store.emit("seal:set", {bookingId, assertionToken?}, ack) | passkeyRoutes.ts; io.ts:172 → sealing.ts:68 | blocked/cancelled → note; approved/fallback → seal | ⚠️ L1-001, L1-004 |
| 73 | Seal.tsx:96-100 | Lift my seal | onClick + useSendGuard(reopenOnOk) | store.emit("seal:cancel", {bookingId}, ack) | io.ts:173 | re-opens Set your seal; SEAL_LOCKED copy keyed by event | ✅ |
| 74 | Seal.tsx:31-35,109-117 | Call it off (organizer, two-tap) | useTwoTap + useSendGuard | store.emit("booking:callOff", {bookingId}, ack) | io.ts:180 → sealing.ts:100 | CAPTURING shown inline | ✅ |
| 75 | Seal.tsx:126-141 | Seal countdown | 1 s interval | booking.sealDeadlineAt (mapped with serverNow) | booking:created | — | ✅ |
| 76 | SealRow.tsx | Seal row | render | booking.seals[].status/standing | seal:status / booking:created | — | ✅ |
| 77 | Voided.tsx:49-53 | Back to the charts (organizer) | onClick + useSendGuard | store.emit("booking:retry", {}, ack) | io.ts:174 → sealing.ts:112 (verified BAD_PHASE outside VOIDED) | NEEDS_ATTENTION shown inline; → DRY_RUN | ✅ |
| 78 | Voided.tsx:57-61 | Adjust my terms (my decline only) | onClick | navigate(`/brief`) | VOIDED allows brief; server accepts brief:submit and goes back to BRIEFING | — | ✅ |
| 79 | Voided.tsx:28-39 | Headline / my reason | render | state.lastResult.publicReason, state.declined | `booking:result` and `seal:declinedPrivate` both replayed (replay.ts:86-99) | — | ✅ |
| 80 | Booked.tsx:57,70-93 | Save to your log (.ics) | onClick | local Blob download | — | — | ✅ |
| 81 | Booked.tsx:15-21 | Reference / share / itinerary | render | lastResult.reference ?? booking.reference; sealPrivate.amountCents; planPrivate | replayed | — | ✅ |
| 82 | crew.tsx:45-58 | CopyLine | onClick | navigator.clipboard | — | "Copied" | ✅ |
| 83 | useRecorder.ts:114-125 | Voice availability | effect (once per page) | api.health() → `eleven` | GET /api/health (public: {ok, eleven, degraded}) | voice controls hidden until true | ✅ |

**Totals:** 83 elements · 74 ✅ · 9 ⚠️ · 0 ❌

### A.2 REST client (net/api.ts) against the server

| api.ts | Method + path | Body | Auth | Response | Server | Match |
|---|---|---|---|---|---|---|
| cities | GET /cities | — | — | {cityId, name, notes}[] | routes.ts:192 | ✅ |
| createTrip | POST /trips | {name, organizerName, band, origin, cityIds?, crewKey?} | — | {tripId, joinCode, memberId, memberToken, crewKey} | :72 | ✅ |
| tripByCode | GET /trips/by-code/:code | — | — | {tripId, joinCode, name, status, crew, takenBands, crewClosed} | :83 | ✅ |
| join | POST /trips/:tripId/members | {name, band, origin, crewKey?} | — | {memberId, memberToken, crewKey} | :100 | ✅ |
| addAbsent | POST /trips/:tripId/absent | {name, band, origin} | Bearer | {memberId, inviteKey, invitePath} | :107 | ✅ |
| reissueInvite | POST /trips/:tripId/absent/:memberId/invite | {} | Bearer | same as addAbsent | :113 | ✅ |
| claimAbsent | POST /trips/:tripId/absent/:memberId/claim | {inviteKey, crewKey?} | — | {memberToken, crewKey} | :117 | ✅ |
| redeemHandoff | POST /trips/:tripId/members/:memberId/handoff | {code} | — | {memberToken} | :123 | ✅ |
| headsetCode | POST /trips/:tripId/headset-code | {} | Bearer | {code, expiresAt} | :128 | ✅ |
| unpairHeadset | DELETE /trips/:tripId/headset | — | Bearer | {ok:true} | :133 | ✅ |
| pairHeadset | POST /xr/pair | {code} | — | {tripId, joinCode, deviceToken} | :138 | ✅ (XR only) |
| hailAudio | POST /trips/:tripId/hail-audio | raw Blob | Bearer | {transcript} | :168 | ✅ (L1-005, L1-010) |
| seedDemo | POST /demo/seed | {} + X-Dev-Key | — | {tripId, joinCode, organizer, maya, dev (each with handoff), headsetCode} | :187 | ✅ |
| health | GET /health | — | — | {ok, eleven, degraded} (public) | :196 | ✅ |
| passkeyStatus | GET …/passkey | — | Bearer | {registered, required} | passkeyRoutes.ts:47 | ✅ |
| passkeyRegisterOptions / Verify | POST …/passkey/register/options · /verify | {} · {response} | Bearer | options · {ok} | :53 / :59 | ✅ |
| passkeyAuthOptions / Verify | POST …/passkey/auth/options · /verify | {} · {response, bookingId} | Bearer | options · {assertionToken} | :68 / :76 | ✅ |

No mismatches in path, method, body field, auth or response shape.
- Error bodies are `{code, message}`.
- A non-JSON or empty error body still becomes an `ApiError(status)`.
- An unknown `/api` route is a JSON 404 (verified).
- A network failure is `ApiError(0, …, "OFFLINE")`.

### A.3 Socket emits from the phone (ClientToServer)

The phone emits these events: `trip:join`, `brief:submit`, `table:start`, `table:sailWithout`, `table:hail`, `plan:vote`, `plan:pick`, `seal:set`, `seal:cancel`, `booking:retry`, `booking:callOff` and `crew:setOpen`. All of them match `events.ts` and `io.ts:139-180` in event name and payload field names.
- **Types:** `capCents` is in cents, `planId` and `bookingId` are not mixed up, and `memberIds` is `string[]`.
- **Acks:** every guarded button passes an ack through `useSendGuard`. `crew:setOpen`, `plan:vote` and `table:hail` send no ack and rely on the caller-only `error` event.
- **Never sent by the phone:** `dryrun:control`, `headset:unpair` (the REST DELETE is used instead) and `client:log`.

---

## B. Return path: ServerToClient → tripStore → screens

| Event | tripStore (net/tripStore.ts) | State written | Read by phone | Replayed on join? | Verdict |
|---|---|---|---|---|---|
| trip:state | :94-113 | trip, booking (deadline mapped), shortlist (kept if same ids), votes, autoPick (mapped), myVote (kept only on the same status), and resets turns/audio/planPrivate/dryrun when entering BRIEFING or AT_TABLE | every screen | yes (after table:decided) | ✅ |
| brief:private | :114 | brief, memory | Brief | yes | ✅ |
| table:watch | :116 | trip.negotiation.watch | (headset and gallery; the phone uses turn.watch) | no | ✅ |
| turn:new | :118 | turns (deduplicated, sorted) | Table, Hail (my last hail) | yes (last 50) | ✅ |
| turn:audioReady | :120 | audio | voices.ts | yes | ✅ |
| table:decided | :121 | shortlist | DryRun, Seal, Booked | yes | ✅ |
| plan:private | :122 | planPrivate | DryRun, Booked | yes | ✅ |
| dryrun:script / dryrun:control | :123-135 | dryrun (skew-mapped) | DryRun | script yes | ✅ |
| plan:votes | :136 | votes, autoPick | DryRun | via trip:state | ✅ |
| plan:myVote | :137 | myVote | DryRun (see L1-003) | yes (DRY_RUN) | ✅ |
| booking:created | :138-143 | booking; keeps declined, lastResult and sealPrivate only for the same booking | Seal, Voided, Booked, Brief | yes | ✅ |
| seal:private | :144 | sealPrivate | Seal, Booked | yes | ✅ |
| seal:status | :145-149 | booking.seals[].status | Seal, SealRow | via snapshot | ✅ |
| seal:declinedPrivate | :150 | declined | Voided, Brief `locked` | yes | ✅ |
| booking:result | :151 | lastResult | Voided, Booked | yes (after booking:created) | ✅ |
| table:failed | :153 | error (not on the Gallery) | PhaseRoutes banner | — | ✅ |
| error | :154 | error | banner, useInlineError owners, Seal PASSKEY_REQUIRED | — | ✅ (L1-004, L1-008) |

**Read but never written:** none. Every `ClientState` field a phone screen reads has a writer, with the right name and shape.

**Written but not read by the phone:** `dryrun.planIds`, `trip.negotiation`, `trip.candidateCities`, `trip.paymentsMode` and `trip.version`. They are used by the headset and gallery, or not at all; this is harmless.

**Routing:**
- Every `navigate` or `<Link>` target exists in `router.tsx`: `/`, `/new`, `/join`, `/join?code=`, `/t/:code`, `/t/:code/{muster,brief,wait,table,dryrun,seal,booked,voided}` and `/t/:code/gallery`.
- `allowedScreens` covers all 6 `TripStatus` values.
- A deep link reload of `/t/CODE/<screen>` works: Vite returns index.html (200). TripShell then loads the saved session, the replay rebuilds state, and the guard keeps an allowed screen or redirects to the phase's main one.
- A lower-case code in the URL works: the session key and the lookup are both upper-cased.

---

## C. Findings

### L1-001 — Cancelling the passkey set-up prompt still sets the seal
- Severity: Medium
- Location: net/passkey.ts:35-46 → phone/screens/Seal.tsx:42-44
- Evidence:
  - A member with no passkey anywhere (`registered:false, required:false`) on a phone with a platform authenticator gets the OS "create a passkey" prompt first.
  - If they tap Cancel, `startRegistration` throws a WebAuthn `NotAllowedError`. That is not an `ApiError`, so `code` is undefined, and line 45 returns `{kind:"fallback"}`.
  - Seal.tsx:44 then emits `seal:set` without an assertion. The server accepts it, because `hasPasskey(memberId)` is false (sealing.ts:75).
  - Result: the member declined the biometric prompt, but their share was authorized anyway. The same happens when `register/verify` fails (PASSKEY_FAILED).
- Fix: in the register `catch`, tell "user declined / prompt failed" apart from "passkeys impossible here".
  - For a WebAuthn error (`e.name === "NotAllowedError"` or any non-`ApiError`), return `{kind:"cancelled", message: PASSKEY_COPY.cancelled}`.
  - Keep `fallback` only for `!supported || !platform`.
  - Optionally, add a "Seal without a passkey" link after a cancel, so the confirm-tap path is a deliberate choice.
- Effort: S
- Scope: apps/web/src/net/passkey.ts (plus a test in net/)
- Acceptance: on a device with Touch ID and no passkey, tap Set your seal and cancel the create-passkey sheet. No `seal:set` is emitted, the seal row stays "waiting", and the note says the seal isn't set.

### L1-002 — A saved seat for a voyage the helm can't find is a dead end
- Severity: Low
- Location: phone/screens/PhaseRoutes.tsx:41-47 (with TripShell.tsx:92-93, Landing.tsx:21-23)
- Evidence:
  - Live: `trip:join {tripId:"nope"}` returns ack `{ok:false, code:"NO_TRIP"}` plus an `error` event.
  - The phone then shows only the margin note "That voyage doesn't exist.", with no button. There is no "Back to the start", and the stale `aa:session:CODE` is not cleared.
  - Landing's "Back to voyage" keeps leading there.
  - A `LOADING` (503) refusal is also never retried: the join is only resent on reconnect.
- Fix:
  - When `!trip && state.error` with code NO_TRIP, show "Back to the start" and clear the session (and `aa:last` if it points there).
  - For LOADING, re-emit `trip:join` after a short delay.
- Effort: S
- Scope: apps/web/src/phone/screens/PhaseRoutes.tsx, apps/web/src/net/session.ts
- Acceptance: put a bogus `aa:session:ZZZZZZ` in storage and open `/t/ZZZZZZ`. You see the error plus a working way back, and afterwards Landing no longer offers that voyage.

### L1-003 — The vote highlight is optimistic forever and can't be corrected by the server
- Severity: Low
- Location: phone/screens/DryRun.tsx:37-38,78
- Evidence:
  - `myVote = tapped ?? state.myVote`. Once tapped, the local value always wins.
  - `plan:vote` is sent without an ack. A refusal (for example BAD_PHASE right as the auto-pick fires, or offline EXPIRED) leaves the tapped chart pressed.
  - A vote cast from this member's second device (`plan:myVote` echo) is never shown here.
- Fix: send with `useSendGuard("plan:vote", {reopenOnOk:true})` or an ack, and clear `tapped` when the ack arrives (ok or refused), so `state.myVote` becomes the source of truth.
- Effort: S
- Scope: apps/web/src/phone/screens/DryRun.tsx
- Acceptance: vote A on phone 1, then vote B as the same member on phone 2. Phone 1 now shows B pressed.

### L1-004 — A PASSKEY_REQUIRED refusal is shown twice on the Seal screen
- Severity: Low
- Location: phone/screens/Seal.tsx:89-90; PhaseRoutes.tsx:70-73
- Evidence: Seal reads `state.error?.code === "PASSKEY_REQUIRED"` and renders its own note under the button, but it never clears the error. The shell banner shows the raw server message too. The other inline owners use `useInlineError`, which clears the banner.
- Fix: `const passkeyRefused = useInlineError(["PASSKEY_REQUIRED"])` and render its note.
- Effort: S
- Scope: apps/web/src/phone/screens/Seal.tsx
- Acceptance: force PASSKEY_REQUIRED. Exactly one note appears, under Set your seal.

### L1-005 — Voice notes are cut to 160 characters (the hail limit), but the note allows 200
- Severity: Low
- Location: apps/server/src/api/routes.ts:171 (`transcript.slice(0, HAIL_MAX_CHARS)`) ← phone/components/VoiceNote.tsx:20 / Brief.tsx:155
- Evidence: the Brief's "Say it instead" uses the hail-audio route, which truncates every transcript to 160 characters. A 20 s dictated note, which is longer than 160 characters, loses its end without notice. The typed note allows 200 (NOTE_MAX_CHARS).
- Fix: have the route take a `?kind=note` (or a separate route) that slices to `NOTE_MAX_CHARS`. Pass it from `VoiceNote` through `api.hailAudio(tripId, token, blob, kind)`.
- Effort: S
- Scope: apps/server/src/api/routes.ts, apps/web/src/net/api.ts, apps/web/src/phone/components/{VoiceNote.tsx,useRecorder.ts}
- Acceptance: dictate about 190 characters. The full text lands in the note.

### L1-006 — Headset code and "Unpair headset" are only reachable before the table meets
- Severity: Low
- Location: phone/components/organizer.tsx:32-96, rendered only by phone/screens/Muster.tsx:71; phase.ts:9-17
- Evidence: Muster is allowed only in BRIEFING. From AT_TABLE onwards the organizer can't show a new headset code (for example the Quest was swapped, or the code expired) or revoke a paired headset (SEC-018). That is when the headset is actually in use. Doc 03 puts the card on P5 but doesn't say it should disappear later.
- Fix: also render `HeadsetCodeCard` (or a compact "Headset" link that opens it) on Table, DryRun and Seal for the organizer.
- Effort: S
- Scope: apps/web/src/phone/screens/{Table,DryRun,Seal}.tsx
- Acceptance: during AT_TABLE the organizer can show a fresh code and unpair the headset from the phone.

### L1-007 — On a locked Brief the inputs and the voice note stay live
- Severity: Low
- Location: phone/screens/Brief.tsx:81-82,99-155
- Evidence:
  - When `locked` (VOIDED and not my decline), only the Seal button is disabled.
  - The dial, chips and textarea still change, which suggests the edits count.
  - "Say it instead" still uploads audio to STT, which spends the voyage's STT budget for terms that can't be sealed.
- Fix: pass `disabled={locked}` to the chips, dial, textarea and `VoiceNote` (hide it), or render the brief read-only when locked.
- Effort: S
- Scope: apps/web/src/phone/screens/Brief.tsx, components/{BrassDial,VoiceNote}.tsx
- Acceptance: in VOIDED as a crew member whose seal cleared, the Brief is read-only and has no voice control.

### L1-008 — Inline error owners match by code only, not by the event that caused it
- Severity: Low
- Location: phone/errors.ts:47-57; Hail.tsx:39 (`HAIL_CODES` includes SLOW_DOWN and BAD_INPUT)
- Evidence:
  - The server tags every refusal with `event` (verified: `{code:"CAPTAINS_CALLING", event:"table:hail"}`), but `useInlineError` ignores it.
  - SLOW_DOWN and BAD_INPUT are generic (the socket-level "Easy there…" budget, and "Too many joins" on a `trip:join` retry).
  - On the Table screen such a refusal is taken over by the hail dock. It shows "One hail every few seconds. Your words are still in the box." and restores `pending` text, even though no hail was refused.
- Fix: add an optional `events` filter, `useInlineError(codes, active, ["table:hail"])`, and apply it in Hail, Seal (`booking:callOff`) and Voided (`booking:retry`).
- Effort: S
- Scope: apps/web/src/phone/errors.ts (+ callers, errors.test.ts)
- Acceptance: an `error {code:"SLOW_DOWN", event:"trip:join"}` on the Table screen goes to the banner, not the hail dock.

### L1-009 — Muster keeps offering an absent friend's link after they have opened it
- Severity: Low
- Location: phone/screens/Muster.tsx:23,46-52,118-127
- Evidence:
  - `absent` means `role==="absent" && !briefSealed`. A friend who has claimed their invite but not sealed yet still gets "Show X's invite link", and the stored URL is now spent (verified: the 2nd claim returns 403 BAD_INVITE).
  - "Make a new link" gets 409 INVITE_CLAIMED. The copy for that is correct, but the organizer can't see the state in advance.
  - `CrewPublic` has no "invite opened" flag.
- Fix: add `inviteOpen?: boolean` (or `claimed`) to `CrewPublic` for absent members (layer 3), and hide the link or reissue controls once it is claimed ("X has opened their invite").
- Effort: S
- Scope: packages/shared/src/types.ts, apps/server/src/trips/crew.ts (crewPublic), apps/web/src/phone/screens/Muster.tsx
- Acceptance: after the friend opens their link, the organizer's Muster shows "opened" and no invite link.

### L1-010 — (layer-3 note) An empty hail-audio upload passes the gate and reaches speech-to-text
- Severity: Low
- Location: apps/server/src/api/routes.ts:156-171
- Evidence: live, a POST with no body (`Content-Length: 0`) as a member in BRIEFING answered **502 STT_FAILED**, not 411 or 422. It passed the rate limits and the `spend("stt")` budget, then went to `transcribe()`. The phone never sends an empty take (useRecorder.ts:66 drops it), so there is no user-facing bug, but a scripted client can burn the STT budget and hail limits for free.
- Fix: refuse `len === 0` in `hailAudioGate` with 422 BAD_INPUT before `spend`.
- Effort: S
- Scope: apps/server/src/api/routes.ts
- Acceptance: `curl -X POST -H "Authorization: Bearer …" /api/trips/:id/hail-audio` with no body returns 422, and the STT spend counter is unchanged.

---

## Summary
- 83 elements checked: 74 ✅, 9 ⚠️, 0 ❌.
- 10 findings: High 0 · Medium 1 · Low 9.
- The contract checks found no mismatches:
  - REST: every path, method, body field, Bearer use and response shape, including the new `reissueInvite`, `redeemHandoff` and `unpairHeadset`.
  - Socket: every event name and payload.
  - Units: `capCents` is in cents, the dial's typed dollars are converted ×100, and every server clock value is mapped with `serverNow`.
  - Return path and routing: every state field a screen reads is written by the store, every navigate target exists, and the phase map covers all six statuses.
- All 17 round-1 issues are fixed.
