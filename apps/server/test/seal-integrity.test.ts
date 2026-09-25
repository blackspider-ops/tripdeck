/**
 * WP-04 at the helm level: public seal sequences (SEC-002), seal deadline and call-off (SEC-011), refunds blocking a
 * retry (SEC-016), pick failure semantics (TR4-016), brief + standing atomicity (TR4-017), VOIDED memory (TR4-018).
 */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

const mem = vi.hoisted(() => ({ lines: [] as { key: string; text: string }[], calls: 0 }));
vi.mock("../src/memory/memory.js", () => ({
  crewKeyHash: (k: string) => `h:${k}`,
  personKey: (keyHash: string, name: string) => `crew:${keyHash}|${name.trim().toLowerCase()}`,
  validCrewKey: (k: unknown) => typeof k === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(k),
  recall: async () => [],
  remember: async (key: string, text: string) => { mem.lines.push({ key, text }); },
  // O2-041: a voyage's notes go in one call
  rememberAll: async (notes: { key: string; text: string }[]) => { mem.calls++; mem.lines.push(...notes); },
  budgetBand: () => "mid budget",
}));

import { TripService } from "../src/trips/service.js";
import { type HelmError } from "../src/util/errors.js";
import { REASONS } from "../src/payments/orchestrator.js";
import type { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean) => { for (let i = 0; i < 400 && !pred(); i++) await settle(); };
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };

function helm() {
  const h = new TripService();
  const sim = (h.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const trip: { ev: string; p: any }[] = [];
  const member: { id: string; ev: string; p: any }[] = [];
  h.attachBus({ trip: (_t, ev, p) => trip.push({ ev, p }), member: (id, ev, p) => member.push({ id, ev, p }) });
  return { h, sim, trip, member };
}
async function atDryRun(h: TripService) {
  const seed = await seedExpo(h);
  await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
  await until(() => h.trip(seed.tripId).status === "DRY_RUN");
  return seed;
}
const LIS = "LIS-W1-casa-alfama";

describe("SEC-002: the trip room can't tell whose seal was declined", () => {
  it("per-member public sequences (seal:status + trip:state) are identical whoever declines", async () => {
    const runs: Record<string, unknown> = {};
    for (const who of ["organizer", "maya", "dev"] as const) {
      for (let run = 0; run < 2; run++) {
        const { h, sim, trip, member } = helm();
        const seed = await atDryRun(h);
        const ids = { organizer: seed.organizer.memberId, maya: seed.maya.memberId, dev: seed.dev.memberId };
        sim.latency = [10, 40];
        sim.declineMember = ids[who];
        trip.length = 0;
        await h.pick(seed.tripId, { memberId: ids.organizer }, LIS);
        const bookingId = h.trip(seed.tripId).bookingId!;
        await Promise.all([h.setSeal(seed.tripId, ids.organizer, bookingId), h.setSeal(seed.tripId, ids.maya, bookingId)]);
        await until(() => h.trip(seed.tripId).status === "VOIDED");
        await settle(60);

        const seq: Record<string, string[]> = { organizer: [], maya: [], dev: [] };
        const bookingSeq: string[] = [];
        const name = (id: string) => (Object.keys(ids) as (keyof typeof ids)[]).find((k) => ids[k] === id)!;
        const push = (list: string[], s: string) => { if (list.at(-1) !== s) list.push(s); };
        for (const { ev, p } of trip) {
          if (ev === "seal:status") push(seq[name(p.memberId)], p.status);
          const b = ev === "booking:created" ? p : ev === "trip:state" ? p.booking : undefined;
          if (b) { push(bookingSeq, b.status); for (const s of b.seals) push(seq[name(s.memberId)], s.status); }
          expect(JSON.stringify(p)).not.toMatch(/DECLINED|over_limit|declineReason/);
        }
        runs[`${who}#${run}`] = { seq, bookingSeq };
        // the owner still learns it, privately
        expect(member.filter((m) => m.ev === "seal:declinedPrivate").map((m) => m.id)).toEqual([ids[who]]);
      }
    }
    const want = {
      seq: { organizer: ["PENDING", "AUTHORIZED", "VOIDED"], maya: ["PENDING", "AUTHORIZED", "VOIDED"], dev: ["PENDING", "AUTHORIZED", "VOIDED"] },
      bookingSeq: ["PENDING", "AUTHORIZING", "VOIDED"],
    };
    for (const got of Object.values(runs)) expect(got).toEqual(want);
  });
});

describe("SEC-011: seal deadline and organizer call-off", () => {
  it("the organizer calls it off: every hold released, voyage VOIDED, retry works; members and wrong phases are refused", async () => {
    const { h, sim, trip } = helm();
    const seed = await atDryRun(h);
    await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    const t = h.trip(seed.tripId);
    await h.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
    await settle(20);
    expect(sim.heldCount()).toBe(0); // S2-001: Rae and Dev (standing) are set, but nothing is authorized before all-set
    expect(await code(() => h.callOff(seed.tripId, { memberId: seed.maya.memberId }, t.bookingId!))).toBe("NOT_ORGANIZER");
    expect(await code(() => h.callOff(seed.tripId, { memberId: seed.organizer.memberId }, "other"))).toBe("BAD_PHASE");
    // L4-004: a second, concurrent call-off is the same call-off (never "the booking is being logged")
    const both = await Promise.all([1, 2].map(() => code(() => h.callOff(seed.tripId, { memberId: seed.organizer.memberId }, t.bookingId!))));
    expect(both).toEqual(["OK", "OK"]);
    expect(t.status).toBe("VOIDED");
    expect(sim.heldCount()).toBe(0);
    expect(trip.filter((e) => e.ev === "booking:result").map((e) => e.p.publicReason)).toEqual([REASONS.calledOff]);
    expect(await code(() => h.callOff(seed.tripId, { memberId: seed.organizer.memberId }, t.bookingId!))).toBe("BAD_PHASE");
    h.retry(seed.tripId, { memberId: seed.organizer.memberId });
    expect(t.status).toBe("DRY_RUN");
  });

  it("the paired headset can call it off too", async () => {
    const { h, sim } = helm();
    const seed = await atDryRun(h);
    const { deviceToken } = h.pairHeadset(seed.headsetCode);
    await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    await h.callOff(seed.tripId, { deviceToken }, h.trip(seed.tripId).bookingId!);
    expect(h.trip(seed.tripId).status).toBe("VOIDED");
    await settle(20);
    expect(sim.heldCount()).toBe(0);
  });

  it("seals not all set by the deadline void the booking with nobody held", async () => {
    const { h, sim, trip } = helm();
    const seed = await atDryRun(h);
    h.payments.sealDeadlineMs = 80;
    await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    const t = h.trip(seed.tripId);
    await h.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!); // Maya never taps
    await until(() => t.status === "VOIDED");
    expect(t.status).toBe("VOIDED");
    expect(sim.heldCount()).toBe(0);
    expect(trip.find((e) => e.ev === "booking:result")?.p.publicReason).toBe(REASONS.deadline);
    expect(h.payments.bookings.get(t.bookingId!)!.sealDeadlineAt).toBeTruthy();
  });
});

