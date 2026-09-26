// Gear VR / Cardboard: recenter turns the room so the chart sits 0.9 m ahead of the head, facing it.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { LazyFollow, VRRig, VR_TABLE, pitchOf, recenterPose, yawOf } from "./vrRig";

const look = (yawDeg: number, pitchDeg = 0) =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(pitchDeg * THREE.MathUtils.DEG2RAD, yawDeg * THREE.MathUtils.DEG2RAD, 0, "YXZ"));

describe("recenter math", () => {
  it("yaw is the heading, whatever the pitch or roll", () => {
    expect(yawOf(look(0))).toBeCloseTo(0);
    expect(yawOf(look(90))).toBeCloseTo(Math.PI / 2);
    expect(yawOf(look(-135, -40))).toBeCloseTo((-135 * Math.PI) / 180);
    const rolled = look(30, 10).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4));
    expect(yawOf(rolled)).toBeCloseTo((30 * Math.PI) / 180, 1);
    expect(pitchOf(look(0, -30))).toBeCloseTo((-30 * Math.PI) / 180);
  });

  it("looking straight down still has a heading (the top of the view)", () => {
    expect(yawOf(look(90, -90))).toBeCloseTo(Math.PI / 2, 3);
  });

  it("the chart lands ahead of the head, below the eye, its +z facing the viewer", () => {
    const rig = new VRRig();
    const anchor = new THREE.Group();
    rig.seat(anchor);
    const head = new THREE.Vector3(0.1, 0.05, -0.2);
    rig.recenter(head, look(-90, -20)); // looking along +x, a little down
    anchor.updateMatrixWorld(true);
    const at = anchor.getWorldPosition(new THREE.Vector3());
    expect(at.x).toBeCloseTo(head.x + VR_TABLE.distance);
    expect(at.z).toBeCloseTo(head.z);
    expect(at.y).toBeCloseTo(-VR_TABLE.drop);
    const plusZ = new THREE.Vector3(0, 0, 1).transformDirection(anchor.matrixWorld);
    expect(plusZ.x).toBeCloseTo(-1); // back toward the viewer
    expect(anchor.getWorldScale(new THREE.Vector3()).x).toBeCloseTo(VR_TABLE.scale);
    expect(recenterPose(head, look(-90))).toEqual({ x: 0.1, z: -0.2, yaw: expect.closeTo(-Math.PI / 2) });
    rig.dispose();
  });
});

describe("LazyFollow (VR caption)", () => {
  it("starts ahead at 1.5 m, holds still for small head turns, glides after a big one", () => {
    const card = new THREE.Object3D();
    const f = new LazyFollow(card, 1.5, 0.3);
    const head = new THREE.Vector3();
    f.update(0.016, head, look(0));
    const first = card.position.clone();
    expect(first.length()).toBeCloseTo(1.5);
    expect(first.z).toBeLessThan(0);
    f.update(0.016, head, look(10)); // inside the dead zone
    expect(card.position.distanceTo(first)).toBeLessThan(1e-6);
    for (let i = 0; i < 200; i++) f.update(0.016, head, look(90));
    expect(card.position.x).toBeLessThan(-1.2); // now off to the left (+90° yaw looks down −x)
    expect(card.position.length()).toBeCloseTo(1.5);
  });
});
