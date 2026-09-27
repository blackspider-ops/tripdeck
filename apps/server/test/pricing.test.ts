import { describe, expect, it } from "vitest";
import { loadDataset } from "../src/data/loader.js";
import { buildChartBook, buildPlan, toPublic } from "../src/fit/pricing.js";
import { EXPO_CREW } from "./fixtures.js";

const ds = loadDataset();
const hotel = (id: string) => ds.hotels.find((h) => h._id === id)!;
const share = (p: ReturnType<typeof buildPlan>, id: string) => p.members.find((m) => m.memberId === id)!;

describe("pricing — doc 07 §9 worked plans", () => {
  it("Lisbon / Casa Alfama reproduces shares to the cent", () => {
    const p = buildPlan(ds, EXPO_CREW, "LIS", "W1", hotel("LIS-h-casa-alfama"));
    expect(p._id).toBe("LIS-W1-casa-alfama");
    expect(share(p, "rae").amountCents).toBe(103_800);
    expect(share(p, "maya").amountCents).toBe(86_800);
    expect(share(p, "dev").amountCents).toBe(96_300);
    expect(p.groupCents).toBe(286_900);
    expect(p.fitsEveryone).toBe(true);
    // every member: overnight flight + 30-min uphill walk to fado
    for (const m of p.members) {
      expect([...new Set(m.flags.map((f) => f.type))].sort()).toEqual(["long_walk", "red_eye"]); // picks now spread over the stay: a walk per day
      expect(m.missing).toEqual([]);
    }
    expect(p.publicFlags.map((f) => f.type).sort()).toEqual(["long_walk", "red_eye"]);
  });

  it("Mexico City / Roma Norte reproduces shares; Maya misses beach", () => {
    const p = buildPlan(ds, EXPO_CREW, "MEX", "W1", hotel("MEX-h-roma-flat"));
    expect(share(p, "rae").amountCents).toBe(70_800);
    expect(share(p, "maya").amountCents).toBe(59_800);
    expect(share(p, "dev").amountCents).toBe(66_900);
    expect(p.groupCents).toBe(197_500);
    expect(share(p, "maya").missing).toEqual(["beach"]);
    expect(p.publicFlags).toEqual([]);
  });

  it("Dev never gets the 2-stop flight", () => {
    const p = buildPlan(ds, EXPO_CREW, "MEX", "W1", hotel("MEX-h-roma-flat"));
    expect(share(p, "dev").flightId).toBe("MEX-f-jfk-am");
  });

  it("organizer absorbs the lodging remainder cent (Montréal)", () => {
    const p = buildPlan(ds, EXPO_CREW, "YUL", "W1", hotel("YUL-h-plateau"));
    const lodging = (id: string) => share(p, id).lines.find((l) => l.kind === "lodging")!.amountCents;
    expect(lodging("rae")).toBe(22_668);
    expect(lodging("maya")).toBe(22_666);
    expect(lodging("rae") + lodging("maya") + lodging("dev")).toBe(68_000);
  });

  it("schedules every activity inside its start window", () => {
    for (const plan of buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"], 50)) {
      for (const day of plan.days) for (const it of day.items) {
        const a = ds.activities.find((x) => x._id === it.activityId)!;
        const [eh, em] = a.startEarliest.split(":").map(Number);
        const [lh, lm] = a.startLatest.split(":").map(Number);
        expect(it.startMin, `${plan._id} ${a._id}`).toBeGreaterThanOrEqual(eh * 60 + em);
        expect(it.startMin, `${plan._id} ${a._id}`).toBeLessThanOrEqual(lh * 60 + lm);
      }
    }
  });

  it("chart book: no hostels for this crew; MEX is fairest; only Casa Alfama fits everyone in Lisbon", () => {
    const book = buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"], 50);
    expect(book.some((p) => p.hotelId.includes("hostel"))).toBe(false);
    expect(book[0]._id).toBe("MEX-W1-roma-flat");
    const lisFits = book.filter((p) => p.cityId === "LIS" && p.fitsEveryone).map((p) => p._id);
    expect(lisFits).toEqual(["LIS-W1-casa-alfama"]);
  });

  it("public view carries no shares, caps or fit per member", () => {
    const p = buildPlan(ds, EXPO_CREW, "LIS", "W1", hotel("LIS-h-casa-alfama"));
    const json = JSON.stringify(toPublic(ds, p));
    expect(json).not.toContain("amountCents");
    expect(json).not.toContain("capCents");
    expect(json).not.toContain("satisfaction");
    expect(json).not.toContain("86800");
  });
});
