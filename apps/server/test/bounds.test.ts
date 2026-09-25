/**
 * R2-WP-11 — resource bounds & eviction: settled bookings, the SIM's records and passkeys leave memory with their
 * voyage (O2-035 / L4-010 / S2-011) and come back with it, while a booking that still owes money never does; memory
 * stays bounded after many voyages; lone and stale voyages are swept (S2-006, L5-008); only the current round's turns
 * are kept (L5-008); a restart gives a table run back (L4-009); the reconnect sync writes only what is dirty (O2-035);
 * other maps are bounded (O2-042).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));
vi.mock("../src/store/db.js", async () => (await import("./support/fakeDb.js")).fakeDb);

import { fake } from "./support/fakeDb.js";
import { TripService } from "../src/trips/service.js";
import { type TripRec } from "../src/trips/records.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";
import type { BookingRec } from "../src/payments/orchestrator.js";
import { config } from "../src/config.js";
import { HANDOFF_TTL_MS, REASON_TABLE_FAILED, REASON_TABLE_RESTART } from "../src/trips/records.js";
import { holdsPasskeyClaim, mintPasskeyClaim, passkeyMapSizes, resetPasskeysForTests } from "../src/passkeys/passkeys.js";
import { prefix48 } from "../src/api/routes.js";

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
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
/** Every seal set; waits until the voyage is BOOKED or VOIDED (Maya's card declines with `decline`). */
async function sealed(h: TripService, decline = false) {
  const seed = await atDryRun(h);
  if (decline) simOf(h).declineMember = seed.maya.memberId;
  await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
  const t = h.trip(seed.tripId);
  await h.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
  await h.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
  await until(() => t.status === "BOOKED" || t.status === "VOIDED");
  await h.payments.whenSettled(t.bookingId!);
  return { seed, t, b: h.payments.bookings.get(t.bookingId!)! };
}
/** The voyage (in memory and in the store) was last touched `ms` ago. */
function age(h: TripService, tripId: string, ms: number) {
  const at = new Date(Date.now() - ms).toISOString();
  h.trips.get(tripId)!.updatedAt = at;
  const doc = fake.get<TripRec>("trips", tripId);
  if (doc) doc.updatedAt = at;
}
const pastDone = () => config.limits.voyageDoneMs + 60_000;
const simHolds = (sim: SimProvider, b: BookingRec) => {
  const s = sim as unknown as { results: { keys(): IterableIterator<string> }; auths: { has(k: string): boolean }; instructions: { has(k: string): boolean } };
  return [...s.results.keys()].some((k) => k.startsWith(`${b._id}:`))
    || b.seals.some((x) => (x.authRef && s.auths.has(x.authRef)) || (x.instructionRef && s.instructions.has(x.instructionRef)));
};

beforeEach(() => { fake.reset(); resetPasskeysForTests(); });

describe("O2-035 / L4-010 / S2-011: settled bookings leave memory with their voyage", () => {
  it("a BOOKED voyage swept past VOYAGE_DONE_DAYS leaves no booking, SIM record or passkey behind; hydrate brings them back", async () => {
    const h = helm();
    const { seed, b } = await sealed(h);
    const nonce = mintPasskeyClaim(seed.maya.memberId);
    expect(h.payments.bookings.size).toBe(1);
    expect(simHolds(simOf(h), b)).toBe(true);
    age(h, seed.tripId, pastDone());

    expect(h.sweep()).toEqual([seed.tripId]);
    expect(h.payments.bookings.size).toBe(0);
    expect(simHolds(simOf(h), b)).toBe(false);
    expect(passkeyMapSizes().claims).toBe(0);
    expect(h.members.size).toBe(0);

    // still in the store: the voyage, its booking and Maya's passkey claim come back with it
    fake.state.connected = true;
    const t = await h.hydrate({ tripId: seed.tripId });
    expect(t?.status).toBe("BOOKED");
    expect(h.payments.bookings.get(b._id)?.status).toBe("CAPTURED");
    expect(h.payments.bookings.get(b._id)?.reference).toBe(b.reference);
    expect(holdsPasskeyClaim(seed.maya.memberId, nonce)).toBe(true);
  });

  it("eviction never drops a booking that still owes a refund (needsAttention) or a release; once settled it goes", async () => {
    const h = helm();
    const sim = simOf(h);
    // a refund owed: the first capture fails and refunds are refused
    const capture = sim.capture.bind(sim), refund = sim.refund.bind(sim);
    let first = true;
    const refuse = { on: true };
    sim.capture = (p) => { if (first) { first = false; return Promise.resolve({ ok: false }); } return capture(p); };
    sim.refund = (p) => (refuse.on ? Promise.resolve({ ok: false }) : refund(p));
    const { t: trip1, b: b1 } = await sealed(h);
    expect(trip1.status).toBe("VOIDED");
    expect(b1.needsAttention).toBe(true);

    // a hold never confirmed released: Maya declines, Rae's release answers a plain {ok:false}
    sim.void = () => Promise.resolve({ ok: false });
    const held = await sealed(h, true);
    expect(h.payments.holdsOutstanding(held.b)).toBe(true);

    age(h, trip1._id, pastDone());
    age(h, held.seed.tripId, pastDone());
    expect(h.sweep().sort()).toEqual([trip1._id, held.seed.tripId].sort());
    // the voyages are gone from memory, the money that is still owed is not
    expect(h.payments.bookings.get(b1._id)).toBe(b1);
    expect(h.payments.bookings.get(held.b._id)).toBe(held.b);
    expect(h.payments.unsettledFor(trip1._id)).toEqual([b1]);

    // once the refund went through and the hold is released, the next sweep lets them go
    refuse.on = false;
    sim.void = SimProvider.prototype.void.bind(sim);
    await h.payments.redrive(b1);
    await h.payments.redrive(held.b);
    expect(h.payments.unsettled(b1) || h.payments.unsettled(held.b)).toBe(false);
    h.sweep();
    expect(h.payments.bookings.size).toBe(0);
  });

  it("a booking still settling is kept even if its voyage is evicted", () => {
    const h = helm();
    const b = h.payments.create({ tripId: "gone", planId: LIS, cityId: "LIS", attempt: 1, shares: [{ memberId: "m1", amountCents: 100, capCents: 200 }] });
    expect(h.payments.forget("gone")).toEqual([b._id]);
    h.sweep();
    expect(h.payments.bookings.has(b._id)).toBe(true);
  });
});

