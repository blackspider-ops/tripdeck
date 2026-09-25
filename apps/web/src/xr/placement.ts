// Q0 — Placement (doc 03 §4): an ink ring follows the hit-test point on horizontal surfaces;
// pinch lays the chart down. Uses an anchor when the browser supports it.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";

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
    if (!this.placed) {
      const results = this.hitSource ? frame.getHitTestResults(this.hitSource) : [];
      const pose = results[0]?.getPose(refSpace);
      if (pose) {
        this.reticle.visible = true;
        this.reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        this.reticle.visible = false;
      }
      return;
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
      this.wantAnchorAt = at.clone();
    } else {
      if (!this.canFallback) return false;
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
    // once placed, stop paying for per-frame hit tests (recenter asks for a new source)
    try { this.hitSource?.cancel(); } catch { /* ended */ }
    this.hitSource = null;
    this.onPlaced?.();
    return true;
  }

  get canFallback() { return performance.now() >= this.fallbackAt || this.noHitTest; }
}
