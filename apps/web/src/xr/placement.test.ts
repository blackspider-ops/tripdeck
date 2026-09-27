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

// Quest MR recenter (user report: "Recentre doesn't work good") and the co-located alignment step (docs/03 §4)
import { BELOW_EYE, FRONT_DIST, alignYaw, rayOnPlane, snapInFront } from "./placement";

describe("snapInFront", () => {
  it("puts the chart straight ahead, level, facing the viewer (+z toward them), at the table height when known", () => {
    const eye = new THREE.Vector3(1, 1.6, 2);
    const { at, yaw } = snapInFront(eye, new THREE.Vector3(0, -0.8, -1)); // looking down and ahead (−z)
    expect(at.x).toBeCloseTo(1); expect(at.z).toBeCloseTo(2 - FRONT_DIST); expect(at.y).toBeCloseTo(1.6 - BELOW_EYE);
    const plusZ = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const toEye = eye.clone().sub(at).setY(0).normalize();
    expect(plusZ.dot(toEye)).toBeCloseTo(1);
    expect(snapInFront(eye, new THREE.Vector3(1, 0, 0), 0.74).at.y).toBe(0.74);
    // looking straight down still lands somewhere sensible
    expect(Number.isFinite(snapInFront(eye, new THREE.Vector3(0, -1, 0)).at.z)).toBe(true);
  });
});

describe("Placement.recenter (mixed reality)", () => {
  it("never hides the chart: it snaps in front at once, keeps the table height, drops the old anchor and asks for surfaces again", async () => {
    const target = new THREE.Group();
    const p = new Placement(target);
    const { s, src } = session("yes");
    await p.start(s);
    const cam = camera();
    now += 4000;
    await p.place(cam); // no surface seen: the fallback in front
    const tableY = target.position.y;
    const oldAnchor = { delete: vi.fn(), anchorSpace: {} };
    (p as unknown as { anchor: unknown }).anchor = oldAnchor;
    const placed = vi.fn();
    p.onPlaced = placed;
    cam.position.set(2, 1.6, 0); cam.rotation.set(0, Math.PI / 2, 0); cam.updateMatrixWorld(); // turned to face −x
    p.recenter(cam, s);
    expect(target.visible).toBe(true);
    expect(p.placed).toBe(true);
    expect(p.adjusting).toBe(true);
    expect(oldAnchor.delete).toHaveBeenCalled();
    expect(target.position.y).toBeCloseTo(tableY);
    expect(target.position.x).toBeCloseTo(2 - FRONT_DIST);
    expect(placed).toHaveBeenCalledOnce();
    await Promise.resolve(); await Promise.resolve();
    expect(s.requestHitTestSource).toHaveBeenCalledTimes(2); // a fresh source to find the table again
    expect(src.cancel).toHaveBeenCalled(); // the first one was released at the first placement
  });
  it("while adjusting, a pinch with no surface under the ring keeps the chart where it is", async () => {
    const target = new THREE.Group();
    const p = new Placement(target);
    const { s } = session("yes");
    await p.start(s);
    p.recenter(camera(), s);
    const at = target.position.clone();
    expect(await p.place(camera())).toBe(false);
    expect(target.position.equals(at)).toBe(true);
    // the laptop / no session: a plain snap, no adjusting
    const q = new Placement(new THREE.Group());
    q.recenter(camera(), null);
    expect(q.adjusting).toBe(false);
    expect(q.placed).toBe(true);
  });
});

describe("alignYaw (pinch the table corner nearest you)", () => {
  const center = new THREE.Vector3(0, 0.75, 0);
  const seatDir = (yaw: number, deg: number) => {
    const r = (deg * Math.PI) / 180;
    return new THREE.Vector3(Math.cos(r), 0, Math.sin(r)).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  };
  it("turns the chart so the viewer's own seat points at their corner, for any seat", () => {
    for (const [cx, cz] of [[0.6, 0.4], [-0.5, 0.5], [-0.6, -0.4], [0.5, -0.5]]) {
      const corner = new THREE.Vector3(cx, 0.75, cz);
      for (const deg of [90, 205, 335, 355, 12]) {
        const yaw = alignYaw(center, corner, deg);
        const want = corner.clone().sub(center).setY(0).normalize();
        expect(seatDir(yaw, deg).dot(want)).toBeCloseTo(1, 6);
      }
    }
  });
  it("the organizer's seat (south, 90°) facing the viewer matches the plain placement's yaw", () => {
    const corner = new THREE.Vector3(0, 0.75, 1); // straight toward +z
    expect(alignYaw(center, corner, 90)).toBeCloseTo(0, 6);
  });
  it("rayOnPlane meets the table top, or not (a ray pointing up)", () => {
    const down = new THREE.Ray(new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(0.5, -1, -0.5).normalize());
    expect(rayOnPlane(down, 0.75)!.y).toBeCloseTo(0.75);
    expect(rayOnPlane(new THREE.Ray(new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(0, 1, 0)), 0.75)).toBeNull();
  });
});

