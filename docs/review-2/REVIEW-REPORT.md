# All Ayes — Review Report, round 2

**Reviewed:** commit `0430ef9` (after all 17 round-1 work packages landed), about 21,000 lines of TypeScript including tests: server, phones, headset/Gallery and the shared contract. The current HEAD is `e64d877`, which fixes five small bugs found in the live run (see below).
**How:** 7 independent read-only reviewers (1 security expert, 1 optimization reviewer, and 5 traceability reviewers, one per layer from the buttons down to the database and back), plus **a live end-to-end run in Chrome**. Findings were checked by reading the code end to end, running the test suites (server 308 tests, web 52, all passing at review time), probing the running dev server, and reading the real MongoDB Atlas database without writing to it. No paid API was called on purpose.
**Companion files:** [`TASKS.md`](TASKS.md) (the work board for fixers), the 7 detailed reports and [`live-e2e.md`](live-e2e.md) in this folder.

---

## Status after fixes (2026-09-25)

**All 18 work packages are done.** 128 of the 129 tasks are fixed and ticked. The one box left open is S2-015 (the browser tile tokens): the docs part is done, but the restriction itself has to be set in the Google Cloud and Cesium ion consoles by the account owner. The four things this report said to fix before the Expo are fixed:

1. **No more surprise passkey sheet.** "Set your seal" never starts a passkey registration. A member without a passkey seals with a tap. Anyone who wants a passkey adds one on purpose with **Add a passkey** (Wait or Brief screen), and a cancelled Face ID prompt never sets a seal (R2-WP-01).
2. **Seal timing no longer gives anyone away.** Seals are collected first and nothing is authorized while they gather. About 2.5 seconds after the last seal is set, every share is authorized together and the outcome is published for everyone at the same moment. A lifted seal looks exactly like a set one (R2-WP-02).
3. **The public plan no longer narrows anyone's share.** Group totals are shown as ranges (Lisbon "$2,650 to $3,100", Mexico City "$1,550 to $2,100"). Pick times follow a fixed layout, home airports are gone from everything public, the globe has a single home-port rivet, and the public booking has no group total. Members still see their own exact share ($1,038 / $868 / $963 in the Expo script) (R2-WP-03).
4. **Hails can't be used to probe budgets.** Every non-public amount is stripped whatever the secrets are. Refused hails count toward the rate limit, and hails are closed while the Captain opens the table (R2-WP-04).

The three pre-deploy Highs are fixed too. No new booking can start while a refund is owed. Failed writes are parked and retried, and a single-writer lease stops two helms writing at once. Settled bookings leave memory with their voyage.

**Commits** (`git log --oneline aa7895d..HEAD`, oldest last):

| Commit | What |
|---|---|
| *(final, uncommitted)* | R2-WP-18: docs 00–09, README, DEPLOY.md and `.env.example` synced with the as-built system; this status section |
| `24694a5` | R2-WP-17: DOM test harness (happy-dom + Testing Library), coverage gaps filled, bundle budget in `npm run check`, faster server suite |
| `9a55152` | R2-WP-16: phone and net cleanup, fewer re-renders, organizer-only "Adjust my terms", "opened their invite", hail off in Watch 0 |
| `91e29a8` | R2-WP-14: `shortlists` collection (trip doc 12 kB → 0.8 kB), batched audit events, coalesced booking writes, lean `trip:state` broadcasts |
| `cc5c6d9` | R2-WP-13 + R2-WP-15: server refactor (no behaviour change); 3D leak and performance fixes |
| `1832272` | R2-WP-12: unknown-voyage lookup limit, per-/48 pairing limit, spend reserve and stored spend counters, empty clip → 422 |
| `171d400` | R2-WP-11: settled bookings, SIM records and passkeys evicted with their voyage; create caps and live-voyage cap; lone/stale sweeps; old-round turns deleted |
| `54a00f4` | R2-WP-08 + R2-WP-10: client transport and store; identity and seat races (organizer-only reopen, seat reset, passkey claim cookie) |
| `b1fe52e` | R2-WP-07: `TOKEN_REJECTED` / `DEVICE_EXPIRED` and the role in the join ack, headset re-pair card, chart-room menu fixes |
| `797ac46` | R2-WP-06: parked-write retry, single-writer lease, full reconnect, `LOADING` while MongoDB is down, boot resilience |
| `9128272` | Round 2 wave 1 (R2-WP-01 to R2-WP-05) + R2-WP-09: passkey-free sealing, collect-then-settle seals, public ranges, hail oracle closed, dev/demo exposure, phone UX |

