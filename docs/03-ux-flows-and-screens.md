# 03 — UX Flows & Screens

Surfaces:
- **Q** = Quest 3 headset (Quest Browser, WebXR `immersive-ar`) — the Organizer
- **P** = Phone web app (every member, including the Organizer for their private Brief)
- **S** = Spectator/Gallery (laptop) — judges, audience, video capture

Trip lifecycle (`trip.status`, shared with docs 04/05/06):

```
BRIEFING → AT_TABLE → DRY_RUN → SEALING → BOOKED
                                 ▲            └──→ VOIDED
                                 └──(back to the charts)──┘
```
(A voyage is created straight into `BRIEFING`. `VOIDED` → `DRY_RUN` with the same two charts; a new pick starts a fresh booking attempt. A voyage can meet at the table at most `TABLE_RUNS_MAX` times (default 6). Canonical machine: doc 04 §5.)

```
```

---

## 1. End‑to‑end flow (demo path)

```
[P: Organizer] Create voyage ──► QR + join code
      │
      ├─► [P: Maya] scan QR ─► Join ─► Brief (sealed) ─┐
      ├─► [P: Organizer] Brief (sealed) ───────────────┤
      └─► [link: Dev (absent)] Brief (sealed) ─────────┤  (pre-done before demo)
                                                       ▼
[Q] Put on headset ─► Place chart on table ─► Crew arrives (all briefs sealed)
      │
      ▼
[Q/P/S] THE TABLE: Captain opens ─► Watch 1..3 (advocates speak; humans may Hail)
      │                                         
      ▼                                        
Captain: "Two charts" ─► bell ─► DRY RUN (2 cloches, tokens walk, red notes)
      │                          [P] private "Fits your terms ✓" per chart
      ▼
Pick a chart (grab cloche / majority tap) ─► SEALING
      │
      ▼
[P] each member: review share ─► Set your seal (a tap; Face ID only if they added a passkey) ─► seal "set"
      │   (nothing is charged or held yet; ~2.5 s after the LAST seal every share is authorized together)
      ├─ all authorized ─► capture ─► BOOKED (seals press, bell ×2)
      └─ any declined   ─► void all ─► VOIDED ("nobody was charged") ─► retry
```

---

## 2. Visibility matrix (who sees what)

| Data | Owner phone | Other phones | Quest (shared table) | Spectator | Server/LLM |
|---|---|---|---|---|---|
| Member name, color band | ✓ | ✓ | ✓ | ✓ | ✓ |
| Home airport | ✓ (they chose it) | ✗ | ✗ (one home-port rivet for the whole crew) | ✗ | Pricing only; not in any prompt (S2-002) |
| Brief exists (sealed icon) | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Budget cap** | ✓ | ✗ | ✗ | ✗ | Own Advocate prompt + deterministic fit code only; **never Captain** |
| Must‑haves / dealbreakers | ✓ | ✗ | ✗ (only as spoken, privacy‑safe paraphrase) | ✗ | Own Advocate only |
| Advocate spoken lines | ✓ | ✓ | ✓ | ✓ | ✓ (after privacy filter) |
| Fit for a Chart (✓/✗) | ✓ | ✗ | ✗ (only group‑level "fits everyone" once all fit) | ✗ | ✓ |
| My share amount | ✓ | ✗ | "— sealed —" until booked | ✗ | ✓ |
| Group total — public **range** from the listings only (e.g. "$2,650–3,100") | ✓ | ✓ | ✓ | ✓ | ✓ |
| Exact group total (Σ shares) | ✗ | ✗ | ✗ | ✗ | Server only (payments, fairness) |
| Plan moments (place; group moment vs "some of the crew" pick; group times exact, pick times an indicative layout) | ✓ | ✓ | ✓ | ✓ | ✓ |
| **My schedule** (which picks I attend, my legs, my arrival time) | ✓ | ✗ | ✗ (the scene walks anonymous group/pick beads only) | ✗ | ✓ |
| Seal status (pending/set) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Which seal declined | Owner only ("your seal didn't clear") | ✗ ("one share didn't clear") | ✗ | ✗ | ✓ |

