// OPT-016 / OPT-066: one seating plan for the 3D table and the phone's top-down chart.
import { describe, expect, it } from "vitest";
import type { CrewPublic } from "@all-ayes/shared";
import { ORGANIZER_DEG, seatAngle } from "./seating";

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
