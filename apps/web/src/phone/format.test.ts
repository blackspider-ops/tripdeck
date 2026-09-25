import { describe, expect, it } from "vitest";
import { countdownLabel, formatWindow, windowLabel } from "./format";

describe("formatWindow (OPT-012)", () => {
  it("formats a same-month window with an en dash, optionally with the year", () => {
    expect(formatWindow("2027-03-12", "2027-03-16")).toBe("Mar 12–16");
    expect(formatWindow("2027-03-12", "2027-03-16", { year: true })).toBe("Mar 12–16, 2027");
  });
  it("names both months when the window crosses one", () => {
    expect(formatWindow("2027-03-29", "2027-04-02")).toBe("Mar 29–Apr 2");
  });
  it("looks a window up by id", () => {
    const ws = [{ id: "W1", start: "2027-03-12", end: "2027-03-16" }];
    expect(windowLabel(ws, "W1")).toBe("Mar 12–16");
    expect(windowLabel(ws, "W9")).toBe("");
  });
});

describe("countdownLabel (WP-04 seal countdown)", () => {
  it("shows m:ss, rounding up, and never goes below zero", () => {
    expect(countdownLabel(581_000)).toBe("9:41");
    expect(countdownLabel(59_001)).toBe("1:00");
    expect(countdownLabel(5_000)).toBe("0:05");
    expect(countdownLabel(-3_000)).toBe("0:00");
  });
});
