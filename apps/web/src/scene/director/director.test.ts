// O2-068: the SceneDirector's parts driven by a fake DirectorContext. The pieces they build (crew pieces, ribbons,
// the seal chart, cloches, cards) are mocked: these tests check the director logic, not the meshes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { BookingPublic, CrewPublic, PlanPublic, TripState, TripStatus, Turn } from "@all-ayes/shared";
import type { DirectorContext } from "./context";

const reg = vi.hoisted(() => ({
  pieces: [] as { id: string; dispose: () => void; isSealed: boolean }[],
  charts: [] as { args: unknown[]; pressSeal: (id: string, instant?: boolean) => Promise<void>; dispose: () => void }[],
  cloches: [] as { planId: string; lift: (up?: boolean) => Promise<void>; dispose: () => void }[],
  sounds: [] as string[],
}));

vi.mock("../CrewPiece", async () => {
  const T = await import("three");
  class CrewPiece {
    group = new T.Group();
    seat = new T.Vector3();
    isSealed = false;
    dispose = vi.fn(() => { this.group.removeFromParent(); });
    constructor(_tw: unknown, readonly id: string) { reg.pieces.push(this); }
    placeAt(v: THREE.Vector3) { this.seat.copy(v); return Promise.resolve(); }
    setSealed(v: boolean) { this.isSealed = v; }
    setFlagTier() { /* neighbours' flags at alternating heights */ }
    speak = vi.fn(async () => undefined); object = vi.fn(async () => undefined); concede = vi.fn(async () => undefined);
    settle = vi.fn(async () => undefined);
    frontPoint() { return new T.Vector3(); }
    update() { /* flags face the camera */ }
  }
  return { CrewPiece };
});
vi.mock("../audio", () => ({
  sound: { play: (s: string) => { reg.sounds.push(s); } },
  playVoiceAt: vi.fn(), speakFallback: vi.fn(),
}));
vi.mock("../Ribbon", async () => {
  const T = await import("three");
  class InkRibbon { group = new T.Group(); placeNear() { /* */ } unroll() { return Promise.resolve(); } rollUp() { return Promise.resolve(); } dispose() { /* */ } }
  return { InkRibbon };
});
vi.mock("../Globe", () => ({ HOME_PORT: { id: "home", name: "Home", lat: 0, lng: 0 } }));
vi.mock("../SealChart", async () => {
  const T = await import("three");
  class SealChart {
    group = new T.Group();
    args: unknown[];
    pressSeal = vi.fn(async () => undefined);
    setStanding = vi.fn();
    dispose = vi.fn();
    constructor(...args: unknown[]) { this.args = args; reg.charts.push(this); }
    unroll() { return Promise.resolve(); }
    tie() { return Promise.resolve(); }
    voidAll() { return Promise.resolve(); }
  }
  return { SealChart };
});
vi.mock("../DryRun", async () => {
  const T = await import("three");
  class DryRunCloche {
    group = new T.Group();
    dome = new T.Object3D();
    planId: string;
    lift = vi.fn(async () => undefined);
    slideOut = vi.fn(async () => undefined);
    slideBack = vi.fn(async () => undefined);
    setVotes = vi.fn();
    update = vi.fn();
    dispose = vi.fn();
    constructor(_tw: unknown, plan: { planId: string }) { this.planId = plan.planId; reg.cloches.push(this); }
  }
  return { DryRunCloche, CITY_R: 0.115 };
});
vi.mock("../CityTiles", () => ({ tilesAvailable: () => false, CityTiles: class { dispose() { /* */ } update() { /* */ } } }));
vi.mock("../Buttons", async () => {
  const T = await import("three");
  class PaperMenu {
    group = new T.Group();
    constructor(_tw: unknown, _title: string, private items: { onSelect: () => void }[]) {}
    interactables(enabled: () => boolean) { return this.items.map((it) => ({ object: new T.Object3D(), onSelect: it.onSelect, enabled })); }
  }
  return { PaperMenu };
});

