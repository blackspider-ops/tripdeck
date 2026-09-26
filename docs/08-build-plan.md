# 08 — Build Plan (2 people, 36 hours)

**Person A — "Shipwright":** XR scene, Dry Run, all visuals/design, phone UI styling, dataset content, Meta video.
**Person B — "Purser":** server, state machine, agents, voice, payments, memory, deploy, Devpost write‑up.

Hacking window: **Fri Sep 25 8:00 PM → Sun Sep 27 8:00 AM**. We submit by **7:30 AM**. Expo 9:00–11:15 AM.

> ⚠️ **Rules check:** MLH‑style hackathons expect project **code to be written during the hacking window**. Planning, docs, design, account setup, reading SDK docs and using open‑source libraries are fine beforehand. Don't commit app code before 8 PM Friday. If unsure, ask organizers at check‑in and disclose on Devpost.

---

## 1. Tonight (Thu Sep 24) — prep only, no app code

### 1.1 Accounts & keys (both, ~90 min)
| # | Item | Where | Owner | Done |
|---|---|---|---|---|
| 1 | Visa Developer account + **request Visa Intelligent Commerce sandbox** | developer.visa.com → VIC | B | ☐ |
| 2 | Read `github.com/visa/mcp` + `github.com/visa/vic-reference-agent` READMEs; note exact calls for doc 06 §4.3 | GitHub | B | ☐ |
| 3 | Google Cloud project, billing enabled, **Map Tiles API** key (restrict by HTTP referrer later) → `VITE_GOOGLE_MAP_TILES_KEY`. No card? A free **Cesium ion** token serves the same Google tiles → `VITE_CESIUM_ION_TOKEN` | console.cloud.google.com / ion.cesium.com | A | ☐ |
| 4 | Gemini API key **with billing enabled** (free‑tier rate limits can stall a live negotiation) | aistudio.google.com | B | ☐ |
| 5 | ElevenLabs account + API key. The defaults (George, Liam, Sarah, Chris, Jessica; doc 05 §8) work on any plan; set `ELEVEN_VOICE_*` only to override | elevenlabs.io (MLH promo link in email) | A | ☐ |
| 6 | MongoDB Atlas cluster (M0) + $50 student credit | mongodb.com/atlas | B | ☐ |
| 7 | Backboard account, promo **`13HACKGT`**, skim API docs | backboard.io | B | ☐ |
| 8 | `.tech` domain via MLH promo (register **`allayes.tech` tonight** (checked free Sep 25); fallbacks: `getallayes.tech`, `allayescrew.tech`) | get.tech | A | ☐ |
| 9 | GitHub Student Developer Pack (Copilot) | education.github.com | both | ☐ |
| 10 | Hosting account with WebSockets (Render/Railway/Fly) | — | B | ☐ |
| 11 | Install `cloudflared` (HTTPS tunnel), Node 22+ (npm workspaces) | local | both | ☐ |
| 12 | Chrome extension **Immersive Web Emulator** (Meta) | Chrome Web Store | A | ☐ |
| 12b | **Headset iPhone set up** (doc 10 §3–4): iOS 18 updated, case off, fit tested in the Gear VR shell (no USB plug, centred, padded, camera bump clear), Low Power Mode off, Auto‑Lock 5 min, motion access allowed for the tunnel site, **aA → Hide Toolbar** practised | Settings / Safari | A | ☐ |
| 13 | Download fonts (Libre Caslon Display/Text, Source Serif 4, IBM Plex Mono, Homemade Apple) + CC0 sounds (doc 02 §10) | Google Fonts / freesound (CC0 filter) | A | ☐ |
| 14 | Join HackGT Discord (packet link) + Match | — | both | ☐ |

### 1.2 Packing (both)
Govt ID + student ID (**required**), laptops + chargers, **the Gear VR shell + the iPhone 16 Pro** (plus folded paper/foam to pad it in the clamp), **2 phones each if possible** (demo needs the headset iPhone + 1–2 more), USB‑C cables, power strip, headphones, phone hotspot plan, water bottle, hoodie, toiletries/sleep kit if staying, **alcohol wipes** (headset hygiene for judges), a real small table cloth (dark green) for the demo table, printed 1‑page pitch card.

### 1.3 Friday before 8 PM
- 2:00 check‑in (arrive by 1:45; bags to Klaus first).
- 5:30–7:00 Sponsor Fair: ask open questions (PRD §10): Visa (sandbox vs sim), Hardware desk (Quest count, opening time, keep all weekend), organizers (prize stacking), Meta (video details).
- ~~7:45 PM: Person A queues at the Hardware Desk for the Quest 3.~~ None available for us; we use the Gear VR (doc 10).

