// O2-068 / OPT-016: the seat ring the director and the Gallery camera share.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { CrewPublic } from "@all-ayes/shared";
import { CAPTAIN_POS, SEAT_R, SEAT_Y, seatMap, seatPoint } from "./seats";
import { pieceScale, seatAngle } from "../shared-ui/seating";

const crew = (...ids: string[]) => ids.map((memberId, i) => ({ memberId, name: memberId, role: "member", band: (i + 1) as 1, briefSealed: false })) as CrewPublic[];

describe("seatPoint", () => {
  it("is on the ring at SEAT_Y, angle measured from +x toward +z", () => {
    const p = seatPoint(0);
    expect([p.x, p.y, p.z]).toEqual([SEAT_R, SEAT_Y, 0]);
    const q = seatPoint(90);
    expect(q.x).toBeCloseTo(0);
    expect(q.z).toBeCloseTo(SEAT_R);
    for (const d of [17, 200, 335]) expect(Math.hypot(seatPoint(d).x, seatPoint(d).z)).toBeCloseTo(SEAT_R);
  });
  it("writes into `out`", () => {
    const out = new THREE.Vector3();
    expect(seatPoint(45, out)).toBe(out);
  });
});

describe("seatMap", () => {
  it("one distinct seat per member, at that member's seatAngle", () => {
    const c = crew("rae", "maya", "dev", "ann");
    const m = seatMap(c, "rae");
    expect([...m.keys()]).toEqual(["rae", "maya", "dev", "ann"]);
    for (const x of c) expect(m.get(x.memberId)!.distanceTo(seatPoint(seatAngle(c, "rae", x.memberId)))).toBeCloseTo(0);
    const pts = [...m.values()];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(pts[i].distanceTo(pts[j])).toBeGreaterThan(0.01);
  });
  it("is empty for an empty crew", () => {
    expect(seatMap([], "rae").size).toBe(0);
  });
});

describe("the ring for crews of 2–12 (3D)", () => {
  // a crew piece's base is Ø4.4 cm (CrewPiece PAWN_PROFILE), the Captain's Ø5.4 cm; pieces scale by pieceScale
  const PIECE_R = 0.022, CAPTAIN_R = 0.027, CLOCHE_R = 0.13;
  it("no two pieces touch, none stands on the Captain or under a Dry Run cloche", () => {
    for (let n = 2; n <= 12; n++) {
      const c = crew(...Array.from({ length: n }, (_, i) => `m${i}`));
      const pts = [...seatMap(c, "m0").values()];
      const r = PIECE_R * pieceScale(n);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) expect(pts[i].distanceTo(pts[j]), `n=${n}`).toBeGreaterThan(2 * r + 0.02);
        const flat = new THREE.Vector3(pts[i].x, 0, pts[i].z);
        expect(flat.distanceTo(CAPTAIN_POS), `captain n=${n}`).toBeGreaterThan(r + CAPTAIN_R);
        for (const side of [-1, 1]) expect(flat.distanceTo(new THREE.Vector3(side * 0.3, 0, 0.15)), `cloche n=${n}`).toBeGreaterThan(CLOCHE_R + r);
      }
    }
  });
});
