import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentsOrchestrator, REASONS, type BookingRec } from "../src/payments/orchestrator.js";
import { SimProvider } from "../src/payments/sim.js";
import { quiet, trackSim } from "./support/quiet.js";

function setup() {
  const sim = trackSim(new SimProvider());
  sim.latency = [5, 15];
  sim.declineMember = ""; sim.timeoutMember = "";
  const log: string[] = [];
  const results: { status: string }[] = [];
  const reasons: (string | undefined)[] = [];
  const declined: string[] = [];
  const orch = new PaymentsOrchestrator(sim, {
    sealStatus: (_b, m, s) => log.push(`${m}:${s}`),
    declinedPrivate: (_b, m, r) => declined.push(`${m}:${r}`),
    result: (_b, status, reason) => { results.push({ status }); reasons.push(reason); },
    persist: () => undefined,
  });
  orch.settleMs = 0; // S2-001's settle point is tested on its own below
  const shares = [
    { memberId: "rae", amountCents: 103_800, capCents: 110_000 },
    { memberId: "maya", amountCents: 86_800, capCents: 90_000 },
    { memberId: "dev", amountCents: 96_300, capCents: 140_000 },
  ];
  return { sim, orch, log, results, reasons, declined, shares };
}
/** O2-063: until the provider calls in flight have answered and the orchestrator has acted on them (was a fixed 80 ms). */
const settle = () => quiet();
const create = (o: PaymentsOrchestrator, shares: { memberId: string; amountCents: number; capCents: number }[]) =>
  o.create({ tripId: "t", planId: "LIS-W1-casa-alfama", cityId: "LIS", attempt: 1, shares });
/** Every seal set, then wait until the outcome is published. */
async function sealAll(o: PaymentsOrchestrator, b: BookingRec, ids: string[]) {
  await Promise.all(ids.map((id) => o.setSeal(b._id, id)));
  await o.whenSettled(b._id);
}

