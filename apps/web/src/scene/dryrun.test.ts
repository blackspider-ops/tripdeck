// O2-068: the Dry Run plate pins every stop on the plate; a stop past the plate is pulled to its rim and marked
// "outside" (an arrow and "to X · n min" instead of a pin). Runs DryRunCloche's placement on a bare `this`
// (building a whole cloche needs canvases and troika).
import { describe, expect, it, vi } from "vitest";
import type { PlanPublic, PublicScheduleItem } from "@all-ayes/shared";

vi.mock("troika-three-text", async () => {
  const T = await import("three");
  class Text extends T.Object3D { text = ""; sync() { /* */ } }
  class BatchedText extends Text {}
  return { Text, BatchedText, preloadFont: () => undefined };
});

import { CITY_R, DryRunCloche } from "./DryRun";
import type * as THREE from "three";

interface Place { id: string; pos: THREE.Vector3; outside: boolean; name: string }
type Internals = { places(items: PublicScheduleItem[]): Place[]; toScene(p: { lat: number; lng: number }): THREE.Vector3 };
const proto = DryRunCloche.prototype as unknown as Internals;

const center = { lat: 38.72, lng: -9.14 };
const plan = { cityId: "LIS", cityCenter: center, tileRadiusKm: 2, hotelId: "h", hotelName: "Hotel", hotelLat: center.lat, hotelLng: center.lng } as unknown as PlanPublic;
/** `north` km north of the center. */
const item = (id: string, north: number) => ({ activityId: id, name: id, lat: center.lat + (north * 1000) / 110_540, lng: center.lng }) as unknown as PublicScheduleItem;
const places = (p: PlanPublic, items: PublicScheduleItem[]) =>
  proto.places.call({ plan: p, scale: CITY_R / ((p as unknown as { tileRadiusKm: number }).tileRadiusKm * 1000), toScene: proto.toScene } as unknown as Internals, items);

describe("DryRunCloche places", () => {
  it("scales stops onto the plate (tileRadiusKm → CITY_R), north is −z", () => {
    const [hotel, near] = places(plan, [item("a", 1)]);
    expect(hotel.pos.length()).toBeCloseTo(0);
    expect(hotel.outside).toBe(false);
    expect(near.pos.z).toBeCloseTo(-CITY_R / 2, 4);
    expect(near.outside).toBe(false);
  });

  it("a stop past the plate is clamped just inside the rim and marked outside", () => {
    const [, far, edge] = places(plan, [item("far", 5), item("edge", 1.98)]);
    expect(far.outside).toBe(true);
    expect(far.pos.length()).toBeCloseTo(CITY_R - 0.004);
    expect(far.pos.z).toBeLessThan(0); // still in its direction
    // inside the plate but within 4 mm of the rim: pinned to the rim, also "outside" (no pin at the edge)
    expect(edge.outside).toBe(true);
    expect(edge.pos.length()).toBeCloseTo(CITY_R - 0.004);
  });

  it("the stay is only 'outside' past the plate itself (not the 4 mm margin)", () => {
    const nearRim = { ...plan, hotelLat: center.lat + 1980 / 110_540 } as PlanPublic;
    const [hotel] = places(nearRim, []);
    expect(hotel.outside).toBe(false);
    expect(hotel.pos.length()).toBeCloseTo(CITY_R - 0.004);
  });

  it("returns clones: clamping never mutates a shared vector", () => {
    const [a, b] = places(plan, [item("a", 0)]);
    expect(a.pos).not.toBe(b.pos);
  });
});