// Quest 3S report: "the globe keeps jumping forward and backward, here and there, and is not bound". Once down, the
// chart is world-locked to one anchor (deadband + easing), moved only on purpose, and survives a reference-space reset.
import { AIM_AT_RING_M, LOCK_DEADBAND_M, LOCK_SNAP_M, PoseLock, yawOf } from "./placement";

describe("PoseLock (anchor noise never moves the chart)", () => {
  const at = new THREE.Vector3(0.2, 0.74, -0.8);
  it("jitter inside the deadband: the chart doesn't move at all", () => {
    const lock = new PoseLock();
    lock.reset(at, 0.3);
    for (let i = 0; i < 300; i++) {
      const j = at.clone().add(new THREE.Vector3(Math.sin(i) * 0.003, Math.cos(i * 1.7) * 0.003, Math.sin(i * 2.3) * 0.003));
      expect(lock.step(j, 0.3 + Math.sin(i) * 0.004, 1 / 72)).toBe(false);
    }
    expect(lock.pos.equals(at)).toBe(true);
    expect(lock.yaw).toBe(0.3);
  });
  it("a real correction past the deadband eases in (no jump), all the way", () => {
    const lock = new PoseLock();
    lock.reset(at, 0);
    const want = at.clone().add(new THREE.Vector3(0.05, 0, 0));
    lock.step(want, 0, 1 / 72);
    const first = lock.pos.distanceTo(at);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(0.01); // one frame moves a little, never the whole way
    for (let i = 0; i < 200; i++) lock.step(want, 0, 1 / 72);
    expect(lock.pos.distanceTo(want)).toBeLessThan(1e-6);
  });
  it("a relocalization (past LOCK_SNAP_M) or the first pose after snap() is taken at once", () => {
    const lock = new PoseLock();
    lock.reset(at, 0);
    const far = at.clone().add(new THREE.Vector3(LOCK_SNAP_M + 0.1, 0, 0));
    lock.step(far, 1, 1 / 72);
    expect(lock.pos.equals(far)).toBe(true);
    expect(lock.yaw).toBe(1);
    lock.snap();
    const near = far.clone().add(new THREE.Vector3(0.02, 0, 0));
    lock.step(near, 1, 1 / 72);
    expect(lock.pos.equals(near)).toBe(true);
  });
  it("yawOf reads the heading of an orientation", () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.8);
    expect(yawOf(q)).toBeCloseTo(0.8);
  });
});

// a fake XR frame: anchors and hit-test results under the test's control
class FakeRigid { constructor(public position: { x: number; y: number; z: number }) { /* */ } }
function fakeFrame() {
  const poses = new Map<object, { p: THREE.Vector3; yaw: number }>();
  const pending: { resolve: (a: unknown) => void; at: { x: number; y: number; z: number } }[] = [];
  const hits: { matrix: number[] }[] = [];
  const frame = {
    createAnchor: vi.fn((t: FakeRigid) => new Promise((resolve) => pending.push({ resolve, at: t.position }))),
    getPose: (space: object) => {
      const a = poses.get(space);
      if (!a) return null;
      const o = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a.yaw);
      return { transform: { position: { x: a.p.x, y: a.p.y, z: a.p.z }, orientation: { x: o.x, y: o.y, z: o.z, w: o.w } } };
    },
    getHitTestResults: () => hits.map((h) => ({ getPose: () => ({ transform: { matrix: h.matrix } }) })),
  };
  /** Resolve the i-th anchor request: an anchor tracked at its requested spot (moved later via `poses`). */
  const resolve = (i: number) => {
    const space = {};
    const anchor = { anchorSpace: space, delete: vi.fn() };
    const r = pending[i];
    poses.set(space, { p: new THREE.Vector3(r.at.x, r.at.y, r.at.z), yaw: 0 });
    r.resolve(anchor);
    return { anchor, pose: poses.get(space)! };
  };
  return { frame: frame as unknown as XRFrame, pending, resolve, hits };
}
const REF = {} as XRReferenceSpace;
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
/** A level hit-test pose at (x, y, z); `wall`: its normal points sideways. */
const hitAt = (x: number, y: number, z: number, wall = false) =>
  ({ matrix: (wall ? new THREE.Matrix4().makeRotationZ(Math.PI / 2) : new THREE.Matrix4()).setPosition(x, y, z).toArray() });