**Tests.** At `8adeee9`, `npm test` runs **485 server tests in 40 files** and **214 web tests in 33 files**, all passing. At review time it was 308 and 52. Server and web `tsc --noEmit` are clean, the production build succeeds, and `npm run check` now also enforces the bundle budget. The Expo script is unchanged (Lisbon shares $1,038 / $868 / $963, Mexico City internal total $1,975), and the end-to-end test still shows **zero** private events reaching the headset and the Gallery.

### Still open / needs outside help
None of these blocks the Expo demo. They need an account owner, hardware, a real deploy, or a product decision.

**Needs an account owner or outside credentials**
- **Tile tokens (S2-015):** restrict the Google Map Tiles key (HTTP referrer, Map Tiles API only, a quota) and the Cesium ion token (`assets:read`, asset 2275207, allowed URLs) in the provider consoles. If either one was ever deployed without restrictions, rotate it. Steps are in DEPLOY.md, "Browser tile tokens".
- **Visa Intelligent Commerce:** payments still run in the labelled simulation until sandbox credentials arrive and `payments/visaVic.ts` is wired. The Visa provider also has no `forget` for evicted voyages yet.
- **Backboard paging order (found in R2-WP-17):** fixed in `8adeee9`. Backboard's docs don't state a list order, so recall now reads the first and last pages (at most 3 requests) and keeps the newest lines either way. Nothing to confirm.

**Needs real hardware or a live check**
- **A real Quest 3:** immersive entry, placement and anchors, hand input, 72 fps, in-headset text size, and the per-frame savings from R2-WP-15 have only been checked in the laptop view.
- **Manual phone and Chrome checks:** "Set your seal" with a password manager installed, "Add a passkey" on a real iPhone or Android, and the Table, Dry Run and Seal screens in dark mode. These weren't run live, because a live table costs paid API calls. They're covered by unit and DOM tests.

**Needs a product or spec decision**
- **Absent-friend invites (S2-012, partly fixed):** everyone now sees when an invite has been opened, and the organizer can reset a seat ("Wasn't X?"). The full fix, a claim secret the organizer can't read, needs the invite delivered out of band (email or SMS, or a key made on the friend's phone). That channel doesn't exist yet. There's also no way to recover the organizer's own seat if their token leaks.
- **Booking write count (O2-038):** a booking now takes n+5 writes, not the n+3 the task asked for. Getting to n+3 would mean dropping either the per-capture `capturedAt` intent or the `published` bookkeeping at the settle point. Both are in the spec (doc 06 §4.2, doc 04 §4.7), so this needs a spec decision.
- **Per-address `table:start` quota:** not added. A venue NAT puts many Expo crews behind one address, so the quota could block honest crews. The per-voyage `TABLE_RUNS_MAX` and the spend reserve cover it for now. The reserve's "past the table" test is a heuristic: a determined abuser could walk template-only tables through to the Dry Run.
- **What an Advocate may say:** a mate may still describe its own member's picks, paraphrased (the "discreet" tier). That links pick prices to that member. Flights stay hidden.

**Known limits (accepted)**
- The headset only finds out it has been unpaired or replaced on its next action or join. Nothing tells it at the moment it happens.
- Right after a restart, a few paid calls outside the hail gate can get through while the stored spend counters are being read. This is bounded. Spend counters for evicted voyages stay until their 90-day TTL.
- The single-writer lease uses each instance's own clock. That's fine on Render, but clock skew larger than the 30 s TTL would matter.
- Without MongoDB, a voyage evicted as lone or stale is gone, not archived.
- A stray queued write of an old-round turn can land after the cleanup. The next round removes it.
- A refused join other than `LOADING` (e.g. `SLOW_DOWN`) is only sent again on reconnect.

