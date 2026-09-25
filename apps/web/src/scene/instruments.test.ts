// O2-068: the compass Watch pointers and the carriage clock (OPT-052: string work only when the slot changes).
// Real meshes on a stub canvas; troika is mocked (no font worker in node).
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";

vi.mock("troika-three-text", async () => {
  const T = await import("three");
  class Text extends T.Object3D { text = ""; syncs = 0; sync() { this.syncs++; } dispose() { /* no GPU */ } }
  return { Text, preloadFont: () => undefined };
});

const ctx2d: unknown = new Proxy({}, {
  get: (_t, k) => k === "getImageData" || k === "createImageData"
    ? (_x: number, _y: number, w = 1, h = 1) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4) })
    : k === "measureText" ? () => ({ width: 10 }) : () => ({ addColorStop: () => undefined }),
  set: () => true,
});
(globalThis as unknown as { document: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

import { CarriageClock, CompassTimer } from "./Instruments";
import { Tweens } from "./tween";

type FakeText = THREE.Object3D & { text: string; syncs: number };
const texts = (c: CarriageClock) => c.group.children.filter((o): o is FakeText => "syncs" in o);

describe("CarriageClock.setMinute", () => {
  it("shows the 5-minute slot, and only re-sets the text when the slot or the day changes", () => {
    const c = new CarriageClock();
    const [time, day] = texts(c);
    c.setMinute(8 * 60 + 2, "Day 1");
    expect(time.text).toBe("08:00");
    expect(day.text).toBe("DAY 1");
    const [ts, ds] = [time.syncs, day.syncs];
    for (let m = 8 * 60 + 2; m < 8 * 60 + 5; m += 0.1) c.setMinute(m, "Day 1"); // every frame in one slot
    expect([time.syncs, day.syncs]).toEqual([ts, ds]);
    c.setMinute(8 * 60 + 5, "Day 1");
    expect(time.text).toBe("08:05");
    expect(time.syncs).toBe(ts + 1);
    c.setMinute(8 * 60 + 5, "Day 2");
    expect(day.text).toBe("DAY 2");
    expect(time.syncs).toBe(ts + 1);
  });

  it("rings onHour when the hour turns, never for the first minute shown", () => {
    const c = new CarriageClock();
    const hour = vi.fn();
    c.onHour = hour;
    c.setMinute(8 * 60 + 55);
    expect(hour).not.toHaveBeenCalled();
    c.setMinute(8 * 60 + 59);
    expect(hour).not.toHaveBeenCalled();
    c.setMinute(9 * 60);
    expect(hour).toHaveBeenCalledOnce();
    c.setMinute(9 * 60 + 30);
    expect(hour).toHaveBeenCalledOnce();
  });
});

describe("CompassTimer.setWatch", () => {
  const REST = Math.PI;
  const needles = (c: CompassTimer) => (c as unknown as { needles: THREE.Group[] }).needles.map((n) => +n.rotation.y.toFixed(3));

  it("instant: Watch n puts the first n pointers out, the rest at rest", () => {
    const c = new CompassTimer(new Tweens());
    expect(needles(c)).toEqual([+REST.toFixed(3), +REST.toFixed(3), +REST.toFixed(3)]);
    c.setWatch(2, true);
    expect(needles(c)).toEqual([-0.62, 0, +REST.toFixed(3)]);
  });

  it("live: only the newly reached pointer tweens; a lower Watch (new meeting) snaps back", () => {
    const tw = new Tweens();
    const c = new CompassTimer(tw);
    c.setWatch(1, true);
    c.setWatch(2);
    expect(tw.size).toBe(1);
    expect(needles(c)[1]).toBeCloseTo(REST); // still moving
    tw.update(2);
    expect(needles(c)).toEqual([-0.62, 0, +REST.toFixed(3)]);
    c.setWatch(0);
    expect(tw.size).toBe(0);
    expect(needles(c).every((v) => v === +REST.toFixed(3))).toBe(true);
  });

  it("after snapNorth the pointers stay north until the Watch goes down", () => {
    const tw = new Tweens();
    const c = new CompassTimer(tw);
    c.setWatch(3, true);
    c.snapNorth(true);
    expect(needles(c)).toEqual([0, 0, 0]);
    c.setWatch(3, true); // the same sync again
    expect(needles(c)).toEqual([0, 0, 0]);
    c.setWatch(1, true); // a new meeting
    expect(needles(c)).toEqual([-0.62, +REST.toFixed(3), +REST.toFixed(3)]);
  });
});
