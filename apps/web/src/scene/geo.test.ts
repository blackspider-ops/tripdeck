// O2-068: globe maths (Globe pins, arcs and spin; the Dry Run city plates).
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { arcPoints, latLngToSphere, metersFrom, spinFor } from "./geo";

describe("latLngToSphere", () => {
  it("puts a point on the sphere of radius r, poles on ±y", () => {
    for (const [lat, lng] of [[0, 0], [38.7, -9.1], [-33.9, 151.2], [19.4, -99.1]]) {
      expect(latLngToSphere(lat, lng, 2).length()).toBeCloseTo(2);
    }
    const n = latLngToSphere(90, 42, 1);
    expect(n.y).toBeCloseTo(1);
    expect(Math.hypot(n.x, n.z)).toBeCloseTo(0);
    expect(latLngToSphere(-90, 0, 1).y).toBeCloseTo(-1);
  });

  it("matches SphereGeometry's UV layout: lng 0 on +x, lng 90 on −z, lng −90 on +z", () => {
    const p0 = latLngToSphere(0, 0, 1);
    expect([p0.x, p0.y, p0.z].map((v) => +v.toFixed(6))).toEqual([1, 0, 0]);
    expect(latLngToSphere(0, 90, 1).z).toBeCloseTo(-1);
    expect(latLngToSphere(0, -90, 1).z).toBeCloseTo(1);
  });

  it("writes into `out` when given", () => {
    const out = new THREE.Vector3();
    expect(latLngToSphere(10, 20, 1, out)).toBe(out);
  });
});

describe("spinFor", () => {
  it("turns any longitude to face +z (the Organizer)", () => {
    for (const lng of [-170, -99.1, -9.1, 0, 45, 151.2, 180]) {
      const p = latLngToSphere(0, lng, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), spinFor(lng));
      expect(p.z).toBeCloseTo(1);
      expect(p.x).toBeCloseTo(0);
    }
  });
});

describe("metersFrom", () => {
  const center = { lat: 38.72, lng: -9.14 };
  it("is zero at the center; north is −z, east is +x", () => {
    const o = metersFrom(center, center);
    expect(o.x).toBeCloseTo(0);
    expect(o.z).toBeCloseTo(0);
    const north = metersFrom(center, { lat: center.lat + 0.01, lng: center.lng });
    expect(north.z).toBeCloseTo(-1105.4, 0);
    expect(north.x).toBeCloseTo(0);
    const east = metersFrom(center, { lat: center.lat, lng: center.lng + 0.01 });
    expect(east.x).toBeGreaterThan(0);
  });
  it("shrinks east–west metres with latitude (cos lat)", () => {
    const eq = metersFrom({ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }).x;
    const hi = metersFrom({ lat: 60, lng: 0 }, { lat: 60, lng: 0.01 }).x;
    expect(eq).toBeCloseTo(1113.2, 0);
    expect(hi / eq).toBeCloseTo(0.5);
  });
});

describe("arcPoints", () => {
  const a = latLngToSphere(41.9, -87.6, 1); // Chicago-ish
  const b = latLngToSphere(38.7, -9.1, 1); // Lisbon-ish

  it("n+1 points from a to b on radius r, lifted in the middle only", () => {
    const pts = arcPoints(a, b, 0.16, 0.18, 48);
    expect(pts).toHaveLength(49);
    expect(pts[0].distanceTo(a.clone().multiplyScalar(0.16))).toBeCloseTo(0, 6);
    expect(pts[48].distanceTo(b.clone().multiplyScalar(0.16))).toBeCloseTo(0, 6);
    const lens = pts.map((p) => p.length());
    for (const l of lens) expect(l).toBeGreaterThanOrEqual(0.16 - 1e-9);
    expect(Math.max(...lens)).toBeCloseTo(lens[24]);
    expect(lens[24]).toBeGreaterThan(0.16);
  });

  it("the lift grows with the arc's angle up to 1.2 rad, then stays", () => {
    const peak = (x: THREE.Vector3, y: THREE.Vector3) => arcPoints(x, y, 1, 0.18, 2)[1].length();
    const near = latLngToSphere(0, 0, 1), close = latLngToSphere(0, 10, 1), far = latLngToSphere(0, 100, 1), farther = latLngToSphere(0, 150, 1);
    expect(peak(near, close)).toBeLessThan(peak(near, far));
    expect(peak(near, far)).toBeCloseTo(1.18);
    expect(peak(near, farther)).toBeCloseTo(1.18);
  });

  it("doesn't mutate its inputs", () => {
    const a2 = a.clone().multiplyScalar(3);
    arcPoints(a2, b, 1);
    expect(a2.length()).toBeCloseTo(3);
  });
});
