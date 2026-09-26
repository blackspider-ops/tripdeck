// Who sits where around the chart table (OPT-016), as angles only: no three.js import, so the phone's top-down
// chart (Table.tsx) and the 3D scene (scene/seats.ts) share one seating plan without the phone pulling in three.
import type { CrewPublic } from "@all-ayes/shared";

/**
 * Angles (deg, x = cos, z = sin; +z is south, toward the Organizer) for the non-organizer seats of a crew of up to 4
 * (the hand-placed plan the Expo crew and the snapshots use: unchanged).
 */
const OTHER_SEATS: Record<number, number[]> = { 0: [], 1: [335], 2: [205, 335], 3: [205, 335, 355] };
/** The Organizer sits south. */
export const ORGANIZER_DEG = 90;
const FALLBACK_DEG = 200;

/**
 * Larger crews (5–12): the others share the free arcs of the ring evenly, going round from the Organizer. Kept clear:
 * the Organizer's own place (south), the Dry Run cloches (Ø26 cm at x ±0.30, z 0.15: roughly 0–50° and 130–175°),
 * the Captain (3D: west of the globe, ~186°) and the brass compass / the phone chart's Captain (north, 270°). Seats sit
 * at the middle of equal steps along the free arcs, so neighbours are ≥ (free arc / others) apart: ~17° for 11 others
 * (≈7 cm apart on the 3D ring, over twice a piece's base at the big-crew scale).
 */
const FREE_ARCS: [number, number][] = [[112, 128], [192, 262], [278, 362], [52, 68]];
const FREE_LEN = FREE_ARCS.reduce((s, [a, b]) => s + (b - a), 0);

function ringAngles(k: number): number[] {
  const step = FREE_LEN / k;
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    let t = (i + 0.5) * step;
    for (const [a, b] of FREE_ARCS) {
      if (t <= b - a) { out.push(Math.round((a + t) * 10) / 10 % 360); break; }
      t -= b - a;
    }
  }
  return out;
}

const cache = new Map<number, number[]>();
/** The non-organizer seat angles for `k` others, in roster order. */
export function otherSeatAngles(k: number): number[] {
  if (OTHER_SEATS[k]) return OTHER_SEATS[k];
  let a = cache.get(k);
  if (!a) cache.set(k, (a = ringAngles(k)));
  return a;
}

/** Seat angle (deg) of one member, given the whole crew in roster order. */
export function seatAngle(crew: readonly CrewPublic[], organizerId: string, memberId: string): number {
  if (memberId === organizerId) return ORGANIZER_DEG;
  const others = crew.filter((c) => c.memberId !== organizerId);
  return otherSeatAngles(others.length)[others.findIndex((c) => c.memberId === memberId)] ?? FALLBACK_DEG;
}

/**
 * How big a crew piece (and its name flag) stands, by crew size: full size up to 6, then smaller so twelve fit round
 * the ring without touching (0.79 at 12).
 */
export function pieceScale(crewSize: number): number {
  return crewSize <= 6 ? 1 : Math.max(0.79, 1 - (crewSize - 6) * 0.035);
}
