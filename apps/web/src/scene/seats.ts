// Where everyone sits around the chart (OPT-016): the one source for the director and the Gallery camera.
import * as THREE from "three";
import type { CrewPublic } from "@all-ayes/shared";
import { SEAT_R, seatPlace } from "../shared-ui/seating";

export { SEAT_R };

/** Pieces stand on the chart sheet. */
export const SEAT_Y = 0.0025;
// The Captain stands west of the globe; the seating plan (shared-ui/seating.ts OBSTACLES) keeps every seat clear of
// it, the brass compass and the Dry Run cloches (x ±0.30, z 0.15).
export const CAPTAIN_POS = new THREE.Vector3(-0.3, 0, -0.03);

/** Seat position on the table for an angle, on a ring of radius `r` (default: the Organizer's ring, SEAT_R). */
export function seatPoint(deg: number, out = new THREE.Vector3(), r = SEAT_R): THREE.Vector3 {
  const a = (deg * Math.PI) / 180;
  return out.set(Math.cos(a) * r, SEAT_Y, Math.sin(a) * r);
}

/** Every member's seat, keyed by memberId. */
export function seatMap(crew: readonly CrewPublic[], organizerId: string): Map<string, THREE.Vector3> {
  return new Map(crew.map((c) => {
    const { deg, r } = seatPlace(crew, organizerId, c.memberId);
    return [c.memberId, seatPoint(deg, new THREE.Vector3(), r)];
  }));
}