/** Every seal set; the first capture fails and, while `refuse.on`, every refund is refused: a refund stays owed. */
async function owingVoid(h: TripService, sim: SimProvider, seed: Awaited<ReturnType<typeof seedExpo>>) {
  const capture = sim.capture.bind(sim), refund = sim.refund.bind(sim);
  let first = true;
  const refuse = { on: true };
  sim.capture = (p) => { if (first) { first = false; return Promise.resolve({ ok: false }); } return capture(p); };
  sim.refund = (p) => (refuse.on ? Promise.resolve({ ok: false }) : refund(p));
  await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
  const t = h.trip(seed.tripId);
  const b = h.payments.bookings.get(t.bookingId!)!;
  await h.setSeal(seed.tripId, seed.organizer.memberId, b._id);
  await h.setSeal(seed.tripId, seed.maya.memberId, b._id);
  await until(() => t.status === "VOIDED");
  return { t, b, refuse };
}

describe("SEC-016: a refund still owed blocks retry", () => {
  it("retry is refused with NEEDS_ATTENTION until the refund goes through", async () => {
    const { h, sim, trip } = helm();
    const seed = await atDryRun(h);
    const { b, refuse } = await owingVoid(h, sim, seed);
    expect(trip.find((e) => e.ev === "booking:result")?.p.publicReason).toBe(REASONS.refundPending);
    expect(b.needsAttention).toBe(true);
    expect(await code(() => h.retry(seed.tripId, { memberId: seed.organizer.memberId }))).toBe("NEEDS_ATTENTION");
    refuse.on = false;
    expect(await code(() => h.retry(seed.tripId, { memberId: seed.organizer.memberId }))).toBe("NEEDS_ATTENTION"); // kicks the re-drive
    await until(() => !b.needsAttention);
    expect(await code(() => h.retry(seed.tripId, { memberId: seed.organizer.memberId }))).toBe("OK");
  });
});

