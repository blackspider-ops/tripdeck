/**
 * The window finder (docs/03 P1, docs/04 §4.12): from the organizer's date range, the trip lengths it allows and every
 * member's private availability, the up-to-3 trips (departure day × nights) the voyage offers. Pure; the helm calls it
 * when the last terms seal (to prefetch live prices) and when the table meets (the windows then stay with the voyage).
 *
 * Every candidate trip is a departure day d and a length n in minNights..maxNights whose days d..d+n (departure and
 * return included) lie in the range. Ranked by:
 *   1. members free every day of it, most first
 *   2. weekend fit: fewer workdays (Mon–Fri) per day away
 *   3. earlier departure, then the longer trip
 * then picked greedily, skipping any that shares more than one day with a window already picked ("non-overlapping-ish":
 * back-to-back trips may share the changeover day). A range too small for three such trips is topped up with the
 * best remaining distinct ones. When no trip suits everyone the windows with the most members win; who can't make a
 * window is handled like any other term it breaks (a private "date_mismatch" on that member's share).
 */
import { GENERATED_WINDOWS, addDays, dayNumber, rangeLabel, rangeWindowId, weekday, type Availability, type DateRange, type DateWindow } from "@all-ayes/shared";

export interface FoundWindow extends DateWindow {
  /** Members free for the whole window (server-internal: never sent, never said per member). */
  available: number;
}

interface Candidate { s: number; n: number; count: number; work: number }

/** Better first: more members, fewer workdays per day away, earlier, longer. */
function compare(a: Candidate, b: Candidate): number {
  if (a.count !== b.count) return b.count - a.count;
  const wa = a.work * (b.n + 1), wb = b.work * (a.n + 1); // a.work/(a.n+1) vs b.work/(b.n+1), in integers
  if (wa !== wb) return wa - wb;
  if (a.s !== b.s) return a.s - b.s;
  return b.n - a.n;
}

/** Days shared by two trips (inclusive day spans). */
const shared = (a: Candidate, b: Candidate) => Math.max(0, Math.min(a.s + a.n, b.s + b.n) - Math.max(a.s, b.s) + 1);

/**
 * The voyage's generated windows (1..`count`, in date order), or [] when the range can't hold a trip of `minNights`.
 * `availability[i]` undefined or `{any: true}` = free every day of the range.
 */
export function findWindows(range: DateRange, availability: (Availability | undefined)[], count = GENERATED_WINDOWS): FoundWindow[] {
  const a = dayNumber(range.start), b = dayNumber(range.end);
  if (a === null || b === null || b < a) return [];
  const N = b - a + 1;
  // per member: prefix counts of free days over the range, so "free all of d..d+n" is O(1)
  const prefixes = availability.map((av) => {
    const p = new Int32Array(N + 1);
    if (!av || av.any) { for (let i = 0; i < N; i++) p[i + 1] = i + 1; return p; }
    const free = new Uint8Array(N);
    for (const d of av.days ?? []) { const k = dayNumber(d); if (k !== null && k >= a && k <= b) free[k - a] = 1; }
    for (let i = 0; i < N; i++) p[i + 1] = p[i] + free[i];
    return p;
  });
  const work = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) { const wd = weekday(addDays(range.start, i)); work[i + 1] = work[i] + (wd === 0 || wd === 6 ? 0 : 1); }

  const cands: Candidate[] = [];
  const maxN = Math.min(range.maxNights, N - 1);
  for (let n = Math.max(1, range.minNights); n <= maxN; n++) {
    for (let s = 0; s + n < N; s++) {
      let c = 0;
      for (const p of prefixes) if (p[s + n + 1] - p[s] === n + 1) c++;
      cands.push({ s, n, count: c, work: work[s + n + 1] - work[s] });
    }
  }
  cands.sort(compare);

  const picked: Candidate[] = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    if (picked.every((p) => shared(p, c) <= 1)) picked.push(c);
  }
  // a small range: top up with the best remaining distinct trips
  for (const c of cands) {
    if (picked.length >= count) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked
    .sort((x, y) => x.s - y.s || x.n - y.n)
    .map((c) => {
      const start = addDays(range.start, c.s), end = addDays(range.start, c.s + c.n);
      return { id: rangeWindowId(start, c.n), start, end, nights: c.n, label: rangeLabel(start, end), available: c.count };
    });
}