---

## 2. Hour‑by‑hour

> **Hardware change (Sat Sep 26).** The hardware desk had no Quest 3 for us, and we have no Galaxy phone. The headset is an **iPhone 16 Pro (iOS 18, Safari) clamped into our Samsung Gear VR shell**, used as a plain lens viewer with no USB plug (so no touchpad or Back button): webxr-polyfill Cardboard mode, a VR chart room with the table at a fixed seated pose, gaze + 1.6 s dwell only, motion permission on **Enter VR**, **Lens spacing** / `?ipd=`. The organizer's phone drives picks and seals. Setup: doc 10. The Friday rows below are kept as planned; read "Quest" there as "headset iPhone" and "place on the table" as "table at the seated pose". The Quest MR path stays in the code as a stretch.

Legend: **CP** = checkpoint (go/no‑go). IDs reference PRD stories.

### Friday night
| Time | Person A (Shipwright) | Person B (Purser) |
|---|---|---|
| 8:00–8:30 | Get Quest 3 (none came; Gear VR instead, doc 10); connect Wi‑Fi; open test HTTPS URL | Create monorepo (doc 04 §3), shared types, `.env`, Mongo connection, `/health`; tunnel up |
| 8:30–10:00 | XR hello: `immersive-ar` passthrough, hit‑test ring, pinch to place a paper disc on real table (C1) | Server: trips/members REST, join codes, member tokens, socket rooms, `trip:state` (A1–A3) |
| **10:00 CP1** | **WebXR runs on the headset over HTTPS** (now: the polyfill's `immersive-vr` on the iPhone in Safari, with head tracking after the motion prompt). If NO → Gallery‑first plan (§4) | **Create/join from 2 phones works live** |
| 10:00–1:00 | Chart table, globe (texture + graticules + pins), crew pieces (Lathe), troika text, CaptionStrip; `SceneDirector` driven by a **fake event log** | `fit/pricing.ts`, `fit.ts`, `fairness.ts` + dataset JSON from doc 07 + **unit tests reproducing doc 07 §9** |
| 1:00–2:00 | Phone design tokens + Landing/Create/Muster/Join/Brief screens (styling) | Wire Brief submit (B1–B6), brief privacy (private room only), state machine BRIEFING→AT_TABLE |
| 2:00–3:30 | Ink ribbons + piece tip/slide animations; compass timer | **Sleep 2:00–6:00** |
| 3:30–7:30 | **Sleep 3:30–7:30** | (asleep until 6:00) |

### Saturday
| Time | Person A | Person B |
|---|---|---|
| 6:00–10:00 | (A wakes 7:30) 7:30–10: Dry Run scene: cloches, **low‑poly city first**, beads, route lines, brass clock, red margin notes (D1–D3) | Negotiation engine: chart book, Advocate/Captain calls with JSON schema, 3‑Watch protocol, pacing; **privacy filter + 40 adversarial tests**; ElevenLabs TTS + audio cache (C3–C7) |
| **10:00 CP2** | Dry Run plays both cloches in Gallery | **Full negotiation runs end‑to‑end with voices + captions on phones; 0 leaks** |
| 10:00–10:45 | Continue | **Visa tech talk** (ask about VIC sandbox/sim if not answered) |
| 10:45–1:00 | **Google Photorealistic 3D Tiles in cloche** (timebox: decide at 1:00 keep vs fallback); tile attribution tag | Payments: SIM provider + orchestrator + seal flows + all tests from doc 06 §10 (E1, E3–E5) |
| 1:00–2:00 | Seal ceremony: rolled chart, wax seal press, crack, bell | **VIC sandbox integration attempt** (timebox until 2:00 → choose Mode A/B/C) |
| **2:00 CP3** | **All P0 phases pass in Gallery + phones**: brief → table → dry run → seal → booked/voided | same |
| 2:00–3:30 | XR on Quest: placement polish, spatial audio per piece, wrist menu, debug overlay; perf pass (≥72 fps table) | Phone screens logic: Table mirror (C8), Dry Run cards with private stamps (D4–D5), Seal/Booked/Voided (E1–E5) |
| 3:30–4:15 | **Meta tech talk** (take notes on what they value) | Backboard memory (G1–G2), seed Maya's memory |
| 4:15–6:00 | XR input: grab cloche to pick, hail pinch‑hold; reduced‑motion toggle | Hail via text (P0) + push‑to‑talk STT (P1); passkey WebAuthn (P1); `/debug` page |
| 6:00–7:00 | **Integration on the actual Quest over venue Wi‑Fi**; deploy to `.tech` domain; test on hotspot | same |
| 7:00–7:45 | Dinner (noodles) — eat away from screens | Dinner |
| 7:45–9:30 | **Record Meta video** (storyboard doc 09 §5): Spectator capture + phone screen recordings + Quest footage | Devpost write‑up draft (doc 09 §6); public repo README; license |
| 9:30–10:00 | T‑shirts + stretch | same |
| **10:00 CP4** | **5 consecutive clean demo runs** (checklist §7) — log every failure | same |
| 10:00–1:00 | Fix list from CP4; visual polish only on what judges see | Fix list; `warm-voice-cache` script; rehearse pitch with 3 strangers (does the 20‑second hook land?) |
| 1:00–4:00 | **Sleep 1:00–4:00** | Opportunistic: **NSA Packet Pursuit** 1:00–2:00 *only if CP4 was green*; then **sleep 2:00–5:00** |

### Sunday
| Time | Person A | Person B |
|---|---|---|
| 4:00–5:00 | Final visual QA against the anti‑AI rulebook (doc 02 §2) | (asleep) |
| 5:00–7:00 | 2 more full rehearsals; charge everything | Final deploy + `/health` green; Devpost finalize; upload video (YouTube unlisted); repo public |
| **7:30** | **Devpost submitted** with all challenge selections (doc 09 §7), tags, video, repo, write‑up, Create‑X box | same |
| 7:30–8:00 | Buffer / fixes to video only | Buffer |
| 8:00–9:00 | Breakfast; set up station (§6) | same |
| 9:00–11:15 | **Expo** | **Expo** |
| 12:00 | Closing — collect prizes in person | |

---

## 3. Task board (P0 first)

| ID | Task | Owner | Est | Depends | Story |
|---|---|---|---|---|---|
| T01 | Monorepo, shared types, env, health | B | 0.5h | — | — |
| T02 | Trips/members REST + sockets + rooms | B | 1.5h | T01 | A1–A3 |
| T03 | XR bootstrap + placement | A | 1.5h | tunnel | C1 |
| T04 | Dataset JSON (doc 07) | A | 1h | — | — |
| T05 | pricing/fit/fairness + tests | B | 2.5h | T04 | — |
| T06 | Scene components (table, globe, pieces, text) | A | 3h | T03 | C2 |
| T07 | SceneDirector + fake event log | A | 1h | T06 | — |
| T08 | Phone screens styling | A | 1.5h | — | — |
| T09 | Brief wiring + privacy rooms | B | 1h | T02 | B1–B6 |
| T10 | Negotiation engine | B | 3h | T05 | C3–C7 |
| T11 | Privacy filter + tests | B | 1h | T10 | C5 |
| T12 | TTS + cache + pacing | B | 1h | T10 | C4 |
| T13 | Dry Run scene (low‑poly) | A | 2.5h | T06 | D1–D3 |
| T14 | dryrun simulate + script events | B | 1h | T05 | D2 |
| T15 | Payments SIM + orchestrator + tests | B | 2h | T02 | E1–E5 |
| T16 | Seal ceremony animations | A | 1h | T06 | E5 |
| T17 | Phone Table/DryRun/Seal logic | B | 1.5h | T10,T15 | C8,D4,E1 |
| T18 | Spectator view | A | 0.5h | T07 | F1–F2 |
| T19 | Deploy + domain | B | 0.5h | — | — |
| T20 | Google 3D tiles (P1) | A | 2h | T13 | D1 |
| T21 | VIC sandbox (Mode A/B) | B | 2h | T15 | E3 |
| T22 | Voice hail STT (P1) | B | 0.75h | T12 | C6 |
| T23 | Passkey (P1) | B | 1h | T15 | E2 |
| T24 | Backboard memory (P1) | B | 0.75h | T10 | G1–G2 |
| T25 | XR input polish, wrist menu, debug overlay | A | 1.5h | T06 | Q5 |
| T26 | Meta video | A | 1.75h | CP3 | Meta |
| T27 | Devpost + README | B | 1h | CP3 | all |

Total A ≈ 21.75h, B ≈ 24.25h of the ~30 awake hours each → ~20–25% buffer.

---

## 4. Cut lines (drop in this order when behind)

| Order | Cut | Replacement | Impact |
|---|---|---|---|
| 1 | Google Photorealistic tiles | Low‑poly paper city | Less wow in Dry Run |
| 2 | Passkey (WebAuthn) | "Set your seal" confirm | Slightly weaker Visa story (mention passkey in VIC instruction if Mode A) |
| 3 | Voice hails | Text hails from phone | Minor |
| 4 | Backboard memory | Skip (lose MLH Backboard entry) | Minor |
| 5 | VIC real sandbox | SIM mode, labeled | Weaker Visa, still valid flow |
| 6 | Phone Table mirror visuals | Log list only | Minor |
| 7 | Headset XR (iPhone: motion denied, double image, overheats) | First reopen the tab and allow motion, **Lens spacing** / `?ipd=`, cool the phone; then a borrowed phone (a Galaxy S6–S10 fits the clamp properly, doc 10 appendix A); last, **Gallery‑first demo**: laptop Spectator + phones; enter Lighthouse only if we have any XR running | Track at risk |

**Never cut:** privacy filter · deterministic pricing/fit · 3‑Watch termination · all‑or‑nothing orchestrator · captions · the design rulebook.

**Gallery‑first plan (if CP1 fails):** all scene code already runs in Gallery; keep trying the headset iPhone (new tab + motion prompt, `?vr=cardboard` elsewhere, a borrowed phone); worst case demo on laptop + phones and say "runs on a phone in a Gear VR shell" only if it truly does.

---

## 5. Risk register

| # | Risk | P | I | Trigger | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R1 | No Quest from desk, and no Galaxy phone | — | — | **Happened** (Fri 8 PM) | An iPhone 16 Pro in our Samsung Gear VR shell (webxr-polyfill Cardboard mode, gaze only; doc 10). Quest MR kept as stretch if one turns up | A |
| R1b | Headset iPhone can't run it: motion access denied (no head tracking), double image (lens spacing / off‑centre), Safari toolbar crops the view, loose fit in a clamp made for Galaxy phones | M | H | CP1 through the shell | Enter VR → **Allow**; denied → new tab or clear the site's website data; **Lens spacing** / `?ipd=`; **aA → Hide Toolbar**; case off, centre it, pad with paper/foam; lens distortion is Cardboard's, not measured for Gear VR (accept slight edge bend) | A |
| R1c | Headset iPhone overheats or drops frames mid‑demo (closed shell) | H | M | Phone hot, fps < 45 in the debug overlay | *Photoreal cities* off in VR (default); `?lowtex`; brightness down a notch; phone out of the shell between judges; charge between runs, not during | A |
| R1d | Wearer gets motion sick (3DoF drift, low fps) | M | M | Judge says so | Seated only; **Recenter** (3.2 s gaze on the wheel); *Reduce motion*; runs ≤ 3 min; offer the Gallery instead | A |
| R2 | No devtools once the phone is in the headset | H | M | — | `client:log` relay + in‑headset debug overlay; Safari Web Inspector from a Mac over USB with the phone out of the shell | A |
| R2b | Dwell selects by accident (a judge stares at a cloche and picks it) | M | M | Rehearsal | Rae drives picks and seals from her phone; tell the wearer "just look around"; the pick stays open to the phone | A |
| R3 | Quest only: WebXR features missing (plane detection) | L | M | CP1 | Hit‑test only; manual height adjust | A |
| R4 | VIC sandbox access delayed | M | M | Not approved by Sat noon | Mode B/C | B |
| R5 | Gemini latency spikes | M | M | > 4 s turns | Flash model, short outputs, pipelining, template fallback, cached run | B |
| R6 | Budget leak in a spoken line | L | H | Filter tests | Filter + regenerate + template; 40 tests | B |
| R7 | Negotiation boring/robotic | M | M | Stranger test Sat night | Tune prompts for warmth; distinct voices; memory line; hail moment | B |
| R8 | Tiles slow on venue Wi‑Fi | H | M | > 4 s load | Low‑poly fallback auto‑switch; pre‑warm by viewing once | A |
| R9 | Venue Wi‑Fi fails at Expo | M | H | — | Phone hotspot; cached run mode | B |
| R10 | Audio inaudible at Expo | H | M | Loud atrium | Captions everywhere; small speaker for laptop; captions; the headset iPhone's speaker is muffled by the shell | A |
| R11 | Burnout / sleep debt | H | M | — | Scheduled sleep blocks; meals away from screens | both |
| R12 | Scope creep | H | H | Any P2 before CP3 | Only P0 until CP3 green | both |
| R13 | Meta video missing | L | H | Not recorded by 10 PM Sat | Recorded Sat 7:45–9:30 fixed slot | A |
| R14 | Rule issue (pre‑written code) | L | H | — | No code before 8 PM Fri; disclose libs | both |
| R15 | Gemini/ElevenLabs rate limits or quota during Expo | M | H | 429s in `/debug` | Billing‑enabled keys; warm voice cache; `DEMO_REPLAY=cached` emergency | B |
| R16 | Passkeys fail on the production domain | M | L | Registered on a tunnel URL | Set `WEBAUTHN_RP_ID` to the `.tech` domain; re‑register on it Sat evening. As built passkeys are optional (members without one seal with a tap; LIVE-001), so the demo phones can simply not add one | B |
| R17 | Judge wearing headset sees private data | L | H | — | Headset uses device token with no member room (doc 04 §7); socket privacy test covers xr | B |

---

## 6. Expo station setup (Sun 8:00–9:00)
- A chair for the wearer (the chart room is seated). Table with dark green cloth (looks like a chart table; a Quest would use it for plane detection).
- Headset iPhone charged ≥ 90% and cool, case off, Do Not Disturb on, silent off, Low Power Mode off, brightness up, Safari on `<domain>/xr` paired with the headset code from Rae's phone (**Show headset code**; re‑pair after each re‑seed), **aA → Hide Toolbar**, motion allowed; paper/foam padding in the shell, a charger at the station (never charge in the shell), **alcohol wipes** for the lenses and face pad. Full list: doc 10 §9.
- The wearer only looks; **Rae's phone drives** *Weigh anchor*, the pick and the seals (dwell picks whatever the wearer stares at).
- The Gallery on the laptop is **projected / turned to the aisle**, so judges see the scene the wearer sees.
- Laptop: Gallery view full‑screen facing the aisle; second tab `/api/debug/<code>` (sign in once with the dev key).
- Phones: Organizer (Rae) + Maya logged into seeded trip; Dev pre‑sealed.
- Hotspot on, tested. Laptop speaker for voices.
- Voice cache warmed once with the production key: `npm run warm-voices --workspace @all-ayes/server` (runs the Expo table with Rae's hail after her mate's proposal), so `DEMO_REPLAY=cached` is ready as the emergency button.
- Printed card: 1‑line pitch + QR to Devpost + prize list.
- `POST /demo/seed` fresh trip between each judge (≤ 10 s).

---

## 7. Demo run checklist (use at CP4 and every rehearsal)
- [ ] `/api/health` with `X-Dev-Key` all green (mongo, gemini, eleven, backboard, `payments` mode shown, `persistence.degraded` false, budgets `ok`)
- [ ] Fresh seeded trip; 3 crew shown; Dev pre‑sealed
- [ ] Headset iPhone: `/xr` paired, **Enter VR** → motion allowed → landscape → side‑by‑side chart room in ≤ 10 s; one image (not two) through the shell; table straight ahead (or a 3.2 s gaze on the wheel to **Recenter**); reticle visible; a 1.6 s dwell selects; the **Exit VR** plaque leaves VR back to the Enter card
- [ ] Phone not hot, fps ≥ 45 in the debug overlay through the Dry Run
- [ ] Captain opens with no individual numbers
- [ ] Early exit after Watch 2 (8 voiced lines), ≤ 70 s, voices audible, captions synced
- [ ] Rae's hail "I'd pay more for the beach" appears as a caption and Rae's mate acknowledges it ("Heard you, Rae…")
- [ ] 0 redactions needed (or filter caught it — check `/debug`)
- [ ] Two cloches, beads walk, red notes show (30 min walk, overnight flight); the cloche tags read "$1,550–2,100" (Mexico City) and "$2,650–3,100" (Lisbon) — ranges, never an exact group total
- [ ] Private stamps correct on Maya's phone (✓ both; "no beach" on MEX)
- [ ] Pick Lisbon → shares Rae $1,038 / Maya $868 / Dev $963 (owner‑only)
- [ ] Seals press at each tap with no passkey sheet (unless one was added on Wait); "Every seal is set · settling…"; ~2.5 s later BOOKED; bell ×2; reference shown
- [ ] (Optional) decline path: Dev's standing seal sets at once, Maya seals then taps **Lift my seal** (before Rae seals; her seal still reads set), Rae seals last → ~2.5 s later every seal lifts together, nobody charged → Back to the charts → pick Lisbon → booked
- [ ] Headset never shows a share, cap or fit (check the unrolled chart shows "— sealed —")
- [ ] Total time ≤ 3:00

---

## 8. Definition of done (per P0 story)
- Works on the headset iPhone in the Gear VR shell (or the Gallery if R1b), phones (iOS Safari + Android Chrome), and survives a page reload mid‑phase.
- Private data verified absent from `trip:{id}` room (socket privacy test green).
- Copy checked against doc 02 §11 voice rules.
- No console errors in `/debug` during a full run.