describe("L4-001: an owed refund can't be bypassed through new terms and a new table", () => {
  it("VOIDED → new terms → new table / pick are refused with NEEDS_ATTENTION until the refund clears", async () => {
    const { h, sim } = helm();
    const seed = await atDryRun(h);
    const { t, b, refuse } = await owingVoid(h, sim, seed);
    const rae = { memberId: seed.organizer.memberId };
    await h.submitBrief(seed.tripId, rae.memberId, { capCents: 110_000, dateWindowIds: ["W1"], mustHaves: ["food", "nightlife"], dealbreakers: ["early_start"] });
    expect(t.status).toBe("BRIEFING");
    const runs = t.tableRuns;
    // the new table is refused at the state machine (transition → AT_TABLE), before it costs a run
    expect(await code(() => h.startTable(seed.tripId, rae))).toBe("NEEDS_ATTENTION");
    expect(t.status).toBe("BRIEFING");
    expect(t.tableRuns).toBe(runs);

    // pick's own gate: pretend the refund cleared long enough to reach the charts, then owe it again
    const owed = b.seals.filter((s) => s.capturedAt && !s.refundedAt);
    for (const s of owed) s.refundedAt = "pretend";
    await h.startTable(seed.tripId, rae);
    await until(() => t.status === "DRY_RUN");
    for (const s of owed) s.refundedAt = undefined;
    const bookings = h.payments.bookings.size;
    expect(await code(() => h.pick(seed.tripId, rae, LIS))).toBe("NEEDS_ATTENTION");
    expect(t.status).toBe("DRY_RUN");
    expect(t.attempt).toBe(1);
    expect(t.bookingId).toBe(b._id);
    expect(h.payments.bookings.size).toBe(bookings); // no second booking

    refuse.on = false;
    expect(await code(() => h.pick(seed.tripId, rae, LIS))).toBe("NEEDS_ATTENTION"); // kicks the re-drive
    await until(() => !h.payments.owesRefund(b));
    expect(await code(() => h.pick(seed.tripId, rae, LIS))).toBe("OK");
    expect(t.status).toBe("SEALING");
    expect(t.attempt).toBe(2);
  });
});

describe("S2-010: an unreleased hold blocks retry", () => {
  it("a void that throws once: retry answers NEEDS_ATTENTION until a re-drive releases the hold", async () => {
    const { h, sim } = helm();
    const seed = await atDryRun(h);
    const voidCall = sim.void.bind(sim);
    let fail = 1;
    sim.void = async (p) => { if (fail-- > 0) throw new Error("network down"); return voidCall(p); };
    sim.declineMember = seed.maya.memberId;
    await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    const t = h.trip(seed.tripId);
    const b = h.payments.bookings.get(t.bookingId!)!;
    await h.setSeal(seed.tripId, seed.organizer.memberId, b._id);
    await h.setSeal(seed.tripId, seed.maya.memberId, b._id);
    await until(() => t.status === "VOIDED");
    expect(h.payments.owesRefund(b)).toBe(false); // nothing was captured: the old gate would have let this through
    expect(h.payments.holdsOutstanding(b)).toBe(true);
    expect(await code(() => h.retry(seed.tripId, { memberId: seed.organizer.memberId }))).toBe("NEEDS_ATTENTION");
    await until(() => !h.payments.holdsOutstanding(b));
    expect(sim.heldCount()).toBe(0);
    expect(await code(() => h.retry(seed.tripId, { memberId: seed.organizer.memberId }))).toBe("OK");
  });
});