describe("all-or-nothing seal (doc 06 §10)", () => {
  it("1. everyone approves → CAPTURED, one capture each, Σ seals = total", async () => {
    const { orch, sim, results, shares } = setup();
    const b = create(orch, shares);
    expect(b.seals.reduce((s, x) => s + x.amountCents, 0)).toBe(b.groupCents);
    await sealAll(orch, b, shares.map((s) => s.memberId));
    expect(b.status).toBe("CAPTURED");
    expect(sim.calls.capture).toBe(3);
    expect(results).toEqual([{ status: "CAPTURED" }]);
    expect(b.reference).toMatch(/^AA-LIS-[A-Z2-9]{4}$/);
  });

  it("2. one lifts their seal → all voided at the all-set point, nothing authorized, no capture", async () => {
    const { orch, sim, results, declined, shares } = setup();
    const b = create(orch, shares);
    await orch.setSeal(b._id, "rae");
    orch.cancelSeal(b._id, "maya");
    await settle();
    expect(b.status).toBe("AUTHORIZING"); // S2-001: nothing voids mid-gathering; Dev hasn't set yet
    expect(results).toEqual([]);
    await sealAll(orch, b, ["dev"]);
    expect(b.status).toBe("VOIDED");
    expect(sim.calls.authorize).toBe(0); // a lifted seal means no hold is ever placed
    expect(sim.calls.capture).toBe(0);
    expect(sim.heldCount()).toBe(0);
    expect(declined).toEqual(["maya:user_cancelled"]);
    expect(results.at(-1)?.status).toBe("VOIDED");
    expect(b.seals.find((s) => s.memberId === "rae")!.status).toBe("VOIDED");
  });

  it("3. share over the instruction limit is declined (spending control)", async () => {
    const { orch, sim, shares, declined } = setup();
    const b = create(orch, [{ ...shares[0], amountCents: 120_000 }, shares[1], shares[2]]);
    await sealAll(orch, b, shares.map((s) => s.memberId));
    expect(b.status).toBe("VOIDED");
    expect(declined).toContain("rae:over_limit");
    expect(sim.heldCount()).toBe(0);
  });

  it("4. duplicate seal taps → one instruction, one authorization", async () => {
    const { orch, sim, shares } = setup();
    const b = create(orch, shares);
    expect(await Promise.all([orch.setSeal(b._id, "rae"), orch.setSeal(b._id, "rae"), orch.setSeal(b._id, "rae")])).toEqual(["ok", "locked", "locked"]);
    await sealAll(orch, b, ["maya", "dev"]);
    expect(sim.calls.authorize).toBe(3); // one per seal
    expect(b.status).toBe("CAPTURED");
  });

  it("5. capture failure → everyone released; captured shares are refunded, not voided (SEC-016)", async () => {
    const { orch, sim, shares, results, reasons } = setup();
    const b: BookingRec = create(orch, shares);
    const capture = sim.capture.bind(sim);
    sim.capture = (p) => (p.authRef === b.seals[0].authRef ? Promise.resolve({ ok: false }) : capture(p));
    await sealAll(orch, b, shares.map((s) => s.memberId));
    expect(b.status).toBe("VOIDED");
    expect(sim.capturedCount()).toBe(0);
    expect(sim.heldCount()).toBe(0); // the seal whose capture failed is released too
    expect(results.at(-1)?.status).toBe("VOIDED");
    // Maya and Dev were captured: a void can't undo that, so they get refunds
    expect(sim.calls.refund).toBe(2);
    expect(sim.refundedCount()).toBe(2);
    expect(b.seals.filter((s) => s.refundedAt).map((s) => s.memberId).sort()).toEqual(["dev", "maya"]);
    expect(b.needsAttention).toBeFalsy();
    expect(orch.owesRefund(b)).toBe(false);
    expect(reasons.at(-1)).toBe(REASONS.refunded);
    expect(b.seals.every((s) => s.status === "VOIDED")).toBe(true); // invariant 3
  });

  it("5b. a refund the provider refuses is flagged needs_attention and keeps being owed", async () => {
    const { orch, sim, shares, reasons } = setup();
    const b = create(orch, shares);
    const capture = sim.capture.bind(sim);
    const refund = sim.refund.bind(sim);
    let refuse = true;
    sim.capture = (p) => (p.authRef === b.seals[0].authRef ? Promise.resolve({ ok: false }) : capture(p));
    sim.refund = (p) => (refuse && p.authRef === b.seals[1].authRef ? Promise.resolve({ ok: false }) : refund(p));
    await sealAll(orch, b, shares.map((s) => s.memberId));
    expect(b.status).toBe("VOIDED");
    expect(b.needsAttention).toBe(true);
    expect(orch.owesRefund(b)).toBe(true);
    expect(orch.unsettledFor("t")).toEqual([b]);
    expect(reasons.at(-1)).toBe(REASONS.refundPending);
    refuse = false; // the provider now accepts the refund
    expect(await orch.redrive(b)).toBe(true);
    expect(b.needsAttention).toBe(false);
    expect(orch.owesRefund(b)).toBe(false);
  });

  it("5c. every capture failed → nothing to refund, and the crew is told nobody was charged", async () => {
    const { orch, sim, shares, reasons } = setup();
    sim.capture = async () => ({ ok: false });
    const b = create(orch, shares);
    await sealAll(orch, b, shares.map((s) => s.memberId));
    expect(b.status).toBe("VOIDED");
    expect(sim.calls.refund).toBe(0);
    expect(sim.heldCount()).toBe(0);
    expect(reasons.at(-1)).toBe(REASONS.captureFailedNoCharge);
  });

  it("6. an absent member's standing seal is set on creation, but authorizes only with everyone else (S2-001)", async () => {
    const { orch, sim, shares, log } = setup();
    await orch.createStanding("dev", 140_000);
    const b = create(orch, shares);
    await settle();
    expect(log).toEqual(["dev:AUTHORIZED"]); // publicly "set"
    expect(b.seals.find((s) => s.memberId === "dev")!.status).toBe("AUTHORIZING");
    expect(sim.calls.authorize).toBe(0); // no answer can precede the live seals
    await orch.setSeal(b._id, "rae");
    await settle();
    expect(sim.calls.authorize).toBe(0);
    await sealAll(orch, b, ["maya"]);
    expect(sim.calls.authorize).toBe(3);
    expect(b.status).toBe("CAPTURED");
  });

  it("7. retry creates fresh seals; the voided attempt is untouched", async () => {
    const { orch, shares } = setup();
    const a1 = create(orch, shares);
    expect(await orch.callOff(a1._id)).toBe("voided");
    const a2 = orch.create({ tripId: "t", planId: "LIS-W1-casa-alfama", cityId: "LIS", attempt: 2, shares });
    expect(a2._id).not.toBe(a1._id);
    expect(a2.seals.every((s) => s.status === "PENDING")).toBe(true);
    expect(a1.status).toBe("VOIDED");
  });
});

