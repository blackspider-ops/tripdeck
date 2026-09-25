// TR2-001: press/release must match on the mesh, not on the Interactable wrapper.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { Interactable } from "../scene/Buttons";
import { MouseInput, pickTarget, sameTarget } from "./input";

function box(z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial());
  m.position.z = z;
  m.updateMatrixWorld();
  return m;
}

function rayAlongMinusZ() {
  const r = new THREE.Raycaster();
  r.ray.origin.set(0, 0, 1);
  r.ray.direction.set(0, 0, -1);
  return r;
}

describe("XR pick", () => {
  it("a press and release on the same mesh selects even when the wrappers are rebuilt", () => {
    const mesh = box(0);
    const onSelect = vi.fn();
    const list = () => [{ object: mesh, onSelect }]; // fresh wrapper per call, like a getter
    const ray = rayAlongMinusZ();
    const down = pickTarget(ray, list())?.target ?? null;
    const up = pickTarget(ray, list())?.target ?? null;
    expect(down).not.toBe(up);
    expect(sameTarget(up, down)).toBe(true);
    if (sameTarget(up, down)) down!.onSelect();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("takes the nearest enabled, visible target", () => {
    const near = box(0.5), far = box(0);
    const targets: Interactable[] = [
      { object: far, onSelect: () => undefined },
      { object: near, onSelect: () => undefined },
    ];
    expect(pickTarget(rayAlongMinusZ(), targets)?.target.object).toBe(near);
    near.visible = false;
    expect(pickTarget(rayAlongMinusZ(), targets)?.target.object).toBe(far);
    targets[0].enabled = () => false;
    expect(pickTarget(rayAlongMinusZ(), targets)).toBeNull();
  });

  it("different meshes never match", () => {
    const a = { object: box(0), onSelect: () => undefined };
    const b = { object: box(0), onSelect: () => undefined };
    expect(sameTarget(a, b)).toBe(false);
    expect(sameTarget(null, a)).toBe(false);
  });
});

// R2-WP-07 / L2-006: the laptop view's mouse. A fake canvas (node has no DOM): 100×100 px, a box in the middle.
function fakeCanvas() {
  const on = new Map<string, (e: unknown) => void>();
  const el = {
    style: { cursor: "" },
    captured: [] as number[],
    addEventListener: (t: string, f: (e: unknown) => void) => on.set(t, f),
    removeEventListener: (t: string) => on.delete(t),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture(id: number) { this.captured.push(id); },
  };
  const fire = (t: string, e: Partial<PointerEvent> = {}) => on.get(t)?.({ clientX: 50, clientY: 50, button: 0, pointerId: 1, ...e });
  return { el, on, fire };
}
function mouseRig() {
  const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 10);
  cam.position.set(0, 0, 1);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const onSelect = vi.fn();
  const target: Interactable = { object: box(0), onSelect };
  const c = fakeCanvas();
  const input = new MouseInput(c.el as unknown as HTMLElement, cam, () => [target]);
  const onLongPress = vi.fn();
  input.onLongPress = onLongPress;
  return { ...c, input, onSelect, onLongPress };
}
let clock = 0;
const nowSpy = () => vi.spyOn(performance, "now").mockImplementation(() => clock);

describe("MouseInput (laptop view)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a left click on a target selects it; the press captures the pointer", () => {
    const r = mouseRig();
    r.fire("pointerdown");
    r.fire("pointerup");
    expect(r.onSelect).toHaveBeenCalledTimes(1);
    expect(r.el.captured).toEqual([1]);
  });

  it("a right or middle click on a target selects nothing (those drags pan / dolly)", () => {
    const r = mouseRig();
    for (const button of [2, 1]) {
      r.fire("pointerdown", { button });
      r.fire("pointerup", { button });
    }
    expect(r.onSelect).not.toHaveBeenCalled();
    expect(r.onLongPress).not.toHaveBeenCalled();
  });

  it("a drag further than 6 px is looking around: no select, no hail", () => {
    const r = mouseRig();
    r.fire("pointerdown");
    r.fire("pointermove", { clientX: 60, clientY: 50 });
    r.fire("pointerup");
    expect(r.onSelect).not.toHaveBeenCalled();
  });

  it("a still press on empty table for 700 ms opens the hail card; a short one doesn't", () => {
    nowSpy();
    const r = mouseRig();
    clock = 1_000;
    r.fire("pointerdown", { clientX: 5, clientY: 5 });
    clock = 1_300;
    r.fire("pointerup", { clientX: 5, clientY: 5 });
    expect(r.onLongPress).not.toHaveBeenCalled();
    clock = 2_000;
    r.fire("pointerdown", { clientX: 5, clientY: 5 });
    clock = 2_700;
    r.fire("pointerup", { clientX: 5, clientY: 5 });
    expect(r.onLongPress).toHaveBeenCalledTimes(1);
    expect(r.onSelect).not.toHaveBeenCalled();
  });

  it("a press that ends off the canvas (cancel / lost capture) is cleared, so hover works again", () => {
    const r = mouseRig();
    r.fire("pointerdown");
    r.fire("pointermove", { clientX: 5, clientY: 5 }); // dragging
    r.el.style.cursor = "";
    r.fire("pointermove", { clientX: 50, clientY: 50 });
    expect(r.el.style.cursor).toBe(""); // still pressed: no hover
    r.fire("lostpointercapture");
    r.fire("pointermove", { clientX: 50, clientY: 50 });
    expect(r.el.style.cursor).toBe("pointer");
    r.fire("pointerdown");
    r.fire("pointercancel");
    r.fire("pointerup");
    expect(r.onSelect).not.toHaveBeenCalled(); // the cancelled press never selects
    r.input.dispose();
    expect(r.on.size).toBe(0);
  });
});
