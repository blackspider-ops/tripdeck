// @vitest-environment happy-dom
// The month-grid calendar (Create's range, the Brief's "When can you go?"), rendered: weekday alignment, month paging
// within bounds, range picking, tap / keyboard / drag marking (mouse and touch), and the read-only mode.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaysCalendar, RangeCalendar, monthTitle } from "./Calendar";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function RangeHarness({ onChange }: { onChange?: (s: string | null, e: string | null) => void }) {
  const [r, setR] = useState<{ s: string | null; e: string | null }>({ s: null, e: null });
  return (
    <>
      <RangeCalendar min="2026-12-15" max="2027-02-10" start={r.s} end={r.e} onChange={(s, e) => { setR({ s, e }); onChange?.(s, e); }} />
      <output>{r.s ?? "-"}|{r.e ?? "-"}</output>
    </>
  );
}
function DaysHarness({ initial = [], disabled = false }: { initial?: string[]; disabled?: boolean }) {
  const [days, setDays] = useState<string[]>(initial);
  return (
    <>
      <DaysCalendar min="2027-03-08" max="2027-03-21" days={days} onChange={setDays} disabled={disabled} />
      <output>{days.join(",")}</output>
    </>
  );
}
const out = () => screen.getByRole("status").textContent;
const day = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("the month grid", () => {
  it("lays days under the right weekday, with blanks before the 1st", () => {
    render(<DaysHarness />);
    const grid = screen.getByRole("group", { name: "Days I can go" });
    expect(within(grid).getByText("March 2027")).toBeTruthy();
    const cells = grid.querySelector(".cal-grid")!.children;
    // March 1 2027 is a Monday: one blank (Sunday) first
    expect(cells[0].className).toBe("cal-blank");
    expect(cells[1].getAttribute("data-day")).toBe("2027-03-01");
    expect(cells[1].getAttribute("aria-label")).toBe("Mon, Mar 1");
    expect(grid.querySelectorAll("[data-day]")).toHaveLength(31);
    expect(monthTitle("2027-12")).toBe("December 2027");
  });

  it("pages months only within the bounds, across a year end", () => {
    render(<RangeHarness />);
    const g = screen.getByRole("group", { name: "Trip dates" });
    expect(within(g).getByText("December 2026")).toBeTruthy();
    expect((within(g).getByRole("button", { name: "Previous month" }) as HTMLButtonElement).disabled).toBe(true);
    expect(day("Mon, Dec 14").disabled).toBe(true); // before min
    expect(day("Tue, Dec 15").disabled).toBe(false);
    fireEvent.click(within(g).getByRole("button", { name: "Next month" }));
    expect(within(g).getByText("January 2027")).toBeTruthy();
    fireEvent.click(within(g).getByRole("button", { name: "Next month" }));
    expect(within(g).getByText("February 2027")).toBeTruthy();
    expect((within(g).getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(true);
    expect(day("Thu, Feb 11").disabled).toBe(true); // after max
  });
});

describe("RangeCalendar", () => {
  it("tap a start, then an end; a tap before the start moves it; a third tap starts over", () => {
    const seen: [string | null, string | null][] = [];
    render(<RangeHarness onChange={(s, e) => seen.push([s, e])} />);
    fireEvent.click(day("Sun, Dec 20"));
    expect(out()).toBe("2026-12-20|-");
    expect(day("Sun, Dec 20").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(day("Fri, Dec 18")); // before the start: the start moves
    expect(out()).toBe("2026-12-18|-");
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    fireEvent.click(day("Sat, Jan 2"));
    expect(out()).toBe("2026-12-18|2027-01-02");
    expect(day("Sat, Jan 2").className).toContain("m-end");
    expect(day("Fri, Jan 1").className).toContain("m-between");
    expect(day("Sun, Jan 3").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(day("Mon, Jan 4")); // a third tap starts a new range
    expect(out()).toBe("2027-01-04|-");
    // the same day twice = a one-day range
    fireEvent.click(day("Mon, Jan 4"));
    expect(out()).toBe("2027-01-04|2027-01-04");
    expect(day("Mon, Jan 4").className).toContain("m-single");
    expect(seen).toHaveLength(5);
  });
});

describe("DaysCalendar", () => {
  it("a keyboard press (click with detail 0) toggles one day", () => {
    render(<DaysHarness />);
    fireEvent.click(day("Wed, Mar 10"));
    expect(out()).toBe("2027-03-10");
    fireEvent.click(day("Wed, Mar 10"));
    expect(out()).toBe("");
  });

  it("a mouse tap toggles once (pointerdown marks it; the click that follows is ignored)", () => {
    render(<DaysHarness />);
    fireEvent.pointerDown(day("Wed, Mar 10"), { button: 0 });
    fireEvent.pointerUp(window);
    fireEvent.click(day("Wed, Mar 10"), { detail: 1 });
    expect(out()).toBe("2027-03-10");
  });

  it("dragging from an unmarked day marks every day it passes; from a marked day it clears them", () => {
    render(<DaysHarness initial={["2027-03-15"]} />);
    fireEvent.pointerDown(day("Fri, Mar 12"), { button: 0 });
    for (const d of ["Sat, Mar 13", "Sun, Mar 14", "Mon, Mar 15", "Tue, Mar 16"]) fireEvent.pointerEnter(day(d));
    fireEvent.pointerUp(window);
    expect(out()).toBe("2027-03-12,2027-03-13,2027-03-14,2027-03-15,2027-03-16");
    fireEvent.pointerEnter(day("Wed, Mar 17")); // not painting any more
    expect(out()).toBe("2027-03-12,2027-03-13,2027-03-14,2027-03-15,2027-03-16");
    // clear from Sat 13 across to Mon 15 (Sat was marked: this drag clears)
    fireEvent.pointerDown(day("Sat, Mar 13"), { button: 0 });
    fireEvent.pointerEnter(day("Sun, Mar 14"));
    fireEvent.pointerEnter(day("Mon, Mar 15"));
    fireEvent.pointerUp(window);
    expect(out()).toBe("2027-03-12,2027-03-16");
  });

  it("a touch drag follows the finger (pointermove + elementFromPoint), never outside the range", () => {
    render(<DaysHarness />);
    const grid = document.querySelector(".cal-grid")!;
    expect(grid.className).toContain("paint"); // touch-action: none while marking
    let under: Element | null = null;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => under });
    fireEvent.pointerDown(day("Mon, Mar 8"), { button: 0, pointerType: "touch" });
    for (const name of ["Tue, Mar 9", "Wed, Mar 10"]) {
      under = day(name);
      act(() => { fireEvent.pointerMove(grid, { clientX: 10, clientY: 10, pointerType: "touch" }); });
    }
    under = day("Sun, Mar 7"); // before the range: ignored
    fireEvent.pointerMove(grid, { clientX: 1, clientY: 1 });
    fireEvent.pointerCancel(window);
    under = day("Thu, Mar 11");
    fireEvent.pointerMove(grid, { clientX: 1, clientY: 1 }); // after the drag ended
    expect(out()).toBe("2027-03-08,2027-03-09,2027-03-10");
  });

  it("read-only: days show marked but don't toggle", () => {
    render(<DaysHarness initial={["2027-03-09"]} disabled />);
    expect(day("Tue, Mar 9").getAttribute("aria-pressed")).toBe("true");
    expect(day("Tue, Mar 9").disabled).toBe(true);
    fireEvent.click(day("Wed, Mar 10"));
    fireEvent.pointerDown(day("Wed, Mar 10"), { button: 0 });
    expect(out()).toBe("2027-03-09");
    expect(document.querySelector(".cal-grid")!.className).not.toContain("paint");
  });
});
