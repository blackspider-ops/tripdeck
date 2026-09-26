/**
 * Organizer-chosen date ranges and member availability (docs/03 P1/P4, docs/04 §4). Pure calendar arithmetic on ISO
 * days (`YYYY-MM-DD`, read as UTC days so no timezone ever shifts one): the Create calendar, the Brief's "When can you
 * go?", the helm's validation and window finder (apps/server/src/fit/windows.ts) all share it. No date library.
 *
 * A generated window's id says everything about it: `D20270312N4` = depart 2027-03-12, 4 nights (back 2027-03-16).
 */
import type { Availability, DateRange, DateWindow } from "./types.js";

/** Trip length the organizer may allow (nights). */
export const MIN_NIGHTS = 1;
export const MAX_NIGHTS = 14;
export const DEFAULT_MIN_NIGHTS = 3;
export const DEFAULT_MAX_NIGHTS = 5;
/** The range may end at most this many months out. */
export const RANGE_MAX_MONTHS = 12;
/** A date-range voyage offers up to this many generated windows. */
export const GENERATED_WINDOWS = 3;
/**
 * Airlines open fares ~330 days ahead (docs/12): a range ending later gets the gentle "we'll estimate" note, and the
 * live prefetch skips flights past it (apps/server/src/trips/live.ts FLIGHT_HORIZON_DAYS).
 */
export const LIVE_PRICE_HORIZON_DAYS = 330;
export const LIVE_PRICE_NOTE = "Live prices may not be available that far ahead — we'll estimate.";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for a valid ISO day, else null ("2027-02-30" is not a day). */
export function dayNumber(iso: unknown): number | null {
  if (typeof iso !== "string" || !ISO_DAY.test(iso)) return null;
  const ms = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  const n = ms / DAY_MS;
  return fromDayNumber(n) === iso ? n : null;
}
export const isIsoDay = (s: unknown): s is string => dayNumber(s) !== null;
export function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
export function addDays(iso: string, n: number): string {
  return fromDayNumber((dayNumber(iso) ?? 0) + n);
}
/** `b − a` in days. */
export function daysBetween(a: string, b: string): number {
  return (dayNumber(b) ?? 0) - (dayNumber(a) ?? 0);
}
/** 0 = Sunday … 6 = Saturday. */
export function weekday(iso: string): number {
  return (((dayNumber(iso) ?? 0) + 4) % 7 + 7) % 7; // 1970-01-01 was a Thursday
}
/** The same day `n` months later (clamped to the month's end: Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) - 1 + n, d = Number(iso.slice(8, 10));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}
/** Every day from `start` to `end`, both included. */
export function daysOf(start: string, end: string): string[] {
  const a = dayNumber(start), b = dayNumber(end);
  if (a === null || b === null || b < a) return [];
  return Array.from({ length: b - a + 1 }, (_, i) => fromDayNumber(a + i));
}
/** Today on this device's own calendar (the phone), as an ISO day. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mar 12–16", "Mar 30–Apr 2" (the phone's formatWindow shape). */
export function rangeLabel(start: string, end: string): string {
  const sm = MONTHS[Number(start.slice(5, 7)) - 1], em = MONTHS[Number(end.slice(5, 7)) - 1];
  const sd = Number(start.slice(8, 10)), ed = Number(end.slice(8, 10));
  return `${sm} ${sd}–${em === sm && start.slice(0, 4) === end.slice(0, 4) ? "" : `${em} `}${ed}`;
}

/** `D20270312N4`: a generated window's id. */
export function rangeWindowId(start: string, nights: number): string {
  return `D${start.replace(/-/g, "")}N${nights}`;
}
const GENERATED_ID = /^D(\d{4})(\d{2})(\d{2})N(\d{1,2})$/;
export const isGeneratedWindowId = (id: string) => GENERATED_ID.test(id);
/** The window a generated id names (label "Mar 12–16"), or null for anything else. */
export function parseRangeWindowId(id: string): DateWindow | null {
  const m = GENERATED_ID.exec(id);
  if (!m) return null;
  const start = `${m[1]}-${m[2]}-${m[3]}`;
  const nights = Number(m[4]);
  if (dayNumber(start) === null || nights < MIN_NIGHTS || nights > MAX_NIGHTS) return null;
  const end = addDays(start, nights);
  return { id, start, end, nights, label: rangeLabel(start, end) };
}

/** Is the member free every day of this window (departure and return days included)? */
export function availableFor(av: Availability | undefined, start: string, end: string): boolean {
  if (!av || av.any) return true;
  const days = new Set(av.days ?? []);
  return daysOf(start, end).every((d) => days.has(d));
}

/**
 * What's wrong with a date range, or null. `tomorrow` is the earliest start; `lastDay` the latest end (today plus
 * RANGE_MAX_MONTHS). The range must hold at least one trip of `minNights`.
 */
export function checkDateRange(r: Partial<DateRange> | undefined, bounds: { tomorrow: string; lastDay: string }): string | null {
  if (!r || !isIsoDay(r.start) || !isIsoDay(r.end)) return "Pick the earliest departure and the latest return.";
  const minN = r.minNights, maxN = r.maxNights;
  if (!Number.isInteger(minN) || !Number.isInteger(maxN) || minN! < MIN_NIGHTS || maxN! > MAX_NIGHTS || minN! > maxN!) {
    return `Trip length is ${MIN_NIGHTS} to ${MAX_NIGHTS} nights (shortest first).`;
  }
  if (r.start < bounds.tomorrow) return "The earliest departure is tomorrow.";
  if (r.end > bounds.lastDay) return `Keep it within the next ${RANGE_MAX_MONTHS} months.`;
  if (daysBetween(r.start, r.end) < minN!) return `The range is too short for ${minN} night${minN === 1 ? "" : "s"}.`;
  return null;
}

/** Bounds for `checkDateRange` from a calendar day ("today" on the phone). */
export function rangeBounds(today: string): { tomorrow: string; lastDay: string } {
  return { tomorrow: addDays(today, 1), lastDay: addMonths(today, RANGE_MAX_MONTHS) };
}

/** Does the range end past the live-price horizon (the Create note)? */
export function beyondLiveHorizon(end: string, today: string): boolean {
  return daysBetween(today, end) > LIVE_PRICE_HORIZON_DAYS;
}
