/**
 * OPT-068 / OPT-069: direct tests for the small helpers that were only covered through pricing snapshots —
 * dataset derivation and indexes, the travel model, phrasing clamps, hail parsing, env parsing, and the shared
 * money/clock formatters.
 */
import { describe, expect, it, vi } from "vitest";
import type { Dataset } from "@all-ayes/shared";
import { clockToMin, formatCents, formatDollars, minToClock } from "@all-ayes/shared";
import { cityName, deriveW2, indexOf, loadDataset, shiftDay } from "../src/data/loader.js";
import { travel } from "../src/dryrun/walking.js";
import { clampRibbon, clampToSentences } from "../src/negotiation/phrasing.js";
import { parseHail } from "../src/negotiation/rules.js";
import { oneOf } from "../src/config.js";

const ds = loadDataset();

describe("dataset derivation (OPT-069)", () => {
  it("shiftDay crosses month and year boundaries and keeps the clock as written", () => {
    expect(shiftDay("2027-03-31T22:10", 1)).toBe("2027-04-01T22:10");
    expect(shiftDay("2027-12-31T06:00", 1)).toBe("2028-01-01T06:00");
    expect(shiftDay("2028-02-28T23:59", 1)).toBe("2028-02-29T23:59");
    expect(shiftDay("2027-03-01T00:30", -1)).toBe("2027-02-28T00:30");
  });

  it("W2 = every W1 flight a day later at +8%, rounded to the dollar", () => {
    const w1 = ds.flights.filter((f) => f.dateWindowId === "W1");
    const w2 = ds.flights.filter((f) => f.dateWindowId === "W2");
    expect(w2).toHaveLength(w1.length);
    const [f] = deriveW2([{ ...w1[0], priceCents: 41_250, departLocal: "2027-03-11T23:00", arriveLocal: "2027-03-12T09:00" }]);
    expect(f).toMatchObject({ _id: `${w1[0]._id}-w2`, dateWindowId: "W2", priceCents: 44_600, departLocal: "2027-03-12T23:00", arriveLocal: "2027-03-13T09:00" });
    expect(deriveW2(w2)).toEqual([]); // only W1 flights derive
  });

  it("loads once: the same dataset object every time", () => {
    expect(loadDataset()).toBe(ds);
  });
});

describe("dataset index (OPT-029)", () => {
  it("finds cities, hotels, activities and windows by id, cached per dataset", () => {
    const ix = indexOf(ds);
    expect(indexOf(ds)).toBe(ix);
    for (const c of ds.cities) expect(ix.city.get(c._id)).toBe(c);
    for (const h of ds.hotels) expect(ix.hotel.get(h._id)).toBe(h);
    for (const a of ds.activities) expect(ix.activity.get(a._id)).toBe(a);
    for (const w of ds.dateWindows) expect(ix.window.get(w.id)).toBe(w);
    expect(cityName(ds, "LIS")).toBe("Lisbon");
    expect(cityName(ds, "ZZZ")).toBe("ZZZ");
  });

  it("an override matches in either direction, and the first listed wins (as find did)", () => {
    const o = ds.overrides[0];
    expect(indexOf(ds).override(o.fromId, o.toId)).toBe(o);
    expect(indexOf(ds).override(o.toId, o.fromId)).toBe(o);
    const tiny: Dataset = { ...ds, overrides: [
      { fromId: "a", toId: "b", mode: "tram", minutes: 7 },
      { fromId: "b", toId: "a", mode: "taxi", minutes: 9 },
    ] };
    expect(indexOf(tiny).override("b", "a")?.minutes).toBe(7);
    expect(indexOf(tiny).override("a", "c")).toBeUndefined();
  });
});

