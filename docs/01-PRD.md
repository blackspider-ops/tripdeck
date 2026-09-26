# 01 — Product Requirements Document: All Ayes

| Field | Value |
|---|---|
| Product | All Ayes |
| One‑liner | Everyone's in, or nobody pays. (Descriptor: send your mate to the table.) |
| Event | HackGT 13 — Seaside Market (Sep 25–27, 2026) |
| Team | 2 (Person A: XR + design + data · Person B: agents + backend + payments) |
| Track | The Lighthouse Laboratory (Immersive AR/VR/XR) |
| Status | Final pre‑build spec, v1.1 (Sep 24, 2026) — reviewed for cross‑doc consistency |
| Related | 02 design · 03 UX · 04 tech · 05 agents · 06 payments · 07 data · 08 build · 09 demo |

---

## 1. Problem

Group trips die in the group chat. Research and reviews of the category point to four repeatable failure points:

1. **Budgets don't match, and nobody wants to say so.** One friend can do $100/night, another $300. Saying "too expensive" in front of an already‑excited group feels bad, so people either go quiet, over‑spend, or drop out late. Group‑chat spending pressure is a documented pattern: once everyone has reacted enthusiastically, nobody can quietly walk it back.
2. **Analysis paralysis.** Many destinations × many hotels × many activities × many people = decision fatigue. Threads go long and interest dies.
3. **Hard tradeoffs are invisible.** Tools organize ideas but don't help people *feel* tradeoffs ("cheaper hotel, but a 40‑minute walk every morning"). Mindtrip's 2026 reviews single this out: great for visual planning, "light for hard trade‑offs"; "the decision load remains theirs".
4. **One person fronts the money.** Someone books everything and then chases Venmos for weeks. Splitwise and friends settle *after* the money has been spent; the fronting problem remains.

And one research finding shapes our solution: multi‑agent group travel negotiation papers (MIND, GroupTravelBench, 2026) find that LLM agents often **fail to compromise at all** — in one benchmark **67% of tasks received zero compromises**. A naive "let the AIs talk" product loops forever. We need structure.

### 1.1 Who has this problem
- College students and young professionals planning spring break, reunions, bachelor/bachelorette trips, friend getaways.
- Friend groups spread across cities (different origins → different flight costs → budget friction is worse).

---

## 2. Solution summary

All Ayes turns trip planning into a short, structured, *visible* negotiation between personal agents, finished by a group checkout that is safe for everyone.

| Pillar | What happens | Why it's different |
|---|---|---|
| **Sealed Terms (Brief)** | Each member tells *their own* agent their real cap, dates, must‑haves, dealbreakers — privately on their own phone. | The group never sees anyone's number. |
| **The Table** | In a VR chart room on an iPhone clamped into a Samsung Gear VR shell, a paper globe sits on a chart table in front of you. (On a Quest 3 the same table lands on your real table in mixed reality; stretch.) Each member's Advocate is a carved piece; they speak (ElevenLabs voices), propose, object, concede. Humans can Hail in. The Captain forces a decision within 3 Watches. | One advocate **per person**, negotiating visibly. Competitors use one central AI. Structured protocol fixes the "agents never compromise" problem. |
| **Dry Run** | The top two Charts appear as miniature cities under glass cloches (Google Photorealistic 3D Tiles). Each member's token walks the day; a brass clock ticks; long walks ink in red; each member privately sees "fits your terms ✓". | You *see* tradeoffs before paying. Not found in any product. |
| **The Seal (all‑or‑nothing)** | Each member approves their own share on their own phone (a tap, or their passkey if they added one). Each share is paid by a **Visa agent token capped at that member's private limit**. Once every seal is set, all shares are authorized together; only if every one authorizes do we capture; any decline voids everyone, and nobody learns whose it was. | Nobody fronts money. Uses Visa Intelligent Commerce primitives (agent tokens, spending controls, passkeys). No consumer group‑trip app does this. |
| **Absent friend** | A member who can't join live still has an Advocate at the table speaking for them. | Includes people, not just the loudest in the room. |
| **Memory** | Advocates remember each member across trips (Backboard). | "Last time you hated 6 AM flights." |

---

## 3. Goals, non‑goals, success

### 3.1 Goals (hackathon)
- G1. Win **Lighthouse (1st)**, **Visa ($5k)**, **Meta (top 3)**, and as many MLH prizes as qualify; be a grand‑prize contender.
- G2. A **reliable 3‑minute demo** that works first try at Expo, with a no‑headset fallback.
- G3. Every sponsor sees *their* tech doing essential work, not decoration.

