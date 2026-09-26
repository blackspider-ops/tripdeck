/**
 * Demo voyages for the /demo page (docs/09):
 *
 *   seedRandom (default)  a fresh crew each time: 3–8 people from a list of names, random home airports, budget
 *                         bands and caps, must-haves, dealbreakers and notes, 3 random ports, a random date range
 *                         2–9 months out (so live fares are on sale) with random trip lengths and per-member
 *                         availability (mostly overlapping; sometimes one person with a gap), and one member away with
 *                         a standing instruction. Deterministic for a given seed (and day).
 *   seedExpo              the scripted Expo scenario (docs/07-dataset-spec.md §8): Rae (organizer, ATL), Maya (ORD),
 *                         Dev (absent, JFK) on Lisbon / Mexico City / Montréal in W1–W2, all briefs sealed, Maya's
 *                         memory from a previous voyage, Dev's standing instruction. Its briefs lead to Lisbon by
 *                         design (tests and the pitch rely on its numbers); the engine itself is generic.
 */
import type { Availability, Band, BriefInput, DateRange, Dealbreaker, Tag } from "@all-ayes/shared";
import { addDays, daysOf } from "@all-ayes/shared";
import { CAP_MAX_CENTS, CAP_MIN_CENTS, CAP_STEP_CENTS, DEALBREAKERS, MAX_DEALBREAKERS, MAX_MUST_HAVES, ORIGINS, TAGS } from "@all-ayes/shared";
import type { TripService } from "../trips/service.js";
import { crewKeyHash, personKey, recall, remember } from "../memory/memory.js";
import { newToken } from "../util/ids.js";
import { sample } from "../trips/course.js";
import { isGeneratedPort } from "../data/loader.js";

export type DemoKind = "random" | "expo";

/** A seat handed to a phone: the /demo page shows its link (a one-time handoff code, SEC-004). */
export interface DemoSeat { name: string; role: "organizer" | "member" | "absent"; band: Band; memberId: string; memberToken: string; handoff: string }
export interface DemoSeed {
  kind: DemoKind; seed?: number; tripId: string; joinCode: string; tripName: string;
  organizer: DemoSeat; crew: DemoSeat[]; ports: string[]; headsetCode: string;
  /** Expo only (older clients): Maya's and Dev's seats. */
  maya?: DemoSeat; dev?: DemoSeat;
}

/** The scripted Expo voyage (unchanged numbers: Lisbon shares $1,038 / $868 / $963). */
export async function seedExpo(helm: TripService): Promise<DemoSeed & { maya: DemoSeat; dev: DemoSeat }> {
  const { trip, member: rae, token: raeToken } = helm.createTrip({
    name: "Spring Break '27", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX", "YUL"], windowIds: ["W1", "W2"],
  });
  // docs/12: the Expo keeps its curated flights and stays exactly (no live prefetch), before any terms seal
  trip.curatedOnly = true;
  helm.save(trip);
  // SEC-003: memory is keyed on a private crew key, not "Maya|ORD". Seeded Maya gets her own fresh key, and her
  // "previous voyage" is written under it, so the Expo line ("gave up the city pick last time") still plays and
  // nobody else's history can leak into (or out of) the demo.
  const mayaCrewKey = newToken();
  const maya = helm.join(trip._id, { name: "Maya", band: 2, origin: "ORD", crewKey: mayaCrewKey });
  const dev = helm.addAbsent(trip._id, { memberId: rae._id }, { name: "Dev", band: 3, origin: "JFK" });
  const devClaim = helm.claimAbsent(trip._id, dev.memberId, dev.inviteKey);

  const mayaKey = personKey(crewKeyHash(mayaCrewKey), "Maya");
  if (!(await recall(mayaKey)).some((m) => /conceded/i.test(m))) {
    await remember(mayaKey, "voyage: Nashville · booked · mid budget · conceded the city choice (wanted Chicago)");
  }

  await helm.submitBrief(trip._id, rae._id, { capCents: 110_000, dateWindowIds: ["W1"], mustHaves: ["food", "nightlife"], dealbreakers: ["early_start"], note: "Want at least one big night out" });
  await helm.submitBrief(trip._id, maya.member._id, { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: ["beach", "chill"], dealbreakers: ["hostel"], note: "I get tired walking hills" });
  await helm.submitBrief(trip._id, dev.memberId, { capCents: 140_000, dateWindowIds: ["W1", "W2"], mustHaves: ["food", "museums"], dealbreakers: ["layovers_2plus"], note: "Can't join live, trust my mate" });

  const { code } = helm.headsetCode(trip._id, { memberId: rae._id });
  // SEC-004: the /demo page hands phones a one-time handoff code (fragment of the link), never a member token
  const seat = (name: string, role: DemoSeat["role"], band: Band, memberId: string, memberToken: string): DemoSeat =>
    ({ name, role, band, memberId, memberToken, handoff: helm.mintHandoff(trip._id, memberId, memberToken) });
  const organizer = seat("Rae", "organizer", 1, rae._id, raeToken);
  const mayaSeat = seat("Maya", "member", 2, maya.member._id, maya.token);
  const devSeat = seat("Dev", "absent", 3, dev.memberId, devClaim.memberToken);
  return {
    kind: "expo", tripId: trip._id, joinCode: trip.joinCode, tripName: trip.name,
    organizer, crew: [organizer, mayaSeat, devSeat], ports: portNames(helm, trip.candidateCityIds), headsetCode: code,
    maya: mayaSeat, dev: devSeat,
  };
}

