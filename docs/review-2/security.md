# All Ayes: security review, round 2 (commit 0430ef9)

Reviewer: AppSec audit, read-only, round 2. The current code was reviewed from scratch: every REST route, every socket event, the trips/* modules, payments, passkeys, privacy filter, persistence, limits, web.ts, config, the Docker entrypoint and the web client's credential handling. Every finding below was checked by reading the code path end to end or by a repro. Repros ran against an in-process `TripService` (scratchpad `r2-sec/share-infer.mts`, `share-infer-cheap.mts`, `seal-timing.mts`, `hail-oracle.mts`, `tripmem.mts`) or against the live dev helm on :8787 and Vite on :5173 (curl, `seed.json`, `debug.html`). No paid model or voice call was triggered, and no repo file other than this report was modified. One demo voyage (`HFRPTZ`) was seeded on the running dev helm. Server tests: 29 files, 308 tests pass. `npm audit --omit=dev`: 0 vulnerabilities.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 4 |
| Low | 8 |
| Info | 3 |
| **Total** | **17** |

## Executive summary
1. **"Nobody learns whose seal failed" is still broken, this time by timing.** Public seal statuses no longer carry the outcome. But a decline voids the booking about one provider round trip (~0.6 to 1.2 s) after the decliner's seal turns "set". When an absent member's standing seal declines, the void lands about 0.8 s after `booking:created`, before any live member has tapped. The Gallery sees exactly who it was (S2-001).
2. **The public plan still pins down each member's share.** Exact reconstruction (round-1 SEC-001) is fixed. Brute-forcing the open-source plan builder against public data (the `table:decided` schedule, `groupCents`, public crew origins and the dataset) still narrows every share to 1 to 6 values, about $60 apart. The organizer's share comes out exact in half the plans. When the cheapest-flight assumption fails, that also shows someone has a flight dealbreaker (S2-002).
3. **The hail filter is an oracle again.** A hail like `9 $5000 0 0` is stripped to `9 0 0`, and the post-strip check then reads it as 900. The hail is refused only if a secret cap, share or headroom lies within ±5 % of 900. Refused probes don't count toward any hail limit (S2-003). Anyone who reads the join code off a Gallery URL can join an open crew and probe.
4. **The dev and demo setup leaks.** The debug view's `crew-xxxxxx` redaction is an unsalted hash of the public memberId, so anyone can reverse it. In dev mode the page is open to anyone who has a join code (S2-004). The documented setup (`npm run dev`, which runs `vite --host`, plus a cloudflared tunnel) also serves the whole repo over `/@fs/`, including `apps/server/data/memory.json`, along with the open seed, debug and health routes (S2-005).
5. **Resource limits hold per address but have no global cap.** A /48 of IPv6 space is enough to create voyages until a 512 MB instance runs out of memory (50k voyages ≈ 426 MB RSS) (S2-006). Unauthenticated `/api/trips/:id/*` paths query MongoDB before any limiter runs (S2-007). One global bucket of pairing failures lets a few addresses stop every headset from pairing (S2-008). Most other round-1 fixes check out: auth on every route and event, tokens and handoffs, headers, CORS, production gating, the privilege drop and the refund paths (see "Verified non-issues").

---

## Critical

(none)

---

## High

### S2-001 — Seal timing and ordering still reveal whose seal declined (standing seals: immediately)
- Severity: High
- Location: apps/server/src/payments/orchestrator.ts:134-141 (`startStanding` authorizes absent seals at once), 264-298 (`startSeal`: public "set" at 270, provider round trip at 274-277), 300-309 (`decline` → `voidAll` straight away), 341-353 (`voidAll` announces every seal VOIDED together), 212-219 (`toPublic` exposes `standing`); apps/server/src/trips/sealing.ts:36-38 (`booking:created`, then `startStanding`)
- Evidence: the SEC-002 fix hides *what* happened to each seal but not *when*. A seal becomes publicly AUTHORIZED ("set") as soon as its member taps. The provider answers ~0.6 to 1.2 s later, and a decline voids the whole booking right then. Repro `r2-sec/seal-timing.mts` records the trip-room (Gallery) stream:
  ```
  three live members (decliner: Maya)          absent Dev with a standing instruction (decliner: Dev)
     27 booking:created standing: none             12 booking:created standing: Dev
   3030 seal:status Rae AUTHORIZED                 12 seal:status Dev AUTHORIZED
   6031 seal:status Maya AUTHORIZED               803 seal:status Rae/Maya/Dev VOIDED
   6969 seal:status Rae/Maya/Dev VOIDED           803 booking:result VOIDED "One share didn't clear…"
   6970 booking:result VOIDED "One share didn't clear…"
  ```
- Exploit / impact: anyone in the trip room (Gallery, headset, other members) attributes a decline to the member whose seal was set just before the void. With a standing seal the attribution is certain: the void arrives ~0.8 s after `booking:created`, when only the absent member (`standing: true`) has a seal set. The decline reason for a plan that was fitted to caps is almost always `over_limit` (the limit is `min(cap, share×1.02)`). So this reveals that the named member's cap is below their share, and S2-002 gives an estimate of that share. A member who lifts their seal (`user_cancelled`) is exposed the same way. This breaks doc 06 §7 and the product promise.
- Fix: decouple authorization from the public tap. Option A: collect every member's instruction first ("set" = instruction created), then authorize all seals together once the last one is set, or at the deadline, and settle with a single `booking:result`. Every decline then lands at the same moment. Option B: never void mid-gathering. Hold the result and publish the void only at a fixed time: when every seal is set, or at the deadline. Either way, standing seals must not authorize before the live seals. Add random jitter, or a fixed floor of a few seconds, between the last "set" and `booking:result`.
- Effort: M
- Scope (dirs a fixer may touch): apps/server/src/payments, apps/server/src/trips, packages/shared/src, apps/server/test
- Acceptance: a test in apps/server/test/seal-integrity.test.ts runs 3 members, one of them absent with a standing seal, in two worlds: each seal in turn made to decline. The test records the trip-room `seal:status`/`booking:result` sequences with timestamps. Assert that the sequences are identical across worlds and that the gap between the last public "set" and `booking:result` doesn't depend on which member declined (for example, the result always arrives at the all-set or deadline boundary).

### S2-002 — Public plan + public crew data still narrow every share to a handful of values (exact for the organizer in half the plans)
- Severity: High
- Location: apps/server/src/fit/pricing.ts:291-327 (`publicDays`/`toPublic`: pick items with exact `startMin`/`endMin`, `groupCents`), 96-112 (`arrivalsFor`: a pick's day-1 start = max landing time of its attendees, rounded), 52-66 (`chooseFlight`: cheapest from the public origin unless dealbreakers), 128-156 (`placePicks`); apps/server/src/trips/core.ts:210-212 (`crewPublic` publishes `origin` and `role`); packages/shared/src/types.ts:122-129
- Evidence: repro `r2-sec/share-infer.mts` models a stronger attacker than the round-1 test's `candidateShares`. For each member it enumerates every flight from their public origin and every set of ≤ 2 picks, reruns the open-source builder (`arrivalsFor` → `placeGroupMoments` → pick placement → `legsAndFlags` → `memberView`), and keeps only the worlds whose `publicDays` equal the observed schedule and whose total equals the public `groupCents`. On the Expo crew's top 6 charts:
  ```
  MEX-W1-roma-flat  32 worlds  shares [[68900,70800,68300],[62300,…,65800],[66300,…,63400]]  truth [70800,59800,66900]
  YUL-W1-mile-end    3 worlds  shares [[55000],[55000,52000],[45400,48400]]                  truth [55000,55000,45400]
  YUL-W1-old-mtl     3 worlds  shares [[69000],[69000,66000],[59400,62400]]                  truth [69000,69000,59400]
  YUL-W1-plateau     3 worlds  shares [[59668],[59666,56666],[50066,53066]]                  truth [59668,59666,50066]
  ```
  Every share is narrowed to 1 to 6 candidates within ~$60, and 3 of 18 are exact (the organizer's, each in the YUL plans). With the "cheapest flight" prior (`share-infer-cheap.mts`), the MEX charts have **no** consistent world, which tells the attacker someone has a flight dealbreaker (Dev's `layovers_2plus`). The consistent worlds also say which picks each member attends, so their must-have tags leak too.
- Exploit / impact: a token-less Gallery socket (or anyone with the code) gets `table:decided` and `trip:state` and can compute each member's share to within tens of dollars. Add the public "past what my friend can do" lines, `fitsEveryone`, and S2-001, and caps get bounded as well. The residual signal comes from: exact pick start times (each is determined by the attendees' landing times), a public `groupCents` that constrains the total, and flights that are determined by the public origin.
- Fix: remove the timing channel and the sum constraint from the public view. (1) Publish pick moments without exact times, or only group moments plus an anonymous count of "free time" slots. The Dry Run scene can animate picks from a server-quantised script (e.g. whole hours or dayparts) that is not a function of arrivals. (2) Drop `origin` from `CrewPublic`, or publish only a coarse region, since it pins each member's flight price. (3) Treat `groupCents` as a coarse band in public (it is also used in spoken lines, so round it before the filter's allow-list). Keep exact values in `plan:private` only.
- Effort: L
- Scope (dirs a fixer may touch): apps/server/src/fit, apps/server/src/trips, apps/server/src/negotiation, apps/server/src/privacy, packages/shared/src, apps/web/src/scene, apps/web/src/phone, apps/web/src/gallery, apps/server/test
- Acceptance: port `share-infer.mts` into apps/server/test/plan-privacy.test.ts. For every plan in the Expo chart book and 20 random 2- to 4-person crews, assert that the attack leaves each member at least N distinct share candidates, spanning at least $X (e.g. N ≥ 8 and a span ≥ $150), and that no share is determined uniquely.

---

## Medium

### S2-003 — Hail filter oracle: amounts assembled by the stripper are then tested against secrets (refusal = "a secret is near X")
- Severity: Medium
- Location: apps/server/src/privacy/guard.ts:39-46 (`sanitizeHail`: strip, then `filterLine(text).leak` → null); apps/server/src/privacy/filter.ts:98-101 (spelled-digit reader `9 0 0` → 900), 212-217 (leak rule); apps/server/src/trips/table.ts:235-237 (a refused hail throws `HAIL_AMOUNTS` before `lastHailAt` is stamped); apps/server/src/realtime/io.ts:162-169
- Evidence: `stripAmounts` removes `$5000` from `lets go 9 $5000 0 0 somewhere nice`, which leaves `9 0 0`. The re-check reads that as 900, so the result depends on the secrets. Repro `r2-sec/hail-oracle.mts`:
  ```
  "lets go 9 $5000 0 0 somewhere nice" | secret=900 → REFUSED | secret=2500 → "lets go 9 0 0 somewhere nice"
  ```
  One hail can pack several probes (160 chars ≈ 8 values). A refusal consumes nothing: no pending hail, no 5 s stamp. Only the per-socket budget of 60 events per 10 s applies, and each member may open many sockets.
- Exploit / impact: during AT_TABLE, any member runs an adaptive group test over $20 to $3,000 in 5 % steps. Refused probes are free, and each accepted probe costs one watch. That locates other members' caps, shares and headroom to ±5 %. The join code sits in every Gallery URL (`/t/<CODE>/gallery`) and crews are open by default (SEC-010), so an outsider can join in BRIEFING and then probe. Accepted hails also carry non-public numbers (`9 0 0`) into the public room, which breaks the guard's own "no amount except exact public ones" rule.
- Fix: make hail sanitisation independent of secrets. After stripping, remove every remaining digit or number-word run whose reading is ≥ 20 and not public (repeat to a fixpoint, or collapse the digit runs and re-strip). Then accept or refuse based only on the word count, never on `filterLine(...).leak`. Also count refused hails toward `HAIL_MIN_INTERVAL_MS` and cap refusals per member per watch.
- Effort: S
- Scope (dirs a fixer may touch): apps/server/src/privacy, apps/server/src/trips, apps/server/test
- Acceptance: extend apps/server/test/privacy-bypass.test.ts. For a corpus that includes `9 $5000 0 0`, `nine $5 hundred`, `1 $7 0 0 0` and zero-width variants, assert that `sanitizeHail(p, ctx(secret))` returns the same result (same text, or both null) for secret ∈ {900, 1000, 2500}, and that the output has no non-public amount according to `extractAmounts`. Also assert that 3 refused hails in 1 s get `SLOW_DOWN`.

### S2-004 — Debug view "redaction" is reversible and, in dev mode, open to anyone holding a join code
- Severity: Medium
- Location: apps/server/src/api/devAccess.ts:75 (`redactRef = "crew-" + sha256(memberId).slice(0,6)`), 41-45 (`devAllowed` returns true in dev mode); apps/server/src/api/debug.ts:17-28, 46 (per-seal `status` incl. DECLINED, instruction/auth refs), 41-42 (event log audiences, e.g. `seal:declinedPrivate` → `member:crew-…`), 61-67 (accepts a join code); apps/server/src/trips/core.ts:62-64, 79-82
- Evidence: memberIds are public (`trip:state.crew`, `GET /api/trips/by-code/:code`). Live check on :8787 (dev mode via `npm run dev`): seeded voyage `HFRPTZ`, then `curl /api/trips/by-code/HFRPTZ` and `curl /api/debug/HFRPTZ` (no key, no cookie). Recomputing `sha256(memberId)` matched every `crew-xxxxxx` on the page: `Rae → crew-435d5f`, `Maya → crew-7fa5a4`, `Dev → crew-436b43`, all present. The seal list shows `crew-…: DECLINED`, and the log shows which `member:crew-…` received `seal:declinedPrivate`.
- Exploit / impact: in the documented demo setup (dev helm behind a cloudflared tunnel, README.md:21, docs/09 §154), anyone with the tunnel URL and a join code (both appear in the Gallery URL) opens `/api/debug/<CODE>` and reads, by name, whose seal declined, when, and which refs were issued. In production the page is behind DEV_KEY. But whoever holds the key (often the organizer at a demo) can still de-anonymise it.
- Fix: salt the reference with the per-process secret (`HMAC(SECRET, tripId|memberId)`). Collapse DECLINED to VOIDED in the seal list, drop the audience for `seal:declinedPrivate` (log it as `member:*`), and never render instruction or auth refs. Require DEV_KEY for `/api/debug` even in dev mode whenever the request arrives through a proxy or tunnel (Host not loopback), or simply always.
- Effort: S
- Scope (dirs a fixer may touch): apps/server/src/api, apps/server/src/trips, apps/server/test
- Acceptance: a test drives a declined booking and fetches `/api/debug/:code` (dev mode). Assert that no `sha256(memberId).slice(0,6)` of any crew member appears, that the page has no `DECLINED` and no `sim_auth_`/`sim_ins_`, and that a request with `Host: x.trycloudflare.com` and no key gets 403.

### S2-005 — The documented dev/demo topology publishes the repo (`vite --host` `/@fs/`) and the dev-open API through the tunnel
- Severity: Medium
- Location: apps/web/package.json:7 (`"dev": "vite --host"`); apps/web/vite.config.ts:19-33 (`allowedHosts` incl. `.trycloudflare.com`, no `server.fs.allow`/extra `fs.deny`, `/api` proxied to the helm); apps/server/src/config.ts:47 (`npm_lifecycle_event === "dev"` ⇒ dev mode); README.md:21, docs/04:525, docs/09:154 (Quest via `cloudflared tunnel --url http://localhost:5173`)
- Evidence: live on :5173 (LAN-bound, 10.90.158.88), `GET /@fs/<repo>/…` returned `package.json` 200, `apps/server/src/config.ts` 200, `docs/review/security.md` 200, and `apps/server/data/memory.json` 200. That file holds 20 memory threads keyed `crew:<hash>|<name>`, with 21 budget-band lines. `.env` returned 403, because Vite's default deny list still works. Through the same origin, `/api/demo/seed`, `/api/debug/*` and the full `/api/health` answer without a key, because `npm run dev` switches the helm into dev mode.
- Exploit / impact: during a demo, anyone on the venue Wi-Fi or with the tunnel URL can download the local memory store (names, past trips, budget bands), the source, and any review docs or scratch files under the repo. They can also seed voyages, which spends Backboard calls, and read the debug view (S2-004).
- Fix: in vite.config.ts set `server.fs.allow` to `apps/web` and `packages/shared` only, and add `**/data/**`, `**/.cache/**` and `docs/**` to `server.fs.deny`. Make `--host` opt-in (`dev:lan`). Document that a tunnel should point at a production-mode build (`SERVE_WEB=1 npm run start:prod` with `PUBLIC_BASE_URL` = the tunnel URL and a DEV_KEY), not at `npm run dev`. Also make the helm refuse dev-mode dev routes when the request's Host isn't loopback or LAN (see S2-004).
- Effort: S
- Scope (dirs a fixer may touch): apps/web/vite.config.ts, apps/web/package.json, apps/server/src/api, apps/server/src/config.ts, README.md, DEPLOY.md, docs
- Acceptance: with `npm run dev` running, `curl http://<lan-ip>:5173/@fs/<repo>/apps/server/data/memory.json` and `/@fs/<repo>/package.json` both return 403, the app still loads, and `curl -H 'Host: a.trycloudflare.com' :8787/api/debug/<code>` returns 403.

### S2-006 — No global cap on voyages or seats: a handful of IPv6 /64s can exhaust memory (and Atlas)
- Severity: Medium
- Location: apps/server/src/api/routes.ts:44, 46, 72-81, 100-105 (per-address only: 10 creates, 20 joins/min); apps/server/src/util/limits.ts:113-125 (key = /64); apps/server/src/trips/core.ts:225-245 (BRIEFING voyages live `VOYAGE_IDLE_HOURS`=48 h); apps/server/src/config.ts:113
- Evidence: repro `r2-sec/tripmem.mts` created 50,000 voyages with 4 seats each: `trips 50000 members 200000 rss 426` MB, heap +126 MB (≈2.5 KB per voyage). Each voyage is also persisted (trip and 4 member docs). One address gets 14,400 voyages per day. A single cloud VM with a routed /56 or /48 has 256 to 65,536 /64s, which is 256 × 10 = 2,560 voyages per minute. Nothing caps the total, and idle voyages stay 48 h.
- Exploit / impact: in under an hour the 512 MB Render starter runs out of memory, and every live voyage, including those mid-SEALING, restarts. That voids their bookings (`REASONS.restarted`). MongoDB (M0: 512 MB) fills up, and persistence degrades for everyone.
- Fix: add global ceilings, e.g. `MAX_LIVE_VOYAGES` (refuse creates with 503 past it) and a global create rate. Evict unsealed BRIEFING voyages with ≤ 1 member after ~1 h. Add a per-/48 bucket next to the per-/64 one. Keep the creator's IP out of storage.
- Effort: M
- Scope (dirs a fixer may touch): apps/server/src/api, apps/server/src/util, apps/server/src/trips, apps/server/src/config.ts, apps/server/test
- Acceptance: a test in limits.test.ts sets `MAX_LIVE_VOYAGES=100` and creates voyages from 50 distinct /64s. Assert that creation beyond 100 is refused (503) and that a 1-member idle voyage is swept after the short TTL.

---

## Low

### S2-007 — Unauthenticated MongoDB lookups on every `/api/trips/:tripId/*` request, before any limiter
- Severity: Low
- Location: apps/server/src/api/routes.ts:95-98 (`r.use("/trips/:tripId", …hydrate)` runs before each route's limiter); apps/server/src/trips/persistence.ts:55-75, 39-45; apps/server/src/trips/records.ts:123-124 (`HYDRATE_MISS_MAX`=1000, then the whole miss cache is cleared)
- Evidence: any path under `/api/trips/<random>/…` (e.g. `POST …/headset-code`, `GET …/passkey`) calls `hydrate({tripId})` → `loadWhere("trips", {_id})`. The passkey limiter is mounted after this middleware. Cycling more than 1,000 distinct random ids clears the miss cache, so repeats hit the database again.
- Exploit / impact: requests at line rate turn into Atlas queries 1:1 (M0 allows ~100 ops/s), which degrades persistence for every voyage. Each lookup is cheap (an `_id` index hit), so the effect is throttling, not a crash.
- Fix: run one per-address limiter on the `/trips/:tripId` middleware before `hydrate` (count misses only, like `lookupMiss`). Make the miss cache an `Lru` rather than clear-on-overflow.
- Effort: S
- Scope (dirs a fixer may touch): apps/server/src/api, apps/server/src/trips, apps/server/test
- Acceptance: with a stubbed `loadWhere` counter, 200 requests to random trip ids from one address produce at most the miss-limit number of DB calls. Then `SLOW_DOWN` follows.

### S2-008 — One global bucket of wrong pairing codes lets a few addresses block all headset pairing
- Severity: Low
- Location: apps/server/src/api/routes.ts:49 (`pairFailAll` 300/min, key `"*"`), 138-141
- Evidence: `failures([[pairFail, ip], [pairFailAll, "*"]])` refuses every caller while the global bucket is full. Each /64 may make 10 wrong guesses a minute, so 30 /64s keep it full indefinitely.
- Exploit / impact: during the demo, nobody can pair a headset ("Too many headset codes tried"). No confidentiality impact: 40-bit codes, 10 min TTL, single use.
- Fix: scale the global cap with the number of pending codes, or drop it and rely on the 40-bit space plus per-/64 and per-/48 limits. Or give the organizer's phone a pairing path that doesn't count toward it (e.g. the organizer shows a QR code that carries a 128-bit one-time secret).
- Effort: S
- Scope (dirs a fixer may touch): apps/server/src/api, apps/server/src/trips, apps/web/src/xr, apps/server/test
- Acceptance: a test makes 300 wrong `/xr/pair` calls from 30 /64s, then a correct code from a fresh address pairs successfully.

### S2-009 — Passkey registration is trust-on-first-use by whoever holds the member token; a leaked token can permanently block that member's seal
- Severity: Low
- Location: apps/server/src/passkeys/passkeys.ts:126-132 (never replaced), 157-168; apps/server/src/api/passkeyRoutes.ts:47-60; apps/server/src/trips/sealing.ts:75-78 (gate required once any passkey exists)
- Evidence: registration needs only the bearer token. The first credential for a member can never be replaced (`PASSKEY_EXISTS`), and once one exists `setSeal` demands an assertion.
- Exploit / impact: someone who briefly holds a member's token (shared phone, a screenshot of a demo handoff, an XSS) registers their own authenticator. The real member can then never set their seal, and every booking fails at the deadline. The step-up gives no protection before registration, and only the attacker controls it after.
- Fix: make first registration require something the token alone doesn't give: registration only from the device that claimed the seat (bind it to a server-side session nonce minted at join or claim), or organizer confirmation. Provide a recovery path (organizer reset plus re-claim) that voids and reissues the member token.
- Effort: M
- Scope (dirs a fixer may touch): apps/server/src/passkeys, apps/server/src/api, apps/server/src/trips, apps/web/src/phone, apps/server/test
- Acceptance: a test shows that registering with only the member token (no claim nonce) is refused, and that an organizer reset lets the rightful member register and seal.

### S2-010 — Retry isn't blocked by unreleased holds, and `void → {ok:false}` counts as released
- Severity: Low
- Location: apps/server/src/trips/sealing.ts:110-128 (`retry` checks only `owesRefund`); apps/server/src/payments/orchestrator.ts:198 (`owesRefund` = captured and not refunded), 315-326 (`release` treats any answer, including `{ok:false}`, as released); apps/server/src/api/debug.ts:51 (says "retry is blocked until it clears")
- Evidence: a `release` that throws sets `needsAttention`, but `retry` ignores it, so a new attempt can authorize while the old hold still sits on the card. A provider answer of `{ok:false}` (a transient refusal) marks `releasedAt` and is never retried.
- Exploit / impact: with a real provider, stacked holds can push a member over their card limit. The member then gets a spurious decline, which S2-001 attributes publicly. The operator is told that retry is blocked when it isn't. With the SIM, the impact is only functional.
- Fix: block `retry` while any seal of the previous attempt has `authRef && !releasedAt && !capturedAt`. Treat `{ok:false}` as not released unless the provider says the hold doesn't exist.
- Effort: S
- Scope (dirs a fixer may touch): apps/server/src/payments, apps/server/src/trips, apps/server/test
- Acceptance: in payments.test.ts, with a SIM whose `void` throws once, `booking:retry` gets `NEEDS_ATTENTION` until a re-drive succeeds.

### S2-011 — Payments, SIM and passkey maps are never evicted (slow unbounded growth)
- Severity: Low
- Location: apps/server/src/payments/orchestrator.ts:69 (`bookings`); apps/server/src/payments/sim.ts:13-15 (`instructions`, `auths`, `results` hold a promise per idempotency key); apps/server/src/passkeys/passkeys.ts:43-45; apps/server/src/trips/core.ts:253-263 (`evictTrip` drops members and standing but not bookings or credentials)
- Evidence: `grep bookings.delete` finds nothing. `sweep` evicts voyages, but their bookings, SIM results and passkeys stay in memory for the life of the process.
- Exploit / impact: memory grows with every attempt ever made. Growth is slow, since it needs voyages that reach SEALING, but it compounds S2-006 on a long-running instance.
- Fix: in `evictTrip`, delete the voyage's final bookings (they're in Mongo) and their deadline timers, and drop passkey credentials and challenges of evicted members (reload on hydrate). Bound the SIM's maps with an `Lru`.
- Effort: S
- Scope (dirs a fixer may touch): apps/server/src/trips, apps/server/src/payments, apps/server/src/passkeys, apps/server/test
- Acceptance: a test sweeps a BOOKED voyage and asserts that `payments.bookings`, the SIM maps and the passkey maps no longer hold its ids, and that `hydrate` restores the booking.

### S2-012 — The organizer can still take an absent friend's seat (the invite key is theirs; the crew-key check is advisory)
- Severity: Low
- Location: apps/server/src/trips/crew.ts:122-128 (`mintInvite` returns the key to the organizer), 135-152 (`claimAbsent`: `OWN_INVITE` only compares the *supplied* crew key), 111-120 (`reissueInvite`)
- Evidence: the organizer calls `POST …/absent/:id/claim` with the invite key and no `crewKey`. A fresh key is minted, so the `OWN_INVITE` guard never matches, and the organizer gets the absent seat's member token.
- Exploit / impact: the organizer can seal the absent friend's terms (cap, must-haves), create the standing instruction under the friend's name, and read that seat's private plan and seal views. The friend's own link then fails. The residual of round-1 SEC-004.
- Fix: deliver the invite over a channel the organizer can't read. For example, the organizer enters the friend's phone number or email and the server sends the link, or the friend's phone presents a QR code that the organizer's phone approves (the key is then generated on the friend's device). At minimum, show every crew member when an absent seat is claimed ("Dev opened their link"), and let the friend re-key if the claim wasn't theirs.
- Effort: M
- Scope (dirs a fixer may touch): apps/server/src/trips, apps/server/src/api, apps/web/src/phone, apps/server/test
- Acceptance: a test shows that a claim without the out-of-band secret is refused, even with the organizer's invite key.

### S2-013 — Dev key still accepted from `/demo?key=` (travels in the request line before the client strips it)
- Severity: Low
- Location: apps/web/src/net/api.ts:107-123 (`captureDevKey` reads `search.get("key")`)
- Evidence: the page request `GET /demo?key=<DEV_KEY>` reaches the helm and any proxy or CDN in front with the key in the URL. Render/Cloudflare request logs keep query strings, and the browser history has the URL until `replaceState` runs.
- Exploit / impact: the production DEV_KEY leaks into infrastructure logs. It opens `/api/demo/seed`, `/api/debug/*` and the health details (S2-004).
- Fix: accept `#key=` only, since fragments never leave the browser. Drop the `?key=` branch and say so in DEPLOY.md.
- Effort: S
- Scope (dirs a fixer may touch): apps/web/src/net, DEPLOY.md
- Acceptance: a web unit test shows that `/demo?key=x` doesn't store a dev key and `/demo#key=x` does.

### S2-014 — Paid-API budgets are global: one abuser can switch voices and models off for everyone; per-voyage counters are LRU-evictable
- Severity: Low
- Location: apps/server/src/util/limits.ts:134 (`perTrip` Lru 5,000), 156-165 (`spend`); apps/server/src/config.ts:107-111
- Evidence: the daily caps (Gemini 3,000, TTS 1,500, STT 500, Backboard 3,000) are shared by the whole server. Each voyage may use up to its own caps (e.g. 150 Gemini calls), and new voyages are cheap (S2-006). Past 5,000 voyages, the per-voyage counters are evicted and reset.
- Exploit / impact: ~20 abusive voyages use up the day's Gemini budget, and every other voyage falls back to template lines and captions. Spend itself stays bounded, which was the round-1 goal. This is availability only.
- Fix: reserve part of the daily budget for voyages with at least 2 sealed members, or with an organizer who is past the "table" step. Charge `table:start` against a per-address daily meeting quota. Keep per-voyage counters in the trip record rather than in an LRU.
- Effort: S
- Scope (dirs a fixer may touch): apps/server/src/util, apps/server/src/trips, apps/server/test
- Acceptance: a test runs abusive voyages until the unreserved budget is gone, then shows that a legitimate voyage still gets `spend("gemini") === true` out of the reserve.

---

## Info

### S2-015 — Browser tile tokens ship in the public bundle (restrict them at the provider)
- Severity: Info
- Location: apps/web/src/scene/CityTiles.ts:9-10; Dockerfile:14-17; .env (`VITE_CESIUM_ION_TOKEN` is set)
- Evidence: the Cesium ion token is present in `apps/web/dist/assets/Stage-*.js`. That is expected for a browser key.
- Exploit / impact: anyone can lift it and spend the account's ion or Google Tiles quota.
- Fix: in Cesium ion, restrict the token to asset 2275207 with `assets:read` and to the production URL. In Google Cloud, restrict the key by HTTP referrer and API. Rotate it if it was ever unrestricted.
- Effort: S
- Scope (dirs a fixer may touch): DEPLOY.md (documentation only)
- Acceptance: a request for a tile with the token from a non-allowed origin is refused by the provider.

### S2-016 — Docker entrypoint chowns whatever DATA_DIR/CACHE_DIR names, as root, with no allow-list
- Severity: Info
- Location: apps/server/scripts/docker-entrypoint.mjs:18-28
- Evidence: the privilege drop itself is correct: `setgroups` → `setgid` → `setuid`, the process exits if it fails, symlinks are skipped via `lstat`, and the server loads only after the drop. But if an operator mistakenly sets `DATA_DIR=/app` (or `/`), the whole tree is recursively chowned to `node`.
- Exploit / impact: only after a misconfiguration. A later compromise of the `node` process could then modify the server code, which persists on the image's writable layer.
- Fix: refuse any DATA_DIR/CACHE_DIR that isn't under `/var/data` or the default `/app/apps/server/{data,.cache}`, and never chown `/app/apps/server/dist`.
- Effort: S
- Scope (dirs a fixer may touch): apps/server/scripts
- Acceptance: running the entrypoint as root with `DATA_DIR=/app` exits non-zero without chowning anything.

### S2-017 — Dev-only dependency advisory (vitest / @vitest/mocker)
- Severity: Info
- Location: package-lock.json (vitest 3.x)
- Evidence: `npm audit --omit=dev`: 0 vulnerabilities. Full `npm audit`: 2 moderate issues (GHSA-82fw-gwwq-j7x9, @vitest/mocker path traversal). They're dev-only, and the runtime image installs with `--omit=dev`.
- Exploit / impact: none in production. It only matters when running the test UI on a shared machine.
- Fix: upgrade vitest when convenient.
- Effort: S
- Scope (dirs a fixer may touch): package.json, apps/server/package.json, package-lock.json
- Acceptance: `npm audit` shows 0 issues.

---

## Verified non-issues
- **AuthN/AuthZ on every route and event.** `memberByToken` scans only that voyage's seats and skips removed ones. `requireActive` guards brief, vote, hail and seal. `requireOrganizer` checks `m.tripId === tripId` or `deviceOk`. `sailWithout` and `unpairHeadset` refuse the headset. The passkey routes use `memberOf(tripId)`, and `auth/verify` binds member + booking + trip. `claimAbsent` checks trip, role, hash and removal. A gallery socket can't hail, pick, call off or log. After "sail without them", `evict` strips the socket's member identity. A token used on another trip resolves to a spectator seat only.
- **Private events.** `toTrip` throws on `PRIVATE_EVENTS`. `brief:private`, `plan:private`, `plan:myVote`, `seal:private` and `seal:declinedPrivate` go only to `member:{id}` or the member's own replay. Public `seal:status` carries only PENDING, AUTHORIZED, CAPTURED and VOIDED (the leak left is timing, S2-001). `bookingDoc` drops `capCents`, and `trip:state` has no shares or caps. Advocate prompts get no cap or share, only `fits`, `missing` and the group total.
- **Payments.** Concurrent `seal:set` collapses (the `setting` set plus the PENDING re-check). `pick` is synchronous up to the transition, so a double pick gets BAD_PHASE. A deadline, call-off or decline racing an in-flight authorization marks the seal VOIDED, and the late approval is released (orchestrator.ts:283-292). `callOff` and the deadline are refused once ALL_AUTHORIZED. A failed capture refunds the captured seals and releases the rest. `retry` is blocked while money is owed (see S2-010 for holds). The limit is `min(cap, share×1.02)`, so nobody is charged above their cap. Idempotency keys are per booking and member.
- **Codes and tokens.** Member, invite, handoff, device and crew tokens are 256-bit random, stored as SHA-256 and compared in constant time. Handoffs are single-use, last 2 h, stay in memory only, and are minted only by the dev-gated seed. Pair codes are 40 bits, HMAC'd under `PAIRING_SECRET`, single-use, last 10 min, and limited per /64 (S2-008 is availability). Device tokens last 12 h, end at BOOKED, and can be unpaired. Join codes are 30 bits with per-/64 miss limits on both REST and the socket.
- **WebAuthn.** In production the relying party is pinned to `PUBLIC_BASE_URL` (the Origin and X-Forwarded-Host headers are ignored). simplewebauthn 13.3.3 enforces user verification (the default `requireUserVerification=true`) and the counter. Credentials and counters persist. A credential id can't be re-bound. Assertion tokens are single-use, 2 min, and bound to member + booking + rpID.
- **Input and injection.** Socket payloads pass through `str`/`strs`/`briefInput`. REST bodies read named fields (32 kB JSON limit). Every Mongo filter uses a string `_id` or `joinCode`. No prototype pollution (server-generated keys only). The filter regexes are linear. Names, notes, memory and hails reach prompts only via `promptName`, `promptText`, `noteForPrompt` and `memoryForPrompt` (hails only as parsed tags).
- **XSS and HTML.** No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in apps/web/src. React and troika render text. The debug pages escape `& < > "` and `safeNext` whitelists the redirect. `clean()` strips `<>` and control characters from names and hails. No `href` or `src` is built from server strings, except crew avatars, which are local.
- **Headers, CORS, cookies.** CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, a sanitised Host echo), nosniff, `Referrer-Policy: no-referrer`, XFO DENY, COOP, and Permissions-Policy are present live. HSTS is sent in production. The Socket.io `allowRequest` accepts only same-origin, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, or dev hosts outside production. REST sends no CORS headers and uses bearer tokens, not cookies. The debug cookie is HttpOnly, SameSite=Strict, `Path=/api/debug`, 1 h, HMAC-signed with a per-process secret, and Secure in production.
- **Mode gating.** `resolveMode` fails closed: production if NODE_ENV or APP_ENV says so, or if the public URL is non-local. Production refuses a weak DEV_KEY or a missing `PUBLIC_BASE_URL`. Dev routes need DEV_KEY outside dev mode, and the key is compared in constant time. `/api/health` publicly shows only `ok`, `eleven` and `degraded`.
- **Secrets.** The `.env` loader never overrides real env vars. Vite exposes only `VITE_*` (`.env` → 403 on the dev server). No token, cap or note is logged, and provider error bodies are truncated. `.dockerignore` excludes `.env*`, data, caches, tests and docs. The image runs compiled JS without dev dependencies, and source maps are deleted.
- **Path traversal and static files.** `/api/audio/:turnId` resolves only through an in-memory turnId → sha1 map (no path input), and restored keys must match `^[0-9a-f]{40}$`. `express.static` with `index:false`. `.map` files 404 in production. Unknown `/api/*` paths return a JSON 404.
- **Docker privilege drop.** Correct order, exit on failure, symlinks skipped, and the server is imported only after `setuid(1000)` (S2-016 is a hardening note).
- **Resource bounds that hold.** Socket messages are capped at 64 kB, with 60 events per 10 s per socket, 64 sockets and 120 connects per minute per /64. `client:log` needs authentication and is limited to 5/s. Hail audio is authenticated, phase-checked, rate-limited and budget-checked before any byte is read (411 without a length, 413 over the cap). `headersTimeout` is 10 s and `requestTimeout` 60 s. The debug log is bounded (400 rows × 200 voyages). The TTS cache is pruned.

### Round-1 fixes, re-verified (side check)
SEC-003 (crew key), SEC-004 (one-time handoff; organizer pre-claim remains, see S2-012), SEC-005 (spend caps; see S2-014), SEC-006, SEC-007 (trust-proxy hops, /64 keys), SEC-008 (persisted, never replaced; TOFU remains, see S2-009), SEC-009, SEC-011, SEC-012, SEC-013, SEC-014, SEC-016, SEC-018, SEC-019 (except `?key=`, see S2-013), SEC-020, SEC-021, SEC-022, SEC-024 and SEC-026 are fixed as described. **SEC-001, SEC-002, SEC-015, SEC-017 and SEC-025 are only partly fixed**: see S2-002, S2-001, S2-006, S2-003 and S2-004.

### Repro artifacts (scratchpad `r2-sec/`)
- `share-infer.mts`, `share-infer-cheap.mts`: brute-force share inference from the public plan (S2-002).
- `seal-timing.mts`: the Gallery's view of seal statuses and timing with a decline (S2-001).
- `hail-oracle.mts`: the post-strip amount oracle (S2-003).
- `tripmem.mts`: memory per voyage at 50k voyages (S2-006).
- `seed.json`, `bycode.json`, `debug.html`: live dev helm, debug ref reversal (S2-004).
- curl (live :5173): `/@fs/` reads of repo files and `apps/server/data/memory.json`, with `.env` → 403 (S2-005).