describe("travel model (OPT-069, doc 07 §7)", () => {
  const at = (id: string, lat: number, lng: number) => ({ id, lat, lng });
  const noOverrides: Dataset = { ...ds, overrides: [] };

  it("walks up to 2 km (×1.3 detour at 4.8 km/h), ×1.4 on Lisbon's hills; taxis beyond", () => {
    const flat = travel(noOverrides, at("x", 38.7, -9.14), at("y", 38.709, -9.14)); // ~1.0 km
    expect(flat.mode).toBe("walk");
    expect(flat.minutes).toBe(16);
    const hill = travel(noOverrides, at("LIS-a-fado", 38.7, -9.14), at("y", 38.709, -9.14));
    expect(hill.minutes).toBe(Math.round(16.3 * 1.4));
    expect(hill.flagged).toBe(false);
    expect(travel(noOverrides, at("x", 38.7, -9.14), at("y", 38.73, -9.14)).mode).toBe("taxi"); // ~3.3 km
  });

  it("an override wins in the reverse direction too", () => {
    const o = ds.overrides[0];
    const leg = travel(ds, at(o.toId, 0, 0), at(o.fromId, 1, 1));
    expect(leg).toMatchObject({ fromId: o.toId, toId: o.fromId, mode: o.mode, minutes: o.minutes });
  });
});

describe("phrasing clamps and hail parsing (OPT-069 / OPT-019)", () => {
  it("clampToSentences keeps whole sentences within the budget, else cuts words", () => {
    expect(clampToSentences("One two. Three four five.", 5)).toBe("One two. Three four five.");
    expect(clampToSentences("One two. Three four five.", 4)).toBe("One two.");
    expect(clampToSentences("one two three four five six", 3)).toBe("one two three.");
  });

  it("clampRibbon keeps at most 8 words", () => {
    expect(clampRibbon("a b c d e f g h i j")).toBe("a b c d e f g h");
    expect(clampRibbon("Lisbon  —  keep the fado")).toBe("Lisbon — keep the fado");
  });

  it("parseHail reads wishes and 'cheaper', nothing else", () => {
    expect(parseHail("m", "Maya", "Beaches and tacos please")).toMatchObject({ tags: ["beach", "food"], cheaper: false });
    expect(parseHail("m", "Maya", "something more affordable")).toMatchObject({ tags: [], cheaper: true });
    expect(parseHail("m", "Maya", "the seashore")).toMatchObject({ tags: [], cheaper: false }); // word boundaries
  });
});

describe("env parsing (OPT-061)", () => {
  it("oneOf accepts a listed value (any case), else warns and uses the default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(oneOf("X", ["rules", "model"] as const, "rules", { X: "model" })).toBe("model");
    expect(oneOf("X", ["rules", "model"] as const, "rules", { X: " Model " })).toBe("model");
    expect(oneOf("X", ["rules", "model"] as const, "rules", {})).toBe("rules");
    expect(warn).not.toHaveBeenCalled();
    expect(oneOf("X", ["rules", "model"] as const, "rules", { X: "modle" })).toBe("rules");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/X=modle is not one of rules, model/));
    warn.mockRestore();
  });
});

describe("shared formatters (OPT-068)", () => {
  it("formatCents: sign, thousands, padded cents", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(-5)).toBe("-$0.05");
    expect(formatCents(103_800)).toBe("$1,038.00");
    expect(formatCents(123_456_789)).toBe("$1,234,567.89");
    expect(formatDollars(86_849)).toBe("$868");
  });

  it("minToClock wraps around the day; clockToMin reads a bare hour", () => {
    expect(minToClock(0)).toBe("00:00");
    expect(minToClock(-30)).toBe("23:30");
    expect(minToClock(1440 + 75)).toBe("01:15");
    expect(clockToMin("7")).toBe(420);
    expect(clockToMin("08:30")).toBe(510);
  });
});

describe("R2-WP-14 (O2-043): cached date formatters", () => {
  it("say exactly what toLocaleDateString said", async () => {
    const { dayLabel, monthDayLabel } = await import("@all-ayes/shared");
    for (let i = 0; i < 400; i += 7) {
      const d = new Date(Date.UTC(2026, 0, 1 + i, 12)).toISOString().slice(0, 10);
      const at = new Date(d + "T12:00:00Z");
      expect(monthDayLabel(d)).toBe(at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }));
      const next = new Date(at); next.setUTCDate(next.getUTCDate() + 3);
      expect(dayLabel(d, 3)).toBe(next.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }));
    }
  });
});
