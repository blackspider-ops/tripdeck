# 07 — Dataset Specification: "Three Ports" preset

We use a **curated, illustrative dataset** — not live inventory. Real multi‑supplier booking by agents is still unsolved industry‑wide in 2026, and live APIs would eat our 36 hours. Prices are realistic ballparks for mid‑March 2027 but **invented for the demo**; Devpost and the pitch say so.

File: `apps/server/src/data/dataset.json` (loaded into memory once at boot and indexed; nothing is seeded into MongoDB. `apps/server/src/demo/seed.ts`, run by `POST /api/demo/seed` from the `/demo` page, creates the Expo trip).

---

## 1. Conventions
- Money: **USD cents** in JSON (`priceCents`), dollars in this doc for readability.
- Flights are **round‑trip, per person**, for date window `W1` unless noted.
- Hotels: `nightlyCents` is for the **whole unit**; `sleeps` = max people. 4 nights in W1.
- Activities: price per person; `durationMin`; `startEarliest`/`startLatest` local time.
- Coordinates WGS84 (used for Dry Run placement + walking times).
- `id` format: `<CITY>-<kind>-<slug>`.

## 2. Preset
```json
{
  "presetId": "three-ports",
  "name": "Three Ports",
  "cities": ["LIS", "MEX", "YUL"],
  "origins": ["ATL", "ORD", "JFK"],
  "dateWindows": [
    {"id": "W1", "start": "2027-03-12", "end": "2027-03-16", "nights": 4},
    {"id": "W2", "start": "2027-03-13", "end": "2027-03-16", "nights": 3}
  ]
}
```
(W2 flights = W1 price + 8%; W2 is only used if some member can't do W1.)

## 3. Cities
| id | Name | Center (lat, lng) | Tiles radius | Scale in cloche | Public flags |
|---|---|---|---|---|---|
| LIS | Lisbon | 38.7120, −9.1380 | 1.5 km | 8 cm per km | "hilly neighborhoods", "overnight flights from the US" |
| MEX | Mexico City | 19.4200, −99.1650 | 2.0 km | 6 cm per km | "high altitude (2,240 m)" |
| YUL | Montréal | 45.5080, −73.5700 | 1.5 km | 8 cm per km | "below freezing in March" |

Inside the radius (drawn in the cloche): LIS — Casa Alfama, Baixa, Castelo, Bairro Alto/fado; MEX — Roma Norte flat, food tour, mezcal crawl, Arena México. Outside (rim arrows): Cascais, Belém, Tile Museum, Sintra; Frida Kahlo museum, Anthropology museum, Xochimilco, Teotihuacán.

---

## 4. Flights (round trip, W1, per person)

| id | City | From | Airline | Out (local) | Stops | Red‑eye | Price |
|---|---|---|---|---|---|---|---|
| LIS-f-atl-dl | LIS | ATL | Delta | 18:10 → 07:55+1 | 0 | yes | $690 |
| LIS-f-atl-ua | LIS | ATL | United (via EWR) | 13:05 → 08:30+1 | 1 | yes | **$612** |
| LIS-f-ord-ua | LIS | ORD | United (via EWR) | 12:40 → 08:30+1 | 1 | yes | **$520** |
| LIS-f-ord-tp | LIS | ORD | TAP | 17:30 → 07:20+1 | 0 | yes | $648 |
| LIS-f-jfk-tp | LIS | JFK | TAP | 20:30 → 08:25+1 | 0 | yes | **$540** |
| LIS-f-jfk-dl | LIS | JFK | Delta | 19:00 → 07:05+1 | 0 | yes | $575 |
| MEX-f-atl-dl | MEX | ATL | Delta | 09:40 → 11:25 | 0 | no | **$380** |
| MEX-f-ord-am | MEX | ORD | Aeroméxico | 08:15 → 11:55 | 0 | no | **$330** |
| MEX-f-jfk-am | MEX | JFK | Aeroméxico | 08:00 → 11:40 | 0 | no | **$360** |
| MEX-f-jfk-2s | MEX | JFK | Budget (2 stops) | 06:05 → 16:50 | 2 | no | $245 |
| YUL-f-atl-dl | YUL | ATL | Delta | 10:15 → 12:45 | 0 | no | **$310** |
| YUL-f-ord-ac | YUL | ORD | Air Canada | 09:00 → 11:55 | 0 | no | **$280** |
| YUL-f-jfk-dl | YUL | JFK | Delta | 08:30 → 10:05 | 0 | no | **$190** |

**Bold** = cheapest valid for the Expo crew (Dev's `layovers_2plus` dealbreaker rules out `MEX-f-jfk-2s`).
Return legs: same airline, departing 12:00–15:00 local on Mar 16.

---

## 5. Hotels (whole unit per night; W1 = 4 nights)

| id | City | Name | Type | Neighborhood | lat, lng | Sleeps | Nightly | Rating |
|---|---|---|---|---|---|---|---|---|
| LIS-h-casa-alfama | LIS | Casa Alfama | apartment | Alfama | 38.7110, −9.1300 | 4 | **$210** | 4.6 |
| LIS-h-baixa-triple | LIS | Hotel Baixa (triple room) | hotel | Baixa | 38.7107, −9.1374 | 3 | $235 | 4.4 |
| LIS-h-cais-loft | LIS | Cais Loft | apartment | Cais do Sodré | 38.7060, −9.1440 | 4 | $260 | 4.5 |
| LIS-h-belem-guest | LIS | Belém Guesthouse | guesthouse | Belém | 38.6970, −9.2060 | 3 | $260 | 4.2 |
| LIS-h-bairro-hostel | LIS | Bairro Alto Hostel (3 beds) | hostel | Bairro Alto | 38.7131, −9.1447 | 3 | $126 | 4.0 |
| MEX-h-roma-flat | MEX | Roma Norte Flat | apartment | Roma Norte | 19.4150, −99.1620 | 4 | **$150** | 4.4 |
| MEX-h-condesa | MEX | Condesa Boutique (triple) | hotel | Condesa | 19.4120, −99.1740 | 3 | $210 | 4.6 |
| MEX-h-polanco | MEX | Polanco Hotel (triple) | hotel | Polanco | 19.4330, −99.1950 | 3 | $290 | 4.7 |
| MEX-h-coyoacan | MEX | Casa Coyoacán | guesthouse | Coyoacán | 19.3500, −99.1620 | 4 | $120 | 4.3 |
| MEX-h-centro-hostel | MEX | Centro Hostel (3 beds) | hostel | Centro Histórico | 19.4326, −99.1332 | 3 | $66 | 3.9 |
| YUL-h-plateau | YUL | Plateau Apartment | apartment | Plateau | 45.5230, −73.5810 | 4 | **$170** | 4.3 |
| YUL-h-old-mtl | YUL | Old Montréal Inn (triple) | hotel | Vieux‑Montréal | 45.5075, −73.5540 | 3 | $240 | 4.6 |
| YUL-h-mile-end | YUL | Mile End Guesthouse | guesthouse | Mile End | 45.5250, −73.6000 | 3 | $135 | 4.2 |
| YUL-h-griffintown | YUL | Griffintown Loft | apartment | Griffintown | 45.4920, −73.5600 | 4 | $200 | 4.4 |
| YUL-h-downtown-hostel | YUL | Downtown Hostel (3 beds) | hostel | Downtown | 45.5017, −73.5673 | 3 | $105 | 4.0 |

Hostels are excluded for the Expo crew (Maya's `hostel` dealbreaker).

---

## 6. Activities (per person)

`group` = default **group moment** (everyone attends) for that city's plans; others are **picks** attended only by members whose must‑haves match.

### Lisbon
| id | Name | Tags | lat, lng | Min | Start window | Price | Role |
|---|---|---|---|---|---|---|---|
| LIS-a-tram-castle | Tram 28 & Castelo de São Jorge | history | 38.7139, −9.1334 | 150 | 09:30–15:00 | $18 | group |
| LIS-a-fado | Fado night (Bairro Alto tasca) | music, nightlife | 38.7127, −9.1440 | 120 | 20:00–21:30 | $38 | group |
| LIS-a-food-tour | Tascas & pastéis food tour | food | 38.7107, −9.1374 | 180 | 11:00–13:00 | $65 | pick |
| LIS-a-cascais | Cascais beach day (train) | beach, chill | 38.6979, −9.4215 | 360 | 10:00–12:00 | $12 | pick |
| LIS-a-belem | Belém Tower & Jerónimos | museums, history | 38.6916, −9.2160 | 180 | 09:30–14:00 | $22 | pick |
| LIS-a-tile-museum | National Tile Museum | museums | 38.7247, −9.1136 | 90 | 10:00–16:00 | $8 | pick |
| LIS-a-bairro-night | Bairro Alto night out | nightlife | 38.7131, −9.1447 | 180 | 22:00–23:30 | $25 | pick |
| LIS-a-sintra | Sintra day trip | history, nature | 38.7876, −9.3905 | 480 | 07:30–08:30 | $55 | pick (early start) |

### Mexico City
| id | Name | Tags | lat, lng | Min | Start window | Price | Role |
|---|---|---|---|---|---|---|---|
| MEX-a-frida | Museo Frida Kahlo | museums, history | 19.3551, −99.1625 | 120 | 10:00–17:00 | $18 | group |
| MEX-a-lucha | Lucha libre, Arena México | nightlife | 19.4247, −99.1500 | 150 | 19:30–20:30 | $30 | group |
| MEX-a-food-tour | Roma street food tour | food | 19.4150, −99.1620 | 180 | 11:00–13:00 | $55 | pick |
| MEX-a-anthro | Museo Nacional de Antropología | museums | 19.4260, −99.1863 | 180 | 09:00–15:00 | $6 | pick |
| MEX-a-mezcal | Mezcal bar crawl, Roma | nightlife | 19.4180, −99.1600 | 180 | 21:00–23:00 | $25 | pick |
| MEX-a-xochimilco | Xochimilco trajinera | chill, music | 19.2570, −99.1030 | 180 | 11:00–15:00 | $20 | pick |
| MEX-a-teotihuacan | Teotihuacán pyramids | history, nature | 19.6925, −98.8438 | 480 | 06:30–07:30 | $45 | pick (early start) |

### Montréal
| id | Name | Tags | lat, lng | Min | Start window | Price | Role |
|---|---|---|---|---|---|---|---|
| YUL-a-old-mtl | Old Montréal walk | history | 45.5075, −73.5540 | 120 | 10:00–15:00 | $0 | group |
| YUL-a-jazz | Jazz bar night | music, nightlife | 45.5100, −73.5650 | 150 | 20:00–21:30 | $20 | group |
| YUL-a-market | Jean‑Talon market food walk | food | 45.5362, −73.6146 | 150 | 10:00–13:00 | $40 | pick |
| YUL-a-bagels | St‑Viateur vs Fairmount bagel run | food | 45.5227, −73.6010 | 60 | 08:30–16:00 | $12 | pick |
| YUL-a-mmfa | Museum of Fine Arts | museums | 45.4986, −73.5794 | 150 | 10:00–15:00 | $24 | pick |
| YUL-a-snowshoe | Mont‑Royal snowshoe | nature | 45.5048, −73.5874 | 150 | 09:00–13:00 | $25 | pick |
| YUL-a-spa | Bota Bota floating spa | chill | 45.5000, −73.5510 | 180 | 10:00–17:00 | $70 | pick |

---

## 7. Walking & transit model (`dryrun/walking.ts`)
```
straightKm = haversine(a, b)
if straightKm ≤ 2.0:  mode = walk;  minutes = straightKm × 1.3 / 4.8 km/h × 60 × hillFactor(city, a, b)
elif straightKm ≤ 8: mode = taxi;  minutes = 8 + straightKm × 2.5
else:                mode = train/taxi (dataset override)
hillFactor: LIS segments touching Alfama/Bairro Alto/Castelo = 1.4, else 1.0
flag long_walk if walk minutes > 25; flag early_start if activity start or flight departure < 08:00
flag red_eye if the outbound flight is overnight (arrives next calendar day)
```
Dataset `overrides` (checked first):
| From → To | Mode | Minutes | Note |
|---|---|---|---|
| LIS-h-casa-alfama → LIS-a-fado | walk | **30** | steep streets; **flagged** |
| LIS-h-casa-alfama → LIS-a-cascais | tram + train | 55 | via Cais do Sodré |
| LIS-h-casa-alfama → LIS-a-belem | tram | 35 | Tram 15E |
| MEX-h-roma-flat → MEX-a-frida | taxi | 25 | |
| MEX-h-roma-flat → MEX-a-xochimilco | taxi | 45 | |
| MEX-h-roma-flat → MEX-a-anthro | taxi | 15 | |
| MEX-h-roma-flat → MEX-a-lucha | taxi | 15 | |
| MEX-a-frida → MEX-a-lucha | taxi | 30 | Coyoacán → Doctores |
| MEX-a-xochimilco → MEX-a-frida | taxi | 25 | |

---

## 8. Expo crew (seeded by `apps/server/src/demo/seed.ts`)

| Member | Role | Band | Origin | Cap (PRIVATE) | Dates | Must‑haves | Dealbreakers | Note | Memory seed |
|---|---|---|---|---|---|---|---|---|---|
| Rae | organizer | 1 Prussian | ATL | $1,100 | W1 | food, nightlife | early_start | "Want at least one big night out" | — |
| Maya | member | 2 Sienna | ORD | $900 | W1 | beach, chill | hostel | "I get tired walking hills" | "Conceded the city choice last voyage (Chicago → Nashville)" |
| Dev | absent | 3 Olive | JFK | $1,400 | W1, W2 | food, museums | layovers_2plus | "Can't join live, trust my mate" | — |

---

## 9. Worked plans (expected output of `fit/pricing.ts` — pinned by `apps/server/test/pricing.test.ts`)

These are the **internal** plans (server-only). The exact group totals below are the sum of the private shares, so they never leave the helm: the public view, the Captain and the table show a range instead (`publicTotalRange`: the lowest–highest total any crew of this size could have for that city, stay, window and pick set, widened to $50 — Lisbon **$2,650 to $3,100**, Mexico City **$1,550 to $2,100**; S2-002). Members see only their own exact share.

Pick rule (as built): group moments for everyone; then for each must‑have, the first `pick` (dataset order) with that tag unless one of the member's picks already covers it. So Rae gets one food pick in Montréal (the market), not two, and Belém's guesthouse is priced at $260/night so that Casa Alfama is the only Lisbon stay that fits every purse (keeps the Expo story stable).

### 9.1 `LIS-W1-casa-alfama` (Lisbon)
Hotel: Casa Alfama $210 × 4 = **$840** → $280.00 each.
| Member | Flight | Lodging | Activities attended | Share | Cap | Fits |
|---|---|---|---|---|---|---|
| Rae | $612 (LIS-f-atl-ua) | $280 | tram‑castle 18 + fado 38 + food tour 65 + Bairro night 25 = **$146** | **$1,038.00** | $1,100 | ✓ |
| Maya | $520 (LIS-f-ord-ua) | $280 | tram‑castle 18 + fado 38 + Cascais 12 = **$68** | **$868.00** | $900 | ✓ |
| Dev | $540 (LIS-f-jfk-tp) | $280 | tram‑castle 18 + fado 38 + food tour 65 + Belém 22 = **$143** | **$963.00** | $1,400 | ✓ |
| **Group** | | | | **$2,869.00** | | fits everyone ✓ |

Flags: all members `red_eye` (overnight outbound); all members `long_walk` Day 1 (hotel → fado, 30 min). Must‑haves: all covered.

### 9.2 `MEX-W1-roma-flat` (Mexico City)
Hotel: Roma Norte Flat $150 × 4 = **$600** → $200.00 each.
| Member | Flight | Lodging | Activities | Share | Fits |
|---|---|---|---|---|---|
| Rae | $380 | $200 | Frida 18 + lucha 30 + food tour 55 + mezcal 25 = **$128** | **$708.00** | ✓ |
| Maya | $330 | $200 | Frida 18 + lucha 30 + Xochimilco 20 = **$68** | **$598.00** | ✓ (beach **missing**) |
| Dev | $360 | $200 | Frida 18 + lucha 30 + food tour 55 + anthro 6 = **$109** | **$669.00** | ✓ |
| **Group** | | | | **$1,975.00** | fits everyone ✓ |

Flags: none. Maya's must‑have *beach* not covered (private).

### 9.3 `YUL-W1-plateau` (Montréal)
Hotel $170 × 4 = $680 → $226.67 / $226.67 / $226.66 (remainder cent to organizer: Rae $226.68, others $226.66).
| Member | Flight | Lodging | Activities | Share |
|---|---|---|---|---|
| Rae | $310 | $226.68 | old‑mtl 0 + jazz 20 + market 40 = $60 | $596.68 |
| Maya | $280 | $226.66 | old‑mtl 0 + jazz 20 + spa 70 = $90 | $596.66 |
| Dev | $190 | $226.66 | old‑mtl 0 + jazz 20 + market 40 + MMFA 24 = $84 | $500.66 |
| **Group** | | | | **$1,694.00** |

Flags: public "below freezing in March". Maya's beach missing.

### 9.4 Fairness (doc 05 §5), approximate
| Plan | Rae | Maya | Dev | maximin | sum |
|---|---|---|---|---|---|
| MEX-W1-roma-flat | 98.8 | 76.3 | 98.8 | **76.3** | 273.9 |
| YUL-W1-plateau | 98.6 | 76.1 | 98.6 | 76.1 | 273.3 |
| LIS-W1-casa-alfama | 65.6 | 63.8 | 85.9 | 63.8 | 215.3 |

(LIS numbers include 2 flags each for red‑eye + long walk; exact values come from code — fixtures should be regenerated from `fairness.ts`, not copied from here.)

Because the Captain only shortlists plans that were **proposed or supported** in the meeting (doc 05 §5), Montréal (never proposed in the Expo run) is excluded → **Chart A = Mexico City** (fairest), **Chart B = Lisbon** (covers every must‑have). The crew then chooses in the Dry Run — in the Expo script they choose **Lisbon** (Maya gets their beach; everyone still fits).

---

## 10. Dry Run scripts (Expo)

> Generated by `apps/server/src/fit/pricing.ts` (group moments: daytime at the window's latest start, evening at the earliest; picks placed at the first :00/:30 slot after landing +60 min with a 30‑min buffer, else Day 2). The tables below are the Expo output; minor minute differences are expected if the dataset changes.

### Lisbon — Day 1 (Sat Mar 13)
| Time | Who | What | Travel in | Flag |
|---|---|---|---|---|
| 08:30 | all | Land LIS, taxi to Casa Alfama | 25 min taxi | red‑eye |
| 11:00 | Rae, Dev | Food tour (Baixa) | 12 min walk | |
| 11:00 | Maya | Rest at the flat | — | |
| 15:00 | all | Tram 28 & Castelo | 8 min walk | |
| 20:00 | all | Fado night, Bairro Alto | **30 min uphill walk** | **long walk** |
| 22:30 | Rae | Bairro Alto night out | 2 min walk | |
### Lisbon — Day 2 (Sun Mar 14)
| 10:00 | Maya | Cascais beach day | 55 min tram + train | |
| 10:00 | Dev | Belém Tower & Jerónimos | 35 min tram | |
| 10:30 | Rae | Sleep in, pastéis | — | |

### Mexico City — Day 1 (Fri Mar 12 — daytime flights land the same day)
| Time | Who | What | Travel in | Flag |
|---|---|---|---|---|
| 11:25–11:55 | all | Land MEX (daytime; ATL 11:25, JFK 11:40, ORD 11:55), taxi to Roma Norte | 30 min taxi | |
| 13:00 | Rae, Dev | Roma street food tour | 3 min walk | |
| 13:00 | Maya | Xochimilco trajinera | 45 min taxi | |
| 17:00 | all | Frida Kahlo museum (late entry, window ends 17:00) | 25 min taxi | |
| 19:30 | all | Lucha libre | 30 min taxi | |
| 22:00 | Rae | Mezcal crawl | 10 min taxi | |
### Mexico City — Day 2 (Sat Mar 13)
| 10:00 | Dev | Anthropology museum | 15 min taxi | |
| 11:00 | Rae, Maya | Brunch + Condesa park (free) | 10 min walk | |

(Clock speed: 1 s = 15 min → Day 1 from 08:00 to 23:00 plays in 60 s; the Expo script plays **Day 1 only**, both cloches in sync. The Narrator talks over it and can pinch the clock to pause.)

---

## 11. JSON shape examples
```json
{ "_id":"LIS-f-ord-ua","kind":"flight","cityId":"LIS","origin":"ORD","dateWindowId":"W1",
  "airline":"United","departLocal":"2027-03-12T12:40","returnLocal":"2027-03-16T13:10",
  "stops":1,"redEye":true,"priceCents":52000 }

{ "_id":"LIS-h-casa-alfama","kind":"hotel","cityId":"LIS","name":"Casa Alfama","neighborhood":"Alfama",
  "lat":38.7110,"lng":-9.1300,"stayType":"apartment","nightlyCents":21000,"sleeps":4,"rating":4.6 }

{ "_id":"LIS-a-cascais","kind":"activity","cityId":"LIS","name":"Cascais beach day (train)",
  "tags":["beach","chill"],"lat":38.6979,"lng":-9.4215,"durationMin":360,"priceCents":1200,
  "startEarliest":"10:00","startLatest":"12:00","role":"pick" }
```

## 12. Data QA checklist
- [ ] Every stop outside the city tile radius (list in §3) renders as an **edge arrow** on the cloche rim ("to Cascais · 55 min").
- [ ] Every scheduled activity starts inside its own start window (§6 vs §10).
- [ ] Unit test reproduces §9 shares to the cent.
- [ ] No hostel appears in any Expo shortlist.
- [ ] MEX 2‑stop flight never chosen for Dev.
- [ ] Walking overrides applied (Casa Alfama → fado = 30 min, flagged).
