/**
 * MAX_CREW 12 (organizer + up to 11, absent seats included), end to end at the helm: joins up to 12 then CREW_FULL,
 * several rooms of one stay priced and split exactly, a big table that stays short (speaking budget), seals for 8 and
 * 12 whose public sequences can't tell whose card declined, and random 8-person voyages that reach BOOKED.
 */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

vi.mock("../src/memory/memory.js", () => ({
  crewKeyHash: (k: string) => `h:${k}`,
  personKey: (keyHash: string, name: string) => `crew:${keyHash}|${name.trim().toLowerCase()}`,
  validCrewKey: (k: unknown) => typeof k === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(k),
  recall: async () => [],
  remember: async () => undefined,
  rememberAll: async () => undefined,
  budgetBand: () => "mid budget",
}));

import { BANDS, BAND_IDS, MAX_CREW, ORIGINS, type Band, type BriefInput, type Dealbreaker, type Tag } from "@all-ayes/shared";
import { indexOf, loadDataset } from "../src/data/loader.js";
import { buildChartBook, buildPlan, lodgingShares, lodgingTotalCents, roomsFor, toPublic, type PricingMember } from "../src/fit/pricing.js";
import { TABLE_VOICES_PER_WATCH } from "../src/negotiation/engine.js";
import { TripService } from "../src/trips/service.js";
import type { HelmError } from "../src/util/errors.js";
import type { SimProvider } from "../src/payments/sim.js";
import { RANDOM_CREW_MAX, randomVoyagePlan, seedRandom } from "../src/demo/seed.js";
import { config } from "../src/config.js";
import { EXPO_CREW } from "./fixtures.js";

const ds = loadDataset();
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, tries = 2000) => { for (let i = 0; i < tries && !pred(); i++) await settle(2); };
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };
const simOf = (h: TripService) => (h.payments as unknown as { provider: SimProvider }).provider;

const NAMES = ["Rae", "Maya", "Dev", "Ines", "Kofi", "Lena", "Milo", "Nia", "Omar", "Priya", "Quinn", "Rosa"];
const TAG_SETS: Tag[][] = [["food"], ["beach"], ["museums"], ["food", "history"], ["nightlife"], ["chill"], ["music"], ["history"], ["food", "chill"], ["museums", "music"], ["nature"], []];
/** Varied terms (caps, windows, wishes, dealbreakers): a table where mates want different charts. */
const DBS: Dealbreaker[][] = [[], ["red_eye"], ["hostel"], ["early_start"], ["long_walks"], ["layovers_2plus"], ["red_eye", "hostel"]];
const diverse = (i: number): BriefInput => ({
  capCents: [110_000, 90_000, 140_000, 160_000, 100_000, 200_000, 130_000, 95_000, 180_000, 120_000, 150_000, 105_000][i % 12],
  dateWindowIds: i % 3 === 2 ? ["W2"] : i % 3 === 1 ? ["W1", "W2"] : ["W1"],
  mustHaves: TAG_SETS[(i * 5) % TAG_SETS.length], dealbreakers: DBS[i % DBS.length],
});
/** A generous brief (everyone can do W1, big cap), so a crew of any size has charts that fit everyone. */
const brief = (i: number, dealbreakers: Dealbreaker[] = []): BriefInput =>
  ({ capCents: 250_000, dateWindowIds: ["W1"], mustHaves: TAG_SETS[i % TAG_SETS.length], dealbreakers });

function helm() {
  const h = new TripService();
  const sim = simOf(h);
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const trip: { ev: string; p: any }[] = [];
  const member: { id: string; ev: string; p: any }[] = [];
  h.attachBus({ trip: (_t, ev, p) => trip.push({ ev, p }), member: (id, ev, p) => member.push({ id, ev, p }) });
  return { h, sim, trip, member };
}

/** A voyage of `n` on LIS/MEX/YUL: the organizer, members, and every 4th seat absent (with a standing seal). */
async function bigVoyage(h: TripService, n: number, sealed = n, briefOf: (i: number) => BriefInput = brief) {
  const { trip, member: org } = h.createTrip({ name: `Crew of ${n}`, organizerName: NAMES[0], band: 1, origin: "ATL", cityIds: ["LIS", "MEX", "YUL"], windowIds: ["W1", "W2"] });
  const seats = [{ memberId: org._id, role: "organizer" as const }];
  for (let i = 1; i < n; i++) {
    const origin = ORIGINS[i % 3];
    if (i % 4 === 3) {
      const a = h.addAbsent(trip._id, { memberId: org._id }, { name: NAMES[i], band: (i + 1) as Band, origin });
      h.claimAbsent(trip._id, a.memberId, a.inviteKey);
      seats.push({ memberId: a.memberId, role: "absent" as never });
    } else {
      const j = h.join(trip._id, { name: NAMES[i], band: (i + 1) as Band, origin });
      seats.push({ memberId: j.member._id, role: "member" as never });
    }
  }
  for (const [i, s] of seats.entries()) if (i < sealed) await h.submitBrief(trip._id, s.memberId, briefOf(i));
  return { tripId: trip._id, organizerId: org._id, seats: seats as { memberId: string; role: "organizer" | "member" | "absent" }[] };
}

