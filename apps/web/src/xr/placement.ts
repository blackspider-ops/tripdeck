// Q0 — Placement (doc 03 §4): an ink ring follows the hit-test point on horizontal surfaces;
// pinch lays the chart down. Uses an anchor when the browser supports it.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";

/** How far ahead and how far below the eye the chart lands when there's no table to hit (m). */
export const FRONT_DIST = 0.75;
export const BELOW_EYE = 0.45;

/**
 * The chart straight ahead of the viewer, level: `forward` flattened onto the floor, FRONT_DIST out, at `tableY` (the
 * real table's height, when known) or BELOW_EYE under the eye. `yaw` turns the chart's +z (the viewer's side) to them.
 */
export function snapInFront(eye: THREE.Vector3, forward: THREE.Vector3, tableY?: number): { at: THREE.Vector3; yaw: number } {
  const fwd = forward.clone().setY(0);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); // looking straight down: keep north
  fwd.normalize();
  const at = eye.clone().addScaledVector(fwd, FRONT_DIST);
  at.y = tableY ?? eye.y - BELOW_EYE;
  return { at, yaw: Math.atan2(eye.x - at.x, eye.z - at.z) };
}

/**
 * Co-located crews (docs/03 §4): everyone lays the chart on the same spot (the table's centre), then pinches the
 * table corner nearest them. The chart turns so this viewer's own seat (seating.ts angle `seatDeg`: x = cos, z = sin
 * in the chart's frame) points at that corner. Returns the chart's yaw (rotation about +y).
 */
export function alignYaw(center: THREE.Vector3, corner: THREE.Vector3, seatDeg: number): number {
  const r = (seatDeg * Math.PI) / 180;
  // rotation.y by θ turns a local direction at atan2(x, z) = α to α + θ
  return Math.atan2(corner.x - center.x, corner.z - center.z) - Math.atan2(Math.cos(r), Math.sin(r));
}

/** Where a ray meets the horizontal plane y = `y`, or null (parallel, or behind the ray). */
export function rayOnPlane(ray: THREE.Ray, y: number): THREE.Vector3 | null {
  const out = new THREE.Vector3();
  return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), out);
}

export class Placement {
  readonly reticle = new THREE.Group();
  placed = false;
  private hitSource: XRHitTestSource | null = null;
  private anchor: XRAnchor | null = null;
  /** Anchors can only be created while an XRFrame is active, so `place()` (a select handler) asks
   *  the next frame to do it. */
  private wantAnchorAt: THREE.Vector3 | null = null;
  private session: XRSession | null = null;
  /** Set only once we know hit-test isn't available (not while the source is still being requested). */
  private noHitTest = false;
  private yaw = 0;
  private fallbackAt = 0;
  /** After a recenter: the chart is already down in front, and the reticle keeps finding surfaces so a pinch can
   *  move it onto the real table (docs/03 §4). */
  adjusting = false;
  onPlaced?: () => void;