describe("TR4-016: pick semantics once the booking exists", () => {
  it("an agent-card failure for one member still delivers everyone else's seal screen, and pick resolves", async () => {
    const { h, sim, member, trip } = helm();
    const seed = await atDryRun(h);
    const card = sim.ensureAgentCard.bind(sim);
    sim.ensureAgentCard = async (id) => { if (id === seed.maya.memberId) throw new Error("tokenization down"); return card(id); };
    trip.length = 0;
    await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    const got = member.filter((m) => m.ev === "seal:private");
    expect(got.map((m) => m.id).sort()).toEqual([seed.organizer.memberId, seed.maya.memberId, seed.dev.memberId].sort());
    expect(got.find((m) => m.id === seed.maya.memberId)!.p.cardLast4).toBe("••••");
    expect(trip.some((e) => e.ev === "trip:state" && e.p.status === "SEALING")).toBe(true);
  });

  it("a missing brief is refused before the voyage changes", async () => {
    const { h } = helm();
    const seed = await atDryRun(h);
    const t = h.trip(seed.tripId);
    h.briefs.delete(seed.maya.memberId);
    expect(await code(() => h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS))).toBe("BRIEFS_PENDING");
    expect(t.status).toBe("DRY_RUN");
    expect(t.attempt).toBe(0);
    expect(t.bookingId).toBeUndefined();
  });
});

describe("TR4-017: a brief seal is atomic even when the standing instruction fails", () => {
  it("the absent member's brief seals and broadcasts without a standing instruction; they seal live", async () => {
    const { h, sim, trip, member } = helm();
    const { trip: t, member: rae } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const dev = h.addAbsent(t._id, { memberId: rae._id }, { name: "Dev", band: 3, origin: "JFK" });
    sim.createInstruction = async () => { throw new Error("VIC down"); };
    trip.length = 0;
    await h.submitBrief(t._id, dev.memberId, { capCents: 140_000, dateWindowIds: ["W1"], mustHaves: ["food"], dealbreakers: [] });
    expect(h.members.get(dev.memberId)!.briefSealed).toBe(true);
    expect(h.members.get(dev.memberId)!.standing).toBeUndefined();
    expect(h.briefs.has(dev.memberId)).toBe(true);
    expect(h.payments.standing.has(dev.memberId)).toBe(false);
    expect(trip.some((e) => e.ev === "trip:state" && e.p.crew.find((c: { memberId: string }) => c.memberId === dev.memberId)?.briefSealed)).toBe(true);
    expect(member.some((m) => m.ev === "brief:private" && m.id === dev.memberId)).toBe(true);
  });

  it("when it works, the instruction is kept on the member (server-side only) with a 24 h expiry from the seal", async () => {
    const { h, member } = helm();
    const seed = await seedExpo(h);
    const dev = h.members.get(seed.dev.memberId)!;
    const sealedAt = Date.parse(h.briefs.get(seed.dev.memberId)!.sealedAt!);
    expect(dev.standing!.expiresAt).toBe(sealedAt + 24 * 3600_000);
    expect(JSON.stringify(member.filter((m) => m.id === seed.dev.memberId).map((m) => m.p))).not.toContain(dev.standing!.instructionRef);
  });
});

describe("TR4-018: a voided attempt leaves a neutral memory note", () => {
  it("every active member gains one line, with no budget band and no blame", async () => {
    const { h } = helm();
    const seed = await atDryRun(h);
    mem.lines.length = 0; mem.calls = 0;
    await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    h.cancelSeal(seed.tripId, seed.maya.memberId, h.trip(seed.tripId).bookingId!);
    await h.setSeal(seed.tripId, seed.organizer.memberId, h.trip(seed.tripId).bookingId!);
    await until(() => mem.lines.length === 3);
    // keyed on each member's private crew key (SEC-003): three distinct threads, none of them "name|origin"
    const keys = mem.lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).toMatch(/^crew:h:[A-Za-z0-9_-]{32,}\|(rae|maya|dev)$/);
    for (const l of mem.lines) {
      expect(l.text).toMatch(/^voyage: Lisbon, .* · not booked \(nobody was charged\)$/);
      expect(l.text).not.toMatch(/budget|maya|declin|lifted/i);
    }
    expect(new Set(mem.lines.map((l) => l.text)).size).toBe(1);
    expect(mem.calls).toBe(1); // O2-041: one store write for the whole crew
  });
});

