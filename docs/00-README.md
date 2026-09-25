# All Ayes — Documentation Index

> **All Ayes — everyone's in, or nobody pays.**
> *Send your mate to the table.*
> Every friend privately briefs their own agent with their real budget and wishes. The agents meet around a paper globe on your real table (Meta Quest 3, mixed reality), argue it out loud, show the group two candidate trips as miniature cities ticking through a day (**Dry Run**), and then book it with an **all‑or‑nothing checkout**: every friend sets their seal, each share is paid by a Visa agent token capped at that friend's private limit, and if any share fails, nobody is charged. Nobody fronts the money. Nobody has to say "that's too expensive" in the group chat.

Built for **HackGT 13 — Seaside Market** (Sep 25–27, 2026, Klaus Advanced Computing Building, Georgia Tech). Team of 2.

---

## 1. Documents

| # | Doc | What it answers | Primary owner |
|---|---|---|---|
| 00 | `00-README.md` (this) | What is this, where is everything, shared vocabulary | Both |
| 01 | [`01-PRD.md`](01-PRD.md) | Why, for whom, what exactly we ship, how we win each prize | Both |
| 02 | [`02-design-language.md`](02-design-language.md) | The "Chart Room" visual + sound + motion system; the anti‑AI rules | Person A |
| 03 | [`03-ux-flows-and-screens.md`](03-ux-flows-and-screens.md) | Every screen, every XR scene, every state, who sees what | Person A |
| 04 | [`04-technical-design.md`](04-technical-design.md) | Architecture, stack, data model, APIs, socket protocol, deploy | Person B |
| 05 | [`05-agent-spec.md`](05-agent-spec.md) | Advocates + Captain, negotiation protocol, prompts, tools, privacy guards | Person B |
| 06 | [`06-payments-spec.md`](06-payments-spec.md) | Visa Intelligent Commerce flow, all‑or‑nothing state machine, sim mode | Person B |
| 07 | [`07-dataset-spec.md`](07-dataset-spec.md) | The curated trip dataset (3 cities) with seed values | Person A (data), B (loader) |
| 08 | [`08-build-plan.md`](08-build-plan.md) | Hour‑by‑hour plan for 2 people, cut lines, risks, tests, prep tonight | Both |
| 09 | [`09-demo-and-pitch.md`](09-demo-and-pitch.md) | Expo script, judge Q&A, Meta video storyboard, Devpost draft, submission checklist | Both |

**Reading order for a new teammate:** 00 → 01 → 03 → 02 → 08. Engineers then read 04 → 05 → 06 → 07.

---

## 2. What we are entering

