/**
 * The whole-stay itinerary and the human share-line wording (Booked, Seal, Dry Run, headset panel).
 * Pure: the server places the chosen moments (fit/pricing.ts spreads them over the stay); this fills every day of the
 * stay around them — the flight in, transfer and check-in on day 1, meals and free time on the full days, check-out,
 * transfer and the flight home on the last day — so a booked itinerary never shows a lone day.
 */
import type { MyDay } from "./types.js";
import { dayLabel } from "./format.js";

// ---------- share lines ----------

/** "Round-trip flight · IAD ⇄ SDF". */
export const flightLabel = (origin: string, airport: string) => `Round-trip flight · ${origin} ⇄ ${airport}`;

/** "Inn at the Park · 2 rooms · 3 nights · your share (1 of 5)"; one room and a crew of one say less. */
export function lodgingLabel(name: string, rooms: number, nights: number, crewSize: number): string {
  const parts = [name];
  if (rooms > 1) parts.push(`${rooms} rooms`);
  parts.push(`${nights} night${nights === 1 ? "" : "s"}`);
  if (crewSize > 1) parts.push(`your share (1 of ${crewSize})`);
  return parts.join(" · ");
}

const FRACTIONS: Record<string, number> = { "½": 2, "⅓": 3, "¼": 4 };
/**
 * A share line's label in plain words. Lines from older builds read "Flight IAD⇄SDF" and
 * "Inn at the Park ×2, 1/5 ×3n"; those are rewritten; anything else is returned as is.
 */
export function humanShareLabel(label: string): string {
  const f = /^Flight ([A-Z0-9]{3,4})\s*⇄\s*([A-Z0-9]{3,4})$/.exec(label);
  if (f) return flightLabel(f[1], f[2]);
  const l = /^(.+?)(?: ×(\d+),?)?(?: (½|⅓|¼|1\/(\d+)))? ×(\d+)n$/.exec(label);
  if (l) {
    const crew = l[3] ? (FRACTIONS[l[3]] ?? Number(l[4])) : 1;
    return lodgingLabel(l[1], l[2] ? Number(l[2]) : 1, Number(l[5]), crew);
  }
  return label;
}

// ---------- the whole-stay itinerary ----------

export type ItineraryKind = "flight" | "transfer" | "stay" | "meal" | "activity" | "free";
export interface ItineraryEntry {
  /** Minutes after local midnight; null for an untimed block ("Free afternoon"). */
  startMin: number | null;
  title: string;
  kind: ItineraryKind;
  /** The server's activity id for chosen moments (each appears once across the stay). */
  activityId?: string;
}
export interface ItineraryDay { day: number; label: string; role: "arrival" | "full" | "departure"; entries: ItineraryEntry[] }

export interface ItineraryInput {
  /** My days from plan:private (day 1 = arrival). */
  days: MyDay[];
  /** Nights of the stay: the itinerary always has nights + 1 days. */
  nights: number;
  /** The window's first day (ISO), for labels of days the server didn't send. */
  startDate?: string;
  neighborhood: string;
  hotelName: string;
  cityName: string;
  arrival?: { landMin: number; atStayMin: number };
  departure?: { departMin: number };
  /** My route ("IAD", "SDF") when I fly; absent for a home port. */
  route?: { origin: string; airport: string };
}

export const CHECK_IN_MIN = 15 * 60;
export const CHECK_OUT_MIN = 11 * 60;
const DEFAULT_FLIGHT_HOME_MIN = 17 * 60;
const DINNER_MIN = 19 * 60 + 30;
const BREAKFAST_MIN = 8 * 60 + 30;
const LUNCH_MIN = 12 * 60 + 30;

const busy = (items: { startMin: number; endMin: number }[], from: number, to: number) => items.some((it) => it.startMin < to && it.endMin > from);

