// Gear VR / Cardboard gaze input: the dwell timer (pure) and how a tap, Enter/Space, a session select and a dwell
// reach the target under the reticle.
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { Interactable } from "../scene/Buttons";
import { DWELL_MS, GazeInput, LONG_GAZE_MS, LONG_PRESS_MS, SELECT_DEDUPE_MS, newDwell, stepDwell } from "./gaze";

describe("stepDwell", () => {
  it("fills over 1.6 s, fires once, and not again until the gaze leaves and returns", () => {
    const s = newDwell();
    const a = {};
    expect(DWELL_MS).toBe(1600);
    expect(stepDwell(s, a, 0)).toMatchObject({ progress: 0, fire: false });
    expect(stepDwell(s, a, 800).progress).toBeCloseTo(0.5);
    expect(stepDwell(s, a, 1599).fire).toBe(false);
    expect(stepDwell(s, a, 1600)).toMatchObject({ fire: true, progress: 1 });
    expect(stepDwell(s, a, 5000).fire).toBe(false); // staying put never re-fires
    stepDwell(s, null, 5100); // gaze leaves
    expect(stepDwell(s, a, 5200).fire).toBe(false);
    expect(stepDwell(s, a, 6800).fire).toBe(true); // …and returns for another full dwell
  });

  it("leaving before the ring fills cancels it", () => {
    const s = newDwell();
    const a = {}, b = {};
    stepDwell(s, a, 0);
    stepDwell(s, b, 1500); // moved to another target
    expect(stepDwell(s, a, 1700).fire).toBe(false);
    expect(stepDwell(s, a, 1700 + DWELL_MS).fire).toBe(true);
  });

  it("a long gaze on a target with a long action fires that once, after the select", () => {
    const s = newDwell();
    const w = {};
    stepDwell(s, w, 0, true);
    expect(stepDwell(s, w, DWELL_MS, true).fire).toBe(true);
    expect(stepDwell(s, w, (DWELL_MS + LONG_GAZE_MS) / 2, true).longProgress).toBeCloseTo(0.5);
    expect(stepDwell(s, w, LONG_GAZE_MS, true).long).toBe(true);
    expect(stepDwell(s, w, LONG_GAZE_MS + 5000, true).long).toBe(false);
    // no long action → never a long fire
    const t = newDwell();
    stepDwell(t, w, 0);
    expect(stepDwell(t, w, LONG_GAZE_MS * 2).long).toBe(false);
  });
});

// ---------------------------------------------------------------- dispatch

function fakeWin() {
  const on = new Map<string, (e: unknown) => void>();
  return {
    on,
    addEventListener: (t: string, f: (e: unknown) => void) => on.set(t, f),
    removeEventListener: (t: string) => on.delete(t),
    fire: (t: string, e: Record<string, unknown> = {}) => on.get(t)?.({ button: 0, preventDefault: () => undefined, ...e }),
  };
}
function fakeSession() {
  const on = new Map<string, () => void>();
  return {
    on,
    addEventListener: (t: string, f: () => void) => on.set(t, f),
    removeEventListener: (t: string) => on.delete(t),
  };
}
function box(z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial());
  m.position.z = z;
  m.updateMatrixWorld();
  return m;
}

function gazeRig() {
  let clock = 1000;
  const win = fakeWin();
  const onSelect = vi.fn();
  const onWheelSelect = vi.fn();
  const recenter = vi.fn();
  const target: Interactable = { object: box(-1), onSelect };
  const wheel: Interactable = { object: box(-1), onSelect: onWheelSelect };
  wheel.object.position.x = 1; wheel.object.updateMatrixWorld();
  const onEmptySelect = vi.fn(), onEmptyLongPress = vi.fn(), onBack = vi.fn();
  const g = new GazeInput({
    getTargets: () => [target, wheel], win: win as unknown as EventTarget, now: () => clock,
    longAction: (t) => (t.object === wheel.object ? recenter : null),
    onEmptySelect, onEmptyLongPress, onBack,
  });
  const session = fakeSession();
  g.attach(session as unknown as XRSession);
  const origin = new THREE.Vector3();
  const at = (x: number) => g.update(origin, new THREE.Vector3(x, 0, -1).normalize()); // x=0 → target, x=1 → wheel
  return { g, win, session, onSelect, onWheelSelect, recenter, onEmptySelect, onEmptyLongPress, onBack, at, tick: (ms: number) => { clock += ms; } };
}