describe("L4-008: voided attempts don't flood the memory recall", () => {
  it("two voids and a capture leave one voided note and one booked note per member", async () => {
    const { h } = helm();
    const seed = await atDryRun(h);
    const rae = { memberId: seed.organizer.memberId };
    mem.lines.length = 0;
    const t = h.trip(seed.tripId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.pick(seed.tripId, rae, LIS);
      if (attempt < 3) {
        await h.callOff(seed.tripId, rae, t.bookingId!);
        await until(() => t.status === "VOIDED");
        h.retry(seed.tripId, rae);
      } else {
        await h.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
        await h.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
        await until(() => t.status === "BOOKED");
      }
    }
    await until(() => mem.lines.length >= 6);
    await settle(30);
    const byKey = new Map<string, string[]>();
    for (const l of mem.lines) byKey.set(l.key, [...(byKey.get(l.key) ?? []), l.text]);
    expect(byKey.size).toBe(3);
    for (const lines of byKey.values()) {
      expect(lines).toHaveLength(2);
      expect(lines.filter((x) => x.includes("not booked"))).toHaveLength(1);
      expect(lines.filter((x) => x.includes("· booked ·"))).toHaveLength(1);
    }
  });
});

describe("L4-006: a late booking result can't take the restore-only edges live", () => {
  it("onBookingResult(VOIDED) on a BOOKED voyage changes nothing and emits nothing", async () => {
    const { h, trip } = helm();
    const seed = await atDryRun(h);
    await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    const t = h.trip(seed.tripId);
    const b = h.payments.bookings.get(t.bookingId!)!;
    await h.setSeal(seed.tripId, seed.organizer.memberId, b._id);
    await h.setSeal(seed.tripId, seed.maya.memberId, b._id);
    await until(() => t.status === "BOOKED");
    await settle(20);
    mem.lines.length = 0;
    const version = t.version, events = trip.length;
    h.sealing.onBookingResult(b, "VOIDED", REASONS.declined);
    h.sealing.onBookingResult(b, "CAPTURED");
    await settle(20);
    expect(t.status).toBe("BOOKED");
    expect(t.version).toBe(version);
    expect(trip.length).toBe(events);
    expect(mem.lines).toEqual([]);
  });

  it("transition(): restore-only edges need an explicit `from`, and `from` is checked even when staying put", async () => {
    const { h } = helm();
    const seed = await atDryRun(h);
    const t = h.trip(seed.tripId);
    expect(await code(() => h.transition(t, "BRIEFING"))).toBe("BAD_PHASE"); // DRY_RUN → BRIEFING: restore only
    expect(await code(() => h.transition(t, "DRY_RUN", { from: ["VOIDED"] }))).toBe("BAD_PHASE"); // same status, wrong precondition
    expect(t.status).toBe("DRY_RUN");
    h.transition(t, "DRY_RUN", { from: ["DRY_RUN"] }); // same status, precondition holds: a no-op
    h.transition(t, "BRIEFING", { from: ["DRY_RUN"], reason: "test restore" });
    expect(t.status).toBe("BRIEFING");
    t.status = "BOOKED";
    expect(await code(() => h.transition(t, "VOIDED"))).toBe("BAD_PHASE");
    h.transition(t, "VOIDED", { from: ["BOOKED"], reason: "test restore" });
    expect(await code(() => h.transition(t, "BOOKED"))).toBe("BAD_PHASE");
  });
});

describe("L4-007: retry checks the Two Charts before committing to DRY_RUN", () => {
  it("a VOIDED voyage whose charts don't resolve answers retry with a clear error and lands in BRIEFING", async () => {
    const { h } = helm();
    const seed = await atDryRun(h);
    const rae = { memberId: seed.organizer.memberId };
    await h.pick(seed.tripId, rae, LIS);
    const t = h.trip(seed.tripId);
    await h.callOff(seed.tripId, rae, t.bookingId!);
    await until(() => t.status === "VOIDED");
    t.shortlistIds = ["gone-A", "gone-B"]; // an older doc after a dataset change
    t.shortlistPlans = undefined;
    const err = await (async () => { try { h.retry(seed.tripId, rae); } catch (e) { return e as HelmError; } })();
    expect(err?.code).toBe("BAD_PHASE");
    expect(err?.message).toMatch(/no longer on the table/);
    expect(t.status).toBe("BRIEFING");
    expect(t.tableReset?.reason).toBeTruthy();
    expect(t.shortlistIds).toBeUndefined();
  });

  it("R2-WP-13 (L3-006 remainder): that path starts a new round, so a rejoin replays none of the old meeting's turns", async () => {
    const { h } = helm();
    const seed = await atDryRun(h);
    const rae = { memberId: seed.organizer.memberId };
    await h.pick(seed.tripId, rae, LIS);
    const t = h.trip(seed.tripId);
    const round = t.negotiation.round ?? 0;
    expect(t.negotiation.turns.length).toBeGreaterThan(0);
    await h.callOff(seed.tripId, rae, t.bookingId!);
    await until(() => t.status === "VOIDED");
    t.shortlistIds = ["gone-A", "gone-B"];
    t.shortlistPlans = undefined;
    expect(() => h.retry(seed.tripId, rae)).toThrow(/no longer on the table/);
    expect(t.negotiation.round).toBe(round + 1);
    expect(t.negotiation.turns).toEqual([]);
    const sent: string[] = [];
    await h.replayer.replay(t, (ev) => { sent.push(ev); }, seed.maya.memberId);
    expect(sent).not.toContain("turn:new");
  });
});