async function toDryRun(h: TripService, tripId: string, organizerId: string) {
  await h.startTable(tripId, { memberId: organizerId });
  await until(() => h.trip(tripId).status === "DRY_RUN");
  return h.trip(tripId);
}

// ---------- the crew ----------
describe("MAX_CREW 12: bands and seats", () => {
  it("twelve distinct bands; bands 1–4 are the original four", () => {
    expect(MAX_CREW).toBe(12);
    expect(BAND_IDS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(BAND_IDS.map((b) => BANDS[b].hex)).size).toBe(12);
    expect(new Set(BAND_IDS.map((b) => BANDS[b].name)).size).toBe(12);
    expect([1, 2, 3, 4].map((b) => BANDS[b as Band].hex)).toEqual(["#2F5D8A", "#A0522D", "#556B2F", "#7A4E7A"]);
  });

  it("joins up to 12 (absent seats count), then CREW_FULL on the 13th — by code and as an absent friend", async () => {
    const { h } = helm();
    const v = await bigVoyage(h, 12, 11);
    expect(h.activeMembers(h.trip(v.tripId))).toHaveLength(12);
    expect(await code(() => h.join(v.tripId, { name: "Thirteen", band: 1, origin: "ATL" }))).toBe("CREW_FULL");
    expect(await code(() => h.addAbsent(v.tripId, { memberId: v.organizerId }, { name: "Thirteen", band: 2, origin: "ATL" }))).toBe("CREW_FULL");
    // sail-without (the 12th never sealed) frees a seat, and its band
    await h.sailWithout(v.tripId, { memberId: v.organizerId }, [v.seats[11].memberId]);
    expect(await code(() => h.join(v.tripId, { name: "Late", band: 12, origin: "ATL" }))).toBe("OK");
  });

  it("every seat has its own mate voice (bands 5–12 included)", () => {
    const ids = BAND_IDS.map((b) => config.eleven.voices[String(b)]);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(12);
  });
});

// ---------- lodging ----------
describe("lodging for bigger crews: rooms = ceil(crew / sleeps) of one stay, split exactly", () => {
  const crewOf = (n: number): PricingMember[] => Array.from({ length: n }, (_, i) => ({
    memberId: `m${i}`, name: NAMES[i], role: i === 0 ? "organizer" : "member", origin: ORIGINS[i % 3], brief: brief(i),
  }));

  it("the split sums to rooms × nightly × nights for every crew size and stay; ≤ sleeps is one room", () => {
    const win = indexOf(ds).window.get("W1")!;
    for (const h of ds.hotels.filter((x) => ["LIS", "MEX", "YUL"].includes(x.cityId))) {
      for (let n = 1; n <= MAX_CREW; n++) {
        const rooms = roomsFor(h, n);
        expect(rooms).toBe(Math.ceil(n / h.sleeps));
        if (n <= h.sleeps) expect(rooms).toBe(1);
        const total = lodgingTotalCents(h, n, win.nights);
        expect(total).toBe(h.nightlyCents * win.nights * rooms);
        const shares = lodgingShares(total, crewOf(n).map((m) => m.memberId), "m0");
        expect([...shares.values()].reduce((s, x) => s + x, 0)).toBe(total);
        const base = Math.floor(total / n);
        for (const [id, x] of shares) expect(x).toBe(id === "m0" ? total - base * (n - 1) : base);
      }
    }
  });

  it("a plan's lodging lines add up to the stay's bill; its public name says ×rooms, never who sleeps where", () => {
    for (const n of [5, 8, 12]) {
      const crew = crewOf(n);
      const win = indexOf(ds).window.get("W1")!;
      for (const h of ds.hotels.filter((x) => x.cityId === "LIS")) {
        const p = buildPlan(ds, crew, "LIS", "W1", h);
        const lodging = p.members.flatMap((m) => m.lines).filter((l) => l.kind === "lodging");
        expect(lodging).toHaveLength(n);
        expect(lodging.reduce((s, l) => s + l.amountCents, 0)).toBe(h.nightlyCents * win.nights * roomsFor(h, n));
        expect(p.groupCents).toBe(p.members.reduce((s, m) => s + m.amountCents, 0));
        const pub = toPublic(ds, p);
        const rooms = roomsFor(h, n);
        expect(pub.hotelName).toBe(rooms > 1 ? `${h.name} ×${rooms}` : h.name);
        expect(pub.rooms).toBe(rooms > 1 ? rooms : undefined);
        expect(JSON.stringify(pub)).not.toMatch(/"m\d+"/);
        if (rooms > 1) expect(lodging[0].label).toContain(`${h.name} ×${rooms}, 1/${n} ×${win.nights}n`);
      }
    }
  });

  it("the Expo crew's numbers are exactly as before (one room each)", () => {
    const book = buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"]);
    const lis = book.find((p) => p._id === "LIS-W1-casa-alfama")!;
    expect(lis.members.map((m) => m.amountCents)).toEqual([103_800, 86_800, 96_300]);
    expect(lis.groupCents).toBe(286_900);
    expect(book.every((p) => toPublic(ds, p).rooms === undefined)).toBe(true);
    const mex = book.find((p) => p.cityId === "MEX" && p.dateWindowId === "W1" && p.fitsEveryone);
    expect(mex?.groupCents).toBe(197_500);
  });
});