### 3.2 Non‑goals (explicitly out of scope)
- Real airline/hotel inventory or real bookings. Industry agents in 2026 still only book reliably inside bounded ecosystems; multi‑supplier booking is unsolved. We use a **curated dataset** (doc 07) and say so honestly.
- Real money. Visa **sandbox** only (or clearly labeled simulation).
- Accounts/auth beyond a trip join code. No password system.
- More than 12 members (the organizer + up to 11, absent friends included: `MAX_CREW`), more than 4 candidate ports on one chart, more than 3 date windows. A crew larger than a stay sleeps books several rooms/units of the same stay (doc 05 §2); the Expo crew is 3.
- Native Quest, Gear VR (Oculus Mobile) or iOS app / Unity. Web only: the headset iPhone runs our page in Safari through webxr-polyfill (doc 10).
- Android/iOS native apps. Phones use the web.

### 3.3 Success metrics (measured at Expo)
| Metric | Target |
|---|---|
| Demo end‑to‑end run time | ≤ 3:00 |
| Demo success rate in rehearsal (last 5 runs Sat night/Sun morning) | 5/5 |
| Negotiation completes | ≤ 3 Watches, ≤ 90 s wall clock (Expo run: ≤ 70 s, 8 voiced turns) |
| Voice latency (turn text ready → audio starts) | ≤ 1.5 s p50 |
| Budget leaks (any member's cap spoken/shown to others) | **0** (enforced by filter, doc 05 §7) |
| Prices not from dataset (hallucinated) | **0** (validator, doc 05 §7) |
| Judge understands the pitch in first 20 s | Yes (test on 3 strangers Sat night) |
| XR frame rate on the headset iPhone (16 Pro, polyfill Cardboard mode) | ≥ 60 fps in Table scene; ≥ 45 fps in Dry Run with *Photoreal cities* off (on a Quest 3: ≥ 72 / ≥ 60) |

---

## 4. Personas

### P1 — The Organizer ("Rae", in the headset)
- Gets the group going. Usually ends up fronting money.
- Wants: momentum, a fair plan, no chasing payments.
- Uses: the headset (iPhone in the Gear VR shell: Table, Dry Run, Seal ceremony, by looking) + own phone for their Brief, *Weigh anchor*, the pick and the seal.

### P2 — The Budget‑Tight Friend ("Maya", on a phone)
- Has a real cap ($900 all‑in — the tightest in the Expo crew, doc 07 §8). Doesn't want to be "the poor one".
- Wants: a trip they can afford **without announcing it**.
- Uses: phone only (Brief, Table view, Dry Run cards, Seal).

### P3 — The Absent Friend ("Dev", not present)
- Busy/at work/in another time zone. Normally gets left out and then complains.
- Wants: to be represented and to approve at the end.
- Uses: Brief earlier via link; Seal later via link (or in the demo, pre‑authorized within cap).

> Pronoun note: personas are fictional; use "they/them" in all copy.

---

## 5. User stories & acceptance criteria

IDs are referenced in doc 08 tasks. **P0 = must ship for demo**, P1 = ship if time, P2 = stretch.

### Epic A — Voyage setup
| ID | Story | Acceptance criteria | Pri |
|---|---|---|---|
| A1 | As the Organizer, I create a Voyage and get a join code/QR. | `POST /api/trips` returns `tripId` + 6‑char `joinCode`; QR visible on the Organizer phone; trip `status=BRIEFING`. | P0 |
| A2 | As a member, I join from my phone by scanning the QR or typing the code. | Phone shows my crew slot, I pick a name + color band (12 bands, one per seat; the 13th join is refused `CREW_FULL`); every client gets the updated crew in `trip:state` within 1 s (there is no separate `member:joined` event). The organizer can close the crew to further joins by code. | P0 |
| A3 | As the Organizer, I add an absent member with a share link. | Absent member gets `role=absent`, link (`/t/CODE/brief#m=…&k=…`, key in the fragment, shown once) opens Briefing directly; the organizer can re-issue it until it's opened. | P0 |
| A4 | As the Organizer, I pick candidate cities (default 3 from dataset). | Cities list stored on trip; appears as ink pins on the globe. | P1 (default preset is P0) |

### Epic B — Sealed Terms (Brief)
| ID | Story | Acceptance criteria | Pri |
|---|---|---|---|
| B1 | I set my all‑in budget cap privately with a brass dial. | Value stored only in `briefs` (member‑scoped); never emitted on any shared channel; UI says "Your terms stay sealed." | P0 |
| B2 | I set dates I can travel. | Date range chips; stored in brief. | P0 |
| B3 | I choose must‑haves and dealbreakers from chips + free text. | Up to 3 must‑haves, 3 dealbreakers; free text ≤ 200 chars. | P0 |
| B4 | I can record a 20 s voice note instead of typing. | STT transcript shown for confirmation before sealing. | P1 |
| B5 | I see that my Advocate remembers me from last time. | If memory exists, Briefing pre‑fills + shows "Remembered from your last voyage" note. | P1 |
| B6 | Everyone sees *that* I've sealed, never *what*. | Shared UI shows a wax seal icon next to my name; content never leaves server. | P0 |

### Epic C — The Table (negotiation)
| ID | Story | Acceptance criteria | Pri |
|---|---|---|---|
| C1 | As the Organizer, I put on the headset (iPhone in a Gear VR shell) and I'm sitting at the chart table in a VR chart room. | After **Enter VR** (iOS asks for motion access) the table is already in front of me at a fixed seated pose (no placement); a gaze reticle shows what I'll select and a 1.6 s dwell selects; **Recenter** (menu, or a 3.2 s gaze on the ship's wheel) puts the table in front of wherever I face; the red **Exit VR** plaque below the table leaves VR. Safari has no WebXR, so the webxr-polyfill Cardboard mode gives the view (`?vr=cardboard` forces it elsewhere). | P0 |
| C1b | On a Quest 3, I place the chart table on my real table in MR. | Plane detection finds horizontal surface; pinch to place; anchor persists for session. | P2 (stretch, only if a Quest turns up) |
| C2 | When all briefs are sealed, the crew pieces arrive around the globe. | One piece per member incl. absent; each piece has member's color band + name flag. | P0 |
| C3 | The Captain opens with group‑level constraints only. | Opening line mentions shared dates + candidate cities; contains **no** individual numbers. | P0 |
| C4 | Advocates take turns proposing/objecting/conceding with voices. | Each turn ≤ 35 words (≤ 20 in Expo mode), typed (`PROPOSE`/`OBJECT`/`CONCEDE`/`SUPPORT`), references a plan id; voice plays; ink ribbon caption renders. | P0 |
| C5 | Budgets never leak. | Automated filter redacts; 0 leaks across 20 scripted runs. | P0 |
| C6 | I can Hail (interrupt) by voice. | Push‑to‑talk (phone button; in the headset, dwell on the "Hail the table" tag → set hail lines) → transcript turn → Advocates respond next Watch. Max 2 Hails per Watch. | P1 (text Hail from phone = P0) |
| C7 | Negotiation always ends. | Hard cap 3 Watches; Captain names The Two Charts; bell sound; `status=DRY_RUN`. | P0 |
| C8 | Phones mirror the Table. | Phone shows 2D chart with pieces, current speaker highlighted, caption. | P0 |

### Epic D — Dry Run
| ID | Story | Acceptance criteria | Pri |
|---|---|---|---|
| D1 | Two cloches appear with the two Charts' cities. | Google Photorealistic 3D Tiles (or low‑poly fallback) clipped to a disc under glass. | P0 (fallback acceptable) |
| D2 | The day walks under the cloche; a brass clock ticks. | 1 real second = 15 in‑trip minutes; route segments from dataset walking times. As built the shared scene walks the group-level day (anonymous beads, public indicative times, S2-002); each member's own day is on their phone. | P0 |
| D3 | Long walks and early starts are flagged. | Segments > 25 min or starts < 8:00 inked in Sounding Red with a margin note. | P0 |
| D4 | Each member privately sees fit for each Chart. | Phone shows "Fits your terms ✓" / "Over your terms by a little" (no numbers to others). | P0 |
| D5 | The group picks one Chart. | Organizer taps on their phone (safest), or holds their gaze 1.6 s on a cloche in the headset; majority of members' taps within 20 s or Organizer decides. | P0 |

### Epic E — The Seal (checkout)
| ID | Story | Acceptance criteria | Pri |
|---|---|---|---|
| E1 | I see my exact share before sealing. | Line items for my flight + my hotel share + my activities; total; "within your terms ✓". | P0 |
| E2 | I approve on my own phone, with a passkey if I want one. | As built (LIVE-001): the confirm tap on *Set your seal* seals; sealing never pops a passkey-registration sheet. **Add a passkey** (Wait/Brief, optional, phones with a platform authenticator) registers one; from then on *Set your seal* asks for Face ID/Touch ID, and a cancelled prompt never seals. | P0 confirm tap · P1 optional passkey |
| E3 | My share is authorized by my agent token capped at my limit. | Visa VIC sandbox call (or SIM mode) returns `AUTHORIZED` / `DECLINED`. | P0 |
| E4 | All‑or‑nothing. | Seals are collected first (a "set" places no hold); ~2.5 s after the last one, every share is authorized together (doc 06 §4.2, S2-001). If all `AUTHORIZED` → capture all → `BOOKED`. If any `DECLINED` (or the seal deadline passes, or the organizer calls it off) → void all holds → `VOIDED`, nobody charged; UI explains which step failed (not whose budget, and not whose seal). A failed capture refunds what was captured. | P0 |
| E5 | The group sees seals land on the table. | Wax seals press onto the Chart one by one as members tap (a lifted seal looks set too); a moment after the last one, the bell on `BOOKED` or every seal cracks together on `VOIDED`. | P0 |
| E6 | Absent member can seal later. | Seal link; demo uses pre‑authorized absent seal within cap. | P1 |

### Epic F — Spectator & capture
| ID | Story | Acceptance criteria | Pri |
|---|---|---|---|
| F1 | Judges/audience watch on a laptop. | `/t/:code/gallery` renders the same scene with an orbiting camera, synced. | P0 |
| F2 | We can record the Meta video without casting. | Spectator view is screen‑recordable at 1080p. | P0 |

### Epic G — Memory
| ID | Story | Acceptance criteria | Pri |
|---|---|---|---|
| G1 | After booking, each Advocate saves what it learned. | Backboard write per member: preferences, what they conceded, satisfaction. | P1 |
| G2 | Next voyage, Advocate uses it. | Briefing pre‑fill + Advocate references it in first turn. | P1 |

---

## 6. Feature priority summary

| P0 (demo cannot happen without) | P1 (big polish, do if on time) | P2 (stretch) |
|---|---|---|
| Voyage + join + 3 members incl. absent | Voice Hail via push‑to‑talk | Quest 3 mixed reality on a real table; hand‑gesture voting (grab a pin) |
| Private Briefs + privacy filter | Voice‑note Brief | Surprise Mode (hidden destination reveal) |
| Table scene + pieces + voices + captions | Passkey (WebAuthn) seal | Live flight prices |
| 3‑Watch protocol + Captain + deterministic fit | Backboard memory across voyages | Colocated second headset |
| Dry Run (2 cloches, walking tokens, red flags) | Photoreal tiles (vs low‑poly fallback) | Multi‑language voices |
| All‑or‑nothing Seal via Visa sandbox or SIM | Decline‑then‑retry path | |
| Phone mirror + Spectator view | | |
| MongoDB persistence, .tech domain | | |

---

## 7. Competitive landscape (researched Sep 24, 2026)

| Product | Has | Lacks (vs All Ayes) |
|---|---|---|
| Mindtrip | Group chat with AI balancing preferences; flight (May '26) + stay (Jul '26) booking | No private budgets, no per‑person agents, no tradeoff visualization, no VR/MR, one person pays |
| Nowah (early, blog Aug 1 '26) | Private 1‑on‑1 preference/budget collection; proposes fair splits at booking | Single central agent, no agent payments per member, no all‑or‑nothing, no 3D; founder: "we are not there yet" |
| Wooorld (Quest) | Social 3D world map in MR, voice chat, AI guide | No planning, booking, budgets, payments |
| Geo Voyage (Quest) | Spin a 3D globe in MR, drop pins | Exploration only |
| WePlanify / Troupe / SquadTrip / Wanderlog | Polls, shared itineraries, expense tracking | 2D, manual voting, post‑hoc splitting |
| Splitwise | Post‑trip settlement | Someone already fronted the money |
| Trip.com TripGenie + Mastercard | Agent that pays | Single user, attractions only, broader rollout 2027 |
| MIND / GroupTravelBench (papers) | Multi‑agent negotiation research | Research only; agents rarely compromise |

**Our unique combination:** per‑person Advocates negotiating visibly (with a protocol that forces compromise) + Dry Run tradeoff simulation in VR + all‑or‑nothing group checkout with per‑member capped agent tokens.

---

## 8. Prize strategy (how each judge sees "their" thing)

| Prize | What they will literally see in the demo | Talking point |
|---|---|---|
| **Lighthouse** | A VR chart room on an iPhone in a Gear VR shell: carved pieces around you, ink ribbons, cloched cities, wax seals; the Gallery projects the same scene for the room. | "VR is how the group *sees* the tradeoff together, and it runs on a phone and a lens shell people already own." |
| **Visa** | Per‑member agent token with cap, passkey approval, all‑or‑nothing capture/void, a live decline demo. | "Agentic commerce for groups: trusted, capped, nobody fronts money." |
| **Meta** | Three friends (one absent) reach a plan with no awkward budget talk; AI is the crew — remove it and the product disappears. | "Connection without the money awkwardness; absent friends still have a voice." Requires video + repo + write‑up (doc 09). |
| **Gemini** | Every Advocate + Captain are Gemini calls with JSON‑schema structured outputs over a priced chart book (function‑calling tools in P1 "deeper" mode, doc 05 §6.3). | Structured outputs; model chooses and argues, code does the math. |
| **ElevenLabs** | Distinct voice per crew member; captions synced. | "The table *sounds* like a table." |
| **Backboard** | Advocate remembers a member's last voyage. | Promo `13HACKGT`. |
| **MongoDB Atlas** | Trip state machine, turns log, seals, bookings. | Change‑stream‑friendly state (optional). |
| **.Tech** | `allayes.tech` (fallback `getallayes.tech`) serving the app. | |
| **Grand** | Real problem + 3 novel mechanics + unforgettable demo. | |

---

## 9. Constraints & assumptions
- **Hardware:** we could not get a Quest 3, and we have no Galaxy phone. The headset is an **iPhone 16 Pro** (iOS 18, Safari) clamped into a **Samsung Gear VR shell** used only as a lens viewer: no USB plug, so the shell's touchpad and Back button do nothing. VR only (no cameras, no passthrough), 3DoF head tracking from the phone's motion sensors (iOS asks for motion access on **Enter VR**). Safari has no WebXR, so the page runs webxr-polyfill's Cardboard mode (side by side, Cardboard lens values, adjustable lens spacing). All headset input is gaze: reticle + 1.6 s dwell. The organizer's phone drives picks and seals. Full setup: doc 10 (with an appendix for a borrowed Galaxy phone, which would add the touchpad).
- **Quest 3 (optional):** if one appears, `/xr` still opens `immersive-ar` with plane detection, hit test, anchors and hand tracking in Quest Browser. Camera access is not used on any headset.
- **Team of 2, 36 hours.** Every P0 must be buildable by 2 people; see doc 08 cut lines.
- **Network:** venue Wi‑Fi may be poor → phone hotspot backup; all demo audio can be pre‑cached (doc 04 §13, "Demo mode cache").
- **Privacy tiers** (enforced in code, doc 05 §7): **Secret** = cap, share, headroom, fit — never leaves the owner's phone/own Advocate. **Discreet** = must‑haves, dealbreakers, note — only the member's own Advocate may voice them, paraphrased. **Public** = listings, group-total *ranges* (what the listings imply; the exact total is the sum of the shares, so it stays with the helm — S2-002), crew names, seal status. Home airports are not public.
- **Honesty:** inventory is curated; payments are sandbox/simulated; say so on Devpost.

## 10. Open questions (ask at Sponsor Fair, Fri 5:30–7 PM)
| # | Question | Ask whom | Why it matters |
|---|---|---|---|
| Q1 | Do you expect Visa Intelligent Commerce sandbox, or is a faithful simulation OK? | Visa table | Decides how much time goes to real API integration |
| Q2 | How many Quest 3s, when does the desk open, can we keep it all weekend? | Hardware desk | Answered: none for us. We run an iPhone in our Gear VR shell (doc 10) |
| Q3 | Can one project win a track + sponsor prizes + grand? | Organizers | Stacking strategy |
| Q4 | For Meta: does the video need voiceover? Any length tolerance? | Meta table | Video plan |
| Q5 | Any Aramco/other challenge we're missing? | Organizers | Free extra entries |

## 11. Risks (top 5; full register in doc 08)
1. Headset iPhone fails (motion access denied, double image, overheats) → reopen the tab and allow motion, **Lens spacing** / `?ipd=`, cool it down, or the Gallery; track weaker only if the headset can't run at all.
2. Visa sandbox onboarding slow → SIM mode with identical UX, labeled.
3. Agents loop or leak → deterministic scorer + Captain + output filter.
4. 3D Tiles quota/billing issue → low‑poly procedural city fallback.
5. Voice latency → streaming TTS + pre‑generated demo lines.