// ---------- the random voyage ----------
const NAMES = [
  "Ava", "Ben", "Cleo", "Dara", "Eli", "Finn", "Gus", "Hana", "Ines", "Jae", "Kofi", "Lena", "Milo", "Nia", "Omar", "Priya",
  "Quinn", "Rosa", "Sami", "Tess", "Uma", "Vik", "Wren", "Yara", "Zane", "Theo", "Mei", "Luca",
];
const NOTES = [
  "I get tired walking hills", "Want at least one big night out", "Need a slow morning or two", "Would love a good market",
  "Early flights are rough for me", "Something outdoorsy please", "Keen on live music", "Keep it easy on the wallet",
  "Big on local food", "A day by the water would be perfect", "Can't join live, trust my mate", "Museums over nightclubs",
];
const TRIP_NAMES = ["Long weekend", "The big one", "Crew escape", "Group trip", "Reunion voyage", "Off the clock", "Shore leave"];
/** Budget bands (dollars): the cap is drawn inside one, on the dial's $50 steps. */
const BANDS_USD: [number, number][] = [[700, 1100], [1100, 1700], [1700, 2600]];

/** A random demo crew has 3–8 people (MAX_CREW allows 12; 8 keeps the demo table short). */
export const RANDOM_CREW_MIN = 3;
export const RANDOM_CREW_MAX = 8;

/** mulberry32: a small, fast PRNG — the whole random voyage follows from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The random crew and course for a seed (pure: no helm), so tests can check what a seed makes. `windows` and each
 * brief's `dateWindowIds` are the older fixed-window draw (pure pricing tests use them); the demo voyage itself uses
 * `dateRange` and each member's `availability` (drawn after everything else, so older draws are unchanged).
 */
export function randomVoyagePlan(seed: number, cityIds: string[], windowIds: string[], crewSize?: number, today = new Date().toISOString().slice(0, 10)) {
  const r = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length) % xs.length];
  const drawn = RANDOM_CREW_MIN + Math.floor(r() * (RANDOM_CREW_MAX - RANDOM_CREW_MIN + 1)); // 3–8
  // /demo?crew=N asks for a crew size (2..MAX_CREW) — the draw above still runs so the rest of the seed is unchanged
  const size = crewSize ?? drawn;
  const shuffled = [...NAMES];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const ports = sample(cityIds, 3, r);
  const nWindows = 1 + Math.floor(r() * 3);
  const windows = sample(windowIds, nWindows, r);
  const common = pick(windows);
  const crew = shuffled.slice(0, size).map((name, i) => {
    const [lo, hi] = pick(BANDS_USD);
    const cap = Math.min(CAP_MAX_CENTS, Math.max(CAP_MIN_CENTS, Math.round((lo + r() * (hi - lo)) * 100 / CAP_STEP_CENTS) * CAP_STEP_CENTS));
    const tags = TAGS.map((t) => t.id);
    const mustHaves = sample(tags, 1 + Math.floor(r() * MAX_MUST_HAVES), r) as Tag[];
    const nDb = Math.floor(r() * 3) % (MAX_DEALBREAKERS + 1);
    const dealbreakers = sample(DEALBREAKERS.map((d) => d.id), nDb, r) as Dealbreaker[];
    // everyone can do one shared window; some can do others too
    const dateWindowIds = windows.filter((w) => w === common || r() < 0.4);
    const brief: BriefInput = { capCents: cap, dateWindowIds, mustHaves, dealbreakers, note: pick(NOTES) };
    const role: DemoSeat["role"] = i === 0 ? "organizer" : i === size - 1 ? "absent" : "member";
    return { name, role, band: (i + 1) as Band, origin: pick(ORIGINS), brief };
  });
  const tripName = pick(TRIP_NAMES);
  const { dateRange, availability } = randomDates(r, today, crew.length);
  return { tripName, ports, windows, crew: crew.map((c, i) => ({ ...c, availability: availability[i] })), dateRange };
}

