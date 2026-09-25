// O2-068: when the chart may be laid down without a surface (Q0): after 3.5 s of searching, or at once when the
// browser has no hit-test. Fake XR session; three.js runs headless.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { Placement } from "./placement";

let now = 1000;
// vite.config restores mocks before each test, so the clock is stubbed per test
beforeEach(() => { now = 1000; vi.spyOn(performance, "now").mockImplementation(() => now); });

const session = (hit: "yes" | "no" | "throws") => {
  const src = { cancel: vi.fn() };
  return {
    src,
    s: {
      requestReferenceSpace: vi.fn(async () => ({})),
      requestHitTestSource: hit === "no" ? undefined : vi.fn(async () => { if (hit === "throws") throw new Error("NotSupported"); return src; }),
    } as unknown as XRSession,
  };
};

const camera = () => {
  const c = new THREE.PerspectiveCamera();
  c.position.set(0, 1.6, 0);
  c.updateMatrixWorld();
  return c;
};

describe("Placement.canFallback", () => {
  it("with hit-test: not before 3.5 s, then yes", async () => {
    const p = new Placement(new THREE.Group());
    const { s } = session("yes");
    await p.start(s);
    expect(p.canFallback).toBe(false);
    now += 3499;
    expect(p.canFallback).toBe(false);
    now += 1;
    expect(p.canFallback).toBe(true);
  });

  it("no hit-test API, or it refuses: at once", async () => {
    for (const kind of ["no", "throws"] as const) {
      const p = new Placement(new THREE.Group());
      await p.start(session(kind).s);
      expect(p.canFallback, kind).toBe(true);
    }
  });

  it("place() without a reticle refuses while it can't fall back, then lays the chart 75 cm ahead and 45 cm down", async () => {
    const target = new THREE.Group();
    const p = new Placement(target);
    const placed = vi.fn();
    p.onPlaced = placed;
    const { s, src } = session("yes");
    await p.start(s);
    expect(await p.place(camera())).toBe(false);
    expect(target.visible).toBe(false);
    now += 4000;
    expect(await p.place(camera())).toBe(true);
    expect(target.visible).toBe(true);
    expect(p.placed).toBe(true);
    expect(target.position.z).toBeCloseTo(-0.75);
    expect(target.position.y).toBeCloseTo(1.15);
    expect(src.cancel).toHaveBeenCalled(); // no more per-frame hit tests once placed
    expect(placed).toHaveBeenCalledOnce();
  });

  it("a session that ended while the source was requested drops it", async () => {
    const p = new Placement(new THREE.Group());
    const { s, src } = session("yes");
    const started = p.start(s);
    p.stop();
    await started;
    expect(src.cancel).toHaveBeenCalled();
  });
});
