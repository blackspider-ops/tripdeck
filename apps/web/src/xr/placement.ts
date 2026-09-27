// Q0 — Placement (doc 03 §4): an ink ring follows the hit-test point on level surfaces;
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

/**
 * The chart's yaw with the seat at `seatDeg` pointing straight at the viewer's eye (the seat nearest them). Depends only
 * on where the chart and the eye are, so recentring twice gives the same turn.
 */
export function faceSeatYaw(center: THREE.Vector3, eye: THREE.Vector3, seatDeg: number): number {
  return normAngle(alignYaw(center, eye, seatDeg));
}
function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Where a ray meets the horizontal plane y = `y`, or null (parallel, or behind the ray). */
export function rayOnPlane(ray: THREE.Ray, y: number): THREE.Vector3 | null {
  const out = new THREE.Vector3();
  return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), out);
}

// ---------- the lock: once down, the chart stays on the real table ----------
// User report (Quest 3S, MR): "the globe keeps jumping forward and backward … is not bound". The chart is moved only
// by an explicit action (the first pinch that lays it down, Recenter, a pinch aimed at the ring while adjusting after
// a Recenter); after that one XRAnchor holds it, and anchor updates pass through PoseLock (deadband + light easing).

/** Anchor updates smaller than this are tracking noise: the chart doesn't move (m, rad ≈ 0.34°). */
export const LOCK_DEADBAND_M = 0.006;
export const LOCK_DEADBAND_RAD = 0.006;
/** A real anchor correction is eased in with this time constant (s). */
export const LOCK_SMOOTH_S = 0.2;
/** A jump this big is a relocalization or a reference-space reset: taken at once, not glided across the room (m). */
export const LOCK_SNAP_M = 0.3;
/** While adjusting after a Recenter, a pinch must point within this far of the ring to move the chart (m). */
export const AIM_AT_RING_M = 0.2;
/** Adjusting ends by itself after this long (ms): the chart stays where the Recenter put it. */
export const ADJUST_MS = 20_000;
/** A hit-test result counts as a table top only if its normal is this close to straight up (cos). */
const LEVEL_COS = 0.8;

function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** The heading (rotation about +y) of an orientation: where its +z points on the floor. */
export function yawOf(q: { x: number; y: number; z: number; w: number }): number {
  const v = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  return Math.atan2(v.x, v.z);
}

/**
 * The chart's world pose, following its anchor without the anchor's noise: changes inside the deadband are ignored;
 * once a change is past it, the chart eases all the way there (then rests again); a jump past LOCK_SNAP_M (or the
 * first pose after `snap()`) is taken at once. Position only ever moves toward the anchor's pose — never on its own.
 */
export class PoseLock {
  readonly pos = new THREE.Vector3();
  yaw = 0;
  private movingPos = false;
  private movingYaw = false;
  private snapNext = true;

  /** Start from this pose (the chart was just put here on purpose). */
  reset(pos: THREE.Vector3, yaw: number) {
    this.pos.copy(pos); this.yaw = yaw;
    this.movingPos = this.movingYaw = false;
    this.snapNext = false;
  }
  /** Take the next pose at once (after a reference-space reset). */
  snap() { this.snapNext = true; }

  /** One frame toward the anchor's pose (`dt` s). True when the chart moved. */
  step(want: THREE.Vector3, wantYaw: number, dt: number): boolean {
    const d = this.pos.distanceTo(want);
    const dy = angleDiff(this.yaw, wantYaw);
    if (this.snapNext || d > LOCK_SNAP_M) {
      this.reset(want, wantYaw);
      return d > 0 || dy !== 0;
    }
    if (d > LOCK_DEADBAND_M) this.movingPos = true;
    if (Math.abs(dy) > LOCK_DEADBAND_RAD) this.movingYaw = true;
    if (!this.movingPos && !this.movingYaw) return false;
    const k = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.1)) / LOCK_SMOOTH_S);
    if (this.movingPos) {
      this.pos.lerp(want, k);
      if (this.pos.distanceTo(want) < 0.0005) { this.pos.copy(want); this.movingPos = false; }
    }
    if (this.movingYaw) {
      const left = angleDiff(this.yaw, wantYaw);
      this.yaw += left * k;
      if (Math.abs(left * (1 - k)) < 0.0005) { this.yaw = wantYaw; this.movingYaw = false; }
    }
    return true;
  }
}

