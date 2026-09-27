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