/** Every day of the stay, arrival to departure, with the chosen moments spread as the server placed them. */
export function buildItinerary(input: ItineraryInput): ItineraryDay[] {
  const total = Math.max(2, input.nights + 1, input.days.length);
  const byDay = new Map(input.days.map((d) => [d.day, d] as const));
  const out: ItineraryDay[] = [];
  const hood = input.neighborhood;
  // the flight home can't sit in the day anything is placed on: moments on the last day (older plans) move onto the
  // previous full day's list rather than vanish
  for (let d = 1; d <= total; d++) {
    const src = byDay.get(d);
    const label = src?.label ?? (input.startDate ? dayLabel(input.startDate, d - 1) : `Day ${d}`);
    const role: ItineraryDay["role"] = d === 1 ? "arrival" : d === total ? "departure" : "full";
    const items = [...(src?.items ?? [])].sort((a, b) => a.startMin - b.startMin);
    const entries: ItineraryEntry[] = items.map((it) => ({ startMin: it.startMin, title: it.name, kind: "activity", activityId: it.activityId }));

    if (role === "arrival") {
      const land = input.arrival?.landMin;
      if (input.route && land !== undefined) {
        entries.push({ startMin: land, title: `Flight lands · ${input.route.origin} → ${input.route.airport}`, kind: "flight" });
        entries.push({ startMin: land + 15, title: `Transfer to ${input.hotelName}`, kind: "transfer" });
      } else if (input.route) {
        entries.push({ startMin: null, title: `Fly in · ${input.route.origin} → ${input.route.airport}, then transfer to ${input.hotelName}`, kind: "flight" });
      } else {
        entries.push({ startMin: null, title: `Make your way to ${input.cityName}`, kind: "transfer" });
      }
      const atStay = input.arrival?.atStayMin ?? CHECK_IN_MIN;
      entries.push({ startMin: Math.max(CHECK_IN_MIN, atStay), title: `Check in · ${input.hotelName}`, kind: "stay" });
      const checkIn = Math.max(CHECK_IN_MIN, atStay);
      // an easy dinner after check-in (a late landing just gets a late bite)
      if (checkIn <= DINNER_MIN - 30 && !busy(items, DINNER_MIN - 60, DINNER_MIN + 90)) entries.push({ startMin: DINNER_MIN, title: `Easy dinner in ${hood}`, kind: "meal" });
      else if (checkIn > DINNER_MIN - 30 && checkIn < 22 * 60 && !busy(items, checkIn, checkIn + 120)) entries.push({ startMin: checkIn + 30, title: `Late bite near ${hood}`, kind: "meal" });
    } else if (role === "full") {
      if (!busy(items, BREAKFAST_MIN - 30, BREAKFAST_MIN + 60)) entries.push({ startMin: BREAKFAST_MIN, title: `Breakfast near ${hood}`, kind: "meal" });
      if (!busy(items, 9 * 60 + 30, 12 * 60)) entries.push({ startMin: null, title: `Free morning · explore ${hood}`, kind: "free" });
      if (!busy(items, 12 * 60, 14 * 60)) entries.push({ startMin: LUNCH_MIN, title: "Lunch", kind: "meal" });
      if (!busy(items, 14 * 60, 18 * 60)) entries.push({ startMin: null, title: "Free afternoon", kind: "free" });
      if (!busy(items, DINNER_MIN - 60, DINNER_MIN + 90)) entries.push({ startMin: DINNER_MIN, title: `Dinner in ${hood}`, kind: "meal" });
    } else {
      const home = input.departure?.departMin ?? DEFAULT_FLIGHT_HOME_MIN;
      if (!busy(items, BREAKFAST_MIN - 30, BREAKFAST_MIN + 60)) entries.push({ startMin: BREAKFAST_MIN, title: `Breakfast near ${hood}`, kind: "meal" });
      entries.push({ startMin: CHECK_OUT_MIN, title: `Check out · ${input.hotelName}`, kind: "stay" });
      if (input.route) {
        entries.push({ startMin: Math.max(CHECK_OUT_MIN + 30, home - 150), title: `Transfer to ${input.route.airport}`, kind: "transfer" });
        entries.push({ startMin: home, title: `Flight home · ${input.route.airport} → ${input.route.origin}`, kind: "flight" });
      } else {
        entries.push({ startMin: null, title: "Head home", kind: "transfer" });
      }
    }
    // timed entries in order; untimed blocks sit where their part of the day is (morning before lunch, afternoon after)
    const slot = (e: ItineraryEntry) => e.startMin ?? (e.title.startsWith("Free morning") ? 10 * 60 : e.title === "Free afternoon" ? 14 * 60 : 12 * 60);
    entries.sort((a, b) => slot(a) - slot(b));
    out.push({ day: d, label, role, entries });
  }
  return out;
}