describe("memory stays bounded after N voyages", () => {
  it("N booked voyages swept → no voyage, member, brief, booking, standing instruction, SIM record or passkey claim left", async () => {
    const h = helm();
    const N = 6;
    for (let i = 0; i < N; i++) {
      const { seed } = await sealed(h);
      mintPasskeyClaim(seed.maya.memberId);
    }
    expect(h.trips.size).toBe(N);
    expect(h.payments.bookings.size).toBe(N);
    for (const id of [...h.trips.keys()]) age(h, id, pastDone());
    expect(h.sweep()).toHaveLength(N);
    expect({ trips: h.trips.size, members: h.members.size, briefs: h.briefs.size, bookings: h.payments.bookings.size, standing: h.payments.standing.size })
      .toEqual({ trips: 0, members: 0, briefs: 0, bookings: 0, standing: 0 });
    expect(simOf(h).sizes()).toEqual({ instructions: 0, auths: 0, results: 0 });
    expect(passkeyMapSizes()).toEqual({ credentials: 0, challenges: 0, assertions: 0, claims: 0 });
  });
});

describe("S2-006 / L5-008: lone and stale voyages are swept", () => {
  it("a lone BRIEFING voyage (≤ 1 seat, nothing sealed) goes after VOYAGE_LONE_HOURS; a crewed one and a fresh one stay", async () => {
    const h = helm();
    const lone = h.createTrip({ name: "lone", organizerName: "O", band: 2, origin: "ATL" as never });
    const young = h.createTrip({ name: "young", organizerName: "Y", band: 2, origin: "ATL" as never });
    const crewed = await seedExpo(h);
    age(h, lone.trip._id, config.limits.voyageLoneMs + 60_000);
    age(h, crewed.tripId, config.limits.voyageLoneMs + 60_000);
    expect(h.sweep()).toEqual([lone.trip._id]);
    expect(h.trips.has(young.trip._id)).toBe(true);
    expect(h.trips.has(crewed.tripId)).toBe(true);
  });

  it("a DRY_RUN voyage idle past VOYAGE_STALE_DAYS is swept, isn't loaded at boot, and still opens by code", async () => {
    const a = helm();
    const stale = await atDryRun(a);
    const fresh = await atDryRun(a);
    const code = a.trip(stale.tripId).joinCode;
    age(a, stale.tripId, config.limits.voyageStaleMs + 60_000);
    expect(a.sweep()).toEqual([stale.tripId]);

    const b = helm();
    await b.restore();
    expect(b.trips.has(stale.tripId)).toBe(false);
    expect(b.trips.has(fresh.tripId)).toBe(true);
    fake.state.connected = true;
    expect((await b.hydrate({ joinCode: code }))?.status).toBe("DRY_RUN");
    expect(b.tripByCode(code)._id).toBe(stale.tripId);
  });
});