describe("Placement: world-locked once down", () => {
  beforeEach(() => { (globalThis as unknown as { XRRigidTransform: unknown }).XRRigidTransform = FakeRigid; });

  async function placed() {
    const target = new THREE.Group();
    const p = new Placement(target);
    const { s } = session("yes");
    await p.start(s);
    const f = fakeFrame();
    f.hits.push(hitAt(0, 0.74, -0.7));
    p.update(f.frame, REF);
    expect(p.reticle.visible).toBe(true);
    expect(await p.place(camera())).toBe(true);
    now += 14; p.update(f.frame, REF); // the next frame asks for the anchor
    expect(f.frame.createAnchor).toHaveBeenCalledTimes(1);
    const a = f.resolve(0);
    await flush();
    now += 14; p.update(f.frame, REF);
    return { target, p, s, f, a };
  }

  it("anchor jitter under the deadband never moves the chart root, frame after frame", async () => {
    const { target, p, f, a } = await placed();
    const home = target.position.clone(), yaw = target.rotation.y;
    for (let i = 0; i < 500; i++) {
      a.pose.p.set(Math.sin(i * 0.9) * 0.003, 0.74 + Math.cos(i * 1.3) * 0.003, -0.7 + Math.sin(i * 2.1) * 0.003);
      a.pose.yaw = Math.sin(i) * 0.004;
      now += 14; p.update(f.frame, REF);
      expect(target.position.distanceTo(home)).toBe(0);
      expect(target.rotation.y).toBe(yaw);
    }
    expect(LOCK_DEADBAND_M).toBeGreaterThan(Math.sqrt(3) * 0.003);
  });

  it("once down, an ordinary pinch (the globe, a panel button, empty space) never moves it", async () => {
    const { target, p, f } = await placed();
    const home = target.position.clone();
    f.hits.length = 0; f.hits.push(hitAt(1.5, 0.2, 0.4)); // the head now looks at the floor elsewhere
    now += 14; p.update(f.frame, REF);
    const cam = camera(); cam.position.set(1, 1.6, 1); cam.updateMatrixWorld();
    for (let i = 0; i < 5; i++) expect(await p.place(cam, new THREE.Ray(cam.position.clone(), new THREE.Vector3(0, -1, 0)))).toBe(false);
    expect(target.position.equals(home)).toBe(true);
    expect(f.frame.createAnchor).toHaveBeenCalledTimes(1); // no re-anchoring either
  });

  it("an anchor asked for an older spot that resolves late is thrown away (no pull back)", async () => {
    const target = new THREE.Group();
    const p = new Placement(target);
    const { s } = session("yes");
    await p.start(s);
    const f = fakeFrame();
    f.hits.push(hitAt(0, 0.74, -0.7));
    p.update(f.frame, REF);
    await p.place(camera());
    now += 14; p.update(f.frame, REF); // anchor #0 requested at the first spot
    const cam = camera(); cam.rotation.set(0, Math.PI / 2, 0); cam.updateMatrixWorld();
    p.recenter(cam, s); // put in front (−x) on purpose
    now += 14; p.update(f.frame, REF); // anchor #1 requested there
    const there = target.position.clone();
    const late = f.resolve(0); // the old one resolves last
    await flush();
    for (let i = 0; i < 10; i++) { now += 14; p.update(f.frame, REF); }
    expect(late.anchor.delete).toHaveBeenCalled();
    expect(target.position.equals(there)).toBe(true);
    f.resolve(1);
    await flush();
    for (let i = 0; i < 10; i++) { now += 14; p.update(f.frame, REF); }
    expect(target.position.distanceTo(there)).toBeLessThan(1e-9);
  });

  it("the table really shifts (anchor moves 4 cm): the chart follows smoothly; the alignment turn is kept", async () => {
    const { target, p, f, a } = await placed();
    p.setYaw(1.2);
    a.pose.p.x += 0.04;
    now += 14; p.update(f.frame, REF);
    expect(target.position.x).toBeGreaterThan(0);
    expect(target.position.x).toBeLessThan(0.01);
    for (let i = 0; i < 300; i++) { now += 14; p.update(f.frame, REF); }
    expect(target.position.x).toBeCloseTo(0.04, 5);
    expect(target.rotation.y).toBeCloseTo(1.2, 6);
  });

  it("adjusting after a Recenter: only a pinch aimed at the ring moves the chart; it ends by itself", async () => {
    const { target, p, s, f } = await placed();
    p.recenter(camera(), s);
    await flush();
    const home = target.position.clone();
    f.hits.length = 0; f.hits.push(hitAt(0.5, 0.74, -0.9));
    now += 14; p.update(f.frame, REF);
    expect(p.reticle.visible).toBe(true);
    const eye = new THREE.Vector3(0, 1.6, 0);
    const awayRay = new THREE.Ray(eye.clone(), new THREE.Vector3(-1, -0.5, 0).normalize());
    expect(await p.place(camera(), awayRay)).toBe(false);
    expect(await p.place(camera())).toBe(false); // no ray: not aimed
    expect(target.position.equals(home)).toBe(true);
    const ring = new THREE.Vector3(0.5, 0.74, -0.9);
    const aimed = new THREE.Ray(eye.clone(), ring.clone().sub(eye).normalize());
    expect(aimed.distanceToPoint(ring)).toBeLessThan(AIM_AT_RING_M);
    expect(await p.place(camera(), aimed)).toBe(true);
    expect(target.position.distanceTo(ring)).toBeLessThan(1e-9);
    // a second Recenter, then nobody pinches: adjusting times out and the chart stays
    p.recenter(camera(), s);
    now += 21_000; p.update(f.frame, REF);
    expect(p.adjusting).toBe(false);
  });

  it("the ring ignores walls (a hit whose normal isn't up)", async () => {
    const p = new Placement(new THREE.Group());
    await p.start(session("yes").s);
    const f = fakeFrame();
    f.hits.push(hitAt(0, 1.2, -1, true));
    p.update(f.frame, REF);
    expect(p.reticle.visible).toBe(false);
  });

  it("a reference-space reset without an anchor carries the chart so it stays on the real table", async () => {
    const target = new THREE.Group();
    const p = new Placement(target);
    await p.start(session("no").s); // no hit test, and (below) no anchors
    now += 4000;
    await p.place(camera());
    const before = target.position.clone(); // (0, 1.15, -0.75) in the old space
    // the new origin sits 1 m along old +x, turned 90° about +y
    const o = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    p.onReset({ position: { x: 1, y: 0, z: 0 }, orientation: { x: o.x, y: o.y, z: o.z, w: o.w } });
    // same real spot, in new coordinates: old = T·new ⇒ new = T⁻¹·old
    const want = before.clone().applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(1, 0, 0), o, new THREE.Vector3(1, 1, 1)).invert());
    expect(target.position.distanceTo(want)).toBeLessThan(1e-9);
    expect(target.rotation.y).toBeCloseTo(-Math.PI / 2, 6);
    // with an anchor, the anchor's next pose is taken at once (no glide across the room)
    const { target: t2, p: p2, f, a } = await placed();
    a.pose.p.x += 0.1; // under LOCK_SNAP_M, but it's a reset
    p2.onReset(null);
    now += 14; p2.update(f.frame, REF);
    expect(t2.position.x).toBeCloseTo(0.1, 9);
  });
});

