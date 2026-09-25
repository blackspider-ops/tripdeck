# All Ayes — Review Report

**Reviewed:** commit `befc070`, ~10,500 lines of TypeScript (server, phones, headset/Gallery, shared contract).
**How:** 7 independent read-only reviewers — 1 security expert, 1 optimization reviewer, and 5 traceability reviewers (one per layer, from the UI buttons all the way down to the database and back). Findings were verified by reading the code end to end, running the test suite, or reproducing against the running app.
**Companion files:** [`TASKS.md`](TASKS.md) (the work board for fixers) and the 7 detailed reports in this folder.

---

## Status after fixes (2026-09-25)

**All 17 work packages are done.** Every finding on the task board is fixed, or has a note in [`TASKS.md`](TASKS.md) saying why it was left. The two Critical issues are closed: the public Dry Run data no longer lets anyone work out a member's share (WP-02), and every pinch and click works on the headset and in the laptop view (WP-01).

**Commits** (`git log --oneline 9fde3b3^..HEAD`, oldest last):

| Commit | What |
|---|---|
| *(final, uncommitted)* | WP-17 docs sync; leftovers: debug page shows needs-attention and the seal deadline, phone copy for `SEAL_LOCKED` / `TOO_MANY_RUNS`, `DRAFT` status removed, one backing tally in the negotiation rules, write-only fields dropped, `serverNow` on `booking:created` |
| `7e6c034` | WP-14: server refactor (TripService split into `trips/*` modules), SEAL_LOCKED, TOO_MANY_RUNS, hydrate on join, audio keys on turns |
| `b68ead5` | WP-16: web tests (26 → 50), dead code, TripShell split, web follow-ups |
| `800ee5b` | Wave 3: WP-07 abuse limits, WP-08 production hardening, WP-09 typed contract, WP-10 persistence, WP-11 file stores, WP-13 invite reissue; e2e seal-order race fixed |
| `7df4a54` | WP-13: phone UX fixes |
| `b039baf` | WP-06: identity, sessions and seats |
| `566d2c8` | WP-15: 3D performance and scene refactor |
| `2eebec3` | Wave 2a: WP-03 live state and replay, WP-04 payment and seal integrity, WP-12 privacy filter |
| `9fde3b3` | Wave 1: WP-01 headset input, WP-02 public-plan privacy, WP-05 passkeys |

**Tests.** `npm test` runs both suites: **server 305 tests in 27 files**, **web 52 tests in 12 files**, all passing. Server and web `tsc --noEmit` are clean and the production build succeeds. At review time there were 73 server tests and no web tests.

### Still open / needs outside help
Nothing below blocks the Expo demo. These need credentials, hardware, a real deploy, or a product decision.

**Needs outside help or real hardware**
- **Visa Intelligent Commerce:** payments run in a labelled simulation until Visa sandbox credentials arrive and `payments/visaVic.ts` is wired. `PAYMENTS_MODE=visa_sandbox` falls back to the simulation with a warning.
- **A real Quest 3:** immersive entry, table placement and anchors, hand input, 72 fps and in-headset text size have only been checked in the laptop view and the emulator.
- **Docker:** ✅ verified 2026-09-25. The image builds (Colima), runs as the non-root `node` user in production mode, refuses `/demo/seed` without the dev key (403), sends the security headers, returns a JSON 404 for unknown `/api/*`, and ran a full Expo voyage over the wire: shortlist MEX → LIS, shares $1,038 / $868, booking CAPTURED, 0 private events on the headset and Gallery.
- **Render disk:** if the mounted `/var/data` is owned by root, the `node` user can't write to it and local memory falls back to RAM. After the first deploy, check that `/api/health` says `degraded: false`.

**Not verified end to end**
- The HTTP long-polling fallback hasn't been tested with WebSockets actually blocked.
- The BOOKED ceremony (twine and reference tag) was only typechecked, not seen live. The globe clearing after a full voided → new terms cycle wasn't run live either.
- Spend-cap counters live in memory, so a restart resets them.

