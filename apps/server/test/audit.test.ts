/**
 * Regression tests from the server audit: payments invariants (doc 06 §5.3), seat rights after
 * "sail without them", replay after a voided attempt, and no orphan voyages.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import { PaymentsOrchestrator } from "../src/payments/orchestrator.js";
import { SimProvider } from "../src/payments/sim.js";
import { TripService } from "../src/trips/service.js";
import { type HelmError } from "../src/util/errors.js";
import { seedExpo } from "../src/demo/seed.js";
import { quiet, trackSim, until as untilTurn } from "./support/quiet.js";

afterEach(() => vi.useRealTimers());

function setup() {
  const sim = trackSim(new SimProvider());
  sim.latency = [5, 15];
  sim.declineMember = ""; sim.timeoutMember = "";
  const log: string[] = [];
  const results: { status: string }[] = [];
  const declined: string[] = [];
  const orch = new PaymentsOrchestrator(sim, {
    sealStatus: (_b, m, s) => log.push(`${m}:${s}`),
    declinedPrivate: (_b, m, r) => declined.push(`${m}:${r}`),
    result: (_b, status) => results.push({ status }),
    persist: () => undefined,
  });
  orch.settleMs = 0;
  const shares = [
    { memberId: "rae", amountCents: 103_800, capCents: 110_000 },
    { memberId: "maya", amountCents: 86_800, capCents: 90_000 },
    { memberId: "dev", amountCents: 96_300, capCents: 140_000 },
  ];
  const create = () => orch.create({ tripId: "t", planId: "LIS-W1-casa-alfama", cityId: "LIS", attempt: 1, shares });
  return { sim, orch, log, results, declined, shares, create };
}
/** A provider that takes this long (a stub standing in for the network, not a wait for the test). */
const lag = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** O2-063: until the provider calls in flight have answered and the orchestrator has acted (was a fixed 80 ms). */
const settle = () => quiet();

describe("payments invariants (doc 06 §5.3)", () => {
  it("a member lifting a seal they already set places no hold for anyone (S2-001: authorizations wait for all-set)", async () => {
    const { orch, sim, create, results, declined } = setup();
    const b = create();
    await orch.setSeal(b._id, "rae");
    orch.cancelSeal(b._id, "rae");
    await Promise.all([orch.setSeal(b._id, "maya"), orch.setSeal(b._id, "dev")]);
    await orch.whenSettled(b._id);
    expect(b.status).toBe("VOIDED");
    expect(results).toEqual([{ status: "VOIDED" }]);
    expect(declined).toEqual(["rae:user_cancelled"]);
    expect(sim.calls.authorize).toBe(0);
    expect(sim.heldCount()).toBe(0);
  });

  it("an approval that arrives after the 15 s timeout is voided, not left held", async () => {
    vi.useFakeTimers();
    const { orch, sim, create, declined, shares } = setup();
    sim.latency = [20_000, 20_000];
    const b = create();
    const p = Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
    await vi.advanceTimersByTimeAsync(15_050);
    await p;
    expect(declined.sort()).toEqual(["dev:timeout", "maya:timeout", "rae:timeout"]);
    expect(b.status).toBe("VOIDED");
    await vi.advanceTimersByTimeAsync(6_000); // the network finally says yes
    expect(sim.calls.authorize).toBe(3);
    expect(sim.heldCount()).toBe(0);
  });

  it("lifting a seal once every seal is AUTHORIZED (captures under way) can't void a captured booking", async () => {
    const { orch, sim, create, results, declined, shares } = setup();
    const capture = sim.capture.bind(sim);
    sim.capture = async (p) => { await lag(30); return capture(p); };
    const b = create();
    const sealing = Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
    await untilTurn(() => b.status === "ALL_AUTHORIZED");
    expect(b.status).toBe("ALL_AUTHORIZED");
    orch.cancelSeal(b._id, "maya");
    await sealing;
    await orch.whenSettled(b._id);
    expect(b.status).toBe("CAPTURED");
    expect(results).toEqual([{ status: "CAPTURED" }]);
    expect(declined).toEqual([]);
    expect(b.seals.every((s) => s.status === "CAPTURED")).toBe(true);
  });

  it("lifting a seal while voids are in flight is refused (settling) and doesn't send a second decline", async () => {
    const { orch, sim, create, declined, shares } = setup();
    const voidFn = sim.void.bind(sim);
    sim.void = async (p) => { await lag(30); return voidFn(p); };
    sim.declineMember = "maya";
    const b = create();
    await Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
    await untilTurn(() => b.status === "ANY_DECLINED");
    expect(b.status).toBe("ANY_DECLINED");
    expect(orch.cancelSeal(b._id, "dev")).toBe("locked");
    await orch.whenSettled(b._id);
    expect(declined).toEqual(["maya:over_limit"]);
    expect(b.seals.find((s) => s.memberId === "dev")!.declineReason).toBeUndefined();
    expect(sim.heldCount()).toBe(0);
  });

  it("a provider error while voiding doesn't wedge the booking in ANY_DECLINED", async () => {
    const { orch, sim, create, results, shares } = setup();
    sim.void = () => Promise.reject(new Error("network down"));
    sim.declineMember = "maya";
    const b = create();
    await Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
    await orch.whenSettled(b._id);
    expect(b.status).toBe("VOIDED");
    expect(b.needsAttention).toBe(true);
    expect(orch.holdsOutstanding(b)).toBe(true); // S2-010: the voyage stays blocked until a re-drive releases them
    expect(results.at(-1)?.status).toBe("VOIDED");
  });

  it("a capture that throws is treated as a failed capture: VOIDED and every hold released", async () => {
    const { orch, sim, create, results, shares } = setup();
    const capture = sim.capture.bind(sim);
    let first = true;
    sim.capture = (p) => { if (first) { first = false; return Promise.reject(new Error("gateway 500")); } return capture(p); };
    const b = create();
    await Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
    await settle();
    expect(b.status).toBe("VOIDED");
    expect(results.at(-1)?.status).toBe("VOIDED");
    expect(sim.capturedCount()).toBe(0);
    expect(sim.heldCount()).toBe(0);
  });

  it("the order of public seal updates on a void doesn't point at whose seal failed", async () => {
    const { orch, sim, create, log, shares } = setup();
    sim.declineMember = "maya";
    const b = create();
    await Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
    const before = log.length;
    await orch.whenSettled(b._id);
    // announced together in seat order, not decliner-first
    expect(log.slice(before).map((x) => x.split(":")[0])).toEqual(["rae", "maya", "dev"]);
  });

  it("an expired standing instruction isn't used (that member seals live)", async () => {
    const { orch, create } = setup();
    await orch.createStanding("dev", 140_000);
    orch.standing.get("dev")!.expiresAt = Date.now() - 1;
    const b = create();
    await settle();
    const dev = b.seals.find((s) => s.memberId === "dev")!;
    expect(dev.standing).toBe(false);
    expect(dev.status).toBe("PENDING");
    expect(b.status).toBe("PENDING");
  });
});

