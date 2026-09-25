# 05 — Agent Specification: Advocates & the Captain

**Core idea:** every member gets their own **Advocate** that knows only *their* sealed terms. A **Captain** with no access to anyone's budget runs a short, structured meeting and always ends it. All numbers (prices, shares, fit, fairness) come from deterministic code; the models only choose among real options and speak.

Why the structure: 2026 research on multi‑agent group travel (MIND; GroupTravelBench) shows LLM agents often don't compromise at all (one benchmark: 67% of tasks with zero compromises). A free‑form "let the AIs chat" loops or stalls. We use typed acts, a hard 3‑Watch limit, and a Captain who decides by a fairness rule.

---

## 1. Roles

| Agent | Count | Knows | Doesn't know | Speaks as |
|---|---|---|---|---|
| **Advocate** | 1 per member (incl. absent) | Its member's full Brief (cap, dates, must‑haves, dealbreakers, note), its member's memory (Backboard), all public listings, its member's share + fit for any plan | Any other member's Brief, share, or fit | "my friend" / first name of its member; warm, brief |
| **Captain** | 1 | Public listings, public plan totals, per‑plan **fits‑everyone boolean**, per‑plan fairness score, the act log | Any cap, any individual share, any individual fit, who is budget‑tight | "we", "the table" |

Model: a fast Gemini Flash‑class model via `@google/genai`, `temperature 0.7` for Advocates (personality), `0.3` for the Captain, **structured JSON output** with a response schema, max output ≈ 120 tokens.

---

## 2. Candidate plan space (deterministic, before any LLM call)

`fit/pricing.ts` builds a finite set of **candidate Plans** so agents can only reference real, priced options:

1. For each `cityId ∈ trip.candidateCityIds` × each `dateWindow` acceptable to ≥ 1 member:
2. For each hotel in that city that sleeps ≥ group size (or combinations of 2 units if needed) and is **not a dealbreaker for anyone** (e.g. hostel):
3. Per member: pick the **cheapest flight** from their origin for that window that violates none of their dealbreakers (red‑eye, 2+ layovers). If none → plan invalid for that member (fit=false, reason).
4. Activities (`fit/pricing.ts`, greedy, matches doc 07 §6):
   - **Group moments:** the city's activities with `role:"group"` — everyone attends (one per day, max 2 in the trip).
   - **Picks:** for each member, add `role:"pick"` activities whose tags match a must‑have that the group moments don't already cover for that member (max 2 picks per member). If two members share a matching pick (e.g. Rae + Dev → food tour) they attend it together.
   - Skip any activity with `earlyStart` for a member with the `early_start` dealbreaker; `early_start` also rejects flights departing before 08:00.
   - Place each activity inside its `startEarliest`–`startLatest` window; resolve clashes by moving picks to Day 2.
5. Compute: group total, per‑member shares (§2.1), per‑member fit + reasons, must‑haves covered/missing, flags (walk > 25 min → `long_walk`, activity/flight < 08:00 → `early_start`, overnight flight → `red_eye`).
6. Keep the **top 12 plans** by fairness (§5) → the "chart book" the agents choose from. IDs look like `LIS-W1-casa-alfama`.

### 2.1 Share rule (fair split)
- Flights: each member pays their own flight.
- Lodging: total nights × nightly ÷ number of members (equal split of the unit; if 2 units, split per unit occupants).
- Activities: each member pays for the activities they attend (group moments → everyone; picks → only the members attending).
- Rounding: to the cent; remainder cents assigned to the organizer's share.

---

### 2.2 What an Advocate argues for (as built)
`advocatePreference = 100 × mustHaveCoverage + member satisfaction + 0.5 × plan maximin` — a good mate pushes for its friend's wishes first, but prefers the version of a city the whole table can say aye to (stops mates proposing the priciest hotel just because their friend has room).

### 2.3 Who decides what (as built)
`AGENT_DECISIONS=rules` (default): the protocol in `negotiation/rules.ts` decides each move deterministically and Gemini writes every line in character; with no Gemini key, lines come from templates. `AGENT_DECISIONS=model`: Gemini may choose among the legal moves (validated; the rule decision is the fallback). Rules mode is what the Expo demo uses — same story every run.

