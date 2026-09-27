// The chart room's hand spin (docs/03 §4), kept apart from the Globe's drawing so it can be tested headless.
// User report (Quest 3S): "the globe keeps jumping … here and there". A drag only ever turns the globe: yaw about its
// own axis (the `spin` group) and a clamped pitch (the `tilt` group). It never touches a position or a scale, a single
// frame's turn is bounded (a ray sliding over the pole, or off the sphere, can't flip it), and the inertia after a
// flick is bounded and dies out.
import * as THREE from "three";
import { angleDelta, spinFriction } from "./geo";

/** Pitch (tilt about the globe's east–west axis) stays within ±this (rad, ≈ 43°). */
export const PITCH_MAX = 0.75;
/** The most one drag step may turn the globe, either way (rad). */
export const SPIN_STEP_MAX = 0.35;
/** Inertia after a flick is capped at this (rad/s). */
export const SPIN_VEL_MAX = 6;
/** A hand held this still this long before letting go leaves the globe where it is (ms). */
const STILL_MS = 120;

export const clampPitch = (x: number) => Math.max(-PITCH_MAX, Math.min(PITCH_MAX, x));
const clampStep = (x: number) => Math.max(-SPIN_STEP_MAX, Math.min(SPIN_STEP_MAX, x));

/**
 * The turn that carries the grabbed point `prev` to `cur` (both relative to the globe's centre, in the stand's frame,
 * which never turns). Yaw: the change of the point's azimuth, faded out near the poles (where the azimuth is
 * meaningless and would swing wildly). Pitch: the change of its latitude, signed by which side of the globe it is on
 * (pull the near side up and the globe tips back). Both are clamped to SPIN_STEP_MAX.
 */
export function dragRotation(prev: THREE.Vector3, cur: THREE.Vector3, r: number): { yaw: number; pitch: number } {
  const rhoP = Math.hypot(prev.x, prev.z), rhoC = Math.hypot(cur.x, cur.z);
  const poleFade = Math.min(1, Math.min(rhoP, rhoC) / (0.35 * r));
  const yaw = rhoP > 1e-6 && rhoC > 1e-6 ? angleDelta(Math.atan2(prev.x, prev.z), Math.atan2(cur.x, cur.z)) * poleFade : 0;
  const lat = (v: THREE.Vector3) => Math.asin(Math.max(-1, Math.min(1, v.y / Math.max(1e-6, v.length()))));
  // rotation.x = θ moves a point at depth z by dy = −z·dθ: the near side (z > 0) comes up for a negative θ
  const side = Math.max(-1, Math.min(1, (prev.z + cur.z) / 2 / (0.35 * r)));
  const pitch = -(lat(cur) - lat(prev)) * side;
  return { yaw: clampStep(yaw), pitch: clampStep(pitch) };
}

/** The hand on the globe: `tilt` (x only) and `spin` (y only) are the only things it ever changes. */
export class GlobeSpin {
  private grab: { prev: THREE.Vector3; lastAt: number } | null = null;
  private vel = 0;
  private tmp = new THREE.Vector3();
  private lastTouch = -Infinity;

  /** `frame`: the stand (the tilt's parent, which doesn't turn); `r`: the globe's radius in that frame. */
  constructor(private frame: THREE.Object3D, private tilt: THREE.Object3D, private spin: THREE.Object3D, private r: number) {}

  /** A world point → relative to the globe's centre, in the stand's frame. */
  private local(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return this.frame.worldToLocal(out.copy(world)).sub(this.tilt.position);
  }

  grabAt(world: THREE.Vector3, now: number) {
    this.grab = { prev: this.local(world, new THREE.Vector3()), lastAt: now };
    this.vel = 0;
    this.lastTouch = now;
  }

  dragTo(world: THREE.Vector3, now: number) {
    const g = this.grab;
    if (!g) return;
    const cur = this.local(world, this.tmp);
    const { yaw, pitch } = dragRotation(g.prev, cur, this.r);
    this.spin.rotation.y += yaw;
    this.tilt.rotation.x = clampPitch(this.tilt.rotation.x + pitch);
    const dt = Math.max(1e-3, (now - g.lastAt) / 1000);
    this.vel = Math.max(-SPIN_VEL_MAX, Math.min(SPIN_VEL_MAX, yaw / dt));
    g.prev.copy(cur);
    g.lastAt = now;
    this.lastTouch = now;
  }

  release(now: number) {
    if (this.grab && now - this.grab.lastAt > STILL_MS) this.vel = 0; // held still before letting go
    this.grab = null;
    this.vel = Math.max(-SPIN_VEL_MAX, Math.min(SPIN_VEL_MAX, this.vel));
    this.lastTouch = now;
  }

  /** Per frame (s): the inertia after a flick, yaw only. */
  tick(dt: number) {
    if (this.grab || !this.vel) return;
    this.spin.rotation.y += this.vel * Math.max(0, Math.min(dt, 0.1));
    this.vel = spinFriction(this.vel, dt);
  }

  get held() { return Boolean(this.grab); }
  get spinning() { return Boolean(this.grab) || this.vel !== 0; }
  /** When a hand last touched it (ms): the auto-turn to the city under discussion waits a little after that. */
  get touchedAt() { return this.lastTouch; }
}
