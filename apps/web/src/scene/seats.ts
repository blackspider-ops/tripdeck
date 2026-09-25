// Where everyone sits around the chart (OPT-016): the one source for the director and the Gallery camera.
import * as THREE from "three";
import type { CrewPublic } from "@all-ayes/shared";
import { seatAngle } from "../shared-ui/seating";

/** Radius of the ring of seats (m). */
export const SEAT_R = 0.245;
/** Pieces stand on the chart sheet. */
export const SEAT_Y = 0.0025;
// Everyone sits where the Organizer (south) can see them past the Ø32 cm globe, and clear of the
// Dry Run cloches (x ±0.30, z 0.15). North would hide a piece behind the globe.
export const CAPTAIN_POS = new THREE.Vector3(-0.3, 0, -0.03);

/** Seat position on the table for an angle. */
export function seatPoint(deg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = (deg * Math.PI) / 180;
  return out.set(Math.cos(a) * SEAT_R, SEAT_Y, Math.sin(a) * SEAT_R);
}

/** Every member's seat, keyed by memberId. */
export function seatMap(crew: readonly CrewPublic[], organizerId: string): Map<string, THREE.Vector3> {
  return new Map(crew.map((c) => [c.memberId, seatPoint(seatAngle(crew, organizerId, c.memberId))]));
}
