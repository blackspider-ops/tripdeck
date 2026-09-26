/**
 * The window finder (fit/windows.ts) and the shared calendar helpers (packages/shared/src/dates.ts): generated window
 * ids and labels, range validation, and the finder's rules — lengths, overlaps, gaps, tie-breaks, a crew nobody fully
 * suits, and a 12-month range × 12 members in a few milliseconds.
 */
import { describe, expect, it } from "vitest";
import {
  addDays, addMonths, availableFor, checkDateRange, daysOf, dayNumber, isGeneratedWindowId, parseRangeWindowId, rangeBounds,
  rangeLabel, rangeWindowId, weekday, beyondLiveHorizon, type Availability, type DateRange,
} from "@all-ayes/shared";
import { findWindows } from "../src/fit/windows.js";
import { indexOf, loadDataset } from "../src/data/loader.js";
import { seasonFactor, modelFlights } from "../src/fit/flights.js";

const range = (start: string, end: string, minNights = 3, maxNights = 5): DateRange => ({ start, end, minNights, maxNights });
const free = (start: string, end: string): Availability => ({ days: daysOf(start, end) });
const without = (av: Availability, ...drop: string[]): Availability => ({ days: av.days!.filter((d) => !drop.includes(d)) });

describe("calendar helpers", () => {
  it("parses real ISO days only, and does day arithmetic across months and leap years", () => {
    expect(dayNumber("2027-02-30")).toBeNull();
    expect(dayNumber("2027-3-1")).toBeNull();
    expect(dayNumber(20270301)).toBeNull();
    expect(addDays("2027-02-27", 2)).toBe("2027-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2026-09-26", 12)).toBe("2027-09-26");
    expect(weekday("2027-03-12")).toBe(5); // a Friday
    expect(daysOf("2027-03-30", "2027-04-02")).toEqual(["2027-03-30", "2027-03-31", "2027-04-01", "2027-04-02"]);
  });

  it("names a generated window by its dates: D20270312N4 = Mar 12–16", () => {
    expect(rangeWindowId("2027-03-12", 4)).toBe("D20270312N4");
    expect(parseRangeWindowId("D20270312N4")).toEqual({ id: "D20270312N4", start: "2027-03-12", end: "2027-03-16", nights: 4, label: "Mar 12–16" });
    expect(parseRangeWindowId("D20270330N3")?.label).toBe("Mar 30–Apr 2");
    expect(rangeLabel("2027-12-30", "2028-01-02")).toBe("Dec 30–Jan 2");
    for (const bad of ["W1", "D20270230N3", "D20270312N0", "D20270312N15", "D2027031N4"]) expect(parseRangeWindowId(bad), bad).toBeNull();
    expect(isGeneratedWindowId("D20270312N4")).toBe(true);
    expect(isGeneratedWindowId("W1")).toBe(false);
  });

  it("a generated window resolves wherever a dataset window does (the flight model's season is by month)", () => {
    const ds = loadDataset();
    const ix = indexOf(ds);
    expect(ix.window.get("W1")).toEqual(ds.dateWindows[0]); // the dataset's windows are untouched
    const w = ix.window.get("D20270312N4")!;
    expect(w).toMatchObject({ start: "2027-03-12", end: "2027-03-16", nights: 4 });
    expect(ix.window.has("D20270312N4")).toBe(true);
    expect(ix.window.has("D20270230N4")).toBe(false);
    expect(seasonFactor(w)).toBe(seasonFactor({ id: "x", start: "2027-03-20", end: "2027-03-24", nights: 4 }));
    const flights = modelFlights(ds, "LIS", "ATL", "D20270312N4");
    expect(flights.length).toBeGreaterThan(0);
    for (const f of flights) {
      expect(f.departLocal.startsWith("2027-03-12")).toBe(true);
      expect(f.returnLocal.startsWith("2027-03-16")).toBe(true);
    }
  });

  it("checks a range: from tomorrow, within 12 months, long enough for the shortest trip, 1–14 nights", () => {
    const b = rangeBounds("2026-09-26");
    expect(b).toEqual({ tomorrow: "2026-09-27", lastDay: "2027-09-26" });
    expect(checkDateRange(range("2026-10-01", "2026-10-20"), b)).toBeNull();
    expect(checkDateRange(range("2026-09-27", "2027-09-26", 1, 14), b)).toBeNull();
    expect(checkDateRange(range("2026-09-26", "2026-10-20"), b)).toMatch(/tomorrow/);
    expect(checkDateRange(range("2026-10-01", "2027-09-27"), b)).toMatch(/12 months/);
    expect(checkDateRange(range("2026-10-01", "2026-10-03", 3, 5), b)).toMatch(/too short for 3 nights/);
    expect(checkDateRange(range("2026-10-01", "2026-10-04", 3, 5), b)).toBeNull(); // Oct 1 → Oct 4 = 3 nights
    expect(checkDateRange(range("2026-10-01", "2026-10-20", 5, 3), b)).toMatch(/nights/);
    expect(checkDateRange(range("2026-10-01", "2026-10-20", 0, 3), b)).toMatch(/nights/);
    expect(checkDateRange(range("2026-10-01", "2026-10-20", 3, 15), b)).toMatch(/nights/);
    expect(checkDateRange({ start: "2026-10-01" }, b)).toMatch(/earliest departure/);
    expect(checkDateRange(range("2026-10-20", "2026-10-01"), b)).toMatch(/too short/);
  });

  it("flags a range ending past the ~330-day live-price horizon", () => {
    expect(beyondLiveHorizon("2027-08-22", "2026-09-26")).toBe(false); // 330 days
    expect(beyondLiveHorizon("2027-08-23", "2026-09-26")).toBe(true);
  });

  it("a member is available for a window only when free every day of it, departure and return included", () => {
    expect(availableFor({ any: true }, "2027-03-12", "2027-03-16")).toBe(true);
    expect(availableFor(undefined, "2027-03-12", "2027-03-16")).toBe(true);
    expect(availableFor(free("2027-03-12", "2027-03-16"), "2027-03-12", "2027-03-16")).toBe(true);
    expect(availableFor(free("2027-03-12", "2027-03-15"), "2027-03-12", "2027-03-16")).toBe(false);
  });
});