describe("restart recovery re-drives provider calls (TR5-006)", () => {
  it("a booking restored mid-void (ANY_DECLINED, seals VOIDED with authRefs) voids every hold", async () => {
    const { orch, sim, create, shares } = setup();
    const voidFn = sim.void.bind(sim);
    sim.void = () => new Promise(() => undefined); // the old process dies before any void goes out
    sim.declineMember = "maya";
    const b = create();
    await Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
    await untilTurn(() => b.status === "ANY_DECLINED");
    expect(sim.heldCount()).toBe(2);
    sim.void = voidFn;
    // the old process crashed right after persisting ANY_DECLINED, before any void went out
    const doc = JSON.parse(JSON.stringify(b));
    doc.status = "ANY_DECLINED";
    for (const s of doc.seals) s.status = "VOIDED";
    const results: string[] = [];
    const again = new PaymentsOrchestrator(sim, { sealStatus: () => undefined, declinedPrivate: () => undefined, result: (_b, st) => results.push(st), persist: () => undefined });
    again.bookings.set(doc._id, doc);
    const voids = sim.calls.void;
    await again.recover(doc);
    expect(sim.calls.void - voids).toBe(2);
    expect(sim.heldCount()).toBe(0);
    expect(doc.status).toBe("VOIDED");
    expect(doc.seals.filter((s: { releasedAt?: string }) => s.releasedAt)).toHaveLength(2);
    expect(results).toEqual(["VOIDED"]);
    // idempotent: a second recovery changes nothing and calls nobody
    const n = sim.calls.void;
    await again.recover(doc);
    expect(sim.calls.void).toBe(n);
  });

  it("an authorization requested before the crash is settled on restore: a late hold is released", async () => {
    const { orch, sim, create, shares } = setup();
    sim.latency = [40, 40];
    const b = create();
    for (const s of shares) void orch.setSeal(b._id, s.memberId); // all set: the authorizations start together
    await untilTurn(() => !!b.seals[0].authorizeRequestedAt);
    const doc = JSON.parse(JSON.stringify(b)); // crash snapshot: rae AUTHORIZING, no authRef yet
    expect(doc.seals[0].status).toBe("AUTHORIZING");
    expect(doc.seals[0].authorizeRequestedAt).toBeTruthy();
    expect(doc.seals[0].authRef).toBeUndefined();
    const again = new PaymentsOrchestrator(sim, { sealStatus: () => undefined, declinedPrivate: () => undefined, result: () => undefined, persist: () => undefined });
    again.bookings.set(doc._id, doc);
    await again.recover(doc);
    await settle();
    expect(doc.status).toBe("VOIDED");
    expect(doc.seals[0].authRef).toBeTruthy(); // learned from the provider's idempotent replay
    expect(sim.heldCount()).toBe(0);
  });

  it("a booking restored mid-capture (ALL_AUTHORIZED) completes its captures instead of voiding captured money", async () => {
    const { orch, sim, create, shares } = setup();
    const capture = sim.capture.bind(sim);
    let n = 0;
    sim.capture = async (p) => { if (++n <= 3) { if (n === 1) return capture(p); return new Promise(() => undefined); } return capture(p); };
    const b = create();
    void Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
    await untilTurn(() => b.status === "ALL_AUTHORIZED");
    await settle(); // the one capture that answers
    const doc = JSON.parse(JSON.stringify(b)); // one capture done, two in flight when the process died
    expect(doc.status).toBe("ALL_AUTHORIZED");
    const results: string[] = [];
    const again = new PaymentsOrchestrator(sim, { sealStatus: () => undefined, declinedPrivate: () => undefined, result: (_b, st) => results.push(st), persist: () => undefined });
    again.bookings.set(doc._id, doc);
    await again.recover(doc);
    expect(doc.status).toBe("CAPTURED");
    expect(results).toEqual(["CAPTURED"]);
    expect(sim.capturedCount()).toBe(3);
  });
});