// ---------- the table ----------
/** What a line costs at Expo pacing without a voice (engine PACE): its word estimate + breath, ≥ 2.5 s. */
const lineMs = (text: string) => Math.max(2_500, Math.min(9_000, Math.max(2_500, text.split(/\s+/).length * 380)) + 400);

describe("a big table stays short (speaking budget)", () => {
  for (const [n, terms] of [[7, "alike"], [8, "alike"], [12, "alike"], [8, "diverse"], [12, "diverse"]] as const) {
    it(`a crew of ${n} (${terms} terms) decides with at most ${2 + 3 * TABLE_VOICES_PER_WATCH} lines, under two minutes at Expo pacing`, async () => {
      const { h, trip } = helm();
      const v = await bigVoyage(h, n, n, terms === "diverse" ? diverse : brief);
      const t = await toDryRun(h, v.tripId, v.organizerId);
      expect(t.status).toBe("DRY_RUN");
      expect(t.shortlistIds).toHaveLength(2);
      const turns = trip.filter((e) => e.ev === "turn:new").map((e) => e.p as { act: string; watch: number; text: string; speaker: { kind: string } });
      expect(turns[0].act).toBe("OPEN");
      expect(turns.at(-1)!.act).toBe("DECIDE");
      expect(turns.length).toBeLessThanOrEqual(2 + 3 * TABLE_VOICES_PER_WATCH);
      for (let w = 1; w <= 3; w++) expect(turns.filter((x) => x.watch === w && x.speaker.kind === "advocate").length).toBeLessThanOrEqual(TABLE_VOICES_PER_WATCH);
      // Watch 1 voices distinct proposals only
      const w1 = turns.filter((x) => x.watch === 1 && x.speaker.kind === "advocate");
      expect(w1.length).toBeGreaterThan(0);
      expect(w1.every((x) => x.act === "PROPOSE")).toBe(true);
      expect(turns.reduce((s, x) => s + lineMs(x.text), 0)).toBeLessThan(120_000);
      // the shortlist is still the fairest of what the table considered: the public A/B only (no private numbers)
      expect(JSON.stringify(trip.filter((e) => e.ev === "turn:new").map((e) => e.p))).not.toMatch(/\$\d/);
    }, 60_000);
  }

  it("a crew of 6 or fewer is unchanged: every mate speaks every watch it runs", async () => {
    const { h, trip } = helm();
    const v = await bigVoyage(h, 5);
    await toDryRun(h, v.tripId, v.organizerId);
    const turns = trip.filter((e) => e.ev === "turn:new").map((e) => e.p as { watch: number; speaker: { kind: string } });
    const watches = [...new Set(turns.filter((x) => x.speaker.kind === "advocate").map((x) => x.watch))];
    for (const w of watches) expect(turns.filter((x) => x.watch === w && x.speaker.kind === "advocate")).toHaveLength(5);
  }, 60_000);
});

