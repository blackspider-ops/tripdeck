// OPT-016 / OPT-066: one seating plan for the 3D table and the phone's top-down chart.
import { describe, expect, it } from "vitest";
import type { CrewPublic } from "@all-ayes/shared";
import {
  MIN_GAP_DIAMETERS, ORGANIZER_DEG, PIECE_R, SEAT_R, exclusionWindows, flagTier, inWindow, otherSeatAngles, pieceScale, ringSeats,
  seatAngle, seatPlace,
} from "./seating";

const crew = (...ids: string[]) => ids.map((memberId, i) => ({ memberId, name: memberId, role: "member", band: (i + 1) as 1, origin: "ORD", briefSealed: false })) as CrewPublic[];

describe("seatAngle", () => {
  it("puts the organizer south, and the others around the north arc in roster order", () => {
    const c = crew("rae", "maya", "dev", "ann");
    expect(seatAngle(c, "rae", "rae")).toBe(ORGANIZER_DEG);
    expect([seatAngle(c, "rae", "maya"), seatAngle(c, "rae", "dev"), seatAngle(c, "rae", "ann")]).toEqual([205, 335, 355]);
  });
  it("uses the plan for the crew size, and the organizer's position in the roster doesn't matter", () => {
    expect(seatAngle(crew("rae", "maya"), "rae", "maya")).toBe(335);
    expect(seatAngle(crew("maya", "rae", "dev"), "rae", "dev")).toBe(335);
  });
  it("falls back for someone not on the roster", () => {
    expect(seatAngle(crew("rae", "maya"), "rae", "ghost")).toBe(200);
  });
});

describe("seatAngle for crews of 2–12", () => {
  const big = (n: number) => crew(...Array.from({ length: n }, (_, i) => `m${i}`));
  const gap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  it("keeps the hand-placed seats for up to 4 exactly", () => {
    expect(otherSeatAngles(1)).toEqual([335]);
    expect(otherSeatAngles(2)).toEqual([205, 335]);
    expect(otherSeatAngles(3)).toEqual([205, 335, 355]);
  });
  const xz = ({ deg, r }: { deg: number; r: number }) => [Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r];
  const dist = (p: { deg: number; r: number }, q: { deg: number; r: number }) => { const [a, b] = xz(p), [c, d] = xz(q); return Math.hypot(a - c, b - d); };
  it("keeps the hand-placed seats for up to 4 exactly (angle and ring)", () => {
    const c = big(4);
    expect(c.map((m) => seatPlace(c, "m0", m.memberId))).toEqual([
      { deg: 90, r: SEAT_R }, { deg: 205, r: SEAT_R }, { deg: 335, r: SEAT_R }, { deg: 355, r: SEAT_R },
    ]);
  });
  it("2–12: pieces ≥ 1.3 diameters apart, the Organizer south, no seat inside an exclusion window", () => {
    for (let n = 2; n <= 12; n++) {
      const c = big(n);
      const seats = c.map((m) => seatPlace(c, "m0", m.memberId));
      const d = 2 * PIECE_R * pieceScale(n);
      expect(seats[0]).toEqual({ deg: ORGANIZER_DEG, r: SEAT_R });
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        expect(dist(seats[i], seats[j]), `n=${n} ${seats[i].deg}/${seats[j].deg}`).toBeGreaterThanOrEqual(d * MIN_GAP_DIAMETERS);
      }
      for (const s of seats.slice(1)) {
        expect(inWindow(s.deg, exclusionWindows(s.r, d / 2)), `n=${n}: ${s.deg}@${s.r}`).toBe(false);
        expect(gap(s.deg, 186), `captain n=${n}`).toBeGreaterThan(5);
        expect(gap(s.deg, 270), `compass n=${n}`).toBeGreaterThan(7);
      }
    }
  });
  it("5–12 spread round the whole rim: every quarter of the table seats someone, none bunched on one side", () => {
    for (let n = 5; n <= 12; n++) {
      const a = otherSeatAngles(n - 1);
      const quarter = (lo: number, hi: number) => a.filter((d) => d >= lo && d < hi).length;
      const q = [quarter(0, 90), quarter(90, 180), quarter(180, 270), quarter(270, 360)];
      expect(Math.min(...q), `n=${n} ${q}`).toBeGreaterThanOrEqual(1);
      expect(Math.max(...q), `n=${n} ${q}`).toBeLessThanOrEqual(Math.ceil((n - 1) / 2));
      // the front (south) half, either side of the Organizer, seats its share too (for twelve: 4 of 11, was 2, the rest crowding the north-east)
      expect(q[0] + q[1], `n=${n} ${q}`).toBeGreaterThanOrEqual(n === 12 ? 4 : 2);
      // even: one equal step along the free arcs, ≥ 17.5° even for twelve
      const all = [ORGANIZER_DEG, ...a];
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(gap(all[i], all[j]), `n=${n}`).toBeGreaterThanOrEqual(17.5);
    }
  });
  it("falls back to two alternating rings when one is too short, still clear of every window", () => {
    const seats = ringSeats(24, 12);
    const radii = new Set(seats.map((s) => s.r));
    expect(radii.size).toBe(2);
    const d = 2 * PIECE_R * pieceScale(12);
    for (const s of seats) expect(inWindow(s.deg, exclusionWindows(s.r, d / 2)), `${s.deg}@${s.r}`).toBe(false);
    for (let i = 1; i < seats.length; i++) expect(seats[i].r).not.toBe(seats[i - 1].r);
  });
  it("neighbouring name flags alternate heights going round the ring", () => {
    for (let n = 3; n <= 12; n++) {
      const c = big(n);
      const others = c.slice(1).map((m) => ({ deg: seatAngle(c, "m0", m.memberId), tier: flagTier(c, "m0", m.memberId) }));
      const ring = others.sort((p, q) => ((p.deg - 90 + 360) % 360) - ((q.deg - 90 + 360) % 360));
      for (let i = 1; i < ring.length; i++) expect(ring[i].tier, `n=${n}`).not.toBe(ring[i - 1].tier);
      expect(flagTier(c, "m0", "m0")).toBe(0);
      expect(ring[0].tier, "the Organizer's neighbour differs from the Organizer").toBe(1);
    }
  });
  it("shrinks the pieces only past 6", () => {
    for (let n = 1; n <= 6; n++) expect(pieceScale(n)).toBe(1);
    expect(pieceScale(12)).toBeCloseTo(0.79);
    for (let n = 7; n <= 12; n++) expect(pieceScale(n)).toBeLessThan(pieceScale(n - 1));
  });
});
