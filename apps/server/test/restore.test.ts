/**
 * Restart recovery (doc 04 §4: "On boot it reloads the live voyages so a restart resumes them").
 * Mongo is faked (test/support/fakeDb.ts): what the helm persists is BSON round-tripped like the driver did, and a
 * new helm restores from exactly that, so a field that is only changed in memory is lost here too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));
vi.mock("../src/store/db.js", async () => (await import("./support/fakeDb.js")).fakeDb);

import { fake } from "./support/fakeDb.js";
import { TripService } from "../src/trips/service.js";
import { type TripRec } from "../src/trips/records.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";
import { REASONS, type BookingRec } from "../src/payments/orchestrator.js";
import { recall } from "../src/memory/memory.js";
import { HelmLease, memoryLeaseStore } from "../src/store/lease.js";

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean) => { for (let i = 0; i < 400 && !pred(); i++) await settle(); };
function helm() {
  const h = new TripService();
  const sim = (h.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  return h;
}
async function atDryRun(h: TripService) {
  const seed = await seedExpo(h);
  await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
  await until(() => h.trip(seed.tripId).status === "DRY_RUN");
  return seed;
}

beforeEach(() => fake.reset());

describe("restore after a restart", () => {
  it("mid-seal voyages are voided (nobody held) and can retry; absent members keep their standing instruction; autoPick re-arms; old docs load", async () => {
    const a = helm();
    // voyage 1: sealing, Rae authorized, Maya pending
    const s1 = await atDryRun(a);
    await a.pick(s1.tripId, { memberId: s1.organizer.memberId }, "LIS-W1-casa-alfama");
    await a.setSeal(s1.tripId, s1.organizer.memberId, a.trip(s1.tripId).bookingId!);
    await until(() => a.payments.bookings.get(a.trip(s1.tripId).bookingId!)!.seals.filter((s) => s.status !== "PENDING").length === 2); // Rae + Dev set
    // voyage 2: dry run with a majority countdown that should already have fired
    const s2 = await atDryRun(a);
    a.vote(s2.tripId, s2.maya.memberId, "LIS-W1-casa-alfama");
    a.vote(s2.tripId, s2.dev.memberId, "LIS-W1-casa-alfama");
    fake.get<TripRec>("trips", s2.tripId)!.autoPick!.at = Date.now() - 1000;
    // voyage 3: written by an older build without removedMemberIds / autoPick
    const s3 = await seedExpo(a);
    const legacy = fake.get<Record<string, unknown>>("trips", s3.tripId)!;
    delete legacy.removedMemberIds; delete legacy.autoPick;

    const b = helm();
    await b.restore();

    // 1) the dead attempt is voided so the organizer can go back to the charts
    const t1 = b.trip(s1.tripId);
    expect(t1.status).toBe("VOIDED");
    expect(b.payments.bookings.get(t1.bookingId!)!.status).toBe("VOIDED");
    expect(b.payments.bookings.get(t1.bookingId!)!.seals.every((s) => s.status === "VOIDED")).toBe(true);
    // 2) Dev (absent) still has his standing instruction: attempt 2 authorizes him without him
    expect(b.payments.standing.has(s1.dev.memberId)).toBe(true);
    b.retry(s1.tripId, { memberId: s1.organizer.memberId });
    await b.pick(s1.tripId, { memberId: s1.organizer.memberId }, "LIS-W1-casa-alfama");
    const b2 = b.payments.bookings.get(b.trip(s1.tripId).bookingId!)!;
    // S2-001: his standing seal is set at once (it authorizes with everyone else's once all are set)
    const devPublic = () => b.payments.toPublic(b2).seals.find((s) => s.memberId === s1.dev.memberId)!.status;
    await until(() => devPublic() === "AUTHORIZED");
    expect(devPublic()).toBe("AUTHORIZED");
    // 3) the overdue majority countdown still picks
    await until(() => b.trip(s2.tripId).status === "SEALING");
    expect(b.trip(s2.tripId).chosenPlanId).toBe("LIS-W1-casa-alfama");
    // 4) older documents don't crash the helm
    expect(b.crewPublic(b.trip(s3.tripId)).map((c) => c.name)).toEqual(["Rae", "Maya", "Dev"]);
  });
});

async function booked(h: TripService, cancel = false) {
  const seed = await atDryRun(h);
  await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
  const t = h.trip(seed.tripId);
  if (cancel) {
    // S2-001: a lift counts as "set"; the booking voids once every seal is set
    h.cancelSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    await h.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
  } else {
    await h.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
    await h.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
  }
  await until(() => t.status === (cancel ? "VOIDED" : "BOOKED"));
  return seed;
}

describe("restore reconciles the voyage with its booking (TR5-001, TR4-003)", () => {
  it("trip SEALING + booking CAPTURED → BOOKED with its reference; trip SEALING + booking VOIDED → VOIDED and retry works", async () => {
    const a = helm();
    const cap = await booked(a);
    const voi = await booked(a, true);
    const ref = a.payments.bookings.get(a.trip(cap.tripId).bookingId!)!.reference;
    // the trip writes were lost after the final booking writes landed
    for (const t of fake.docs<{ _id: string; status: string }>("trips")) if (t._id === cap.tripId || t._id === voi.tripId) t.status = "SEALING";

    const b = helm();
    await b.restore();
    const t1 = b.trip(cap.tripId);
    expect(t1.status).toBe("BOOKED");
    expect(b.state(t1).booking?.reference).toBe(ref);
    expect(b.state(t1).booking?.seals.every((s) => s.status === "CAPTURED")).toBe(true);
    const t2 = b.trip(voi.tripId);
    expect(t2.status).toBe("VOIDED");
    b.retry(voi.tripId, { memberId: voi.organizer.memberId });
    expect(t2.status).toBe("DRY_RUN");
  });

  it("a live booking no voyage points at (its trip write was lost) is voided and its holds released", async () => {
    const a = helm();
    const seed = await atDryRun(a);
    await a.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const bookingId = a.trip(seed.tripId).bookingId!;
    for (const t of fake.docs<{ _id: string; status: string; bookingId?: string }>("trips")) if (t._id === seed.tripId) { t.status = "DRY_RUN"; delete t.bookingId; }
    const b = helm();
    await b.restore();
    expect(b.payments.bookings.get(bookingId)!.status).toBe("VOIDED");
    expect(b.trip(seed.tripId).status).toBe("DRY_RUN");
  });
});

describe("standing instructions across a restart (SEC-009, TR4-004, TR5-004)", () => {
  it("restored with the ORIGINAL expiry, never re-issued; once expired the absent member seals live", async () => {
    const a = helm();
    const seed = await atDryRun(a);
    const dev = a.members.get(seed.dev.memberId)!;
    const original = dev.standing!.expiresAt;
    expect(original).toBeGreaterThan(Date.now() + 23 * 3600_000);

    // 1) restart 1 h later (clock moved): same instruction, same expiry
    const snap0 = fake.snapshot();
    const b = helm();
    await b.restore();
    expect(b.payments.standing.get(seed.dev.memberId)!.expiresAt).toBe(original);
    expect(b.payments.standing.get(seed.dev.memberId)!.instructionRef).toBe(dev.standing!.instructionRef);
    const sim = (b.payments as unknown as { provider: SimProvider }).provider;
    expect(sim.instructionExpiry(dev.standing!.instructionRef)).toBe(original);

    // 2) sealed 25 h ago: nothing is renewed, and the next booking's seal for Dev is live (standing:false)
    fake.load(snap0);
    for (const m of fake.docs<{ _id: string; standing?: { expiresAt: number } }>("members")) if (m._id === seed.dev.memberId) m.standing!.expiresAt = Date.now() - 3600_000;
    const snap2 = fake.snapshot();
    const c = helm();
    await c.restore();
    expect(c.payments.standing.has(seed.dev.memberId)).toBe(false);
    await c.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const bk = c.payments.bookings.get(c.trip(seed.tripId).bookingId!)!;
    expect(bk.seals.find((s) => s.memberId === seed.dev.memberId)!.standing).toBe(false);

    // 3) an older doc without `standing`: the expiry comes from when the brief was sealed (25 h ago → none)
    fake.load(snap2);
    for (const m of fake.docs<{ _id: string; standing?: unknown }>("members")) delete m.standing;
    for (const br of fake.docs<{ memberId: string; sealedAt: string }>("briefs")) if (br.memberId === seed.dev.memberId) br.sealedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    const snap3 = fake.snapshot();
    const d = helm();
    await d.restore();
    expect(d.payments.standing.has(seed.dev.memberId)).toBe(false);
    // …and sealed 1 h ago → 23 h left, not a fresh 24 h
    const sealedAt = Date.now() - 3600_000;
    fake.load(snap3);
    for (const br of fake.docs<{ memberId: string; sealedAt: string }>("briefs")) if (br.memberId === seed.dev.memberId) br.sealedAt = new Date(sealedAt).toISOString();
    const e = helm();
    await e.restore();
    expect(e.payments.standing.get(seed.dev.memberId)!.expiresAt).toBe(sealedAt + 24 * 3600_000);
  });
});

const simOf = (h: TripService) => (h.payments as unknown as { provider: SimProvider }).provider;
type Ev = { ev: string; p: any };
/** A helm whose trip-room and member events are recorded (attached before restore, like a live process). */
function recorded() {
  const h = helm();
  const room: Ev[] = [];
  const priv: (Ev & { memberId: string })[] = [];
  h.attachBus({ trip: (_t, ev, p) => room.push({ ev, p }), member: (memberId, ev, p) => priv.push({ memberId, ev, p }) });
  return { h, room, priv };
}
const storedBooking = (id: string) => fake.get<BookingRec>("bookings", id)!;

