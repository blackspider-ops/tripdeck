# All Ayes: live end-to-end run in Chrome, round 2

Repo `/Users/tejas/Downloads/untitled folder 3`. The run drove the app in a real Chrome window (phone screens, the laptop chart room and the Gallery) against the dev helm, before and after commit `e64d877`. This file records one open finding (LIVE-001) and five bugs the run found that were already fixed in `e64d877`.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 0 |
| Low | 0 |
| **Total** | **1** |

---

## Findings

### LIVE-001 — "Set your seal" starts a passkey *registration* for members who have no passkey, and on the live run a 1Password sheet blocked the tab
- Severity: High
- Location: apps/web/src/net/passkey.ts:35-46 (`if (!status.registered)` → `passkeyRegisterOptions` → `startRegistration`), apps/web/src/phone/screens/Seal.tsx:37-52 (`setSeal` calls `approveWithPasskey` on every tap)
- Evidence:
  - A member with no passkey on file gets `{registered:false, required:false}` from `GET …/passkey`. On any device with a platform authenticator (Mac, iPhone, Android), `approveWithPasskey` then calls `startRegistration`, so tapping "Set your seal" opens the OS or password-manager "create a passkey" sheet.
  - In the live run, a 1Password "save passkey" sheet opened over the tab and blocked it. The seal couldn't be set until the sheet was dealt with.
  - At the Expo every member seals for the first time, so every tapper hits a registration prompt in the middle of the ceremony. What happens next depends on the password manager, not on the app.
  - Related: cancelling that prompt still seals (L1-001: a non-`ApiError` falls through to `{kind:"fallback"}`), and a `PASSKEY_REQUIRED` refusal shows two notes (L1-004, O2-026).
- Exploit / impact: the headline moment of the demo (every friend sets their seal) is interrupted by a system sheet the presenter can't control, and on some setups the tab is stuck. Registration during sealing also mixes "enrol a credential" with "approve this payment", which is what makes the cancel path (L1-001) unsafe.
- Fix:
  - Never auto-register during sealing. When the member has no passkey (`registered:false` and `required:false`), seal with the confirm tap and do not call `startRegistration`.
  - Offer "Add a passkey" as an explicit, optional action somewhere calm (the Brief or Wait screen), not in the Seal flow.
  - Keep the server gate as it is: a member who *has* a passkey must assert with it (`PASSKEY_REQUIRED` otherwise).
  - While there, treat a cancelled or failed assertion as "not sealed" (L1-001) and show `PASSKEY_REQUIRED` once, through `useInlineError` (L1-004 / O2-026).
- Effort: M
- Scope (dirs a fixer may touch): apps/web/src/net/passkey.ts, apps/web/src/phone/screens/Seal.tsx, apps/web/src/phone/screens/Wait.tsx, apps/web/src/phone/components (new optional "Add a passkey" control), apps/web/src/net (tests)
- Acceptance:
  - A web test: with `passkeyStatus` → `{registered:false, required:false}` on a device that reports a platform authenticator, sealing never calls `navigator.credentials.create` (or `startRegistration`) and emits `seal:set` with no assertion.
  - A web test: with a passkey on file, a cancelled assertion emits no `seal:set`.
  - Manual check in Chrome (with a password manager installed): "Set your seal" on a fresh member shows no passkey sheet, and "Add a passkey" on the Wait screen does.

---

## Found and already fixed (no task)

These five bugs came out of the same live run and are fixed in commit `e64d877`, whose message lists all five. The memory-banner, chart-room help layout and hail-toggle client changes were already in the files at `0430ef9` ("live E2E client fixes"); `e64d877` adds the audio route and tiles-deadline changes and a regression test for the audio route. None of them needs a task.

1. **`/api/audio/:turnId` answered 404 for cached voices.** The default cache lives under `apps/server/.cache`, and `sendFile` refuses any path with a dot segment. Fix: `sendFile(file, { dotfiles: "allow" })` (the path is always the server's own turnId → sha1 key). Test: `apps/server/test/audio-route.test.ts`.
2. **The memory banner repeated "voyage:".** The Brief's memory banner showed the stored prefix twice. Fix in `apps/web/src/phone/memory.ts` (+ `memory.test.ts`).
3. **The city tiles' 4 s give-up timer counted wall-clock time.** A hidden tab or a stall used up the deadline and the Dry Run fell back to the paper city. Fix: `apps/web/src/scene/CityTiles.ts` now counts rendered time only (a frame gap over 250 ms moves the deadline out).
4. **The chart room's help text overlapped the captions.** Fix: layout in `apps/web/src/xr/XRPage.tsx` / `xr.css`.
5. **"Hail the table" was enabled outside the table.** Fix: the laptop toolbar's hail button is disabled unless `AT_TABLE && negotiation.running` (`apps/web/src/xr/XRPage.tsx`). Still open and separate: the button stays enabled during Watch 3, when the server always refuses (L2-005).
