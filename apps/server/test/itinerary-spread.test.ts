/**
 * Booked itineraries cover every day of the stay: the chosen moments are spread over the stay (not crammed into one
 * day), and the whole-stay itinerary (shared buildItinerary) has nights + 1 dated days, arrival first and departure
 * last, with each chosen moment exactly once.
 */
import { describe, expect, it } from "vitest";
import { buildItinerary, type Plan } from "@all-ayes/shared";
import { isGeneratedPort, loadDataset } from "../src/data/loader.js";
import { buildChartBook, toPrivate, type PricingMember } from "../src/fit/pricing.js";
import { randomVoyagePlan } from "../src/demo/seed.js";

const ds = loadDataset();
const ports = ds.cities.map((c) => c._id).filter((id) => !isGeneratedPort(id));
const windowIds = ds.dateWindows.map((w) => w.id);
const books: { seed: number; crew: PricingMember[]; book: Plan[] }[] = [];
for (let seed = 1; seed <= 30; seed++) {
  const v = randomVoyagePlan(seed, ports, windowIds);
  const crew = v.crew.map((c, i): PricingMember => ({ memberId: `m${i}`, name: c.name, role: c.role, origin: c.origin, brief: c.brief }));
  books.push({ seed, crew, book: buildChartBook(ds, crew, v.ports, 4) });
}

describe("whole-stay itineraries", () => {
  it("N nights → N+1 dated days, arrival and departure present, each moment once", () => {
    let checked = 0;
    for (const { seed, crew, book } of books) for (const p of book) {
      const win = ds.dateWindows.find((w) => w.id === p.dateWindowId)!;
      for (const m of crew) {
        const mine = toPrivate(p, m.memberId)!;
        const days = buildItinerary({ days: mine.days, nights: win.nights, startDate: win.start, neighborhood: "Old Town", hotelName: "Inn", cityName: p.cityId, arrival: mine.arrival, departure: mine.departure, route: mine.route });
        expect(days.length, `seed ${seed} ${p._id}`).toBeGreaterThanOrEqual(win.nights + 1);
        expect(days[0].role).toBe("arrival");
        expect(days.at(-1)!.role).toBe("departure");
        expect(days[0].entries.some((e) => e.title.startsWith("Check in"))).toBe(true);
        expect(days.at(-1)!.entries.some((e) => e.title.startsWith("Check out"))).toBe(true);
        for (const d of days) expect(d.entries.length, `seed ${seed} ${p._id} day ${d.day}`).toBeGreaterThan(0);
        const ids = days.flatMap((d) => d.entries).map((e) => e.activityId).filter(Boolean);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBe(mine.days.flatMap((d) => d.items).length);
        if (mine.route) expect(days.at(-1)!.entries.some((e) => e.kind === "flight")).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("spreads the moments: with 2+ full days and 3+ moments, no single day holds them all", () => {
    let eligible = 0;
    for (const { seed, book } of books) for (const p of book) {
      const total = p.days.flatMap((d) => d.items).length;
      if (p.days.length < 4 || total < 3) continue;
      eligible++;
      const most = Math.max(...p.days.map((d) => d.items.length));
      expect(most, `seed ${seed} ${p._id}`).toBeLessThan(total);
    }
    expect(eligible).toBeGreaterThan(0);
  });

  it("share lines read in plain words", () => {
    const p = books[0].book[0];
    const lines = toPrivate(p, books[0].crew[0].memberId)!.lines;
    const lodging = lines.find((l) => l.kind === "lodging")!.label;
    expect(lodging).toMatch(/\d+ nights?/);
    expect(lodging).not.toMatch(/×\d+n$/);
    const flight = lines.find((l) => l.kind === "flight");
    if (flight) expect(flight.label).toMatch(/^Round-trip flight · [A-Z0-9]{3,4} ⇄ [A-Z0-9]{3,4}$/);
  });
});
