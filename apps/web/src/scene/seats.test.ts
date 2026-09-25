// O2-068 / OPT-016: the seat ring the director and the Gallery camera share.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { CrewPublic } from "@all-ayes/shared";
import { SEAT_R, SEAT_Y, seatMap, seatPoint } from "./seats";
import { seatAngle } from "../shared-ui/seating";

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