describe("L5-008: only the current round's turns remain", () => {
  it("after two interrupted tables, the stored turns are the current meeting's only", async () => {
    const h = helm();
    const seed = await seedExpo(h);
    const t = h.trip(seed.tripId);
    const oldTurn = (round: number) => ({ _id: `old-${round}`, turnId: `old-${round}`, tripId: seed.tripId, round, seq: 1, speaker: "captain", text: "x", watch: 0, createdAt: new Date().toISOString() });
    const persist = (await import("./support/fakeDb.js")).fakeDb.persist;
    for (const reason of [REASON_TABLE_FAILED, REASON_TABLE_RESTART]) {
      await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
      persist("turns", oldTurn(t.negotiation.round!)); // a turn the interrupted meeting wrote
      h.table.resetTable(t, reason);
      h.save(t);
      expect(fake.docs<{ tripId: string; round: number }>("turns").filter((d) => d.tripId === seed.tripId && d.round < t.negotiation.round!)).toEqual([]);
    }
    await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    await until(() => t.status === "DRY_RUN");
    const stored = fake.docs<{ tripId: string; round: number }>("turns").filter((d) => d.tripId === seed.tripId);
    expect(stored.length).toBe(t.negotiation.turns.length);
    expect(stored.every((d) => d.round === t.negotiation.round)).toBe(true);
  });
});

describe("L4-009: an interrupted table gives its run back only when the helm restarted", () => {
  it("a restart mid-table leaves tableRuns unchanged; an engine failure still counts", async () => {
    const a = helm();
    const seed = await seedExpo(a);
    expect(a.trip(seed.tripId).tableRuns ?? 0).toBe(0);
    await a.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    const midTable = fake.snapshot(); // the trip doc was saved AT_TABLE with tableRuns 1
    expect(fake.get<TripRec>("trips", seed.tripId)!.status).toBe("AT_TABLE");

    fake.load(midTable);
    const b = helm();
    await b.restore();
    const t = b.trip(seed.tripId);
    expect(t.status).toBe("BRIEFING");
    expect(t.tableRuns ?? 0).toBe(0);

    await b.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    b.table.resetTable(t, REASON_TABLE_FAILED);
    expect(t.tableRuns).toBe(1);
  });
});

describe("O2-035: the reconnect sync writes only what was held in memory before the merge", () => {
  it("a stored BOOKED voyage merged in is not written back; the voyage made while MongoDB was away is", async () => {
    const a = helm();
    const { seed, b } = await sealed(a);
    const stored = fake.snapshot();

    fake.reset();
    const h = helm();
    await h.restore(); // boot with MongoDB unreachable: nothing loaded, the hook registered
    const created = h.createTrip({ name: "offline", organizerName: "Z", band: 2, origin: "ATL" as never });
    const hook = fake.state.hook!;
    fake.load(stored);
    fake.state.connected = true;
    fake.state.writes = [];
    await hook();
    expect(h.trips.has(seed.tripId)).toBe(true);
    expect(h.payments.bookings.has(b._id)).toBe(true);
    const writes = fake.state.writes;
    expect(writes.some((w) => w.col === "bookings" && w.id === b._id)).toBe(false);
    expect(writes.some((w) => w.col === "trips" && w.id === seed.tripId)).toBe(false);
    expect(writes.some((w) => w.col === "members" && w.id === seed.maya.memberId)).toBe(false);
    expect(writes.some((w) => w.col === "trips" && w.id === created.trip._id)).toBe(true);
    expect(writes.some((w) => w.col === "members" && w.id === created.member._id)).toBe(true);
  });
});

describe("O2-042: other maps and timers", () => {
  it("expired demo handoffs are pruned on redeem too", () => {
    const h = helm();
    const { trip, member, token } = h.createTrip({ name: "h", organizerName: "O", band: 2, origin: "ATL" as never });
    vi.useFakeTimers({ now: Date.now() });
    try {
      h.mintHandoff(trip._id, member._id, token);
      vi.setSystemTime(Date.now() + HANDOFF_TTL_MS + 1);
      h.mintHandoff(trip._id, member._id, token);
      expect(h.identity.handoffCount).toBe(1); // minting prunes the first
      vi.setSystemTime(Date.now() + HANDOFF_TTL_MS + 1);
      expect(() => h.redeemHandoff(trip._id, member._id, "nope")).toThrow();
      expect(h.identity.handoffCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the SIM forgets a booking's records and its maps are bounded", () => {
    const sim = new SimProvider();
    const s = sim as unknown as { results: { max: number }; auths: { max: number }; instructions: { max: number } };
    expect([s.results.max, s.auths.max, s.instructions.max].every((m) => Number.isFinite(m) && m > 0)).toBe(true);
  });

  it("prefix48: the /48 of a /64 key; IPv4 has none", () => {
    expect(prefix48("2001:db8:1:2::/64")).toBe("2001:db8:1::/48");
    expect(prefix48("2001:db8:0:0::/64")).toBe("2001:db8:0::/48");
    expect(prefix48("203.0.113.9")).toBeUndefined();
  });
});