// User report (Quest 3S): "after Recenter the chart turns 90°" / "the recenter actually goes to Hana's view". Recenter
// turned the chart's +z (the seat at 90°) to the viewer, whoever sat there, instead of the wearer's own seat.
import { faceSeatYaw } from "./placement";
import { seatAngle } from "../shared-ui/seating";
import { GlobeSpin } from "../scene/globeSpin";
import type { CrewPublic } from "@all-ayes/shared";

describe("recenter keeps the wearer's own seat toward them", () => {
  const crew5 = ["org", "hana", "ivo", "june", "kai"].map((id, i) => ({ memberId: id, name: id, role: "member", band: ((i % 3) + 1) as 1, briefSealed: true })) as unknown as CrewPublic[];
  /** The world direction (flat) from the chart's centre to the seat at `deg`, with the chart turned by `yaw`. */
  const seatDir = (deg: number, yaw: number) => {
    const r = (deg * Math.PI) / 180;
    return new THREE.Vector3(Math.cos(r), 0, Math.sin(r)).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  };
  const toEye = (at: THREE.Vector3, eye: THREE.Vector3) => eye.clone().sub(at).setY(0).normalize();

  it("faceSeatYaw points each member's seat (5 aboard) straight at the eye", () => {
    const at = new THREE.Vector3(0.3, 0.74, -0.6), eye = new THREE.Vector3(-0.2, 1.5, 0.1);
    for (const m of crew5) {
      const deg = seatAngle(crew5, "org", m.memberId);
      expect(seatDir(deg, faceSeatYaw(at, eye, deg)).dot(toEye(at, eye)), m.memberId).toBeCloseTo(1, 9);
    }
    // the organizer's seat (90°) keeps the old behaviour: +z at the viewer
    expect(faceSeatYaw(at, eye, 90)).toBeCloseTo(Math.atan2(eye.x - at.x, eye.z - at.z), 9);
  });

  it("Placement.recenter: Hana's headset gets Hana's seat, not whoever sits at +z; twice gives the same turn", async () => {
    const target = new THREE.Group();
    const p = new Placement(target);
    const hana = seatAngle(crew5, "org", "hana");
    expect(hana).not.toBe(90);
    p.seatDeg = () => hana;
    const { s } = session("yes");
    await p.start(s);
    const cam = camera(); cam.position.set(1, 1.6, 0.5); cam.rotation.set(0, 0.7, 0); cam.updateMatrixWorld();
    p.recenter(cam, s);
    const yaw1 = target.rotation.y;
    const eye = cam.getWorldPosition(new THREE.Vector3());
    expect(seatDir(hana, yaw1).dot(toEye(target.position, eye))).toBeCloseTo(1, 6);
    p.recenter(cam, s);
    expect(target.rotation.y).toBeCloseTo(yaw1, 9);
    expect(p.currentYaw).toBeCloseTo(yaw1, 9);
  });

  it("setting it down on the ring after a Recenter keeps the turn (no 90° jump)", async () => {
    const target = new THREE.Group();
    const p = new Placement(target);
    p.seatDeg = () => 20;
    const { s } = session("yes");
    await p.start(s);
    p.recenter(camera(), s);
    const yaw = target.rotation.y;
    // a surface under the ring, a pinch aimed at it
    const ring = new THREE.Vector3(0.3, 0.74, -0.8);
    p.reticle.matrix.makeTranslation(ring.x, ring.y, ring.z);
    p.reticle.visible = true;
    const eye = new THREE.Vector3(0, 1.6, 0);
    expect(await p.place(camera(), new THREE.Ray(eye, ring.clone().sub(eye).normalize()))).toBe(true);
    expect(target.rotation.y).toBeCloseTo(yaw, 9);
  });
});

