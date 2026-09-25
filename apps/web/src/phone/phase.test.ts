// OPT-066 / OPT-035: the phone's routing policy, for every status × sealed × organizer.
import { describe, expect, it } from "vitest";
import type { TripStatus } from "@all-ayes/shared";
import { allowedScreens, screenOf } from "./phase";

const STATUSES: TripStatus[] = ["BRIEFING", "AT_TABLE", "DRY_RUN", "SEALING", "BOOKED", "VOIDED"];

describe("allowedScreens", () => {
  it("briefing: unsealed members start on the Brief; sealed ones on Muster (organizer) or Wait", () => {
    for (const s of ["BRIEFING"] as const) {
      expect(allowedScreens(s, false, true)).toEqual(["brief", "muster"]);
      expect(allowedScreens(s, false, false)).toEqual(["brief", "wait"]);
      expect(allowedScreens(s, true, true)).toEqual(["muster", "brief"]);
      expect(allowedScreens(s, true, false)).toEqual(["wait", "brief"]);
    }
  });

  it("later phases are the same for everyone, sealed or not", () => {
    const expected: Partial<Record<TripStatus, string[]>> = {
      AT_TABLE: ["table"], DRY_RUN: ["dryrun", "table"], SEALING: ["seal"], BOOKED: ["booked"], VOIDED: ["voided", "brief"],
    };
    for (const [status, screens] of Object.entries(expected)) {
      for (const sealed of [false, true]) for (const org of [false, true]) {
        expect(allowedScreens(status as TripStatus, sealed, org)).toEqual(screens);
      }
    }
  });

  it("every phase has a main screen, and the organizer never lands on Wait nor crew on Muster", () => {
    for (const s of STATUSES) for (const sealed of [false, true]) {
      expect(allowedScreens(s, sealed, true).length).toBeGreaterThan(0);
      expect(allowedScreens(s, sealed, true)).not.toContain("wait");
      expect(allowedScreens(s, sealed, false)).not.toContain("muster");
    }
  });
});

describe("screenOf", () => {
  it("reads the screen segment of /t/:code/<screen>", () => {
    expect(screenOf("/t/ABC123/brief")).toBe("brief");
    expect(screenOf("/t/ABC123/table/extra")).toBe("table");
    expect(screenOf("/t/ABC123")).toBe("");
    expect(screenOf("/t/ABC123/")).toBe("");
  });
});