export class Placement {
  readonly reticle = new THREE.Group();
  placed = false;
  private hitSource: XRHitTestSource | null = null;
  private anchor: XRAnchor | null = null;
  /** Bumped whenever the chart is put somewhere on purpose (or the session stops): an anchor request made for an
   *  older spot is thrown away when it resolves, never allowed to pull the chart back there. */
  private anchorGen = 0;
  /** The anchor resolved: its first pose fixes `rel`. */
  private relPending = false;
  /** The chart's pose in its anchor's level frame (an offset and a turn); fixed when the anchor is made or the chart
   *  is turned on purpose (the alignment step). */
  private rel = { offset: new THREE.Vector3(), yaw: 0 };
  private anchorPos = new THREE.Vector3();
  private anchorYaw = 0;
  private lock = new PoseLock();
  private want = new THREE.Vector3();
  private lastUpdate = 0;
  /** Anchors can only be created while an XRFrame is active, so `place()` (a select handler) asks
   *  the next frame to do it. */
  private wantAnchorAt: THREE.Vector3 | null = null;
  private session: XRSession | null = null;
  /** Set only once we know hit-test isn't available (not while the source is still being requested). */
  private noHitTest = false;
  private yaw = 0;
  private fallbackAt = 0;
  private adjustUntil = 0;
  /** After a recenter: the chart is already down in front, and the reticle keeps finding surfaces so a pinch aimed at
   *  the ring can move it onto the real table (docs/03 §4). Ends by itself after ADJUST_MS. */
  adjusting = false;
  onPlaced?: () => void;
  /** The wearer's own seat angle (seating.ts; 90 = the Organizer's, the chart's +z). The chart is laid down and
   *  recentred with THIS seat toward the viewer, never whichever seat happens to sit at +z (user report: "the recenter
   *  actually goes to Hana's view"). */
  seatDeg: () => number = () => 90;

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
    this.adjusting = false;
    this.target.visible = false;
    this.fallbackAt = performance.now() + 3500;
    this.noHitTest = false;
    try {
      const viewer = await session.requestReferenceSpace("viewer");
      const src = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
      if (this.session !== session) { src?.cancel(); return; } // session ended / restarted meanwhile
      this.noHitTest = !src;
      // laid down (the fallback) while the source was on its way: no per-frame hit tests once placed
      if (this.placed && !this.adjusting) { src?.cancel(); return; }
      this.hitSource = src;
    } catch {
      this.hitSource = null;
      this.noHitTest = true;
    }
  }

  /** Release the hit-test source and anchor (recenter, session end). */
  stop() {
    try { this.hitSource?.cancel(); } catch { /* session already ended */ }
    this.hitSource = null;
    this.dropAnchor();
    this.session = null;
    this.reticle.visible = false;
  }

  reset(session: XRSession | null) {
    this.stop();
    if (session) void this.start(session);
  }

  /** Forget the anchor (and any request still in flight). */
  private dropAnchor() {
    this.anchorGen++;
    try { this.anchor?.delete?.(); } catch { /* ended */ }
    this.anchor = null;
    this.relPending = false;
    this.wantAnchorAt = null;
  }

  /** The chart was put here on purpose: the lock starts from here. */
  private putAt(at: THREE.Vector3, yaw: number) {
    this.yaw = yaw;
    this.target.position.copy(at);
    this.target.rotation.set(0, yaw, 0);
    this.lock.reset(at, yaw);
  }

  update(frame: XRFrame | undefined, refSpace: XRReferenceSpace | null) {
    if (!frame || !refSpace) return;
    const now = performance.now();
    const dt = this.lastUpdate ? (now - this.lastUpdate) / 1000 : 0;
    this.lastUpdate = now;
    if (this.adjusting && now > this.adjustUntil) this.endAdjusting();
    if (!this.placed || this.adjusting) {
      const results = this.hitSource ? frame.getHitTestResults(this.hitSource) : [];
      let found: XRPose | undefined;
      for (const r of results) {
        const pose = r.getPose(refSpace);
        // a table top, not a wall or the underside of a shelf
        if (pose && pose.transform.matrix[5] >= LEVEL_COS) { found = pose; break; }
      }
      if (found) {
        this.reticle.visible = true;
        this.reticle.matrix.fromArray(found.transform.matrix);
      } else {
        this.reticle.visible = false;
      }
      if (!this.placed) return;
    }
    if (this.wantAnchorAt && frame.createAnchor) {
      const at = this.wantAnchorAt, session = this.session, gen = this.anchorGen;
      this.wantAnchorAt = null;
      try {
        frame.createAnchor(new XRRigidTransform({ x: at.x, y: at.y, z: at.z }), refSpace)
          ?.then((a) => {
            if (gen === this.anchorGen && this.session === session && this.placed) { this.anchor = a; this.relPending = true; }
            else a.delete();
          })
          .catch(() => undefined);
      } catch { /* anchors refused: the chart stays where it was put */ }
    }
    if (!this.anchor) return;
    const p = frame.getPose(this.anchor.anchorSpace, refSpace);
    if (!p) return; // not tracked this frame: hold still
    const { position: ap, orientation: ao } = p.transform;
    this.anchorPos.set(ap.x, ap.y, ap.z);
    this.anchorYaw = yawOf(ao);
    if (this.relPending) {
      // the chart's pose in the anchor's frame, from where it was put (it doesn't move now)
      this.relPending = false;
      this.rel.yaw = this.yaw - this.anchorYaw;
      this.rel.offset.copy(this.target.position).sub(this.anchorPos).applyAxisAngle(Y_UP, -this.anchorYaw);
      this.lock.reset(this.target.position, this.yaw);
      return;
    }
    this.want.copy(this.rel.offset).applyAxisAngle(Y_UP, this.anchorYaw).add(this.anchorPos);
    if (this.lock.step(this.want, this.anchorYaw + this.rel.yaw, dt)) {
      this.yaw = this.lock.yaw;
      this.target.position.copy(this.lock.pos);
      this.target.rotation.set(0, this.yaw, 0);
    }
  }

  /**
   * The reference space was reset (Quest: tracking recovered, the floor re-found). With an anchor its next pose is
   * the truth, taken at once; without one, the chart is carried by the reset's transform so it stays on the table.
   * `transform`: the new origin in the old space (null when unknown).
   */
  onReset(transform: { position: DOMPointReadOnly | { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } } | null | undefined) {
    this.reticle.visible = false;
    this.lock.snap();
    if (this.anchor || !this.placed || !transform) return;
    const { position: tp, orientation: to } = transform;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(tp.x, tp.y, tp.z), new THREE.Quaternion(to.x, to.y, to.z, to.w), new THREE.Vector3(1, 1, 1),
    ).invert();
    const at = this.target.position.clone().applyMatrix4(m);
    const turn = yawOf(new THREE.Quaternion(to.x, to.y, to.z, to.w).invert());
    this.putAt(at, this.yaw + turn);
    if (this.wantAnchorAt) this.wantAnchorAt.applyMatrix4(m);
  }

  /**
   * Lay the chart down at the reticle (or in front of the user if no surface was found). Once the chart is down it
   * moves only while adjusting after a Recenter, and then only for a pinch whose ray (`aim`) points at the ring.
   */
  async place(camera: THREE.Camera, aim?: THREE.Ray | null) {
    if (this.placed && !this.adjusting) return false; // laid down: only Recenter moves it
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    const at = new THREE.Vector3();
    if (this.reticle.visible) {
      at.setFromMatrixPosition(this.reticle.matrix);
      // adjusting: an ordinary pinch (a missed button, the globe) must not throw the chart across the room
      if (this.adjusting && (!aim || aim.distanceToPoint(at) > AIM_AT_RING_M)) return false;
      // a new spot: the old anchor (from the last placement or a recenter) must not pull the chart back
      this.dropAnchor();
      this.wantAnchorAt = at.clone();
    } else {
      if (this.adjusting || !this.canFallback) return false; // after a recenter the chart is already down in front
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
      fwd.y = 0; fwd.normalize();
      at.copy(camPos).addScaledVector(fwd, 0.75);
      at.y = camPos.y - 0.45;
      this.dropAnchor();
      if (this.session) this.wantAnchorAt = at.clone(); // world-lock the fallback spot too
    }
    // adjusting after a Recenter: the chart only slides onto the table; its turn (the wearer's seat toward them, or the
    // alignment) is kept. The first lay-down turns the wearer's own seat toward them.
    const wasAdjusting = this.adjusting;
    this.putAt(at, wasAdjusting ? this.yaw : faceSeatYaw(at, camPos, this.seatDeg()));
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
   * a pinch aimed at the ring lays it exactly there (`adjusting`, for ADJUST_MS). Never leaves the chart hidden.
   */
  recenter(camera: THREE.Camera, session: XRSession | null) {
    const eye = new THREE.Vector3(), fwd = new THREE.Vector3(0, 0, -1);
    camera.getWorldPosition(eye);
    fwd.applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    const tableY = this.placed ? this.target.position.y : undefined;
    const { at } = snapInFront(eye, fwd, tableY);
    const yaw = faceSeatYaw(at, eye, this.seatDeg());
    // the old anchor would pull the chart back to where it was
    this.dropAnchor();
    this.putAt(at, yaw);
    this.target.visible = true;
    this.placed = true;
    this.wantAnchorAt = session ? at.clone() : null;
    this.adjusting = Boolean(session);
    this.adjustUntil = performance.now() + ADJUST_MS;
    if (session && !this.hitSource) void this.requestHits(session);
    this.onPlaced?.();
  }

  /** Stop looking for the table after a Recenter: the chart stays where it is. */
  endAdjusting() {
    this.adjusting = false;
    this.reticle.visible = false;
    try { this.hitSource?.cancel(); } catch { /* ended */ }
    this.hitSource = null;
  }

  private async requestHits(session: XRSession) {
    try {
      const viewer = await session.requestReferenceSpace("viewer");
      const src = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
      if (this.session !== session || !this.adjusting) { src?.cancel(); return; }
      this.hitSource = src;
    } catch { this.hitSource = null; }
  }

  /** Turn the chart about its centre (the alignment step): on purpose, so the anchor keeps this turn. */
  setYaw(yaw: number) {
    this.yaw = yaw;
    this.target.rotation.set(0, yaw, 0);
    this.lock.reset(this.target.position, yaw);
    if (this.anchor && !this.relPending) this.rel.yaw = yaw - this.anchorYaw;
  }
  get currentYaw() { return this.yaw; }

  get canFallback() { return performance.now() >= this.fallbackAt || this.noHitTest; }
}

const Y_UP = new THREE.Vector3(0, 1, 0);