// ---------- seals ----------
describe("seals for 8 and 12: the room can't tell whose seal was declined", () => {
  for (const n of [8, 12]) {
    it(`crew of ${n}: identical public sequences whoever declines (organizer, a member, an absent standing seal)`, async () => {
      const runs: Record<string, unknown> = {};
      const whoIdx = { organizer: 0, member: 1, absent: 3, last: n - 1 };
      for (const [who, idx] of Object.entries(whoIdx)) {
        const { h, sim, trip, member } = helm();
        const v = await bigVoyage(h, n);
        await toDryRun(h, v.tripId, v.organizerId);
        const t = h.trip(v.tripId);
        sim.latency = [10, 40];
        sim.declineMember = v.seats[idx].memberId;
        trip.length = 0;
        await h.pick(v.tripId, { memberId: v.organizerId }, t.shortlistIds![0]);
        const bookingId = t.bookingId!;
        await Promise.all(v.seats.filter((s) => s.role !== "absent").map((s) => h.setSeal(v.tripId, s.memberId, bookingId)));
        await until(() => t.status === "VOIDED");
        await settle(60);
        expect(t.status).toBe("VOIDED");
        const seq: Record<string, string[]> = Object.fromEntries(v.seats.map((_, i) => [String(i), []]));
        const at = (id: string) => String(v.seats.findIndex((s) => s.memberId === id));
        const push = (list: string[], s: string) => { if (list.at(-1) !== s) list.push(s); };
        const bookingSeq: string[] = [];
        for (const { ev, p } of trip) {
          if (ev === "seal:status") push(seq[at(p.memberId)], p.status);
          const b = ev === "booking:created" ? p : ev === "trip:state" ? p.booking : undefined;
          if (b) { push(bookingSeq, b.status); for (const s of b.seals) push(seq[at(s.memberId)], s.status); }
          expect(JSON.stringify(p)).not.toMatch(/DECLINED|over_limit|declineReason/);
        }
        runs[who] = { seq, bookingSeq };
        expect(member.filter((m) => m.ev === "seal:declinedPrivate").map((m) => m.id)).toEqual([v.seats[idx].memberId]);
        expect(sim.heldCount()).toBe(0);
      }
      const first = Object.values(runs)[0] as { seq: Record<string, string[]>; bookingSeq: string[] };
      expect(first.bookingSeq).toEqual(["PENDING", "AUTHORIZING", "VOIDED"]);
      for (const s of Object.values(first.seq)) expect(s).toEqual(["PENDING", "AUTHORIZED", "VOIDED"]);
      for (const got of Object.values(runs)) expect(got).toEqual(first);
    }, 120_000);
  }

  it("crew of 12 books: every seal (3 standing) captured, nobody fronts a cent", async () => {
    const { h, sim } = helm();
    const v = await bigVoyage(h, 12);
    const t = await toDryRun(h, v.tripId, v.organizerId);
    await h.pick(v.tripId, { memberId: v.organizerId }, t.shortlistIds![0]);
    for (const s of v.seats.filter((x) => x.role !== "absent")) await h.setSeal(v.tripId, s.memberId, t.bookingId!);
    await until(() => t.status === "BOOKED" || t.status === "VOIDED");
    expect(t.status).toBe("BOOKED");
    await h.payments.whenSettled(t.bookingId!);
    const b = h.payments.bookings.get(t.bookingId!)!;
    expect(b.seals).toHaveLength(12);
    expect(b.seals.filter((s) => s.standing)).toHaveLength(3);
    expect(sim.heldCount()).toBe(0);
  }, 60_000);
});

// ---------- the random demo ----------
describe("random demo voyages of up to 8", () => {
  it("draws crews of 3–8 with one away member", () => {
    const ids = ds.cities.map((c) => c._id), wins = ds.dateWindows.map((w) => w.id);
    const sizes = new Set<number>();
    for (let s = 0; s < 200; s++) {
      const p = randomVoyagePlan(s, ids, wins);
      sizes.add(p.crew.length);
      expect(p.crew.filter((c) => c.role === "absent")).toHaveLength(1);
      expect(new Set(p.crew.map((c) => c.band)).size).toBe(p.crew.length);
    }
    expect(Math.min(...sizes)).toBe(3);
    expect(Math.max(...sizes)).toBe(RANDOM_CREW_MAX);
    expect(RANDOM_CREW_MAX).toBe(8);
  });

  it("random seeds with 8 members reach BOOKED in-process (PACE_SCALE=0)", async () => {
    const ids = ds.cities.map((c) => c._id), wins = ds.dateWindows.map((w) => w.id);
    const seeds: number[] = [];
    for (let s = 0; seeds.length < 3 && s < 1000; s++) if (randomVoyagePlan(s, ids, wins).crew.length === 8) seeds.push(s);
    expect(seeds).toHaveLength(3);
    for (const seed of seeds) {
      const { h } = helm();
      const s = await seedRandom(h, seed);
      expect(s.crew).toHaveLength(8);
      const t = await toDryRun(h, s.tripId, s.organizer.memberId);
      expect(t.status).toBe("DRY_RUN");
      await h.pick(s.tripId, { memberId: s.organizer.memberId }, t.shortlistIds![0]);
      for (const c of s.crew.filter((x) => x.role !== "absent")) await h.setSeal(s.tripId, c.memberId, t.bookingId!);
      await until(() => t.status === "BOOKED" || t.status === "VOIDED");
      expect(t.status, `seed ${seed}`).toBe("BOOKED");
    }
  }, 120_000);
});
