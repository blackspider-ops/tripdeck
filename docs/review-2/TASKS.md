# All Ayes — Task Board, round 2

Generated from the round-2 review in this folder (reviewed at commit `0430ef9`; current HEAD `e64d877`). **137 findings → 129 tasks in 18 work packages (R2-WP).** Duplicates found by several reviewers are merged under one canonical ID (the others are listed as *also covers*). Full detail for any ID: `grep -n "### <ID>" docs/review-2/*.md`.

## Protocol for sub-agents

1. **Pick** a WP whose wave is open (all *Depends on* WPs are `done`) and whose status is `open`.
2. **Claim** it: change its status line to `claimed — <your name>, <date>` in this file. Don't commit; the person running the fixes commits.
3. **Isolate**: work on branch `r2-wp-XX` (ideally a git worktree). Touch **only** the paths in *Scope*. If a fix needs a file outside scope, stop and add a note under *Notes* instead.
4. **For each item**: read its detail section (`grep -n "### <ID>" docs/review-2/*.md`), implement the *Fix*, add the *Acceptance* test, tick the box. Items marked *also covers* are fixed by the same change — verify each of them too.
5. **Gates before handing back** (all must pass):
   - `cd apps/server && npx tsc --noEmit && npx vitest run`
   - `cd apps/web && npx tsc --noEmit && npx vite build --outDir /tmp/aa-<wp> --emptyOutDir && npx vitest run`
   - The Expo script must not change: `apps/server/test/negotiation.test.ts` and the shares in `pricing.test.ts` stay green (Lisbon $2,869 → $1,038 / $868 / $963; Mexico City $1,975), unless your item explicitly changes them — then update the docs too.
   - Privacy: `apps/server/test/e2e.test.ts` still proves the headset and Gallery receive **zero** private events.
   - Never call a paid API (Gemini, ElevenLabs, Backboard, Visa) from a test or a probe. Don't edit `.env`.
6. **Finish**: don't `git commit`. Tick the boxes, set status to `done`, and write what you did, what you verified and anything deferred under *Notes*.

Status values: `open` · `claimed — who, when` · `done` · `blocked — why`. Severity is the worst item in the package. Effort: S = under an hour or two, M = half a day, L = a day or more.

## Waves

| Wave | Work packages | Can run in parallel? |
|---|---|---|
| 1 | R2-WP-01, R2-WP-02, R2-WP-03, R2-WP-04, R2-WP-05 | Yes — scopes are disjoint. Three of them touch `trips/core.ts`, each in one named function only (WP-02 `transition`, WP-03 `crewPublic`, WP-05 `log`). |
| 2 | R2-WP-06, R2-WP-07, R2-WP-08, R2-WP-09 | WP-06, WP-07 and WP-09 in parallel; WP-08 after WP-06 and WP-07 (shared io.ts / events.ts / PhaseRoutes.tsx). |
| 3 | R2-WP-10, R2-WP-11, R2-WP-12 | No — in order 10 → 11 → 12 (crew.ts, passkeys.ts, core.ts, routes.ts are shared). |
| 4 | R2-WP-13, R2-WP-14, R2-WP-15, R2-WP-16, R2-WP-17, R2-WP-18 | WP-13 and WP-15 in parallel (server vs web; both may only *append* to `packages/shared/src/constants.ts`). Then WP-14, then WP-16 (both touch `net/tripStore.ts`), then WP-17, and WP-18 last. |

## Overview