**Small follow-ups (nice to have)**
- Memory entries still load all at once on first use (`memory.ts`). The typed `C2SPayload` in `packages/shared/events.ts` is still unused.
- The seal-timing tests (S2-001, about 2.3 s, and SEC-002) still use real timers on purpose, because they measure publish timing. There's no DOM test yet for the headset code card, the JoinCrew submit path, phase-to-phase redirects, or hail recording.
- Cosmetic leftovers: `DryRun.buildRoutes` and `globeTexture` could be split, `xr.css` spells out `#221c17` instead of `PALETTE.room`, and the re-render counts were asserted in tests but not measured with the React Profiler. Also found in R2-WP-17: a dead soft-hyphen entry in `scene/text.ts`, a month-end date label ("May 29–2") in `SealCeremony.fmtWindow`, and a branch in `PhaseController.buildDryRun` that looks unreachable. All three, and the Backboard paging (recall now reads the newest memories whichever order Backboard lists them in), were fixed in `8adeee9`.

---

## The bottom line

The round-1 fixes mostly held. There are **no Critical issues this time** (round 1 had 2), and High issues dropped from 17 to 6. The wiring between phones, headset, Gallery and server matches everywhere, the Expo numbers are right to the cent, and across a full live voyage the headset and Gallery got **zero** private events.

**Four things still need fixing before the Expo:**

1. **Setting your seal pops up a "create a passkey" sheet (High, live).** For anyone with no passkey yet (every member at the Expo), tapping "Set your seal" starts a passkey *registration*. In the live run a 1Password sheet covered the tab and blocked it. And if someone cancels that sheet, their seal gets set anyway.
2. **"Nobody learns whose payment failed" still leaks through timing (High).** Seal statuses no longer say who declined, but the booking voids about a second after the declining seal is set. For an absent friend's automatic seal, the Gallery can tell with certainty who it was.
3. **The public plan still narrows everyone's share (High).** The exact reconstruction from round 1 is fixed. But re-running the open-source plan builder against the public schedule, group total and home airports narrows each member's share to a few values about $60 apart. The organizer's share comes out exact in half the plans.
4. **Hails can be used to probe budgets (Medium).** A carefully built hail is refused only when a secret number is close to a guess, and refused hails cost nothing. So a crew member, or an outsider who read the join code off the Gallery URL, can home in on other people's caps.

**And three more before a public deploy:** a way to start a second booking while money from the first is still owed a refund (High); database writes that fail during an Atlas outage are never retried, so after the next restart a booking that was really charged can be announced as "nobody was charged" (High); and settled bookings are never removed from memory (High, slow growth).

---

## Scoreboard

| Area | Critical | High | Medium | Low | Info | Total |
|---|---|---|---|---|---|---|
| Security | — | 2 | 4 | 8 | 3 | 17 |
| Optimization | — | 1 | 28 | 40 | — | 69 |
| Trace 1 · Phone UI → client | — | — | 1 | 9 | — | 10 |
| Trace 2 · Headset/Gallery → client | — | — | 2 | 6 | — | 8 |
| Trace 3 · Client ⇄ server contract | — | — | 1 | 8 | — | 9 |
| Trace 4 · Server → domain modules | — | 1 | 1 | 8 | — | 10 |
| Trace 5 · Persistence → MongoDB → back | — | 1 | 4 | 8 | — | 13 |
| Live Chrome run | — | 1 | — | — | — | 1 |
| **All findings** | **0** | **6** | **41** | **87** | **3** | **137** |
| **After merging duplicates** | **0** | **6** | **38** | **82** | **3** | **129 tasks** |

Eight findings were reported more than once and are merged into the task that fixes them:
- The passkey prompt: LIVE-001 also covers L1-001 (cancel still seals) and L1-004 / O2-026 (the refusal shows twice).
- A headset or phone whose token stopped working silently becomes a spectator: L3-001 also covers L2-002.
- Hail "slow down" copy shown for unrelated refusals: L1-008 also covers L3-008.
- Bookings never evicted: O2-035 also covers L4-010 and S2-011.
- XR objects and listeners left behind on unmount: O2-053 also covers L2-007.

That leaves 129 distinct things to fix, in 18 work packages.

---

## Fix these first