> **Why per-member schedules are private:** with public listing prices, who attends which pick plus each member's landing time (→ their flight) rebuilds every share exactly and hints at must‑haves (SEC-001). The public plan therefore carries group-level moments only; each member's own day comes in `plan:private`.

> **Why only a range of the group total is shown (S2-002):** the exact total is the sum of the private shares, so with public listing prices it pins them together — for a two-person crew even a total rounded to $100 gave each share exactly. Home airports fix each member's flight price, and real pick times follow landing times; together they narrowed every share to a handful of values (the organizer's exactly). So the room gets only what the listings already imply: the lowest-to-highest total any crew of this size could have for this plan (same city, stay, window and picks), picks laid out at crew-independent times (dataset order from 9:00), flags read off the group route and the listings, and no airports. An attacker who reruns the open-source builder learns nothing beyond the listings (`plan-privacy.test.ts`). Each member sees their own exact share and real times in `plan:private`.

---

## 3. Phone screens (P)

All phone screens: ruled logbook paper, red margin line, Caslon headings, Plex Mono numbers (doc 02).

> Wireframe note: any emoji/symbols in these ASCII sketches (🎙 📯 ⚠ ✓ ◉ ⚑) are **placeholders** for the engraved SVG icons in doc 02 §6. The shipped UI uses no emoji.

### P0 — Landing (`/`)
```
┌────────────────────────────┐
│ ⚓  ALL AYES                │
│                            │
│ Everyone's in, or nobody   │
│ pays.                      │
│ Send your mate to the      │
│ table.                     │
│                            │
│ [ Start a voyage ]  (red)  │
│   Join with a code         │
│                            │
│ ─ how it works ─           │
│ 1 Seal your terms          │
│ 2 Mates argue it out       │
│ 3 Watch it run dry         │
│ 4 Everyone seals — or      │
│   nobody pays              │
└────────────────────────────┘
```
States: default · offline ("Lost the signal. Holding your place.")

### P1 — Create voyage (`/new`)
Fields: Voyage name ("Spring Break '27"), your name, your color band (4 swatches), preset (default: *Three Ports* — Lisbon / Mexico City / Montréal, Mar 12–16, 2027, 3 origins).
Primary: **Set sail** → creates trip (`BRIEFING`), goes to P2.

### P2 — Muster (invite) (`/t/:code/muster`)
```
┌────────────────────────────┐
│ SPRING BREAK '27           │
│ Muster your crew           │
│  ┌──────────┐              │
│  │  [ QR ]  │  Code: K7M2QX│
│  └──────────┘              │
│ Crew                       │
│ ▣ Rae (you)   ✉ unsealed   │
│ ▣ Maya        ✉ sealed 🔴  │  ← wax icon (SVG, not emoji)
│ ▣ Dev (away)  ✉ unsealed   │
│ [ + Add an absent friend ] │
│ [ Seal my terms ] (red)    │
└────────────────────────────┘
```
- "Add an absent friend" → name + band → copyable link `/t/:code/brief#m=:memberId&k=:inviteKey`. The key is in the fragment, so no server log sees it, and it is shown only this once. The phone strips it from the address bar on open (SEC-019). Opening it on the organizer's own phone is refused ("This invite is for your friend…"). Re-opening it on the phone that already claimed it just opens the voyage (TR1-002).
- Organizer: **Close the crew** / **Reopen the crew** under the Muster. A closed crew refuses joins by code ("The organizer has closed this crew"). Absent invites still work (SEC-010).
- Live updates via `trip:state` (sent after every join and sealed brief; its crew list carries `briefSealed`, never the terms).
- Absent friends who haven't opened their link keep an invite block (QR + copy line) even when the crew is full; if this tab no longer has the link, **Make a new link for X** re-issues it (the old one stops working) (TR1-001).
- Once a link is opened, everyone's crew list reads "(away, opened their invite)" and the organizer's Muster says "X has opened their invite" with **Wasn't X?** → confirm → **Reset X's seat**: whoever opened it is signed out, the seat's passkeys are revoked, and a fresh link is shown to send again (S2-012; BRIEFING or VOIDED; never the organizer's own seat). Sealed terms stay.