| WP | Wave | Title | Worst | Items (canonical / total) | Effort mix | Depends on | Status |
|---|---|---|---|---|---|---|---|
| [R2-WP-01](#r2-wp-01) | 1 | Sealing without surprise passkey prompts | **High** | 2 / 5 | S×1 M×1 | — | done |
| [R2-WP-02](#r2-wp-02) | 1 | Seal timing & payment integrity | **High** | 7 / 7 | S×6 M×1 | — | done |
| [R2-WP-03](#r2-wp-03) | 1 | Public plan data still narrows every share | **High** | 1 / 1 | L×1 | — | done |
| [R2-WP-04](#r2-wp-04) | 1 | Hail filter oracle | **Medium** | 2 / 2 | S×2 | — | done |
| [R2-WP-05](#r2-wp-05) | 1 | Dev/demo exposure & deploy config | **Medium** | 5 / 5 | S×5 | — | done |
| [R2-WP-06](#r2-wp-06) | 2 | Persistence integrity & restore | **High** | 10 / 10 | S×9 M×1 | R2-WP-02 | done |
| [R2-WP-07](#r2-wp-07) | 2 | Headset & Gallery: pairing state and chart-room UX | **Medium** | 7 / 8 | S×6 M×1 | R2-WP-03 | done |
| [R2-WP-08](#r2-wp-08) | 2 | Client transport & store | **Medium** | 8 / 8 | S×8 | R2-WP-06, R2-WP-07 | done |
| [R2-WP-09](#r2-wp-09) | 2 | Phone UX fixes | **Low** | 4 / 5 | S×4 | R2-WP-01 | done |
| [R2-WP-10](#r2-wp-10) | 3 | Identity, seats & crew races | **Medium** | 6 / 6 | S×4 M×2 | R2-WP-01, R2-WP-06 | done |
| [R2-WP-11](#r2-wp-11) | 3 | Resource bounds & eviction | **High** | 5 / 7 | S×3 M×2 | R2-WP-02, R2-WP-06, R2-WP-10 | done |
| [R2-WP-12](#r2-wp-12) | 3 | Rate limits, budgets & hail-audio | **Low** | 6 / 6 | S×6 | R2-WP-11 | done |
| [R2-WP-13](#r2-wp-13) | 4 | Server refactor & cleanup (no behaviour change) | **Medium** | 19 / 19 | S×13 M×6 | R2-WP-02, R2-WP-04, R2-WP-06, R2-WP-08, R2-WP-10, R2-WP-11, R2-WP-12 | done |
| [R2-WP-14](#r2-wp-14) | 4 | Server write volume & performance | **Medium** | 10 / 10 | S×8 M×2 | R2-WP-13 | done |
| [R2-WP-15](#r2-wp-15) | 4 | 3D leaks, performance & scene cleanup | **Medium** | 15 / 16 | S×10 M×5 | R2-WP-03, R2-WP-07 | done |
| [R2-WP-16](#r2-wp-16) | 4 | Phone & net cleanup, re-renders | **Medium** | 12 / 12 | S×8 M×4 | R2-WP-08, R2-WP-09, R2-WP-12, R2-WP-14, R2-WP-15 | done |
| [R2-WP-17](#r2-wp-17) | 4 | Tests & tooling | **Medium** | 9 / 9 | S×5 M×4 | R2-WP-13, R2-WP-14, R2-WP-15, R2-WP-16 | done |
| [R2-WP-18](#r2-wp-18) | 4 | Docs sync | **Low** | 1 / 1 | S×1 | R2-WP-13, R2-WP-14, R2-WP-15, R2-WP-16, R2-WP-17 | done |

## R2-WP-01

### Sealing without surprise passkey prompts

- **Status:** done
- **Wave:** 1  ·  **Depends on:** —
- **Why:** Every first-time sealer gets an OS or password-manager "create a passkey" sheet in the middle of the seal ceremony (live, a 1Password sheet blocked the tab). Cancelling it still seals, and a PASSKEY_REQUIRED refusal shows twice. This blocks the Expo demo.
- **Scope (only touch these):** apps/web/src/net/passkey.ts (+ new passkey.test.ts), apps/web/src/phone/screens/Seal.tsx, apps/web/src/phone/screens/Wait.tsx, new apps/web/src/phone/components/AddPasskey.tsx, apps/server/src/web.ts (Referrer-Policy header only), apps/server/src/api/passkeyRoutes.ts (status origin only), apps/server/test/passkeys.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **LIVE-001** | High | M | "Set your seal" starts a passkey registration for members with no passkey (a 1Password sheet blocked the tab live); cancelling it still seals; PASSKEY_REQUIRED shows twice | L1-001, O2-026, L1-004 | `live-e2e.md` |
| [x] | **L3-007** | Low | S | The passkey status GET still depends on a Referer that the app's own `Referrer-Policy: no-referrer` removes |  | `trace-3-transport.md` |

**Notes:**
- **Done (fixer R2-WP-01, 2026-09-25):**
  - LIVE-001: `net/passkey.ts` no longer registers during sealing. `prepareSeal()` → no passkey on file (`registered:false, required:false`) sends `seal:set` with the confirm tap and never loads WebAuthn; a passkey on file asserts. New `addPasskey()` / `passkeyAvailability()` back an explicit, optional "Add a passkey" control (`phone/components/AddPasskey.tsx`) on Wait.tsx, offered only on phones with a platform authenticator; it registers only and never seals. Seal.tsx copy now says the tap seals unless a passkey was added. A passkey on another address (`required && !registered`) is a note on Seal with an explicit "Add a passkey" there (dev tunnels; production answers PASSKEY_ELSEWHERE). Server gate (sealing.ts) untouched.
  - L1-001: a cancelled/failed assertion (any non-`PASSKEY_MISSING` error) → `cancelled` note, no `seal:set`. The old "register failed → fallback → seal" path is gone.
  - L1-004 / O2-026: Seal uses `useInlineError(["PASSKEY_REQUIRED"])` (one note, banner cleared, cleared again on the next tap).
  - L3-007: `web.ts` sends `Referrer-Policy: same-origin`; comment in passkeyRoutes.ts `originFor`. **Out-of-scope touch:** the one-line header expectation in `apps/server/test/hardening.test.ts` (no-referrer → same-origin), needed for the gate. **Deferred to R2-WP-18:** docs/04-technical-design.md:587 still says `Referrer-Policy: no-referrer`.
  - Tests: new `apps/web/src/net/passkey.test.ts` (10: no passkey → no `startRegistration` / `navigator.credentials.create`, sends with no assertion; cancel/failed verify → note, no send; elsewhere; unsupported; offline; Add a passkey registers only). `apps/server/test/passkeys.test.ts` +2 (confirm-tap seal without a passkey, registration doesn't seal and then the gate asks; same-origin header + Referer-only status → registered).
  - Gates: web tsc/build/vitest green (62). Server tsc green; vitest 325/328 — the 3 failures (contract.test.ts, wp14-helm.test.ts: hail refused `TABLE_OPENING`) come from a concurrent in-progress edit to `trips/table.ts` hail() (not this WP). e2e zero-private-events green.
  - Manual Chrome check with a password manager not run here (no browser session); R2-WP-09 can add `<AddPasskey>` to Brief.tsx in one line.
- **LIVE-001** — never call `startRegistration` from the seal flow. No passkey on file (`registered:false, required:false`) → seal with the confirm tap. A member *with* a passkey still asserts; the server gate (sealing.ts:75-78) stays as it is, so don't touch it.
- **L1-001** (also covered) — with a passkey on file, a cancelled or failed assertion returns `cancelled` and emits no `seal:set`. The explicit "Add a passkey" action must never seal as a side effect.
- **L1-004 / O2-026** (also covered) — Seal reads `PASSKEY_REQUIRED` through `useInlineError(["PASSKEY_REQUIRED"])`, so it shows once and clears on retry.
- "Add a passkey" goes on Wait.tsx. Showing it on Brief.tsx too is one line for R2-WP-09 (it owns Brief.tsx).
- Don't touch apps/server/src/passkeys/** here: R2-WP-10 changes registration for S2-009 and must build on this flow.
- **L3-007** — prefer `Referrer-Policy: same-origin` in web.ts (still no Referer cross-origin); production pins the relying party anyway.
- If R2-WP-02 needs new Seal.tsx copy for S2-001, it lands after this WP.

## R2-WP-02

### Seal timing & payment integrity

- **Status:** done
- **Wave:** 1  ·  **Depends on:** —
- **Why:** The moment a booking voids still shows whose seal declined (for a standing seal, with certainty). The owed-refund gate can be bypassed through new terms → new table → pick. Retry ignores unreleased holds, and call-off and booking-result edges mislabel or skip guards.
- **Scope (only touch these):** apps/server/src/payments/**, apps/server/src/trips/sealing.ts, apps/server/src/trips/core.ts (transition() only), apps/server/test/{seal-integrity,payments,audit}.test.ts and new server tests

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **S2-001** | High | M | Seal timing and ordering still reveal whose seal declined (standing seals: immediately) |  | `security.md` |
| [x] | **L4-001** | High | S | The SEC-016 owed-refund gate can be bypassed by going VOIDED → BRIEFING → new table → pick |  | `trace-4-service.md` |
| [x] | **S2-010** | Low | S | Retry isn't blocked by unreleased holds, and `void → {ok:false}` counts as released |  | `security.md` |
| [x] | **L4-004** | Low | S | A second or concurrent call-off gets `CAPTURING` ("the booking is being logged") while the booking is actually voiding |  | `trace-4-service.md` |
| [x] | **L4-006** | Low | S | `onBookingResult` transitions without `from`, so the restore-only edges are reachable live; `from` is ignored on a same-status call |  | `trace-4-service.md` |
| [x] | **L4-007** | Low | S | `retry()` commits DRY_RUN before it checks that the Two Charts still resolve |  | `trace-4-service.md` |
| [x] | **L4-008** | Low | S | Every voided attempt writes a memory note to every member, pushing real history out of the last-5 recall |  | `trace-4-service.md` |

**Notes:**
- **S2-001** — the public model stays "set / not set" (doc 06 §7). Whichever design you pick (collect every instruction, then authorize together; or hold the void until the all-set or deadline boundary), standing seals must not authorize before the live ones. The Expo shares and the BOOKED path must not change.
- If S2-001 needs new phone copy, list it here for after R2-WP-01; don't edit Seal.tsx in this WP.
- **L4-001** — the check goes in `pick`, the single money choke point. The optional refusal of VOIDED→BRIEFING in crew.ts is left to R2-WP-10 (it owns crew.ts).
- **L4-007** — this WP adds the sealing.ts guard. Extending `checkCharts` to VOIDED (persistence.ts) is done in R2-WP-06.
- packages/shared is owned by R2-WP-03 in this wave. If a public booking field is needed, coordinate with it.

**Done (fixer R2-WP-02, 2026-09-25):**
- **S2-001 — design: "collect, then settle together" (Option A + a fixed settle point).** A "set" only puts the member's instruction on file (standing seals: at `booking:created`); nothing is authorized while seals are gathered. A lift (`seal:cancel`) is recorded privately (DECLINED `user_cancelled`) and shows publicly as "set"; nothing voids mid-gathering. When the last seal is set, `settleAt` = now + `SEAL_SETTLE_MS` (2.5 s × PACE_SCALE, no jitter); every seal is authorized concurrently (none if one was lifted, so no hold is placed), all answers are awaited, then capture-all or void-all, and the outcome (owners' private reasons, every seal in seat order, one `booking:result`) is published at `settleAt`, or later for everyone if the provider is slower. While held, `toPublic` shows AUTHORIZING, all seals "set", no reference/deadline; call-off → `settling` (CAPTURING), lift → SEAL_LOCKED, whatever the outcome. Only the deadline and a call-off end a booking before all-set. BOOKED path and Expo shares unchanged (only +2.5 s before the result). `orchestrator.ts` (markSet/maybeSettle/settle/authorizeSeal/finish, publicSealOf/publicBookingStatus); documented in doc 06 §4.2 "Seal timing", §5.1–5.2, §5.3 inv. 9, §6, §7, §8, §10.
- **L4-001** — `pick` refuses with NEEDS_ATTENTION (and kicks a re-drive) while *any* booking of the voyage is unsettled (`payments.unsettledFor(tripId)`, sealing.ts:35), before anything changes. Defence in depth: `transition()` refuses → SEALING / → AT_TABLE the same way, so a new table after VOIDED → BRIEFING is refused before it costs a run.
- **S2-010** — `holdsOutstanding(b)` / `unsettled(b)`; retry (and pick/new table) refuse while a voided booking has `authRef && !releasedAt && !capturedAt`. `release()` counts only `ok` or the new `void → {gone:true}` ("no such hold") as released; a plain `{ok:false}` stays outstanding. Provider contract + SIM updated.
- **L4-004** — `payments.callOff` returns `voided | voiding | settling | none`; a second/concurrent call-off (or one during a deadline void) is ok; `settling` → CAPTURING "Every seal is set; the booking is settling."
- **L4-006** — `onBookingResult` only acts in SEALING (`from: ["SEALING"]`); `transition()` checks `from` before the same-status no-op, and the restore-only edges (BOOKED→VOIDED, VOIDED→BOOKED, DRY_RUN→BRIEFING) require an explicit `from`.
- **L4-007** — `retry` checks the Two Charts resolve before DRY_RUN; if not → BRIEFING with REASON_CHARTS_CHANGED and a clear BAD_PHASE.
- **L4-008** — a voided memory note only on the voyage's first attempt and never for a restart void.
- **Tests:** payments.test.ts (rewritten for the new model; new: settle-point timing worlds incl. standing decliner and lifts with fake timers, slow provider, call-off tri-state, S2-010 throw-once / `{ok:false}` vs `gone`), seal-integrity.test.ts (new: helm-level S2-001 timing-indistinguishability across 5 worlds, L4-001, S2-010, L4-004, L4-006, L4-007, L4-008), audit.test.ts (updated to the new model).
- **Verified:** server `tsc` clean and vitest 351/351 (31 files) incl. e2e (zero private events to headset/Gallery), negotiation and pricing (Expo shares unchanged); web `tsc` clean.
- **Outside scope, touched minimally (flag for review):** `trips/persistence.ts` lines 215/236/304 gained an explicit `from` (required by the L4-006 restore-only gate; R2-WP-06 owns the file, no behaviour change). `test/live-state.test.ts` and `test/restore.test.ts`: one assertion each updated to the new model (a lift voids at all-set; a standing seal is publicly set, not authorized).
- **Follow-ups for other WPs:** web copy for CAPTURING in `apps/web/src/phone/errors.ts` says "being logged" → should read "settling" (the phone may also show a short "Settling…" state after the last seal; Seal.tsx is R2-WP-01's, after it lands). `/api/debug` shows the internal booking status and could reveal the outcome up to 2.5 s early to the operator (dev key only) → R2-WP-05/S2-004. Docs 03/09 wording of "voided instantly" in the Nobody-fronts demo → R2-WP-18. R2-WP-06: `checkCharts` to VOIDED (L4-007 part 2); `recover`'s reason override should keep `finish()` so restarts publish at once (settleAt is not held after a restart).

## R2-WP-03

### Public plan data still narrows every share

- **Status:** done
- **Wave:** 1  ·  **Depends on:** —
- **Why:** Re-running the open-source plan builder against the public schedule times, `groupCents` and crew origins narrows each member's share to a handful of values (the organizer's is exact in half the plans) and leaks must-haves. Anyone with the join code, including a token-less Gallery, can do it.
- **Scope (only touch these):** apps/server/src/fit/**, apps/server/src/privacy/context.ts, apps/server/src/negotiation/** (spoken group total rounding only), apps/server/src/trips/core.ts (crewPublic only), apps/server/src/trips/table.ts (publicShortlist / emitShortlist only), packages/shared/src/types.ts, apps/web/src/scene/{DryRun,Globe}.ts, apps/web/src/scene/SceneDirector.ts (setOrigins only), apps/web/src/scene/director/{TurnPlayer,PhaseController}.ts (origin arcs only), apps/web/src/phone/screens/{DryRun,Booked}.tsx, apps/server/test/plan-privacy.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **S2-002** | High | L | Public plan + public crew data still narrow every share to a handful of values (exact for the organizer in half the plans) |  | `security.md` |

**Notes:**
- Port `share-infer.mts` into plan-privacy.test.ts first; it must fail on today's public view.
- The internal `Plan` and the Expo shares don't change. Only the public view does, so negotiation.test.ts and pricing.test.ts stay green.
- Globe arcs read `crew[].origin` today (SceneDirector.ts:149, TurnPlayer.ts:46/77, PhaseController.ts:123). If origin leaves `CrewPublic`, draw arcs from a coarse region or drop the per-member arcs.
- **Done (2026-09-25).** The public contract is now a function of public facts only (city, window, stay, crew size, the set of picks):
  - `PlanPublic.groupCents` → `groupRange: {lowCents, highCents}` (`publicTotalRange`): the lowest–highest total *any* crew of this size could have for that city/stay/window/pick set, widened to $50. Rounding was tried first and rejected: at $100 (and even $500) steps a 2-person YUL crew was still pinned exactly. The exact total stays internal (`Plan.groupCents`, pricing.test/negotiation.test unchanged; Expo LIS/MEX publicly read "$2,650 to $3,100" / "$1,550 to $2,100").
  - `publicDays`: group moments keep their real (dataset-fixed) times; picks are laid out from public facts (dataset order, from 09:00 on day 1, as one party, else day 2), labels `Day 1`/`Day 2`. `publicFlags` come from `publicPlanFlags` (flagged group leg, group moment < 8am, every flight overnight) — the old "everyone has a long walk" flag leaked who walks from a pick.
  - `CrewPublic.origin` removed (`crewPublic`, `GET /trips/by-code`, `trip:state`). The Advocate prompt no longer carries `origin` either (it could be said aloud). Globe: one `HOME_PORT` rivet (centroid of the three airports); all arcs start there.
  - Spoken totals: Advocate `group_total` and the Captain's DECIDE instruction use the range; the system prompt says "group totals as the range given". Privacy context: the range ends are allowed, each chart's exact total is now *sensitive*.
  - Web: phone DryRun card shows "$2,650–3,100 group, all in"; scene DryRun tag shows the range.
- **Attack test** (`plan-privacy.test.ts`, "S2-002" block): a port of share-infer — per member every persona the builder can produce (origin if published else any; flight-relevant dealbreakers; ≤ 3 ordered must-haves), full `buildPlan` → public-view rebuild, total constraint. *Before* (legacy view: exact pick times, dated labels, exact total, origins): Expo book shares narrowed to 1–7 candidates, organizer exact in all 4 YUL charts (test asserts < 8 and ≥ 4 exact). *After*: Expo book ≥ 19 candidates spanning ≥ $182 per member (asserted ≥ 15 / ≥ $150); 20 seeded random 2–4-person crews × top 6 charts: every member's candidate set **equals the listing floor** (what the pick set alone allows, no total) — the public view adds nothing — and is never below 3 values / $120 (YUL has one flight per airport: $190/$280/$310). Truth always among the candidates. Plus a crew-independence test (rotated origins, same picks ⇒ identical public days and range).
- Out-of-scope files touched only because the contract change forces them: `test/b-prompts.test.ts` (DECIDE regex now expects a range), `test/__snapshots__/b-{chartbook-snapshot,prompts}.test.ts.snap` (only `views` hashes and prompt text moved; the `book` hashes — the internal plans — are unchanged), `apps/web/src/scene/labels.test.ts` (fixture dropped `origin`), docs/01 (privacy tier line). Docs 03 §2/§4 and 04 §4.2/§6/§7.2/§10 updated.
- **Deferred / follow-ups:**
  - **`BookingPublic.groupCents` is still the exact total** (payments/orchestrator.ts `toPublic`, R2-WP-02's file): from SEALING on, `booking:created`/`trip:state.booking` give the room Σ shares for the chosen chart, which re-adds the sum constraint. Fix: drop it from `BookingPublic` (no web consumer reads it; only tripStore tests) or publish `groupRange`. Needs the orchestrator owner.
  - docs/05 still shows `origin` in the Advocate facts example (l.54) and "group totals" as public/allowed (l.183, 190, 256) → R2-WP-18 docs sync.
  - Residual by design: an Advocate may voice its member's picks (discreet tier, paraphrased), which attributes pick prices to that member; flights stay hidden.

## R2-WP-04

### Hail filter oracle

- **Status:** done
- **Wave:** 1  ·  **Depends on:** —
- **Why:** The amount check that runs after stripping turns a hail into a free probe of other members' caps and shares (to ±5 %). Refused probes cost nothing, and an outsider can join an open crew from the Gallery URL and probe.
- **Scope (only touch these):** apps/server/src/privacy/{guard,filter}.ts, apps/server/src/trips/table.ts (hail() only), apps/server/scripts/warm-voice-cache.ts (comment only), apps/server/test/{privacy-bypass,hail}.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **S2-003** | Medium | S | Hail filter oracle: amounts assembled by the stripper are then tested against secrets (refusal = "a secret is near X") |  | `security.md` |
| [x] | **L4-005** | Low | S | A hail during the Captain's OPEN (watch 0) is accepted and logged ahead of the Watch-1 proposals |  | `trace-4-service.md` |

**Notes:**
- **S2-003** — sanitisation must not depend on secrets: strip every non-public amount to a fixpoint, then accept or refuse on word count only. Refused hails count toward `HAIL_MIN_INTERVAL_MS`.
- **L4-005** — pick one behaviour for a hail during the Captain's OPEN (refuse, or hold it until Watch 1 ends) and fix the comment or doc that disagrees.
- **Done (fixer R2-WP-04, 2026-09-25):**
  - **S2-003** — `privacy/guard.ts` `sanitizeHail`: runs on a copy of the context with `sensitiveDollars: []`, so the result can't depend on the secrets. It strips every non-public amount (≥ 20 or with a currency sign) repeatedly until none is left, up to 8 passes and otherwise refuses. `9 $5000 0 0` → `$5000` goes, then the `9 0 0` that is left goes too. It then accepts or refuses on word count only, and the `filterLine(...).leak` recheck is gone. `trips/table.ts` `hail()`: `lastHailAt` is now stamped before sanitising, so a refused hail costs the same 5 s as an accepted one. I did not add a per-member, per-watch refusal cap: refusals no longer leak anything and are rate-limited.
  - **L4-005** — I chose to refuse. `hail()` throws `TABLE_OPENING` ("The Captain is opening the table. Hail once the mates start speaking.") while `negotiation.watch < 1`, after the CAPTAINS_CALLING check. The `warm-voice-cache.ts` comment is updated, and doc 05 (§ hails, §7.1 rule 8, failure table) is updated.
  - **Tests:** `privacy-bypass.test.ts` has a new S2-003 block. For 13 probes (`9 $5000 0 0`, `nine $5 hundred`, `1 $7 0 0 0`, zero-width variants, spelled digits, arithmetic, `$900`, Rae's hail), `sanitizeHail` returns the identical result for secrets {900}, {1000}, {2500}, the Expo set and {}, and nothing non-public survives according to `extractAmounts`. `hail.test.ts` checks that refused → `SLOW_DOWN`; that 3 refused hails give `HAIL_AMOUNTS, SLOW_DOWN, SLOW_DOWN`; that through the service, the code, text, ribbon and redactions are identical near and far from the secrets (secrets planted on the probe versus far from it); and that `TABLE_OPENING` applies at Watch 0 and a hail is OK at Watch 1.
  - **Outside scope (test-only, needed for the gates):** `test/wp14-helm.test.ts` (2 tests set `negotiation.watch = 1` before hailing) and `test/contract.test.ts` (waits for the first PROPOSE before hailing, as e2e does). No production file outside scope was touched.
  - **Gates:** server `tsc --noEmit` passes, and `vitest run` is 29 files / 328 tests green. The Expo script is unchanged: e2e, negotiation and contract passed 3× in a row, and Rae's "I'd pay more for the beach." still lands after Watch 1. Web was not touched.
  - **Deferred (web, R2-WP-09/16):** add `TABLE_OPENING` to `apps/web/src/phone/errors.ts` `HAIL_CODES` + `COPY`, so the Hail dock shows it inline; until then it shows in the generic banner with the server's message. Optionally hide the hail control during Watch 0 (see L2-005 for Watch 3).

## R2-WP-05

### Dev/demo exposure & deploy config

- **Status:** done
- **Wave:** 1  ·  **Depends on:** —
- **Why:** The documented demo setup (`vite --host` plus a tunnel) serves the repo, including `memory.json`, over `/@fs/`. The debug view's redaction can be reversed, and in dev mode anyone with a join code can open it. `/demo?key=` puts the dev key in request logs. The tile token and the Docker entrypoint need hardening.
- **Scope (only touch these):** apps/web/vite.config.ts, apps/web/package.json (dev script), apps/server/src/api/{devAccess,debug}.ts, apps/server/src/config.ts (mode detection only), apps/server/src/trips/core.ts (log() audience only), apps/web/src/net/api.ts (captureDevKey only, + api.test.ts), apps/server/scripts/docker-entrypoint.mjs, README.md, DEPLOY.md, docs/09-demo-and-pitch.md, new server tests for debug and dev hosts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **S2-004** | Medium | S | Debug view "redaction" is reversible and, in dev mode, open to anyone holding a join code |  | `security.md` |
| [x] | **S2-005** | Medium | S | The documented dev/demo topology publishes the repo (`vite --host` `/@fs/`) and the dev-open API through the tunnel |  | `security.md` |
| [x] | **S2-013** | Low | S | Dev key still accepted from `/demo?key=` (travels in the request line before the client strips it) |  | `security.md` |
| [ ] | **S2-015** | Info | S | Browser tile tokens ship in the public bundle (restrict them at the provider) |  | `security.md` |
| [x] | **S2-016** | Info | S | Docker entrypoint chowns whatever DATA_DIR/CACHE_DIR names, as root, with no allow-list |  | `security.md` |

**Notes:**
- Expo day: the tunnel should point at a production-mode build (`SERVE_WEB=1 npm run start:prod` with `PUBLIC_BASE_URL` = tunnel URL and a DEV_KEY). At minimum, `npm run dev` without `--host` and with `server.fs.allow`/`fs.deny`. Update docs/09 and README to match.
- **S2-015** is provider-side (Cesium ion: asset 2275207, `assets:read`, production URL; Google: referrer and API restriction) plus a DEPLOY.md note. It needs the account owner; rotate the token if it was ever unrestricted.
- core.ts is touched by three wave-1 WPs in different functions (R2-WP-02 `transition`, R2-WP-03 `crewPublic`, this WP `log`). Stay inside yours.
- **Done (fixer R2-WP-05, 2026-09-25):**
  - **S2-004** — `redactRef(tripId, memberId)` is now `HMAC(per-process SECRET, "debug-ref|trip|member")` (devAccess.ts:112), so it can't be recomputed from the public member id. debug.ts:51 shows seals by `publicSealStatus` (DECLINED → VOIDED), sorted by ref (order no longer maps to the crew list), without instruction/auth refs. core.ts `log()` logs `seal:declinedPrivate` with audience `member:*` (in-memory debug log and the `events` audit). `devAllowed` (devAccess.ts:74) opens dev routes keyless in dev mode only when `isLoopbackRequest` (devAccess.ts:59): loopback socket, loopback Host, no `Forwarded`/`Cf-Connecting-Ip`/`Cf-Ray`, loopback `X-Forwarded-*`, Origin/Referer and the Vite proxy's `x-dev-proxy-client/-host`.
  - **S2-005** — vite.config.ts: `server.host: "localhost"` (package.json `dev` = `vite`, new `dev:lan` = `vite --host`), `server.fs` = strict, allow `apps/web`, `packages/shared`, `node_modules`; deny Vite's defaults + `<repo>/apps/server/**`, `<repo>/docs/**`, `**/.cache/**`, `*.sqlite`, `*.log`. The `/api` proxy always overwrites `x-dev-proxy-client` (peer address) and `x-dev-proxy-host` (original Host) so the helm can tell a LAN/tunnel client from this machine. README / DEPLOY / docs/09 now say: tunnel a production-mode build (`npm run build`; `cloudflared tunnel --url http://localhost:8787`; `APP_ENV=production SERVE_WEB=1 PUBLIC_BASE_URL=<tunnel> DEV_KEY=… npm run start:prod`); `npm run dev` + tunnel on :5173 still works but dev routes need the key. config.ts unchanged (the loopback gate makes the `npm run dev` signal safe).
  - **S2-013** — `captureDevKey` stores the key from `#key=` only; `?key=` is ignored (warned) and still stripped from the address bar. README / DEPLOY / docs/09 updated.
  - **S2-015** — documentation done (DEPLOY.md "Browser tile tokens": ion scope `assets:read`, asset 2275207, allowed URLs; Google referrer + API restriction + quota; rotate if ever unrestricted). **Box left open:** the provider-side restriction needs the account owner.
  - **S2-016** — docker-entrypoint.mjs: `planDirs` validates DATA_DIR/CACHE_DIR against `/var/data`, `/app/apps/server/data`, `/app/apps/server/.cache` before touching anything and exits 1 otherwise; after `mkdir` the realpath is re-checked (symlinked parent). The server import runs only when the script is the main module (so tests can import the checks).
  - **Tests:** apps/server/test/dev-hosts.test.ts (loopback classification; a declined booking's debug page has no `sha256(memberId)` ref, no DECLINED / `sim_auth_` / `sim_ins_`, `seal:declinedPrivate → member:*`; tunnel Host, LAN-via-proxy, cloudflared headers get 403 in dev mode for `/api/debug` and `/api/demo/seed`; the key opens it), apps/server/test/entrypoint.test.ts (`DATA_DIR=/app` etc. refused), apps/web/src/net/api.test.ts (`?key=` not stored, `#key=` stored and sent), apps/web/src/devServer.test.ts (real config in middleware mode: `/@fs/` for root package.json, apps/server/data/memory.json, server source, docs, .env → 403; app, shared, node_modules → 200; proxy header overwrite).
  - **Verified live:** :5173 (the running `vite --host` restarted on the config change) serves `/`, `/demo` and 110 crawled modules with 200; `/@fs/…/memory.json`, `/package.json`, `/docs/…`, server source → 403 on localhost and the LAN IP; `/api/debug/NOPE` → 404 (allowed) from localhost, 403 with `Host: x.trycloudflare.com` and from the LAN IP; socket.io polling through the proxy OK. Gates were green (server 335/335, web 68/68, tsc, vite build) before other wave-1 WPs' in-progress payment/plan changes started failing their own suites.
  - **Deferred:** S2-015 provider-side restriction (account owner). The running Vite still has `--host` from its original command line until it is restarted with `npm run dev`.


## R2-WP-06

### Persistence integrity & restore

- **Status:** done
- **Wave:** 2  ·  **Depends on:** R2-WP-02
- **Why:** A mid-run Atlas outage parks writes forever, so at the next boot a captured booking can be voided ("nobody was charged"). An overlapping instance voids live seals. A reconnect skips passkeys and memory. Stored voyages answer 404 while Mongo is down, and a failed memory load overwrites a person's thread.
- **Scope (only touch these):** apps/server/src/store/**, apps/server/src/trips/persistence.ts, apps/server/src/memory/memory.ts (load/update only), apps/server/src/voice/voice.ts (restoreTurnAudio / audioFile only), apps/server/src/index.ts (restore wrap only), apps/server/src/trips/crew.ts (createTrip join code + standing persist only), apps/server/src/trips/sealing.ts (unset standing on BOOKED only), apps/server/src/payments/orchestrator.ts (recover reason override only), render.yaml, DEPLOY.md (single-writer note), apps/server/test/{store,storage,restore,persistence}.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **L5-001** | High | S | Writes parked during a mid-run MongoDB outage are never retried, so the voyage's final state is lost at the next restart |  | `trace-5-persistence.md` |
| [x] | **L5-002** | Medium | M | Restore assumes it is the only writer: an overlapping instance voids live seals and resets live tables, and the version guard silently drops the loser |  | `trace-5-persistence.md` |
| [x] | **L5-003** | Medium | S | Reconnecting after a failed boot connect doesn't load passkeys, and memory stays on local files for the life of the process |  | `trace-5-persistence.md` |
| [x] | **L5-004** | Medium | S | While MongoDB is unreachable after boot, every stored voyage answers 404 NO_TRIP, and phones don't rejoin once it's back |  | `trace-5-persistence.md` |
| [x] | **L5-005** | Medium | S | A failed first load of `memories`/`backboard_assistants` is cached as empty, and the next `remember` overwrites the person's thread |  | `trace-5-persistence.md` |
| [x] | **L5-006** | Low | S | The restore reconcile path settles the trip but skips the outcome's side effects |  | `trace-5-persistence.md` |
| [x] | **L5-007** | Low | S | The absent member's cap is duplicated in `members.standing.limitCents`, and it's never cleared once the voyage is booked |  | `trace-5-persistence.md` |
| [x] | **L5-009** | Low | S | A malformed booking doc, or a `find` error during restore, still crashes boot |  | `trace-5-persistence.md` |
| [x] | **L5-010** | Low | S | joinCode uniqueness is checked only in memory, so a clash with an archived voyage parks the new voyage forever |  | `trace-5-persistence.md` |
| [x] | **L5-012** | Low | S | The audio cache pruner can delete an mp3 that a restored turn still points at |  | `trace-5-persistence.md` |

**Notes:**
- **L5-003** is also a security gap: after a failed boot connect, the passkey gate drops to a confirm tap until the next restart. Load passkeys *before* `persistAllPasskeys()` in the merge path.
- **L5-004** — the server half is here (503 LOADING instead of NO_TRIP while the db is reconnecting). The client retry on LOADING is part of L1-002 in R2-WP-08.
- Follow-up for R2-WP-02's L4-007: extend `checkCharts` to VOIDED here.
- The docs/04 §4 wording (single writer, the cap in `standing`, turn retention) is L5-013 in R2-WP-18.

**Done (fixer R2-WP-06, 2026-09-25):**
- **L5-001** — `store/writeQueue.ts`: a successful write retries every parked slot (`hasRetriableParked` → `retryFailed`), a 45 s `retryParkedMs` timer runs while anything retriable is parked, a `PermanentWriteError` slot is flagged `permanent` and never re-sent by `retryFailed` (only a fresh persist of that doc), `parked()` lists them; `closeDb` (db.ts) logs every parked `(col,_id)` and stops the timer.
- **L5-002** — new `store/lease.ts` (`HelmLease` + `LeaseStore`; Mongo store `helm_lease {_id:"helm", owner, expiresAt}` in db.ts, 30 s TTL, renewed every 10 s). `index.ts` awaits `acquireHelmLease()` before restore; the reconnect path acquires it before `retryFailed`/merge. Without the lease nothing is queued (`persist`/`append` no-op) and a queued write throws permanent ("fenced"); a lost lease logs and stops writing. `dbHealth()` gains `lease` and `degraded` now includes `staleSkipped > 0` and lease `lost`/`waiting` (`isDegraded`, pure). render.yaml: keep the disk + `numInstances: 1`; DEPLOY.md "One helm at a time"; docs/04 §4 guard sentence corrected + single-writer and parked-retry bullets.
- **L5-003** — `restore()` always `loadPasskeys()` (merge too), before `syncAfterReconnect` re-persists them. `memory.ts` `useMongoMemory()` (called by `syncAfterReconnect`): merges the file threads (append, dedupe, last 20) and assistant ids (Mongo wins) into Mongo, then switches the store. *(memory.ts: one exported function beyond load/update, needed by the fix.)*
- **L5-004** — `persistence.ts missing()`: not connected and `dbHealth().mode` is `reconnecting`/`unavailable` → `503 LOADING`, never NO_TRIP. Client retry on LOADING stays with R2-WP-08 (L1-002).
- **L5-005** — `mongoLocal`: a failed load is not cached (next call loads again), `readOk()` tells callers; `update` on a failed load writes nothing; `assistantFor` refuses to create an assistant when the map didn't load (falls back to local).
- **L5-006** — `reconcileBooking`: SEALING + final booking goes through `sealing.onBookingResult` (lastResult, save, booking:result, memory notes, standing drop); a VOIDED booking without a stored reason gets `restoredVoidReason` (restart, or refunded/refundPending if money had been captured). `orchestrator.recover` passes its reason to `captureAll(b, noChargeReason)`, so a SIM that forgot its holds reports the restart. Defensive SEALING→VOIDED after `recover` now sets lastResult too.
- **L5-007** — `storedStanding()` (persistence.ts): members docs keep `{memberId, instructionRef, expiresAt}` only (crew.ts submitBrief, restore); restore re-derives the limit from the brief and rewrites old docs that still carry it; BOOKED voyages unset `standing` (restore) and `sealing.onBookingResult` drops it on CAPTURED (`dropStanding`). *(Type: `MemberRec.standing` is still typed `StandingInstruction` (records.ts is out of scope); `storedStanding` casts. R2-WP-13 may narrow it to `Omit<…,"limitCents">`.)*
- **L5-009** — per-booking try/catch in `loadVoyages`; new `store/restoreRetry.ts` `restoreOrRetry()` (index.ts): a failed boot restore starts anyway and retries `restore({merge:true})` with backoff.
- **L5-010** — db.ts `classifyWriteError` (`stale`/`joinCode`/`permanent`/`retry`); a trips E11000 on `joinCode` raises `store/hooks.ts raiseJoinCodeClash` (after the slot parks); `crew.ts redrawJoinCode` draws a new code, fixes the code index, saves and broadcasts trip:state.
- **L5-012** — `voice.ts restoreTurnAudio` refreshes the mp3's mtime, so the pruner (most recently used first) keeps it.
- **R2-WP-02 follow-ups** — kept the explicit `from` at persistence.ts repairTrip (`["DRY_RUN","VOIDED"]`), checkCharts and the BOOKED↔VOIDED reconcile; reviewed: all restore-only edges, correct. `checkCharts` now also sends a VOIDED voyage whose charts don't resolve back to BRIEFING (L4-007 part 2). Restore under collect-then-settle: mid-gathering (seals set, nothing authorized) → voided, restart reason, zero authorize calls; mid-settle (settleAt fixed, auths requested, one privately declined) → voided and published at once (`finish()` isn't held after a restart), public seals VOIDED in seat order with no DECLINED/reason, the decliner told privately, re-asked auths (standing seal) released, nothing unsettled; captured-but-not-yet-published → BOOKED.
- **Tests:** store.test.ts (parked retry by timer and by success, permanent stays parked, isDegraded, lease wait/handover/fencing, classifyWriteError, restoreOrRetry), restore.test.ts (L5-006 ×3, WP-02 model ×3, two-helm lease, L5-007; `booked(…, cancel)` helper now sets the last seal so the lift actually voids), persistence.test.ts (L5-003 passkeys, L5-004, L5-009 ×2, L5-010, VOIDED charts), storage.test.ts (L5-005 ×3, L5-003 memory move, L5-012). `test/support/fakeDb.ts`: additive `state.mode` and `state.failLoads` (outside the listed scope, test support only).
- **Verified:** server `tsc` clean, vitest 379/379 (31 files) incl. e2e zero private events, negotiation and pricing (Expo shares unchanged); web `tsc` clean. Doc 06 §5.3 invariants: payments/seal-integrity suites unchanged and green.
- **Deferred / for others:** client retry on `LOADING` → R2-WP-08 (L1-002). Doc 06 §4.2 could say "a restored booking is published at once; a post-restart capture failure reports the restart" and docs/04 §4.2 that `standing` has no limit → R2-WP-18 (L5-013). The lease uses each instance's clock (fine on Render; skew > TTL would matter). L5-008/L5-011 are not in this WP.

## R2-WP-07

### Headset & Gallery: pairing state and chart-room UX

- **Status:** done
- **Wave:** 2  ·  **Depends on:** R2-WP-03
- **Why:** A replaced, expired or unpaired headset silently becomes a spectator, and every tap tells the organizer "Only the organizer can do that." The laptop-view menu opens off-screen. A refused Gallery join says "Finding the voyage…" forever. Small input and shortcut edge cases.
- **Scope (only touch these):** apps/server/src/realtime/io.ts (trip:join handler and device refusals only), apps/server/src/trips/core.ts (deviceOk / requireOrganizer messages only), packages/shared/src/events.ts (error codes), apps/web/src/xr/**, apps/web/src/gallery/**, apps/web/src/scene/SceneDirector.ts, apps/web/src/scene/director/{context,TurnPlayer}.ts, apps/web/src/phone/screens/PhaseRoutes.tsx (token-rejected card only), apps/server/test (socket test), apps/web/src/xr/input.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **L3-001** | Medium | M | A stale member or device token silently joins as a spectator; the headset keeps its controls and every tap says "Only the organizer can do that." | L2-002 | `trace-3-transport.md` |
| [x] | **L2-001** | Medium | S | In the laptop view, the chart-room menu opens partly above the viewport, so "Recenter chart" and "Captions" can't be clicked |  | `trace-2-xr-gallery.md` |
| [x] | **L2-003** | Low | S | The Gallery (and the headset's Enter card) show "Finding the voyage…" forever when the join is refused |  | `trace-2-xr-gallery.md` |
| [x] | **L2-004** | Low | S | Gallery shortcuts ignore modifier keys |  | `trace-2-xr-gallery.md` |
| [x] | **L2-005** | Low | S | The hail card and toolbar button are still offered in Watch 3, when the server always refuses |  | `trace-2-xr-gallery.md` |
| [x] | **L2-006** | Low | S | MouseInput edge cases: a right or middle click selects, and a release outside the canvas leaves the press stuck |  | `trace-2-xr-gallery.md` |
| [x] | **L2-008** | Low | S | Gallery "follow the speaker" turns to the next speaker when the line arrives, not when it plays |  | `trace-2-xr-gallery.md` |

**Notes:**
- **L3-001 / L2-002** are the same bug seen from the transport and from the headset. One server signal (a caller-only `error {code, event:"trip:join"}` or a richer join ack) serves both: the headset clears `aa:headset:<CODE>`, shows the pair card and hides its controls; the phone shows its "Join again" card.
- **L2-005** is not the e64d877 fix. That one disabled the toolbar hail outside AT_TABLE; this one is Watch 3.
- The XRApp dispose and dropped `store.tap` leftovers (L2-007) are merged into O2-053 (R2-WP-15).
- **Done (2026-09-25).**
  - **L3-001 / L2-002 (contract change, doc 04 §7 `trip:join` row).** `trip:join` acks `{ok:true, as:"member"|"device"|"spectator", tokenRejected?:"member"|"device"}` (`JoinAck` in events.ts; the guard in io.ts passes the join's result through, every other event still acks `{ok:true}`). A credential that was sent but not accepted still joins as a spectator, but the caller first gets a caller-only `error {code, event:"trip:join"}`: `TOKEN_REJECTED` or `DEVICE_EXPIRED` (copy in `JOIN_REFUSAL`, events.ts). Not for a headset once the voyage is BOOKED (it just watches the logged voyage). A headset whose pairing ends mid-session gets `DEVICE_EXPIRED` from `requireOrganizer` (core.ts) and from `table:hail` (io.ts) instead of `NOT_ORGANIZER` / `NOT_MEMBER`. Headset (XRPage): the session is state; on `DEVICE_EXPIRED` (join or action) it clears `aa:headset:<CODE>`, disposes the chart room (ends an AR session), closes the socket and shows "Pair the headset again" with the `/xr` link. Phone (PhaseRoutes): `TOKEN_REJECTED` on `trip:join` latches the "Join again" card for that voyage ("This phone's key for the voyage no longer works, so it can only watch."), so clearing the banner can't bring back a refusing member UI. Gallery (token-less) is unchanged: `as:"spectator"`, no error. The `controls` getter idea from L2-002 wasn't needed (the page unmounts the scene).
  - **L2-001.** `WristMenu.deskCamera` (set in `startDesk`, cleared on exit): in the laptop view the menu goes 45 cm along the camera's full view direction, square to it (toolbar and the brass wheel). XR placement unchanged.
  - **L2-003.** Gallery corner and the headset Enter card show the join refusal (`s.error.event === "trip:join"` with no trip) plus a hint.
  - **L2-004.** Gallery `onKey` ignores meta/ctrl/alt and key repeat.
  - **L2-005.** `hailOpen(trip)` (XRApp.ts): AT_TABLE, running, `1 ≤ watch < MAX_WATCHES`, the same gate as table.ts `hail` (Watch 0 is TABLE_OPENING, Watch 3 CAPTAINS_CALLING). Used by the long press / hail card (the store subscription already closes an open card) and the toolbar button.
  - **L2-006.** MouseInput: only button 0 presses/releases count; `setPointerCapture` on down; `pointercancel` / `lostpointercapture` clear the press.
  - **L2-008.** `SceneDirector.onSpeaker(t)` via `DirectorContext.speaking`, called at the start of `TurnPlayer.animate` and in `applyInstant` (history, in order); GalleryApp follows it instead of the raw `turn:new` tap (which also drops that never-unsubscribed tap).
- **Tests.** identity.test.ts ("R2-WP-07 / L3-001 / L2-002" block, over the wire): member / Gallery / bad member token acks + `TOKEN_REJECTED` before the replay and nothing private; a replaced headset's next `table:start` / `table:hail` → `DEVICE_EXPIRED`, its rejoin → `tokenRejected:"device"` + `DEVICE_EXPIRED`; the same after unpair; BOOKED rejoin is quiet. Service-level expired/unpaired assertions now expect `DEVICE_EXPIRED` (a non-organizer member still `NOT_ORGANIZER`). contract.test.ts / b-api.test.ts join acks updated to the new shape. xr/input.test.ts: 5 MouseInput tests (left click selects + captures, right/middle select nothing, 10 px drag no select, 700 ms still press → hail and 300 ms doesn't, cancel/lost capture restores hover and never selects).
- **Verified live (Chrome, laptop view, 920×869 canvas):** menu item centres y = 238…636 px (all inside); a mouse click on "Captions" cycled M → L. Re-paired a second headset over REST, then clicked the Weigh-anchor tag: the page switched to "Pair the headset again", key removed. Reloading with the stale key → same card at the join. `/t/ZZZZZZ/gallery` → "No voyage with that code." A phone with a stale member token for a still-seated member → the "key no longer works" + "Join again" card.
- **For R2-WP-08:** the store ignores the new join ack fields (`flush` only reads `ok`); if it wants `as` / `tokenRejected` in `ClientState`, read them there. The XR/phone hooks key off the `error` event, which the store already keeps.
- **Deferred:** the headset isn't pushed a notice the moment it's unpaired / replaced (it learns on its next action or join). It would need a device-socket eviction from `unpairHeadset` / `pairHeadset` via the bus (identity.ts, not in scope). `DEVICE_EXPIRED` isn't in routes.ts's status map (its HelmError carries 403 itself).

## R2-WP-08

### Client transport & store

- **Status:** done
- **Wave:** 2  ·  **Depends on:** R2-WP-06, R2-WP-07
- **Why:** The join ack waits on a slow memory recall, and the replay can send stale snapshots. Actions tapped before the join ack skip the outbox. The socket contract and REST codes have loose ends. A stale error survives a reconnect, REST calls never time out, and a saved voyage that's gone is a dead end.
- **Scope (only touch these):** apps/web/src/net/{tripStore,api,session}.ts + tests (api.ts: not captureDevKey), apps/server/src/realtime/io.ts, apps/server/src/trips/replay.ts, packages/shared/src/events.ts, apps/server/src/api/routes.ts (trips pre-middleware and audio route only), apps/server/src/api/passkeyRoutes.ts (BAD_BOOKING status only), apps/web/src/phone/screens/{PhaseRoutes,JoinCrew,Create}.tsx (join retry and fetch guards only), apps/server/test/{contract,b-api}.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **L1-002** | Low | S | A saved seat for a voyage the helm can't find is a dead end |  | `trace-1-phone.md` |
| [x] | **L3-002** | Low | S | The `trip:join` ack arrives after the whole replay, including a slow memory recall, and the rest of the replay emits snapshots taken before that wait |  | `trace-3-transport.md` |
| [x] | **L3-003** | Low | S | Actions tapped between `connect` and the join ack skip the outbox and can race the server's hydrate |  | `trace-3-transport.md` |
| [x] | **L3-004** | Low | S | Loose ends in the socket contract |  | `trace-3-transport.md` |
| [x] | **L3-005** | Low | S | Small inconsistencies in REST and join error codes |  | `trace-3-transport.md` |
| [x] | **L3-009** | Low | S | The client store keeps the voided attempt's private leftovers after "back to the charts" |  | `trace-3-transport.md` |
| [x] | **O2-048** | Medium | S | REST calls have no timeout or abort, and one fetch has no stale-response guard |  | `optimization.md` |
| [x] | **O2-049** | Low | S | A stale error survives a reconnect; the reconnect delay never grows |  | `optimization.md` |

**Notes:**
- **L1-002** — its LOADING retry is the client half of L5-004 (R2-WP-06).
- **L3-002** — the doc 04:393 ack-order line goes to R2-WP-18.
- **L3-005** — `BAD_BOOKING` just gets thrown with 409 here. The single code→status table is O2-025 (R2-WP-13).
- **Done (fixer R2-WP-08, 2026-09-25):**
  - **L3-002** — `replay.ts`: new `replayNow()` does every wait first (the one-tick memory race via a new private `recall()`, and `sealPrivateFor`'s card digits, in parallel), then builds and sends the whole replay in one synchronous pass from the voyage as it is now; a prefetched `seal:private` is only sent if it is for the booking that is current after the wait; a member sailed without during the wait gets nothing private. It returns `{later}` (the slow-recall second `brief:private`). `replay()` = `replayNow` + `await later` (unchanged for service tests). `io.ts` `trip:join` calls `helm.replayer.replayNow` and acks without waiting for `later`. Doc 04 §7 / §7.1 / §7.3 updated with the new order (the ack-order line was meant for R2-WP-18; done here since §7 changed anyway).
  - **L3-003** — `tripStore.ts`: a per-connection join state (`pending` / `joined` / `refused`); `emit` sends directly only when connected **and** not pending, else queues. `ClientState` gained `joined` and `role` (the JoinAck's `as`, R2-WP-07 follow-up). A late join ack for a dropped connection is ignored.
  - **L1-002** (+ client half of L5-004) — store: a `LOADING` join ack re-sends `trip:join` after `JOIN_RETRY_MS` 1/2/4/8/10 s (cap; while connected; timer cleared on disconnect/close), keeping the outbox; a landed join clears the `LOADING` notice. `session.ts forgetVoyage(code)` clears the seat and `aa:last` if it points there. `PhaseRoutes.tsx`: with no trip, `NO_TRIP` shows the note plus "Back to the start" (forgets the voyage, goes to `/`); `LOADING` shows the plotting mark "Fetching the voyage from the ship's log…". `JoinCrew.tsx`: by-code lookup retries `LOADING` (1/2/4/8 s) then gives up.
  - **L3-004** — `headset:unpair` removed from `events.ts` (C2S now 14) and io.ts (the phone only ever used `DELETE /trips/:id/headset`); `crew:setOpen` requires a boolean (`BAD_INPUT`); `client:log` is registered without its ack; `socket.onAny` answers any event outside `CLIENT_TO_SERVER_EVENTS` that carries an ack with `{ok:false, code:"UNKNOWN_EVENT"}` (new exported `UNKNOWN_EVENT`).
  - **L3-005** — routes.ts pre-middleware skips `by-code` (wrong method → JSON 404 `NOT_FOUND`); `/audio/:turnId` 404 is JSON `NOT_FOUND` (also when sendFile fails; Cache-Control removed then); `BAD_BOOKING` thrown with 409; io.ts `trip:join` with neither `tripId` nor `joinCode` → `BAD_INPUT` (after the rate limits, not counted as a miss).
  - **L3-009** — store `trip:state` without a booking clears `lastResult`, `declined`, `sealPrivate`.
  - **O2-048** — `api.ts call()` takes `{signal, timeoutMs = CALL_TIMEOUT_MS (15 s)}`: one AbortController aborts the fetch; a race rejects at once with `ApiError(0, …, "TIMEOUT" | "ABORTED")` even if fetch ignores its signal. `hailAudio` 60 s. `cities` / `tripByCode` accept opts. `JoinCrew` aborts its lookup (and retry timer) on unmount / code change; `Create` aborts `cities()` instead of an `alive` flag. (captureDevKey untouched.)
  - **O2-049** — `connect` clears `error` (join-time notices come after it); `reconnectionDelayMax` 2 s → 10 s (exponential with jitter from 1 s).
  - **Tests.** web `tripStore.test.ts` +6 ("R2-WP-08" block: action before join ack waits + role kept + re-queued after drop; refused join; LOADING retry with growing waits, queue kept, notice cleared, no retry after drop; reconnect clears old error but keeps TOKEN_REJECTED; reconnect delay 1 s → 10 s; L3-009 leftovers). `api.test.ts` +3 (never-answering fetch → TIMEOUT and aborted signal; caller abort → ABORTED; pre-aborted signal). `session.test.ts` +1 (`forgetVoyage`). `contract.test.ts` (web) helper now marks the socket connected (needed by the late-ack guard). server `contract.test.ts` +3 (L3-002 over the wire with a 1.5 s recall: ack < 500 ms, an action acked before the memory lines, which follow; L3-004 four cases; L3-005 empty/null joins → BAD_INPUT). `b-api.test.ts` +4 (by-code wrong method, audio JSON 404, BAD_BOOKING 409, replay held in its wait while call-off → retry → new pick: only the new booking is replayed, no stale `seal:private`).
  - **Gates:** server `tsc` clean, `vitest` 31 files / 386 tests green (incl. e2e zero private events, negotiation/pricing). web `tsc` clean, `vite build` ok, `vitest` 14 files / 89 tests green.
  - **Shared files:** routes.ts / passkeyRoutes.ts carry R2-WP-10's concurrent edits; mine are only the pre-middleware `by-code` skip, the audio route and the BAD_BOOKING status line. docs/04 line ~343 (headset section) lost its `headset:unpair` mention.
  - **Deferred:** a DOM test for PhaseRoutes/JoinCrew (no harness in apps/web; covered by tsc/build). JoinCrew's post-failure crew refresh (`api.tripByCode` after a refused join) still has no abort (it's inside the submit handler) → R2-WP-16 if wanted. A refused (non-LOADING) join such as `SLOW_DOWN` is still only re-sent on reconnect.

## R2-WP-09

### Phone UX fixes

- **Status:** done
- **Wave:** 2  ·  **Depends on:** R2-WP-01
- **Why:** Inline errors are matched by code only, so the hail dock claims unrelated SLOW_DOWN / BAD_INPUT refusals. The vote highlight can't be corrected by the server. Headset controls disappear once the table meets. A locked Brief still takes edits and spends speech-to-text.
- **Scope (only touch these):** apps/web/src/phone/errors.ts (+ errors.test.ts), apps/web/src/phone/components/{Hail,BrassDial,VoiceNote,organizer}.tsx, apps/web/src/phone/screens/{Brief,DryRun,Table,Seal,Voided}.tsx

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **L1-008** | Low | S | Inline errors match by code only, so the hail dock and its "One hail every few seconds" copy claim unrelated SLOW_DOWN / BAD_INPUT refusals | L3-008 | `trace-1-phone.md` |
| [x] | **L1-003** | Low | S | The vote highlight is optimistic forever and can't be corrected by the server |  | `trace-1-phone.md` |
| [x] | **L1-006** | Low | S | Headset code and "Unpair headset" are only reachable before the table meets |  | `trace-1-phone.md` |
| [x] | **L1-007** | Low | S | On a locked Brief the inputs and the voice note stay live |  | `trace-1-phone.md` |

**Notes:**
- **L1-008 / L3-008** — `useInlineError` takes `(code, event)` pairs; the hail copy is keyed on `SLOW_DOWN` + `table:hail`, and a plain SLOW_DOWN uses the server's message.
- Optional: render R2-WP-01's "Add a passkey" control on Brief.tsx too.
- **Done (fixer R2-WP-09, 2026-09-25):**
  - **L1-008 / L3-008** — `errors.ts`: new pure `ownsError(err, codes, events?)`; `useInlineError(codes, active, events?)` claims a refusal only when its code matches and (if `events` is given) `error.event` is one of them; a refusal with no `event` isn't claimed by a filtered owner. The hail copy moved to `COPY_BY_EVENT["SLOW_DOWN table:hail"]`, so any other SLOW_DOWN (join, socket budget, REST) keeps the server's message. `Hail.tsx` passes `HAIL_EVENTS = ["table:hail"]`; `Seal.tsx` call-off → `["booking:callOff"]`; `Voided.tsx` retry → `["booking:retry"]`. (Seal's PASSKEY_REQUIRED owner is unfiltered on purpose: only `seal:set` can raise it.)
  - **L1-003** — `DryRun.tsx`: `plan:vote` is sent with an ack; the answer to the latest tap (ok or refused) clears the optimistic `tapped`, so `state.myVote` (the `plan:myVote` echo, emitted before the ack by `dryrun.ts vote()`) is the truth: a refused vote springs back, a vote from the member's other phone shows here.
  - **L1-006** — `organizer.tsx`: new `HeadsetControls` (organizer only): a quiet "Headset code or unpair" link that opens the existing `HeadsetCodeCard` (fresh code + Unpair headset). Rendered at the foot of Table, DryRun and Seal.
  - **L1-007** — locked Brief is read-only: `BrassDial` gained `disabled` (no pointer/keys/typing/±50), date/must/won't chips `disabled`, note textarea `readOnly`, `VoiceNote` gained `disabled` (renders nothing, stops a take in progress and drops its blob, so no STT is spent).
  - **Follow-ups done:** `TABLE_OPENING` added to `HAIL_CODES` + `COPY` (R2-WP-04). `CAPTURING` copy now "…every seal is set and the booking is settling." (R2-WP-02). `<AddPasskey>` added under the Seal button on Brief.tsx (R2-WP-01; it hides itself where no passkey can be added). Seal.tsx: once every seal is set and no `booking:result` for this booking has arrived, the status line reads "Every seal is set · settling…" (same for every outcome) and the organizer's "Call it off" is hidden (the helm would answer CAPTURING); R2-WP-01's passkey logic is untouched.
  - **Tests:** `errors.test.ts` +6 (SLOW_DOWN by event incl. `seal:set`/`trip:join` → server message; TABLE_OPENING copy + hail code; CAPTURING says settling; `ownsError` for the hail dock — `SLOW_DOWN trip:join` not claimed, the acceptance case — and for Seal/Voided). No DOM test harness in apps/web, so L1-003/L1-006/L1-007 are covered by tsc/build only.
  - **Gates:** web `tsc --noEmit` clean, `vite build` ok, `vitest run` 14 files / 74 tests green. DryRun.tsx edited last, on top of R2-WP-03's in-progress `groupRange` changes (not touched). Server not touched.
  - **Deferred:** hiding the hail control during Watch 0 (optional; the dock now explains TABLE_OPENING inline) → R2-WP-16 if wanted. Manual phone check not run (no browser session).

## R2-WP-10

### Identity, seats & crew races

- **Status:** done
- **Wave:** 3  ·  **Depends on:** R2-WP-01, R2-WP-06
- **Why:** "Sail without them" racing an absent member's brief leaves a removed seat sealed with a live standing instruction. Any member's re-seal in VOIDED throws away the Two Charts and replays old turns. The organizer can still take an absent friend's seat, and the first passkey is trusted to whoever holds the token.
- **Scope (only touch these):** apps/server/src/trips/{crew,identity}.ts, apps/server/src/passkeys/**, apps/server/src/api/passkeyRoutes.ts, apps/server/src/api/routes.ts (absent / claim / join routes only), apps/server/src/trips/core.ts (crewPublic only), packages/shared/src/types.ts (CrewPublic), apps/web/src/phone/screens/Muster.tsx, apps/web/src/phone/seatClaims.ts, apps/web/src/net/passkey.ts (claim nonce only), apps/server/test/{identity,passkeys}.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **L4-003** | Medium | S | "Sail without them" during an absent member's in-flight `submitBrief` leaves the removed seat sealed with a live standing instruction |  | `trace-4-service.md` |
| [x] | **S2-009** | Low | M | Passkey registration is trust-on-first-use by whoever holds the member token; a leaked token can permanently block that member's seal |  | `security.md` |
| [x] | **S2-012** | Low | M | The organizer can still take an absent friend's seat (the invite key is theirs; the crew-key check is advisory) |  | `security.md` |
| [x] | **L1-009** | Low | S | Muster keeps offering an absent friend's link after they have opened it |  | `trace-1-phone.md` |
| [x] | **L4-002** | Low | S | Any crew member's re-seal in VOIDED throws away the Two Charts and the organizer's "back to the charts" |  | `trace-4-service.md` |
| [x] | **L3-006** | Low | S | After "Adjust my terms" (VOIDED → BRIEFING), a rejoin in BRIEFING replays the previous meeting's turns and audio |  | `trace-3-transport.md` |

**Notes:**
- **L4-002** is a product decision (doc 04 §5 allows it today). Pick (a) or (b) and have R2-WP-18 record it in doc 04 §5.
- Also here: L4-001's optional refusal of VOIDED→BRIEFING while a refund is owed (crew.ts).
- **S2-012** — the full fix needs out-of-band delivery (email/SMS, or a key generated on the friend's device). The minimum is a visible "X opened their invite" plus re-key, which needs L1-009's `inviteOpen` flag anyway.
- **S2-009** builds on R2-WP-01's explicit "Add a passkey" action: bind registration to a nonce minted at join/claim, and add an organizer reset.

**Done (fixer R2-WP-10, 2026-09-25):**
- **L4-003** — `crew.ts submitBrief` (~:232): after `await createStanding` the seat is re-checked (`holdsSeat`); a seat released meanwhile drops the new instruction and throws `NOT_MEMBER` (no brief, no `briefSealed`, no `m.standing`).
- **L4-002 — decision (b):** only the organizer's re-seal moves VOIDED → BRIEFING (`assertCanReopen`, crew.ts ~:274). Anyone else's re-seal in VOIDED is `BAD_PHASE` ("The organizer chooses what's next…"); the voyage, the Two Charts, their brief and an absent friend's standing instruction stay as they were, so "back to the charts" and "new table" both remain. docs/04 §5 state-machine line updated here; R2-WP-18 may reword. **UI follow-up (Voided.tsx, not in scope):** "Adjust my terms" is still shown to every member in VOIDED; show it to the organizer only (members get the server's BAD_PHASE message today).
- **L4-001 optional refusal** — not added: refusing new terms while a refund is owed contradicts R2-WP-02's pinned test (seal-integrity "VOIDED → new terms → new table / pick are refused…" expects the re-seal to succeed) and adds nothing (`transition()` refuses → AT_TABLE / SEALING and `pick` refuses). Comment at `assertCanReopen`.
- **L3-006** — the organizer's VOIDED → BRIEFING re-seal also starts a new negotiation round (empty turns, round + 1), like `resetTable`, so a rejoin replays no old turn/audio. *Not covered:* `sealing.ts retry()`'s "charts missing" VOIDED → BRIEFING path (not in scope) still keeps the old turns; one line there for R2-WP-13 (or move the reset into a shared helper).
- **L1-009** — `CrewPublic.inviteOpen?` (types.ts:52; set by `core.ts crewPublic` :230 for absent seats and reset seats). The absent seat gets its invite hash in `addMember` *before* the first broadcast (never shown as "opened" by mistake); `claimAbsent` now broadcasts `trip:state`. Muster (`seatLists` / `inviteView` in `phone/seatClaims.ts`) shows "X has opened their invite" and no link / no "make a new link" once opened.
- **S2-012 — the minimum from the Notes.** Everyone gets `inviteOpen` in `trip:state` (visible claim), and the organizer can reset the seat (`crew.ts resetSeat` :166, `POST /trips/:id/members/:memberId/reset` in routes.ts, Muster "Wasn't X?" → reset → new link). **Deferred:** the full fix (a claim secret the organizer can't read: email/SMS delivery, or a key made on the friend's phone) needs an out-of-band channel that doesn't exist; the acceptance "a claim without the out-of-band secret is refused, even with the organizer's invite key" is therefore **not** met. Also deferred: showing "opened" to *members* (CrewList in `phone/components/crew.tsx`, not in scope; the flag is already in their `trip:state`).
- **S2-009** — registration is bound to a **passkey claim**: create / join / absent-claim / demo-handoff routes set an HttpOnly, SameSite=Strict cookie `aa_pk_<memberId>` scoped to `/api/trips/<id>/passkey` (Secure over HTTPS) holding a 256-bit nonce (`passkeyRoutes.ts issuePasskeyClaim` :48; `passkeys.ts mintPasskeyClaim` :138, stored hashed in the `passkeys` collection as `claim:<memberId>`, reloaded on restore, re-persisted on reconnect). `registrationBlock` → `409 PASSKEY_UNBOUND` without it; the status GET adds `canRegister`. A cookie (not a client-held nonce) because `api.ts`/`session.ts` are out of scope and HttpOnly keeps it out of page JS; `net/passkey.ts` only reads `canRegister` (no "Add a passkey" / no "add here" without the claim) and maps `PASSKEY_UNBOUND`. Recovery: the organizer seat reset (above) revokes the member's token, sockets, passkeys (tombstoned, so a restart doesn't revive them), claim, challenge and assertion tokens, and mints a fresh link that any non-organizer seat can claim (claim/reissue accept a reset `member` seat). Only in BRIEFING/VOIDED, never the organizer's own seat. Members who joined before this change have no claim: they seal with the tap and can't add a passkey until re-claimed.
- **Tests:** new `apps/server/test/seats.test.ts` (6: L4-003 interleaving; L4-002 member/absent re-seal refused + retry works; L3-006 organizer re-seal → new round, replay has no `turn:new`; L1-009 flag from the first broadcast → opened + INVITE_CLAIMED; reset revokes token/sockets/claim/assertions, old link dead, new link claims, member seats too; reset refused AT_TABLE/DRY_RUN). `passkeys.test.ts`: helper sends a claim cookie; status assertions `toMatchObject` (new `canRegister`); +1 HTTP test (create/join cookies HttpOnly/Strict/path; token-only and wrong-seat cookie → PASSKEY_UNBOUND; a passkey added first by someone else → organizer reset → tombstoned, old token 403 → rightful claim → register → PASSKEY_REQUIRED without / seal with Maya's passkey; the revoked one fails). Web: `net/passkey.test.ts` +2 (canRegister false → not offered, PASSKEY_UNBOUND copy, no addHere); new `phone/seatClaims.test.ts` (2: opened → no link; row lists).
- **Out-of-scope touches (flag for review):** `apps/server/test/e2e.test.ts` — the "second passkey" REST guard sends Maya's claim cookie (3 lines + import), needed for the gate. New test files `apps/server/test/seats.test.ts` and `apps/web/src/phone/seatClaims.test.ts` (kept out of identity.test.ts, which R2-WP-07 edits concurrently).
- **Gates:** server `tsc` clean, vitest 393/393 (32 files) incl. e2e zero private events, negotiation and pricing (Expo shares unchanged). Web `tsc` clean, `vite build` ok, vitest 93/93.
- **Deferred / for others:** Voided.tsx organizer-only "Adjust my terms" (L4-002 UI); `sealing.ts retry()` charts-missing path new round (L3-006); CrewList "opened" for members (S2-012); out-of-band invite delivery (S2-012 full); resetting the *organizer's* own seat (a leaked organizer token) has no recovery; `api.resetSeat` could move into `net/api.ts` (seatClaims.ts has its own small fetch). `HTTP_STATUS` in routes.ts doesn't list `PASSKEY_UNBOUND` (thrown with 409 already).

## R2-WP-11

### Resource bounds & eviction

- **Status:** done
- **Wave:** 3  ·  **Depends on:** R2-WP-02, R2-WP-06, R2-WP-10
- **Why:** Settled bookings (and the SIM and passkey maps) are never evicted, and every booking is re-persisted on reconnect. Nothing caps live voyages. Old rounds and abandoned voyages grow forever, and an interrupted table uses up a table run.
- **Scope (only touch these):** apps/server/src/trips/core.ts (sweep / evictTrip only), apps/server/src/trips/{records,dryrun,identity}.ts (bounds and timers only), apps/server/src/trips/table.ts (startTable / resetTable only), apps/server/src/trips/persistence.ts (syncAfterReconnect, restore query), apps/server/src/payments/{orchestrator.ts (forget only),sim.ts}, apps/server/src/passkeys/passkeys.ts (evict / load per member), apps/server/src/store/db.ts (turn cleanup), apps/server/src/api/routes.ts (create cap only), apps/server/src/config.ts, apps/server/src/web.ts (CSP memo), apps/server/test/limits.test.ts + new tests

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **O2-035** | High | S | Settled bookings (and SIM / passkey maps) are never evicted, and every booking is re-persisted on reconnect | L4-010, S2-011 | `optimization.md` |
| [x] | **S2-006** | Medium | M | No global cap on voyages or seats: a handful of IPv6 /64s can exhaust memory (and Atlas) |  | `security.md` |
| [x] | **L5-008** | Low | M | Unbounded growth remains: old table rounds, abandoned live voyages, and wholesale loads of passkeys and memories |  | `trace-5-persistence.md` |
| [x] | **O2-042** | Low | S | Other unbounded maps and non-unref'd timers |  | `optimization.md` |
| [x] | **L4-009** | Low | S | An interrupted table (restart or engine failure) uses up one of the voyage's 6 table runs |  | `trace-4-service.md` |

**Notes:**
- **O2-035 / L4-010 / S2-011** — one `payments.forget(tripId)` called from `evictTrip` for final bookings (keep `needsAttention` ones), plus passkey eviction and a bounded SIM. The O2-035 acceptance test must fail before the fix.
- **O2-042** shares the SIM-map part with S2-011; do both in one change.

**Done (fixer R2-WP-11, 2026-09-25):**
- **O2-035 / L4-010 / S2-011** — `payments.forget(tripId)` (orchestrator.ts:180) drops the voyage's *final* bookings with their deadline timers and the provider's records; it keeps any booking that isn't final, is held/settling, `needsAttention`, or `unsettled` (R2-WP-02's `holdsOutstanding` / `owesRefund`), and returns the ids kept. `evictTrip` (core.ts:288) drops standing instructions first, then `forget`, then `evictPasskeys(memberIds)` (credentials, claim, challenge, assertion tokens; no writes, no tombstones). `sweep` (core.ts:265) also forgets settled bookings whose voyage isn't in memory (boot orphans, a voyage evicted while one was still owed). SIM: `instructions` / `auths` / `results` are `Lru(SIM_MAX_RECORDS = 50 000)` + `forget({idempotencyPrefix, authRefs, instructionRefs})` (sim.ts:16, :103), called duck-typed (`ForgetfulProvider`, orchestrator.ts:554) so provider.ts is unchanged. `syncAfterReconnect` (persistence.ts:135) writes only the trips / members / briefs / bookings that were in memory *before* the merge (the reconnect only runs after a failed boot connect, when every write was dropped); what the merge read isn't written back.
- **S2-006** — `POST /trips` (routes.ts:83): per-IPv6-/48 bucket (`CREATE_RATE_48`, default 30/min; `prefix48` routes.ts:36), whole-server bucket (`CREATE_RATE_GLOBAL`, 60/min) next to the per-/64 10/min, and `MAX_LIVE_VOYAGES` (2000; `0` = off): at the cap the sweep runs once, still full → `503 HELM_FULL`. Sweep: a lone BRIEFING voyage (≤ 1 seat, nothing sealed) goes after `VOYAGE_LONE_HOURS` (1 h; the hourly sweeper means 1–2 h). Seats per voyage were already capped, so the voyage cap bounds seats. *Not done:* "keep the creator's IP out of storage" — it isn't stored today (checked).
- **L5-008** — turns: `deleteOldTurns(tripId, round)` (db.ts:247; `deleteMany round < current`, fenced like `append`) from `startTable` and `resetTable` (table.ts:121, :141). Stale voyages: the sweep evicts DRY_RUN idle > `VOYAGE_STALE_DAYS` (30 d); the restore query (persistence.ts:108) loads AT_TABLE/SEALING always, BRIEFING/DRY_RUN only if touched within `VOYAGE_STALE_DAYS`, plus anything within `RESTORE_RECENT_DAYS`; an older one opens by code (`hydrate`). Passkeys: `loadPasskeysFor(memberIds)` (passkeys.ts:126) in `loadVoyages` for the members it restores (before any voyage is visible), and for the members already in memory on a reconnect merge (L5-003 kept); `loadPasskeys()` (whole collection) is no longer called. Because memory no longer holds every credential, `verifyRegistration` also asks the store whether the credential id exists (tombstones count) before binding it (passkeys.ts:244). Events: fetched per voyage (`eventsPerVoyage`, 16 at a time, `DEBUG_ROWS_PER_TRIP` each). The auto-pick timer won't pick a voyage the sweep evicted.
- **O2-042** — SIM maps bounded (above); auto-pick timer `unref()` (dryrun.ts:39); demo handoffs pruned on redeem too (identity.ts:31); CSP memoized per (production, publicBaseUrl, Host) in a 64-entry LRU (web.ts:36).
- **L4-009** — `resetTable` with `REASON_TABLE_RESTART` gives the table run back (table.ts:118); `REASON_TABLE_FAILED` still counts.
- **New env vars:** `VOYAGE_LONE_HOURS=1`, `VOYAGE_STALE_DAYS=30`, `MAX_LIVE_VOYAGES=2000`, `CREATE_RATE_GLOBAL=60`, `CREATE_RATE_48=30` (config.ts; docs/04 §12 env block + "Ceilings" paragraph, .env.example, DEPLOY.md limits table).
- **Tests:** new `apps/server/test/bounds.test.ts` (12): BOOKED voyage swept → `payments.bookings.size === 0`, no SIM record, no passkey claim, `hydrate` restores booking + claim (verified failing with `forget` stubbed out); eviction keeps a `needsAttention` refund and an outstanding hold, lets them go once settled; a booking still gathering is kept; N=6 booked voyages swept → every map (trips, members, briefs, bookings, standing, SIM ×3, passkeys ×4) empty; lone voyage swept, crewed/fresh kept; stale DRY_RUN swept, not loaded at boot, opens by code; two interrupted tables → only current round's turns stored; L4-009 restart vs engine failure; reconnect sync doesn't write merged docs back; handoff prune; SIM bound; `prefix48`. `limits.test.ts` +2: `MAX_LIVE_VOYAGES=100` with 50 distinct /64s → exactly 100 × 200 then 503 `HELM_FULL`, and a lone idle voyage is swept to make room; global and per-/48 create rates.
- **Out-of-scope touches (flag for review):** `test/support/fakeDb.ts` (+`deleteOldTurns`, additive); `test/passkeys.test.ts` db mock now applies the `loadWhere` filter and has `deleteOldTurns` (the old mock returned every doc for any filter, which the credential-id check needs to be real); `core.ts` gained one import (`evictPasskeys`) outside sweep/evictTrip.
- **Gates:** server `tsc` clean, vitest 407/407 (33 files) incl. e2e zero private events, negotiation and pricing (Expo shares unchanged); doc 06 payments / seal-integrity suites unchanged and green. Web `tsc`: errors only in `src/scene|xr|gallery` (`tweens` / `Tweens` etc.), R2-WP-15's in-progress work; this WP touched no web file.
- **Deferred / for others:** memory entries (memory.ts) still load wholesale on first use (out of scope) → R2-WP-13 or later. The sweeper interval (index.ts, hourly) is out of scope, so "lone after 1 h" is 1–2 h. In memory-only mode (no MongoDB) an evicted lone/stale voyage is gone, not archived (documented in DEPLOY.md). A stray queued write of an old-round turn can land after the delete; the next round removes it. The Visa provider (visaVic.ts) has no `forget` (nothing to forget until it is wired).

## R2-WP-12

### Rate limits, budgets & hail-audio

- **Status:** done
- **Wave:** 3  ·  **Depends on:** R2-WP-11
- **Why:** Unauthenticated trip ids hit MongoDB before any limiter. One global bucket lets a few addresses block every headset pairing. Paid-API budgets are global and reset on restart. An empty hail-audio upload reaches speech-to-text, and voice notes are cut at 160 characters.
- **Scope (only touch these):** apps/server/src/util/limits.ts, apps/server/src/api/routes.ts (non-passkey), apps/server/src/trips/records.ts (hydrate miss cache), apps/server/src/store/db.ts (spend doc only), apps/server/src/config.ts, apps/web/src/net/api.ts (hailAudio kind only), apps/web/src/phone/components/{VoiceNote.tsx,useRecorder.ts}, apps/server/test/limits.test.ts

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **S2-007** | Low | S | Unauthenticated MongoDB lookups on every `/api/trips/:tripId/*` request, before any limiter |  | `security.md` |
| [x] | **S2-008** | Low | S | One global bucket of wrong pairing codes lets a few addresses block all headset pairing |  | `security.md` |
| [x] | **S2-014** | Low | S | Paid-API budgets are global: one abuser can switch voices and models off for everyone; per-voyage counters are LRU-evictable |  | `security.md` |
| [x] | **L5-011** | Low | S | Paid-call spend caps reset on every restart |  | `trace-5-persistence.md` |
| [x] | **L1-010** | Low | S | (layer-3 note) An empty hail-audio upload passes the gate and reaches speech-to-text |  | `trace-1-phone.md` |
| [x] | **L1-005** | Low | S | Voice notes are cut to 160 characters (the hail limit), but the note allows 200 |  | `trace-1-phone.md` |

**Notes:**
- **S2-014 / L5-011** both move per-voyage counters onto the trip record; do them together. Tests must stub every paid call.

**Done (fixer R2-WP-12, 2026-09-25):**
- **S2-007** — `/trips/:tripId` middleware (routes.ts:131): a voyage in memory goes straight through; otherwise a per-address `tripMiss` limiter (`TRIP_MISS_RATE`, 20/min, only misses count) refuses with `429 SLOW_DOWN` *before* `hydrate`. The hydrate miss cache is an `Lru(HYDRATE_MISS_MAX)` instead of clear-on-overflow (persistence.ts:38; `recentMiss` uses `peek`).
- **S2-008** — the global `pairFailAll` (300/min, key `"*"`) is gone; wrong codes count per address (10/min) and per IPv6 /48 (`PAIR_FAIL_RATE_48`, 30/min, via R2-WP-11's `prefix48`) (routes.ts:61, :198).
- **S2-014** — `SPEND_RESERVE_PCT` (20 %) of each daily cap is only for voyages past the table (DRY_RUN / SEALING / BOOKED); everyone else, and calls outside a voyage, stop at cap − reserve (limits.ts:197, :220). The predicate is registered by `apiRouter` (`setSpendPriority`, routes.ts:42-48). `/api/health` `budgets` gains `"reserve"`. Per-voyage counters are no longer lost to the LRU: they are stored (below) and re-read when a voyage's ledger comes back.
- **L5-011** — counters are persisted in a new `spend` collection (db.ts:46 `SpendDoc`; `day:<utcDay>` and `trip:<tripId>`; whole-doc replace through the write queue, so coalesced and lease-fenced; TTL index 90 d on `updatedAt`). A ledger is read once (today's at router creation = boot, a voyage's on its first paid call), added to what was counted meanwhile, and only then written (limits.ts:152). The hail-audio gate awaits `loadSpend(tripId)` (≤ 2 s) before `spend("stt")`. *Deviation:* per-voyage counters live in `spend` docs, not on the trip record (records/core.ts weren't in scope; same effect).
- **L1-010** — `Content-Length: 0` → `422 BAD_INPUT` in `hailAudioGate` before the rate limits and `spend` (routes.ts:219).
- **L1-005** — `POST …/hail-audio?kind=note` slices to `NOTE_MAX_CHARS` (routes.ts:237); `api.hailAudio(…, kind)` (api.ts), `transcribe(…, kind)` (useRecorder.ts), `VoiceNote` sends `"note"`.
- **New env vars:** `SPEND_RESERVE_PCT=20`, `TRIP_MISS_RATE=20`, `PAIR_FAIL_RATE_48=30` (config.ts; docs/04 §12 limits table + "Stored budgets and the reserve" + env block + §4 `spend` collection + REST row; .env.example; DEPLOY.md limits table).
- **Tests:** `limits.test.ts` +4 (empty clip 422 with no STT call and the budget intact; note keeps 200 / hail 160; 300 wrong codes from 30 /64s then a fresh address pairs, and a /48 bucket; 10 abusive voyages get 8 of 10 Gemini calls, a fresh voyage and a scope-less call are refused, a DRY_RUN voyage gets the 2 reserved). New `test/spend.test.ts` (fake db, 6): daily cap survives a restart; a voyage cap survives a restart / LRU loss; pre-read counts are added not lost; memory-only mode stores nothing; 200 random trip ids from one address → ≤ 20 `trips` lookups then all 429 `SLOW_DOWN`, an in-memory voyage still answers; miss cache LRU (1,500 ids, the last 1,000 stay cached). `apps/web/src/net/api.test.ts` +1 (`?kind=note` only for notes).
- **Out-of-scope touches (flag for review):** `apps/server/src/trips/persistence.ts` (the miss cache lives there, not in records.ts: the `Lru` field + import, 4 lines); records.ts only got the comment. `apps/web/src/net/api.test.ts` (+1 test). New test file `apps/server/test/spend.test.ts`.
- **Gates:** server `tsc` clean, vitest 417/417 (34 files) incl. e2e zero-private, negotiation, pricing. Web `tsc` clean, `vite build` OK, vitest 94/94 (R2-WP-15's scene work compiled at the time).
- **Deferred / notes:** after a restart, paid calls outside the hail gate can slip a few through while the stored counters are read (bounded; documented). The reserve's "past the table" test is a heuristic: a determined abuser can walk template-only meetings to DRY_RUN; a per-address `table:start` quota (io.ts) was not done. Spend docs for evicted voyages stay until the 90-day TTL. `setSpendPriority` is one global (the last `apiRouter` built wins; one per process in production).

## R2-WP-13

### Server refactor & cleanup (no behaviour change)

- **Status:** done
- **Wave:** 4  ·  **Depends on:** R2-WP-02, R2-WP-04, R2-WP-06, R2-WP-08, R2-WP-10, R2-WP-11, R2-WP-12
- **Why:** The refactors left a 35-method facade, re-exports and duplicate guards behind. Timeout wrappers are copied five times (the Gemini one never clears its timer). Strings that must match are copied, HTTP status has two sources of truth, and limits live in seven places.
- **Scope (only touch these):** apps/server/src/**, apps/server/test/**, packages/shared/src/constants.ts (additive)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **O2-001** | Medium | M | TripService facade and re-exports are compatibility shims from the refactor |  | `optimization.md` |
| [x] | **O2-010** | Medium | S | The organizer/member phase guard is written 16 times across trips modules |  | `optimization.md` |
| [x] | **O2-011** | Medium | S | Timeout wrapper written 5 times; the Gemini one never clears its timer |  | `optimization.md` |
| [x] | **O2-012** | Medium | S | Strings that must match are copied instead of imported |  | `optimization.md` |
| [x] | **O2-020** | Medium | M | `apiRouter` (206 lines) and `attachRealtime` (143 lines, with a 101-line connection callback) |  | `optimization.md` |
| [x] | **O2-025** | Medium | S | Two sources of truth for HTTP status |  | `optimization.md` |
| [x] | **O2-004** | Low | S | Unused server exports and test-only production surface |  | `optimization.md` |
| [x] | **O2-005** | Low | S | `apiNotFound` is unreachable in production |  | `optimization.md` |
| [x] | **O2-006** | Low | M | Legacy read paths from older document shapes |  | `optimization.md` |
| [x] | **O2-007** | Low | S | Server write-only fields, unused parameters and dead branches |  | `optimization.md` |
| [x] | **O2-013** | Low | S | State-reset and turn-append snippets are copy-pasted in trips modules |  | `optimization.md` |
| [x] | **O2-014** | Low | S | Small helpers duplicated in the API and realtime layers |  | `optimization.md` |
| [x] | **O2-019** | Low | S | Server duplication left over from the negotiation and passkey splits |  | `optimization.md` |
| [x] | **O2-022** | Low | S | Long server functions: `startTable` (83 lines) and `decideResponse` (61 lines) |  | `optimization.md` |
| [x] | **O2-024** | Low | S | Over-thin wrappers and modules |  | `optimization.md` |
| [x] | **O2-027** | Low | M | Trips modules reach shared state two ways; the join/pair-code index is maintained three ways |  | `optimization.md` |
| [x] | **O2-028** | Low | S | Server naming and style drift |  | `optimization.md` |
| [x] | **O2-032** | Low | M | Server limits are scattered across seven places |  | `optimization.md` |
| [x] | **O2-033** | Low | M | Negotiation, memory, simulator and dataset literals in code |  | `optimization.md` |

**Notes:**
- The web bullets of **O2-001** and **O2-024** (XRApp `HAIL_PRESETS` / `openHailCard`, seats.ts `seatAngle`, SceneDirector `DirectorOptions` and forwarders, SealCeremony pass-throughs) are done in R2-WP-15.
- **O2-011** is a real bug, not just duplication: the Gemini race leaves a 6 s timer that keeps a shutting-down process alive.
- **O2-012** — the band-word regex is privacy-relevant; add the band-scrub test.

**Done (fixer R2-WP-13, 2026-09-25):**
- **O2-001 / O2-027** — TripService stays the one public surface of `trips/` (documented in service.ts): the API, sockets and tests call it. Test-only forwarders (`pricingCrew`, `chartBook`, `shortlist`, `datesLabel`, `replay`) and the re-exports (`HelmError`, `datasetHash`, `validateBrief`, record types) are gone; tests use `helm.table.*` / `helm.replayer.replay` and import from `util/errors`, `trips/records`, `trips/crew`. New facade methods only for what the API used behind its back (`resetSeat`, `replayNow`, `currentBooking`); every forwarder returns its result. The modules take `Helm` (core.ts: `HelmCore` + sibling modules), never `./service`; `trip`/`tripByCode`/`broadcastState` are abstract on the core. Index upkeep only via `addTrip` / `removeTrip` / `setJoinCode` / `setHeadset` / `findByPairHash` (the size-change rebuild is gone; restore uses `addTrip`, unpair drops its pending code at once). `buildPrivacyContext` re-export dropped from engine.ts.
- **O2-010** — `organizerTrip(tripId, actor, {phoneOnly?, phases?, phaseMessage?})` and `memberTrip(tripId, memberId, phases?, msg?)` on the core, same check order as before; `requireOrganizer` is private (0 uses outside core.ts).
- **O2-011** — `util/timeout.ts` `withTimeout` (race, timer cleared + unref'd) and `withAbort` (AbortController, timer cleared); used by gemini (the 6 s leak), orchestrator ×2, voice TTS/STT (same coverage as before: TTS headers only, STT incl. body), Backboard, and the hail-audio spend wait.
- **O2-012** — `REASONS.declined = VOID_HEADLINE`; `memory/bands.ts` `BUDGET_BANDS`/`budgetBand`, and the guard's scrub regex is built from it (same source string); `DECIDE_RIBBON` in phrasing.ts. Tests: band scrub for every band, declined === VOID_HEADLINE.
- **O2-020** — routes.ts: `apiRouter` composes `mountTripRoutes` / `mountCrewRoutes` / `mountHeadsetRoutes` / `mountHailAudio` / passkeys / `mountMiscRoutes` / debug + `errorToJson` (same mount order). io.ts: a `HANDLERS` table, `join()` and `onConnection()`. Longest function now 62 lines.
- **O2-025** — `util/errors.ts` `HTTP_STATUS` (every thrown code); `HelmError` takes its status from it (explicit only for NO_STT 501); the router serves `err.status`. All served statuses unchanged (TABLE_OPENING, socket-only and never observable, is 409 now like CAPTAINS_CALLING). New `test/errors.test.ts` greps src for every thrown code.
- **O2-004** — `WriteQueue.setWriter`, `Concurrency.count` deleted; `normalizeIp`, 10 pricing step functions, `TableState`, `DatasetIndex`, `SealRec`, `PaymentEvents`, `PasskeyDoc`, `GenLine` un-exported. Kept: `Lru.peek/has/entries` (now used), `retryAfterMs` and `Reconnector.running` (tested), `chooseFlight`/`choosePicks` (plan-privacy test).
- **O2-005** — `apiNotFound` and both mounts removed; hardening test mounts `apiRouter` alone (JSON 404 still asserted).
- **O2-006** — `LegacyEventDoc` and the `event`/`summary` fallbacks removed (events have a 30-day TTL). The trip-shape upgrades stay in `normalizeTrip`, marked LEGACY with a review date: a one-time migration writes to MongoDB, so it is a deploy step, not done here.
- **O2-007** — removed: `mintHandoff` ttl param (bounds test uses fake timers now), `TripRec.presetId`, `MemberRec.joinedAt`, debug.ts re-fetch + dead fallbacks, `BAD_JSON`/`BAD_REQUEST` map entries, gemini `timeoutMs`, passkeys `originOf` string overload, core's no-op `publicSealStatus`, `SealRec.setAt` (passkeys test now checks `instructionRef`), `EngineResult.endedReason` and `engine.advocateFacts` (tests use prompts' `advocateFacts`), `FilterResult.reasons`. `createTrip` no longer broadcasts to the empty room (one fewer debug/audit row, nobody could receive it).
- **O2-013** — `table.newRound`, `table.backToBriefing(t, from, reason, logReason?)`, `table.appendTurn`, `dryrun.startClock`; used by resetTable, startTable, hail, the engine hook, submitBrief, retry, persistence repair/checkCharts. (Turn JSON key order changed slightly; no consumer depends on it.)
- **O2-014** — one home each: `esc`/`ipOf`/`bearerMember` (api/http.ts), `slow`/`INTERNAL_MESSAGE` (util/errors), `sameHex`/`sameHash`/`safeEqual` (util/ids), `MINUTE_MS`/`anyBlocked`/`countFailures` (util/limits), `tripRoom`/`memberRoom`/`memberOfRoom` (trips/records), debug uses `helm.currentBooking`.
- **O2-019** — system prompts + `LineRequest` live in prompts.ts (gemini.ts is transport only; prompts no longer imports it); passkeys uses config's `originOf`, its resolver is `relyingParty()`; filter `isNumWord` reused, guard `moneyAmount` named.
- **O2-022** — `startTable` → `engineHooks` / `onDecided` / `onFailed`; `decideResponse` → `followHail`, `objectToRival`, `answerObjection`, `majority`, `nearlyAsGood` (b-prompts + negotiation snapshots unchanged).
- **O2-024** — `util/settings.ts` folded into `config.helm.*` / `config.payments.visa()` (lazy); `Replayer.broadcastState`, table's `must` (and `util/errors.must`), engine `plan()` inlined; `h` → `helm` / `asyncRoute` / `handoff`.
- **O2-028** — naming as above; persistence module is `archive`; db.ts/debug.ts import record types from `trips/records`; phase sets `OPEN_PHASES`, `VOICE_PHASES`, `SPEND_PRIORITY_PHASES`.
- **O2-032** — `LIMITS` in util/limits.ts (REST, socket, field caps, dev, sweep, limiter keys); `NAME_MAX_CHARS`, `TRIP_NAME_MAX_CHARS`, `HAIL_MAX_CHARS`, `MIN_TABLE_CREW`, `JOIN_CODE_LEN` appended to packages/shared constants.ts (server imports them; web can adopt in R2-WP-16). Store internals (write queue, reconnect, db) got named constants in their own files (util/limits imports store/db, so LIMITS can't be read there at load). limits.test uses `LIMITS`.
- **O2-033** — named: engine `MAX_WORDS*`/`PACE`, rules `SWITCH_MAX_DROP`/`NEARLY_AS_GOOD`, prompts `MODEL_OPTIONS`, gemini `MAX_OUTPUT_TOKENS`/`MODEL_TIMEOUT_MS`, context `HEADROOM_SECRET_MIN_CENTS`, guard `NOTE_MAX_CHARS`/`NAME_MAX_CHARS`, memory `RECALL_LINES`/`BB_PAGE`/`BB_TIMEOUT_MS`/`BB_DOWN_MS`, sim `SIM_REF_CHARS`/`SIM_LATENCY_MS`, pricing `hotelSlug`; `DEALBREAKER_PHRASE` and `Decision.reason` typed on `FitReason`. **Not done:** `HILLY` / `COMMON_FIRST` into dataset.json (changes the dataset hash → TR5-022 drift warnings on every stored voyage; do it with the next dataset change); prompt key `watch_of_3` (it is prompt text; renaming changes the snapshots).
- **Follow-ups:** `MemberRec.standing` is `StoredStanding = Omit<StandingInstruction,"limitCents">` (no cast in `storedStanding`). `sealing.retry()` charts-missing path starts a new round (L3-006 remainder; new test in seal-integrity). Sweep every 15 min (`LIMITS.sweepIntervalMs`), audio prune stays hourly (index.ts). **Deferred:** per-address `table:start` quota (a venue NAT shares one address across many Expo crews; not clearly safe), memory.ts wholesale load (not a no-behaviour-change refactor), `C2SPayload` in packages/shared/events.ts (out of scope: only constants.ts is).
- **Line counts (shrunk):** gemini.ts 72→55, filter.ts 277→269, identity.ts 87→80, util/text.ts 24→17, service.ts 106→102, sealing.ts 202→197, crew.ts 325→322, devAccess.ts 113→110, passkeyRoutes.ts 118→115, replay.ts 128→126, web.ts 130→126, orchestrator.ts 574→572, passkeys.ts 295→292, voice.ts 179→178, util/settings.ts 27→0. Grew (named helpers/limits/docs): core.ts 302→352, util/limits.ts 257→320, io.ts 232→263, table.ts 268→296, routes.ts 311→321; server src total 7833→8124.
- **Gates (run twice):** server `tsc` clean, vitest 425/425 (35 files; +8: errors.test.ts, retry new-round) incl. e2e zero-private, negotiation, pricing (Expo shares unchanged), prompt/chartbook snapshots unchanged. Web `tsc` clean, vitest 105/105.

## R2-WP-14

### Server write volume & performance

- **Status:** done
- **Wave:** 4  ·  **Depends on:** R2-WP-13
- **Why:** Each save rewrites the ~12 kB trip document (93 % static shortlist). Every emit is its own insert, and a 4-seal booking is 16 persists. Boot loads more history than it uses. Memory writes are sequential whole-file rewrites. Date formatting is 62 % of the chart book's time.
- **Scope (only touch these):** apps/server/src/{trips,store,payments,memory,privacy,fit,realtime,voice}/**, apps/server/src/util/jsonStore.ts, packages/shared/src (format.ts, TripState static fields), apps/web/src/net/tripStore.ts (keep static fields, O2-040 only), apps/server/test/**

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **O2-036** | Medium | M | Each save rewrites the whole ~12 kB trip document, 93% of it the static shortlist |  | `optimization.md` |
| [x] | **O2-037** | Medium | S | One Mongo `insertOne` per emit, including private member emits |  | `optimization.md` |
| [x] | **O2-038** | Medium | M | Booking write amplification, and `bookingDoc` has a side effect |  | `optimization.md` |
| [x] | **O2-040** | Low | S | `trip:state` resends static data on every broadcast |  | `optimization.md` |
| [x] | **O2-039** | Low | S | Boot loads more history than it uses, and strips nulls twice |  | `optimization.md` |
| [x] | **O2-041** | Low | S | Memory writes: sequential whole-file rewrites, full re-serialize on Mongo, unbounded recall cache |  | `optimization.md` |
| [x] | **O2-043** | Low | S | The chart book spends 62% of its time formatting dates |  | `optimization.md` |
| [x] | **O2-044** | Low | S | The privacy filter compiles regexes per line and re-scans the same text |  | `optimization.md` |
| [x] | **O2-045** | Low | S | `evict` scans every socket; the voice cache reads whole mp3s for a duration |  | `optimization.md` |
| [x] | **O2-066** | Low | S | Nothing guards write volume or payload size |  | `optimization.md` |

**Notes:**
- Land **O2-066** (the write-count and payload-size guard) first, so the other items have a baseline.
- **Done (R2-WP-14).** Measured per Expo-style voyage (4 crew, create → table → 4 votes → pick → 4 seals → BOOKED) with a
  counting fake DB behind the real write queue (scratchpad `r2-wp14/harness.mts`), before → after:
  trip doc 11,945 B → 827 B; trip bytes written 62.4 kB → 6.9 kB (+ one 11.3 kB `shortlists` write per decision);
  booking persists 22 → 9 (writes 13 → 9, 18.7 kB → 12.7 kB); event rows 62 in 62 inserts → 11 `insertMany`;
  `trip:state` total 11.4 kB → 7.6 kB (max 1,510 B → 1,164 B); `buildChartBook` 1.16 → 0.46 ms;
  `filterLine` with 12 names 12.5 → 6.1 µs, `sanitizeHail` 24 → 16 µs.
- **O2-066:** `test/write-volume.test.ts` (fake DB + real WriteQueue): trip doc ≤ 1.5 kB and no `shortlistPlans` after the
  table, one `shortlists` write, one trip write per tick of votes, booking persists ≤ 2n+3, every live `trip:state`
  ≤ 1.6 kB without the static fields while the replay carries them; EventBuffer batching. Checked that it fails with the
  shortlist put back in the trip doc, and with `announce` persisting unconditionally.
- **O2-036 (schema):** new `shortlists` collection `{_id: tripId, tripId, round, planIds, plans, datasetHash?, at}`, written
  once when the table decides (and by the reconnect sync); `tripDoc()` drops `shortlistPlans`. Restore attaches it only
  while `round`/`planIds` match the trip doc. LEGACY trip docs that embed `shortlistPlans` still load, and their plans
  are moved to `shortlists` on load. docs/04 §4.1/§4.7/§4.8/§4.10 updated.
- **O2-037:** `store/eventBuffer.ts`; `append` buffers, one unordered `insertMany` per 250 ms / 100 rows, drained by
  `closeDb`. Private emits keep their name-only row (the debug view lists them; no payload is stored) — not dropped.
- **O2-038:** `bookingDoc` is pure; `HelmCore.persistBooking` bumps the version only when it writes (`writesOn()`, new in
  db.ts: connected and holding the lease), and nothing is built without a DB (`save` likewise). The orchestrator
  coalesces one synchronous step's changes into one persist (microtask), stamps every authorization intent with the
  settle point in one write (still queued before any provider answer), doesn't write an authorization answer on its own
  (ALL_AUTHORIZED / ANY_DECLINED follows; a restart re-asks with the same key, doc 06 §4.2), and `announce` writes only
  when a public status changed. **Not reached: n+3.** For 4 seals it is 9 = create + 4 seal sets + ALL_AUTHORIZED +
  captures + CAPTURED + the publication at the settle point, i.e. n+5; for 3 seals (Expo) n+5 as well. The two above
  n+3 are doc 06 §4.2's `capturedAt` "as each capture succeeds" (coalesced only when captures land in the same step)
  and the `published` bookkeeping written at the settle point (docs/04 §4.7). Dropping either needs a spec change.
- **O2-039:** turns are loaded per voyage's current round (`{tripId, round}`; round-0 docs without `round` still match);
  fakeDb now strips nulls like the real loader and the second `stripNulls` pass in persistence.ts is gone. Debug events
  were already per voyage (R2-WP-11).
- **O2-040:** shared `TripStateUpdate` (= TripState with `candidateCities`/`dateWindows` optional) is the `trip:state`
  wire type; `broadcastState` sends `replayer.update(t)` (no static fields), the (re)join replay sends the full
  `state(t)`. tripStore `withStatic` keeps the fields (same arrays) for the same trip id. Added a case to
  `apps/web/src/net/tripStore.test.ts` (next to tripStore.ts). **For R2-WP-18:** docs/04 §7's `trip:state` row should
  say the live broadcasts omit `candidateCities`/`dateWindows` (only §4 was in this WP's doc scope).
- **O2-041:** `rememberAll` (one local store update for a booking's notes, Backboard posts in parallel); `mongoLocal.update`
  takes the keys it may change and compares/writes only those; `memory.json` written compact; `bbCache` is an `Lru`
  (2,000). seal-integrity asserts one store call per booking.
- **O2-043:** `packages/shared/src/format.ts` (`dayLabel`, `monthDayLabel`, cached `Intl.DateTimeFormat`), exported from
  the shared index; used by pricing `labelFor` and `table.datesLabel`. The chart-book snapshot is unchanged; b-helpers
  checks the labels match `toLocaleDateString` over a year.
- **O2-044:** name patterns compiled once per `PrivacyContext` (WeakMap, rebuilt if `names` changes; `lastIndex` reset);
  `FilterResult.amounts` + `amountsIn()` (normalised text) so `sanitizeSpoken`/`sanitizeHail` don't rescan.
- **O2-045:** `evict` walks the member's room (`adapter.rooms`), not every socket. Voice cache hits read the ID3 header +
  4 kB (`cachedDurationMs`), and durations are kept in an `Lru` by cache key; limits.test covers an ID3-tagged file.
- Gates (twice): server tsc + 430 tests, web tsc + vite build + 106 tests; negotiation/pricing shares and the e2e
  zero-private-events and contract tests green.

## R2-WP-15

### 3D leaks, performance & scene cleanup

- **Status:** done
- **Wave:** 4  ·  **Depends on:** R2-WP-03, R2-WP-07
- **Why:** Removed crew pieces, XR-only objects and voice mp3s outlive their scene. The module-global `tweens` keeps old scene graphs alive. Billboards and raycasts do avoidable work every frame, and plain cards cost ~15 MB of canvases. Dead members and duplicated builders remain.
- **Scope (only touch these):** apps/web/src/scene/**, apps/web/src/xr/**, apps/web/src/gallery/**, packages/shared/src/constants.ts (PALETTE, additive), new apps/web/src/phone/timing.ts (O2-034 only)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **O2-050** | Medium | S | Removed crew pieces are never disposed |  | `optimization.md` |
| [x] | **O2-051** | Medium | M | The module-global `tweens` outlives each Stage and holds old scene graphs |  | `optimization.md` |
| [x] | **O2-052** | Medium | S | Voice mp3s keep playing after the director is disposed |  | `optimization.md` |
| [x] | **O2-054** | Medium | S | Every billboard reads the camera's world position every frame |  | `optimization.md` |
| [x] | **O2-055** | Medium | M | Plain paper cards get large unique canvases (about 15 MB desktop, 5 MB Quest) |  | `optimization.md` |
| [x] | **O2-056** | Medium | M | Geometry and materials are rebuilt per instance; about 120–185 draw calls |  | `optimization.md` |
| [x] | **O2-057** | Medium | S | Raycasts every frame: a duplicated target, and tile grounding against the whole tileset |  | `optimization.md` |
| [x] | **O2-002** | Low | S | Round-1 OPT-004 was only partly applied; the scene/XR code has new unused members |  | `optimization.md` |
| [x] | **O2-018** | Low | M | Scene builders and the tween-from-to pattern are duplicated |  | `optimization.md` |
| [x] | **O2-023** | Low | M | Long scene functions |  | `optimization.md` |
| [x] | **O2-030** | Low | S | `SceneDirector` reaches into `PhaseController` internals |  | `optimization.md` |
| [x] | **O2-034** | Low | S | Web timings, colours and layout literals |  | `optimization.md` |
| [x] | **O2-053** | Low | S | XR-only objects, RoomEnvironment, globe pins, XRInput and store taps are never disposed | L2-007 | `optimization.md` |
| [x] | **O2-058** | Low | S | Small per-frame allocations and a double text layout |  | `optimization.md` |
| [x] | **O2-059** | Low | S | The headset preloads a font no 3D text uses |  | `optimization.md` |

**Notes:**
- Also does the web bullets of O2-001 and O2-024 (see R2-WP-13).
- Keep the round-1 invariants: interactables stay a stable cached array, `xr/input.test.ts` stays green, the scene reads only public state.
- **O2-050 / O2-051 / O2-052** are the leaks a long headset session feels; do them first.
- **Done (2026-09-25).** Landed in commit 1832272 (the coordinator committed it with R2-WP-12, gates green); `packages/shared` PALETTE additions are in the same commit. Details:
  - **O2-051** `tween.ts`: `Tweens` is a class; each `Stage` owns `stage.tweens`, passed to every piece (constructors take `tw`) and to the director parts via `DirectorContext.tweens`. `Stage.dispose` calls `tweens.clear()`: resolves every pending tween/wait without running their frames, resets reduce-motion `speed`, and turns later `to()` calls into resolved promises (late continuations of the old director hold nothing). Also `tw.prop(obj, key, to, ms)` (the "capture from, lerp" pattern).
  - **O2-050** `CrewPiece.dispose()` (remove + `disposeObject`, shared geometry/cached materials kept); `CrewSeating` calls it on roster removal and in its own `dispose` (called by `SceneDirector.dispose`).
  - **O2-052** `TurnPlayer` keeps the playing `VoiceHandle` and `stop()`s it on dispose; the audio-URL wait loop and the reading pause stop on dispose. `playVoiceAt().stop()` now also detaches the `PositionalAudio` and resolves `done` (three's `Audio.stop()` drops `onEnded`).
  - **O2-053 / L2-007** `XRApp.dispose` frees the hail card, menu card + wheel (`WristMenu.dispose`), debug card (`DebugOverlay.dispose`, which also drops its `store.tap`), placement reticle, `XRInput` (stored now; `dispose()` removes controller listeners, rays, dots) and the hand listeners. `Stage` disposes the `RoomEnvironment` right after the PMREM bake and frees the room props. `Globe.setPins` diffs (removed pins are freed, heads rebuilt); `setOrigins` runs once. GalleryApp's tap was already gone (R2-WP-07).
  - **O2-054** new `scene/billboard.ts`: `billboard(obj, camPos, parent?)` = `Object3D.lookAt` from last frame's parent matrix, no ancestor walk. `SceneDirector.update` reads the camera's world position once and passes it to the globe flags, Captain tag, crew flags and cloche labels.
  - **O2-055** plain cards (no `draw`) share one material: the 512² paper tile mapped in world units + a 256×16 deckle `alphaMap` on `uv1` (no per-card canvas). Seal chart is now a plain card + two ruled-ink meshes (children of the paper, so they stretch like the painted lines). Inked (keyed) cards are LRU-capped at 24. Street plates: GPU copy freed when a cloche is disposed (canvas stays cached); seed hashes the whole `cityId`. (The plain cards lost their faint 35 % brown inner border stroke; nothing else visible changed.)
  - **O2-056** shared geometries (crew collar/pin/strip/hourglass, globe ring/rivet/flag, cloche base/rim/plate/dome, seal halves/ring/slot/swatch/roll/twine, shadow decal = one unit plane scaled); merged meshes via new `mergedGeometry` (compass ring+hub, clock case+handle / top+feet, globe column+ring, cloche base+knob, Captain lower body+band+spyglass tube, wheel rim+hub and 8 spokes, hourglass); chart weights = 1 instanced brass mesh + 1 instanced shadow (was 12 meshes); crew band strip uses the cached `bandInk(hex, true)`; troika `BatchedText` for each cloche's tag lines and its place labels/margin notes (never frustum-culled: a batch packs in its own `onBeforeRender`). 
  - **O2-057** only `captain.group` is a target (tag no longer cast twice). `XRInput.update` raycasts every other frame unless a select is held. `CityTiles`: `load-model` only marks "ground pending"; the next frame casts once (coalesces bursts), scratch vectors/hit array reused; holder, ground fit and the render-time 4 s timeout unchanged (verified with Cesium tiles: MEX and LIS both ground; MEX y −0.1275 same as before).
  - **O2-058** `Tweens.update` removes finished tweens in place (no arrays per frame); beads re-placed in 0.1-minute steps with a `for` loop; caption colour set before `setText` (one layout); Gallery "speaker" camera uses scratch vectors.
  - **O2-059** `FONTS` drops `headingBold` (no 3D text used it; the page CSS still loads it for DOM text); `display` preloads only "A".
  - **O2-002** removed: `ease.spring`, `busy`, `lerp`, `CrewPiece.setName`/`absent`, `CompassTimer.reset`, `SceneDirector.footprint`/`onStatus`, placement `camera` param, `captionScale` + `scale`, `M.paperDeep/inkSoft/redInk`, `DirectorContext.table`/`disposed`, unused troika.d.ts members; made local: `CLOCHE_R`, `GLOBE_R`, `GLOBE_CENTER_Y`, `MAX_WRITE_MS`, `LOW_TEX`, `sheetPx`, `paperTexture`, `canvasTexture`, `contactShadow`, `PinSpec`, `FontKey`, `Globe.turnTo`, `DryRunCloche.lowPoly`, `SealChart.state`, `WristMenu.wheelHit`. (`Flag` in phone/components is outside this scope → R2-WP-16.)
  - **O2-018** new `scene/props.ts`: `pinInstances`, `paperFlag` (card fitted to troika `textRenderInfo` on sync), `hangingTag`, `foldedLetter`, `cardText`; `tw.prop` replaces several capture-and-lerp tweens.
  - **O2-023** `SoundBank.play` → a `RECIPES` table; XRApp constructor → `buildHailCard` / `buildMenu` / `wireInput`; SealChart → `buildRow` + `flatText`; `chartTexture` → border / rhumbs / rose / cartouche painters.
  - **O2-030** `PhaseController.targets(controls, status)` and `syncBooking(b, instant)`; `seals`/`backCard` private; one status getter.
  - **O2-034** new `phone/timing.ts` (speech/reading pace, audio wait, resume window, Gallery unlock wait) used by the scene/Gallery; `inkA(alpha)` replaces the 15 `rgba(31,42,68,…)`; PALETTE `waxDark`, `woodDark`, `twine`, `room`; `scene/layout.ts` `TABLE_TARGET` (Stage, XRApp orbit, Gallery); `CLIP_R = CITY_R − 0.002`; chart rose derived from `COMPASS_POS`.
  - **O2-001 / O2-024 (web bullets)** dropped the `HAIL_PRESETS`, `seatAngle` and `DirectorOptions` re-exports; SceneDirector `hail` / `setCaptionScale` / `speakerPosition` forwarders removed (XRApp emits `table:hail` and scales `director.table.caption`; Gallery calls `director.crew.speakerPosition`); `openHailCard` alias removed (`openHail` public); the `self` alias → `isResume: () => boolean`. SealCeremony `tie`/`voidAll` kept: `SealChart` stays private to it (O2-030), they are the part's API, not pass-throughs of a public object.
- **Tests:** `scene/tween.test.ts` (6: completion, in-place removal order, key completion, `prop`, `clear()` resolves waits without frames + resets speed + refuses new tweens, per-Stage isolation), `scene/billboard.test.ts` (3: equals `lookAt` under a rotated/scaled chain; batch-member parent; no parent), `scene/materials.test.ts` (2: `mergedGeometry`, `disposeObject` keeps shared/cached). `xr/input.test.ts` unchanged and green.
- **Measured (Chrome, Gallery, keyless local helm on :8799, same camera pose, before = 171d400 in a worktree):**
  - Draw calls: DRY_RUN 137 → 102; SEALING (overhead) 91 → 78. `renderer.info.memory.geometries` at DRY_RUN 124 → 66. Laptop XR view at DRY_RUN with the menu open: 120.
  - Texture memory (canvas maps in the scene, incl. mips): Gallery DRY_RUN 47.2 → 44.5 MB; card textures 3.1 MB → ~0.45 MB (caption 1024×145, back card 778×303, cloche tags 614×254 gone; only the keyed weigh-anchor/button/letter + a 256×16 deckle remain). Headset-only cards removed as well: wrist-menu back ≈ 4.1 MB, hail card ≈ 4.5 MB, seal chart ≈ 4.7 MB, debug card, ribbons (up to 54 widths). Estimated desktop card memory now < 1 MB (target < 3 MB).
  - Leaks: Gallery mounted/unmounted 5× with a pending `wait()` holding the director (what TurnPlayer does mid-line): before, 5/5 old `SceneDirector`s still reachable after GC pressure and 5 waits stuck in the global queue; after, 0/5 alive, 0 pending. Headset laptop view 3×: 0/3 directors alive, closed stores' `taps` 0 and listeners 0, reduce-motion `speed` back to 1 on the new Stage. Crew pieces add/remove (5 pieces): before 124 → 158 → 158 geometries (34 leaked); after 69 → 77 → 69, stable over 3 cycles.
  - Chunks (min): `Stage` 76.1 → 80.0 kB, `troika` 116.6 → 122.8 kB (`BatchedText`), `three` 636.3 → 640.1 kB (`BufferGeometryUtils`), `XRPage` 20.5 → 21.9 kB. No size warnings.
- **Gates:** web `tsc` clean, `vite build` OK, vitest 105/105 (18 files). Server `test/e2e.test.ts` 5/5 at 1832272 (the main tree's server is mid-refactor by R2-WP-13; this WP touched no server file).
- **Deferred:** phone files adopting `phone/timing.ts` (voices.ts 420 ms/word + 1500, Hail/VoiceNote/crew/Booked/organizer/DryRun/BrassDial/Brief literals) and the unused `Flag` icon → R2-WP-16 (outside this scope). `DryRun.buildRoutes` and `globeTexture` not split (O2-023 remainder, cosmetic). BatchedText not used for seal rows / crew flags (they toggle visibility or billboard per piece). No XR-headset profile run (no Quest here); the O2-054/O2-057 per-frame savings are by construction (no ancestor walks, half the idle casts). `xr.css` still spells `#221c17` (= `PALETTE.room`).

## R2-WP-16

### Phone & net cleanup, re-renders

- **Status:** done
- **Wave:** 4  ·  **Depends on:** R2-WP-08, R2-WP-09, R2-WP-12, R2-WP-14, R2-WP-15
- **Why:** `PhaseRoutes` and six screens still subscribe to the whole store. The crew-member form, the REST busy/error boilerplate and several tickers are copied. The web app hard-codes server limits. Unused exports, CSS and a misnamed shared chunk remain.
- **Scope (only touch these):** apps/web/src/phone/**, apps/web/src/net/**, apps/web/src/shared-ui/**, apps/web/src/styles/**, apps/web/src/scene/labels.ts (move only), apps/web/src/{scene,gallery} (O2-031 constant swaps only), apps/web/vite.config.ts (manualChunks), apps/web/tsconfig.json, packages/shared/src/constants.ts, apps/server/src/util/text.ts + apps/server/src/trips/table.ts (O2-031 import swap only)

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **O2-046** | Medium | M | `PhaseRoutes` and six screens still subscribe to the whole store (OPT-047 is only partly done) |  | `optimization.md` |
| [x] | **O2-015** | Medium | M | The name / band / origin form is written three times on the phone |  | `optimization.md` |
| [x] | **O2-016** | Medium | M | The REST action boilerplate is written 7 times, and error copy is applied inconsistently |  | `optimization.md` |
| [x] | **O2-021** | Medium | M | Long phone components and store constructor |  | `optimization.md` |
| [x] | **O2-031** | Medium | S | The web app hard-codes limits that live on the server or in shared constants |  | `optimization.md` |
| [x] | **O2-003** | Low | S | Unused exports in phone/net |  | `optimization.md` |
| [x] | **O2-008** | Low | S | Unused CSS rules, and one class with no CSS |  | `optimization.md` |
| [x] | **O2-009** | Low | S | Phone leftovers from the send-guard and TripShell split; `NO_STT` copy never shows |  | `optimization.md` |
| [x] | **O2-017** | Low | S | Smaller phone duplicates: tickers, speech fallback, storage JSON, literals |  | `optimization.md` |
| [x] | **O2-029** | Low | S | Phone emit guards, inline styles and hard-coded colours |  | `optimization.md` |
| [x] | **O2-047** | Low | S | Duplicate 250 ms tickers, an unstable context value, and a storage write during render |  | `optimization.md` |
| [x] | **O2-060** | Low | S | The shared chunk is named `labels` because the phone imports a `scene/` module |  | `optimization.md` |

**Notes:**
- **O2-009** and **O2-016** meet at useRecorder.ts:98-101: `transcribeError` should return `errorCopy(e)`, which also makes the `NO_STT` copy reachable.
- **O2-021**'s pure reducer map is what O2-067 (R2-WP-17) tests.
- **Done (R2-WP-16, 2026-09-25):**
  - **O2-046** — `useTrip` is gone (grep `useTrip(` in apps/web/src = 0). PhaseRoutes reads `status`, `name`, `connected`, `error` + `useCrew()`; Muster/Brief/Wait/Table/DryRun/Seal/Booked/Voided read their own `useTripSelector` slices. `HailDock` is `memo` and takes only `closed`/`opening` (token + sender from context, no inline `onHail`); `ShipsLog` renders memo'd `LogRow`s. The defensive `memo(...)` around route screens is removed (sub-components stay memo'd). By construction, a `turn:new` at AT_TABLE now re-renders `Table`, `ShipsLog`, one new `LogRow` (+ `TopDownChart` on a speaker change); `PhaseRoutes`, the dock and the other rows don't (before: PhaseRoutes, Table, HailDock, ShipsLog and every `<li>`, 7 selector runs). `turn:audioReady` / `plan:votes` / `table:watch` no longer re-render PhaseRoutes or re-match `<Routes>`. No React Profiler run (no DOM harness; the Chrome session has no React DevTools). GalleryPage `Corner` still reads the whole store (gallery is outside this WP's scope beyond constant swaps).
  - **O2-015** — `phone/components/CrewMemberFields.tsx` (name / band / port, `whose="your"|"their"`, `.spacer`) used by Create, JoinCrew and Muster's AddAbsent. The three default ports (ATL / ORD / JFK) are kept on purpose and now say why (a quick demo crew flies from three ports).
  - **O2-016** — `phone/useAsyncAction.ts` (`{busy, err, run(fn, fallback), clear}`), `errors.ts actionError(e, fallback)` (ApiError → `errorCopy`, else fallback), `ui.tsx InlineError`. Used by Create, JoinCrew, Muster (reset / reissue / seat reset / add absent), HeadsetCodeCard, UnpairHeadset, Demo; TripShell uses `actionError`. grep `e.message` in apps/web/src/phone = 0.
  - **O2-021** — tripStore: `export const reducers: {[K in keyof ServerToClient]: Reducer<K>}` (pure `(state, payload, surface) => patch`), the constructor just `listen`s to each key. Brief: `useBriefDraft` + generic `ChipGroup`; HailDock: `useHailSender`; Seal: `SealAction`; Create: `PortPicker`. New `net/reducers.test.ts` (4).
  - **O2-031** — web uses `NAME_MAX_CHARS`, `TRIP_NAME_MAX_CHARS`, `HAIL_MAX_CHARS`, `MIN_TABLE_CREW`, `JOIN_CODE_LEN`, `MAX_CREW`, `MAX_WATCHES`, `DRYRUN_DAY_START_MIN` (Muster, organizer, Join, Hail, Gallery corner, SceneDirector, Instruments, PhaseController, shared-ui/seating). New shared `DRYRUN_DAY1_LABEL` (phone clock, Instruments, PhaseController agree). grep `maxLength={24}`, `Math.min(3`, `8 * 60` in apps/web/src = 0. Server side was already done by R2-WP-13 (text.ts / table.ts import from shared; nothing to swap).
  - **O2-003** — dropped `export` from `SealPrivate`, `TripSocket`, `HeadsetSession`, `PasskeyResult`, `shallowEqual`, `CrewView`, `MemoryPrefill`, `waitForAudio`, `speak`; `TripView` deleted; `HAIL_MAX_CHARS` from shared. Kept: `clearHeadsetSession` (XRPage uses it since R2-WP-07), `captureDevKey` (api.test). `gallery/GalleryApp.ts Preset` not touched (out of scope).
  - **O2-008** — removed `--ease-physical`, `.hand`, bare `.ok`, `.wrap`, `hr.double`, `.card.flat`, `.card h3`; Table no longer emits `hand-quote` (Homemade Apple is for ≤ 8 words, doc 02; a hail can be 160 characters).
  - **O2-009** — unused `store` destructures, organizer's duplicate import, PhaseRoutes' `me?.` after the guard, stale "the shell re-renders" comments, tripStore's `pending` comment and stacked JSDoc fixed. `transcribeError` → `actionError`, so `NO_STT` shows "Voice isn't on here. Type it instead." `noUnusedLocals` + `noUnusedParameters` on in apps/web/tsconfig.json.
  - **O2-017** — `phone/useNow.ts` (AutoPickNote, SealCountdown, SailWithout); `speechCapMs(text)` in phone/timing.ts (voices.ts and scene/audio.ts `speakFallback`); `net/storage.ts` (`KEYS` registry, `readRaw/writeRaw/readJSON/writeJSON/removeKey`, in-memory fallback per area) used by session.ts (incl. `aa:last`, which bypassed the fallback), Muster invites, organizer `unsealedSince` (removed once everyone has sealed), api.ts dev key, passkey.ts kill switch; `BAND_IDS`; `sealIsSet`; `HAIL_DROPPED`; TOO_FEW copy from `errorCopy`; shared `SIGNAL_LOST` (phone strip + Gallery corner). session.test +1 (localStorage throwing: `aa:last`, seat and forget still work).
  - **O2-029** — CrewDoor uses `useSendGuard("crew:setOpen", {reopenOnOk:true})` (a double tap toggles once — checked live); `.mt-xs/.mt-s/.mt-m/.mt-l/.mb-xs/.m-0/.pt-0/.pb-0/.spacer` (last in phone.css); inline `style={{…}}` in phone 34 → 3 (all data-driven: band colours, QR placeholder size); QR colours from `PALETTE`, QR `<img>` background `var(--qr-paper)`, crew initial on the wood disc `PALETTE.paper`; `JoinCrew` moved to `phone/components/`.
  - **O2-047** — one `MinuteTicker` per store (DryRun.tsx, `useSyncExternalStore`), running only while the day runs; subscribers get the whole minute, so `Timeline`/clock render once per minute change; TripProvider value `useMemo`'d; `unsealedSince` write moved into an effect.
  - **O2-060** — `scene/labels.ts` (+ test) → `shared-ui/labels.ts` (TurnPlayer import updated); grep `scene/` in apps/web/src/phone = 0. manualChunks: `socket` (socket.io/engine.io), `tripstore` (net/tripStore + shared-ui + phone/timing), and — so rollup doesn't pull them into that chunk — `react` (react/react-dom/scheduler) and `shared` (packages/shared). No `labels-*.js`.
  - **Follow-ups from other WPs:** phone timings now in `phone/timing.ts` (hail/note max, preview, two-tap, copied, sail-without, countdown/dry-run ticks, lookup retry, .ics URL TTL, `speechCapMs`); unused `Flag` icon removed (O2-002 web remainder). Voided: "Adjust my terms" only for the organizer, members read "The organizer chooses what's next…"; Brief is locked in VOIDED for everyone but the organizer (L4-002 UI). CrewList: "(away, opened their invite)" (S2-012 UI). `seatClaims.resetSeat` → new `api.resetSeat` (seatClaims.test +1). JoinCrew's post-failure crew refresh is aborted on unmount / a new code (R2-WP-08). Hail dock disabled with the TABLE_OPENING copy during Watch 0 and "Captain's calling it" from Watch 3 (`trip.negotiation.watch`), like the helm (R2-WP-04/-09). `xr.css` uses `var(--room)` (tokens.css `--room: #221C17` = `PALETTE.room`). R2-WP-14 static fields: Brief/Seal/Booked read `dateWindows` from the store's merged trip (`withStatic`); checked live (Brief chips after a reload).
  - **Out-of-scope touches (flag for review):** `apps/server/test/contract.test.ts` — the static "every ServerToClient event has a tripStore handler" check now reads the `reducers` map keys instead of `on("…")` calls (needed for the gate). `apps/web/src/xr/XRApp.ts` — removed an unused `import * as THREE` (the only thing `noUnusedLocals` flagged outside scope). `scene/audio.ts` — `speakFallback` cap → `speechCapMs` (O2-017; a one-line swap). `gallery/GalleryPage.tsx` — `SIGNAL_LOST` next to the `MAX_WATCHES` swap.
  - **Chunks (min, before → after):** TripShell 67.12 → 64.56 kB; Create 3.07 → 2.75 kB; `labels` 48.60 → `socket` 41.62 + `tripstore` 7.27 kB; main `index` 266.92 → 43.47 kB + `react` 223.19 kB (vendor split, same total); new `useAsyncAction` 1.93 kB (errors.ts + hook; `useInlineError` moved to TripContext so Create/JoinCrew don't pull the context), `CrewMemberFields` 0.86 kB; `constants` 1.87 → `shared` 2.12 kB (all of packages/shared). No size warnings.
  - **Verified:** gates twice — web `tsc` (with noUnused*), `vite build`, vitest 19 files / 115 tests; server `tsc`, vitest 36 files / 430 tests (incl. e2e zero private events, negotiation/pricing). Chrome (own tab, closed after): /demo seed → Rae's Muster ("Dev (away, opened their invite)", add-absent form: `Their …` labels, JFK, taken bands disabled, maxLength 24), crew door double tap toggles once, Brief with the sealed terms and date chips, a gone voyage → NO_TRIP card; no console errors. Not walked to the table / Dry Run: the running helm has Gemini and ElevenLabs configured, so a table would spend paid calls.
  - **Deferred:** a React Profiler measurement of the re-render counts (no harness; by construction above) and a hook test for `useAsyncAction` (O2-067 / R2-WP-17: no DOM harness). `noUnusedLocals` for apps/server/tsconfig.json (out of scope; the server already passes with both flags). `GalleryApp.Preset` export and GalleryPage `Corner`'s whole-store read (gallery scope). `phone/timing.ts` is imported by scene/gallery (the reverse of the phone→scene rule); moving it to shared-ui would touch 4 scene/gallery imports. Visual checks of the Table/Dry Run/Seal screens and dark mode on those screens not done live (paid table).

## R2-WP-17

### Tests & tooling

- **Status:** done
- **Wave:** 4  ·  **Depends on:** R2-WP-13, R2-WP-14, R2-WP-15, R2-WP-16
- **Why:** Four full-voyage tests spend 11.5 s on real pacing. The sweep, write queue, socket budgets, negotiation rules 3–5, pricing failures, memory and voice backends, every web hook and all scene/XR logic are untested. There is no bundle-size guard, and a dev-only vitest advisory is open.
- **Scope (only touch these):** apps/server/test/**, apps/web/src/**/*.test.ts(x), apps/web/package.json + apps/web/vite.config.ts (test block), scripts/ (new bundle-budget.mjs), package.json, package-lock.json

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **O2-062** | Medium | S | Four full-voyage tests spend 11.5 s waiting on real pacing |  | `optimization.md` |
| [x] | **O2-064** | Medium | M | Server coverage gaps in the sweep, memory notes, write queue and socket budgets |  | `optimization.md` |
| [x] | **O2-065** | Medium | M | Coverage gaps in negotiation, pricing, memory and voice logic |  | `optimization.md` |
| [x] | **O2-067** | Medium | M | Web hooks and client logic untested; no jsdom setup |  | `optimization.md` |
| [x] | **O2-068** | Medium | M | Scene and XR pure logic is untested |  | `optimization.md` |
| [x] | **O2-061** | Low | S | `npm run check` has no bundle-size guard |  | `optimization.md` |
| [x] | **O2-063** | Low | S | Fixed sleeps in the payments tests; the same meeting runs three times |  | `optimization.md` |
| [x] | **O2-069** | Low | S | Stale test comment and duplicated store tests |  | `optimization.md` |
| [x] | **S2-017** | Info | S | Dev-only dependency advisory (vitest / @vitest/mocker) |  | `security.md` |

**Notes:**
- Never call a paid API in a test: stub fetch, and keep the setup that blanks every key.
- **S2-017** — after the vitest upgrade, run both suites twice.
- **Done (fixer R2-WP-17, 2026-09-25):**
  - **S2-017** — vitest 3.2 → **4.1.11** (server + web devDependencies; web now declares its own). `npm audit`: 0 vulnerabilities. Both suites run twice green.
  - **O2-062** — e2e / contract / plan-privacy / write-volume at `PACE_SCALE=0`. New `test/support/holdForHail.ts`: the Watch-1 PROPOSE line's voice step waits until a hail is pending (event-driven, setImmediate polling, 5 s give-up), so the hail still lands in Watch 2 without real pacing. contract L3-002's 1.5 s memory timer → a promise the test releases. e2e Expo run 3,028 → ~120 ms, contract full voyage 3,040 → ~160 ms, plan-privacy Gallery 2,805 → ~50 ms, contract L3-002 1,508 → 3 ms, write-volume 1,227 → 62 ms.
  - **O2-063** — new `test/support/quiet.ts` (`trackSim` counts SIM calls in flight; `quiet()` waits until none for 3 loop turns; `until(pred)`). payments/audit use it; no `setTimeout(r, 80)` left; audit's provider stubs keep a 30 ms `lag` (that is the fake network, not a wait). payments + audit: 1.46 s → ~0.72 s. negotiation: the scripted Expo meeting runs once (`expoMeeting()`) for the two tests that read it. write-volume's EventBuffer test uses fake timers.
  - **O2-064** — new `coverage-sweep.test.ts` (11: settled voyages past `voyageDoneMs` evicted with their booking; `dropHot` after 2 h; SEALING/AT_TABLE never swept; `lastHailAt` and pair-index pruning; O2-035 orphan booking — verified to fail with the fix commented out; booked memory note per member (band, liked, conceded, never the cap); `checkCharts` on current-shape docs) and `coverage-queue-sockets.test.ts` (7: WriteQueue backoff/park/`retryFailed`, reconnect sync writes everything, per-socket 60/10 s budget, per-address socket cap, connects per minute).
  - **O2-065** — new `coverage-rules-pricing.test.ts` (21: `decideResponse` rules 3–5 incl. Watch-3 majority, "nearly as good", hail "cheaper"; pricing `no_flight`, `date_mismatch`, hostel dealbreaker, `long_walks`, `shortlist()` with < 2 plans) and `coverage-memory-voice.test.ts` (14: Backboard failure → local, 60 s back-off, Mongo load failure not cached, > 25-line threads; TTS non-OK / timeout / unwritable cache / cached-mode miss; `transcribe`). fetch stubbed everywhere; keys faked in-process and reset.
  - **O2-067** — DOM harness: `happy-dom` + `@testing-library/react` (+ `/dom`); `vite.config.ts` gets a `test` block (node by default, `restoreMocks`); DOM files opt in with `// @vitest-environment happy-dom`. New `phone/hooks.test.tsx` (14: useSendGuard latch / stale ack / reopenOnOk / lost-socket reopen; useTripSelector caching and re-render counts; useCrew stability; useInlineError ownership + banner consumption (O2-026) and `events` scoping; useTwoTap; useAsyncAction busy/dup/phone copy/unmount; useNow), `phone/screens/screens.test.tsx` (3: Booked .ics escaping + exclusive DTEND + only my itinerary; SailWithout clock survives remount and is forgotten when all sealed; members never see it), plus the deferred phone DOM tests from R2-WP-08/-09/-16: `phase-routes.test.tsx` (7: NO_TRIP "Back to the start" forgets the seat; LOADING mark; lost seat; JoinCrew LOADING retries on schedule, gives up, 404, aborts on unmount) and `voting-sealing.test.tsx` (9: DryRun vote ack springs back (L1-003); HeadsetControls organizer-only on Table/DryRun/Seal (L1-006); locked Brief read-only (L1-007); Seal PASSKEY_REQUIRED once inline + "Every seal is set · settling…" hides call-off (LIVE-001/O2-026); Hail disabled in Watch 0 and after DECIDE). passkey / seatClaims / captureDevKey already had pure tests (R2-WP-01/-12/-16).
  - **O2-068** — node-env tests: `scene/geo`, `seats`, `text` (coverText, troika mocked), `sheets` (sharedSheet LRU), `instruments` (CarriageClock, CompassTimer), `dryrun` (cloche clamping), `director/director` (CrewSeating removal, SealCeremony fmtWindow + pressed de-dup, TurnPlayer MAX_BACKLOG, PhaseController transitions / cancelPick / void card), `SceneDirector` (unchanged, pins once, Watch cap, rejection undo), `xr/placement` (canFallback), `xr/wristMenu` (palm-up rule), tween +5 (speed, wait, keys). 67 tests.
  - **O2-069** — the outbox and `table:failed` tests live once, in `net/contract.test.ts` (the queue cap and "kept until cleared" moved there); removed from `tripStore.test.ts`. Stale "No web test script yet" comment removed from `xr/input.test.ts`.
  - **O2-061** — new `scripts/bundle-budget.mjs` (per-chunk budgets at today's sizes, +10 % tolerance, 8 kB for an unlisted chunk; follows static imports from every phone route and fails if three/troika/3d-tiles/Stage/XRPage/GalleryPage is reached). Root `npm run budget`, chained at the end of `npm run check`. `BUNDLE_BUDGET_SCALE=0.8 npm run budget` exits 1; a TripShell chunk patched to import three exits 1 naming the path.
  - **Follow-ups:** `apps/server/tsconfig.json` `noUnusedLocals` + `noUnusedParameters` on (nothing flagged). `devServer.test.ts`: `http.closeAllConnections()` in afterAll (the web suite intermittently waited ~3 s on keep-alive sockets under vitest 4) and no dep-discovery crawl.
  - **Durations:** server vitest wall 6.9 s → **4.1 s** (430 → **483** tests, 36 → 40 files); web 0.87 s → **1.4 s** (115 → **213** tests, 19 → 33 files; the DOM files add ~0.7 s of environment setup). Root `npm run check` green twice.
  - **Gates:** server tsc + vitest, web tsc + build + vitest, root `npm run check` — all green, twice. e2e zero-private-events and the Expo shares unchanged.
  - **Findings (not fixed, src out of scope):** memory.ts reads Backboard `page=1&page_size=25` and takes the newest 5 of that page — if the API pages oldest-first, a thread with > 25 memories recalls stale lines forever (API order unconfirmed; ask for newest-first or read the last page). `scene/text.ts` SUBST soft-hyphen entry is dead (U+00AD is in the covered Latin-1 range). `SealCeremony.fmtWindow` across a month end reads "May 29–2" (test pins current behaviour). `PhaseController.buildDryRun`'s "same shortlist, reuse the cloches" branch looks unreachable.
  - **Deferred:** seal-integrity's S2-001 timing test (2.3 s) and SEC-002 (0.8 s) still use real timers on purpose (they measure publish timing); converting them to fake timers would need the socket-free helm under `vi.useFakeTimers` — left. db.ts's own reconnect order (needs a mocked MongoClient). HeadsetCodeCard open (qrcode + pairing mocks), JoinCrew submit path, PhaseRoutes phase-to-phase redirects, Hail recording/preview. A React Profiler re-render measurement (R2-WP-16) — the selector re-render counts are asserted in hooks.test.tsx instead.

## R2-WP-18

### Docs sync

- **Status:** done
- **Wave:** 4  ·  **Depends on:** R2-WP-13, R2-WP-14, R2-WP-15, R2-WP-16, R2-WP-17
- **Why:** docs/04 §4 has drifted from the stored data, and several fixes above change documented behaviour.
- **Scope (only touch these):** docs/** (not docs/review, docs/review-2 except REVIEW-REPORT "Status after fixes"), README.md, DEPLOY.md, .env.example

| Done | ID | Severity | Effort | Finding | Also covers | Detail |
|---|---|---|---|---|---|---|
| [x] | **L5-013** | Low | S | docs/04 §4 drifts from the stored data in a few places |  | `trace-5-persistence.md` |

**Notes:**
- Also carry the doc lines other items flag: doc 04:393 join-ack order (L3-002); doc 04 §4 single writer (L5-002); doc 04 §5 VOIDED→BRIEFING decision (L4-002); the passkey flow in doc 06 §4.1 and doc 03's Seal screen (LIVE-001); the hail during OPEN (L4-005); new error codes (headset unpaired / token rejected, L3-001); the limits table in doc 04 §12 (S2-006, S2-014, L5-011).
- Add a "Status after fixes" section to docs/review-2/REVIEW-REPORT.md.
- **Done (fixer R2-WP-18, 2026-09-25):**
  - **L5-013** — docs/04 §4: preamble (`autoPick` absent before DRY_RUN, filled with `null` on restore; the version guard orders one writer's snapshots, the lease keeps a second instance out; restore rules incl. `VOYAGE_STALE_DAYS`), §4.1 (`presetId` gone, `autoPick?`), §4.2 (`standing` without `limitCents`, `joinedAt` gone), §4.3 (cap only in the brief and the instruction limit), §4.5 (`shortlists`, exact total server-only), §4.6 (old-round turns deleted), §4.7 (`settleAt`, `setAt` gone, `groupCents` server-only), §4.9 (`spend` TTL index), §4.10 (`helm_lease`), new §4.11 "Memory only, by design".
  - Carried doc lines: doc 04 join-ack order (§7.1/§7.3, already right), single writer (§4), VOIDED→BRIEFING organizer-only (§5, doc 03 P10), passkey flow (doc 06 §4.1/§4.2/§5.1/§9, doc 03 P5/P8, doc 01 E2, doc 04 §2/§9.4), hail in Watch 0 and refused hails rate-limited (doc 04 §7.1/§12, doc 03 P6), new codes (`TOKEN_REJECTED`, `DEVICE_EXPIRED`, `UNKNOWN_EVENT`, `PASSKEY_UNBOUND`, `TABLE_OPENING`, `HELM_FULL`; doc 04 §6 errors now from `util/errors.ts`), limits table (create caps, 15-min sweep), Referrer-Policy same-origin, `?key=` gone, tile-token restriction, `trip:state` live broadcasts without static fields, `BookingPublic` without `groupCents`, collect-then-settle wording (doc 04 §7/§8.2, docs 01/02/03/06/08/09; the Nobody-fronts demo order now works with the Lift link), public ranges and no home airports (docs 00/01/02/05/07/08/09; doc 05 §3 contexts rewritten as built), dev/demo tunnel flow (doc 04 §10), layout tree and test section (doc 04 §3/§14).
  - README (unchanged counts: 483 / 213 at `24694a5`), DEPLOY.md (Referrer-Policy; a table for every other env var the code reads), `.env.example` (dev-route/key notes, settle point not configurable, tile-token restriction, sweep interval). Every env var read by config.ts / vite.config.ts is in `.env.example`, DEPLOY.md and doc 04 §11.
  - REVIEW-REPORT.md: "Status after fixes" with the commit list, test counts and the still-open list gathered from every WP's notes.
  - **Unticked boxes left on this board:** S2-015 only (provider-side token restriction; needs the account owner). Every Overview row reads `done`.

## Already fixed in e64d877 (no task)

The live Chrome run found five bugs that are already fixed (see `live-e2e.md`, "Found and already fixed"). None of the round-2 reviewer findings is exactly one of them, so no ID is closed by that commit:

- `/api/audio/:turnId` 404 for cached voices under `.cache` (dotfile) — not L3-005 (that is the empty, non-JSON 404 body for an *unknown* turn) and not L5-012 (pruning).
- Memory banner repeated "voyage:".
- City tiles' 4 s give-up counted wall-clock time instead of rendered time.
- Chart-room help text overlapped the captions — not L2-001 (the wrist menu opening above the viewport was fixed later in R2-WP-07).
- "Hail the table" enabled outside the table — not L2-005 (fixed later in R2-WP-07: hailing only from Watch 1 to the last Watch).

## No task

None. Every one of the 137 finding IDs above is a canonical task or listed under *also covers*.