describe("seal deadline and call-off (SEC-011)", () => {
  afterEach(() => vi.useRealTimers());

  it("2 of 3 seal, 10 minutes pass → VOIDED, nothing held, nobody blamed", async () => {
    vi.useFakeTimers();
    const { orch, sim, shares, results, reasons, declined } = setup();
    const b = create(orch, shares);
    const p = Promise.all([orch.setSeal(b._id, "rae"), orch.setSeal(b._id, "dev")]);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(sim.calls.authorize).toBe(0); // S2-001: nothing is authorized until every seal is set
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(b.status).toBe("VOIDED");
    expect(sim.heldCount()).toBe(0);
    expect(results).toEqual([{ status: "VOIDED" }]);
    expect(reasons).toEqual([REASONS.deadline]);
    expect(declined).toEqual([]);
    expect(b.seals.every((s) => s.status === "VOIDED")).toBe(true);
  });

  it("the deadline does nothing once the booking settled", async () => {
    vi.useFakeTimers();
    const { orch, shares, results } = setup();
    const b = create(orch, shares);
    const p = Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(b.status).toBe("CAPTURED");
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(b.status).toBe("CAPTURED");
    expect(results).toEqual([{ status: "CAPTURED" }]);
  });

  it("call-off voids an attempt still gathering seals, including a tap in flight", async () => {
    const { orch, sim, shares, reasons, declined } = setup();
    const b = create(orch, shares);
    await orch.setSeal(b._id, "rae");
    const inflight = orch.setSeal(b._id, "maya");
    expect(await orch.callOff(b._id)).toBe("voided");
    await inflight;
    await settle();
    expect(b.status).toBe("VOIDED");
    expect(sim.heldCount()).toBe(0);
    expect(reasons.at(-1)).toBe(REASONS.calledOff);
    expect(declined).toEqual([]);
    expect(await orch.callOff(b._id)).toBe("voiding"); // already voided by a call-off: idempotent
  });

  it("L4-004: a concurrent second call-off is 'voiding' (same call-off), never 'captures under way'", async () => {
    const { orch, sim, shares } = setup();
    await orch.createStanding("dev", 140_000);
    const b = create(orch, shares);
    await orch.setSeal(b._id, "rae");
    const voidCall = sim.void.bind(sim);
    sim.void = async (p) => { await new Promise((r) => setTimeout(r, 20)); return voidCall(p); };
    const [a, c] = await Promise.all([orch.callOff(b._id), orch.callOff(b._id)]);
    expect([a, c]).toEqual(["voided", "voiding"]);
    expect(b.status).toBe("VOIDED");
  });

  it("call-off is refused once every seal is set (settling), whatever the outcome will be", async () => {
    for (const decliner of ["", "maya"]) {
      const { orch, sim, shares, results } = setup();
      sim.declineMember = decliner;
      orch.settleMs = 50;
      const b = create(orch, shares);
      await Promise.all(shares.map((s) => orch.setSeal(b._id, s.memberId)));
      expect(await orch.callOff(b._id)).toBe("settling");
      expect(orch.cancelSeal(b._id, "rae")).toBe("locked");
      await orch.whenSettled(b._id);
      expect(results).toEqual([{ status: decliner ? "VOIDED" : "CAPTURED" }]);
    }
  });
});