### P3 — Join (`/join` or via QR `/t/:code`)
Name, color band (taken bands disabled), **Join the crew** → P4.

### P4 — Sealed Terms (Brief) (`/t/:code/brief`)
```
┌────────────────────────────┐
│ YOUR SEALED TERMS          │
│ Only your mate sees this.  │
│                            │
│ All-in, I can do           │
│        ╭───────╮           │
│       ╱ brass   ╲          │
│      │  dial     │         │
│       ╲         ╱          │
│        ╰───────╯           │
│         $ 900              │  (Plex Mono)
│   [−50]           [+50]    │
│                            │
│ I can travel               │
│ [Mar 12–16 ✓] [Mar 13–16]  │
│                            │
│ Must have (up to 3)        │
│ (beach)(food)(nightlife)   │
│ (museums)(nature)(chill)   │
│ (history)(music)           │
│                            │
│ Won't do (up to 3)         │
│ (overnight flights)        │
│ (hostels)(2+ layovers)     │
│ (starts before 8am)        │
│ (long walks)               │
│                            │
│ Anything else?  🎙 hold    │
│ [______________________]   │
│                            │
│ [ Seal my terms ]  (red)   │
└────────────────────────────┘
```
- Dial range $300–$3,000, step $50; ± buttons; tap numeral to type.
- Chip ↔ code mapping (doc 04 §4.3): overnight flights = `red_eye`, hostels = `hostel`, 2+ layovers = `layovers_2plus`, starts before 8am = `early_start` (any activity start **or flight departure** before 08:00), long walks = `long_walks` (any walk > 25 min).
- If memory exists (P1 feature): banner "Remembered from your last voyage" + pre‑fill; each pre‑filled chip shows a tiny pencil mark.
- Validation: cap required; ≥ 1 date option.
- Submit → `brief:submit` → P5.

### P5 — Sealed (waiting) (`/t/:code/wait`)
Sealed‑letter illustration; "Sealed. Your mate knows what you can do." Crew list with seal statuses; hourglass for pending ones. Auto‑advance to P6 when `trip.status = AT_TABLE`.
- **Add a passkey** (optional, LIVE-001): a quiet link, shown only on phones that can hold a passkey (the same control sits under the seal button on the Brief). It only registers a passkey — never seals anything. Without it, the member later seals with a tap; with it, *Set your seal* asks for Face ID / Touch ID.
- **Organizer only:** when every Brief is sealed, a red **Weigh anchor** button appears → `table:start`. (This is the demo trigger; the Organizer can also pinch the Captain piece in the headset.)
- **Organizer only:** "Open on the headset" card shows the 8‑character **headset code** (doc 04 §6) to type at `<domain>/xr` in Quest Browser.
- **Organizer only, after 2 min with someone unsealed:** "Sail without them" (see §6).