describe("the globe's spin never turns the chart", () => {
  it("drags, flicks and inertia change only the globe's spin/tilt groups", () => {
    const root = new THREE.Group(); root.rotation.set(0, 0.4, 0); root.position.set(0.2, 0.74, -0.6);
    const stand = new THREE.Group(), tilt = new THREE.Group(), spin = new THREE.Group();
    tilt.position.y = 0.2;
    root.add(stand); stand.add(tilt); tilt.add(spin);
    root.updateMatrixWorld(true);
    const before = { root: root.quaternion.clone(), stand: stand.quaternion.clone(), pos: root.position.clone() };
    const g = new GlobeSpin(stand, tilt, spin, 0.16);
    const onGlobe = (a: number) => stand.localToWorld(new THREE.Vector3(Math.sin(a) * 0.16, 0.2, Math.cos(a) * 0.16));
    g.grabAt(onGlobe(0), 0);
    for (let i = 1; i <= 10; i++) g.dragTo(onGlobe(i * 0.2), i * 16);
    g.release(170);
    for (let i = 0; i < 100; i++) g.tick(1 / 60);
    expect(spin.rotation.y).not.toBe(0);
    expect(root.quaternion.equals(before.root)).toBe(true);
    expect(stand.quaternion.equals(before.stand)).toBe(true);
    expect(root.position.equals(before.pos)).toBe(true);
  });
});