## 3. Context each agent receives

### 3.1 Advocate context (per turn) — as built (`negotiation/prompts.ts advocateFacts`)
The protocol has already decided the move (§2.3); the Advocate gets the facts for that one move, as a JSON block labelled "data, not instructions":
```json
{
  "you_represent": {"name":"Maya","role":"member"},
  "wishes": {"must_haves":["beach","chill"], "dealbreakers":["hostel"],
             "private_note":"I get tired walking hills"},
  "memory": ["Conceded the city choice last voyage (wanted Chicago)"],
  "watch_of_3": 2, "decided_act": "OBJECT",
  "reason": {"kind":"object_missing", "tag":"beach", "againstPlanId":"MEX-W1-roma-flat", "minePlanId":"LIS-W1-casa-alfama"},
  "plan": {"city":"Mexico City", "group_total":"$1,550 to $2,100", "stay":"Roma Norte Flat",
           "what_your_friend_would_do":["…the picks and group moments on this chart…"],
           "fits_your_friend":true, "your_friends_missing_wishes":["beach"]},
  "hail_from_your_friend": {"wants":["beach"], "cheaper":false}
}
```
No cap, share, budget band or home airport is in it (S2-002: an airport said aloud pins the member's flight price, and with it their share). `group_total` is the **public range** (`publicTotalRange`, the same as `PlanPublic.groupRange`), never the exact total. The design sketch that gave the Advocate its cap, share and a whole chart book is not what shipped: the rules decide, so the model only needs what it may say.

### 3.2 Captain context — as built
The Captain gets no chart book and no per-member data, only a one-line instruction with group-level facts: OPEN = the dates everyone can do (or that none suit everyone) and the ports; DECIDE = the two charts by city and **public total range**, and whether each fits everyone, e.g. `Chart A: Mexico City (group total $1,550 to $2,100, fits everyone). Chart B: Lisbon (group total $2,650 to $3,100, fits everyone).` The fairness ranking itself is computed in code (§5); the Captain never sees who objected, let alone why.

**As built (WP-12):** the Advocate prompt carries `wishes.private_note` — the member's own note, for that member's Advocate only, with every amount removed and instruction-shaped text stripped (`privacy/guard.ts noteForPrompt`). It carries no cap, share or budget band (memory lines are passed through `memoryForPrompt`, which drops the band), and a hail reaches the model only as its parsed wishes (`{wants: tags, cheaper}`), never as raw text. The facts go in a JSON block labelled "data, not instructions"; names are reduced to letters (`promptName`). `noteSource` is stored only when there is a note. Rules-mode templates ignore the note.

---

## 4. The meeting protocol

```
WATCH 0  Captain OPEN          (group-level facts only: dates everyone shares — or "No dates suit everyone;
                               we'll weigh the closest." when there is no common window — and ports on the chart)
WATCH 1  each Advocate PROPOSE (one planId + why; ≤35 words, ≤20 in Expo mode)
WATCH 2  each Advocate responds to the strongest rival proposal: OBJECT | SUPPORT | CONCEDE
         (queued human HAILs are inserted at the start of Watch 2 and Watch 3)
WATCH 3  each Advocate final position: SUPPORT | CONCEDE (OBJECT allowed only with a dealbreaker reason)
DECIDE   Captain names The Two Charts (shortlist) using the fairness rule; bell.
```
Order within a Watch: seating order starting left of the Organizer; the Organizer's Advocate speaks **last** in each Watch (reduces host bias). Absent members' Advocates speak like anyone else.

**Backing:** each Advocate's *backed plan* = the plan of its latest PROPOSE, SUPPORT or CONCEDE. An OBJECT doesn't change what it backs.

**Early exit:** after Watch 2, if every Advocate backs the same plan **and no hail is waiting**, the Captain DECIDEs immediately (still two charts: the backed plan + the best alternative from §5). Otherwise Watch 3 runs. In the Expo run all three back Lisbon after Watch 2 → 8 voiced turns total.

**Hails:** a hail becomes a `HAIL` turn with the human's own words (filtered), shown in the log and caption strip but **not voiced** — the person already said it out loud. It is inserted at the start of the next Watch, and that member's own Advocate must acknowledge it (`acknowledgesHail: true`) in its next turn.

As built (TR4-011): the HAIL turn is stamped with the Watch it is acted on (2 or 3). Each member has at most one hail waiting; another hail from them before their mate has used it is refused privately (`error {code: "HAIL_WAITING"}`) rather than dropped. Hails during Watch 3 or once the Captain is deciding are refused with `CAPTAINS_CALLING` (nobody would act on them). A hail keeps its words but loses **every** amount that isn't an exact public price — whether or not it is near a secret, so what gets through tells the sender nothing about anyone's numbers; a hail that is only an amount is refused privately (`HAIL_AMOUNTS`) and never posted. As built (R2-WP-04): stripping repeats until no non-public amount is left (removing `$5000` from `9 $5000 0 0` leaves `9 0 0`, which goes too), and the hail filter never looks at the secrets — acceptance or refusal depends only on the words and the public prices, so a refusal says nothing about anyone's cap or share (S2-003). A refused hail counts toward the one-hail-every-5-s limit (`SLOW_DOWN`) like an accepted one. Hails open at Watch 1: one sent during the Captain's OPEN (Watch 0) is refused privately with `TABLE_OPENING`, so a HAIL turn never lands in the log ahead of the Watch-1 proposals (L4-005).

Private objection ("whisper", P1): an Advocate can set `"whisper": true` on an OBJECT about affordability. Then the line is **not spoken**; instead the Captain later says "One of us can't make that one work." This hides even *which* member is price‑sensitive.

---

## 5. Fairness & decision rule (`fit/fairness.ts`, deterministic)

Satisfaction per member for a plan, 0–100:
```
if !fits(member, plan): 0
else:
  45 * mustHaveCoverage          // covered / total must-haves (0..1)
+ 25 * min(headroom, 0.30)/0.30  // headroom = (cap - share)/cap
+ 20 * (1 - min(flagCount,3)/3)  // this member's flags: long_walk, early_start, red_eye
+ 10 * (hotelRating/5)
```
Plan score = **(maximin, sum)**: first the minimum satisfaction across members (protects the worst‑off), tie‑break by sum.

Captain DECIDE:
1. Consider plans in any Advocate's `advocatedBy` (PROPOSEd, SUPPORTed or CONCEDEd to at least once — so the meeting matters); if < 2, add best‑scoring plans from the chart book.
2. Chart A = highest (maximin, sum). Chart B = highest remaining with a **different city** (for a meaningful Dry Run); if no other city has maximin > 0, pick the next best same‑city plan.
3. Captain's DECIDE line explains in group terms: "Mexico City leaves more in everyone's pocket; Lisbon covers the most. Let's run them dry."
4. The server computes the shortlist; the Captain's model output only supplies the *line*. If the model names different plans, the server's shortlist wins and the line is regenerated once (else template).

---

## 6. Output schemas (Gemini structured output)

### 6.1 Advocate turn
```json
{
  "type": "object",
  "properties": {
    "act":    {"type":"string","enum":["PROPOSE","OBJECT","SUPPORT","CONCEDE"]},
    "planId": {"type":"string"},
    "line":   {"type":"string","description":"≤35 words, spoken aloud, no dollar amounts except public prices from chart_book"},
    "ribbon": {"type":"string","description":"≤8 words, handwritten on the chart"},
    "whisper":{"type":"boolean"},
    "acknowledgesHail": {"type":"boolean"}
  },
  "required": ["act","planId","line","ribbon"]
}
```
Server validation: `planId ∈ chart_book`; `act` legal for current Watch; word limits (truncate at sentence boundary; regenerate once if > 45 words).

### 6.2 Captain turn
```json
{ "act": "OPEN" | "DECIDE",
  "line": "≤40 words",
  "ribbon": "≤8 words",
  "shortlist": ["planIdA","planIdB"]   // DECIDE only; server re-computes and overrides if it disagrees with §5
}
```

### 6.3 Tools (function calling)
Advocates don't need tools in the default design (the chart book is in context). Tools are enabled for P1 "deeper" mode:

| Tool | Args | Returns | Who |
|---|---|---|---|
| `inspect_plan` | `{planId}` | day schedule, walking minutes, flags (my flags only) | Advocate |
| `find_alternative` | `{planId, change:"cheaper_hotel"|"drop_activity"|"other_window", activityId?}` | new candidate planId (computed, priced) or `none` | Advocate |
| `plan_public` | `{planId}` | public total range, fits_everyone, fairness | Captain |

`find_alternative` is how an Advocate "offers a trade" ("Lisbon works if we skip Sintra") with a real, priced variant — never an invented one.

---

## 7. Guardrails

### 7.0 Privacy tiers (what may be said out loud)
| Tier | Data | Rule |
|---|---|---|
| **Secret** | cap, share, headroom, fit per member | Never spoken or shown to anyone but the owner. Enforced by §7.1 filter + room isolation (doc 04 §7). |
| **Discreet** | must‑haves, dealbreakers, free‑text note | Only the member's **own** Advocate may voice them, paraphrased ("my friend wants a proper beach day"). Never quoted verbatim, never voiced by the Captain or another Advocate, never shown as a list to others. |
| **Public** | listings, listing prices, group-total **ranges** (S2-002), public flags, crew names, seal status (set / not set) | Free to say. The exact group total is **not** public: it is the sum of the private shares (with public listing prices it pins them), so only the range is ever said or shown. Home airports are not public either. |

### 7.1 Budget privacy filter (`privacy/filter.ts`) — runs on every `line`, `ribbon`, and hail
One `PrivacyContext` per table (`privacy/context.ts`), built by the service from the same top-12 chart book the Advocates argue over, and shared by the engine, the hail filter and prompt text (`privacy/guard.ts`).
Before extraction, text is NFKC-normalised, zero-width/bidi characters are removed, digits from any script become ASCII and `9_0_0` → `900`. Extraction also reads space-grouped thousands (`$1 100`), `1.1k`, joined words (`ninehundred`), slang (`hundo`, `grand`), spoken zeros (`nine-oh-oh`), digit-by-digit words (`eight six eight`), and simple arithmetic (`450 plus 450`, `a grand minus a hundred`, `2869 split three ways`).
1. **Sensitive set:** every member's cap, every member's share, every member's headroom (cap−share), each as dollars; plus common spoken forms ("750", "seven fifty", "7.5k", "under 800").
2. **Extract numbers** from text: digits with/without `$`/`,`/`k`; spelled numbers (words→number); ranges ("700 to 800").
3. **Allowed set:** exact public values in the chart book (listing prices, the ends of each public group-total range), dates, times, durations, counts ≤ 10, walking minutes. Each chart's exact group total is in the *sensitive* set (S2-002).
4. **Rule:** a number within ±5% of any sensitive value that isn't an *exact* allowed value → **leak**. Also leak if limit talk (`budget|cap|limit|afford|spend|max|tops…`) or per-member share talk (`each|apiece|per person|my share…`) comes with any non-public number ≥ 100.
5. **On leak:** regenerate once with an added instruction ("Do not state any amount; say it doesn't fit"). If still leaking → the act's template; if even that fails → a neutral safe line for that act (`safeLine`: OPEN "The ports are on the chart…", PROPOSE "<city> would suit my friend.", OBJECT "<city> doesn't work for my friend.", SUPPORT "I'll back <city>.", CONCEDE "I'll come round to <city>.", DECIDE "Two charts, then. Let's run them dry."). Count redactions (rejected attempts, stripped amounts, rewrites) in `turn.redactions`.
6. **Name + affordability** ("Maya can't afford", "Maya simply cannot afford") → rewrite to "one of us".
7. **Impersonation** (SEC-023): an Advocate line labelled with a speaker (`Captain:`), claiming the booking is confirmed/paid, or echoing instructions is rejected like a leak.
8. **Hails** (`sanitizeHail`, S2-003) don't use rule 4 at all: the filter runs without the sensitive set, strips every amount ≥ 20 (or with a currency sign) that isn't an exact public value, repeating until none is left, and refuses only when fewer than two words remain. The outcome is the same whatever the secrets are, so a hail can't be used to probe them.

### 7.2 Price validator
Any currency amount left in a line must equal an allowed public value (±$1). Otherwise the amount is dropped with its connecting words ("for $150 a night"); a sentence left too thin to read is dropped, and the rest of the line is kept (`stripInvalidPrices`). Applies to ribbons too.

### 7.3 Loop/stall prevention
- Hard stop after Watch 3, always.
- If an Advocate repeats the same act+plan three times → forced CONCEDE in Watch 3 unless dealbreaker.
- Global engine timeout 120 s → Captain DECIDE from scores.

### 7.4 Content safety
Advocates never insult members, never pressure ("just pay more"), never mention other members' private preferences unless public in the log. Captain never reveals counts that identify a single person (e.g. with 3 members, "one objected on price" is avoided → uses "not every purse can stretch to that one").

---

## 8. Voices (ElevenLabs)

| Speaker | Voice brief | Default voice (env override) | Settings |
|---|---|---|---|
| Captain | Older, calm, unhurried | George `JBFqnCBsd6RMkjVDRZzb` (`ELEVEN_VOICE_CAPTAIN`) | stability 0.6, style 0.2 |
| Band 1 (Prussian) | Warm, mid‑20s, upbeat | Liam `TX3LPaxmHKxFdv7VOQHJ` (`ELEVEN_VOICE_BAND1`) | stability 0.45 |
| Band 2 (Sienna) | Dry humor, relaxed | Sarah `EXAVITQu4vr4xnSDxMaL` (`ELEVEN_VOICE_BAND2`) | stability 0.5 |
| Band 3 (Olive) | Gentle, thoughtful | Chris `iP95p4xoKVk53GoZ742B` (`ELEVEN_VOICE_BAND3`) | stability 0.55 |
| Band 4 (Madder) | Brisk, confident | Jessica `cgSgspJ2msm6clMCkdW9` (`ELEVEN_VOICE_BAND4`) | stability 0.45 |

- The defaults are ElevenLabs premade voices that every account has, free plan included (a free plan gets HTTP 402 when the API asks for a Voice Library voice). A blank `ELEVEN_VOICE_*=` line in `.env` means "use the default", the same as leaving it out. To use library voices, add them to your account ("My Voices") on a paid plan and set the IDs.

- Streaming TTS, mp3 44.1 kHz, cached per `turnId` at `/api/audio/:turnId`.
- Lines are ≤ 35 words ≈ 12–14 s audio at normal pace. **Expo mode:** ≤ 20 words and voice speed 1.1 ≈ 6–7 s per line, so the 8‑turn Expo run fits ~60–70 s. Target first audio ≤ 800 ms.
- STT for hails: ElevenLabs speech‑to‑text on ≤ 10 s webm clips.
- Fallback: if TTS fails, caption only (the piece still tips and ribbon still writes).

---

## 9. Memory (Backboard)

- One memory thread per **person**, keyed by `crew:<sha256(crewKey)>|<name>` (SEC-003). The **crew key** is 256 random bits the server mints at the person's first create, join or absent-invite claim. The phone keeps it in `localStorage` (`aa:crewKey`) and sends it on every later create, join or claim. The server stores only its hash (`members.crewKeyHash`). Name, home airport and band never select a thread (and the home airport is server-only: never in `trip:state`, a prompt or the Gallery, S2-002). A seat without a crew key has no memory: someone who joins as "Maya · ORD" from a fresh phone recalls nothing. An absent seat gets its key only when the friend claims the invite on their own phone. The organizer's phone can't claim it (`OWN_INVITE`), so the organizer's key never lands on another seat. The same thread key selects the person's Backboard assistant, which is labelled with their first name only.
- The Expo seed gives seeded Maya a fresh crew key and writes her "conceded the city choice (wanted Chicago)" line under it, so the script's "gave up the city pick last time" still plays. Threads keyed `name|origin` by older builds are no longer read.
- **Write** after `BOOKED` (and after `VOIDED` with a smaller note):
  ```
  voyage: Lisbon, Mar 12–16 2027 · outcome: booked
  liked: Cascais beach day, fado night
  conceded: city choice (wanted Mexico City)
  flags hit: long uphill walk day 1
  satisfaction: 72
  ```
  **Never store caps as raw numbers in memory** — store a band ("mid budget") to reduce sensitivity.
- **Read** when a returning member opens the Brief: pre‑fill chips; the Advocate's first PROPOSE may reference it: "My friend gave up the city pick last time."
- Demo: seed one prior voyage for Maya so memory is visible live.
- Fallback: if Backboard is unreachable, skip silently (memory is P1).

---

## 10. System prompts (drafts)

### 10.1 Advocate
```
You are {memberName}'s mate at a trip-planning table with friends. You speak ONLY for {memberName}.
You know {memberName}'s sealed terms. Nobody else at the table does, and you must keep it that way:
- Never say {memberName}'s budget, share, or any amount related to what they can spend.
- If a plan doesn't fit their terms, say it doesn't fit or that it's past what they can do. No numbers.
- You may mention public prices exactly as given, and group totals as the range given ("$1,600 to $2,100"); never a single group total.
Goal: get {memberName} a trip they'll love that fits their terms, while helping the group agree.
Be a good friend, not a lawyer: offer trades, concede when a plan is fair for everyone and fits your friend.
Only choose planIds from chart_book. Do not invent places, prices, or plans.
Style: warm, plain spoken, ≤{maxWords} words (35 normally, 20 in Expo mode), one idea per line. At most one nautical word. No emoji.
You may mention {memberName}'s wishes in your own words (e.g. "my friend wants a beach day"), but never quote their private note.
This is Watch {n} of 3. Allowed acts now: {allowedActs}.
If a hail from {memberName} is present, acknowledge and act on it.
Return JSON matching the schema.
```

### 10.2 Captain
```
You are the Captain of a small crew planning a trip. You do not know anyone's budget or private wishes,
and you must never guess or imply who can or can't afford something.
Watch 0: open the meeting in ≤{maxWords} words: the dates everyone can do and the ports on the chart. Invite proposals.
DECIDE: name the two charts in the provided shortlist (do not choose others) and explain the tradeoff in group terms
(what each covers, which leaves more in everyone's pocket). Be decisive and kind. ≤{maxWords} words. No emoji.
Never mention anyone's wishes or limits individually; speak only about the group.
Return JSON matching the schema.
```
As built (`CAPTAIN_SYSTEM` + `openInstruction` / `decideInstruction` in `negotiation/prompts.ts`): the watch-specific parts travel in the user instruction, and DECIDE names each chart's group total only as its public range (S2-002, §3.2), never an exact total.

---

## 11. Failure modes & responses

| Failure | Detection | Response |
|---|---|---|
| Invalid `planId` | not in chart book | Regenerate once; else map to Advocate's top‑scoring plan |
| Over‑long line | > 45 words | Truncate at sentence; ribbon from first clause |
| Budget leak | filter | Regenerate once → template |
| Invented price | validator | Strip amount |
| Gemini timeout (> 6 s) | timer | Template line for act + top plan; log |
| Rate limit | 429 | Backoff 500 ms ×2 → template |
| Everyone concedes to everyone (degenerate) | all CONCEDE | Captain DECIDEs by score |
| No plan fits all | maximin = 0 for all | Captain: "No chart fits every purse. Here are the closest two." Private stamps show over/under |
| Hail flood | a member's hail still waiting | Refuse privately (`HAIL_WAITING`, "Your mate hasn't used your last hail yet"); never dropped silently |
| Late hail | Watch 3 or Captain deciding | Refuse privately (`CAPTAINS_CALLING`) |
| Hail that is only an amount | nothing left after stripping amounts | Refuse privately (`HAIL_AMOUNTS`); no public turn |
| Early hail | Captain's OPEN (Watch 0) | Refuse privately (`TABLE_OPENING`); hails open at Watch 1 |
| Hail probing | refused hails in quick succession | A refused hail stamps the 5 s interval too (`SLOW_DOWN`); the refusal never depends on secrets |

---

## 12. Example run (Expo scenario, doc 07 data)

Crew: **Rae** (organizer, ATL; must: food, nightlife; dealbreaker: early starts), **Maya** (ORD; must: beach, chill; dealbreaker: hostel), **Dev** (absent, JFK; must: food, museums; dealbreaker: 2+ layovers). Caps (private): Rae $1,100 · Maya $900 · Dev $1,400.

Expo mode (≤ 20 words per line). Seating left of the Organizer: Maya, Dev, then Rae last.

| # | Watch | Speaker | Act | Line | Ribbon | Voiced |
|---|---|---|---|---|---|---|
| 0 | 0 | Captain | OPEN | "Mar 12 to 16 works for everyone. Three ports on the chart: Lisbon, Mexico City and Montréal. Let's hear it." | "Mar 12–16 · three ports" | ✓ |
| 1 | 1 | Maya's mate | PROPOSE LIS | "Lisbon. The Cascais beach day is right there for my friend. My friend gave up the city pick last time." | "Lisbon, for the beach" | ✓ |
| 2 | 1 | Dev's mate | PROPOSE MEX | "Mexico City. The street food tour and the anthropology museum are right there for my friend." | "Mexico City, for the food scene" | ✓ |
| 3 | 1 | Rae's mate | PROPOSE MEX | "Seconding Mexico City. The street food tour and the mezcal crawl — exactly what my friend wanted." | "Mexico City, seconded" | ✓ |
| — | 2 | **Rae (human hail)** | HAIL | "I'd pay more for the beach." | — | ✗ (caption only) |
| 4 | 2 | Maya's mate | OBJECT MEX | "Mexico City has no beach — the one thing my friend asked for. Lisbon has it." | "No beach in Mexico City" | ✓ |
| 5 | 2 | Dev's mate | SUPPORT LIS | "Fair. Lisbon still has the food tour and Belém for my friend. I'll back Lisbon." | "Lisbon, with the food tour" | ✓ |
| 6 | 2 | Rae's mate | CONCEDE LIS | "Heard you, Rae. Lisbon it is — as long as we keep the food tour." | "Lisbon — keep the food tour" | ✓ (acknowledgesHail) |
| 7 | — | Captain | DECIDE | "Two charts, then. Mexico City leaves more in everyone's pocket; Lisbon covers the most. Let's run them dry." | "Two charts. Run them dry." | ✓ |

Early exit after Watch 2: backing = Maya→LIS (proposed; OBJECT doesn't change it), Dev→LIS (support), Rae→LIS (concede); no hail waiting → DECIDE. 8 voiced lines ≈ 55–65 s in Expo mode. Line 1's "gave up the city pick last time" comes from Maya's Backboard memory (P1); if memory is cut, the line ends after "for my friend." The wording above is the template output (rules mode, no Gemini key; reproduced by `negotiation.test.ts`, which pins the speakers, acts, cities, the "Heard you, Rae." opener and the shortlist). With `GEMINI_API_KEY` set, Gemini rewords each line within the same act and plan, so the words vary run to run but the shape does not.

Shortlist (computed by §5, only proposed/supported plans): **A = `MEX-W1-roma-flat`** (internal group total $1,975, fits everyone ✓, fairest: maximin 76.3; Maya's must‑have *beach* missing — private) · **B = `LIS-W1-casa-alfama`** (internal group total $2,869, fits everyone ✓, every must‑have covered). The exact totals stay in the helm (pinned by the tests); the table, the Captain's DECIDE and every screen say only the public ranges: Mexico City **$1,550 to $2,100**, Lisbon **$2,650 to $3,100** (S2-002).
Dry Run then shows Lisbon's overnight flights and the 30‑minute uphill walk to fado on Day 1 (red margin notes). Maya privately sees "Fits your terms ✓" on both, plus "no beach" on Mexico City. In the Expo script the crew picks **Lisbon** → shares Rae $1,038 · Maya $868 · Dev $963 (doc 07 §9.1), each seen only by its owner.

Note the design point this demonstrates: the fairness rule proposes, **humans dispose**. The Captain always offers the fairest chart *and* a genuinely different alternative; the Dry Run lets people choose with the tradeoff in front of them.