describe("L5-006: the restore reconcile path has the outcome's side effects", () => {
  it("SEALING + VOIDED booking: VOIDED with a public reason in the replay", async () => {
    const a = helm();
    const voi = await booked(a, true);
    for (const t of fake.docs<{ _id: string; status: string; lastResult?: unknown }>("trips")) if (t._id === voi.tripId) { t.status = "SEALING"; delete t.lastResult; }
    expect(storedBooking(a.trip(voi.tripId).bookingId!).status).toBe("VOIDED"); // the booking record is final
    const b = helm();
    await b.restore();
    expect(b.trip(voi.tripId).status).toBe("VOIDED");
    expect(b.trip(voi.tripId).lastResult?.publicReason).toBe(REASONS.restarted);
    const out: Ev[] = [];
    await b.replayer.replay(b.trip(voi.tripId), (ev, p) => out.push({ ev, p }));
    expect(out.find((e) => e.ev === "booking:result")?.p.publicReason).toBe(REASONS.restarted);
    expect(fake.get<TripRec>("trips", voi.tripId)!.lastResult?.publicReason).toBe(REASONS.restarted);
  });

  it("SEALING + CAPTURED booking: BOOKED, and one memory line per member with a crew key", async () => {
    const a = helm();
    const cap = await booked(a);
    await settle(20); // the live memory notes are written
    const keys = a.activeMembers(a.trip(cap.tripId)).map((m) => a.memKey(m)).filter((k): k is string => Boolean(k));
    expect(keys.length).toBeGreaterThan(0);
    const before = await Promise.all(keys.map(async (k) => (await recall(k)).filter((l) => l.includes("booked")).length));
    for (const t of fake.docs<{ _id: string; status: string }>("trips")) if (t._id === cap.tripId) t.status = "SEALING";
    const b = helm();
    await b.restore();
    expect(b.trip(cap.tripId).status).toBe("BOOKED");
    await settle(30); // let the memory writes run
    const after = await Promise.all(keys.map(async (k) => (await recall(k)).filter((l) => l.includes("booked")).length));
    expect(after).toEqual(before.map((n) => Math.min(n + 1, 5)));
  });

  it("SIM + ALL_AUTHORIZED (crashed mid-capture): the new process can't capture, so it voids with the restart reason", async () => {
    const a = helm();
    const cap = await booked(a);
    const id = a.trip(cap.tripId).bookingId!;
    const d = storedBooking(id) as BookingRec & { reference?: string };
    d.status = "ALL_AUTHORIZED"; delete d.reference;
    for (const s of d.seals) { s.status = "AUTHORIZED"; delete s.capturedAt; s.published = "AUTHORIZED"; }
    for (const t of fake.docs<{ _id: string; status: string }>("trips")) if (t._id === cap.tripId) t.status = "SEALING";
    const { h: b, room } = recorded();
    await b.restore();
    const t = b.trip(cap.tripId);
    expect(t.status).toBe("VOIDED");
    expect(t.lastResult?.publicReason).toBe(REASONS.restarted);
    expect(room.find((e) => e.ev === "booking:result")?.p.publicReason).toBe(REASONS.restarted);
    const bk = b.payments.bookings.get(id)!;
    expect(bk.needsAttention).toBeFalsy();
    expect(b.payments.unsettled(bk)).toBe(false); // the SIM's forgotten holds count as released: retry is allowed
    b.retry(cap.tripId, { memberId: cap.organizer.memberId });
    expect(t.status).toBe("DRY_RUN");
  });
});

