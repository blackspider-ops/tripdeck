// @vitest-environment happy-dom
// A crew of up to 12 (MAX_CREW): twelve band swatches, and the Table's top-down chart seats twelve with a key.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BANDS, MAX_CREW, type Band, type CrewPublic } from "@all-ayes/shared";
import { BandSwatches, firstFreeBand } from "./ui";
import { TopDownChart } from "../screens/Table";

afterEach(cleanup);

describe("BandSwatches", () => {
  it("offers all twelve bands, taken ones disabled", () => {
    const onChange = vi.fn();
    render(<BandSwatches value={5} onChange={onChange} taken={[1, 2, 3, 4, 5]} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(MAX_CREW);
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(Object.values(BANDS).map((b) => `${b.name} band`));
    expect(radios.slice(0, 4).every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    expect((radios[4] as HTMLButtonElement).disabled).toBe(false); // the one you hold stays yours
    fireEvent.click(radios[11]);
    expect(onChange).toHaveBeenCalledWith(12);
  });
  it("firstFreeBand looks past the first four", () => {
    expect(firstFreeBand([1, 2, 3, 4])).toBe(5);
    expect(firstFreeBand([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as Band[])).toBe(12);
  });
});

describe("TopDownChart", () => {
  const crew = (n: number) => Array.from({ length: n }, (_, i) => ({
    memberId: `m${i}`, name: `Mate${i}`, role: i === 0 ? "organizer" : i === n - 1 ? "absent" : "member", band: (i + 1) as Band, briefSealed: true,
  })) as CrewPublic[];
  const seats = (c: HTMLElement) => [...c.querySelectorAll("g[data-seat]")].map((g) => {
    const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute("transform")!)!;
    return { x: +m[1], y: +m[2] };
  });
  it("seats twelve without touching, initials on the chart and the names in a key", () => {
    const { container } = render(<TopDownChart crew={crew(12)} organizerId="m0" speakingId="m3" />);
    const pts = seats(container);
    expect(pts).toHaveLength(12);
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(2 * 9 + 6);
    const key = screen.getByRole("list", { name: "Who sits where" });
    expect(key.querySelectorAll("li")).toHaveLength(12);
    expect(key.textContent).toContain("Mate11 (away)");
    expect(key.querySelector("li.speaking")?.textContent).toBe("Mate3");
  });
  it("spreads twelve round the whole ring (the 3D table's plan), not bunched at the top", () => {
    const { container } = render(<TopDownChart crew={crew(12)} organizerId="m0" speakingId={null} />);
    const pts = seats(container);
    const cx = 150, cy = 150;
    const quarter = (fx: (x: number) => boolean, fy: (y: number) => boolean) => pts.filter((p) => fx(p.x - cx) && fy(p.y - cy)).length;
    const lt = (v: number) => v < 0, ge = (v: number) => v >= 0;
    for (const q of [quarter(lt, lt), quarter(ge, lt), quarter(lt, ge), quarter(ge, ge)]) expect(q).toBeGreaterThanOrEqual(2);
    expect(pts.filter((p) => p.y > cy).length).toBeGreaterThanOrEqual(5); // the Organizer and four more along the front
    expect(pts[0].x).toBeCloseTo(cx); // the Organizer, south
    expect(pts[0].y).toBeGreaterThan(cy);
  });
  it("up to six, names sit on the chart and there is no key", () => {
    const { container } = render(<TopDownChart crew={crew(4)} organizerId="m0" speakingId={null} />);
    expect(seats(container)).toHaveLength(4);
    expect(screen.queryByRole("list", { name: "Who sits where" })).toBeNull();
    expect(container.textContent).toContain("Mate1");
  });
});