import { Tweens } from "../tween";
import { CrewSeating } from "./CrewSeating";
import { SealCeremony } from "./SealCeremony";
import { TurnPlayer } from "./TurnPlayer";
import { PhaseController } from "./PhaseController";

beforeEach(() => { reg.pieces.length = 0; reg.charts.length = 0; reg.cloches.length = 0; reg.sounds.length = 0; });

// ---------------------------------------------------------------- fixtures

const member = (memberId: string, band = 1, briefSealed = false): CrewPublic => ({ memberId, name: memberId, role: "member", band: band as 1, briefSealed });
const CREW = [member("rae", 1, true), member("maya", 2, true), member("dev", 3, true)];
const plan = (planId: string, cityId: string): PlanPublic => ({ planId, cityId, cityName: cityId, hotelName: "H", neighborhood: "N", hotelId: "h", hotelLat: 0, hotelLng: 0, dateWindowId: "w1", days: [] } as unknown as PlanPublic);
const trip = (status: TripStatus, extra: Partial<TripState> = {}): TripState => ({
  tripId: "T", joinCode: "J", name: "Voyage", status, version: 1, organizerId: "rae", crew: CREW,
  candidateCities: [], dateWindows: [{ id: "w1", start: "2026-05-01", end: "2026-05-05", nights: 4 }],
  negotiation: { watch: 1, running: false }, paymentsMode: "sim", serverNow: 0, ...extra,
});
let seq = 0;
const turn = (over: Partial<Turn> = {}): Turn => ({
  turnId: `t${++seq}`, tripId: "T", seq, watch: 1, speaker: { kind: "captain" }, act: "PROPOSE", cityId: "LIS",
  text: "Lisbon fits everyone", ribbon: "Lisbon", voiced: false, redactions: 0, createdAt: "", ...over,
});
const booking = (bookingId: string, seals: BookingPublic["seals"]): BookingPublic => ({ bookingId, planId: "p1", attempt: 1, status: "PENDING", mode: "sim", seals });

function fakeCtx(state: Record<string, unknown> = {}) {
  const queue: (() => Promise<void> | void)[] = [];
  const raw = {
    store: { state: { trip: trip("AT_TABLE"), shortlist: [] as PlanPublic[], booking: null, audio: {}, lastResult: null, ...state }, emit: vi.fn(), dryrunMinute: () => null as number | null },
    opts: { controls: true, voices: false, speechFallback: false },
    renderer: {},
    root: new THREE.Group(),
    tweens: new Tweens(),
    globe: { turnToPin: vi.fn(async () => undefined), drawArc: vi.fn(), circle: vi.fn(), eraseArcs: vi.fn(), stow: vi.fn(async () => undefined), inkAllArcs: vi.fn() },
    compass: { snapNorth: vi.fn() },
    captain: { group: new THREE.Group(), speak: vi.fn(async () => undefined), settle: vi.fn(async () => undefined) },
    clock: { group: new THREE.Group(), setMinute: vi.fn() },
    isResume: vi.fn(() => false),
    enqueue: (fn: () => Promise<void> | void) => { queue.push(fn); },
    caption: vi.fn(), speaking: vi.fn(), targetsChanged: vi.fn(),
  };
  const drain = async () => { while (queue.length) await queue.shift()!(); };
  return { ctx: raw as unknown as DirectorContext, raw, queue, drain };
}

// ---------------------------------------------------------------- CrewSeating