| # | What's wrong (plain language) | Why it matters | Severity | Work package |
|---|---|---|---|---|
| 1 | "Set your seal" starts a passkey registration for anyone without one; cancelling it still seals (LIVE-001) | Every tapper at the Expo hits a system sheet mid-ceremony; live, it blocked the tab | High | R2-WP-01 |
| 2 | The moment a booking voids shows whose seal declined, and for an absent friend's automatic seal it's certain (S2-001) | Breaks "nobody learns whose payment failed" | High | R2-WP-02 |
| 3 | Public schedule times, group total and home airports narrow every share to a few values (S2-002) | Breaks "nobody sees your budget"; anyone with the join code can do it | High | R2-WP-03 |
| 4 | New terms → new table → pick starts a second booking while the first still owes a refund (L4-001) | Friends asked to pay again before their money comes back | High | R2-WP-02 |
| 5 | Writes that fail during a MongoDB outage longer than ~70 s are never retried (L5-001) | After a restart, a booking that was charged can be voided and announced as "nobody was charged" | High | R2-WP-06 |
| 6 | Hails can be crafted to test guesses against other members' caps, for free (S2-003) | A crew member or outsider can learn budgets to within 5 % | Medium | R2-WP-04 |
| 7 | The demo setup (`vite --host` + tunnel) serves the whole repo, including the memory file; the debug page's "anonymous" labels can be reversed and open with just a join code (S2-005, S2-004) | On Expo Wi-Fi or via the tunnel, anyone can download past trips and budget bands, or see whose seal declined | Medium | R2-WP-05 |
| 8 | A headset whose pairing was replaced, expired or unpaired keeps its controls, and every tap says "Only the organizer can do that." (L3-001 + L2-002) | Confusing on stage, with no way to re-pair from the headset | Medium | R2-WP-07 |
| 9 | In the laptop view the chart-room menu opens partly off-screen, so "Recenter chart" and "Captions" can't be clicked (L2-001) | Visible in any laptop demo of the headset | Medium | R2-WP-07 |
| 10 | Settled bookings (and card-simulator and passkey records) are never removed from server memory (O2-035) | Memory grows with every booking until a restart; each reconnect re-writes them all | High | R2-WP-11 |

**Suggested cut for Expo day:** R2-WP-01 (passkey prompt), R2-WP-02 (seal timing and the refund gate), R2-WP-04 (hail probe), R2-WP-05 (point the tunnel at a production-mode build; lock down `/@fs/` and the debug page), and L3-001 + L2-001 from R2-WP-07 (headset). R2-WP-03 is the largest single fix (L). If it can't land in time, keep the join code and Gallery URL off public screens and close the crew once everyone is aboard.

**Before a public deploy at `allayes.tech`:** everything in waves 1–3, in particular R2-WP-03 (plan privacy), R2-WP-06 (persistence), R2-WP-10 (seats and crew races), R2-WP-11 (memory bounds) and R2-WP-12 (rate limits and budgets). Wave 4 is clean-up, performance and tests.

---

## What's solid (verified, no action needed)

- **Expo numbers are exact.** Lisbon $2,869 with shares $1,038 / $868 / $963, Mexico City $1,975, the 9-turn script with 8 voiced lines, and Maya's "gave up the city pick last time" memory line. The lift, decline and retry paths book on the third attempt with no card holds left.
- **Private events stay private.** Across a full live voyage (brief → table → dry run → sealing → void → retry → booked), the headset, the Gallery and a bad-token spectator got **zero** private events, including 8 fresh replays. The 3D scene never reads a private field.
- **All round-1 routes and events are wired.** Every one of the 19 REST functions matches its route (path, method, body, auth, response). All 15 client→server events have a handler and there are no undeclared ones. All 18 server→client events are emitted and handled, and the contract is now type-checked. On the phone, 83 buttons and links were traced with none broken; on the headset and Gallery, 38 with none broken. The round-1 "dead pinch" bug is fixed and verified live.
- **Restarts restore every status.** A restart was simulated for each trip status: all restore without a crash, and what a rejoining phone or Gallery receives matches the design doc's replay order.
- **The real database matches the design.** On Atlas, every collection's shape and every index in docs/04 §4.9 (including the unique and time-to-live ones) exist. There are no dangling members, no trip↔booking mismatches, no orphan bookings, and no private caps stored in bookings.
- **Classic web security holds.** Auth is checked on every route and socket event. Tokens are 256-bit, stored hashed and compared in constant time. The passkey relying party is pinned in production, and security headers and CSP are present. There's no XSS, no injection and no path traversal, and production mode fails closed. `npm audit --omit=dev` finds 0 vulnerabilities.
- **Payments are race-safe.** Double taps, a call-off racing the last seal, and a deadline racing an authorization all end with nobody charged twice and no hold left. Nobody is ever charged above their cap.
- **Performance where it counts.** The live state update is at most 1.6 kB (7.5 kB in round 1), building it takes about 1 µs, and a rejoin replay takes 0.28 ms. Phones never download the 3D library, and the 3D code is split into cacheable chunks.

