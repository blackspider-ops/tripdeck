// Controllers + hands (doc 03 §4 interaction table). Quest Browser turns a hand pinch into a
// `select` on the hand's target-ray space, so one code path serves both.
//  - select on a thing → that thing's action (place, weigh anchor, pick a cloche, pause the clock…)
//  - pinch-hold ≥ 400 ms on empty space → the Hail card
//  - squeeze → the menu
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import type { Interactable } from "../scene/Buttons";
import { sound } from "../scene/audio";

const HOLD_MS = 400;
/** Laptop view: a still press this long opens the hail card; moving further than DRAG_PX is an orbit. */
const LONG_PRESS_MS = 650;
const DRAG_PX = 6;

interface Pointer {
  ctrl: THREE.XRTargetRaySpace;
  ray: THREE.Mesh;
  dot: THREE.Mesh;
  downAt: number;
  /** A select is being held (hover must stay current for the release). */
  down: boolean;
  downHit: Interactable | null;
  /** The controller listeners, kept so `dispose` can remove them. */
  off: () => void;
}

export class XRInput {
  private pointers: Pointer[] = [];
  private raycaster = new THREE.Raycaster();
  private tmpM = new THREE.Matrix4();
  private tmpV = new THREE.Vector3();
  private tmpN = new THREE.Vector3();
  private frame = 0;
  onEmptySelect?: () => void;
  onLongPress?: () => void;
  onSqueeze?: () => void;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, private getTargets: () => readonly Interactable[]) {
    const inkRay = new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.45 });
    const redDot = new THREE.MeshBasicMaterial({ color: PALETTE.soundingRed, side: THREE.DoubleSide });
    const rayGeo = new THREE.CylinderGeometry(0.0007, 0.0007, 1, 5);
    const dotGeo = new THREE.RingGeometry(0.004, 0.0055, 20);
    for (let i = 0; i < 2; i++) {
      const ctrl = renderer.xr.getController(i);
      const ray = new THREE.Mesh(rayGeo, inkRay);
      ray.rotation.x = -Math.PI / 2;
      ray.position.z = -0.5;
      ray.visible = false;
      const dot = new THREE.Mesh(dotGeo, redDot);
      dot.visible = false;
      ctrl.add(ray);
      scene.add(ctrl, dot);
      const onConnected = (e: unknown) => {
        const src = (e as { data: XRInputSource }).data;
        ray.visible = src.targetRayMode === "tracked-pointer" && !src.hand; // hands don't need a drawn ray
      };
      const onDisconnected = () => { ray.visible = false; dot.visible = false; };
      const onSelectStart = () => {
        // Quest can suspend the AudioContext (system menu, headset off); a select is a user gesture
        if (!sound.unlocked) void sound.unlock();
        p.downAt = performance.now();
        p.down = true;
        p.downHit = this.hit(p);
      };
      const onSelectEnd = () => this.release(p);
      const onSqueeze = () => this.onSqueeze?.();
      ctrl.addEventListener("connected", onConnected);
      ctrl.addEventListener("disconnected", onDisconnected);
      ctrl.addEventListener("selectstart", onSelectStart);
      ctrl.addEventListener("selectend", onSelectEnd);
      ctrl.addEventListener("squeezestart", onSqueeze);
      const p: Pointer = {
        ctrl, ray, dot, downAt: 0, down: false, downHit: null,
        off: () => {
          ctrl.removeEventListener("connected", onConnected);
          ctrl.removeEventListener("disconnected", onDisconnected);
          ctrl.removeEventListener("selectstart", onSelectStart);
          ctrl.removeEventListener("selectend", onSelectEnd);
          ctrl.removeEventListener("squeezestart", onSqueeze);
        },
      };
      this.pointers.push(p);
    }
  }

  private hit(p: Pointer): Interactable | null {
    // an untracked / disconnected pointer keeps a stale matrix: don't ray-cast from it
    if (!p.ctrl.visible) { p.dot.visible = false; return null; }
    this.tmpM.identity().extractRotation(p.ctrl.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(p.ctrl.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmpM);
    const found = pickTarget(this.raycaster, this.getTargets());
    if (!found) { p.dot.visible = false; return null; }
    const { target, hit } = found;
    p.dot.visible = true;
    p.dot.position.copy(hit.point);
    if (hit.face) p.dot.lookAt(this.tmpV.copy(hit.point).add(this.tmpN.copy(hit.face.normal).transformDirection(hit.object.matrixWorld)));
    return target;
  }

  private release(p: Pointer) {
    const held = performance.now() - p.downAt;
    const now = this.hit(p);
    // compare the picked mesh, not the Interactable wrapper (a list may be rebuilt between press and release)
    if (p.downHit && sameTarget(now, p.downHit)) p.downHit.onSelect();
    else if (!p.downHit && held >= HOLD_MS) this.onLongPress?.();
    else if (!p.downHit) this.onEmptySelect?.();
    p.downHit = null;
    p.down = false;
  }

  /** Hover feedback: a small red ring where the ray lands on something selectable. While nothing is held it's
   *  refreshed every other frame (36–45 Hz on Quest), halving the per-frame ray casts (O2-057). */
  update() {
    if (!this.pointers.some((p) => p.ctrl.visible)) { for (const p of this.pointers) p.dot.visible = false; return; }
    const skip = (this.frame++ & 1) === 1;
    for (const p of this.pointers) if (p.down || !skip) this.hit(p);
  }

  /** Stop listening to the controllers and free the rays and dots (O2-053: the instance used to be dropped). */
  dispose() {
    for (const p of this.pointers) {
      p.off();
      p.ray.removeFromParent();
      p.dot.removeFromParent();
      p.ctrl.removeFromParent();
    }
    const [first] = this.pointers;
    if (first) {
      first.ray.geometry.dispose(); (first.ray.material as THREE.Material).dispose();
      first.dot.geometry.dispose(); (first.dot.material as THREE.Material).dispose();
    }
    this.pointers = [];
  }
}

