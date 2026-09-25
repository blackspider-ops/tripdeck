/**
 * Pre-generates the Expo voices (docs/04 §13 "Demo mode cache"): seeds the Expo voyage, runs the table
 * with ElevenLabs, and leaves every line cached so the live demo plays instantly.
 * Usage: npm run warm-voices --workspace @all-ayes/server   (needs ELEVENLABS_API_KEY)
 */

// Cached mode (DEMO_REPLAY=cached) speaks the protocol's template lines, so warm exactly those: no Gemini, live voices,
// short pauses (Rae's hail must land inside Watch 1–2, as in the e2e test). OPT-061: set through the environment before config.ts is loaded (an empty value also beats .env), instead
// of mutating the config singleton afterwards.
Object.assign(process.env, { GEMINI_API_KEY: "", DEMO_REPLAY: "live", PACE_SCALE: "0.05" });
const { features } = await import("../src/config.js");
const { TripService } = await import("../src/trips/service.js");
const { seedExpo } = await import("../src/demo/seed.js");

if (!features.eleven()) { console.error("Set ELEVENLABS_API_KEY first."); process.exit(1); }
const helm = new TripService();
const seed = await seedExpo(helm);
const t = helm.trip(seed.tripId);
await helm.startTable(t._id, { memberId: seed.organizer.memberId });
// Rae hails once her mate has proposed (as in the Expo script and e2e test); a hail during the Captain's OPEN
// (Watch 0) is refused with TABLE_OPENING (L4-005).
const started = Date.now();
while (!t.negotiation.turns.some((x) => x.act === "PROPOSE" && x.speaker.kind === "advocate" && x.speaker.memberId === seed.organizer.memberId)
  && Date.now() - started < 60_000) await new Promise((r) => setTimeout(r, 20));
helm.hail(t._id, seed.organizer.memberId, "I'd pay more for the beach.");
while (helm.trip(t._id).status === "AT_TABLE" && Date.now() - started < 120_000) await new Promise((r) => setTimeout(r, 250));
console.log(`Cached ${t.negotiation.turns.filter((x) => x.voiced).length} lines. Status: ${helm.trip(t._id).status}`);
process.exit(0);