---

## Round 1 → Round 2

All 17 round-1 work packages were marked done. The round-2 reviewers re-checked the round-1 findings in their area:

| Area | Re-checked | Confirmed fixed | Only partly fixed → where it reappears |
|---|---|---|---|
| Security | 24 | 19 (4 with a smaller residual: SEC-004 → S2-012, SEC-005 → S2-014, SEC-008 → S2-009, SEC-019 → S2-013) | SEC-001 → **S2-002** (plan data) · SEC-002 → **S2-001** (seal timing) · SEC-015 → **S2-006** (no global cap) · SEC-017 → **S2-003** (hail oracle) · SEC-025 → **S2-004** (debug page) |
| Optimization | the measured items | OPT-001–003 and OPT-049–053 hold; `trip:state` 7.5 → 1.6 kB | OPT-004 → **O2-002** (unused members) · OPT-047 → **O2-046** (whole-store subscriptions) · OPT-071 → **O2-066** (write-volume test) · OPT-072 → **O2-061** (bundle-size guard) |
| Trace 1 · Phone | 17 | 17 | — |
| Trace 2 · Headset/Gallery | 15 | 14 (TR2-015 is outside this layer) | — |
| Trace 3 · Transport | 17 | 15, checked live (TR3-015 not re-tested live) | TR3-016 → **L3-002** (one doc line on the join-ack order) |
| Trace 4 · Service | 20 | 18 | TR4-002 (the version check is still unused, now documented) · TR4-020 → **L4-003** (a new race) |
| Trace 5 · Persistence | 23 | 19 | TR5-003 → **L5-003** · TR5-007 → **L5-001** · TR5-015 → **L5-007** · TR5-016 → **L5-008** |

In short, across security and the five trace layers **102 of 116 re-checked round-1 fixes are confirmed** (plus the eight measured optimization fixes). The round-2 findings that go back to a round-1 issue are residual side channels (timing, inference) or edge cases the first fix didn't reach.

---

## Security in brief (17 findings)

- **High (2):** seal timing shows whose seal declined (S2-001); public plan data narrows every share (S2-002).
- **Medium (4):** hail filter oracle (S2-003); debug page labels reversible and open in dev (S2-004); the demo setup serves the repo over the tunnel (S2-005); no global cap on voyages, so a few IPv6 ranges can exhaust memory (S2-006).
- **Low (8):** database lookups before the rate limiter (S2-007); one global pairing bucket can block all headsets (S2-008); first passkey trusted to whoever holds the token (S2-009); retry ignores unreleased card holds (S2-010); some maps never evicted (S2-011); the organizer can still take an absent friend's seat (S2-012); dev key accepted in a query string (S2-013); paid-API budgets are global (S2-014).
- **Info (3):** restrict the map-tiles token at the provider (S2-015); Docker entrypoint should refuse odd data directories (S2-016); a dev-only vitest advisory (S2-017).

## Optimization in brief (69 findings)

- **Leaks:** settled bookings are never evicted (O2-035, High). On the headset, removed crew pieces, the global animation list, still-playing voice clips and XR-only objects outlive their scene (O2-050 to O2-053).
- **Database writes:** each save rewrites a ~12 kB trip document that is 93 % unchanging shortlist; every event is its own insert; one 4-seal booking causes 16 writes (O2-036 to O2-038).
- **Leftovers from the refactors:** a 35-method compatibility facade, re-exports, 16 copies of the same phase guard, 5 copies of a timeout wrapper (the Gemini one never clears its timer), strings that must match but are copied (O2-001, O2-010 to O2-012).
- **Phone:** six screens still re-render on every socket event; the crew-member form and error handling are copy-pasted; the web app hard-codes server limits (O2-015, O2-016, O2-031, O2-046).
- **3D:** per-frame billboard and raycast work, ~15 MB of plain-card canvases, 120–185 draw calls (O2-054 to O2-057).
- **Tests:** four full-voyage tests spend 11.5 s on real pacing; no tests for the sweep, write queue, web hooks or scene logic; no bundle-size guard (O2-061 to O2-069).