  constructor(private target: THREE.Object3D) {
    const ink = new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.85 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.106, 64), ink);
    const inner = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.023, 32), ink);
    const bar1 = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.002), ink);
    const bar2 = bar1.clone(); bar2.rotation.z = Math.PI / 2;
    for (const m of [ring, inner, bar1, bar2]) { m.rotation.x = -Math.PI / 2; this.reticle.add(m); }
    bar2.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    this.reticle.visible = false;
    this.reticle.matrixAutoUpdate = false;
    target.visible = false;
  }

  async start(session: XRSession) {
    this.stop();
    this.session = session;
    this.placed = false;
    this.target.visible = false;
    this.fallbackAt = performance.now() + 3500;
    this.noHitTest = false;
    try {
      const viewer = await session.requestReferenceSpace("viewer");
      const src = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
      if (this.session !== session) { src?.cancel(); return; } // session ended / restarted meanwhile
      this.hitSource = src;
      this.noHitTest = !src;
    } catch {
      this.hitSource = null;
      this.noHitTest = true;
    }
  }

  /** Release the hit-test source and anchor (recenter, session end). */
  stop() {
    try { this.hitSource?.cancel(); } catch { /* session already ended */ }
    this.hitSource = null;
    try { this.anchor?.delete?.(); } catch { /* ditto */ }
    this.anchor = null;
    this.wantAnchorAt = null;
    this.session = null;
    this.reticle.visible = false;
  }

  reset(session: XRSession | null) {
    this.stop();
    if (session) void this.start(session);
  }

  update(frame: XRFrame | undefined, refSpace: XRReferenceSpace | null) {
    if (!frame || !refSpace) return;
    if (!this.placed || this.adjusting) {
      const results = this.hitSource ? frame.getHitTestResults(this.hitSource) : [];
      const pose = results[0]?.getPose(refSpace);
      if (pose) {
        this.reticle.visible = true;
        this.reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        this.reticle.visible = false;
      }
      if (!this.placed) return;
    }
    if (this.wantAnchorAt && frame.createAnchor) {
      const at = this.wantAnchorAt, session = this.session;
      this.wantAnchorAt = null;
      frame.createAnchor(new XRRigidTransform({ x: at.x, y: at.y, z: at.z }), refSpace)
        ?.then((a) => { if (this.session === session && this.placed) this.anchor = a; else a.delete(); })
        .catch(() => undefined);
    }
    if (this.anchor) {
      const p = frame.getPose(this.anchor.anchorSpace, refSpace);
      if (p) this.target.position.set(p.transform.position.x, p.transform.position.y, p.transform.position.z);
    }
  }

  /** Lay the chart down at the reticle (or in front of the user if no surface was found). */
  async place(camera: THREE.Camera) {
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    const at = new THREE.Vector3();
    if (this.reticle.visible) {
      at.setFromMatrixPosition(this.reticle.matrix);
      // a new spot: the old anchor (from the last placement or a recenter) must not pull the chart back
      try { this.anchor?.delete?.(); } catch { /* ended */ }
      this.anchor = null;
      this.wantAnchorAt = at.clone();
    } else {
      if (this.adjusting || !this.canFallback) return false; // after a recenter the chart is already down in front
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
      fwd.y = 0; fwd.normalize();
      at.copy(camPos).addScaledVector(fwd, 0.75);
      at.y = camPos.y - 0.45;
    }
    // the Organizer sits "south": the table's +z points at the user
    this.yaw = Math.atan2(camPos.x - at.x, camPos.z - at.z);
    this.target.position.copy(at);
    this.target.rotation.set(0, this.yaw, 0);
    this.target.visible = true;
    this.reticle.visible = false;
    this.placed = true;
    this.adjusting = false;
    // once placed, stop paying for per-frame hit tests (recenter asks for a new source)
    try { this.hitSource?.cancel(); } catch { /* ended */ }
    this.hitSource = null;
    this.onPlaced?.();
    return true;
  }

  /**
   * Recenter in mixed reality: the chart comes straight back in front of the viewer at once (at the table height it
   * had, so it stays on the real table), with a fresh anchor there; the reticle then keeps looking for surfaces, and
   * a pinch lays it exactly where the ring is (`adjusting`). Never leaves the chart hidden.
   */
  recenter(camera: THREE.Camera, session: XRSession | null) {
    const eye = new THREE.Vector3(), fwd = new THREE.Vector3(0, 0, -1);
    camera.getWorldPosition(eye);
    fwd.applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    const tableY = this.placed ? this.target.position.y : undefined;
    const { at, yaw } = snapInFront(eye, fwd, tableY);
    // the old anchor would pull the chart back to where it was
    try { this.anchor?.delete?.(); } catch { /* ended */ }
    this.anchor = null;
    this.yaw = yaw;
    this.target.position.copy(at);
    this.target.rotation.set(0, yaw, 0);
    this.target.visible = true;
    this.placed = true;
    this.wantAnchorAt = session ? at.clone() : null;
    this.adjusting = Boolean(session);
    if (session && !this.hitSource) void this.requestHits(session);
    this.onPlaced?.();
  }

  private async requestHits(session: XRSession) {
    try {
      const viewer = await session.requestReferenceSpace("viewer");
      const src = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
      if (this.session !== session || !this.adjusting) { src?.cancel(); return; }
      this.hitSource = src;
    } catch { this.hitSource = null; }
  }

  /** Turn the chart about its centre (the alignment step). */
  setYaw(yaw: number) { this.yaw = yaw; this.target.rotation.set(0, yaw, 0); }
  get currentYaw() { return this.yaw; }

  get canFallback() { return performance.now() >= this.fallbackAt || this.noHitTest; }
}
