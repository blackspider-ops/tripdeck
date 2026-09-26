import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import { TripService } from "../src/trips/service.js";
import { HelmError } from "../src/util/errors.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";

function helmWithBus() {
  const helm = new TripService();
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const trip: { ev: string; p: any }[] = [];
  const member: { id: string; ev: string; p: any }[] = [];
  helm.attachBus({ trip: (_t, ev, p) => trip.push({ ev, p }), member: (id, ev, p) => member.push({ id, ev, p }) });
  return { helm, trip, member };
}
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };

async function atDryRun() {
  const x = helmWithBus();
  const seed = await seedExpo(x.helm);
  await x.helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
  for (let i = 0; i < 400 && x.helm.trip(seed.tripId).status !== "DRY_RUN"; i++) await new Promise((r) => setTimeout(r, 5));
  return { ...x, seed };
}

afterEach(() => vi.useRealTimers());

describe("voyage setup", () => {
  it("A4: organizer can put two ports on the chart; one is rejected", async () => {
    const { helm } = helmWithBus();
    const { trip } = helm.createTrip({ name: "Two ports", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS", "MEX"] });
    expect(trip.candidateCityIds).toEqual(["LIS", "MEX"]);
    expect(await code(() => helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL", cityIds: ["LIS"] }))).toBe("BAD_INPUT");
    // no ports named: 3 at random ("Surprise me"), never every port (the chart book holds 12 plans), and the next two windows
    const dflt = helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" }).trip;
    expect(dflt.candidateCityIds).toHaveLength(Math.min(3, helm.ds.cities.length));
    expect(new Set(dflt.candidateCityIds).size).toBe(dflt.candidateCityIds.length);
    expect(dflt.candidateWindowIds).toEqual(["W1", "W2"]);
    // at most four ports on one chart
    const five = helm.ds.cities.slice(0, 5).map((c) => c._id);
    if (five.length === 5) expect(await code(() => helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL", cityIds: five }))).toBe("BAD_INPUT");
  });

  it("rejects a taken band, a fifth crew member, and bad briefs", async () => {
    const { helm } = helmWithBus();
    const { trip, member } = helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    expect(await code(() => helm.join(trip._id, { name: "Maya", band: 1, origin: "ORD" }))).toBe("BAND_TAKEN");
    helm.join(trip._id, { name: "B", band: 2, origin: "ORD" });
    helm.join(trip._id, { name: "C", band: 3, origin: "ORD" });
    helm.join(trip._id, { name: "D", band: 4, origin: "ORD" });
    expect(await code(() => helm.join(trip._id, { name: "E", band: 2, origin: "ORD" }))).toBe("CREW_FULL");
    expect(await code(() => helm.submitBrief(trip._id, member._id, { capCents: 100, dateWindowIds: ["W1"], mustHaves: [], dealbreakers: [] }))).toBe("BAD_INPUT");
    expect(await code(() => helm.submitBrief(trip._id, member._id, { capCents: 90_000, dateWindowIds: ["W9"], mustHaves: [], dealbreakers: [] }))).toBe("BAD_INPUT");
  });

  it("the table only meets when every remaining brief is sealed; sail-without removes the stragglers", async () => {
    const { helm } = helmWithBus();
    const { trip, member } = helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const maya = helm.join(trip._id, { name: "Maya", band: 2, origin: "ORD" });
    const late = helm.join(trip._id, { name: "Late", band: 3, origin: "JFK" });
    await helm.submitBrief(trip._id, member._id, { capCents: 110_000, dateWindowIds: ["W1"], mustHaves: ["food"], dealbreakers: [] });
    await helm.submitBrief(trip._id, maya.member._id, { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: ["beach"], dealbreakers: [] });
    expect(await code(() => helm.startTable(trip._id, { memberId: member._id }))).toBe("BRIEFS_PENDING");
    expect(await code(() => helm.startTable(trip._id, { memberId: maya.member._id }))).toBe("NOT_ORGANIZER");
    helm.sailWithout(trip._id, { memberId: member._id }, [late.member._id]);
    expect(helm.crewPublic(trip).map((c) => c.name)).toEqual(["Rae", "Maya"]);
    expect(await code(() => helm.startTable(trip._id, { memberId: member._id }))).toBe("OK");
  });

  it("headset codes are single-use and the device token gets organizer controls only", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    const pair = helm.pairHeadset(seed.headsetCode);
    expect(await code(() => helm.pairHeadset(seed.headsetCode))).toBe("BAD_CODE");
    expect(helm.deviceOk(seed.tripId, pair.deviceToken)).toBe(true);
    expect(helm.memberByToken(seed.tripId, pair.deviceToken)).toBeNull();
    // a second pairing revokes the first headset
    const { code: c2 } = helm.headsetCode(seed.tripId, { memberId: seed.organizer.memberId });
    const pair2 = helm.pairHeadset(c2);
    expect(helm.deviceOk(seed.tripId, pair.deviceToken)).toBe(false);
    expect(helm.deviceOk(seed.tripId, pair2.deviceToken)).toBe(true);
  });
});

describe("review follow-ups", () => {
  it("absent invite links are single-use; the headset can't sail without anyone", async () => {
    const { helm } = helmWithBus();
    const { trip, member } = helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const inv = helm.addAbsent(trip._id, { memberId: member._id }, { name: "Dev", band: 3, origin: "JFK" });
    expect(helm.claimAbsent(trip._id, inv.memberId, inv.inviteKey).memberToken).toBeTruthy();
    expect(await code(() => helm.claimAbsent(trip._id, inv.memberId, inv.inviteKey))).toBe("BAD_INVITE");
    const { code: hc } = helm.headsetCode(trip._id, { memberId: member._id });
    const { deviceToken } = helm.pairHeadset(hc);
    expect(await code(() => helm.sailWithout(trip._id, { deviceToken }, [inv.memberId]))).toBe("NOT_ORGANIZER");
  });

  it("TR1-001: the organizer can re-issue an unclaimed invite; the old link stops working, a claimed one can't be re-issued", async () => {
    const { helm } = helmWithBus();
    const { trip, member } = helm.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const maya = helm.join(trip._id, { name: "Maya", band: 2, origin: "ORD" });
    const inv = helm.addAbsent(trip._id, { memberId: member._id }, { name: "Dev", band: 3, origin: "JFK" });
    expect(await code(() => helm.reissueInvite(trip._id, { memberId: maya.member._id }, inv.memberId))).toBe("NOT_ORGANIZER");
    expect(await code(() => helm.reissueInvite(trip._id, { memberId: member._id }, maya.member._id))).toBe("NOT_FOUND");
    const again = helm.reissueInvite(trip._id, { memberId: member._id }, inv.memberId);
    expect(again.inviteKey).not.toBe(inv.inviteKey);
    expect(again.invitePath).toContain(`m=${inv.memberId}&k=${again.inviteKey}`);
    expect(await code(() => helm.claimAbsent(trip._id, inv.memberId, inv.inviteKey))).toBe("BAD_INVITE");
    expect(helm.claimAbsent(trip._id, inv.memberId, again.inviteKey).memberToken).toBeTruthy();
    expect(await code(() => helm.reissueInvite(trip._id, { memberId: member._id }, inv.memberId))).toBe("INVITE_CLAIMED");
  });

  it("the Dry Run clock is shared: replays carry the same start time", async () => {
    const { helm, seed, trip } = await atDryRun();
    const first = trip.filter((e) => e.ev === "dryrun:script").at(-1)!.p;
    expect(first.startedAt).toBeTypeOf("number");
    const replayed: { ev: string; p: any }[] = [];
    await helm.replayer.replay(helm.trip(seed.tripId), (ev, p) => replayed.push({ ev, p }), seed.maya.memberId);
    expect(replayed.find((e) => e.ev === "dryrun:script")!.p.startedAt).toBe(first.startedAt);
  });
});

describe("D5 — majority auto-pick", () => {
  it("two of three on Lisbon picks it after the countdown", async () => {
    const { helm, seed, trip } = await atDryRun();
    vi.useFakeTimers();
    helm.vote(seed.tripId, seed.maya.memberId, "LIS-W1-casa-alfama");
    expect(helm.trip(seed.tripId).autoPick).toBeNull();
    helm.vote(seed.tripId, seed.dev.memberId, "LIS-W1-casa-alfama");
    expect(helm.trip(seed.tripId).autoPick?.planId).toBe("LIS-W1-casa-alfama");
    expect(trip.at(-1)).toMatchObject({ ev: "plan:votes", p: { autoPick: { planId: "LIS-W1-casa-alfama" } } });
    await vi.advanceTimersByTimeAsync(20_100);
    vi.useRealTimers();
    for (let i = 0; i < 100 && helm.trip(seed.tripId).status !== "SEALING"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(helm.trip(seed.tripId).status).toBe("SEALING");
    expect(helm.trip(seed.tripId).chosenPlanId).toBe("LIS-W1-casa-alfama");
  });

  it("a split cancels the countdown, and the organizer picking first wins", async () => {
    const { helm, seed } = await atDryRun();
    vi.useFakeTimers();
    helm.vote(seed.tripId, seed.maya.memberId, "LIS-W1-casa-alfama");
    helm.vote(seed.tripId, seed.dev.memberId, "LIS-W1-casa-alfama");
    helm.vote(seed.tripId, seed.dev.memberId, "MEX-W1-roma-flat");
    expect(helm.trip(seed.tripId).autoPick).toBeNull();
    helm.vote(seed.tripId, seed.organizer.memberId, "LIS-W1-casa-alfama");
    expect(helm.trip(seed.tripId).autoPick?.planId).toBe("LIS-W1-casa-alfama");
    vi.useRealTimers();
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, "MEX-W1-roma-flat");
    expect(helm.trip(seed.tripId).chosenPlanId).toBe("MEX-W1-roma-flat");
    expect(helm.trip(seed.tripId).autoPick).toBeNull();
  });
});

describe("phase guards", () => {
  it("votes and picks only during the Dry Run; seals only while sealing", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    expect(await code(() => helm.vote(seed.tripId, seed.maya.memberId, "LIS-W1-casa-alfama"))).toBe("BAD_PHASE");
    expect(await code(() => helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama"))).toBe("BAD_PHASE");
    expect(await code(() => helm.setSeal(seed.tripId, seed.maya.memberId, "nope"))).toBe("BAD_PHASE");
    expect(await code(() => helm.hail(seed.tripId, seed.maya.memberId, "hi"))).toBe("CAPTAINS_CALLING");
  });
});
