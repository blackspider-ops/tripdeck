// OPT-016 / OPT-066: one seating plan for the 3D table and the phone's top-down chart.
import { describe, expect, it } from "vitest";
import type { CrewPublic } from "@all-ayes/shared";
import { ORGANIZER_DEG, otherSeatAngles, pieceScale, seatAngle } from "./seating";

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
  it("gives every member a distinct seat, ≥16° from any other, clear of the Captain, compass and cloches", () => {
    for (let n = 2; n <= 12; n++) {
      const c = big(n);
      const angles = c.map((m) => seatAngle(c, "m0", m.memberId));
      expect(angles[0]).toBe(ORGANIZER_DEG);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(gap(angles[i], angles[j]), `n=${n} ${angles[i]}/${angles[j]}`).toBeGreaterThanOrEqual(16);
      for (const a of angles.slice(1)) {
        expect(gap(a, 186), `captain n=${n}`).toBeGreaterThan(5);
        expect(gap(a, 270), `compass n=${n}`).toBeGreaterThan(7);
        if (n > 4) { // the Dry Run cloches (the hand-placed plan already sits clear of them)
          expect(a >= 3 && a <= 50, `east cloche n=${n}: ${a}`).toBe(false);
          expect(a >= 130 && a <= 189, `west cloche n=${n}: ${a}`).toBe(false);
        }
      }
    }
  });
  it("shrinks the pieces only past 6", () => {
    for (let n = 1; n <= 6; n++) expect(pieceScale(n)).toBe(1);
    expect(pieceScale(12)).toBeCloseTo(0.79);
    for (let n = 7; n <= 12; n++) expect(pieceScale(n)).toBeLessThan(pieceScale(n - 1));
  });
});
