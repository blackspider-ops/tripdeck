/**
 * WP-03 — live state & replay consistency: Watch progress, replayed booking outcome, event order around a
 * new booking, the shared Dry Run clock, my own vote, and the lean trip:state (ids only after the table).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import { PRIVATE_EVENTS } from "@all-ayes/shared";
import { TripService } from "../src/trips/service.js";
import { HelmError } from "../src/util/errors.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";

type Ev = { ev: string; p: any };

function helmWithBus(onTrip?: (helm: TripService, e: Ev) => void) {
  const helm = new TripService();
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const trip: Ev[] = [];
  const member: (Ev & { id: string })[] = [];
  helm.attachBus({
    trip: (_t, ev, p) => { trip.push({ ev, p }); onTrip?.(helm, { ev, p }); },
    member: (id, ev, p) => member.push({ id, ev, p }),
  });
  return { helm, trip, member };
}
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };
const until = async (ok: () => boolean) => { for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); expect(ok()).toBe(true); };
const replayOf = async (helm: TripService, tripId: string, memberId?: string) => {
  const got: Ev[] = [];
  await helm.replayer.replay(helm.trip(tripId), (ev, p) => got.push({ ev, p }), memberId);
  return got;
};

async function atDryRun(onTrip?: (helm: TripService, e: Ev) => void) {
  const x = helmWithBus(onTrip);
  const seed = await seedExpo(x.helm);
  await x.helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
  await until(() => x.helm.trip(seed.tripId).status === "DRY_RUN");
  return { ...x, seed };
}

afterEach(() => vi.useRealTimers());

describe("TR2-002 — Watch progress during the table", () => {
  it("each table:watch is reflected in trip:state (a reconnect mid-table sees it)", async () => {
    const seen: { watch: number; snapshot: number; replayed: number }[] = [];
    const { seed } = await atDryRun((helm, e) => {
      if (e.ev !== "table:watch") return;
      const t = [...helm.trips.values()][0];
      const replayed: Ev[] = [];
      void helm.replayer.replay(t, (ev, p) => replayed.push({ ev, p }));
      seen.push({ watch: e.p.watch, snapshot: helm.state(t).negotiation.watch, replayed: replayed.find((x) => x.ev === "trip:state")!.p.negotiation.watch });
    });
    expect(seed.tripId).toBeTruthy();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) { expect(s.snapshot).toBe(s.watch); expect(s.replayed).toBe(s.watch); }
  });
});

describe("OPT-042 — trip:state carries shortlist ids, not the plans", () => {
  it("ids only; table:decided precedes trip:state on replay", async () => {
    const { helm, trip, seed } = await atDryRun();
    const st = trip.filter((e) => e.ev === "trip:state").at(-1)!.p;
    expect(st.shortlist).toBeUndefined();
    expect(st.shortlistIds).toEqual(["MEX-W1-roma-flat", "LIS-W1-casa-alfama"]);
    expect(JSON.stringify(st).length).toBeLessThan(2500);
    // live: the bodies go first, then the snapshot
    const names = trip.map((e) => e.ev);
    expect(names.lastIndexOf("table:decided")).toBeLessThan(names.lastIndexOf("trip:state"));
    const got = (await replayOf(helm, seed.tripId)).map((e) => e.ev);
    expect(got.indexOf("table:decided")).toBeGreaterThanOrEqual(0);
    expect(got.indexOf("table:decided")).toBeLessThan(got.indexOf("trip:state"));
  });

  it("no ids (and no plans replayed) before the table has decided", async () => {
    const { helm } = helmWithBus();
    const seed = await seedExpo(helm);
    const got = await replayOf(helm, seed.tripId, seed.maya.memberId);
    expect(got.find((e) => e.ev === "trip:state")!.p.shortlistIds).toBeUndefined();
    expect(got.some((e) => e.ev === "table:decided")).toBe(false);
  });
});

describe("OPT-003 / OPT-002 — no redundant events", () => {
  it("joining and sealing a brief send only trip:state to the room", async () => {
    const { helm, trip } = helmWithBus();
    await seedExpo(helm);
    expect(trip.some((e) => e.ev === "member:joined" || e.ev === "brief:received")).toBe(false);
    expect(trip.filter((e) => e.ev === "trip:state").at(-1)!.p.crew.every((c: any) => c.briefSealed)).toBe(true);
  });
});

describe("TR1-015 — standing seals start after the booking is announced", () => {
  it("booking:created precedes every seal:status for that booking", async () => {
    const { helm, trip, seed } = await atDryRun();
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const created = trip.findIndex((e) => e.ev === "booking:created");
    const bookingId = trip[created].p.bookingId;
    const statuses = trip.map((e, i) => ({ ...e, i })).filter((e) => e.ev === "seal:status" && e.p.bookingId === bookingId);
    expect(statuses.length).toBeGreaterThan(0); // Dev's standing seal
    expect(statuses[0].p.memberId).toBe(seed.dev.memberId);
    for (const s of statuses) expect(s.i).toBeGreaterThan(created);
  });
});

describe("TR3-003 — the booking outcome survives a reload", () => {
  it("BOOKED: replay sends booking:result with the reference after booking:created", async () => {
    const { helm, seed } = await atDryRun();
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const t = helm.trip(seed.tripId);
    await helm.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
    await helm.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    await until(() => t.status === "BOOKED");
    const got = await replayOf(helm, seed.tripId);
    const names = got.map((e) => e.ev);
    expect(names.indexOf("booking:created")).toBeLessThan(names.indexOf("booking:result"));
    const res = got.find((e) => e.ev === "booking:result")!.p;
    expect(res).toMatchObject({ bookingId: t.bookingId, status: "CAPTURED" });
    expect(res.reference).toMatch(/^TD-LIS-/);
  });

  it("VOIDED: replay sends the same public reason; after 'back to the charts' the voided booking is gone from trip:state", async () => {
    const { helm, trip, seed } = await atDryRun();
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const t = helm.trip(seed.tripId);
    helm.cancelSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    await helm.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!); // S2-001: the void lands once every seal is set
    await until(() => t.status === "VOIDED");
    const live = trip.find((e) => e.ev === "booking:result")!.p;
    expect(live.publicReason).toBeTruthy();
    const res = (await replayOf(helm, seed.tripId, seed.organizer.memberId)).find((e) => e.ev === "booking:result")!.p;
    expect(res).toEqual({ bookingId: t.bookingId, status: "VOIDED", reference: undefined, publicReason: live.publicReason });

    helm.retry(seed.tripId, { memberId: seed.organizer.memberId });
    const st = trip.filter((e) => e.ev === "trip:state").at(-1)!.p;
    expect(st.status).toBe("DRY_RUN");
    expect(st.booking).toBeUndefined();
    expect(st.chosenPlanId).toBeUndefined();
    expect((await replayOf(helm, seed.tripId)).some((e) => e.ev === "booking:result")).toBe(false);
  });
});

describe("TR2-006 — Dry Run clock control", () => {
  it("a duplicate pause is not broadcast and doesn't move the clock; payload carries the server clock", async () => {
    const { helm, trip, seed } = await atDryRun();
    const org = { memberId: seed.organizer.memberId };
    helm.dryrunControl(seed.tripId, org, "pause");
    const first = trip.filter((e) => e.ev === "dryrun:control");
    expect(first).toHaveLength(1);
    expect(first[0].p).toMatchObject({ action: "pause", startedAt: expect.any(Number), pausedAt: expect.any(Number), serverNow: expect.any(Number) });
    await new Promise((r) => setTimeout(r, 20));
    helm.dryrunControl(seed.tripId, org, "pause");
    expect(trip.filter((e) => e.ev === "dryrun:control")).toHaveLength(1);
    const script = (await replayOf(helm, seed.tripId)).find((e) => e.ev === "dryrun:script")!.p;
    expect(script.pausedAt).toBe(first[0].p.pausedAt);
    helm.dryrunControl(seed.tripId, org, "resume");
    const resumed = trip.filter((e) => e.ev === "dryrun:control").at(-1)!.p;
    expect(resumed).toMatchObject({ action: "resume", pausedAt: null });
    expect(resumed.startedAt).toBeGreaterThan(first[0].p.startedAt);
    helm.dryrunControl(seed.tripId, org, "resume"); // already running: no-op
    expect(trip.filter((e) => e.ev === "dryrun:control")).toHaveLength(2);
  });

  it("is refused outside the Dry Run (BAD_PHASE), with nothing broadcast", async () => {
    const { helm, trip } = helmWithBus();
    const seed = await seedExpo(helm);
    expect(await code(() => helm.dryrunControl(seed.tripId, { memberId: seed.organizer.memberId }, "pause"))).toBe("BAD_PHASE");
    expect(trip.some((e) => e.ev === "dryrun:control")).toBe(false);
  });
});

describe("TR1-008 / TR1-009 — votes", () => {
  it("plan:votes and trip:state carry serverNow; my vote comes back privately on replay", async () => {
    const { helm, trip, member, seed } = await atDryRun();
    helm.vote(seed.tripId, seed.maya.memberId, "LIS-W1-casa-alfama");
    expect(trip.filter((e) => e.ev === "plan:votes").at(-1)!.p.serverNow).toBeTypeOf("number");
    expect(helm.state(helm.trip(seed.tripId)).serverNow).toBeTypeOf("number");
    // live echo to Maya's room only
    expect(member.filter((e) => e.ev === "plan:myVote")).toEqual([{ id: seed.maya.memberId, ev: "plan:myVote", p: { planId: "LIS-W1-casa-alfama" } }]);
    expect(trip.some((e) => e.ev === "plan:myVote")).toBe(false);
    expect(PRIVATE_EVENTS).toContain("plan:myVote");

    const mine = (await replayOf(helm, seed.tripId, seed.maya.memberId)).find((e) => e.ev === "plan:myVote")!.p;
    expect(mine).toEqual({ planId: "LIS-W1-casa-alfama" });
    expect((await replayOf(helm, seed.tripId, seed.organizer.memberId)).find((e) => e.ev === "plan:myVote")!.p).toEqual({ planId: null });
    // the room (headset / gallery) replay never includes it
    expect((await replayOf(helm, seed.tripId)).some((e) => e.ev === "plan:myVote")).toBe(false);
  });
});
