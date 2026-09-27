// Quest 3S report: "the globe keeps jumping … here and there". A hand only turns the globe (yaw + clamped pitch,
// bounded steps and inertia); it never moves or scales it.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GlobeSpin, PITCH_MAX, SPIN_STEP_MAX, SPIN_VEL_MAX, dragRotation } from "./globeSpin";

const R = 0.16;
function rig() {
  const chart = new THREE.Group(); chart.position.set(0.3, 0.74, -0.8); chart.rotation.y = 0.7;
  const stand = new THREE.Group(); chart.add(stand);
  const tilt = new THREE.Group(); tilt.position.y = 0.212; stand.add(tilt);
  const spin = new THREE.Group(); tilt.add(spin);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(R)); spin.add(sphere);
  chart.updateMatrixWorld(true);
  return { chart, stand, tilt, spin, sphere, hand: new GlobeSpin(stand, tilt, spin, R) };
}
const onGlobe = (r: ReturnType<typeof rig>, lat: number, lng: number) => {
  const p = new THREE.Vector3(Math.cos(lat) * Math.sin(lng), Math.sin(lat), Math.cos(lat) * Math.cos(lng)).multiplyScalar(R);
  return r.stand.localToWorld(p.add(r.tilt.position));
};

describe("globe hand spin", () => {
  it("a drag (even wild, across the pole or off the sphere) only rotates: no position or scale anywhere changes", () => {
    const r = rig();
    const before = r.sphere.getWorldPosition(new THREE.Vector3());
    let t = 0;
    r.hand.grabAt(onGlobe(r, 0.2, 0), t);
    for (let i = 0; i < 200; i++) {
      t += 14;
      const wild = i % 7 === 0 ? new THREE.Vector3(Math.sin(i) * 3, 2, Math.cos(i) * 3) : onGlobe(r, Math.sin(i * 0.3) * 1.5, i * 0.2);
      r.hand.dragTo(wild, t);
      r.chart.updateMatrixWorld(true);
      expect(r.sphere.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-12);
      expect(Math.abs(r.tilt.rotation.x)).toBeLessThanOrEqual(PITCH_MAX + 1e-12);
      expect(r.tilt.rotation.y).toBe(0); expect(r.tilt.rotation.z).toBe(0);
      expect(r.spin.rotation.x).toBe(0); expect(r.spin.rotation.z).toBe(0);
    }
    r.hand.release(t);
    for (let i = 0; i < 500; i++) r.hand.tick(1 / 72);
    expect(r.hand.spinning).toBe(false); // inertia dies out
    for (const o of [r.chart, r.stand, r.tilt, r.spin]) expect(o.scale.equals(new THREE.Vector3(1, 1, 1))).toBe(true);
    expect(r.chart.position.equals(new THREE.Vector3(0.3, 0.74, -0.8))).toBe(true);
    expect(r.tilt.position.equals(new THREE.Vector3(0, 0.212, 0))).toBe(true);
    expect(r.spin.position.lengthSq()).toBe(0);
  });

  it("a sideways drag on the equator turns it by the angle swept; steps and flicks are bounded; near the pole yaw fades", () => {
    const a = dragRotation(new THREE.Vector3(0, 0, R), new THREE.Vector3(R * Math.sin(0.1), 0, R * Math.cos(0.1)), R);
    expect(a.yaw).toBeCloseTo(0.1); expect(a.pitch).toBeCloseTo(0);
    const flip = dragRotation(new THREE.Vector3(0, 0, R), new THREE.Vector3(0, 0, -R), R);
    expect(Math.abs(flip.yaw)).toBeLessThanOrEqual(SPIN_STEP_MAX);
    const pole = dragRotation(new THREE.Vector3(0.001, R, 0), new THREE.Vector3(-0.001, R, 0), R);
    expect(Math.abs(pole.yaw)).toBeLessThan(0.1);
    // pulling the near side up tips the globe back (negative rotation.x), clamped
    const up = dragRotation(new THREE.Vector3(0, 0, R), new THREE.Vector3(0, R * Math.sin(0.2), R * Math.cos(0.2)), R);
    expect(up.pitch).toBeCloseTo(-0.2);
    const r = rig();
    r.hand.grabAt(onGlobe(r, 0, 0), 0);
    r.hand.dragTo(onGlobe(r, 0, 0.3), 1); // 0.3 rad in 1 ms: a huge flick
    r.hand.release(2);
    const y0 = r.spin.rotation.y;
    r.hand.tick(0.01);
    expect(Math.abs(r.spin.rotation.y - y0)).toBeLessThanOrEqual(SPIN_VEL_MAX * 0.01 + 1e-9);
  });
});
