// Who sits where around the chart table (OPT-016), as angles and ring radii only: no three.js import, so the phone's
// top-down chart (Table.tsx) and the 3D scene (scene/seats.ts) share one seating plan without the phone pulling in three.
import type { CrewPublic } from "@all-ayes/shared";

/** Radius (m) of the Organizer's seat and of the hand-placed seats for crews of up to 4. */
export const SEAT_R = 0.245;
/**
 * Radius (m) of the ring for crews of 5–12: the Organizer's ring. (Any closer in and, from the Gallery's overhead camera
 * or the Organizer's chair, the pieces seem to stand under the Ø32 cm globe, whose sphere looms larger than its base.)
 */
export const RING_R = SEAT_R;
/** When one ring is too short for everyone (not for 12, but kept as the fallback): seats alternate between these. */
export const RING_IN_R = 0.225;
export const RING_OUT_R = 0.285;

/**
 * Angles (deg, x = cos, z = sin; +z is south, toward the Organizer) for the non-organizer seats of a crew of up to 4
 * (the hand-placed plan the Expo crew and the snapshots use: unchanged).
 */
const OTHER_SEATS: Record<number, number[]> = { 0: [], 1: [335], 2: [205, 335], 3: [205, 335, 355] };
/** The Organizer sits south. */
export const ORGANIZER_DEG = 90;
const FALLBACK_DEG = 200;

/** A crew piece's base radius (m) at full size (CrewPiece PAWN_PROFILE: Ø4.4 cm). */
export const PIECE_R = 0.022;
/** Neighbouring pieces stand at least this many piece diameters apart (centre to centre). */
export const MIN_GAP_DIAMETERS = 1.3;

/**
 * What a seat must keep clear of, on the table plane (m; x east, z south). Mirrors the scene: the Dry Run cloches
 * (DryRun.ts rest at x ±0.30, z 0.15, CLOCHE_R 0.13), the Captain (seats.ts CAPTAIN_POS, a Ø5.4 cm base) and the brass
 * compass (ChartTable.ts COMPASS_POS, ~Ø10 cm). `minDeg` keeps a seat at least that far round from the object even
 * where the ring passes clear of it (a piece right in front of the Captain or on the compass would hide it).
 */
export const OBSTACLES: readonly { name: string; x: number; z: number; r: number; minDeg: number }[] = [
  { name: "east cloche", x: 0.3, z: 0.15, r: 0.13, minDeg: 0 },
  { name: "west cloche", x: -0.3, z: 0.15, r: 0.13, minDeg: 0 },
  { name: "captain", x: -0.3, z: -0.03, r: 0.027, minDeg: 11 },
  { name: "compass", x: 0, z: -0.285, r: 0.05, minDeg: 13 },
];
/** Extra clearance (m) between a piece and an obstacle. */
const CLEARANCE = 0.006;

export interface SeatPlace { deg: number; r: number }

/** An angular window [from, to] (deg, from < to, may run past 360) that no seat may sit in. */
export type Window = [number, number];

/**
 * The windows a seat on a ring of radius `r` must avoid, for pieces of radius `pieceR`: every obstacle, and the
 * Organizer's own seat (south, at SEAT_R) with the minimum gap between pieces.
 */
export function exclusionWindows(r: number, pieceR: number): Window[] {
  const out: Window[] = [];
  const add = (cx: number, cz: number, clear: number, minDeg: number) => {
    const ro = Math.hypot(cx, cz);
    const at = ((Math.atan2(cz, cx) * 180) / Math.PI + 360) % 360;
    // the ring point at angle Δ from the object is `clear` away when r² + ro² − 2·r·ro·cosΔ = clear²
    const cos = (r * r + ro * ro - clear * clear) / (2 * r * ro);
    const half = Math.max(minDeg, cos >= 1 ? 0 : (Math.acos(Math.max(-1, cos)) * 180) / Math.PI);
    if (half > 0) out.push([at - half, at + half]);
  };
  for (const o of OBSTACLES) add(o.x, o.z, o.r + pieceR + CLEARANCE, o.minDeg);
  add(0, SEAT_R, 2 * pieceR * MIN_GAP_DIAMETERS, 0);
  return out;
}

/** Is angle `deg` inside any of `windows`? */
export function inWindow(deg: number, windows: readonly Window[]): boolean {
  const d = ((deg % 360) + 360) % 360;
  return windows.some(([a, b]) => [d - 360, d, d + 360].some((x) => x > a && x < b));
}

/**
 * The free arcs of the ring, going round from just past the Organizer (increasing angle: west of south, north, east,
 * back to south), as [from, to] pairs (deg, may run past 360).
 */