/**
 * A date range starting 2–9 months out (it ends within ~10, inside the airlines' ~330-day sales horizon), 10–40 days
 * long, trips of 2–4 up to 3 more nights; everyone is free on a shared block long enough for the longest trip, most
 * mark a few more days (some "any of these dates"), and in about a third of voyages one member has a gap in the block.
 */
export function randomDates(r: () => number, today: string, n: number): { dateRange: DateRange; availability: Availability[] } {
  const start = addDays(today, 61 + Math.floor(r() * 200));
  const len = 10 + Math.floor(r() * 31);
  const end = addDays(start, len - 1);
  const minNights = 2 + Math.floor(r() * 3);
  const maxNights = minNights + Math.floor(r() * 4);
  const days = daysOf(start, end);
  const blockLen = Math.min(days.length, maxNights + 1 + Math.floor(r() * 5));
  const at = Math.floor(r() * (days.length - blockLen + 1));
  const block = days.slice(at, at + blockLen);
  const gapped = n > 2 && r() < 0.35 ? 1 + Math.floor(r() * (n - 1)) : -1; // never the organizer
  const availability = Array.from({ length: n }, (_, i): Availability => {
    if (i !== gapped && r() < 0.3) return { any: true };
    const mine = new Set(block);
    const extra = Math.floor(r() * 3);
    for (let k = 0; k < extra; k++) {
      const s0 = Math.floor(r() * days.length), l = 2 + Math.floor(r() * 5);
      for (const d of days.slice(s0, s0 + l)) mine.add(d);
    }
    if (i === gapped) mine.delete(block[1 + Math.floor(r() * Math.max(1, block.length - 2))]);
    return { days: [...mine].sort() };
  });
  return { dateRange: { start, end, minNights, maxNights }, availability };
}

/**
 * A random demo voyage: sealed briefs for everyone, one member away (their standing instruction set when their
 * terms seal), a headset code. Same seed → same voyage (ids and tokens aside).
 */
export async function seedRandom(helm: TripService, seed: number = Math.floor(Math.random() * 2 ** 31), crewSize?: number): Promise<DemoSeed> {
  // curated ports only (a generated one, docs/11, is picked by name)
  const ports = helm.ds.cities.map((c) => c._id).filter((id) => !isGeneratedPort(id));
  const plan = randomVoyagePlan(seed, ports, helm.ds.dateWindows.map((w) => w.id), crewSize);
  const [org, ...rest] = plan.crew;
  const { trip, member: o, token: oToken } = helm.createTrip({
    name: plan.tripName, organizerName: org.name, band: org.band, origin: org.origin, cityIds: plan.ports, dateRange: plan.dateRange,
  });
  const seats: { c: (typeof plan.crew)[number]; memberId: string; token: string }[] = [{ c: org, memberId: o._id, token: oToken }];
  for (const c of rest) {
    if (c.role === "absent") {
      const a = helm.addAbsent(trip._id, { memberId: o._id }, { name: c.name, band: c.band, origin: c.origin });
      seats.push({ c, memberId: a.memberId, token: helm.claimAbsent(trip._id, a.memberId, a.inviteKey).memberToken });
    } else {
      const j = helm.join(trip._id, { name: c.name, band: c.band, origin: c.origin, crewKey: newToken() });
      seats.push({ c, memberId: j.member._id, token: j.token });
    }
  }
  for (const s of seats) await helm.submitBrief(trip._id, s.memberId, { ...s.c.brief, dateWindowIds: [], availability: s.c.availability });
  const { code } = helm.headsetCode(trip._id, { memberId: o._id });
  const crew = seats.map((s): DemoSeat => ({
    name: s.c.name, role: s.c.role, band: s.c.band, memberId: s.memberId, memberToken: s.token, handoff: helm.mintHandoff(trip._id, s.memberId, s.token),
  }));
  return {
    kind: "random", seed, tripId: trip._id, joinCode: trip.joinCode, tripName: trip.name,
    organizer: crew[0], crew, ports: portNames(helm, trip.candidateCityIds), headsetCode: code,
  };
}

const portNames = (helm: TripService, ids: string[]) => ids.map((id) => helm.ds.cities.find((c) => c._id === id)?.name ?? id);
