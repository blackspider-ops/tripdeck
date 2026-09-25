// Who sits where around the chart table (OPT-016), as angles only: no three.js import, so the phone's top-down
// chart (Table.tsx) and the 3D scene (scene/seats.ts) share one seating plan without the phone pulling in three.
import { MAX_CREW, type CrewPublic } from "@all-ayes/shared";

/** Angles (deg, x = cos, z = sin; +z is south, toward the Organizer) for the non-organizer seats. */
const OTHER_SEATS: Record<number, number[]> = { 0: [], 1: [335], 2: [205, 335], 3: [205, 335, 355] };
/** The Organizer sits south. */
export const ORGANIZER_DEG = 90;
const FALLBACK_DEG = 200;

/** Seat angle (deg) of one member, given the whole crew in roster order. */
export function seatAngle(crew: readonly CrewPublic[], organizerId: string, memberId: string): number {
  if (memberId === organizerId) return ORGANIZER_DEG;
  const others = crew.filter((c) => c.memberId !== organizerId);
  const angles = OTHER_SEATS[Math.min(MAX_CREW - 1, others.length)] ?? OTHER_SEATS[MAX_CREW - 1];
  return angles[others.findIndex((c) => c.memberId === memberId)] ?? FALLBACK_DEG;
}