describe("public seal sequence doesn't reveal the decliner (SEC-002)", () => {
  it("whoever is declined, every member's public status sequence is the same", async () => {
    const seqs: Record<string, Record<string, string[]>> = {};
    for (const decliner of ["rae", "maya", "dev"]) {
      for (let run = 0; run < 3; run++) {
        const { orch, sim, shares, log, declined } = setup();
        sim.latency = [2, 25]; // random per call
        sim.declineMember = decliner;
        const b = create(orch, shares);
        const bySeat: Record<string, string[]> = Object.fromEntries(orch.toPublic(b).seals.map((s) => [s.memberId, [s.status]]));
        await sealAll(orch, b, shares.map((s) => s.memberId));
        for (const e of log) { const [m, st] = e.split(":"); if (bySeat[m].at(-1) !== st) bySeat[m].push(st); }
        expect(declined).toEqual([`${decliner}:over_limit`]);
        expect(b.status).toBe("VOIDED");
        expect(sim.heldCount()).toBe(0);
        seqs[`${decliner}#${run}`] = bySeat;
      }
    }
    const want = { rae: ["PENDING", "AUTHORIZED", "VOIDED"], maya: ["PENDING", "AUTHORIZED", "VOIDED"], dev: ["PENDING", "AUTHORIZED", "VOIDED"] };
    for (const got of Object.values(seqs)) expect(got).toEqual(want);
  });

  it("a snapshot mid-seal never shows an authorization outcome or a DECLINED; a lift reads as 'set'", async () => {
    const { orch, shares } = setup();
    orch.settleMs = 40;
    const b = create(orch, shares);
    await orch.setSeal(b._id, "rae");
    expect(orch.toPublic(b).seals.map((s) => s.status)).toEqual(["AUTHORIZED", "PENDING", "PENDING"]);
    orch.cancelSeal(b._id, "maya");
    expect(orch.toPublic(b).status).toBe("AUTHORIZING");
    expect(orch.toPublic(b).seals.map((s) => s.status)).toEqual(["AUTHORIZED", "AUTHORIZED", "PENDING"]);
    await orch.setSeal(b._id, "dev");
    await new Promise((r) => setTimeout(r, 10));
    // decided internally (voided), but held until the settle point
    expect(b.status).toBe("VOIDED");
    expect(orch.toPublic(b)).toMatchObject({ status: "AUTHORIZING", reference: undefined, sealDeadlineAt: undefined });
    expect(orch.toPublic(b).seals.every((s) => s.status === "AUTHORIZED")).toBe(true);
    await orch.whenSettled(b._id);
    expect(orch.toPublic(b).status).toBe("VOIDED");
    expect(orch.toPublic(b).seals.every((s) => s.status === "VOIDED")).toBe(true);
  });
});

