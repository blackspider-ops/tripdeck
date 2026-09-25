/**
 * R2-WP-10 — identity, seats & crew races: a brief racing "sail without them" (L4-003), who may reopen the terms after
 * a void (L4-002) and what a rejoin then replays (L3-006), the "invite opened" flag (L1-009) and the organizer's seat
 * reset (S2-012 minimum / S2-009 recovery). Passkey claims over HTTP are in passkeys.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

import type { BriefInput, CrewPublic, Tag } from "@all-ayes/shared";
import { TripService } from "../src/trips/service.js";
import { type HelmError } from "../src/util/errors.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";
import { newToken } from "../src/util/ids.js";
import { consumeAssertion, holdsPasskeyClaim, mintAssertion, mintPasskeyClaim } from "../src/passkeys/passkeys.js";

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean) => { for (let i = 0; i < 600 && !pred(); i++) await settle(); };
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as HelmError).code; } return "OK"; };
const BRIEF = (capCents: number, mustHaves: Tag[]): BriefInput => ({ capCents, dateWindowIds: ["W1"], mustHaves, dealbreakers: [] });

function helm() {
  const h = new TripService();
  const sim = (h.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  const trip: { ev: string; p: any }[] = [];
  const evicted: string[] = [];
  h.attachBus({ trip: (_t, ev, p) => trip.push({ ev, p }), member: () => {}, evict: (id) => evicted.push(id) });
  return { h, trip, evicted };
}
const lastCrew = (trip: { ev: string; p: any }[]) => trip.filter((e) => e.ev === "trip:state").at(-1)!.p.crew as CrewPublic[];

/** The Expo voyage, met, picked and called off: VOIDED with the Two Charts on file. */
async function voided(h: TripService) {
  const seed = await seedExpo(h);
  const rae = { memberId: seed.organizer.memberId };
  await h.startTable(seed.tripId, rae);
  await until(() => h.trip(seed.tripId).status === "DRY_RUN");
  const t = h.trip(seed.tripId);
  await h.pick(seed.tripId, rae, t.shortlistIds![0]);
  await h.callOff(seed.tripId, rae);
  await until(() => t.status === "VOIDED");
  expect(t.status).toBe("VOIDED");
  return { seed, rae, t };
}

afterEach(() => vi.useRealTimers());

describe("L4-003: 'sail without them' during an absent friend's in-flight brief", () => {
  it("the brief is refused NOT_MEMBER; no standing instruction, brief or seal outlives the released seat", async () => {
    const { h } = helm();
    const { trip, member: rae } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    h.join(trip._id, { name: "Maya", band: 2, origin: "ORD" });
    const inv = h.addAbsent(trip._id, { memberId: rae._id }, { name: "Dev", band: 3, origin: "JFK" });
    h.claimAbsent(trip._id, inv.memberId, inv.inviteKey, newToken());
    const brief = code(() => h.submitBrief(trip._id, inv.memberId, BRIEF(140_000, ["food"]))); // awaits the provider
    h.sailWithout(trip._id, { memberId: rae._id }, [inv.memberId]);
    expect(await brief).toBe("NOT_MEMBER");
    const dev = h.members.get(inv.memberId)!;
    expect(h.trip(trip._id).removedMemberIds).toEqual([inv.memberId]);
    expect(h.payments.standing.has(inv.memberId)).toBe(false);
    expect(h.briefs.has(inv.memberId)).toBe(false);
    expect(dev.briefSealed).toBe(false);
    expect(dev.standing).toBeUndefined();
  });
});

describe("L4-002 (decision b) / L3-006: reopening the terms after a void", () => {
  it("a member's re-seal in VOIDED is refused and keeps the Two Charts: the organizer can still go back to the charts", async () => {
    const { h } = helm();
    const { seed, rae, t } = await voided(h);
    const charts = t.shortlistIds;
    const before = h.briefs.get(seed.maya.memberId)!.capCents;
    expect(await code(() => h.submitBrief(seed.tripId, seed.maya.memberId, BRIEF(80_000, ["beach"])))).toBe("BAD_PHASE");
    // an absent friend with a claimed link can't do it either (and their standing instruction is left as it was)
    const standing = h.payments.standing.get(seed.dev.memberId);
    expect(await code(() => h.submitBrief(seed.tripId, seed.dev.memberId, BRIEF(90_000, ["food"])))).toBe("BAD_PHASE");
    expect(h.payments.standing.get(seed.dev.memberId)).toBe(standing);
    expect(t.status).toBe("VOIDED");
    expect(t.shortlistIds).toEqual(charts);
    expect(h.briefs.get(seed.maya.memberId)!.capCents).toBe(before);
    h.retry(seed.tripId, rae); // "back to the charts" still works
    expect(t.status).toBe("DRY_RUN");
  }, 15_000);

  it("the organizer's new terms reopen the briefing as a new round: a rejoin replays no turn of the voided meeting", async () => {
    const { h } = helm();
    const { seed, t } = await voided(h);
    expect(t.negotiation.turns.length).toBeGreaterThan(0);
    const round = t.negotiation.round ?? 0;
    await h.submitBrief(seed.tripId, seed.organizer.memberId, BRIEF(120_000, ["food"]));
    expect(t.status).toBe("BRIEFING");
    expect(t.shortlistIds).toBeUndefined();
    expect(t.negotiation.round).toBe(round + 1);
    const sent: string[] = [];
    await h.replayer.replay(t, (ev) => { sent.push(ev); }, seed.maya.memberId);
    expect(sent).toContain("trip:state");
    expect(sent).not.toContain("turn:new");
    expect(sent).not.toContain("turn:audioReady");
    // and now anyone may adjust their terms again
    await h.submitBrief(seed.tripId, seed.maya.memberId, BRIEF(80_000, ["beach"]));
    expect(h.briefs.get(seed.maya.memberId)!.capCents).toBe(80_000);
  }, 15_000);
});

