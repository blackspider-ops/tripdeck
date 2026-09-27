// O2-068 / OPT-051: the SceneDirector reacts only when a slice it watches changes (trip, turns, votes, booking,
// error), and a refusal undoes an optimistic pick. Its parts and pieces are mocked; the store is a fake.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TripState } from "@all-ayes/shared";

const parts = vi.hoisted(() => ({
  crewSync: vi.fn(), turnsSync: vi.fn(), phasesSync: vi.fn(), setVotes: vi.fn(), syncBooking: vi.fn(), cancelPick: vi.fn(),
  setPins: vi.fn(), setOrigins: vi.fn(), setWatch: vi.fn(), captionSet: vi.fn(), showTag: vi.fn(),
}));

vi.mock("./ChartTable", async () => {
  const T = await import("three");
  return { ChartTable: class { group = new T.Group(); caption = { set: parts.captionSet }; }, COMPASS_POS: new T.Vector3() };
});
vi.mock("./Globe", async () => {
  const T = await import("three");
  return { HOME_PORT: { id: "home" }, Globe: class { group = new T.Group(); setPins = parts.setPins; setOrigins = parts.setOrigins; update() { /* */ } } };
});
vi.mock("./CrewPiece", async () => {
  const T = await import("three");
  return { CaptainPiece: class { group = new T.Group(); tagVisible = false; rise() { return Promise.resolve(); } showTag = parts.showTag; update() { /* */ } } };
});
vi.mock("./Instruments", async () => {
  const T = await import("three");
  return {
    CompassTimer: class { group = new T.Group(); setWatch = parts.setWatch; },
    CarriageClock: class { group = new T.Group(); hit = new T.Object3D(); onHour?: () => void; },
  };
});
vi.mock("./audio", () => ({ sound: { play: () => undefined } }));
vi.mock("./director/CrewSeating", () => ({ CrewSeating: class { sync = parts.crewSync; setSpread() { /* */ } update() { /* */ } dispose() { /* */ } } }));
vi.mock("./director/TurnPlayer", () => ({ TurnPlayer: class { sync = parts.turnsSync; dispose() { /* */ } } }));
vi.mock("./director/PhaseController", () => ({
  PhaseController: class {
    sync = parts.phasesSync; setVotes = parts.setVotes; syncBooking = parts.syncBooking; cancelPick = parts.cancelPick;
    targets() { return []; } update() { /* */ } dispose() { /* */ }
  },
}));

import { SceneDirector } from "./SceneDirector";
import { Tweens } from "./tween";
import type { TripStore } from "../net/tripStore";
import type * as THREE from "three";

const trip = (over: Partial<TripState> = {}): TripState => ({
  tripId: "T", joinCode: "J", name: "V", status: "AT_TABLE", version: 1, organizerId: "rae",
  crew: [{ memberId: "rae", name: "rae", role: "organizer", band: 1, briefSealed: true }],
  candidateCities: [], dateWindows: [], negotiation: { watch: 1, running: true }, paymentsMode: "sim", serverNow: 0, ...over,
});

function fakeStore(state: Record<string, unknown>) {
  const subs = new Set<() => void>();
  const store = {
    state: { trip: trip(), turns: [], votes: {}, booking: null, error: null, audio: {}, shortlist: [], ...state } as Record<string, unknown>,
    subscribe: (fn: () => void) => { subs.add(fn); return () => subs.delete(fn); },
    emit: vi.fn(), clearError: vi.fn(),
    set(patch: Record<string, unknown>) { this.state = { ...this.state, ...patch }; for (const f of subs) f(); },
  };
  return store;
}

beforeEach(() => { for (const f of Object.values(parts)) f.mockClear(); });

const make = (store: ReturnType<typeof fakeStore>, controls = true) =>
  new SceneDirector(store as unknown as TripStore, { controls, voices: false, speechFallback: false }, {} as THREE.WebGLRenderer, new Tweens());

describe("SceneDirector.unchanged (OPT-051)", () => {
  it("syncs on the first snapshot, then ignores changes to slices it doesn't watch", () => {
    const store = fakeStore({});
    const d = make(store);
    expect(parts.crewSync).toHaveBeenCalledOnce();
    store.set({ audio: { t1: { audioUrl: "/a.mp3" } } }); // turn:audioReady
    store.set({ connection: "reconnecting" });
    store.set({ myVote: "p1" }); // private events
    expect(parts.crewSync).toHaveBeenCalledOnce();
    expect(parts.turnsSync).toHaveBeenCalledOnce();
    d.dispose();
  });

  it("each watched slice (trip, turns, votes, booking, error) triggers a sync when its reference changes", () => {
    const store = fakeStore({});
    const d = make(store);
    const patches = [{ trip: trip({ version: 2 }) }, { turns: [] }, { votes: { p1: 1 } }, { booking: null }, { error: { code: "X", message: "no" } }];
    let n = 1;
    for (const p of patches) {
      store.set(p);
      if ("booking" in p) { expect(parts.crewSync).toHaveBeenCalledTimes(n); continue; } // null → null: same reference
      expect(parts.crewSync).toHaveBeenCalledTimes(++n);
    }
    d.dispose();
  });

  it("nothing happens without a trip, or after dispose", () => {
    const store = fakeStore({ trip: null });
    const d = make(store);
    expect(parts.crewSync).not.toHaveBeenCalled();
    store.set({ trip: trip() });
    expect(parts.crewSync).toHaveBeenCalledOnce();
    d.dispose();
    store.set({ trip: trip({ version: 3 }) });
    expect(parts.crewSync).toHaveBeenCalledOnce();
  });

  it("pins are set only when the candidate cities change; the home port once", () => {
    const store = fakeStore({});
    const d = make(store);
    store.set({ trip: { ...(store.state.trip as TripState), version: 2 } }); // same candidateCities array
    expect(parts.setPins).toHaveBeenCalledOnce();
    store.set({ trip: trip({ candidateCities: [{ cityId: "LIS", name: "Lisbon", lat: 38.7, lng: -9.1 }] as TripState["candidateCities"] }) });
    expect(parts.setPins).toHaveBeenCalledTimes(2);
    expect(parts.setOrigins).toHaveBeenCalledOnce();
    d.dispose();
  });

  it("the compass Watch is capped at MAX_WATCHES", () => {
    const store = fakeStore({ trip: trip({ negotiation: { watch: 7, running: true } }) });
    const d = make(store);
    expect(parts.setWatch).toHaveBeenCalledWith(3, true);
    d.dispose();
  });
});

describe("SceneDirector rejections", () => {
  it("a new error undoes the optimistic pick once and shows the message; the same error again does nothing", () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore({});
      const d = make(store);
      const err = { code: "BAD_PHASE", message: "Too late" };
      store.set({ error: err });
      expect(parts.cancelPick).toHaveBeenCalledOnce();
      expect(parts.captionSet).toHaveBeenLastCalledWith("All Ayes", "Too late", expect.any(String));
      store.set({ votes: { p1: 2 } }); // same error object still set
      expect(parts.cancelPick).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(3000);
      expect(store.clearError).toHaveBeenCalledOnce();
      d.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("the Gallery (no controls) still cancels a pick but shows no note", () => {
    const store = fakeStore({});
    const d = make(store, false);
    parts.captionSet.mockClear();
    store.set({ error: { code: "X", message: "no" } });
    expect(parts.cancelPick).toHaveBeenCalledOnce();
    expect(parts.captionSet).not.toHaveBeenCalled();
    d.dispose();
  });
});