describe("CrewSeating", () => {
  it("a member leaving the roster has their piece disposed and forgotten (O2-050); the others stay", () => {
    const { ctx, raw } = fakeCtx();
    const seating = new CrewSeating(ctx);
    seating.sync([...CREW], "rae", true);
    expect(reg.pieces.map((p) => p.id)).toEqual(["rae", "maya", "dev"]);
    expect(raw.root.children).toHaveLength(3);
    seating.sync([CREW[0], CREW[2]], "rae", true);
    expect(reg.pieces.map((p) => (p.dispose as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([0, 1, 0]);
    expect(raw.root.children).toHaveLength(2);
    // rejoining makes a new piece, not the disposed one
    seating.sync([...CREW], "rae", true);
    expect(reg.pieces).toHaveLength(4);
    expect(reg.pieces[3].id).toBe("maya");
  });

  it("the same crew array is a no-op; sealing flags follow briefSealed", () => {
    const { ctx } = fakeCtx();
    const seating = new CrewSeating(ctx);
    const crew = [member("rae"), member("maya", 2)];
    seating.sync(crew, "rae", true);
    seating.sync(crew, "rae", true);
    expect(reg.pieces).toHaveLength(2);
    expect(reg.pieces.every((p) => !p.isSealed)).toBe(true);
    seating.sync([member("rae", 1, true), member("maya", 2)], "rae", false);
    expect(reg.pieces.map((p) => p.isSealed)).toEqual([true, false]);
    seating.sync([member("rae", 1, false), member("maya", 2)], "rae", true);
    expect(reg.pieces[0].isSealed).toBe(false);
  });

  it("speakerPosition: the captain's head, a seated member's head, or null for an unknown voyage", () => {
    const { ctx, raw } = fakeCtx({ trip: null });
    const seating = new CrewSeating(ctx);
    expect(seating.speakerPosition({ speaker: { kind: "captain" } })!.y).toBeCloseTo(0.08);
    expect(seating.speakerPosition({ speaker: { kind: "advocate", memberId: "ghost" } })).toBeNull();
    seating.sync([...CREW], "rae", true);
    expect(seating.speakerPosition({ speaker: { kind: "advocate", memberId: "maya" } })!.y).toBeCloseTo(0.06);
    seating.dispose();
    expect(raw.root.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- SealCeremony

describe("SealCeremony", () => {
  const shortlist = [plan("p1", "LIS"), plan("p2", "MEX")];

  it("fmtWindow: the chosen chart's window as 'May 1–5'", () => {
    const { ctx } = fakeCtx({ shortlist });
    new SealCeremony(ctx).openChart(trip("SEALING", { chosenPlanId: "p2" }), true);
    expect(reg.charts[0].args[1]).toBe(shortlist[1]);
    expect(reg.charts[0].args[3]).toBe("May 1–5");
  });

  it("fmtWindow: an unknown window is blank; a window across a month end names both months, like the phone", () => {
    const { ctx } = fakeCtx({ shortlist: [{ ...shortlist[0], dateWindowId: "nope" }] });
    new SealCeremony(ctx).openChart(trip("SEALING"), true);
    expect(reg.charts[0].args[3]).toBe("");
    const { ctx: ctx2 } = fakeCtx({ shortlist });
    new SealCeremony(ctx2).openChart(trip("SEALING", { dateWindows: [{ id: "w1", start: "2026-05-29", end: "2026-06-02", nights: 4 }] }), true);
    expect(reg.charts[1].args[3]).toBe("May 29–Jun 2");
  });

  it("presses each member's seal once per booking, whatever the status churn; a new attempt presses again", async () => {
    const { ctx, queue, drain } = fakeCtx({ shortlist });
    const sc = new SealCeremony(ctx);
    sc.openChart(trip("SEALING"), true);
    const chart = reg.charts[0];
    sc.sync(booking("b1", [{ memberId: "rae", status: "AUTHORIZED" }, { memberId: "maya", status: "PENDING" }]), false);
    sc.sync(booking("b1", [{ memberId: "rae", status: "AUTHORIZED" }, { memberId: "maya", status: "AUTHORIZED" }]), false);
    sc.sync(booking("b1", [{ memberId: "rae", status: "CAPTURED" }, { memberId: "maya", status: "CAPTURED" }]), false);
    expect(queue).toHaveLength(2);
    await drain();
    expect((chart.pressSeal as ReturnType<typeof vi.fn>).mock.calls).toEqual([["rae"], ["maya"]]);
    sc.sync(booking("b2", [{ memberId: "rae", status: "AUTHORIZED" }]), true); // instant: pressed at once, not queued
    expect(queue).toHaveLength(0);
    expect((chart.pressSeal as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual(["rae", true]);
  });

  it("on resume seals are pressed at once; clear() forgets what was pressed", () => {
    const { ctx, raw, queue } = fakeCtx({ shortlist });
    raw.isResume.mockReturnValue(true);
    const sc = new SealCeremony(ctx);
    sc.openChart(trip("SEALING"), true);
    sc.sync(booking("b1", [{ memberId: "rae", status: "AUTHORIZED" }]), false);
    expect(queue).toHaveLength(0);
    expect(reg.charts[0].pressSeal).toHaveBeenCalledWith("rae", true);
    sc.clear();
    expect(reg.charts[0].dispose).toHaveBeenCalled();
    expect(sc.open).toBe(false);
    sc.sync(booking("b1", [{ memberId: "rae", status: "AUTHORIZED" }]), false); // no chart: nothing
    expect(queue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- TurnPlayer

describe("TurnPlayer", () => {
  it("a resumed burst is applied instantly: no poses or sounds, last speaker wins, turns seen once", () => {
    const { ctx, raw } = fakeCtx();
    const tp = new TurnPlayer(ctx, new CrewSeating(ctx));
    const turns = [turn(), turn({ act: "DECIDE", cityId: undefined })];
    tp.sync(turns, trip("AT_TABLE"), true);
    tp.sync(turns, trip("AT_TABLE"), true);
    expect(raw.speaking).toHaveBeenCalledTimes(2);
    expect(raw.speaking.mock.calls.at(-1)![0]).toBe(turns[1]);
    expect(raw.captain.speak).not.toHaveBeenCalled();
    expect(reg.sounds).toEqual([]);
    expect(raw.globe.turnToPin).toHaveBeenCalledWith("LIS", true);
    expect(raw.globe.drawArc).toHaveBeenCalledWith("home", "LIS", "pencil", true);
    expect(raw.compass.snapNorth).toHaveBeenCalledWith(true);
  });

  it("past the table, a resumed line doesn't take over the phase caption", () => {
    const { ctx, raw } = fakeCtx();
    new TurnPlayer(ctx, new CrewSeating(ctx)).sync([turn()], trip("DRY_RUN"), true);
    expect(raw.caption).not.toHaveBeenCalled();
  });

  it("more than MAX_BACKLOG (2) lines waiting: the oldest are applied silently until the backlog is 2, then they animate", async () => {
    const { ctx, raw, queue } = fakeCtx();
    const tp = new TurnPlayer(ctx, new CrewSeating(ctx));
    const turns = [turn(), turn(), turn(), turn()];
    tp.sync(turns, trip("AT_TABLE"), false);
    expect(queue).toHaveLength(4);
    await queue.shift()!(); // backlog 4 → silent
    await queue.shift()!(); // backlog 3 → silent
    expect(raw.captain.speak).not.toHaveBeenCalled();
    expect(raw.speaking.mock.calls.map((c) => c[0])).toEqual([turns[0], turns[1]]);
    const third = queue.shift()!(); // backlog 2 → animated (voice/reading pause)
    expect(raw.captain.speak).toHaveBeenCalledOnce();
    expect(reg.sounds).toContain("click");
    raw.tweens.update(10); // the reading pause
    await third;
    expect(raw.captain.settle).toHaveBeenCalledOnce();
    const fourth = queue.shift()!();
    expect(raw.captain.speak).toHaveBeenCalledTimes(2);
    raw.tweens.update(10);
    await fourth;
    expect(raw.speaking.mock.calls.map((c) => c[0])).toEqual(turns);
  });

  it("markShortlist circles the Two Charts' cities and keeps only their arcs; nothing before the shortlist", () => {
    const { ctx, raw } = fakeCtx();
    const tp = new TurnPlayer(ctx, new CrewSeating(ctx));
    tp.markShortlist();
    expect(raw.globe.circle).not.toHaveBeenCalled();
    raw.store.state.shortlist = [plan("p1", "LIS"), plan("p2", "MEX")];
    tp.markShortlist();
    expect(raw.globe.circle).toHaveBeenCalledWith(["LIS", "MEX"]);
    const keep = raw.globe.eraseArcs.mock.calls[0][0] as (k: string) => boolean;
    expect([keep("home>LIS"), keep("home>MEX"), keep("home>CDMX")]).toEqual([false, false, true]); // erase predicate
  });
});

// ---------------------------------------------------------------- PhaseController

describe("PhaseController", () => {
  const shortlist = [plan("p1", "LIS"), plan("p2", "MEX"), plan("p3", "CDMX")];

  function setup(status: TripStatus = "AT_TABLE") {
    const f = fakeCtx({ shortlist, trip: trip(status) });
    const turns = { markShortlist: vi.fn() };
    const pc = new PhaseController(f.ctx, turns as unknown as TurnPlayer);
    return { ...f, pc, turns };
  }
  const go = async (s: ReturnType<typeof setup>, t: TripState) => {
    s.raw.store.state.trip = t;
    s.pc.sync(t, true, false);
    await s.drain();
  };

  it("a status is choreographed once; a repeated sync of the same status queues nothing", async () => {
    const s = setup();
    s.pc.sync(trip("AT_TABLE"), true, false);
    expect(s.queue).toHaveLength(1); // AT_TABLE with lines: the caption waits for them
    s.pc.sync(trip("AT_TABLE"), true, false);
    expect(s.queue).toHaveLength(1);
    await s.drain();
  });

  it("DRY_RUN builds two cloches (the Two Charts), shows the clock and rings the shortlist; SEALING clears them and opens the seal chart", async () => {
    const s = setup();
    await go(s, trip("AT_TABLE"));
    await go(s, trip("DRY_RUN"));
    expect(reg.cloches.map((c) => c.planId)).toEqual(["p1", "p2"]);
    expect(s.turns.markShortlist).toHaveBeenCalled();
    expect(s.raw.clock.group.visible).toBe(true);
    expect(s.raw.targetsChanged).toHaveBeenCalled();
    expect(s.raw.caption).toHaveBeenLastCalledWith(expect.any(String), "Two charts. Watch them run dry, then pick one.", expect.any(String));
    await go(s, trip("SEALING", { chosenPlanId: "p2" }));
    expect(reg.cloches[1].lift).toHaveBeenCalled();
    expect(reg.cloches.every((c) => (c.dispose as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
    expect(s.raw.clock.group.visible).toBe(false);
    expect(s.raw.globe.stow).toHaveBeenLastCalledWith(true, false);
    expect(reg.charts).toHaveLength(1);
    expect(reg.charts[0].args[1]).toBe(shortlist[1]);
  });

  it("a seat's headset (canVote): one pinch on a cloche votes for it (plan:vote), lifts nothing; a refusal is captioned", async () => {
    const s = setup();
    (s.raw.opts as { canVote?: () => boolean }).canVote = () => true;
    await go(s, trip("DRY_RUN"));
    const [, , c2] = s.pc.targets(true, () => "DRY_RUN");
    c2.onSelect();
    const call = s.raw.store.emit.mock.calls.at(-1) as unknown as [string, unknown, (r: unknown) => void];
    expect(call[0]).toBe("plan:vote");
    expect(call[1]).toEqual({ planId: "p2" });
    expect(s.raw.store.emit).not.toHaveBeenCalledWith("plan:pick", expect.anything());
    expect(reg.cloches.every((c) => !(c.lift as ReturnType<typeof vi.fn>).mock.calls.some((a) => a[0] === true))).toBe(true);
    call[2]({ ok: false, code: "X", message: "Voting has closed." });
    expect(s.raw.caption).toHaveBeenCalledWith("Chart", "Voting has closed.", expect.any(String));
  });

  it("picking a cloche lifts it and emits plan:pick; cancelPick lowers them once (the helm refused)", async () => {
    const s = setup();
    await go(s, trip("DRY_RUN"));
    const targets = s.pc.targets(true, () => "DRY_RUN");
    const [back, c1, c2] = targets;
    expect(back.enabled!()).toBe(false); // the void card is hidden
    expect(c1.enabled!()).toBe(true);
    c2.onSelect();
    expect(s.raw.store.emit).toHaveBeenCalledWith("plan:pick", { planId: "p2" });
    expect(reg.cloches[0].lift).toHaveBeenLastCalledWith(false);
    expect(reg.cloches[1].lift).toHaveBeenLastCalledWith(true);
    s.pc.cancelPick();
    expect(reg.cloches.map((c) => (c.lift as ReturnType<typeof vi.fn>).mock.calls.at(-1))).toEqual([[false], [false]]);
    const calls = reg.cloches.map((c) => (c.lift as ReturnType<typeof vi.fn>).mock.calls.length);
    s.pc.cancelPick(); // nothing pending: no-op
    expect(reg.cloches.map((c) => (c.lift as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual(calls);
    // the Gallery (no controls) and any other phase can't pick
    expect(s.pc.targets(false, () => "DRY_RUN")[1].enabled!()).toBe(false);
    expect(s.pc.targets(true, () => "SEALING")[1].enabled!()).toBe(false);
  });

  it("VOIDED shows 'Back to the charts' to a device with controls; selecting it emits booking:retry; a new meeting clears the globe", async () => {
    const s = setup();
    await go(s, trip("DRY_RUN"));
    await go(s, trip("SEALING", { chosenPlanId: "p1" }));
    await go(s, trip("VOIDED", { chosenPlanId: "p1" }));
    const back = s.pc.targets(true, () => "VOIDED")[0];
    expect(back.enabled!()).toBe(true);
    back.onSelect();
    expect(s.raw.store.emit).toHaveBeenCalledWith("booking:retry", {});
    await go(s, trip("BRIEFING"));
    expect(back.enabled!()).toBe(false);
    expect(s.raw.globe.circle).toHaveBeenLastCalledWith([]);
    expect(s.raw.globe.eraseArcs).toHaveBeenCalled();
    expect(reg.charts[0].dispose).toHaveBeenCalled();
  });

  it("leaving the Dry Run disposes the cloches; coming back builds fresh ones", async () => {
    const s = setup();
    await go(s, trip("DRY_RUN"));
    s.pc.cancelPick();
    await go(s, trip("AT_TABLE"));
    expect(reg.cloches.every((c) => (c.dispose as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
    await go(s, trip("DRY_RUN"));
    expect(reg.cloches).toHaveLength(4);
  });

  it("'Back to the charts' with the same shortlist (VOIDED → DRY_RUN): the old cloches were disposed once at SEALING; two fresh ones are built, none leaked", async () => {
    const s = setup();
    await go(s, trip("DRY_RUN"));
    const first = [...reg.cloches];
    await go(s, trip("SEALING", { chosenPlanId: "p1" }));
    await go(s, trip("VOIDED", { chosenPlanId: "p1" }));
    await go(s, trip("DRY_RUN"));
    expect(reg.cloches.map((c) => c.planId)).toEqual(["p1", "p2", "p1", "p2"]);
    expect(first.every((c) => (c.dispose as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
    expect(reg.cloches.slice(2).every((c) => (c.dispose as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true);
    expect(s.pc.targets(true, () => "DRY_RUN")).toHaveLength(3); // the void card + the two live cloches
    expect(s.raw.clock.group.visible).toBe(true);
    expect(reg.sounds.filter((x) => x === "clink")).toHaveLength(2);
  });
});
