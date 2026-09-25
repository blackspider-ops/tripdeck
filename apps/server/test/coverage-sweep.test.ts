/**
 * O2-064 (R2-WP-17): the sweep's other branches (settled voyages past VOYAGE_DONE_DAYS, the 2 h hot-cache drop,
 * voyages the sweep must never touch, hail stamps and pending headset codes, orphaned settled bookings — O2-035), the
 * booked memory note (budget band, liked, conceded), and the restore-time chart check on current-shape documents.
 * No network: the store is the in-memory fake and memory writes are captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));
vi.mock("../src/store/db.js", async () => (await import("./support/fakeDb.js")).fakeDb);

const mem = vi.hoisted(() => ({ lines: [] as { key: string; text: string }[] }));
vi.mock("../src/memory/memory.js", () => ({
  crewKeyHash: (k: string) => `h:${k}`,
  personKey: (keyHash: string, name: string) => `crew:${keyHash}|${name.trim().toLowerCase()}`,
  validCrewKey: (k: unknown) => typeof k === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(k),
  recall: async () => [],
  remember: async () => undefined,
  rememberAll: async (notes: { key: string; text: string }[]) => { mem.lines.push(...notes); },
  useMongoMemory: async () => undefined,
}));

import { fake } from "./support/fakeDb.js";
import { TripService } from "../src/trips/service.js";
import { HAIL_STAMP_KEEP_MS, HOT_CACHE_MS, PAIR_CODE_TTL_MS, REASON_CHARTS_CHANGED, type TripRec } from "../src/trips/records.js";
import type { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";
import { config } from "../src/config.js";
import { budgetBand } from "../src/memory/bands.js";
import { cityName } from "../src/data/loader.js";
import { resetPasskeysForTests } from "../src/passkeys/passkeys.js";

const settle = (ms = 2) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean) => { for (let i = 0; i < 400 && !pred(); i++) await settle(); };
const LIS = "LIS-W1-casa-alfama";
const simOf = (h: TripService) => (h.payments as unknown as { provider: SimProvider }).provider;
function helm() {
  const h = new TripService();
  const sim = simOf(h);
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  return h;
}
async function atDryRun(h: TripService) {
  const seed = await seedExpo(h);
  await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
  await until(() => h.trip(seed.tripId).status === "DRY_RUN");
  return seed;
}
async function sealed(h: TripService, decline = false) {
  const seed = await atDryRun(h);
  if (decline) simOf(h).declineMember = seed.maya.memberId;
  await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
  const t = h.trip(seed.tripId);
  await h.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
  await h.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
  await until(() => t.status === "BOOKED" || t.status === "VOIDED");
  await h.payments.whenSettled(t.bookingId!);
  return { seed, t };
}
const age = (h: TripService, tripId: string, ms: number) => { h.trips.get(tripId)!.updatedAt = new Date(Date.now() - ms).toISOString(); };
const hot = (h: TripService, id: string) => ({ chartBook: h.chartBooks.has(id), privacy: h.privacy.has(id), hails: h.pendingHails.has(id), closed: h.hailsClosed.has(id) });

beforeEach(() => { fake.reset(); resetPasskeysForTests(); mem.lines.length = 0; });

describe("O2-064: the sweep's settled, hot-cache and never-swept branches", () => {
  it("a VOIDED voyage past VOYAGE_DONE_DAYS is evicted with its (released) booking; a younger one stays", async () => {
    const h = helm();
    const old = await sealed(h, true);
    const young = await sealed(h, true);
    expect([old.t.status, young.t.status]).toEqual(["VOIDED", "VOIDED"]);
    age(h, old.seed.tripId, config.limits.voyageDoneMs + 60_000);
    age(h, young.seed.tripId, config.limits.voyageDoneMs - 60_000);
    expect(h.sweep()).toEqual([old.seed.tripId]);
    expect(h.payments.bookings.has(old.t.bookingId!)).toBe(false);
    expect(h.members.has(old.seed.maya.memberId)).toBe(false);
    expect(h.trips.has(young.seed.tripId)).toBe(true);
    expect(h.payments.bookings.has(young.t.bookingId!)).toBe(true);
  });

  it("a settled voyage idle past 2 h keeps its seat in memory but drops its recomputable caches; the charts rebuild", async () => {
    const h = helm();
    const { seed, t } = await sealed(h);
    const fresh = await sealed(h);
    for (const id of [seed.tripId, fresh.seed.tripId]) {
      h.table.chartBook(h.trip(id)); // warm (a join or replay would)
      h.pendingHails.set(id, []);
      h.hailsClosed.add(id);
    }
    expect(hot(h, seed.tripId)).toEqual({ chartBook: true, privacy: true, hails: true, closed: true });
    age(h, seed.tripId, HOT_CACHE_MS + 60_000);
    expect(h.sweep()).toEqual([]);
    expect(h.trips.has(seed.tripId)).toBe(true);
    expect(hot(h, seed.tripId)).toEqual({ chartBook: false, privacy: false, hails: false, closed: false });
    expect(hot(h, fresh.seed.tripId)).toEqual({ chartBook: true, privacy: true, hails: true, closed: true });
    // recomputable: the chosen plan and the Two Charts come back on the next read
    expect(h.table.shortlist(t).map((p) => p._id)).toContain(LIS);
    expect(h.table.planOf(t, t.chosenPlanId)?._id).toBe(LIS);
  });

  it("SEALING and AT_TABLE voyages are never swept, however old; BRIEFING past VOYAGE_IDLE_HOURS is", async () => {
    const h = helm();
    const sealing = await atDryRun(h);
    await h.pick(sealing.tripId, { memberId: sealing.organizer.memberId }, LIS);
    expect(h.trip(sealing.tripId).status).toBe("SEALING");
    const table = await seedExpo(h);
    h.trip(table.tripId).status = "AT_TABLE"; // held at the table (the engine would end it)
    const briefing = await seedExpo(h);
    const year = 365 * 86_400_000;
    for (const id of [sealing.tripId, table.tripId]) age(h, id, year);
    age(h, briefing.tripId, config.limits.voyageIdleMs + 60_000);
    expect(h.sweep()).toEqual([briefing.tripId]);
    expect(h.trips.has(sealing.tripId) && h.trips.has(table.tripId)).toBe(true);
    await h.callOff(sealing.tripId, { memberId: sealing.organizer.memberId }, h.trip(sealing.tripId).bookingId!);
  });

  it("hail stamps older than HAIL_STAMP_KEEP_MS are pruned; fresh ones stay", () => {
    const h = helm();
    const now = Date.now();
    h.lastHailAt.set("old", now - HAIL_STAMP_KEEP_MS - 1);
    h.lastHailAt.set("edge", now - HAIL_STAMP_KEEP_MS);
    h.lastHailAt.set("fresh", now - 1_000);
    h.sweep(now);
    expect([...h.lastHailAt.keys()].sort()).toEqual(["edge", "fresh"]);
  });

  it("a pending headset code leaves the pair index once it expires, or once the voyage's headset no longer carries it", async () => {
    const h = helm();
    const a = await seedExpo(h);
    const b = await seedExpo(h);
    const ta = h.trip(a.tripId), tb = h.trip(b.tripId);
    const codeA = ta.headset!.codeHash, codeB = tb.headset!.codeHash;
    const now = Date.now();
    h.sweep(now);
    expect(h.findByPairHash(codeA)).toBe(ta);
    expect(h.findByPairHash(codeB)).toBe(tb);
    // B's record changed under the index (e.g. a restore replaced the object) — the stale entry must not resolve B
    tb.headset = { ...tb.headset!, codeHash: "not-" + codeB };
    h.sweep(now);
    expect(h.findByPairHash(codeB)).toBeUndefined();
    // A's code expires (10 min); the voyage itself is still fresh and stays
    expect(h.sweep(ta.headset!.expiresAt)).toEqual([]);
    expect(h.findByPairHash(codeA)).toBeUndefined();
    expect(h.trips.has(a.tripId)).toBe(true);
    expect(PAIR_CODE_TTL_MS).toBe(10 * 60_000);
  });

  it("O2-035: a settled booking whose voyage is no longer in memory leaves on the next sweep", async () => {
    const h = helm();
    const { t } = await sealed(h);
    const bookingId = t.bookingId!;
    h.removeTrip(t); // an orphan: the voyage was never loaded (boot) or left while the booking was unsettled
    expect(h.payments.bookings.has(bookingId)).toBe(true);
    h.sweep();
    expect(h.payments.bookings.has(bookingId)).toBe(false);
  });
});

describe("O2-064: the booked memory note", () => {
  it("each member gets one line: voyage, booked, their budget band (never the cap), what they liked, and a concession", async () => {
    const h = helm();
    const { seed, t } = await sealed(h);
    expect(t.status).toBe("BOOKED");
    await until(() => mem.lines.length >= 3);
    await settle(5);
    expect(mem.lines).toHaveLength(3);
    const plan = h.table.planOf(t, t.chosenPlanId)!;
    const head = h.table.voyageLine(t, plan);
    expect(head).toMatch(/^voyage: Lisbon, /);
    for (const [who, name] of [[seed.organizer.memberId, "rae"], [seed.maya.memberId, "maya"], [seed.dev.memberId, "dev"]] as const) {
      const line = mem.lines.find((l) => l.key.endsWith(`|${name}`));
      expect(line, name).toBeDefined();
      const brief = h.briefs.get(who)!;
      const liked = plan.members.find((m) => m.memberId === who)!.lines.filter((l) => l.kind === "activity").map((l) => l.label).join(", ");
      const first = t.negotiation.turns.find((x) => x.act === "PROPOSE" && x.speaker.kind === "advocate" && x.speaker.memberId === who);
      const conceded = first?.cityId && first.cityId !== plan.cityId ? ` · conceded the city choice (wanted ${cityName(h.ds, first.cityId)})` : "";
      expect(line!.text).toBe(`${head} · booked · ${budgetBand(brief.capCents)} · liked: ${liked}${conceded}`);
      // the cap itself never reaches memory (doc 05 §9): no dollar amount, no cents
      expect(line!.text).not.toContain(String(brief.capCents));
      expect(line!.text).not.toContain(String(brief.capCents / 100));
    }
    // the Expo caps land in two different bands
    expect(mem.lines.find((l) => l.key.endsWith("|dev"))!.text).toContain("comfortable budget");
    expect(mem.lines.find((l) => l.key.endsWith("|maya"))!.text).toContain("mid budget");
  });

  it("a member with no crew key (no memory thread) gets no note; the others still do", async () => {
    const h = helm();
    const seed = await atDryRun(h);
    h.members.get(seed.dev.memberId)!.crewKeyHash = undefined;
    await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    const t = h.trip(seed.tripId);
    await h.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
    await h.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    await until(() => t.status === "BOOKED");
    await until(() => mem.lines.length >= 2);
    await settle(5);
    expect(mem.lines.map((l) => l.key.split("|")[1]).sort()).toEqual(["maya", "rae"]);
  });
});

describe("O2-064: the restore-time chart check on current-shape documents", () => {
  const restart = async () => { const b = helm(); await b.restore(); return b; };
  beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("a DRY_RUN voyage stored as this build writes it restores unchanged: same charts, no warning, no trip rewrite", async () => {
    const a = helm();
    const s = await atDryRun(a);
    const ids = a.trip(s.tripId).shortlistIds;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fake.state.writes = [];
    const b = await restart();
    expect(warn.mock.calls.some((c) => /no longer resolve|dataset changed/.test(String(c[0])))).toBe(false);
    expect(b.trip(s.tripId).status).toBe("DRY_RUN");
    expect(b.table.shortlist(b.trip(s.tripId)).map((p) => p._id)).toEqual(ids);
    expect(fake.state.writes.some((w) => w.col === "trips" && w.id === s.tripId)).toBe(false);
  });

  it("a DRY_RUN voyage whose charts can't be resolved goes back to BRIEFING with REASON_CHARTS_CHANGED, and is saved", async () => {
    const a = helm();
    const s = await atDryRun(a);
    const doc = fake.get<TripRec>("trips", s.tripId)!;
    expect(doc.datasetHash).toBeTruthy(); // current shape: hash stamped, plans in their own doc
    expect(doc.shortlistPlans).toBeUndefined();
    fake.delete("shortlists", s.tripId);
    doc.shortlistIds = ["GONE-A", "GONE-B"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = await restart();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no longer resolve"))).toBe(true);
    const t = b.trip(s.tripId);
    expect(t.status).toBe("BRIEFING");
    expect(t.tableReset?.reason).toBe(REASON_CHARTS_CHANGED);
    expect(fake.get<TripRec>("trips", s.tripId)!.status).toBe("BRIEFING");
  });

  it("a BOOKED voyage charted under another dataset only logs the drift: it is never sent back to BRIEFING", async () => {
    const a = helm();
    const { seed } = await sealed(a);
    fake.get<TripRec>("trips", seed.tripId)!.datasetHash = "0".repeat(16);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = await restart();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("dataset changed"))).toBe(true);
    expect(b.trip(seed.tripId).status).toBe("BOOKED");
  });
});
