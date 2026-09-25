// R2-WP-15 / O2-050, O2-056: merged geometry and what disposeObject frees or keeps.
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { M, disposeObject, mergedGeometry, sharedGeometry } from "./materials";

describe("mergedGeometry", () => {
  it("bakes each part's transform into one position+normal geometry", () => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    b.position.y = 10;
    const g = mergedGeometry([a, b]);
    expect(Object.keys(g.attributes).sort()).toEqual(["normal", "position"]);
    expect(g.attributes.position.count).toBe(72); // 2 × 36 non-indexed vertices
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeCloseTo(10.5);
  });
});

describe("disposeObject", () => {
  it("frees own geometry and materials, keeps shared geometry and cached materials", () => {
    const own = new THREE.BoxGeometry();
    const ownMat = new THREE.MeshBasicMaterial();
    const shared = sharedGeometry(new THREE.BoxGeometry());
    const root = new THREE.Group();
    root.add(new THREE.Mesh(own, ownMat), new THREE.Mesh(shared, M.brass()));
    const spies = [vi.spyOn(own, "dispose"), vi.spyOn(ownMat, "dispose"), vi.spyOn(shared, "dispose"), vi.spyOn(M.brass(), "dispose")];
    disposeObject(root);
    expect(spies.map((s) => s.mock.calls.length)).toEqual([1, 1, 0, 0]);
  });
});