| Category | Entry | Prize (per member, up to 4) | Hard requirements we must meet |
|---|---|---|---|
| **Track (only one allowed)** | The Lighthouse Laboratory — Immersive (AR/VR/XR) | 1st ASUS TUF 27" monitor · 2nd AirPods 4 ANC | Experience must be AR/VR/XR |
| Sponsor | **Visa** — Reimagine Shopping with Generative AI | **$5,000** to the top team | GenAI commerce experience; secure, trusted payments |
| Sponsor | **Meta** — Bringing People Closer Together with AI | Top 3 → Round 2 at Menlo Park (travel + stay) + swag | Working prototype, **2–3 min demo video**, **public repo**, **short write‑up** (who it's for, how it strengthens connection, why AI is essential) |
| Sponsor | **NSA** — Packet Pursuit (side quest, opportunistic; separate folder `~/Downloads/nsa-packet-pursuit/`) | Xbox Series X / Xbox headset | Submit 5 flags; ties broken by time |
| MLH | Best Use of **Gemini API** | MLH swag kits | Meaningful Gemini use |
| MLH | Best Use of **ElevenLabs** | Wireless earbuds | Meaningful voice use |
| MLH | Best Use of **MongoDB Atlas** | M5Stack IoT kit | Atlas as data layer |
| MLH | Best Use of **Backboard** | Tile Essentials Pack | Backboard memory; promo code **`13HACKGT`** |
| MLH | Best **.Tech** Domain Name | Desktop mic + domain up to 10 yrs | Registered .tech domain |
| Auto | Grand prize | Canon G7X III / Switch 2 / iPad 11" | Present at Expo |
| Optional | Create‑X | Startup Launch interest | Tick the box at submission |

> Rule from the pre‑event packet: **one track only**, **any number of sponsor challenges** you genuinely qualify for (verified). Prizes are **picked up in person** after closing — not shipped.

---

## 3. Glossary (use these words everywhere — code, UI, pitch)

| Term | UI name | Meaning |
|---|---|---|
| **Trip** | Voyage | One planning session for one group. Has a lifecycle (see `trip.status`). |
| **Member** | Crew member | A human in the trip. Roles: `organizer`, `member`, `absent`. |
| **Brief** | Sealed Terms | A member's **private** input: budget cap, dates, must‑haves, dealbreakers, notes. Never shown to anyone else. |
| **Advocate** | Your Mate (their piece on the table) | The AI agent that represents exactly one member at the table. Knows only its own member's brief. |
| **Captain** | The Captain | The moderator agent. Sees no budgets — only fit yes/no signals. Keeps rounds short and forces a decision. |
| **Option** | Listing | A single flight, hotel, or activity from the dataset. |
| **Plan** | Chart | A candidate itinerary: 1 city + flights per member + 1 hotel + activities per day. |
| **Round** | Watch | One pass where every advocate speaks once. Max 3. |
| **Turn** | Line | One utterance from an advocate, the Captain, or a human interrupt. |
| **Interrupt** | Hail | A human speaking into the negotiation ("I'd pay more for the beach"). |
| **Shortlist** | The Two Charts | The top 2 plans the Captain puts forward. |
| **Dry Run** | Dry Run | The two plans playing out as miniature cities under glass, a day at a time. |
| **Fit** | Fits your terms ✓ | Deterministic check that a plan's share for a member ≤ that member's cap and violates no dealbreaker. |
| **Seal** | Set your seal | A member's approval + payment authorization for their share. |
| **Booking** | Logged in the ship's book | The all‑or‑nothing group transaction. Either every seal captures, or every seal is voided. |
| **Spectator** | Gallery | A laptop/TV view of the table for people without the headset (judges, video capture). |
| **Headset code** | Headset code | 8‑character code (no lookalike letters, valid 10 min, single use) on the Organizer's phone, typed at `<domain>/xr` to pair the Quest. Gives the headset controls but **no private data**. |
| **Standing instruction** | (pre‑signed seal) | An absent member's advance permission: "my mate may pay up to my terms for this voyage, next 24 h". |
| **Group moment / Pick** | — | Activities everyone attends vs. ones only members with a matching must‑have attend (doc 07 §6). |
| **Privacy tiers** | — | **Secret** (cap, share, fit) · **Discreet** (must‑haves, dealbreakers, note — only your own mate may paraphrase) · **Public** (doc 05 §7.0). |
| **Expo mode** | — | `EXPO_MODE=true`: ≤ 20‑word lines, faster voices, so the negotiation fits ~60–70 s. |

---

## 4. One‑screen architecture

```
 Quest 3 (Quest Browser, WebXR immersive-ar)      Phones (any browser)          Laptop (Spectator)
  three.js + 3DTilesRendererJS + troika text       Briefing, Table view, Seal    same scene, orbit camera
            │                                         │                             │
            └──────────────── Socket.io (WSS) ────────┴─────────────────────────────┘
                                     │
                         Node.js + TypeScript server ("the Helm")
      ┌────────────┬───────────────┬───────────────┬──────────────┬──────────────────┐
      │ Negotiation│ Fit & Pricing │ Payments      │ Voice        │ Memory           │
      │ engine     │ (deterministic│ orchestrator  │ ElevenLabs   │ Backboard        │
      │ (Gemini)   │  code, no LLM)│ (Visa VIC /   │ TTS + STT    │ (per-member)     │
      │            │               │  SIM mode)    │              │                  │
      └────────────┴───────────────┴───────────────┴──────────────┴──────────────────┘
                                     │
                             MongoDB Atlas (trips, members, briefs, options, plans, turns, seals, bookings)
```

---

## 5. Key dates & places (from the official packet/site)

| When | What | Where |
|---|---|---|
| Fri 2:00–3:35 PM (be early; docs disagree 3:35/3:45/4:00) | Check‑in — **Govt ID + Student ID required** | Ferst Theater, south entrance (drop big bags at Klaus first) |
| Fri 4–5 PM | Opening Ceremony (keynote Thomas Dohmke) | Ferst Theater |
| Fri 5:30–7 PM | Sponsor Fair — ask Visa/Meta/Hardware desk our open questions | Klaus Atrium 1F/2F |
| **Fri 8:00 PM** | **Hacking starts — one of us at the Hardware Desk for the Quest 3** | Klaus Atrium |
| Sat 10 AM | Visa tech talk | Klaus |
| Sat 2:30 PM | MLH workshop (likely Google AI Studio) | Klaus |
| Sat 3:30 PM | Meta tech talk | Klaus |
| **Sun 8:00 AM** | **Hacking ends / Devpost deadline** (we submit by 7:30) | — |
| Sun 9:00–11:15 AM | Expo / judging | Klaus Atrium |
| Sun 12:00 PM | Closing — **collect prizes in person** | Ferst Theater |

Help desk: Klaus Atrium · Emergencies: GTPD 404‑894‑2500 · MLH incidents: +1 (409) 202‑6060, incidents@mlh.io · Organizers: hello@hexlabs.org

---

## 6. Doc status (v1.1 final — Sep 24, 2026)

**Round 2 (Sep 25, 2026).** Docs 00–09 were re-synced with the as-built system after the round-2 fixes (18 work packages; see `docs/review-2/REVIEW-REPORT.md`, *Status after fixes*): passkey-free sealing with an optional *Add a passkey*, collect-then-settle seals, public group-total ranges and no public home airports, hails closed during the Captain's opening, the dev/demo exposure fixes, the single-writer lease and the new limits.

**Verified in the final review**
- All shares, group totals and fairness scores in doc 07 are pinned by the server test suite (`npm test`) (LIS $2,869 · MEX $1,975 · YUL $1,694; shares Rae $1,038 / Maya $868 / Dev $963 for the chosen Lisbon chart). These exact totals are internal: since round 2 the table, the Captain and every screen show only public ranges (Lisbon $2,650 to $3,100, Mexico City $1,550 to $2,100; S2-002), and each member sees only their own exact share.
- Every scheduled Dry Run stop starts inside its activity window; 2027‑03‑12 is a Friday (so Day 1 = Sat Mar 13).
- Every socket event used in docs 01/03/05/06/08/09 is defined in doc 04 §7; trip / booking / seal states match across docs 03, 04, 06.
- Example negotiation (doc 05 §12) = demo script (doc 09 §1) = checklist (doc 08 §7): hail at start of Watch 2, early exit, 8 voiced lines, Lisbon chosen.
- Palette contrast ratios computed (doc 02 §3.4).
- Personas use they/them; no budget number is spoken anywhere in the scripts.

**Still open — can only be filled after tonight's setup (doc 08 §1)**
| Item | Where it goes | Owner |
|---|---|---|
| Exact Visa Intelligent Commerce calls from `visa/mcp` + reference agent | doc 06 §4.3 table | B |
| Visa mode decision (A / B / C) | doc 06 §2, Devpost, pitch | B (Sat 2 PM) |
| ElevenLabs voice IDs (Captain + 4 bands) | `.env`, doc 05 §8 | A |
| Final `.tech` domain name | `.env`, doc 09 §6, `WEBAUTHN_RP_ID` | A |
| Answers to the Sponsor Fair questions | PRD §10 | both (Fri 5:30–7 PM) |