## Traceability in brief — from every button to the database and back

| Layer | Checked | Fully correct | Notes |
|---|---|---|---|
| 1 · Phone UI → client net layer | 83 UI elements | 74 (9 work with a defect, 0 broken) | Every REST call and socket emit matches; issues are the passkey cancel, a dead-end saved voyage and small flow edge cases |
| 2 · Headset/Gallery → client net layer | 38 elements | 33 (5 with a defect, 0 broken) | Round-1 dead-input bug fixed live; stale pairing and the off-screen menu remain |
| 3 · Client ⇄ server (REST + sockets) | 19 REST functions · 15 client→server · 18 server→client events | 18 · 12 · 18 | 0 private leaks over 8 live replays; a stale token silently joins as a spectator |
| 4 · Server → domain modules | 66 call edges · 12 state transitions | 54 (10 with a gap, 2 defects) | Units consistent (cents, ms) everywhere; the refund gate can be bypassed; a "sail without them" race |
| 5 · Persistence → MongoDB → restore → replay | 35 write paths · 8 collections · 11 restore cases | Schema and indexes match on Atlas; every status restores | Writes parked in an outage are never retried; reconnect skips passkeys and memory |

---

## How the work is organised

[`TASKS.md`](TASKS.md) turns all 129 distinct findings into **18 work packages** (R2-WP-01 to R2-WP-18) that sub-agents can pick up:

- Each package has a **scope** (the only files it may touch), **dependencies**, a **status** line to claim it, and a checklist of findings with severity, effort (S/M/L) and a pointer to the full detail (`grep -n "### <ID>" docs/review-2/*.md`).
- Packages run in **4 waves** so parallel fixers don't collide:
  - **Wave 1 (Expo-blocking, privacy, payments; parallel):** R2-WP-01 passkey prompt · R2-WP-02 seal timing & payment integrity · R2-WP-03 public plan privacy · R2-WP-04 hail oracle · R2-WP-05 dev/demo exposure
  - **Wave 2 (robustness):** R2-WP-06 persistence · R2-WP-07 headset & Gallery · R2-WP-08 client transport · R2-WP-09 phone UX
  - **Wave 3 (before a public deploy; in order):** R2-WP-10 identity & seats · R2-WP-11 memory bounds · R2-WP-12 rate limits & budgets
  - **Wave 4 (clean-up, performance, tests, docs):** R2-WP-13 server refactor · R2-WP-14 server write volume · R2-WP-15 3D leaks & performance · R2-WP-16 phone clean-up · R2-WP-17 tests & tooling · R2-WP-18 docs sync
- Every package has the same **gates**: typecheck and test both apps, a web build, the Expo script and shares unchanged, the "zero private events to headset/Gallery" test still green, no paid API calls in tests, and no edits to `.env`. Fixers don't commit.

**Already fixed in `e64d877`** (found in the live run, no task): cached voices returning 404 (`/api/audio` under `.cache`), the memory banner repeating "voyage:", the city-tiles 4 s timeout counting wall-clock instead of rendered time, the chart-room help text overlapping the captions, and "Hail the table" being enabled outside the table. None of the reviewer findings is exactly one of these; L2-005 (hail still offered in Watch 3) and L2-001 (menu off-screen) are related but still open.

## Detailed reports

| Report | Contents |
|---|---|
| [security.md](security.md) | 17 findings with exploit scenarios, repros and the round-1 re-check |
| [optimization.md](optimization.md) | 69 findings with measurements (bundle, database writes, timings, 3D budgets) |
| [trace-1-phone.md](trace-1-phone.md) | Every phone button/link → call → server, the return path, and issues |
| [trace-2-xr-gallery.md](trace-2-xr-gallery.md) | Every headset/Gallery interaction → call, the server → scene path |
| [trace-3-transport.md](trace-3-transport.md) | REST, client→server and server→client matrices, live replay orders |
| [trace-4-service.md](trace-4-service.md) | Call graph from the service layer, state-transition table, Expo walk-through |
| [trace-5-persistence.md](trace-5-persistence.md) | Write-path inventory, Atlas schema check, restore per status, failure modes |
| [live-e2e.md](live-e2e.md) | The live Chrome run: LIVE-001 and the five bugs fixed in `e64d877` |