describe("S2-001: the trip room can't tell whose seal failed, by order or by timing", () => {
  const SETTLE = 300;
  /** Seed crew (Rae organizer, Maya, Dev absent with a standing seal). Rae acts at +60 ms, Maya at +120 ms. */
  async function world(opts: { decliner?: "rae" | "maya" | "dev"; lift?: "rae" | "maya" }) {
    const { h, sim, trip } = helm();
    const seed = await atDryRun(h);
    const ids = { rae: seed.organizer.memberId, maya: seed.maya.memberId, dev: seed.dev.memberId };
    const name = (id: string) => (Object.keys(ids) as (keyof typeof ids)[]).find((k) => ids[k] === id)!;
    h.payments.settleMs = SETTLE;
    sim.latency = [5, 60]; // random per call
    sim.declineMember = opts.decliner ? ids[opts.decliner] : "";
    const log: { at: number; e: string }[] = [];
    let t0 = 0;
    h.attachBus({
      trip: (_t, ev, p: any) => {
        if (ev === "booking:created") t0 = Date.now();
        if (ev === "seal:status") log.push({ at: Date.now() - t0, e: `seal:${name(p.memberId)}:${p.status}` });
        if (ev === "booking:result") log.push({ at: Date.now() - t0, e: `result:${p.status}:${p.publicReason}` });
        if (ev === "trip:state" && p.booking) log.push({ at: Date.now() - t0, e: `state:${p.status}:${p.booking.status}:${p.booking.seals.map((s: any) => s.status).join(",")}` });
        trip.push({ ev, p });
      },
      member: () => undefined,
    });
    await h.pick(seed.tripId, { memberId: ids.rae }, LIS);
    const bookingId = h.trip(seed.tripId).bookingId!;
    const act = async (who: "rae" | "maya") => {
      if (opts.lift === who) h.cancelSeal(seed.tripId, ids[who], bookingId);
      else await h.setSeal(seed.tripId, ids[who], bookingId);
    };
    await settle(60 - (Date.now() - t0)); await act("rae");
    await settle(120 - (Date.now() - t0)); await act("maya");
    await until(() => h.trip(seed.tripId).status === "VOIDED");
    await settle(30);
    return log;
  }

  it("identical public sequences and settle timing whoever declines, the standing seal (declining first) and a lift included", async () => {
    const worlds = { dev: await world({ decliner: "dev" }), rae: await world({ decliner: "rae" }), maya: await world({ decliner: "maya" }),
      liftRae: await world({ lift: "rae" }), liftMaya: await world({ lift: "maya" }) };
    const seqs = Object.values(worlds).map((w) => w.map((x) => x.e));
    for (const s of seqs) expect(s).toEqual(seqs[0]);
    expect(seqs[0][0]).toBe("seal:dev:AUTHORIZED"); // the standing seal is set first, and nothing follows it until all-set
    expect(seqs[0].filter((e) => e.startsWith("result:"))).toEqual([`result:VOIDED:${REASONS.declined}`]);
    // the result lands at the fixed settle point after the last "set", whoever declined
    const gaps = Object.values(worlds).map((w) => {
      const lastSet = w.filter((x) => x.e.endsWith(":AUTHORIZED")).at(-1)!.at;
      return w.find((x) => x.e.startsWith("result:"))!.at - lastSet;
    });
    for (const g of gaps) { expect(g).toBeGreaterThanOrEqual(SETTLE - 5); expect(g).toBeLessThan(SETTLE + 80); }
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(60);
    // before the settle point nothing but "set" reached the trip room (no early void for the standing decliner)
    const dev = worlds.dev;
    const result = dev.find((x) => x.e.startsWith("result:"))!.at;
    expect(dev.filter((x) => x.at < result - 5 && /VOIDED/.test(x.e))).toEqual([]);
  });
});