**Known trade-offs (accepted for now)**
- **Absent-friend invites:** an organizer who clears their browser, or uses a different one, can still open a friend's invite before the friend does. Closing that gap needs out-of-band delivery (email or SMS).
- **What public data still shows:** the public Dry Run schedule still lists which "pick" activities exist. In a small crew, the number of people going to each pick may be guessable. Who goes is never shown.
- **What seal timing still shows:** lifting a seal while it's still pending looks the same as not having tapped yet. If an absent member's standing seal is declined before anyone else taps, it was the only seal ever set, so the timing gives it away.
- **Passkeys:** a member can register only one passkey per address. Adding a second one would need approval from the first.
- **Sessions:** member tokens don't expire on the server, and there's no "leave this phone" action. Joins don't need organizer approval (the organizer can close the crew instead). The headset code isn't combined with the join code.
- **Versions:** clients don't send an expected version with their actions. The server re-checks the voyage's phase instead.
- **MongoDB:** production keeps running without MongoDB (it logs an error and reports `degraded`). Join-code uniqueness is checked in memory, so an archived voyage's code could collide (about 1 in 10⁹).

**Small follow-ups (nice to have)**
- Globe pencil arcs are one draw call each, and 3D text labels aren't batched.
- The "sail without them" timer is kept per device. A server join time would let it survive a device change.
- Memory is shown by parsing the stored memory text. Structured memory from the server would be sturdier.
- Web hook tests (`useSendGuard`, `useTwoTap`) need a DOM test environment.
- Some constants are still duplicated: the Gallery's status labels, the phone's `HAIL_MAX_CHARS` (160), and the server's date-label helper.
- The debug log stores members by name, and the debug page maps them to `crew-xxxxxx`. `/api/debug` doesn't load archived voyages.
- No profanity filter on spoken lines. The design's "queued for next phase" hails aren't built: a late hail is refused and the words stay in the box.
- No per-code pairing attempt counter and no countdown on the pair page. A per-address limit applies instead.

---

## The bottom line (at review time)

The app works end to end and most of its wiring is correct: the contract between phones, headset, Gallery and server matches almost everywhere, the maths is right to the cent, and the headset and Gallery never receive a private event. **But two things break the product's core promises, and should be fixed before anyone else sees it:**

1. **Budgets aren't actually private (Critical).** The public Dry Run data includes each person's own schedule (when they land, which activities they attend). Combine that with the public prices and anyone who has the join code — even an anonymous Gallery viewer — can work out every member's exact share to the cent. The security reviewer did it for 6 of 6 members.
2. **The headset can't be used (Critical).** Every pinch and click on 3D objects — the Captain's "Weigh anchor", lifting a dome to pick a chart, the hail card, the clock, "Back to the charts", every menu item — does nothing, on the Quest and in the laptop view. It's a two-line bug in the input code.

After those, there's a cluster of **High** issues that matter for a live demo (a lost invite link, passkey lock-outs, a trip stuck at checkout after a restart) and another cluster that only matters once it's **deployed publicly** (spend limits, spoofable rate limits, production gating, security headers).

---

## Scoreboard

| Area | Critical | High | Medium | Low | Info | Total |
|---|---|---|---|---|---|---|
| Security | 1 | 5 | 10 | 9 | 2 | 27 |
| Optimization | — | 6 | 22 | 45 | — | 73 |
| Trace 1 · Phone UI → client | — | 1 | 4 | 12 | — | 17 |
| Trace 2 · Headset/Gallery → client | 1 | 1 | 4 | 9 | — | 15 |
| Trace 3 · Client ⇄ server contract | — | 1 | 3 | 13 | — | 17 |
| Trace 4 · Server → domain modules | — | — | 6 | 14 | — | 20 |
| Trace 5 · Persistence → MongoDB → back | — | 3 | 6 | 14 | — | 23 |
| **All findings** | **2** | **17** | **55** | **116** | **2** | **192** |
| **After merging duplicates** | **2** | **16** | **45** | **92** | **1** | **156 tasks** |

Several problems were found independently by more than one reviewer. The Watch indicator bug was found by **four** — that's a strong signal it's real. Merging these leaves 156 distinct things to fix, grouped into 17 work packages.

