/**
 * R2-WP-14 (O2-043): date labels from one cached `Intl.DateTimeFormat` per shape. `toLocaleDateString` builds a new
 * formatter on every call (~74 µs each; the chart book made 24 of them); a cached one formats in ~3 µs. The output
 * is the same text `toLocaleDateString("en-US", …)` gives. Dates are dataset days (`YYYY-MM-DD`), read at noon UTC.
 */
const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const monthDayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const at = (isoDay: string, offsetDays: number) => {
  const d = new Date(isoDay + "T12:00:00Z");
  if (offsetDays) d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
};

/** "Mon, Jun 1": a trip day's label (`offsetDays` after `isoDay`). */
export const dayLabel = (isoDay: string, offsetDays = 0) => dayFmt.format(at(isoDay, offsetDays));
/** "Jun 1". */
export const monthDayLabel = (isoDay: string) => monthDayFmt.format(at(isoDay, 0));