### P6 — The Table (mirror) (`/t/:code/table`)
```
┌────────────────────────────┐
│ THE TABLE      Watch 2 of 3│
│   ┌──────────────────┐     │
│   │  top-down chart  │     │
│   │   ◉Rae  ◉Maya    │     │
│   │     (globe)      │     │
│   │   ◉Dev  ⚑Captain │     │
│   └──────────────────┘     │
│ Maya's mate is speaking    │
│ “Mexico City has no beach —│
│  the one thing my friend   │
│  asked for.”               │
│ ─ log ────────────────────│
│ 20:41 ⚑Captain  Four days… │
│ 20:41 ◉Rae      Mexico…    │
│ 20:42 ◉Dev      Food first…│
│                            │
│      ( 📯 hold to hail )   │  (brass trumpet button; SVG)
│  or type a hail: [_______] │
└────────────────────────────┘
```
- Current speaker's flag highlighted with brass ring; caption = full line.
- Hail: hold button → recording indicator (dividers walking) → release → transcript preview 1.5 s → sent. Text hail always available.
- The watch pill reads "Opening" while the Captain opens the table; the hail dock is off then ("The Captain is opening the table. Hail once the mates start speaking.", `TABLE_OPENING`) and opens at Watch 1.
- Disabled once Watch 3 starts or the Captain decides, with the note "Captain's calling it." A refused hail still counts toward the one-hail-every-5-s pace.

### P7 — Dry Run (`/t/:code/dryrun`)
```
┌────────────────────────────┐
│ DRY RUN        Day 1 · 09:00│
│ ┌───────────┐┌───────────┐ │
│ │ CHART A   ││ CHART B   │ │
│ │ Mexico Cty││ Lisbon    │ │
│ │ Roma Norte││ Alfama    │ │
│ │$1,550–2,100││$2,650–3,100│  (group total range: public)
│ │ ✓ Fits    ││ ✓ Fits    │ │  (private stamp, mine only)
│ │ your terms││ your terms│ │
│ │ ✗ no beach││ ⚠ 30 min  │ │  (my must-have miss: private;
│ │  (private)││ uphill walk│ │   walk flag: public)
│ │           ││ ⚠ overnight│ │
│ │           ││   flight  │ │
│ └───────────┘└───────────┘ │
│ Timeline (Chart B, Maya)   │
│ 08:30 Land LIS → Alfama    │
│ 15:00 Tram 28 & Castelo    │
│ 20:00 Fado · 30 min uphill │
│ ...                        │
│ [ Vote A ]   [ Vote B ]    │
└────────────────────────────┘
```
- Private stamp only for me. Group sees "Fits everyone" badge only if *all* fit (computed server‑side).
- Votes: `plan:vote`; Organizer can confirm with `plan:pick`.

### P8 — Your share & Seal (`/t/:code/seal`)
```
┌────────────────────────────┐
│ YOUR SHARE — LISBON        │  (Maya's phone)
│ Mar 12–16 · Casa Alfama    │
│ ─────────────────────────  │
│ Flight ORD⇄LIS     $520.00 │
│ Casa Alfama ⅓ ×4n  $280.00 │
│ Tram 28 & castle    $18.00 │
│ Fado night          $38.00 │
│ Cascais beach day   $12.00 │
│ ═════════════════════════  │
│ Your share         $868.00 │
│ Fits your terms ✓          │
│                            │
│ Paid by your mate's card,  │
│ capped at your terms.      │
│ If anyone's share doesn't  │
│ clear, nobody is charged.  │
│                            │
│ [ Set your seal ]  (red)   │
└────────────────────────────┘
```
- Tap → `seal:set`. No passkey on file → the tap itself sets the seal (sealing never starts a passkey registration, LIVE-001). A passkey added earlier → Face ID / Touch ID first; a cancelled prompt is a note ("Your passkey didn't go through, so your seal isn't set. Try again when ready."), never a seal. Copy under the button: "If you added a passkey, approve with Face ID or Touch ID. Otherwise this tap sets it."
- Status line: "Seal set — waiting on N seals" → once every seal is set, "Every seal is set · settling…" (the same for every outcome) → about 2.5 s later the result (S2-001). Nothing is held on the card before the last seal is set.
- While someone else's seal is still pending, a secondary **Lift my seal** link is shown → `seal:cancel`. The lift is private: everyone (the lifter's own seal row included) still sees the seal as set, and when the last seal is set the attempt voids at the settle point, nobody charged, no hold ever placed (the optional Expo decline demo). Once every seal is set, lifting is refused ("Too late to lift — every seal is set.").
- Organizer: **Call it off** (two taps) while seals are gathered; hidden once every seal is set (it would be refused with `CAPTURING`).
- Card for the cap shown as "Visa •••• 4242 (agent card, capped)" — sandbox/test card.

