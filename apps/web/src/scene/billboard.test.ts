// R2-WP-15 / O2-054: the shared billboard aims exactly like Object3D.lookAt, from last frame's matrices.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { billboard } from "./billboard";

describe("billboard", () => {
  it("matches Object3D.lookAt under a rotated, scaled, moved parent chain", () => {
    const root = new THREE.Group();
    root.position.set(0.3, 1, -2);
    root.rotation.set(0.2, 1.1, -0.3);
    const mid = new THREE.Group();
    mid.scale.setScalar(0.6);
    mid.rotation.y = 0.7;
    mid.position.set(0.1, 0.05, 0);
    root.add(mid);
    const a = new THREE.Object3D(), b = new THREE.Object3D();
    a.position.set(0.02, 0.1, 0.03);
    b.position.copy(a.position);
    mid.add(a, b);
    root.updateMatrixWorld(true); // the renderer did this last frame
    const cam = new THREE.Vector3(1.5, 2, 3);
    a.lookAt(cam);
    billboard(b, cam);
    expect(b.quaternion.angleTo(a.quaternion)).toBeLessThan(1e-6);
  });

  it("aims a batch member relative to the batch", () => {
    const batch = new THREE.Group();
    batch.position.set(0, 0.5, 0);
    batch.rotation.x = 0.4;
    batch.updateMatrixWorld(true);
    const label = new THREE.Object3D(); // not a scene child, like a BatchedText member
    label.position.set(0.1, 0, 0);
    const twin = new THREE.Object3D();
    twin.position.copy(label.position);
    batch.add(twin);
    batch.updateMatrixWorld(true);
    const cam = new THREE.Vector3(-1, 1, 2);
    twin.lookAt(cam);
    billboard(label, cam, batch);
    expect(label.quaternion.angleTo(twin.quaternion)).toBeLessThan(1e-6);
  });

  it("does nothing without a parent", () => {
    const o = new THREE.Object3D();
    billboard(o, new THREE.Vector3(1, 0, 0));
    expect(o.quaternion.equals(new THREE.Quaternion())).toBe(true);
  });
});
