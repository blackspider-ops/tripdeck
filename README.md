<p align="center"><img src="apps/web/public/logo.svg" alt="Tripdeck" width="360"></p>

# Tripdeck

**Everyone's in, or nobody pays.**

Live at **[tripdeck.tech](https://tripdeck.tech)**. Built at HackGT 13.

## Why we made this

Every friend group has a trip that died in the group chat. It usually goes the same way. Nobody wants to be the one who says "that's too expensive", so the plan drifts toward whatever the loudest person wants. Then one person books everything on their card and spends the next month chasing Venmo requests.

Tripdeck fixes both halves of that. Each friend privately tells their own AI mate what they can spend, what they want and what they won't do. The mates then sit around a chart table and argue it out loud, on a Meta Quest sitting on your actual table or on a laptop. Nobody's budget is ever said out loud, only "that's outside what my person can do". When the crew picks a trip, everyone approves their own share on their own card, capped at the limit they set. If one share doesn't go through, nobody is charged.

## How a trip goes

1. **Start a trip.** The organizer picks a few cities (or a region, or "anywhere") and a date range. They can do this on a phone or right inside the Quest.
2. **Everyone joins.** Friends scan a QR code or type a six-letter code. Each person joins on their own phone or their own headset.
3. **Brief your mate.** You tell your mate your budget, the days you're free, what you'd love and what you'd skip. Only you and your mate ever see this.
4. **The table.** The mates propose, object and back each other around a paper globe. Everyone hears it in their mate's own voice. You can jump in and hail your mate if it's missing something.
5. **Dry Run.** The two best trips play out as small cities under glass, a day at a time, so you can see the actual itinerary before anyone pays.
6. **Vote.** Everyone votes. A majority picks the trip after a short countdown. Friends who couldn't make it have their mate vote based on their terms.
7. **Seal.** Each person sees their own share and approves it with Face ID, a passkey or a PIN in the headset. Holds only turn into charges once every seal is set.
8. **Booked.** You get the full day-by-day itinerary, your own receipt and a calendar file.

## Try it

The fastest way is the hosted version at [tripdeck.tech](https://tripdeck.tech). It runs on Render's free plan, so the first load after a quiet spell can take up to a minute while it wakes up.

On a Meta Quest 3 or 3S, open the Quest Browser and go to `tripdeck.tech/xr`:

- **Start a trip** makes the headset the organizer's seat.
- **Join a trip** takes the six-letter code. Pick "I'm new" for a fresh seat, or pick your name if you already joined on a phone. Your phone then gets a one-tap "Let this headset in?" prompt.
- **Enter the chart room** starts mixed reality. Pinch the middle of your table to lay the chart down, then pinch the corner nearest you so everyone in the same room lines up.
- The **Log book** tag on the table opens a side panel with the trip, the crew, your terms, the vote and your seal.

Run room setup on the Quest first (Settings, Physical Space, Space Setup) and mark your table. The table snaps to it much better.

## Running it locally

You need Node 22 or newer.

```bash
npm install
cp .env.example .env   # every key is optional; it runs without any of them
npm run dev            # server on :8787, web on :5173
```

Open `http://localhost:5173/demo` and seed a random trip. That gives you a crew with one-time links for each person. Each link works once, so open each one on a different device or in a private window.

A Quest needs HTTPS. The easiest way to get it during development is a Cloudflare quick tunnel:

```bash
cloudflared tunnel --url http://localhost:5173
```

Then open the printed `https://....trycloudflare.com/xr` in the Quest Browser.

Useful commands:

| Command | What it does |
|---|---|
| `npm run dev` | Server and web app with hot reload |
| `npm test` | Server and web test suites |
| `npm run check` | Typecheck, tests, production build and the bundle size budget. Run this before pushing |
| `npm run build` | Production build of the web app and the server |
| `npm run start:prod` | Runs the built server, which also serves the web app |

## What each service does

Everything works without keys. Each integration makes it better when it's there.

| Service | With a key | Without one |
|---|---|---|
| Gemini | Every mate and the Captain talk in their own words, with natural filler like "um" and "okay so" | Template lines, still with plenty of variety |
| ElevenLabs | A distinct voice for every seat, and spoken hails | Captions and the browser's built-in speech |
| MongoDB Atlas | Trips survive restarts and can be picked back up | Kept in memory |
| Backboard | Your mate remembers you across trips | Local memory |
| Visa Developer sandbox | Each card is verified against the Visa sandbox when you seal | A clearly labelled simulation |
| RouteStack | Live hotel and flight prices where available | Hand-written city data and modelled fares |
| Google 3D Tiles or Cesium ion | Photoreal cities in the Dry Run | Paper low-poly cities |

## About the payments

We want to be upfront about what is real here. When a member sets their seal with `PAYMENTS_MODE=visa_sandbox`, the server makes a real call to the Visa Developer sandbox (mutual TLS plus message-level encryption) to validate the card. The Visa sandbox test card stands in for the member's real card. The holds, captures and the all-or-nothing rule on top of that are our own simulation of Visa Intelligent Commerce's agent card model: a card capped at your limit, locked to travel purchases, and approved by you. No real money moves. Every money screen says which parts are sandbox and which are simulated.

## Project layout

```
packages/shared   types, socket events and constants shared by both sides
apps/server       the "helm": pricing and fairness, the negotiation engine, the privacy filter,
                  payments, voice, memory, REST and WebSocket APIs
apps/web          phone screens (React), the headset (three.js and WebXR), and the laptop view
```

## Deploying

One Docker container. `render.yaml` is a Render blueprint for it, and [`DEPLOY.md`](DEPLOY.md) covers the details, including where the Visa certificates go (Render secret files).

## Known limits

- Hotel and activity data is a hand-written sample for over a hundred cities, plus any city from OpenStreetMap. Flights that aren't live-priced come from a formula based on distance and season. Treat prices as illustrative.
- The mixed reality side has been tested on a Quest 3S, but a few things are still rough: two headsets in the same room, and text size on some of the older table labels.
- The free Render plan sleeps when idle, so give it a minute on the first visit.
- Passkeys are optional. Without one, setting your seal is a tap on your phone, or your PIN in the headset.
- Your mate's memory is tied to a private key stored in your browser. There are no accounts, so clearing the browser starts a fresh memory.

## Credits

Map data from OpenStreetMap contributors. Voices by ElevenLabs.
