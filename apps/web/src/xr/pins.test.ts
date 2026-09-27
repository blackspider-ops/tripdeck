// Chart-room pins and the globe's hand spin (docs/03 §4): lat/lng under a pinch, the nearest charted port, pin /
// unpin / region, and the spin's inertia.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { TripState } from "@all-ayes/shared";
import { angleDelta, distanceKm, latLngToSphere, nearestPort, sphereToLatLng, spinFriction } from "../scene/geo";
import { pinAt, regionOf, type PinPort } from "./pins";

const PORTS: PinPort[] = [
  { cityId: "LIS", name: "Lisbon", lat: 38.72, lng: -9.14, region: "Europe" },
  { cityId: "ROM", name: "Rome", lat: 41.9, lng: 12.5, region: "Europe" },
  { cityId: "MEX", name: "Mexico City", lat: 19.43, lng: -99.13, region: "Latin America" as never },
  { cityId: "AUS", name: "Austin", lat: 30.27, lng: -97.74, state: "TX" },
];
const trip = (over: Partial<TripState> = {}) => ({
  status: "BRIEFING", candidateCities: [{ cityId: "LIS", name: "Lisbon", lat: 38.72, lng: -9.14 }, { cityId: "MEX", name: "Mexico City", lat: 19.43, lng: -99.13 }],
  destination: { kind: "cities", cityIds: ["LIS", "MEX"] }, ...over,
}) as unknown as TripState;

describe("globe geometry", () => {
  it("sphereToLatLng inverts latLngToSphere", () => {
    for (const [lat, lng] of [[0, 0], [38.7, -9.1], [-33.9, 151.2], [64.1, -21.9], [19.4, -99.1]]) {
      const back = sphereToLatLng(latLngToSphere(lat, lng, 0.16, new THREE.Vector3()));
      expect(back.lat).toBeCloseTo(lat, 5);
      expect(back.lng).toBeCloseTo(lng, 5);
    }
  });
  it("finds the nearest charted port within range, and none on open sea", () => {
    expect(nearestPort({ lat: 39.5, lng: -8 }, PORTS)?.cityId).toBe("LIS");
    expect(nearestPort({ lat: 0, lng: -30 }, PORTS)).toBeNull();
    expect(distanceKm({ lat: 38.72, lng: -9.14 }, { lat: 41.9, lng: 12.5 })).toBeGreaterThan(1800);
  });
  it("a flick keeps turning and slows to a stop; the shortest turn wraps", () => {
    let v = 4, t = 0;
    while (v && t < 10) { v = spinFriction(v, 1 / 72); t += 1 / 72; }
    expect(v).toBe(0);
    expect(t).toBeGreaterThan(1);
    expect(t).toBeLessThan(4);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6, 6);
  });
});

describe("pinAt", () => {
  it("pins the nearest port, refuses a duplicate and a fifth port", () => {
    const r = pinAt({ lat: 42, lng: 12 }, false, trip(), PORTS, null);
    expect(r).toMatchObject({ kind: "set", destination: { kind: "cities", cityIds: ["LIS", "MEX", "ROM"] }, say: "Pinned Rome." });
    const four = trip({ candidateCities: ["A", "B", "C", "D"].map((id, i) => ({ cityId: id, name: id, lat: -60 + i, lng: 100 })) });
    expect(pinAt({ lat: 42, lng: 12 }, false, four, PORTS, null)).toMatchObject({ kind: "note", say: expect.stringMatching(/At most 4/) });
    expect(pinAt({ lat: 0, lng: -30 }, false, trip(), PORTS, null)).toMatchObject({ kind: "note" });
  });
  it("a pinch on a pin takes it off, but never below two ports", () => {
    const three = trip({ candidateCities: [...trip().candidateCities, { cityId: "ROM", name: "Rome", lat: 41.9, lng: 12.5 }] });
    expect(pinAt({ lat: 41.8, lng: 12.4 }, false, three, PORTS, null)).toMatchObject({ kind: "set", destination: { kind: "cities", cityIds: ["LIS", "MEX"] } });
    expect(pinAt({ lat: 38.7, lng: -9.1 }, false, trip(), PORTS, null)).toMatchObject({ kind: "note", say: expect.stringMatching(/at least 2/) });
  });
  it("a held pinch pins the port's region (a US state's port: United States); adds to regions already there", () => {
    expect(pinAt({ lat: 42, lng: 12 }, true, trip(), PORTS, null)).toMatchObject({ kind: "set", destination: { kind: "regions", regions: ["Europe"] } });
    expect(regionOf(PORTS[3])).toBe("United States");
    const eu = trip({ destination: { kind: "regions", regions: ["Europe"] } as never, candidateCities: [] });
    expect(pinAt({ lat: 30, lng: -97 }, true, eu, PORTS, null)).toMatchObject({ kind: "set", destination: { kind: "regions", regions: ["Europe", "United States"] } });
    expect(pinAt({ lat: 42, lng: 12 }, true, eu, PORTS, null)).toMatchObject({ kind: "note" });
  });
  it("on a regions / anywhere voyage the first port waits for a second, then the chart has named ports", () => {
    const any = trip({ destination: { kind: "anywhere" } as never, candidateCities: [] });
    const first = pinAt({ lat: 42, lng: 12 }, false, any, PORTS, null);
    expect(first).toMatchObject({ kind: "pending", cityId: "ROM" });
    expect(pinAt({ lat: 38.7, lng: -9 }, false, any, PORTS, "ROM")).toMatchObject({ kind: "set", destination: { kind: "cities", cityIds: ["ROM", "LIS"] } });
  });
});