describe("S2-001: the outcome is published at a fixed settle point", () => {
  afterEach(() => vi.useRealTimers());

  /** Rae taps at +1 s, Maya at +2 s, Dev is standing; returns public event times relative to creation. */
  async function world(opts: { decliner?: string; lift?: string; latency?: [number, number] }) {
    vi.useFakeTimers();
    const { orch, sim, shares } = setup();
    orch.settleMs = 2_500;
    sim.latency = opts.latency ?? [600, 1200];
    sim.declineMember = opts.decliner ?? "";
    await orch.createStanding("dev", 140_000);
    const t0 = Date.now();
    const events: string[] = [];
    const ev = (orch as unknown as { events: { sealStatus: (b: BookingRec, m: string, s: string) => void; result: (b: BookingRec, s: string) => void } }).events;
    const seal = ev.sealStatus, res = ev.result;
    ev.sealStatus = (b, m, s) => { events.push(`${Date.now() - t0} ${m}:${s}`); seal(b, m, s); };
    ev.result = (b, s) => { events.push(`${Date.now() - t0} result:${s}`); res(b, s); };
    const b = create(orch, shares);
    await vi.advanceTimersByTimeAsync(1_000);
    if (opts.lift === "rae") orch.cancelSeal(b._id, "rae"); else void orch.setSeal(b._id, "rae");
    await vi.advanceTimersByTimeAsync(1_000);
    if (opts.lift === "maya") orch.cancelSeal(b._id, "maya"); else void orch.setSeal(b._id, "maya");
    await vi.advanceTimersByTimeAsync(10_000);
    return { events, b, sim };
  }

  it("a void lands at the same moment whoever declined, the standing seal included; a lift looks the same", async () => {
    const worlds = [
      await world({ decliner: "rae" }), await world({ decliner: "maya" }), await world({ decliner: "dev" }),
      await world({ lift: "rae" }), await world({ lift: "maya" }),
    ];
    const want = ["0 dev:AUTHORIZED", "1000 rae:AUTHORIZED", "2000 maya:AUTHORIZED",
      "4500 rae:VOIDED", "4500 maya:VOIDED", "4500 dev:VOIDED", "4500 result:VOIDED"];
    for (const w of worlds) {
      expect(w.events).toEqual(want);
      expect(w.sim.heldCount()).toBe(0);
    }
    // the booked path runs on the same clock
    expect((await world({})).events).toEqual(want.map((e) => e.replace("VOIDED", "CAPTURED")));
  });

  it("a provider slower than the settle point delays the outcome for everyone alike (still no decliner-first update)", async () => {
    const a = await world({ decliner: "dev", latency: [3_000, 3_000] });
    const b = await world({ decliner: "rae", latency: [3_000, 3_000] });
    expect(a.events).toEqual(b.events);
    expect(a.events.at(-1)).toBe("5000 result:VOIDED");
  });
});

describe("S2-010: a hold the provider hasn't released blocks the voyage", () => {
  it("a void that throws once leaves the voyage unsettled until a re-drive releases it", async () => {
    const { orch, sim, shares } = setup();
    const voidCall = sim.void.bind(sim);
    let fail = 1;
    sim.void = async (p) => { if (fail-- > 0) throw new Error("network down"); return voidCall(p); };
    const b = create(orch, shares);
    sim.declineMember = "maya";
    await sealAll(orch, b, shares.map((s) => s.memberId));
    expect(b.status).toBe("VOIDED");
    expect(b.needsAttention).toBe(true);
    expect(orch.holdsOutstanding(b)).toBe(true);
    expect(sim.heldCount()).toBe(1);
    expect(orch.unsettledFor("t")).toEqual([b]); // also kicks the re-drive
    await settle();
    expect(orch.holdsOutstanding(b)).toBe(false);
    expect(b.needsAttention).toBe(false);
    expect(sim.heldCount()).toBe(0);
    expect(orch.unsettledFor("t")).toEqual([]);
  });

  it("a plain {ok:false} is not a release; a provider saying the hold is gone is", async () => {
    const { orch, sim, shares } = setup();
    const voidCall = sim.void.bind(sim);
    let refuse = true;
    sim.void = async (p) => (refuse ? { ok: false } : voidCall(p));
    const b = create(orch, shares);
    sim.declineMember = "rae";
    await sealAll(orch, b, shares.map((s) => s.memberId));
    expect(orch.holdsOutstanding(b)).toBe(true);
    expect(b.seals.filter((s) => s.authRef && !s.releasedAt)).toHaveLength(2);
    refuse = false;
    expect(await orch.redrive(b)).toBe(true);
    expect(orch.holdsOutstanding(b)).toBe(false);
    expect(await sim.void({ authRef: b.seals[1].authRef!, idempotencyKey: "again" })).toEqual({ ok: false, gone: true });
  });
});