function freeArcs(windows: readonly Window[]): Window[] {
  // sweep one turn starting at the Organizer; cut out the (merged) windows
  const start = ORGANIZER_DEG;
  const cuts = windows
    .map(([a, b]): Window => { const s = ((a - start) % 360 + 360) % 360; return [s, s + (b - a)]; })
    .flatMap(([a, b]): Window[] => (b > 360 ? [[a, 360], [0, b - 360]] : [[a, b]]))
    .sort((p, q) => p[0] - q[0]);
  const arcs: Window[] = [];
  let at = 0;
  for (const [a, b] of cuts) {
    if (a > at) arcs.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < 360) arcs.push([at, 360]);
  return arcs.map(([a, b]) => [a + start, b + start]);
}

/** Spreads `k` seats evenly over `arcs`: each sits at the middle of an equal step along their total length. */
function spread(k: number, arcs: readonly Window[]): number[] {
  const len = arcs.reduce((s, [a, b]) => s + (b - a), 0);
  const step = len / k;
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    let t = (i + 0.5) * step;
    for (const [a, b] of arcs) {
      if (t <= b - a) { out.push(Math.round(((a + t) % 360) * 10) / 10); break; }
      t -= b - a;
    }
  }
  return out;
}

/** Angle (deg) two pieces on a ring of radius `r` must be apart to stand `dist` apart. */
const gapDeg = (dist: number, r: number) => (2 * Math.asin(Math.min(1, dist / (2 * r))) * 180) / Math.PI;

/**
 * The seats of `k` others (k ≥ 4) for a crew of `crewSize`: the free arcs of one ring (clear of the Captain, the compass,
 * both cloches and the Organizer), shared evenly. If that leaves neighbours closer than the minimum gap, the seats
 * alternate between an inner and an outer ring (clear of the windows of both), so each ring only needs every other gap.
 */
export function ringSeats(k: number, crewSize = k + 1): SeatPlace[] {
  const pieceR = PIECE_R * pieceScale(crewSize);
  const minDist = 2 * pieceR * MIN_GAP_DIAMETERS;
  const single = freeArcs(exclusionWindows(RING_R, pieceR));
  const len = single.reduce((s, [a, b]) => s + (b - a), 0);
  if (len / k >= gapDeg(minDist, RING_R)) return spread(k, single).map((deg) => ({ deg, r: RING_R }));
  const both = freeArcs([...exclusionWindows(RING_IN_R, pieceR), ...exclusionWindows(RING_OUT_R, pieceR)]);
  return spread(k, both).map((deg, i) => ({ deg, r: i % 2 ? RING_OUT_R : RING_IN_R }));
}

const cache = new Map<number, SeatPlace[]>();
/** The non-organizer seats for `k` others, in roster order. */
export function otherSeats(k: number): SeatPlace[] {
  if (OTHER_SEATS[k]) return OTHER_SEATS[k].map((deg) => ({ deg, r: SEAT_R }));
  let a = cache.get(k);
  if (!a) cache.set(k, (a = ringSeats(k)));
  return a;
}

/** The non-organizer seat angles for `k` others, in roster order. */
export function otherSeatAngles(k: number): number[] {
  return otherSeats(k).map((s) => s.deg);
}

/** Seat (angle and ring radius) of one member, given the whole crew in roster order. */
export function seatPlace(crew: readonly CrewPublic[], organizerId: string, memberId: string): SeatPlace {
  if (memberId === organizerId) return { deg: ORGANIZER_DEG, r: SEAT_R };
  const others = crew.filter((c) => c.memberId !== organizerId);
  return otherSeats(others.length)[others.findIndex((c) => c.memberId === memberId)] ?? { deg: FALLBACK_DEG, r: SEAT_R };
}

/** Seat angle (deg) of one member, given the whole crew in roster order. */
export function seatAngle(crew: readonly CrewPublic[], organizerId: string, memberId: string): number {
  return seatPlace(crew, organizerId, memberId).deg;
}

/**
 * Name-flag tier (0 or 1) of one member: going round the ring, every other seat raises its flag a notch so
 * neighbouring flags never cover each other, even seen edge-on along the ring. The Organizer is tier 0.
 */
export function flagTier(crew: readonly CrewPublic[], organizerId: string, memberId: string): 0 | 1 {
  if (memberId === organizerId) return 0;
  const others = crew.filter((c) => c.memberId !== organizerId);
  const seats = otherSeats(others.length);
  const i = others.findIndex((c) => c.memberId === memberId);
  if (i < 0 || !seats[i]) return 0;
  // rank by angle round from the Organizer, so neighbours on the table alternate (roster order may not be ring order)
  const from = (d: number) => ((d - ORGANIZER_DEG) % 360 + 360) % 360;
  const rank = seats.map((_, j) => j).sort((p, q) => from(seats[p].deg) - from(seats[q].deg)).indexOf(i);
  return rank % 2 === 0 ? 1 : 0;
}

/**
 * How big a crew piece (and its name flag) stands, by crew size: full size up to 6, then smaller so twelve fit round
 * the ring without touching (0.79 at 12).
 */
export function pieceScale(crewSize: number): number {
  return crewSize <= 6 ? 1 : Math.max(0.79, 1 - (crewSize - 6) * 0.035);
}