---

## Fix these first

| # | What's wrong (plain language) | Why it matters | Severity | Work package |
|---|---|---|---|---|
| 1 | Anyone with the join code can compute every member's share from public schedule data | Breaks the "nobody sees your budget" promise — the whole pitch | Critical | WP-02 |
| 2 | No 3D control responds to a pinch or click | The headset demo (the AR/VR track entry) can't be driven | Critical | WP-01 |
| 3 | Adding an absent friend as the 4th crew member loses their invite link forever | That friend can never join, so the table can never start | High | WP-13 |
| 4 | Passkeys: the "do I have one?" check looks at a different web address than sealing does, and passkeys are forgotten on restart | Members get locked out of sealing on a tunnel; after a restart, sealing silently drops back to a plain tap | High | WP-05 |
| 5 | The order of seal updates still hints at whose payment failed | Leaks exactly what the design says must stay private | High | WP-04 |
| 6 | A restart at the wrong moment leaves a trip stuck at checkout forever, or crashes the server on boot | A crash-loop on the hosting platform; a crew charged while the screen says "sealing" | High | WP-04, WP-10 |
| 7 | Memories are keyed on name + home airport | Anyone can join as "Maya from ORD" and read or poison the real Maya's history | High | WP-06 |
| 8 | Demo "open as" links (`?as=`) work in production | Someone can take over another member's seat on a phone | High | WP-06 |
| 9 | No caps on paid APIs, and 5 MB uploads are read before checking who's sending | Someone can run up ElevenLabs/Gemini bills or crash the server's memory | High | WP-07 |
| 10 | The Watch indicator (1/3, 2/3, 3/3) never moves on the headset and Gallery | Visible on stage; also shows the socket contract isn't type-checked, which is how this slipped through | High | WP-03, WP-09 |

**Suggested cut for Expo day:** WP-01, WP-02, WP-05, the invite-link fix in WP-13, the Watch fix in WP-03 and SEC-002 in WP-04. Everything in WP-06, WP-07, WP-08 and WP-10 should land before a public deploy at `allayes.tech`.

---

## What's solid (verified, no action needed)

- **Contract wiring:** every REST call from the phone matches the server route (paths, methods, body fields, auth header, responses). All 8 socket events the phone sends and all server events are handled.
- **Money:** all cents↔dollars conversions are correct; the Expo numbers (Lisbon $2,869 with shares $1,038 / $868 / $963; Mexico City $1,975) match the docs exactly.
- **Private events:** across full live voyages, the headset and Gallery sockets received **zero** private events, and the headset only sends what its device token is allowed to.
- **Classic web security:** no XSS, no NoSQL injection, no prototype pollution, no path traversal, tokens can't be used on another trip, the privacy filter's regexes are safe from slow-regex attacks, and `npm audit` finds no known vulnerabilities in production dependencies.
- **Prompt injection is contained:** a member can only steer their own mate, and prompts never contain exact dollar amounts, so one member can't make another's mate leak a budget.
- **Performance where it counts:** building all trip plans takes ~1 ms, the state snapshot ~1 µs, and phones never download the 3D library.

---

## Security in brief (27 findings)

- **Critical (1):** share reconstruction from public plan data (SEC-001).
- **High (5):** whose-seal-failed inference; memory identity collision; `?as=` session takeover and organizer pre-claiming an absent seat; no spend limits on paid APIs; unauthenticated 5 MB bodies buffered before auth.
- **Medium (10):** spoofable/missing rate limits (join codes and pairing codes can be guessed); passkeys optional, lost on restart, first-come; standing payment approvals renewed on every restart; join code gives instant membership; bookings can hang in "sealing" forever with no abort; no security headers; production safety depends only on `NODE_ENV` (the documented Docker path turns it off); anyone can flood the debug log; unbounded memory/disk growth; capture-failure path "voids" captured money instead of refunding.
- **Low / Info (11):** privacy-filter edge cases for hails, 30-bit pairing codes, tokens in localStorage and URLs, 500s on bad input, container runs as root with dev dependencies, public health endpoint over-shares, source maps shipped, dev key in query strings, permissive socket CORS.

