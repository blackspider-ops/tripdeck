/**
 * OPT-012: one date-window label for every phone screen ("Mar 12–16", optionally ", 2027").
 * Dates are ISO days (YYYY-MM-DD); read at noon UTC so no timezone shifts the day.
 * (The scene's SealCeremony uses this too; the server's datesLabel/labelFor still have their own copies — see WP-13 notes.)
 */
export function formatWindow(start: string, end: string, opts: { year?: boolean } = {}): string {
  const s = new Date(start + "T12:00:00Z");
  const e = new Date(end + "T12:00:00Z");
  const month = (d: Date) => d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const endLabel = month(e) === month(s) ? `${e.getUTCDate()}` : `${month(e)} ${e.getUTCDate()}`;
  return `${month(s)} ${s.getUTCDate()}–${endLabel}${opts.year ? `, ${e.getUTCFullYear()}` : ""}`;
}

/** The label for a date window by id, or "" if it isn't on the trip. */
export function windowLabel(windows: { id: string; start: string; end: string }[], id: string | undefined, opts?: { year?: boolean }): string {
  const w = windows.find((x) => x.id === id);
  return w ? formatWindow(w.start, w.end, opts) : "";
}

/** "9:41" — minutes and seconds left, for the seal countdown (never negative). */
export function countdownLabel(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