describe("R2-WP-02 model (collect, then settle) across a restart", () => {
  it("restored mid-gathering (some seals set, nothing authorized): voided at once with the restart reason; nothing was ever authorized", async () => {
    const a = helm();
    const seed = await atDryRun(a);
    await a.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const id = a.trip(seed.tripId).bookingId!;
    await a.setSeal(seed.tripId, seed.organizer.memberId, id); // Rae + Dev (standing) set, Maya pending
    expect(storedBooking(id).settleAt).toBeUndefined();
    expect(storedBooking(id).seals.some((s) => s.authorizeRequestedAt)).toBe(false);
    const { h: b, room } = recorded();
    await b.restore();
    const t = b.trip(seed.tripId);
    expect(t.status).toBe("VOIDED");
    expect(t.lastResult?.publicReason).toBe(REASONS.restarted);
    expect(simOf(b).calls.authorize).toBe(0);
    // public: every seal VOIDED in seat order, then one booking:result; never DECLINED/AUTHORIZING
    const seals = room.filter((e) => e.ev === "seal:status").map((e) => e.p);
    expect(seals.map((s) => s.status)).toEqual(["VOIDED", "VOIDED", "VOIDED"]);
    expect(seals.map((s) => s.memberId)).toEqual(b.payments.bookings.get(id)!.seals.map((s) => s.memberId));
    expect(room.filter((e) => e.ev === "booking:result")).toHaveLength(1);
    expect(b.payments.unsettledFor(seed.tripId)).toHaveLength(0);
  });

  it("restored mid-settle (settle point fixed, authorizations requested, one privately declined): voided and published at once, holds released", async () => {
    const a = helm();
    a.payments.settleMs = 200; // the restart happens before the settle point…
    simOf(a).latency = [150, 150]; // …with the authorizations still in flight
    const seed = await atDryRun(a);
    await a.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const id = a.trip(seed.tripId).bookingId!;
    await a.setSeal(seed.tripId, seed.organizer.memberId, id);
    await a.setSeal(seed.tripId, seed.maya.memberId, id);
    const snap = fake.snapshot(); // the process dies here
    fake.load(snap);
    const d = storedBooking(id);
    expect(d.settleAt).toBeDefined();
    expect(d.seals.every((s) => s.authorizeRequestedAt)).toBe(true);
    // Maya's answer had come back declined (private; publicly still "set")
    const maya = d.seals.find((s) => s.memberId === seed.maya.memberId)!;
    maya.status = "DECLINED"; maya.declineReason = "over_limit";
    const { h: b, room, priv } = recorded();
    const t0 = Date.now();
    await b.restore();
    const t = b.trip(seed.tripId);
    expect(t.status).toBe("VOIDED");
    expect(Date.now() - t0).toBeLessThan(5_000); // not held until the old settle point
    expect(t.lastResult?.publicReason).toBe(REASONS.restarted);
    expect(room.filter((e) => e.ev === "seal:status").map((e) => e.p.status)).toEqual(["VOIDED", "VOIDED", "VOIDED"]);
    expect(JSON.stringify(room)).not.toMatch(/DECLINED|over_limit/);
    // only Maya learns her decline, privately
    expect(priv.filter((e) => e.ev === "seal:declinedPrivate").map((e) => e.memberId)).toEqual([seed.maya.memberId]);
    // Dev's standing instruction survived, so his re-asked authorization is approved in the new process and released
    const bk = b.payments.bookings.get(id)!;
    await until(() => bk.seals.every((s) => !s.authRef || s.releasedAt));
    expect(simOf(b).heldCount()).toBe(0);
    expect(b.payments.unsettled(bk)).toBe(false);
    await a.payments.whenSettled(id); // the old process's timers end before the next test's database
  });

  it("restored after the capture but before the settle point was published: BOOKED (the money was taken)", async () => {
    const a = helm();
    a.payments.settleMs = 300;
    const seed = await atDryRun(a);
    await a.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const id = a.trip(seed.tripId).bookingId!;
    await a.setSeal(seed.tripId, seed.organizer.memberId, id);
    await a.setSeal(seed.tripId, seed.maya.memberId, id);
    await until(() => storedBooking(id).status === "CAPTURED");
    expect(a.trip(seed.tripId).status).toBe("SEALING"); // held until the settle point
    const snap = fake.snapshot();
    fake.load(snap);
    const { h: b, room } = recorded();
    await b.restore();
    expect(b.trip(seed.tripId).status).toBe("BOOKED");
    expect(room.find((e) => e.ev === "booking:result")?.p.reference).toBe(b.payments.bookings.get(id)!.reference);
    await a.payments.whenSettled(id);
  });
});