describe("findWindows", () => {
  it("everyone free: three weekend-friendly, non-overlapping windows in date order, lengths within min..max", () => {
    // Mar 2027: the 12th is a Friday
    const ws = findWindows(range("2027-03-01", "2027-03-31"), [{ any: true }, { any: true }, { any: true }]);
    expect(ws).toHaveLength(3);
    for (const w of ws) {
      expect(w.nights).toBeGreaterThanOrEqual(3);
      expect(w.nights).toBeLessThanOrEqual(5);
      expect(w.id).toBe(rangeWindowId(w.start, w.nights));
      expect(w.end).toBe(addDays(w.start, w.nights));
      expect(w.available).toBe(3);
      expect(w.start >= "2027-03-01" && w.end <= "2027-03-31").toBe(true);
    }
    expect(ws.map((w) => w.start)).toEqual([...ws.map((w) => w.start)].sort());
    // weekend fit: the fewest workdays per day away are 3-nighters around a weekend (Thu→Sun, Fri→Mon, Sat→Tue: 2 of 4)
    for (const w of ws) { expect([4, 5, 6]).toContain(weekday(w.start)); expect(w.nights).toBe(3); }
    // earliest first among equals: the first weekend (Thu Mar 4 → Sun Mar 7)
    expect(ws[0]).toMatchObject({ id: "D20270304N3", label: "Mar 4–7" });
    // non-overlapping-ish: any two share at most one day
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
      const shared = daysOf(ws[i].start, ws[i].end).filter((d) => daysOf(ws[j].start, ws[j].end).includes(d));
      expect(shared.length).toBeLessThanOrEqual(1);
    }
  });

  it("most members first: the window everyone can make beats an earlier one only some can", () => {
    const a = free("2027-03-01", "2027-03-31");
    const b = free("2027-03-17", "2027-03-25"); // only the second half of the month
    const ws = findWindows(range("2027-03-01", "2027-03-31"), [a, a, b]);
    const best = [...ws].sort((x, y) => y.available - x.available)[0];
    expect(best.available).toBe(3);
    expect(best.start >= "2027-03-17" && best.end <= "2027-03-25").toBe(true);
    expect(ws.filter((w) => w.available === 3).length).toBeGreaterThanOrEqual(1);
  });

  it("a gap splits a member's days: no window everyone can make crosses it", () => {
    const all = free("2027-03-10", "2027-03-20");
    const gap = without(all, "2027-03-14");
    const ws = findWindows(range("2027-03-10", "2027-03-20", 3, 4), [all, all, gap]);
    const full = ws.filter((w) => w.available === 3);
    expect(full.length).toBeGreaterThan(0);
    for (const w of full) expect(daysOf(w.start, w.end)).not.toContain("2027-03-14");
  });

  it("nobody's days overlap for a whole trip: the windows with the most members still come back", () => {
    const ws = findWindows(range("2027-03-01", "2027-03-31", 3, 3), [free("2027-03-01", "2027-03-06"), free("2027-03-20", "2027-03-26"), free("2027-03-02", "2027-03-05")]);
    expect(ws.length).toBe(3);
    expect(Math.max(...ws.map((w) => w.available))).toBe(2); // members 1 and 3 overlap Mar 2–5
    expect(ws.find((w) => w.available === 2)).toMatchObject({ start: "2027-03-02", end: "2027-03-05" });
  });

  it("members with no marked days in range count as unavailable; `any` counts as free", () => {
    const ws = findWindows(range("2027-03-05", "2027-03-15", 3, 3), [{ days: ["2026-01-01"] }, { any: true }]);
    expect(ws.every((w) => w.available === 1)).toBe(true);
  });

  it("only lengths the range can hold: a range of exactly the shortest trip gives one window", () => {
    expect(findWindows(range("2027-03-12", "2027-03-15", 3, 5), [{ any: true }])).toEqual([
      { id: "D20270312N3", start: "2027-03-12", end: "2027-03-15", nights: 3, label: "Mar 12–15", available: 1 },
    ]);
    expect(findWindows(range("2027-03-12", "2027-03-14", 3, 5), [{ any: true }])).toEqual([]);
  });

  it("a small range is topped up with the best distinct trips (still ≤ 3, no duplicates)", () => {
    const ws = findWindows(range("2027-03-12", "2027-03-17", 3, 5), [{ any: true }, { any: true }]);
    expect(ws).toHaveLength(3);
    expect(new Set(ws.map((w) => w.id)).size).toBe(3);
  });

  it("ties: fewer workdays per day away, then earlier, then longer", () => {
    // Mon Mar 1 → Sun Mar 7 2027, 2 nights only: Fri→Sun (1 workday of 3) beats every other 2-nighter
    const ws = findWindows(range("2027-03-01", "2027-03-07", 2, 2), [{ any: true }], 1);
    expect(ws).toEqual([expect.objectContaining({ id: "D20270305N2" })]);
    // two equal-fraction trips: the earlier wins (Sat Mar 6→Tue Mar 9 vs Sat Mar 13→Tue Mar 16, both 2 of 4)
    const two = findWindows(range("2027-03-06", "2027-03-16", 3, 3), [{ any: true }], 1);
    expect(two[0].start).toBe("2027-03-06");
    // same start, same fraction: the longer trip (Fri→Mon 2/4 vs Fri→Wed 4/6 — not equal; Sat→Sun 0/2 needs 1 night)
    const one = findWindows(range("2027-03-06", "2027-03-07", 1, 1), [{ any: true }], 3);
    expect(one).toEqual([expect.objectContaining({ id: "D20270306N1", label: "Mar 6–7" })]);
  });

  it("is deterministic", () => {
    const avs = [free("2027-04-01", "2027-04-20"), without(free("2027-04-01", "2027-04-30"), "2027-04-09"), { any: true } as Availability];
    expect(findWindows(range("2027-04-01", "2027-04-30"), avs)).toEqual(findWindows(range("2027-04-01", "2027-04-30"), avs));
  });

  it("a 12-month range × 12 members, trips of 1–14 nights, runs in well under 100 ms", () => {
    const r = range("2026-10-01", "2027-09-30", 1, 14);
    const days = daysOf(r.start, r.end);
    const avs: Availability[] = Array.from({ length: 12 }, (_, i) => ({ days: days.filter((_, k) => (k * 7 + i * 13) % 11 !== 0) }));
    const t0 = performance.now();
    const ws = findWindows(r, avs);
    const ms = performance.now() - t0;
    expect(ws).toHaveLength(3);
    expect(ms).toBeLessThan(100);
  });
});
