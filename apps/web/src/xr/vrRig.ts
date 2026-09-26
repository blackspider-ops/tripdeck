// The VR chart room (Gear VR / Cardboard, doc 04 §9): no real table to find, so the chart sits on a round walnut
// table at a fixed seated pose inside a dim room, and "Recenter" turns the whole room to face where the head points.
// 3DoF only: the viewer never walks, so the rig follows the head's position (x/z) on recenter too.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import { M } from "../scene/materials";

/** Where the chart sits for a seated viewer (reference space 'local': the origin is the eye at session start). */
export const VR_TABLE = {
  /** Chart centre, metres in front of the eye. */
  distance: 0.9,
  /** Chart surface, metres below the eye. */
  drop: 0.5,
  /** The tabletop scene is scaled up so the globe, pieces and cloches read at Gear VR resolution (~13 px/°). */
  scale: 1.4,
} as const;
/** Seated eye height: where the floor goes. */
export const VR_EYE_HEIGHT = 1.2;
/** The walnut tabletop under the chart (world metres): the chart and baize (Ø0.82 m × 1.4) plus a rim. The laptop
 *  view's Ø1.9 m top, scaled up, would reach behind a seated viewer. */
export const VR_TABLE_RADIUS = 0.64;
/** The Exit plaque: straight below the eyes, just in front of the chest (look down to leave VR). */
export const VR_EXIT_POS = { y: -0.62, z: -0.14 } as const;

/** Heading (radians about +Y) of a view orientation; 0 looks down −Z. Looking straight up/down uses the view's up. */
export function yawOf(q: THREE.Quaternion): number {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  if (f.x * f.x + f.z * f.z < 1e-6) {
    const up = f.y > 0;
    f.set(0, 1, 0).applyQuaternion(q);
    if (up) f.negate(); // looking straight up: the top of the view points backwards
  }
  return Math.atan2(-f.x, -f.z);
}

/** Pitch (radians, + up) of a view orientation. */
export function pitchOf(q: THREE.Quaternion): number {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
}

/** The rig pose that puts the chart `VR_TABLE.distance` ahead of this head, facing it. */
export function recenterPose(headPos: THREE.Vector3, headQuat: THREE.Quaternion): { x: number; z: number; yaw: number } {
  return { x: headPos.x, z: headPos.z, yaw: yawOf(headQuat) };
}

/** Floor, walls, a walnut table (4 draw calls), plus the anchor's seated pose. The anchor is re-parented here while
 *  in VR (XRApp) and handed back on exit; so are the Exit plaque (`mount`) and anything else that turns with the room. */
export class VRRig {
  readonly group = new THREE.Group();
  private props = new THREE.Group();

  constructor() {
    const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 32), M.woodDark());
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -VR_EYE_HEIGHT;
    // the dark chart room: one inward-facing cylinder, unlit so it costs nothing and never shows banding
    const walls = new THREE.Mesh(
      new THREE.CylinderGeometry(4, 4, 4.2, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.room).multiplyScalar(0.85), side: THREE.BackSide }),
    );
    walls.position.y = -VR_EYE_HEIGHT + 2.1;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(VR_TABLE_RADIUS, VR_TABLE_RADIUS, 0.05, 48), M.woodDark());
    top.position.set(0, -VR_TABLE.drop - 0.025, -VR_TABLE.distance);
    const tableUnderside = -VR_TABLE.drop - 0.05;
    const legH = VR_EYE_HEIGHT + tableUnderside;
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.22, legH, 16), M.woodDark());
    pedestal.position.set(0, -VR_EYE_HEIGHT + legH / 2, -VR_TABLE.distance);
    this.props.add(floor, walls, top, pedestal);
    this.group.add(this.props);
  }

  /** Seat the chart (`anchor`) on the rig at the fixed seated pose. */
  seat(anchor: THREE.Object3D) {
    this.group.add(anchor);
    anchor.position.set(0, -VR_TABLE.drop, -VR_TABLE.distance);
    anchor.rotation.set(0, 0, 0);
    anchor.scale.setScalar(VR_TABLE.scale);
    anchor.visible = true;
  }

  /** Hang something on the rig at the Exit plaque's spot, tilted up to face the eyes. */
  mountExit(obj: THREE.Object3D) {
    this.group.add(obj);
    obj.position.set(0, VR_EXIT_POS.y, VR_EXIT_POS.z);
    obj.rotation.set(-Math.PI / 2 + Math.atan2(-VR_EXIT_POS.z, -VR_EXIT_POS.y), 0, 0);
  }

  /** Turn the room to face the head (and follow its x/z). */
  recenter(headPos: THREE.Vector3, headQuat: THREE.Quaternion) {
    const p = recenterPose(headPos, headQuat);
    this.group.position.set(p.x, 0, p.z);
    this.group.rotation.set(0, p.yaw, 0);
    this.group.updateMatrixWorld(true);
  }

  dispose() {
    this.group.removeFromParent();
    this.props.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      if (m.material !== M.woodDark()) (m.material as THREE.Material).dispose();
    });
  }
}

/**
 * Head-locked-ish placement for the caption card: it rests ~1.5 m ahead, a little below the gaze, and only glides
 * after the head has turned well away (a dead zone), so reading it never means chasing it.
 */
export class LazyFollow {
  private want = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private e = new THREE.Euler(0, 0, 0, "YXZ");
  private q = new THREE.Quaternion();
  private moving = false;
  private placed = false;

  constructor(private obj: THREE.Object3D, private dist = 1.5, private below = 0.3, private startDeg = 22, private stopDeg = 4) {}

  reset() { this.placed = false; this.moving = false; }

  update(dt: number, headPos: THREE.Vector3, headQuat: THREE.Quaternion) {
    const pitch = THREE.MathUtils.clamp(pitchOf(headQuat) - this.below, -1.2, 0.6);
    this.e.set(pitch, yawOf(headQuat), 0);
    this.dir.set(0, 0, -1).applyQuaternion(this.q.setFromEuler(this.e));
    this.want.copy(headPos).addScaledVector(this.dir, this.dist);
    const o = this.obj;
    if (!this.placed) {
      o.position.copy(this.want);
      this.placed = true;
    } else {
      // angle between where it is and where it wants to be, seen from the head
      const a = o.position.clone().sub(headPos).normalize().angleTo(this.dir) * THREE.MathUtils.RAD2DEG;
      if (a > this.startDeg) this.moving = true;
      else if (a < this.stopDeg) this.moving = false;
      if (this.moving) o.position.lerp(this.want, 1 - Math.exp(-dt * 3));
      // hold the distance even while resting (the head moves a little with a neck model)
      o.position.sub(headPos).setLength(this.dist).add(headPos);
    }
    o.lookAt(headPos);
  }
}
