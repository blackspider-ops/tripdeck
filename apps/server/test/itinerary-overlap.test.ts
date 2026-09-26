/**
 * Property: no member's schedule ever overlaps. For random crews (and Cartagena, where the 8-hour Rosario Islands boat
 * day and the 6-hour mud volcano trip both start 08:00–09:00), every member's items on a day are in order with the
 * trip between them respected: the next one starts no earlier than the previous one's end + the travel time.
 */
import { describe, expect, it } from "vitest";
import type { Plan } from "@all-ayes/shared";
import { isGeneratedPort, loadDataset } from "../src/data/loader.js";
import { randomVoyagePlan } from "../src/demo/seed.js";
import { buildChartBook, type PricingMember } from "../src/fit/pricing.js";
import { travel } from "../src/dryrun/walking.js";

const ds = loadDataset();
const ports = ds.cities.map((c) => c._id).filter((id) => !isGeneratedPort(id));

function overlapsIn(plan: Plan, crew: PricingMember[]): string[] {
  const bad: string[] = [];
  for (const m of crew) {
    for (const d of plan.days) {
      const mine = d.items.filter((it) => it.attendees.includes(m.memberId)).sort((a, b) => a.startMin - b.startMin);
      for (let i = 1; i < mine.length; i++) {
        const prev = mine[i - 1], next = mine[i];
        const trip = travel(ds, { id: prev.activityId, lat: prev.lat, lng: prev.lng }, { id: next.activityId, lat: next.lat, lng: next.lng }).minutes;
        if (next.startMin < prev.endMin + trip) bad.push(`${plan._id} ${m.memberId} day ${d.day}: ${prev.name} ${prev.startMin}–${prev.endMin} then ${next.name} at ${next.startMin} (${trip} min away)`);
      }
    }
  }
  return bad;
}

const crewOf = (seed: number, withPorts?: string[]) => {
  const v = randomVoyagePlan(seed, ports, ds.dateWindows.map((w) => w.id));
  const crew: PricingMember[] = v.crew.map((c, i) => ({ memberId: `m${i}`, name: c.name, role: c.role, origin: c.origin, brief: c.brief }));
  return { crew, ports: withPorts ?? v.ports };
};

describe("private schedules never overlap (durations + travel)", () => {
  it("across random seeds, for every member of every plan in the chart book", () => {
    const bad: string[] = [];
    let plans = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { crew, ports: p } = crewOf(seed);
      const book = buildChartBook(ds, crew, p as never, 12);
      plans += book.length;
      for (const plan of book) bad.push(...overlapsIn(plan, crew));
    }
    expect(plans).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  it("Cartagena: the mud volcano never sits on top of the Rosario Islands day", () => {
    if (!ds.cities.some((c) => c._id === "CTG")) return;
    const bad: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const { crew } = crewOf(seed);
      // everyone wants nature + chill (the mud volcano pick) on Cartagena
      const keen = crew.map((m) => ({ ...m, brief: { ...m.brief, mustHaves: ["nature", "chill"] as never, dateWindowIds: ds.dateWindows.map((w) => w.id) } }));
      for (const plan of buildChartBook(ds, keen, ["CTG"] as never, 12)) bad.push(...overlapsIn(plan, keen));
    }
    expect(bad).toEqual([]);
  });
});
