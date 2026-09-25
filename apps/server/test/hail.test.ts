/**
 * WP-12 service paths: the table's one privacy context, hails (partial redaction, no silent drops,
 * late hails refused), datesLabel, and the brief note's source.
 */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import { TripService } from "../src/trips/service.js";
import { type HelmError } from "../src/util/errors.js";
import { validateBrief } from "../src/trips/crew.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";
import { buildPrivacyContext } from "../src/privacy/context.js";

function helmWithBus() {
  const helm = new TripService();
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const trip: { ev: string; p: any }[] = [];
  helm.attachBus({ trip: (_t, ev, p) => trip.push({ ev, p }), member: () => undefined });
  return { helm, trip };
}
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };
/** Start the table and step past the Captain's OPEN (L4-005: hails open at Watch 1). */
async function atWatch1(helm: TripService, seed: Awaited<ReturnType<typeof seedExpo>>) {
  await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
  helm.trip(seed.tripId).negotiation.watch = 1;
}

describe("WP-12 — hails and the table's privacy context", () => {
  it("OPT-013 / TR4-012: one context, built from the ≤12-plan chart book the table argues over", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    const t = helm.trip(seed.tripId);
    const book = helm.table.chartBook(t);
    expect(book.length).toBeLessThanOrEqual(12);
    expect(helm.privacy.get(seed.tripId)).toEqual(buildPrivacyContext(helm.ds, helm.table.pricingCrew(t), book));
  });

  it("TR4-011: a hail keeps its words and loses only the amount; a second one while the first waits is refused, not dropped", async () => {
    const { helm, trip } = helmWithBus();
    const seed = await seedExpo(helm);
    await atWatch1(helm, seed);
    helm.hail(seed.tripId, seed.maya.memberId, "I can do 900 for the beach, let's go Lisbon");
    const hail = trip.filter((e) => e.ev === "turn:new" && e.p.act === "HAIL").at(-1)!.p;
    expect(hail.text).toBe("I can do for the beach, let's go Lisbon");
    expect(hail.redactions).toBe(1);
    expect(hail.watch).toBe(2);
    expect(await code(() => helm.hail(seed.tripId, seed.maya.memberId, "beach please"))).toBe("HAIL_WAITING");
    expect(helm.pendingHails.get(seed.tripId)!.filter((h) => h.memberId === seed.maya.memberId)).toHaveLength(1);
  });

  it("SEC-017: a hail that is only an amount is refused privately — no public turn", async () => {
    const { helm, trip } = helmWithBus();
    const seed = await seedExpo(helm);
    await atWatch1(helm, seed);
    const before = trip.filter((e) => e.p?.act === "HAIL").length;
    expect(await code(() => helm.hail(seed.tripId, seed.dev.memberId, "$900"))).toBe("HAIL_AMOUNTS");
    expect(trip.filter((e) => e.p?.act === "HAIL").length).toBe(before);
    // S2-003: a refused hail costs the same interval as an accepted one
    expect(await code(() => helm.hail(seed.tripId, seed.dev.memberId, "somewhere cheaper please"))).toBe("SLOW_DOWN");
    helm.lastHailAt.delete(seed.dev.memberId);
    expect(await code(() => helm.hail(seed.tripId, seed.dev.memberId, "somewhere cheaper please"))).toBe("OK");
  });

  it("S2-003: refused probes are rate-limited — 3 refused hails in 1 s: the 2nd and 3rd get SLOW_DOWN", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    await atWatch1(helm, seed);
    const codes = [];
    for (const p of ["$900", "$1000", "$2500"]) codes.push(await code(() => helm.hail(seed.tripId, seed.maya.memberId, p)));
    expect(codes).toEqual(["HAIL_AMOUNTS", "SLOW_DOWN", "SLOW_DOWN"]);
  });

  it("S2-003: the observable response to a probe is the same near and far from the real secrets", async () => {
    const probes = ["lets go 9 $5000 0 0 somewhere nice", "lets go 8 $5000 6 8 somewhere nice", "I can do 900 for the beach", "$900", "$2500"];
    // the Expo secrets (Maya's cap 900, her Lisbon share 868, …), a set planted right on each probe, one far from all of them
    const secretSets: (number[] | null)[] = [null, [900, 868], [2500], [5000, 7000]];
    for (const p of probes) {
      const seen: string[] = [];
      for (const secrets of secretSets) {
        const { helm, trip } = helmWithBus();
        const seed = await seedExpo(helm);
        await atWatch1(helm, seed);
        const real = helm.privacy.get(seed.tripId)!;
        if (secrets) helm.privacy.set(seed.tripId, { ...real, sensitiveDollars: secrets });
        const c = await code(() => helm.hail(seed.tripId, seed.dev.memberId, p));
        const turn = trip.filter((e) => e.ev === "turn:new" && e.p.act === "HAIL").at(-1)?.p;
        // what the sender (and the room) can observe: the code, the posted words and the redaction count
        seen.push(JSON.stringify([c, turn?.text ?? null, turn?.ribbon ?? null, turn?.redactions ?? null]));
      }
      expect(new Set(seen).size, p).toBe(1);
    }
  });

  it("L4-005: a hail during the Captain's OPEN (Watch 0) is refused with TABLE_OPENING; no turn, no stamp", async () => {
    const { helm, trip } = helmWithBus();
    const seed = await seedExpo(helm);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    const t = helm.trip(seed.tripId);
    t.negotiation.watch = 0;
    expect(await code(() => helm.hail(seed.tripId, seed.organizer.memberId, "I'd pay more for the beach."))).toBe("TABLE_OPENING");
    expect(trip.filter((e) => e.p?.act === "HAIL")).toHaveLength(0);
    t.negotiation.watch = 1;
    expect(await code(() => helm.hail(seed.tripId, seed.organizer.memberId, "I'd pay more for the beach."))).toBe("OK");
  });

  it("TR4-011: a hail after the last Watch, or once the Captain is deciding, is refused with CAPTAINS_CALLING", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    const t = helm.trip(seed.tripId);
    const watch = t.negotiation.watch;
    t.negotiation.watch = 3;
    expect(await code(() => helm.hail(seed.tripId, seed.maya.memberId, "beach please"))).toBe("CAPTAINS_CALLING");
    t.negotiation.watch = watch;
    helm.hailsClosed.add(seed.tripId);
    expect(await code(() => helm.hail(seed.tripId, seed.maya.memberId, "beach please"))).toBe("CAPTAINS_CALLING");
  });

  it("TR4-005: no common window → null; with a chosen plan, that plan's window", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    const t = helm.trip(seed.tripId);
    expect(helm.table.datesLabel(t)).toBe("Mar 12 to 16");
    helm.briefs.get(seed.maya.memberId)!.dateWindowIds = ["W2"];
    helm.chartBooks.delete(t._id);
    expect(helm.table.datesLabel(t)).toBeNull();
    const w2 = helm.table.chartBook(t).find((p) => p.dateWindowId === "W2")!;
    t.chosenPlanId = w2._id;
    expect(helm.table.datesLabel(t)).toBe("Mar 13 to 16");
  });

  it("TR4-006: noteSource is only kept with a note", () => {
    const base = { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: [], dealbreakers: [] };
    const ds = new TripService().ds;
    expect(validateBrief({ ...base, noteSource: "voice" }, ds).noteSource).toBeUndefined();
    expect(validateBrief({ ...base, note: "hills are hard", noteSource: "voice" }, ds).noteSource).toBe("voice");
    expect(validateBrief({ ...base, note: "hills are hard" }, ds).noteSource).toBe("typed");
  });
});
