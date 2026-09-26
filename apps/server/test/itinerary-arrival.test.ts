/**
 * A member's private day never lists anything before they land (the live random demo showed Milo landing in
 * Asheville at 21:45 after a noon "together" moment and an 8 pm one). Group moments on day 1 wait for the crew's
 * latest landing (or move to day 2); every day of the window is on the schedule, free days included.
 */
import { describe, expect, it } from "vitest";
import { dayLabel, type Plan } from "@all-ayes/shared";
import { isGeneratedPort, loadDataset } from "../src/data/loader.js";
import { buildChartBook, toPrivate, toPublic, type PricingMember } from "../src/fit/pricing.js";
import { randomVoyagePlan } from "../src/demo/seed.js";

const ds = loadDataset();
const ports = ds.cities.map((c) => c._id).filter((id) => !isGeneratedPort(id));
const windowIds = ds.dateWindows.map((w) => w.id);
/** Same rule as the builder: free from landing + 60 min, rounded up to the half hour. */
const freeFrom = (landMin: number) => Math.ceil((landMin + 60) / 30) * 30;

const books: { seed: number; crew: PricingMember[]; book: Plan[] }[] = [];
for (let seed = 1; seed <= 50; seed++) {
  const v = randomVoyagePlan(seed, ports, windowIds);
  const crew = v.crew.map((c, i): PricingMember => ({ memberId: `m${i}`, name: c.name, role: c.role, origin: c.origin, brief: c.brief }));
  books.push({ seed, crew, book: buildChartBook(ds, crew, v.ports, 6) });
}

describe("private itineraries respect arrivals (50 random voyages)", () => {
  it("covers late landings (the case that broke)", () => {
    const late = books.flatMap((b) => b.book).filter((p) => (p.days[0].arrivals ?? []).some((a) => a.landMin >= 19 * 60));
    expect(late.length).toBeGreaterThan(10);
  });

  it("no member's private item on the arrival day starts before they land and reach the stay", () => {
    for (const { seed, crew, book } of books) for (const p of book) for (const m of crew) {
      const priv = toPrivate(p, m.memberId)!;
      if (!priv.arrival) continue;
      for (const it of priv.days[0].items) {
        expect(it.startMin, `seed ${seed} ${p._id} ${m.memberId} ${it.name}`).toBeGreaterThanOrEqual(priv.arrival.atStayMin);
        expect(it.startMin, `seed ${seed} ${p._id} ${m.memberId} ${it.name}`).toBeGreaterThanOrEqual(freeFrom(priv.arrival.landMin));
      }
    }
  });

  it("group moments on day 1 start after the crew's latest landing", () => {
    for (const { seed, crew, book } of books) for (const p of book) {
      const latest = Math.max(0, ...(p.days[0].arrivals ?? []).map((a) => freeFrom(a.landMin)));
      for (const it of p.days[0].items.filter((x) => x.attendees.length === crew.length && crew.length > 1)) {
        if (ds.activities.find((a) => a._id === it.activityId)?.role !== "group") continue;
        expect(it.startMin, `seed ${seed} ${p._id} ${it.name}`).toBeGreaterThanOrEqual(latest);
      }
      // every group moment is still on the plan, for everyone
      const groups = p.days.flatMap((d) => d.items).filter((it) => ds.activities.find((a) => a._id === it.activityId)?.role === "group");
      for (const g of groups) expect(g.attendees.length).toBe(crew.length);
    }
  });

  it("the private schedule shows every day of the window from day 1 to the flight home", () => {
    for (const { seed, crew, book } of books) for (const p of book) {
      const win = ds.dateWindows.find((w) => w.id === p.dateWindowId)!;
      // day 1 is the latest landing date (the window's first day, or later after a long flight); the last is the flight home
      expect(p.days.length, `seed ${seed} ${p._id}`).toBeGreaterThanOrEqual(2);
      expect(p.days.length, `seed ${seed} ${p._id}`).toBeLessThanOrEqual(win.nights + 1);
      if (p.days.length > 2) expect(p.days.at(-1)!.label, `seed ${seed} ${p._id}`).toBe(dayLabel(win.end));
      if (p.days[0].label === dayLabel(win.start)) expect(p.days.length, `seed ${seed} ${p._id}`).toBe(win.nights + 1);
      const priv = toPrivate(p, crew[0].memberId)!;
      expect(priv.days.map((d) => d.day)).toEqual(p.days.map((_, i) => i + 1));
      expect(new Set(priv.days.map((d) => d.label)).size).toBe(priv.days.length);
    }
  });

  it("the public schedule stays crew-independent: no arrivals, group moments within their listed hours", () => {
    for (const { book } of books.slice(0, 10)) for (const p of book) {
      const pub = toPublic(ds, p);
      expect(JSON.stringify(pub)).not.toMatch(/arrivals|landMin|atStayMin|attendees/);
      for (const d of pub.days) expect(d.label).toBe(`Day ${d.day}`);
      for (const it of pub.days.flatMap((d) => d.items).filter((x) => x.kind === "group")) {
        const a = ds.activities.find((x) => x._id === it.activityId)!;
        const [h, m] = a.startEarliest.split(":").map(Number);
        const [h2, m2] = a.startLatest.split(":").map(Number);
        expect(it.startMin).toBeGreaterThanOrEqual(h * 60 + m);
        expect(it.startMin).toBeLessThanOrEqual(h2 * 60 + m2);
      }
    }
  });
});