### P9 — Booked (`/t/:code/booked`)
Twine‑tied rolled chart illustration, "Logged. Nobody fronted a cent." Booking reference (Plex Mono), itinerary summary, per‑member "your share" (own only). Link: "Save to your log" (downloads .ics).

### P10 — Voided (`/t/:code/voided`)
Broken seal illustration. Shared copy: "One share didn't clear, so nobody was charged." Owner of the declined seal additionally sees a reason‑specific line (doc 06 §7): `over_limit` → "Your seal didn't clear: that share is over your agent card's limit." · `user_cancelled` → "You lifted your seal, so nobody was charged." · `timeout` → "The card network didn't answer in time." · `provider_error` → "The card network had a problem." Buttons (organizer only, L4-002): **Back to the charts** (→ DRY_RUN, same two charts) · **Adjust my terms** (→ P4; re‑opens BRIEFING and the table meets again). Members read "The organizer chooses what's next: back to the charts, or new terms for everyone."; their Brief is locked in VOIDED (the helm refuses a member's re-seal there with `BAD_PHASE`).

### Global states (all phone screens)
| State | Treatment |
|---|---|
| Loading | Dividers icon walking across a ruled line; text "Plotting…" |
| Offline / socket drop | Top paper strip: "Lost the signal. Holding your place." Auto‑retry every 2 s; queued actions replayed |
| Server error | Red margin note with plain sentence + "Try again" |
| Empty crew | "Nobody's aboard yet. Share the code." |
| Wrong phase (deep link to old screen) | Redirect to screen for current `trip.status` |

---

## 4. Quest scenes (Q)

Entry: in Quest Browser open `https://<domain>/xr` (short, easy to type in the headset) → type the 8‑character **headset code** shown on the Organizer's phone (P5) → the headset gets a **device token** with Organizer controls but **no access to anyone's private data**, including the Organizer's (doc 04 §7) → big paper card "Enter the chart room" → requests `immersive-ar` with required `local-floor`, optional `plane-detection`, `hit-test`, `anchors`, `hand-tracking`. Rationale: at Expo a judge wears the headset, so it must never render a share, cap or fit.

### Q0 — Placement
- Passthrough view. A faint ink ring follows the hit‑test point on horizontal surfaces.
- Card: "Find a table. Pinch to lay down the chart."
- Pinch/trigger → chart disc lays down (paper unroll animation 700 ms) → anchor created.
- Fallback (no plane detection): place 0.75 m in front of user at waist height −0.3 m; grab handle to adjust.

### Q1 — Muster on the chart
- Globe rises from the center (brass stand slides up 500 ms).
- City pins pop in with paper flags; one brass home-port rivet appears (the crew's airports are never public, S2-002).
- Crew pieces slide in from the chart edge as each Brief is sealed (if all sealed, all arrive in sequence 300 ms apart with wood clicks).
- If some briefs pending: pending pieces are **pencil outlines** with hourglass; caption: "Waiting on Dev's terms…"
- When all sealed: Captain piece rises at the compass rose with a small paper tag "Weigh anchor". The meeting starts when the Organizer taps **Weigh anchor** on their phone or pinches the Captain piece (`table:start`). No auto‑start — the Narrator controls timing at Expo.

### Q2 — The Table (negotiation)
Layout (top view, Organizer at south):
```
         Dev ◉                    ◉ Maya
 W  ⚑ Captain     (  GLOBE  )
    (compass rose)
                     ◉ Rae (you)
   ───────── caption strip (faces you) ─────────
```
- Speaker behavior per doc 02 §7.3: tip + slide + ink ribbon + voice; globe auto‑rotates to city in the line; pencil arcs from the home port.
- Compass rose shows Watch progress.
- **Hail:** pinch‑and‑hold on empty space ≥ 400 ms → a paper hail card with four set lines; pinch one to send it as the Organizer's hail. Free text or voice: use the phone.
- End: Captain line + bell; two pins get ink circles (the Two Charts); transition to Q3.

### Q3 — Dry Run
- Two cloches slide out left/right. The low‑poly paper city appears immediately; Google tiles then replace it tile‑by‑tile as they arrive (no cross‑fade — each tile simply "prints in"). If no tile arrives within 4 s, the low‑poly city stays.
- Brass clock between them starts: 08:00 → 23:00 on Day 1 in 60 s (1 s = 15 min); both cloches run in sync, and every device shows the same minute (the clock is shared and persisted). Control: pinch the clock to pause/resume. There is no day jump.
- Stops outside the cloche (Cascais, Belém, Frida Kahlo museum, Xochimilco) appear as edge arrows on the rim with travel time; beads walk to the rim and wait (doc 02 §7.6).
- Unlabeled ink beads walk the group route (one neutral bead per pick); no band colours or names, because the public plan never says who goes where (SEC-001). Each member's own schedule is on their phone.
- A paper tag under each cloche: city · hotel · group total range (public, e.g. "$2,650–3,100"). Picks walk at the public plan's indicative times, not the crew's real ones (S2-002).
- "Fits everyone ✓" brass plaque appears on a cloche only if every member fits.
- Pick: pinch a cloche (it lifts; the other slides back), or the organizer picks on the phone; a clear majority of phone votes auto‑picks after a countdown. → Q4.

### Q4 — Seal ceremony
- Chosen chart unrolls in front of Organizer: title, dates, city, and one line per member with "— sealed —" amount.
- As each `seal:status = AUTHORIZED` ("set") arrives, a wax seal drops on that line; an absent member's standing seal is pressed from `booking.seals[].standing`.
- `BOOKED`: chart rolls up, twine ties with a paper tag carrying the booking reference, bell ×2, the route arcs on globe turn to solid ink; caption "Logged. Nobody fronted a cent."
- `VOIDED`: every seal lifts together (nobody's seal is singled out, SEC-002), caption with the public reason ("One share didn't clear…", "Not every seal was set in time…", "The organizer called it off…"; always "nobody was charged" or "Refunded"). Card: "Back to the charts".

### Q5 — Menu (always available)
Opened by: left palm up for 600 ms, **squeeze** (grip) on either controller, or pinching the small brass ship's wheel on the chart's south‑east edge. In the laptop view: the **Menu** button in the toolbar. Items: *Recenter chart* · *Captions: S / M / L* (0.85 / 1 / 1.3) · *Reduce motion* · *Sound: on/off* (mutes voices **and** effects; there is no separate ambience toggle) · *Debug* (fps, draw calls, socket, last event) · *Exit*.

### Quest interaction summary (as built — TR2-013)
Quest Browser turns a hand pinch into a WebXR `select`, so hands and controllers share one code path.

| Input | Hands | Controllers | Laptop view |
|---|---|---|---|
| Place chart | Pinch on the surface | Trigger | — (placed automatically) |
| Weigh anchor (`table:start`) | Pinch the Captain's tag / piece | Trigger | Click |
| Hail | Pinch‑hold ≥ 400 ms on empty space → hail card with four set lines (*I'd pay more for the beach.* · *Let's keep it cheap.* · *Food matters most to me.* · *Nothing too early, please.*) + Cancel. Free text or voice: from the phone | Hold trigger ≥ 400 ms | Still press ≥ 650 ms, or the **Hail the table** button |
| Pick a chart (`plan:pick`) | Pinch a cloche (it lifts; lowered again if the helm refuses) | Trigger | Click |
| Pause / resume the clock | Pinch the carriage clock | Trigger on clock | Click |
| Back to the charts (VOIDED) | Pinch the card button | Trigger | Click |
| Menu | Palm up, or pinch the brass wheel | Grip (squeeze) | **Menu** button |
| Orbit the view | — | — | Drag (> 6 px cancels the click / hail) |

Not built (the earlier design): rotating the globe by hand (it only turns itself to the city being discussed), grab‑and‑lift of a cloche, swiping the clock to jump days (`dryrun:control` accepts `pause`/`resume`/`restart`, and only pause/resume are sent), a speaking‑trumpet hail with free text, a headset call‑off or crew‑close control (the server accepts both from the paired headset; only the phone has buttons). The headset shows server refusals on the caption card in red for 3 s. The Weigh‑anchor tag appears only with ≥ 2 crew, and the hail card only while the table is running.

---

## 5. Spectator (S) — `/t/:code/gallery`
- Full‑screen three.js scene (same components, non‑XR), slow orbit camera, paper subtitle strip at bottom (speaker name + line), top‑right: Watch indicator + trip status.
- Keyboard: `Space` pause orbit, `1/2/3` camera presets (overhead / Organizer POV / close on speaker), `0` back to the orbit, `C` toggle captions. A failed table (`table:failed`) is not shown as an error here.
- Used for: judges watching while one wears the headset, the Meta video, and **full fallback demo** if no Quest.

---

## 6. Error & edge cases

| Case | Handling |
|---|---|
| A member never seals Brief | Organizer can "Sail without them" after 2 min → that member is **removed from this voyage** (not travelling, not charged, no piece at the table); plans are priced for the remaining crew. They can be re‑added before the table starts. Demo: never happens (Dev is pre‑sealed). |
| No plan fits everyone | Captain says so (privacy‑safe): "No chart fits every purse. Closest two:"; Dry Run shows red "Over" stamps privately; members can adjust terms. |
| Agents disagree through Watch 3 | Captain decides by maximin fairness score (doc 05 §5). Always ends. |
| Hail during Captain's closing line | Refused, not queued: from Watch 3 / the DECIDE the phone shows "Captain's calling it. Hails are closed for this table." and keeps the words in the box. One pending hail per member ("Your mate still has your last hail…"). |
| Quest session ends/crashes | Re‑enter `/xr` → scene restores from `trip.status` + last events (server is source of truth). |
| Tiles fail to load | Low‑poly fallback city, same routes. |
| Voice fails | Captions continue; pieces still tip; log still updates. |
| Payment API timeout | The seal reads "set" at its tap (the outcome is never public). Authorizations start only once every seal is set; one with no answer after 15 s is treated as DECLINED → void all → VOIDED ("nobody was charged"), published for everyone together (later than the usual 2.5 s settle point); only its owner learns why. |
| Seals never all set | The attempt voids at the seal deadline (default 10 min; the phone shows "Seals close in 9:41", on its own clock corrected by the server's `serverNow`). The organizer can **Call it off** (two taps) until every seal is set. |
| Duplicate seal tap / late lift | Idempotency key per member per booking attempt (doc 06); a second tap is refused `SEAL_LOCKED` ("Your seal is already set."), and lifting once every seal is set is refused ("Too late to lift — every seal is set."). |
| Phone's seat token no longer works | The join is refused with `TOKEN_REJECTED` (the seat was reset, or the invite was opened on another phone): the phone watches as a spectator and shows "This phone's key for the voyage no longer works, so it can only watch." + **Join again**. |
| Headset pairing ended | `DEVICE_EXPIRED` (a newer pairing, unpaired from the organizer's phone, or past 12 h): the headset forgets its key and shows the pairing card again. |
| Voyage still loading | `LOADING` (an archived voyage being fetched, or MongoDB reconnecting): "Fetching the voyage from the ship's log…" and the join is retried after 1, 2, 4, 8, then every 10 s. |
| Too many tables | After `TABLE_RUNS_MAX` meetings (default 6): "The table has met enough times for this voyage." (`TOO_MANY_RUNS`). |
