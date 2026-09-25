// O2-068: the left palm held up for 600 ms opens the menu above the wrist (Q5). Real menu on a stub canvas;
// troika is mocked (no font worker in node).
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

vi.mock("troika-three-text", async () => {
  const T = await import("three");
  class Text extends T.Object3D { text = ""; sync = vi.fn(); dispose = vi.fn(); }
  return { Text, preloadFont: vi.fn() };
});

// a 2D context that accepts every call (paperCard paints on it; nothing reads the pixels back)
const ctx2d: unknown = new Proxy({}, {
  get: (_t, k) => k === "getImageData" || k === "createImageData"
    ? (_x: number, _y: number, w = 1, h = 1) => ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4) })
    : k === "measureText" ? () => ({ width: 10 })
      : () => ({ addColorStop: () => undefined }),
  set: () => true,
});
(globalThis as unknown as { document: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };

import { WristMenu } from "./wristMenu";
import { Tweens } from "../scene/tween";

let now = 0;
beforeEach(() => { vi.spyOn(performance, "now").mockImplementation(() => now); }); // mocks are restored per test

const actions = () => ({ recenter: vi.fn(), captions: vi.fn(() => "Captions: L"), motion: vi.fn(() => "x"), sound: vi.fn(() => "x"), debug: vi.fn(() => "x"), exit: vi.fn() });

/** A left hand: wrist at the origin, index and pinky metacarpals placed so index×pinky points `down` or up. */
function hand(palmUp: boolean, wristVisible = true) {
  const joint = (x: number, y: number, z: number) => { const o = new THREE.Object3D(); o.position.set(x, y, z); o.updateMatrixWorld(); return o; };
  const wrist = joint(0, 1, 0);
  wrist.visible = wristVisible;
  // index forward (−z), pinky to the right (+x): (0,0,−1)×(1,0,0) = (0,−1,0) → palm up
  const index = joint(0, 1, -0.08);
  const pinky = joint(palmUp ? 0.05 : -0.05, 1, 0);
  return { joints: { wrist, "index-finger-metacarpal": index, "pinky-finger-metacarpal": pinky } } as unknown as THREE.XRHandSpace;
}
const cam = () => { const c = new THREE.PerspectiveCamera(); c.position.set(0, 1.5, 0.5); c.updateMatrixWorld(); return c; };

describe("WristMenu palm-up rule", () => {
  it("opens only after the palm has been up for more than 600 ms, 14 cm above the wrist", () => {
    const m = new WristMenu(new Tweens(), actions());
    now = 1000;
    m.update(cam(), hand(true));
    now = 1600;
    m.update(cam(), hand(true));
    expect(m.open).toBe(false);
    now = 1601;
    m.update(cam(), hand(true));
    expect(m.open).toBe(true);
    expect(m.group.visible).toBe(true);
    expect(m.group.position.y).toBeCloseTo(1.14);
  });

  it("turning the palm down (or losing the wrist) restarts the 600 ms", () => {
    const m = new WristMenu(new Tweens(), actions());
    now = 0; m.update(cam(), hand(true));
    now = 500; m.update(cam(), hand(false));
    now = 700; m.update(cam(), hand(true));
    now = 1200; m.update(cam(), hand(true));
    expect(m.open).toBe(false);
    now = 1250; m.update(cam(), hand(true, false)); // wrist not tracked
    now = 1300; m.update(cam(), hand(true));
    now = 1800; m.update(cam(), hand(true));
    expect(m.open).toBe(false);
    now = 1901; m.update(cam(), hand(true));
    expect(m.open).toBe(true);
  });

  it("palm down never opens it; no hand is ignored", () => {
    const m = new WristMenu(new Tweens(), actions());
    for (now = 0; now < 3000; now += 100) m.update(cam(), hand(false));
    m.update(cam(), null);
    expect(m.open).toBe(false);
  });

  it("the wheel toggles it; Recenter closes it and recenters; a button relabels itself", () => {
    const a = actions();
    const m = new WristMenu(new Tweens(), a);
    const [wheel, recenter, captions] = m.interactables();
    wheel.onSelect();
    expect(m.open).toBe(true);
    expect(recenter.enabled?.()).toBe(true);
    recenter.onSelect();
    expect(a.recenter).toHaveBeenCalledOnce();
    expect(m.open).toBe(false);
    expect(recenter.enabled?.()).toBe(false);
    captions.onSelect();
    expect(a.captions).toHaveBeenCalledOnce();
  });
});