## Optimization in brief (73 findings)

- **Dead code:** unused exports, an unreachable `DRAFT` status, an unused `/api/cities` while the Create screen hard-codes ports, a no-op `xr:placed` round trip, redundant events.
- **Duplication:** privacy context built in three places; date formatting in six; the microphone recorder copy-pasted between hail and voice note; two voice playback stacks; seat geometry, labels, tallies and lookups repeated.
- **Size:** `TripService` is 596 lines doing nine jobs; `buildPlan`, `SceneDirector` and the Dry Run dome constructor are too long.
- **Performance:** memory recall hits disk/network on every reconnect; headset textures are ~45 MB painted on the main thread; `trip:state` re-sends the whole shortlist (87% of its 7.5 KB); every phone component re-renders on every socket event; whole-document database writes per mutation.
- **Bundle:** the 3D chunk (774 kB) is mostly three.js and already only loads on headset/Gallery; smaller wins from separating vendor code, self-hosting fonts, and lazy-loading QR and passkey libraries.
- **Tests:** the web app has none; a contract test would have caught the Watch bug.

## Traceability in brief — from every button to the database and back

| Layer | Checked | Fully correct | Notes |
|---|---|---|---|
| 1 · Phone UI → client net layer | 70 UI elements | 55 | REST and socket calls all match; issues are flow/UX edge cases |
| 2 · Headset/Gallery → client net layer | 38 elements | 19 | 17 of the rest are the single dead-input bug |
| 3 · Client ⇄ server (REST + sockets) | 19 REST routes · 13 client→server · 18 server→client | 16 · 11 · 13 | Passkey origin mismatch; Watch dropped; booking result not replayed |
| 4 · Server → domain modules | 83 calls/callbacks | 48 | No unit or ID mix-ups; state-machine gaps; removed members can still act |
| 5 · Persistence → MongoDB → restore → replay | 39 mutations · 6 collections | 16 · 1 | Unordered fire-and-forget writes; restore edge cases; ephemeral disk on deploy |

---

## How the work is organised

[`TASKS.md`](TASKS.md) turns all 156 distinct findings into **17 work packages** that sub-agents can pick up:

- Each package has a **scope** (the only folders/files it may touch), **dependencies**, a **status** line to claim it, and a checklist of findings with severity, effort (S/M/L) and a pointer to the full detail (`grep -n "### <ID>" docs/review/*.md`).
- Packages run in **4 waves** so parallel fixers don't collide:
  - **Wave 1 (Critical/High, parallel):** WP-01 headset input · WP-02 public-plan privacy · WP-05 passkeys
  - **Wave 2:** WP-03 live state & replay · WP-04 payments & seals · WP-06 identity & sessions · WP-07 abuse limits
  - **Wave 3:** WP-08 production hardening · WP-09 typed contract & errors · WP-10 persistence · WP-11 file stores & test isolation · WP-12 privacy filter & negotiation · WP-13 phone UX
  - **Wave 4 (refactors, after everything else merges):** WP-14 server refactor · WP-15 3D performance · WP-16 web tests & dead code · WP-17 docs sync
- Every package has the same **gates**: typecheck both apps, all server tests, a web build, the Expo script unchanged, and the "zero private events to headset/Gallery" test still green.

## Detailed reports

| Report | Contents |
|---|---|
| [security.md](security.md) | 27 findings with exploit scenarios and repros |
| [optimization.md](optimization.md) | 73 findings with measurements (bundle, payload sizes, timings) |
| [trace-1-phone.md](trace-1-phone.md) | Inventory of every phone button/link → call, plus issues |
| [trace-2-xr-gallery.md](trace-2-xr-gallery.md) | Every headset/Gallery interaction → call, return-path field check |
| [trace-3-transport.md](trace-3-transport.md) | REST, client→server and server→client matrices |
| [trace-4-service.md](trace-4-service.md) | Call graph from the service layer, state-transition table, Expo walk-through |
| [trace-5-persistence.md](trace-5-persistence.md) | Write-path inventory, schema check, restore behaviour per status |
