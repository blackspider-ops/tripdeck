# 09 — Demo, Pitch & Submission Kit

Roles at Expo: **Person A = Narrator** (talks, hands the judge the Gear VR, helps them sit and recenter). **Person B = Operator** (phones, laptop, seeds trips, watches `/api/debug/<code>`; off the machine running the helm it asks for the DEV_KEY once).

---

## 1. The 3‑minute Expo demo

Setup before each judge: fresh seeded trip (`/demo` → *Seed the Expo voyage*; in production or through the tunnel open `/demo#key=<DEV_KEY>` once — the key moves to this tab's session storage and leaves the address bar; `?key=` doesn't work), Gear VR phone paired via headset code (**Show headset code** on Rae's phone → `<domain>/xr`), **Enter VR** tapped, phone in the headset and the table recentered, laptop showing the Gallery **on the projector / turned to the judges**, Maya's phone + Rae's phone on the table. Set `EXPO_MODE=true` (≤ 20‑word lines, faster voices).

| Time | Narrator (A) says | Operator (B) does | Judge sees |
|---|---|---|---|
| 0:00–0:15 | "Every friend group has a chat where the trip dies. Nobody wants to say *that's too expensive*, and one person ends up fronting two grand and chasing Venmos for a month." | — | The chart room on the projected Gallery |
| 0:15–0:35 | "So each friend gets their own mate. Maya told theirs exactly what they can spend — and that number never leaves Maya's phone. Not to us, not to the other mates, not to the Captain. Dev couldn't come — their mate's here anyway." | Shows Maya's phone: sealed letter "Your terms stay sealed" | Wax‑sealed crew list |
| 0:35–0:45 | "Sit down and put this on — you're at the table. Look at something and tap the side to choose it." | Hands the wiped Gear VR; Rae's phone taps **Weigh anchor** | Judge in VR: globe, three carved pieces, Captain. Everyone else: the same scene on the projector |
| 0:45–1:55 | (quiet — let the crew talk; one line mid‑way:) "Watch Maya's mate — it's arguing for Maya without ever saying a number." Right after the third proposal (~1:10): "You're Rae. Tell them: *I'd pay more for the beach*." | If the judge doesn't speak, types the hail on Rae's phone | Pieces tip, ink ribbons, voices; hail caption; "Heard you, Rae…"; Captain's bell; "Two charts. Run them dry." |
| 1:55–2:20 | "Now the part no trip app does: you can *see* the tradeoff before you pay. Mexico City leaves more in everyone's pocket. Lisbon covers everything — but look, a 30‑minute uphill walk and overnight flights." | Shows Maya's phone: "Fits your terms ✓" on both, "no beach" on Mexico City | Two cloches, beads walking, red margin notes |
| 2:20–2:28 | "Maya really wants that beach. Pick Lisbon — look at the cloche and tap the side." | If the judge is stuck, picks on Rae's phone | Judge lifts Lisbon cloche (tap or 1.6 s gaze) |
| 2:28–2:52 | "Each friend sets their seal. Each share is paid by a **Visa agent card capped at that friend's own terms**, approved on their own phone. And here's the rule: **nothing is charged until every seal is set — and if any share doesn't clear, nobody is charged.**" *(Say "with a passkey" only if the seeded phones added one: sealing is a plain tap unless a member tapped **Add a passkey** on the Wait screen beforehand.)* | Dev's seal presses on its own (standing instruction); taps Set your seal on Rae, then Maya (a tap each; no passkey sheet) | Wax seals press one by one; Maya's phone reads "Every seal is set · settling…"; about 2.5 s after the last seal → bell ×2 → "Logged. Nobody fronted a cent." (leave a beat of silence for the settle) |
| 2:52–3:00 | "All Ayes. Everyone's in — or nobody pays." | Re‑seeds, new headset code | — |

### Optional +20 s (if judge is from Visa or asks "what if someone can't pay?")
Dev's standing seal is set at once. Operator taps **Set your seal** on Maya's phone, then **Lift my seal** (it only shows while someone else is still open, so do it **before** Rae seals). Nothing visible happens: Maya's seal still reads "set" to everyone, and nothing voids yet (a lift is private and looks exactly like a set seal). Then tap **Set your seal** on Rae's phone — the last seal. About **2.5 s later** every seal cracks and lifts together: "One share didn't clear, so nobody was charged." No hold was ever placed. Narrator: "Nobody at the table can tell whose share it was — not even from the timing." → Back to the charts → pick Lisbon → seal again → Booked.

### Failure branches
| If… | Do |
|---|---|
| Gear VR glitches (black screen, Oculus app pops up, phone hot, table drifted) | Drift: menu → *Recenter*. Anything else: "Same table on the screen" → continue on the Gallery; don't debug in front of judges |
| Judge gets queasy or wears glasses that don't fit | Take it back gracefully; they watch the projector. The Gear VR focus wheel helps mild short‑sight |
| Voices lag | Captions carry it; Narrator reads one line aloud |
| Network dies | Operator toggles cached run (`DEMO_REPLAY=cached`; warm it beforehand with `npm run warm-voices --workspace @all-ayes/server`) — if asked, say honestly it's a recorded run of the live system |
| Judge has 60 seconds | Use the 30‑second version (§2) + show the seal moment on phones |

### Station logistics (Gear VR)
- **One wearer, everyone else on the projector.** One person (a judge, or the Narrator for a first look) wears the Gear VR, seated. The laptop runs the Gallery full screen on the projector or a TV facing the judges, so the whole group sees the same scene, voices and captions as the wearer. The Narrator points at the projector, not at the headset.
- Voices play from the laptop speaker (the Gallery); the headset phone plays them too, so turn its volume down if it echoes.
- Between judges: phone out of the shell (heat), wipe lenses and face pad, re‑seed, **new headset code**, `/xr`, **Enter VR**, back in the shell, *Recenter*. Full list: doc 10 §8. Keep a second charged Galaxy ready if we have one.

---

## 2. The 30‑second version
"Group trips die in the group chat because nobody wants to say *too expensive* and one person fronts the money. In All Ayes, each friend privately briefs their own AI mate with their real budget. The mates negotiate out loud around a globe in a VR chart room, show you the two best trips as tiny cities so you can see the tradeoffs, then book with Visa agent cards capped at each person's private limit — and if anyone's share doesn't clear, nobody is charged. Everyone's in, or nobody pays."

## 3. Judge‑specific 20‑second add‑ons
| Judge | Add |
|---|---|
| **Lighthouse (XR)** | "VR isn't decoration here — the group decides around one shared table, and the Dry Run lets you *see* a 30‑minute uphill walk before you pay for it. It's plain WebXR running on a Samsung Gear VR, a phone headset from 2015, in the phone's own browser: gaze and a tap, spatial audio per crew member. Put the same URL in a Quest and it sits on your real table in mixed reality." |
| **Visa** | "It's agentic commerce for groups: per‑member agent credentials with spending controls set from each person's private terms, passkey‑approved instructions, and an all‑or‑nothing capture — holds are voided if any share fails. Built on the Visa Intelligent Commerce sandbox *(or: a faithful simulation of it — say which mode is live)*." |
| **Meta** | "It strengthens real friendships at the exact moment they usually crack — money and planning. The absent friend still has a voice. And the AI is essential: remove the mates and there's no product." |
| **MLH** | "Gemini runs every mate and the Captain with structured outputs; ElevenLabs gives each crew member a voice; Backboard remembers you across voyages; Atlas holds the whole voyage state; it lives at a .tech domain." |

---

## 4. Likely judge questions — answers

| Question | Answer |
|---|---|
| Isn't this just Mindtrip / a group chat bot? | Those use one AI for everyone and one person pays. We give every person their own advocate that can keep their budget private, we visualize tradeoffs in a Dry Run, and we do all‑or‑nothing group payment with capped agent cards. |
| How do you stop the AI from leaking budgets? | Three layers: the Captain never sees budgets; each mate only sees its own person's terms; every spoken line passes a filter that catches amounts near any private number, even spelled out, then regenerates or swaps in a safe line. We tested 40 adversarial phrasings. |
| Don't LLM agents just argue forever? | Research this year found agents often make zero compromises. So we don't let them free‑chat: typed acts, three rounds, and a Captain who decides by a fairness rule — maximize the worst‑off person's satisfaction. It always ends in under 90 seconds. |
| Are the prices real? | No — curated realistic data for three cities. Real multi‑supplier booking by agents is unsolved even in industry. The architecture swaps in live inventory behind the same deterministic pricing layer. |
| Is the payment real? | Sandbox *(Mode A/B)* or labeled simulation *(Mode C)* — say which. The state machine and invariants are real and unit‑tested. |
| How do you know whose card failed? | We don't show it. Seals are collected first and every share is authorized together about 2.5 s after the last one, so even the order and timing of updates are the same whoever declined; only that person's own phone says why. The group totals on the table are ranges for the same reason — an exact total would let you work out the shares. |
| Why a Gear VR and not a Quest? | We couldn't get a Quest this weekend, so we used what we had: a Galaxy phone in a Gear VR. It's a web page, so no app store and no Oculus software (which dropped the Gear VR years ago). It's the cheapest headset people already have in a drawer, which suits a trip planner for students. |
| What changes on a Quest? | Same code, same URL. On a Quest `/xr` opens mixed reality: passthrough, the chart lands on your real table, hands instead of gaze. The Gear VR is VR only (no cameras) and turns with your head but not your body, so it's a chart room with the table at a fixed seated spot. |
| Isn't the Gear VR dead? | Its store and Oculus support are. The phone's browser isn't: Samsung Internet has shipped WebXR since 11.2 and Chrome does Cardboard‑style VR. That's all we need. |
| Does this fit the Meta challenge / Lighthouse? | Lighthouse asks for AR/VR/XR; this is WebXR VR on real headset hardware. The Gear VR was built by Samsung with Oculus (now Meta) — Oculus wrote its software — and the same build runs as MR on Meta's Quest. The Meta challenge is about connection and AI, which don't depend on the headset at all. |
| Why does it need a headset? | It doesn't *need* one — phones and a laptop view work — but deciding together around one shared table and walking the trip in miniature is what makes the tradeoff land. That's the XR contribution. |
| What if someone lies to their own agent? | Then their agent argues for the lie; but the cap is also their payment limit, so they can't be charged beyond it. The system is honest by construction for the one thing that matters — money. |
| Could the fairness rule be unfair? | It protects the worst‑off person first, then maximizes total happiness. And it only *proposes* — humans pick between two charts in the Dry Run. |
| What's next? | Live inventory; the absent friend sealing from a notification; colocated multi‑headset tables; Surprise Mode reveal. |
| Why the nautical design? | It's a chart table — the crew metaphor makes agents feel like people at a table, not chatbots. And HackGT this year is Seaside Market. |

---

## 5. Meta video (2–3 min) — storyboard

Required by Meta: working prototype, **2–3 min demo video**, **public code repo**, **short write‑up** (who it's for, how it strengthens connection, why AI is essential).

Capture: Gallery view screen recording (1080p60) + phone screen recordings + a phone camera filming the person in the Gear VR at the table (for human context). Don't screen‑record the Gear VR phone for the video: side‑by‑side footage reads badly; the Gallery shows the same scene. Voiceover recorded separately in a quiet room. Captions burned in.

| # | Time | Shot | Voiceover / on‑screen text |
|---|---|---|---|
| 1 | 0:00–0:12 | Close‑up of a phone group chat: "lisbon??" "idk kinda pricey" "…" (mock) | "Every friend group has this chat." |
| 2 | 0:12–0:25 | Three friends' phones, each sealing terms on the brass dial | "In All Ayes, each friend privately tells their own mate what they can actually do." |
| 3 | 0:25–0:35 | Title card on chart paper: **ALL AYES — Everyone's in, or nobody pays.** | — |
| 4 | 0:35–1:15 | Gallery (same scene as the headset): pieces tip, ribbons, Captain; cut to Maya's phone showing no numbers anywhere | "Their mates meet at the table and argue it out — out loud, fairly, without anyone's budget ever being said." |
| 5 | 1:15–1:30 | A human hails: "I'd pay more for the beach" → Advocate responds | "And you can always jump in." |
| 6 | 1:30–2:00 | Dry Run cloches, beads walking, red notes | "Before anyone pays, you watch both trips play out. You see the uphill walk. You see who gets their beach." |
| 7 | 2:00–2:25 | Seals pressing, bell, "Nobody fronted a cent." | "Everyone seals their own share with a capped card. If one share fails, nobody is charged." |
| 8 | 2:25–2:40 | Dev (absent) gets the booked note on their phone | "Even the friend who couldn't make it had a voice." |
| 9 | 2:40–2:50 | End card: repo URL, team names, built with Gemini · ElevenLabs · Backboard · MongoDB · Visa Intelligent Commerce · WebXR | "All Ayes. Bringing friends closer — especially when money's involved." |

Upload as YouTube **unlisted**; link on Devpost.

---

## 6. Devpost write‑up (draft)

**Title:** All Ayes — everyone's in, or nobody pays
**Tagline:** Private AI mates negotiate your group trip at a table in VR — and everyone pays their own capped share, or nobody pays.

### Inspiration
Every friend group we know has a trip that died in the group chat. Two reasons kept coming up: nobody wants to be the one who says "that's too expensive," and somebody always ends up fronting the money and chasing everyone for weeks. We wanted planning to feel like sitting around a table together — where everyone has a voice, even the friend who couldn't make it, and nobody's budget is on display.

### What it does
- Each friend privately briefs their own **mate** (an AI advocate) on their phone: real budget, dates, must‑haves and dealbreakers. Nobody else ever sees it.
- In a **VR chart room on a Samsung Gear VR** (any compatible Galaxy phone, in its own browser), a paper globe sits on a chart table in front of you. (On a Meta Quest 3 the same page puts it on your real table in mixed reality.) Each friend's mate is a carved piece; they **negotiate out loud** in three short rounds, and a **Captain** — who never sees any budget — calls two final options using a fairness rule that protects the worst‑off friend.
- **Dry Run:** both options play out as miniature cities under glass. You watch everyone's day, see the 30‑minute uphill walk, and each friend privately sees whether it fits their terms.
- **The Seal:** everyone approves their own share on their own phone (a tap, or a passkey if they added one). Nothing is charged or held until every seal is set; then every share is authorized together. Each share is paid by a **Visa agent card capped at that friend's private limit**. If any share fails, every hold is voided — **nobody fronts the money, nobody gets stuck paying**.
- Friends without a headset join from their phones; a gallery view shows everyone the table (at the Expo it's projected, so the room sees what the wearer sees).

### How we built it
- **WebXR** (three.js) on a **Samsung Gear VR**: `immersive-vr` in Samsung Internet / Chrome, Cardboard‑style side by side, with a webxr‑polyfill fallback for browsers without WebXR; gaze reticle, select by the headset's touchpad or a 1.6 s dwell; spatial audio per crew member. The same page runs `immersive-ar` (passthrough, plane detection, anchors, hands) on a Quest; SDF text via troika; Dry Run cities with **Google Photorealistic 3D Tiles** via 3DTilesRendererJS (a Google Map Tiles key, or the same tiles through a free Cesium ion token; low‑poly fallback).
- **Gemini** runs every mate and the Captain with structured JSON outputs over a deterministic "chart book" of priced plans — the model chooses and argues, but never computes money.
- **ElevenLabs** gives each crew member a distinct voice (streaming TTS) and transcribes spoken interrupts.
- **Backboard** gives each mate long‑term memory of its friend across voyages.
- **MongoDB Atlas** stores the voyage state machine, the negotiation log, seals and bookings.
- **Visa Intelligent Commerce** sandbox *(or simulation — state which)*: per‑member agent credentials, spending controls from private terms, passkey‑approved instructions; our orchestrator enforces all‑or‑nothing authorization → capture/void with idempotency.
- Node.js + Socket.io keeps headset, phones and gallery in sync; private data only ever goes to each member's own channel.
- Hosted at **[domain].tech**.

### Challenges we ran into
- LLM agents tend to never compromise (recent research found zero compromises in most group‑planning tasks). We solved it with typed acts, a three‑round limit, and a Captain with a maximin fairness rule.
- Keeping budgets private while agents talk about money: a privacy filter catches amounts near any private number, even spelled out, and regenerates or replaces the line.
- No Quest was available, so we moved to a Gear VR: a 3DoF phone headset whose own software is dead. We rebuilt the headset view as a seated VR chart room, replaced hands with gaze + tap/dwell, and kept an old phone cool enough to hold frame rate.
- Debugging WebXR on a phone strapped to someone's face without devtools: we built a log relay and an in‑headset debug overlay.
- Designing AI that doesn't *look* like AI: no chat bubbles, no glowing orbs — carved pieces, ink ribbons and wax seals.

### Accomplishments we're proud of
All‑or‑nothing group payment with capped agent cards; a negotiation that always ends in under 90 seconds with zero budget leaks in testing; a VR Dry Run on a phone headset that makes tradeoffs visible.

### What we learned
Structure beats "smarter" prompts for multi‑agent negotiation; privacy has to be enforced in code, not just instructions; and a physical metaphor makes people trust agents more.

### What's next
Live inventory, absent friends sealing from a notification, colocated multi‑headset tables, and a Surprise Mode destination reveal.

### Honesty notes
Trip inventory is curated sample data for three cities (prices are illustrative). Payments run in sandbox/simulation — no real money moves.

**Built with:** `webxr` `three.js` `samsung-gear-vr` `samsung-internet` `gemini` `elevenlabs` `backboard` `mongodb-atlas` `visa-intelligent-commerce` `node.js` `socket.io` `react` `typescript` `google-3d-tiles` `dot-tech`

---

## 7. Submission checklist (Sun, before 7:30 AM)

| Prize | Requirement | Where | ☐ |
|---|---|---|---|
| Track: Lighthouse | Select Lighthouse (only one track) | Devpost | ☐ |
| Visa | Select Visa challenge; write‑up states mode (sandbox/sim) | Devpost | ☐ |
| Meta | Select Meta; **2–3 min video link**; **public repo link**; write‑up answers: who it's for, how it strengthens connection, why AI is essential | Devpost + YouTube + GitHub | ☐ |
| NSA Packet Pursuit | Flags submitted (only if attempted) | NSA's submission channel | ☐ |
| Gemini (MLH) | Select Best Use of Gemini | Devpost | ☐ |
| ElevenLabs (MLH) | Select Best Use of ElevenLabs | Devpost | ☐ |
| MongoDB (MLH) | Select Best Use of MongoDB Atlas | Devpost | ☐ |
| Backboard (MLH) | Select Best Use of Backboard | Devpost | ☐ |
| .Tech (MLH) | Select Best .Tech Domain; domain live | Devpost | ☐ |
| Create‑X | Tick startup interest box (optional) | Devpost form | ☐ |
| All | Team members added on Devpost; demo video; screenshots (4: brief, table, dry run, seal); built‑with tags | Devpost | ☐ |

## 8. Public repo README outline
1. One‑line pitch + 20‑second GIF (table → dry run → seal)
2. What it does (4 bullets)
3. Architecture diagram (from doc 04)
4. Run locally: `npm install`, `cp .env.example .env`, `npm run dev` (localhost only). For the headset (Gear VR phone, or a Quest), tunnel a production-mode build: `npm run build`, `cloudflared tunnel --url http://localhost:8787`, then `APP_ENV=production SERVE_WEB=1 PUBLIC_BASE_URL=<tunnel URL> DEV_KEY=<32+ chars> npm run start:prod` (README *Run it*)
5. Headset: `docs/10-gear-vr.md` (Gear VR setup, pairing, controls, fallbacks)
6. Demo mode: `/demo` → *Seed* (`/demo#key=<DEV_KEY>` in production or from another machine; `?key=` is ignored)
7. Privacy & payments design (short, links to docs)
8. Honesty notes (sample data, sandbox)
9. Credits: libraries, fonts, CC0 sounds, Google tiles attribution
10. License (MIT)