/** Same thing under the pointer: the same mesh (wrappers may be rebuilt between press and release). */
export function sameTarget(a: Interactable | null, b: Interactable | null): boolean {
  return !!a && !!b && a.object === b.object;
}

const scratchHits: THREE.Intersection[] = [];

/**
 * The nearest enabled, visible target under the ray (shared by the headset and the laptop view).
 * Walks the list in place — no per-frame arrays — and on a tie keeps the earlier entry.
 */
export function pickTarget(raycaster: THREE.Raycaster, targets: readonly Interactable[]): { target: Interactable; hit: THREE.Intersection } | null {
  let best: { target: Interactable; hit: THREE.Intersection } | null = null;
  for (const t of targets) {
    if (!(t.enabled?.() ?? true) || !isShown(t.object)) continue;
    scratchHits.length = 0;
    raycaster.intersectObject(t.object, true, scratchHits);
    const h = scratchHits[0];
    if (h && (!best || h.distance < best.hit.distance)) best = { target: t, hit: h };
  }
  scratchHits.length = 0;
  return best;
}

function isShown(o: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false;
  return true;
}

/**
 * Laptop fallback: click = select, press-and-hold (without dragging) = hail card. Only the primary button counts
 * (right/middle drags are OrbitControls' pan/dolly), and a press that ends anywhere — released off the canvas,
 * cancelled, or losing capture — is cleared, so hover feedback never sticks (R2-WP-07 / L2-006).
 */
export class MouseInput {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private downAt = 0;
  private downX = 0;
  private downY = 0;
  private pressed = false;
  private dragged = false;
  private downHit: Interactable | null = null;
  onLongPress?: () => void;

  constructor(private el: HTMLElement, private camera: THREE.Camera, private getTargets: () => readonly Interactable[]) {
    el.addEventListener("pointerdown", this.down);
    el.addEventListener("pointerup", this.up);
    el.addEventListener("pointermove", this.move);
    el.addEventListener("pointercancel", this.cancel);
    el.addEventListener("lostpointercapture", this.cancel);
  }

  private pick(e: PointerEvent): Interactable | null {
    const r = this.el.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return pickTarget(this.raycaster, this.getTargets())?.target ?? null;
  }

  private down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // keep receiving this pointer's up/cancel even when it's released over the toolbar or off the window
    try { this.el.setPointerCapture?.(e.pointerId); } catch { /* not capturable (synthetic events) */ }
    this.downAt = performance.now();
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.pressed = true;
    this.dragged = false;
    this.downHit = this.pick(e);
  };
  private up = (e: PointerEvent) => {
    if (!this.pressed || e.button !== 0) return;
    this.pressed = false;
    const hit = this.pick(e);
    // an orbit drag is looking around, not a click or a hold
    if (!this.dragged) {
      if (this.downHit && sameTarget(hit, this.downHit)) this.downHit.onSelect();
      else if (!this.downHit && performance.now() - this.downAt > LONG_PRESS_MS) this.onLongPress?.();
    }
    this.downHit = null;
  };
  private cancel = () => {
    this.pressed = false;
    this.dragged = false;
    this.downHit = null;
  };
  private move = (e: PointerEvent) => {
    if (this.pressed && !this.dragged && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > DRAG_PX) this.dragged = true;
    if (!this.pressed) this.el.style.cursor = this.pick(e) ? "pointer" : "grab";
  };

  dispose() {
    this.el.removeEventListener("pointerdown", this.down);
    this.el.removeEventListener("pointerup", this.up);
    this.el.removeEventListener("pointermove", this.move);
    this.el.removeEventListener("pointercancel", this.cancel);
    this.el.removeEventListener("lostpointercapture", this.cancel);
    this.el.style.cursor = "";
  }
}