describe("standing instructions keep their original expiry (SEC-009)", () => {
  it("restoreStanding keeps the expiry it was created with and never renews an expired one", async () => {
    const { orch, sim } = setup();
    const t0 = Date.now();
    const ins = (await orch.createStanding("dev", 140_000, t0 + 3600_000))!;
    expect(ins.expiresAt).toBe(t0 + 3600_000);
    const fresh = new SimProvider(); // the SIM forgets instructions with the process
    const again = new PaymentsOrchestrator(fresh, { sealStatus: () => undefined, declinedPrivate: () => undefined, result: () => undefined, persist: () => undefined });
    expect(await again.restoreStanding(ins)).toBe(true);
    expect(again.standing.get("dev")!.expiresAt).toBe(t0 + 3600_000);
    expect(fresh.instructionExpiry(ins.instructionRef)).toBe(t0 + 3600_000);
    expect(await again.restoreStanding({ ...ins, expiresAt: Date.now() - 1 })).toBe(false);
    expect(again.standing.has("dev")).toBe(false);
    expect(await again.createStanding("dev", 140_000, Date.now() - 1)).toBeNull();
    void sim;
  });
});

// ---------- the helm ----------
function helmWithBus() {
  const helm = new TripService();
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const trip: { ev: string; p: any }[] = [];
  helm.attachBus({ trip: (_t, ev, p) => trip.push({ ev, p }), member: () => undefined });
  return { helm, trip };
}
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };
const until = (pred: () => boolean) => untilTurn(pred);

describe("helm guards", () => {
  it("a member removed by 'sail without them' loses their seat (their token no longer authenticates)", async () => {
    const { helm } = helmWithBus();
    const { trip, member, token: raeToken } = helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const maya = helm.join(trip._id, { name: "Maya", band: 2, origin: "ORD" });
    const late = helm.join(trip._id, { name: "Late", band: 3, origin: "JFK" });
    await helm.submitBrief(trip._id, member._id, { capCents: 110_000, dateWindowIds: ["W1"], mustHaves: ["food"], dealbreakers: [] });
    await helm.submitBrief(trip._id, maya.member._id, { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: ["beach"], dealbreakers: [] });
    expect(helm.memberByToken(trip._id, late.token)?._id).toBe(late.member._id);
    helm.sailWithout(trip._id, { memberId: member._id }, [late.member._id]);
    // otherwise their vote would count toward a "majority" of a crew they're no longer in
    expect(helm.memberByToken(trip._id, late.token)).toBeNull();
    expect(helm.memberByToken(trip._id, raeToken)?._id).toBe(member._id);
    expect(helm.memberByToken(trip._id, { not: "a string" } as never)).toBeNull();
  });

  it("a bad organizer input leaves no organizer-less orphan voyage behind", async () => {
    const { helm } = helmWithBus();
    const before = helm.trips.size;
    expect(await code(() => helm.createTrip({ name: "x", organizerName: "Rae", band: 13 as never, origin: "ATL" }))).toBe("BAD_INPUT");
    expect(await code(() => helm.createTrip({ name: "x", organizerName: "", band: 1, origin: "ATL" }))).toBe("BAD_INPUT");
    expect(helm.trips.size).toBe(before);
  });

  it("a hail left queued from an earlier meeting doesn't carry into the next one", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    helm.pendingHails.set(seed.tripId, [{ memberId: seed.organizer.memberId, text: "cheaper please" }]);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    expect(helm.pendingHails.get(seed.tripId)).toEqual([]);
  });

  it("after 'back to the charts', a rejoining phone isn't replayed the voided attempt's seal screen", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    await until(() => helm.trip(seed.tripId).status === "DRY_RUN");
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const t = helm.trip(seed.tripId);
    helm.cancelSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    await helm.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
    await until(() => t.status === "VOIDED");
    helm.retry(seed.tripId, { memberId: seed.organizer.memberId });
    expect(t.status).toBe("DRY_RUN");
    const got: string[] = [];
    await helm.replayer.replay(t, (ev) => got.push(ev), seed.organizer.memberId);
    expect(got).toContain("plan:private");
    expect(got).not.toContain("seal:private");
    expect(got).not.toContain("booking:created");
  });
});
