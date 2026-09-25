// OPT-025 / OPT-066: the chart room's phase captions use the shared copy, so the surfaces can't drift.
import { describe, expect, it } from "vitest";
import { BOOKED_HEADLINE, SEALING_FOOTER, VOID_HEADLINE, type CrewPublic, type TripState } from "@all-ayes/shared";
import { phaseCaption } from "./copy";

const member = (name: string, briefSealed: boolean) => ({ memberId: name, name, role: "member", band: 1, origin: "ORD", briefSealed }) as CrewPublic;
const trip = (status: TripState["status"], crew: CrewPublic[] = []) => ({ status, crew }) as TripState;

describe("phaseCaption", () => {
  it("names whose terms are still out while briefing", () => {
    expect(phaseCaption(trip("BRIEFING", [member("Ann", false), member("Bo", false), member("Cy", true)]))).toBe("Waiting on Ann's and Bo's terms…");
    expect(phaseCaption(trip("BRIEFING", [member("Cy", true)]))).toMatch(/Weigh anchor/);
  });
  it("uses the shared headlines for the ending phases, and leaves the table to its own lines", () => {
    expect(phaseCaption(trip("BOOKED"))).toBe(BOOKED_HEADLINE);
    expect(phaseCaption(trip("VOIDED"))).toBe(VOID_HEADLINE);
    expect(phaseCaption(trip("SEALING"))).toContain(SEALING_FOOTER);
    expect(phaseCaption(trip("AT_TABLE"))).toBeUndefined();
  });
});
