// Every line the chart room prints or captions, in one place (OPT-025). Strings the phone or the helm
// also show live in @all-ayes/shared; the rest are the chart room's own. No three.js import.
import {
  BACK_TO_CHARTS, BOOKED_HEADLINE, SEALING_FOOTER, VOID_HEADLINE, waitingOnTerms,
  type TripState, type TripStatus,
} from "@all-ayes/shared";

/** Speaker name on the caption card for the app's own lines (phase captions, rejections). */
export const NARRATOR = "All Ayes";

/** Caption for a phase, or nothing (the table's own lines speak for AT_TABLE). */
export function phaseCaption(trip: TripState): string | undefined {
  const pending = trip.crew.filter((c) => !c.briefSealed);
  const text: Partial<Record<TripStatus, string>> = {
    BRIEFING: pending.length ? waitingOnTerms(pending.map((p) => p.name)) : "Every crew member's terms are sealed. Weigh anchor when ready.",
    DRY_RUN: "Two charts. Watch them run dry, then pick one.",
    SEALING: `Each friend sets their seal. ${SEALING_FOOTER}`,
    BOOKED: BOOKED_HEADLINE,
    VOIDED: VOID_HEADLINE,
  };
  return text[trip.status];
}

export const CARD = {
  voidTitle: "NOBODY WAS CHARGED",
  backToCharts: BACK_TO_CHARTS,
  hailTitle: "HAIL THE TABLE",
  hailCancel: "Never mind",
  menuTitle: "CHART ROOM",
  weighAnchor: "Weigh anchor",
  sealFooter: SEALING_FOOTER,
  captionIdle: "Waiting on the crew…",
} as const;

/** One-tap hails from the headset (the phone types its own). */
export const HAIL_PRESETS = [
  "I'd pay more for the beach.",
  "Let's keep it cheap.",
  "Food matters most to me.",
  "Nothing too early, please.",
] as const;