describe("L1-009 / S2-012: everyone sees when an invite is opened", () => {
  it("an absent seat is 'not opened' from the start, 'opened' for the whole crew once claimed; a spent link isn't reissued", async () => {
    const { h, trip: room } = helm();
    const { trip, member: rae } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const maya = h.join(trip._id, { name: "Maya", band: 2, origin: "ORD" });
    const inv = h.addAbsent(trip._id, { memberId: rae._id }, { name: "Dev", band: 3, origin: "JFK" });
    // the broadcast that first shows the seat already says "not opened"
    const first = room.filter((e) => e.ev === "trip:state").map((e) => (e.p.crew as CrewPublic[]).find((c) => c.memberId === inv.memberId)).filter(Boolean);
    expect(first.every((c) => c!.inviteOpen === false)).toBe(true);
    expect(lastCrew(room).find((c) => c.memberId === maya.member._id)).not.toHaveProperty("inviteOpen");
    expect(h.tripByCode(trip.joinCode) && h.crewPublic(trip).find((c) => c.memberId === rae._id)).not.toHaveProperty("inviteOpen");
    h.claimAbsent(trip._id, inv.memberId, inv.inviteKey, newToken());
    expect(lastCrew(room).find((c) => c.memberId === inv.memberId)!.inviteOpen).toBe(true);
    expect(await code(() => h.reissueInvite(trip._id, { memberId: rae._id }, inv.memberId))).toBe("INVITE_CLAIMED");
  });

  it("the organizer can reset a seat that was taken: its token, sockets and passkeys are revoked, and only the new link claims it", async () => {
    const { h, trip: room, evicted } = helm();
    const { trip, member: rae, token: raeToken } = h.createTrip({ name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const maya = h.join(trip._id, { name: "Maya", band: 2, origin: "ORD" });
    const inv = h.addAbsent(trip._id, { memberId: rae._id }, { name: "Dev", band: 3, origin: "JFK" });
    const taken = h.claimAbsent(trip._id, inv.memberId, inv.inviteKey); // not Dev (no crew key: the organizer's trick)
    mintPasskeyClaim(inv.memberId);
    const tok = mintAssertion({ memberId: inv.memberId, bookingId: "b", rpID: "localhost", credentialId: "c" });

    // only the organizer, never their own seat
    expect(await code(() => h.crew.resetSeat(trip._id, { token: maya.token }, inv.memberId))).toBe("NOT_ORGANIZER");
    expect(await code(() => h.crew.resetSeat(trip._id, { token: raeToken }, rae._id))).toBe("NOT_FOUND");
    const again = h.crew.resetSeat(trip._id, { token: raeToken }, inv.memberId);
    expect(h.memberByToken(trip._id, taken.memberToken)).toBeFalsy(); // the taker's token is dead
    expect(evicted).toContain(inv.memberId);
    expect(holdsPasskeyClaim(inv.memberId, "anything")).toBe(false);
    expect(consumeAssertion(inv.memberId, "b", tok)).toBeNull();
    expect(lastCrew(room).find((c) => c.memberId === inv.memberId)!.inviteOpen).toBe(false);
    expect(await code(() => h.claimAbsent(trip._id, inv.memberId, inv.inviteKey))).toBe("BAD_INVITE"); // the old link stays dead
    const dev = h.claimAbsent(trip._id, inv.memberId, again.inviteKey, newToken());
    expect(h.memberByToken(trip._id, dev.memberToken)?._id).toBe(inv.memberId);
    expect(lastCrew(room).find((c) => c.memberId === inv.memberId)!.inviteOpen).toBe(true);

    // a member who joined by code can be reset too; their new link claims the seat, and they show as invited
    const m2 = h.crew.resetSeat(trip._id, { memberId: rae._id }, maya.member._id);
    expect(h.memberByToken(trip._id, maya.token)).toBeFalsy();
    expect(lastCrew(room).find((c) => c.memberId === maya.member._id)!.inviteOpen).toBe(false);
    expect(h.reissueInvite(trip._id, { memberId: rae._id }, maya.member._id).memberId).toBe(maya.member._id); // a fresh link
    expect(await code(() => h.claimAbsent(trip._id, maya.member._id, m2.inviteKey))).toBe("BAD_INVITE"); // the reissue retired it
  });

  it("a seat can't be reset while the table meets or the voyage heads for money", async () => {
    const { h } = helm();
    const seed = await seedExpo(h);
    const rae = { memberId: seed.organizer.memberId };
    await h.startTable(seed.tripId, rae);
    expect(await code(() => h.crew.resetSeat(seed.tripId, rae, seed.maya.memberId))).toBe("BAD_PHASE");
    await until(() => h.trip(seed.tripId).status === "DRY_RUN");
    expect(await code(() => h.crew.resetSeat(seed.tripId, rae, seed.maya.memberId))).toBe("BAD_PHASE");
    expect(h.memberByToken(seed.tripId, seed.maya.memberToken)?._id).toBe(seed.maya.memberId); // untouched
  }, 15_000);
});
