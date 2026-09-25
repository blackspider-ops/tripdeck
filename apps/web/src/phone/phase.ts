// Phone routing policy (OPT-035): which screens a crew member may be on in each phase. Pure, unit-tested.
import type { TripStatus } from "@all-ayes/shared";

export type Screen = "muster" | "brief" | "wait" | "table" | "dryrun" | "seal" | "booked" | "voided";

/** The screens allowed for a phase; the first one is where a phase change takes everyone. */
export function allowedScreens(status: TripStatus, sealed: boolean, organizer: boolean): Screen[] {
  switch (status) {
    case "BRIEFING":
      if (!sealed) return organizer ? ["brief", "muster"] : ["brief", "wait"];
      return organizer ? ["muster", "brief"] : ["wait", "brief"];
    case "AT_TABLE": return ["table"];
    case "DRY_RUN": return ["dryrun", "table"];
    case "SEALING": return ["seal"];
    case "BOOKED": return ["booked"];
    case "VOIDED": return ["voided", "brief"];
  }
}

/** The screen segment of /t/:code/<screen>/…, or "" at the voyage root. */
export function screenOf(pathname: string): string {
  return pathname.split("/")[3] ?? "";
}