describe("GazeInput dispatch", () => {
  it("a tap (pointer down/up) selects what the reticle rests on; a tap on nothing is the empty select", () => {
    const r = gazeRig();
    r.at(0);
    expect(r.g.hover?.object).toBeDefined();
    r.win.fire("pointerdown"); r.tick(80); r.win.fire("pointerup");
    expect(r.onSelect).toHaveBeenCalledTimes(1);
    r.at(-3); // looking away
    r.tick(SELECT_DEDUPE_MS);
    r.win.fire("pointerdown"); r.tick(80); r.win.fire("pointerup");
    expect(r.onEmptySelect).toHaveBeenCalledTimes(1);
    expect(r.onSelect).toHaveBeenCalledTimes(1);
  });

  it("Enter and Space select; a held key's repeats don't; Escape / Back exit", () => {
    const r = gazeRig();
    r.at(0);
    r.win.fire("keydown", { key: "Enter" });
    r.tick(SELECT_DEDUPE_MS);
    r.win.fire("keydown", { key: " " });
    r.tick(SELECT_DEDUPE_MS);
    r.win.fire("keydown", { key: " ", repeat: true });
    expect(r.onSelect).toHaveBeenCalledTimes(2);
    r.win.fire("keydown", { key: "Escape" });
    r.win.fire("keydown", { key: "GoBack" });
    expect(r.onBack).toHaveBeenCalledTimes(2);
  });

  it("the XR session's select selects, and one press arriving twice (select + tap) counts once", () => {
    const r = gazeRig();
    r.at(0);
    r.session.on.get("select")!();
    r.win.fire("pointerdown"); r.tick(40); r.win.fire("pointerup"); // same physical tap, within the dedupe window
    expect(r.onSelect).toHaveBeenCalledTimes(1);
  });

  it("dwell selects after 1.6 s; a tap first means the dwell won't fire it again this visit", () => {
    const r = gazeRig();
    r.at(0);
    r.tick(DWELL_MS - 1); r.at(0);
    expect(r.onSelect).not.toHaveBeenCalled();
    r.tick(1); r.at(0);
    expect(r.onSelect).toHaveBeenCalledTimes(1);
    r.tick(3000); r.at(0);
    expect(r.onSelect).toHaveBeenCalledTimes(1);
    // look away and back, tap immediately: the tap selects, the dwell then stays quiet
    r.at(-3); r.at(0);
    r.win.fire("pointerdown"); r.tick(50); r.win.fire("pointerup");
    r.tick(DWELL_MS * 2); r.at(0);
    expect(r.onSelect).toHaveBeenCalledTimes(2);
  });

  it("long press or long gaze on the wheel recenters; long press on nothing opens the hail card", () => {
    const r = gazeRig();
    r.at(1);
    r.win.fire("pointerdown"); r.tick(LONG_PRESS_MS); r.win.fire("pointerup");
    expect(r.recenter).toHaveBeenCalledTimes(1);
    expect(r.onWheelSelect).not.toHaveBeenCalled();
    r.at(-3); r.at(1);
    r.tick(DWELL_MS); r.at(1);
    expect(r.onWheelSelect).toHaveBeenCalledTimes(1); // the dwell opens the menu…
    r.tick(LONG_GAZE_MS - DWELL_MS); r.at(1);
    expect(r.recenter).toHaveBeenCalledTimes(2); // …and holding on recenters
    r.at(-3);
    r.win.fire("pointerdown"); r.tick(LONG_PRESS_MS + 10); r.win.fire("pointerup");
    expect(r.onEmptyLongPress).toHaveBeenCalledTimes(1);
  });

  it("does nothing once detached, and dispose removes every listener", () => {
    const r = gazeRig();
    r.at(0);
    r.g.detach();
    r.win.fire("keydown", { key: "Enter" });
    r.win.fire("pointerdown"); r.win.fire("pointerup");
    expect(r.session.on.size).toBe(0);
    expect(r.onSelect).not.toHaveBeenCalled();
    r.g.dispose();
    expect(r.win.on.size).toBe(0);
  });
});