describe("L5-002: a second helm waits for the lease before it restores", () => {
  it("it doesn't void the first helm's live booking until the first one releases the lease", async () => {
    const store = memoryLeaseStore();
    const la = new HelmLease(store, { owner: "old", pollMs: 2, log: () => undefined });
    await la.acquire();
    const a = helm();
    await a.restore();
    const seed = await atDryRun(a);
    await a.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const id = a.trip(seed.tripId).bookingId!;
    await a.setSeal(seed.tripId, seed.organizer.memberId, id);

    const b = helm();
    const lb = new HelmLease(store, { owner: "new", pollMs: 2, log: () => undefined });
    let restored = false;
    const boot = lb.acquire().then(() => b.restore()).then(() => { restored = true; });
    await settle(40);
    expect(restored).toBe(false);
    expect(b.trips.size).toBe(0);
    expect(storedBooking(id).status).toBe("AUTHORIZING"); // still gathering on the old helm
    expect(a.payments.bookings.get(id)!.status).toBe("AUTHORIZING");

    await la.release(); // the old helm shuts down (SIGTERM)
    await boot;
    expect(restored).toBe(true);
    expect(b.trip(seed.tripId).status).toBe("VOIDED");
    lb.stop();
  });
});

describe("L5-007: the absent member's cap isn't duplicated on the member doc", () => {
  it("no members doc carries limitCents; the restored instruction still has the original limit; a booked voyage's absent member has no standing", async () => {
    const a = helm();
    const seed = await atDryRun(a);
    const cap = a.briefs.get(seed.dev.memberId)!.capCents;
    expect(JSON.stringify(fake.docs("members"))).not.toContain("limitCents");
    expect(fake.get<{ standing?: object }>("members", seed.dev.memberId)!.standing).toBeDefined();
    // an older doc that still carries the cap is rewritten without it
    (fake.get<{ standing: Record<string, unknown> }>("members", seed.dev.memberId)!.standing).limitCents = cap;
    const b = helm();
    await b.restore();
    expect(b.payments.standing.get(seed.dev.memberId)!.limitCents).toBe(cap);
    expect(JSON.stringify(fake.docs("members"))).not.toContain("limitCents");

    // books: the standing instruction is dropped and unset
    await b.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const t = b.trip(seed.tripId);
    await b.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
    await b.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    await until(() => t.status === "BOOKED");
    expect(t.status).toBe("BOOKED");
    expect(b.payments.standing.has(seed.dev.memberId)).toBe(false);
    expect(fake.get<{ standing?: object }>("members", seed.dev.memberId)!.standing ?? undefined).toBeUndefined(); // (the fake stores undefined as null)
    // …and a BOOKED voyage restored from an older doc that still has one: unset too
    fake.get<{ standing?: object }>("members", seed.dev.memberId)!.standing = { memberId: seed.dev.memberId, instructionRef: "x", expiresAt: Date.now() + 3600_000 };
    const c = helm();
    await c.restore();
    expect(c.payments.standing.has(seed.dev.memberId)).toBe(false);
    expect(fake.get<{ standing?: object }>("members", seed.dev.memberId)!.standing ?? undefined).toBeUndefined(); // (the fake stores undefined as null)
  });
});
