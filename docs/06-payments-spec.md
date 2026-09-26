# 06 — Payments Specification: The Seal (all‑or‑nothing group checkout)

**Promise to users:** *Each of you pays only your own share, from your own card, capped at your own sealed terms, set on your own phone (with your own passkey, if you added one). Either everyone's share goes through, or nobody is charged. Nobody fronts the money.*

**Promise to Visa judges:** this is agentic commerce done the way Visa describes it — agent‑specific credentials, user‑set spending controls, passkey‑authenticated instructions — extended to **groups**, which no consumer product we found does.

---

## 1. Background: Visa Intelligent Commerce (VIC)

From Visa's developer materials (researched Sep 24, 2026):
- VIC is Visa's platform for **AI agents to browse, shop and purchase on behalf of consumers within limits the consumer sets**.
- Capabilities: **tokenization & authentication APIs** (agent‑specific payment tokens), **payment instructions & signals APIs** (submit the user's authenticated instructions, retrieve credentials that match them), **passkey** authentication of instructions, **spending controls**, **commerce signals** for disputes.
- Developer entry points: **Visa MCP server** + starter toolkit (`github.com/visa/mcp`), reference app (`github.com/visa/vic-reference-agent`). **Free to use in sandbox.**
- Controls are enforced at authorization so a request must come from the intended merchant for the correct amount.

> We do not hard‑code endpoint names in this doc. Person B reads `visa/mcp` + the reference agent README tonight and fills §4.3 with the exact calls.

---

## 2. Modes

| Mode | What's real | When |
|---|---|---|
| **A — VIC + gateway sandbox** (best) | VIC sandbox: member enrollment → agent token → payment instruction with cap (passkey) → credential. Authorization hold / capture / void through a Visa‑family gateway sandbox (e.g. Cybersource test account) using the VIC credential. | If sandbox access + test merchant are working by Sat 2 PM |
| **B — VIC sandbox + simulated merchant** | VIC tokens + instructions + caps are real sandbox objects; the merchant hold/capture/void is simulated in our orchestrator. | If gateway setup is too slow |
| **C — SIM** (fallback) | Everything simulated, same state machine, same UX; UI shows a small "Sandbox simulation" tag in the ledger footer. | If VIC access isn't granted in time |

`PAYMENTS_MODE=visa_sandbox|sim` plus `VISA_MERCHANT=gateway|simulated`. **We tell judges exactly which mode is running.** Honesty scores better than a fake.

---

## 3. Objects

| Object | Where | Purpose |
|---|---|---|
| **Agent card** (per member) | VIC sandbox token (or SIM id) | The card the member's Advocate may use. Displayed as "Visa •••• 4242 (agent card)". |
| **Instruction** (per member per booking) | VIC payment instruction (or SIM) | "My agent may pay up to **min(cap, share + 2%)** to merchant *All Ayes Voyages* until *T+30 min*." Authenticated with the member's passkey. |
| **Seal** (per member per booking) | `seals` collection | Our record of that member's authorization lifecycle. |
| **Booking** (per attempt) | `bookings` collection | The group transaction; owns the all‑or‑nothing decision. |

Instruction limit (live seal) = `min(member.capCents, seal.amountCents × 1.02)` — tight enough that the agent can't overspend, 2% slack for FX/rounding; expires 30 min after creation. If the share is over the cap, the limit is the cap, so authorization of the share is declined `over_limit` — that *is* the spending control working.

Standing instruction (absent member, §6) = limit `capCents`, merchant *All Ayes Voyages*, expires 24 h after the member seals it — created before any plan exists, so it can only be bounded by their cap. It is persisted with the member (`members.standing = {instructionRef, expiresAt}`, server‑side only — never the limit, which restore re‑derives from the brief's cap, L5-007) and restored on boot **with its original expiry**; a restart never re‑issues or extends it, and an expired one is dropped (that member then seals live). If creating it fails, the brief still seals without it (the member seals live).

The member's cap never leaves their instruction or their own phone.

---

## 4. Flows

### 4.1 Once per member
1. **Enroll agent card**: create/obtain an agent token for the member's (test) card.
2. **Passkey — optional, never part of sealing (LIVE-001).** *Set your seal* never starts a passkey registration (a surprise OS or password-manager sheet in the middle of the ceremony blocked the tab live). A member adds one only by tapping **Add a passkey** on the Wait or Brief screen; it is offered only on phones with a platform authenticator and only with the seat's passkey-claim cookie (`aa_pk_<memberId>`, set at create/join/claim/handoff; without it `409 PASSKEY_UNBOUND`, S2-009). Adding one registers only; it never sets a seal. A member **without** a passkey seals with the confirm tap. A member **with** one must approve with it (`PASSKEY_REQUIRED` otherwise); a cancelled or failed prompt is a note and sends nothing.

### 4.2 Per booking attempt
```
plan:pick (Organizer phone or headset)
  └─► create Booking{attempt n, status PENDING, groupCents}
      create Seal{memberId, amountCents, PENDING} for each member
      emit booking:created (trip), seal:private (each member)
      for each absent member with a live standing instruction → their seal is SET at once
        (its instruction is already on file; it is NOT authorized yet — S2-001)

member taps "Set your seal"
  └─► if the member added a passkey: WebAuthn assertion ──► server verifies (else the confirm tap is enough)
      create Instruction(member agent card, limit, merchant, expiry)  [VIC, passkey-authenticated]
      Seal → AUTHORIZING = "set" (emit seal:status AUTHORIZED): instruction on file, nothing authorized yet
member taps "Lift my seal" (seal:cancel) while seals are being gathered
  └─► Seal → DECLINED(user_cancelled), told privately to its owner; publicly it counts as "set" too

when the LAST seal is set (S2-001: collect, then settle together)
  └─► booking.settleAt = now + SEAL_SETTLE_MS (2.5 s × PACE_SCALE) — the fixed settle point
      if a seal was lifted                    → no authorization at all (no hold for a booking that can't complete)
      else authorize(amountCents) for EVERY seal at once, each against its instruction, and wait for every answer
         ├─ approved  → Seal AUTHORIZED  (hold placed)
         └─ declined / 15 s timeout → Seal DECLINED(reason)
      if any Seal DECLINED                    → all Seals VOIDED → Booking ANY_DECLINED (persisted) → void every hold → Booking VOIDED
      else (all AUTHORIZED)                   → Booking ALL_AUTHORIZED → capture every hold
        ├─ all captures ok                    → Seals CAPTURED → Booking CAPTURED → trip BOOKED
        └─ any capture fails (rare)           → REFUND the captured ones, void the rest → Booking VOIDED
                                                (a refund or release the provider refuses → booking.needsAttention, retry blocked)
      the outcome is PUBLISHED at settleAt (or when the provider is done, if later): the owners' private decline
      reasons, every seal's final status in seat order, then one booking:result. Until then the trip room sees "set".

seal deadline (SEAL_DEADLINE_MS, default 10 min from booking:created; booking.sealDeadlineAt)
  └─ booking still PENDING/AUTHORIZING        → void everything, "Not every seal was set in time, so nobody was charged."
organizer booking:callOff (phone or headset)
  └─ booking still gathering seals            → void everything, "The organizer called it off, so nobody was charged."
     (a second call-off while it voids is the same call-off: ok; refused with CAPTURING once every seal is set —
      the booking is settling, and the refusal is the same whatever the outcome will be)
```

**Seal timing (S2-001).** The public stream must not say whose seal failed, by content *or* by order or timing. The
design is "collect, then settle together": a seal becoming "set" never involves the card network, so its moment depends
only on its member's tap (or, for a standing seal, on `booking:created`). Nothing is voided while seals are being
gathered — a decline can only happen once every seal is set, and a lift is recorded privately and shows publicly as
"set" — so the only public moments are the taps, and then one fixed settle point: `settleAt` = the last "set" +
`SEAL_SETTLE_MS` (2.5 s, no jitter, scaled by `PACE_SCALE` for tests). All authorizations run concurrently from the last
"set", so a standing seal never answers before the live ones, and the published outcome waits for `settleAt` whoever
declined. If the provider is slower than the settle point (up to the 15 s authorization timeout), the outcome is
published when it is done — later for everyone alike, still all seals together, so it says "someone's network was
slow" but not whose. Only the deadline and a call-off end a booking before every seal is set; neither is attributable.
While the outcome is held, `toPublic` shows the booking AUTHORIZING with every seal "set" (no reference, no deadline),
and a call-off or a lift answers "settling" / SEAL_LOCKED. Trade-off: no hold is placed until every seal is set, so a
member's card isn't checked at their tap; an over-limit share is only discovered at the settle point.

A booking restored after a restart is never held for a settle point (`settleAt` isn't re-armed): mid-gathering it is voided with the restart reason and zero authorizations; mid-settle it is voided and published at once. A capture that fails after a restart reports the restart.

Durable intents (restart safety): before each provider call the orchestrator persists what it is about to do —
`seal.authorizeRequestedAt` before `authorize`, all seals VOIDED + booking `ANY_DECLINED` before the voids, `seal.capturedAt` as each capture succeeds —
and records completion (`seal.releasedAt`, `seal.refundedAt`). On boot, `recover()` re‑drives with the same idempotency keys:
a non‑final booking is voided (every seal with an `authRef` and no `releasedAt` is voided whatever its recorded status; an
authorization requested but never answered is asked again with its original key and released if it was approved); an
`ALL_AUTHORIZED` booking re‑drives its captures (completing the booking, or falling into the refund path); a final booking
re‑drives unfinished releases/refunds. The trip then follows its booking (CAPTURED → BOOKED, VOIDED → VOIDED), and a
live booking that no trip points at is voided.

### 4.3 Provider interface (`payments/provider.ts`)
```ts
interface PaymentProvider {
  mode: "visa_sandbox" | "sim";
  ensureAgentCard(memberId: string): Promise<{ cardRef: string; last4: string }>;
  createInstruction(p: { memberId: string; cardRef: string; limitCents: number;
                         merchantName: string; expiresAt: string; passkeyAssertion?: string })
                   : Promise<{ instructionRef: string }>;
  authorize(p: { sealId: string; instructionRef: string; amountCents: number; idempotencyKey: string })
           : Promise<{ approved: true; authRef: string } | { approved: false; reason: DeclineReason }>;
  capture(p: { authRef: string; amountCents: number; idempotencyKey: string }): Promise<{ ok: boolean }>;
  void(p: { authRef: string; idempotencyKey: string }): Promise<{ ok: boolean }>;      // releases a hold; can't undo a capture
  refund(p: { authRef: string; amountCents: number; idempotencyKey: string }): Promise<{ ok: boolean }>; // returns captured money
  resumeInstruction?(p: { memberId: string; instructionRef: string; limitCents: number; expiresAt: number }): Promise<boolean>;
    // boot: confirm a persisted standing instruction is still on file (SIM re-registers what it lost with the process)
}
type DeclineReason = "over_limit" | "timeout" | "provider_error" | "user_cancelled";
```
`visaVic.ts` maps these to the calls from `visa/mcp` (fill in tonight):

| Our call | VIC / gateway call (TO FILL from README) | Notes |
|---|---|---|
| `ensureAgentCard` | tokenization / enroll | sandbox test PAN |
| `createInstruction` | payment instructions (+ passkey auth) | limit, merchant, expiry |
| `authorize` | credential retrieval + gateway auth (Mode A) / simulated (Mode B) | |
| `capture` / `void` / `refund` | gateway capture / void / refund (Mode A) / simulated | a void never undoes a capture |

### 4.4 SIM provider rules (`payments/sim.ts`)
- `authorize` approves if `amountCents ≤ limitCents` else `over_limit`; artificial latency 600–1200 ms.
- Env hooks for demos/tests: `SIM_DECLINE_MEMBER=<memberId>` forces `over_limit`; `SIM_TIMEOUT_MEMBER=<memberId>` never answers.
- Generates refs like `sim_auth_7Q2M`.

---

## 5. State machines

### 5.1 Seal
| From | Event | To |
|---|---|---|
| PENDING | member `seal:set` (confirm tap, or passkey ok if the member added one; instruction created), or standing seal at `booking:created` | AUTHORIZING ("set"; authorization waits for the settle) |
| PENDING / AUTHORIZING | `seal:cancel` while seals are being gathered | DECLINED (`user_cancelled`; publicly "set") |
| AUTHORIZING | every seal set → provider approved | AUTHORIZED |
| AUTHORIZING | every seal set → provider declined | DECLINED (reason) |
| AUTHORIZING | every seal set → 15 s timeout | DECLINED (`timeout`) |
| AUTHORIZED | booking capture ok | CAPTURED |
| AUTHORIZED | booking voided | VOIDED |
| PENDING | booking voided | VOIDED |
| AUTHORIZING | booking voided (deadline, call‑off, another seal declined) | VOIDED (a late approval is released at once) |

### 5.2 Booking
| From | Condition | To | Side effects |
|---|---|---|---|
| PENDING | first seal set (or lifted) | AUTHORIZING | — |
| AUTHORIZING | last seal set | AUTHORIZING (settling) | `settleAt` fixed; every seal authorized together (none if one was lifted) |
| AUTHORIZING (settling) | all seals AUTHORIZED | ALL_AUTHORIZED | capture all (parallel) |
| AUTHORIZING (settling) | any seal DECLINED | ANY_DECLINED | every seal → VOIDED; void every hold |
| PENDING / AUTHORIZING (gathering) | seal deadline passes | ANY_DECLINED | same; public reason "Not every seal was set in time…" |
| PENDING / AUTHORIZING (gathering) | organizer `booking:callOff` | ANY_DECLINED | same; public reason "The organizer called it off…" |
| ALL_AUTHORIZED | all captures ok | CAPTURED | trip → BOOKED; reference `AA-<CITY>-<4>`; Backboard memory write |
| ALL_AUTHORIZED | any capture fails | VOIDED | **refund** the captured seals, void the rest; public reason "Refunded — nobody ends up paying" (or "nobody was charged" when nothing was captured); a refused refund sets `needsAttention`, is logged, re‑driven on boot and on retry, and blocks `booking:retry` (`NEEDS_ATTENTION`) until it clears |
| ANY_DECLINED | voids done | VOIDED | trip → VOIDED; neutral memory note for every member ("not booked (nobody was charged)") on the voyage's first attempt only, never for a restart void (L4-008) |

A settled booking (CAPTURED or VOIDED) is published at `settleAt` when it has one (S2-001). A hold counts as released
only when the provider voided it or says it no longer exists (`void → {gone:true}`); a plain `{ok:false}` or a thrown
call leaves it outstanding (`needsAttention`, re-driven). **Money gate (SEC-016, S2-010, L4-001):** while *any* booking of
the voyage still owes a refund or has an unreleased hold, `booking:retry`, `plan:pick` and a new table
(`transition → SEALING / AT_TABLE`) answer `NEEDS_ATTENTION` and kick a re-drive.

### 5.3 Invariants (unit‑tested)
1. `Σ seals.amountCents == booking.groupCents`.
2. No `capture` call unless **every** seal is AUTHORIZED.
3. After VOIDED, no seal of that booking is AUTHORIZED or CAPTURED.
4. Each provider call carries an idempotency key `${bookingId}:${memberId}:${op}`; replays return the first result.
5. A new attempt (`attempt+1`) always creates new seals; old ones are immutable.
6. Seal amounts are emitted **only** to the owner's `member:{id}` room.
7. The public per‑member seal sequence is the same whoever declined: `PENDING → AUTHORIZED ("set") → VOIDED`, all seals announced together in seat order; no `DECLINED`/`AUTHORIZING` or authorization outcome reaches the trip room (§7).
8. Every provider call is preceded by a persisted intent and re‑driven idempotently on restart (§4.2), so no hold outlives a VOIDED booking across a crash.
9. The *timing* of public events doesn't depend on whose seal failed (S2-001): no authorization starts before every seal is set (standing seals included), and the outcome is published at the fixed settle point (last "set" + `SEAL_SETTLE_MS`, or later for everyone if the provider is slower).
10. Nobody is asked to pay again while any earlier booking of the voyage still owes a refund or holds an unreleased authorization (retry, pick and a new table answer `NEEDS_ATTENTION`).
11. All of the above hold for any crew size up to `MAX_CREW` (12 seals, any number of them standing seals for absent members): the settle point and the per-seal sequence don't depend on the crew size or on which seat declined (`test/crew12.test.ts` runs the SEC-002 sequence check for crews of 8 and 12, declining the organizer, a member, an absent member's standing seal and the last seat). A crew in several rooms of one stay still has one lodging bill split evenly (doc 05 §2.1), so (1) holds exactly.

---

## 6. Absent member

- P0 (demo): the absent member (Dev) set a **standing instruction** earlier via their link ("my mate may pay up to my terms for this voyage, next 24 h" — §3). When a booking is created, Dev's seal is set straight away; his share is authorized against that instruction together with everyone else's once every seal is set (S2‑001), and if `share > limit` it is DECLINED `over_limit` and the booking voids at the settle point like any other decline. On the table, Dev's seal presses first, with a small folded‑letter mark (pre‑signed). In the Expo run Dev's share is $963 against a $1,400 limit.
- `apps/server/src/demo/seed.ts` creates Dev's standing instruction as part of seeding (SIM mode: stored limit; Mode A/B: real sandbox instruction created at seed time).
- P1: absent member gets a push/email link and seals live.

---

## 7. What users see (maps to doc 03)

Publicly a seal is only **set** or not (SEC‑002): the wax presses when its member taps (or a standing seal starts), before and regardless of the card network's answer, and every seal lifts or is logged together when the booking settles — at the fixed settle point a moment after the last seal is set (S2‑001, §4.2). A member who lifts their seal is shown as set too; the booking then voids at the settle point. So nobody — including by the order or timing of updates — learns whose share didn't clear; only its owner does, privately.

| Moment | Owner phone | Others | Table |
|---|---|---|---|
| Seal pending | Ledger + "Set your seal" | "Waiting on Maya's seal" (hourglass) | Line shows "— sealed —" pending |
| Seal set | "Seal set — waiting on 1 seal" | wax icon on name | Wax seal presses on line |
| Booked | Booked screen with **own** share + reference | Booked screen with own share | Roll‑up + bell ×2 |
| Voided | Owner of decline sees a reason line (below); headline = public reason | Public reason: "One share didn't clear, so nobody was charged." / "Not every seal was set in time…" / "The organizer called it off…" / "…Refunded — nobody ends up paying." | Crack + all seals lift |

The organizer's seal screen has **Call it off** while seals are still being gathered (two taps within 4 s → `booking:callOff`). Every seal screen notes: "If not every seal is set in time, the booking is called off and nobody is charged."

Decline reason → owner‑only copy:
| `declineReason` | Owner sees |
|---|---|
| `over_limit` | "Your seal didn't clear: that share is over your agent card's limit." |
| `user_cancelled` | "You lifted your seal, so nobody was charged." |
| `timeout` | "The card network didn't answer in time." |
| `provider_error` | "The card network had a problem." |

Ledger footer copy (Mode A/B): "Paid with a Visa agent card, capped at your terms. Sandbox." · (Mode C): "Sandbox simulation of a Visa agent card, capped at your terms."

---

## 8. Demo scenarios

| Scenario | Setup | Shows |
|---|---|---|
| **Happy path** (always) | All shares ≤ limits | Seals press one by one as members tap; ~2.5 s after the last one → bell, BOOKED |
| **Nobody fronts** (optional, +20 s) | Dev's standing seal is set at once; Maya sets her seal and then taps **Lift my seal** (`seal:cancel`) while Rae's is still open (the link only shows while someone else is pending); Rae sets the last seal. (`SIM_DECLINE_MEMBER=<memberId>`, read at boot, forces an `over_limit` decline instead — tests only, since seeded ids are random) | Every seal reads "set"; ~2.5 s later all seals lift together, "nobody was charged" (no hold was ever placed for a lift); Back to the charts → pick Lisbon again → attempt 2 → BOOKED |
| **Cap enforcement** (judge Q&A) | Open `/api/debug/<code>` (dev key), show Dev's standing instruction ref and an attempted over‑limit auth being declined | Spending control is real, not a UI checkbox |

---

## 9. Security notes
- For a member who added a passkey, the assertion is verified server‑side (bound to member + booking + rpID, single use, 2 min) before their instruction is created; a member without one seals with the confirm tap on their own authenticated seat.
- Agent card refs and instruction refs are server‑side only; phones see last4 + limit status ("capped at your terms"), never the numeric limit shown to others.
- No real PANs anywhere; sandbox test cards only.
- Instruction expiry: 30 min for live seals, 24 h for an absent member's standing instruction — prevents dangling permissions. The standing instruction's expiry is persisted and survives restarts unchanged (never renewed at boot).
- A booking can't hold funds indefinitely: seal deadline (10 min default, `SEAL_DEADLINE_MS`) plus an organizer call‑off. After a restart, live bookings are voided (§4.2 durable intents), so the deadline needs no re‑arming.
- Passkeys are bound to the relying‑party domain (`WEBAUTHN_RP_ID`): register them on the real `.tech` domain; passkeys made on a tunnel URL won't work in production.

---

## 10. Test cases (Vitest, SIM provider)
1. 3 members approve → CAPTURED; 3 captures called once each.
2. Member 2 declines at the settle point while member 1 is approved → member 1's hold voided; no capture called.
3. Timeout on member 3 → voided at 15 s; booking VOIDED.
4. Duplicate `seal:set` ×3 → one authorization call (idempotent).
5. Capture fails for member 1 → the others are **refunded** (not voided); booking VOIDED; a refused refund sets `needsAttention` and blocks retry.
6. Retry after VOIDED → attempt 2 with fresh seals; attempt 1 untouched.
7. Privacy: gallery socket never receives `seal:private` or `seal:declinedPrivate`.
8. Absent member pre‑instruction: the seal is set at `booking:created`; at the settle point share ≤ limit → authorized, share > limit → decline → void all.
9. Decline each member in turn (random latencies), the standing seal and a lift included: the public event sequences are identical and `booking:result` lands at the same settle point after the last "set" (S2‑001).
10. Seal deadline (2 of 3 sealed, +10 min) and organizer call‑off → VOIDED, nothing held.
11. Restart: SEALING + final booking reconciles; mid‑void / mid‑auth / mid‑capture bookings are re‑driven; a standing instruction keeps its original expiry and an expired one isn't renewed.
