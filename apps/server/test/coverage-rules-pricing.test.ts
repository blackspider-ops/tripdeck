/**
 * O2-065 (R2-WP-17): negotiation rules 3–5 and the hail "cheaper" branch, driven directly (not only through the
 * scripted Expo meeting), and the pricing failure paths: no flight, date mismatch, the hostel and long-walks
 * dealbreakers, and shortlist() with fewer than two considered plans.
 */
import { describe, expect, it } from "vitest";
import type { Plan, Tag } from "@all-ayes/shared";
import { loadDataset } from "../src/data/loader.js";
import { buildChartBook, buildPlan, type PricingMember } from "../src/fit/pricing.js";
import { apply, decideResponse, newTableState, parseHail, shortlist } from "../src/negotiation/rules.js";
import { EXPO_CREW } from "./fixtures.js";

const ds = loadDataset();

// ---------- a hand-built table ----------
interface Seat { fits?: boolean; sat?: number; missing?: Tag[]; covered?: Tag[]; cents?: number }
/** A plan with just what the rules read: per-member fit, coverage, satisfaction and share, and a fairness score. */
function plan(id: string, cityId: string, seats: Record<string, Seat>, maximin = 50): Plan {
  return {
    _id: id, cityId, dateWindowId: "W1", hotelId: `${cityId}-h-x`, days: [], groupCents: 0, publicFlags: [],
    fairness: { maximin, sum: maximin * 3 },
    fitsEveryone: Object.values(seats).every((s) => s.fits !== false),
    members: Object.entries(seats).map(([memberId, s]) => ({
      memberId, flightId: "", amountCents: s.cents ?? 100_000, lines: [], flags: [],
      fits: s.fits !== false, reasons: s.fits === false ? ["over_cap"] : ["ok"],
      covered: s.covered ?? [], missing: s.missing ?? [], satisfaction: s.sat ?? 60,
    })),
  } as unknown as Plan;
}
/** Everyone's backing: memberId → planId (as PROPOSE, first proposer recorded unless `proposer` says otherwise). */
function table(backing: Record<string, string>, proposer: Record<string, string> = {}) {
  const st = newTableState();
  for (const [m, pid] of Object.entries(backing)) {
    apply(st, m, { act: "PROPOSE", planId: pid, why: { kind: "propose", seconding: false } });
  }
  for (const [pid, m] of Object.entries(proposer)) st.proposedBy.set(pid, m);
  return st;
}

describe("O2-065: decideResponse rule 3 — answering an objection to my plan", () => {
  it("moves to the objector's plan: SUPPORT when it costs my member ≤ 25 points, CONCEDE when more", () => {
    const close = [plan("A", "LIS", { rae: { sat: 70 }, maya: { sat: 40, missing: ["beach"] } }), plan("B", "MEX", { rae: { sat: 50 }, maya: { sat: 80 } })];
    const st = table({ rae: "A", maya: "B" }, { A: "nobody" });
    st.objections.push({ by: "maya", planId: "A", tag: "beach" });
    expect(decideResponse(ds, close, st, "rae", 2)).toMatchObject({ act: "SUPPORT", planId: "B", why: { kind: "support_switch" } });

    const far = [plan("A", "LIS", { rae: { sat: 90 }, maya: { sat: 40 } }), plan("B", "MEX", { rae: { sat: 50 }, maya: { sat: 80 } })];
    expect(decideResponse(ds, far, st, "rae", 2)).toMatchObject({ act: "CONCEDE", planId: "B", why: { kind: "concede" } });
  });

  it("ignores the objection when their plan doesn't fit my member or misses one of my must-haves", () => {
    const st = table({ rae: "A", maya: "B" }, { A: "nobody" });
    st.objections.push({ by: "maya", planId: "A", tag: "beach" });
    // their plan misses one of my must-haves, and isn't close enough for rule 5 → hold
    const missing = [plan("A", "LIS", { rae: { sat: 90 }, maya: {} }), plan("B", "MEX", { rae: { sat: 30, missing: ["food"] }, maya: {} })];
    expect(decideResponse(ds, missing, st, "rae", 2)).toMatchObject({ act: "SUPPORT", planId: "A", why: { kind: "support_hold" } });
    const unfit = [plan("A", "LIS", { rae: { sat: 90 }, maya: {} }), plan("B", "MEX", { rae: { fits: false }, maya: {} })];
    expect(decideResponse(ds, unfit, st, "rae", 2)).toMatchObject({ act: "SUPPORT", planId: "A", why: { kind: "support_hold" } });
  });

  it("an objection without a must-have tag (unfit), or my own objection, isn't answered by switching", () => {
    const plans = [plan("A", "LIS", { rae: { sat: 90 }, maya: {} }), plan("B", "MEX", { rae: { sat: 50 }, maya: {} })];
    const st = table({ rae: "A", maya: "B" }, { A: "nobody" });
    st.objections.push({ by: "maya", planId: "A" }, { by: "rae", planId: "A", tag: "food" });
    expect(decideResponse(ds, plans, st, "rae", 2)).toMatchObject({ act: "SUPPORT", planId: "A", why: { kind: "support_hold" } });
  });
});

describe("O2-065: decideResponse rule 4 — Watch 3 majority", () => {
  const crew = (rival: Seat) => [
    plan("A", "LIS", { rae: { sat: 95 }, maya: {}, dev: {} }),
    plan("B", "MEX", { rae: { sat: 20, ...rival }, maya: {}, dev: {} }),
  ];

  it("falls in with a majority plan that fits (CONCEDE), even one far worse for my member", () => {
    const st = table({ rae: "A", maya: "B", dev: "B" });
    expect(decideResponse(ds, crew({}), st, "rae", 3)).toMatchObject({ act: "CONCEDE", planId: "B", why: { kind: "concede" } });
  });

  it("objects to a majority plan that doesn't fit, with the real reason", () => {
    const st = table({ rae: "A", maya: "B", dev: "B" });
    expect(decideResponse(ds, crew({ fits: false }), st, "rae", 3))
      .toMatchObject({ act: "OBJECT", planId: "B", why: { kind: "object_unfit", reason: "over_cap", againstPlanId: "B" } });
  });

  it("half the table isn't a majority, and Watch 2 never applies the rule", () => {
    const tie = table({ rae: "A", sam: "A", maya: "B", dev: "B" });
    const plans = [plan("A", "LIS", { rae: { sat: 95 }, sam: {}, maya: {}, dev: {} }), plan("B", "MEX", { rae: { sat: 20 }, sam: {}, maya: {}, dev: {} })];
    expect(decideResponse(ds, plans, tie, "rae", 3)).toMatchObject({ act: "SUPPORT", planId: "A", why: { kind: "support_hold" } });
    const st = table({ rae: "A", maya: "B", dev: "B" }, { A: "nobody" });
    expect(decideResponse(ds, crew({}), st, "rae", 2)).toMatchObject({ act: "SUPPORT", planId: "A", why: { kind: "support_hold" } });
  });
});

describe("O2-065: decideResponse rule 5 — a rival nearly as good", () => {
  const st = () => table({ rae: "A", maya: "B" }, { A: "nobody" });

  it("supports a rival within 10 preference points that fits and misses no more must-haves", () => {
    const plans = [plan("A", "LIS", { rae: { sat: 70 }, maya: {} }), plan("B", "MEX", { rae: { sat: 62 }, maya: {} })];
    expect(decideResponse(ds, plans, st(), "rae", 2)).toMatchObject({ act: "SUPPORT", planId: "B", why: { kind: "support_switch" } });
  });

  it("holds when the rival is more than 10 points worse, misses more, or doesn't fit", () => {
    const worse = [plan("A", "LIS", { rae: { sat: 70 }, maya: {} }), plan("B", "MEX", { rae: { sat: 55 }, maya: {} })];
    const missesMore = [plan("A", "LIS", { rae: { sat: 70, covered: ["food"] }, maya: {} }), plan("B", "MEX", { rae: { sat: 90, missing: ["food"] }, maya: {} })];
    const unfit = [plan("A", "LIS", { rae: { sat: 70 }, maya: {} }), plan("B", "MEX", { rae: { fits: false }, maya: {} })];
    for (const plans of [worse, missesMore, unfit]) {
      expect(decideResponse(ds, plans, st(), "rae", 2)).toMatchObject({ act: "SUPPORT", planId: "A", why: { kind: "support_hold" } });
    }
  });

  it("nothing but my own plan backed → hold", () => {
    const plans = [plan("A", "LIS", { rae: {}, maya: {} }), plan("B", "MEX", { rae: {}, maya: {} })];
    expect(decideResponse(ds, plans, table({ rae: "A", maya: "A" }), "rae", 2)).toMatchObject({ act: "SUPPORT", planId: "A", why: { kind: "support_hold" } });
  });
});

describe("O2-065: decideResponse rule 1 — a hail asking for cheaper", () => {
  it("parseHail marks cheaper wording and nothing else", () => {
    expect(parseHail("rae", "Rae", "can we find something cheaper?").cheaper).toBe(true);
    expect(parseHail("rae", "Rae", "keep it affordable please")).toMatchObject({ cheaper: true, tags: [] });
    expect(parseHail("rae", "Rae", "more beaches and tacos")).toMatchObject({ cheaper: false, tags: ["beach", "food"] });
  });

  it("follows the cheapest backed plan that still fits my member (CONCEDE naming the hailer)", () => {
    const plans = [
      plan("A", "LIS", { rae: { cents: 120_000 }, maya: {}, dev: {} }),
      plan("B", "MEX", { rae: { cents: 90_000 }, maya: {}, dev: {} }),
      plan("C", "YUL", { rae: { cents: 50_000, fits: false }, maya: {}, dev: {} }), // cheaper, but doesn't fit
    ];
    const st = table({ rae: "A", maya: "B", dev: "C" });
    const hail = parseHail("rae", "Rae", "go cheaper");
    expect(decideResponse(ds, plans, st, "rae", 2, hail)).toMatchObject({ act: "CONCEDE", planId: "B", why: { kind: "concede", hailFrom: "Rae" } });
  });

  it("holds when my plan is already the cheapest; a tag nobody offers falls back to cheaper", () => {
    const plans = [plan("A", "LIS", { rae: { cents: 80_000 }, maya: {} }), plan("B", "MEX", { rae: { cents: 90_000 }, maya: {} })];
    const st = table({ rae: "A", maya: "B" }, { A: "nobody" });
    expect(decideResponse(ds, plans, st, "rae", 2, parseHail("rae", "Rae", "cheaper")))
      .toMatchObject({ act: "SUPPORT", planId: "A", why: { kind: "support_hold" } });
    // these plans have no scheduled activities, so no plan offers "museums": the cheaper part decides
    const pricier = [plan("A", "LIS", { rae: { cents: 95_000 }, maya: {} }), plan("B", "MEX", { rae: { cents: 90_000 }, maya: {} })];
    expect(decideResponse(ds, pricier, st, "rae", 2, parseHail("rae", "Rae", "museums, and cheaper")))
      .toMatchObject({ act: "CONCEDE", planId: "B" });
  });

  it("a hail with neither a matching tag nor cheaper wording falls through to the other rules", () => {
    const plans = [plan("A", "LIS", { rae: { sat: 70 }, maya: {} }), plan("B", "MEX", { rae: { sat: 65 }, maya: {} })];
    const st = table({ rae: "A", maya: "B" }, { A: "nobody" });
    expect(decideResponse(ds, plans, st, "rae", 2, parseHail("rae", "Rae", "museums please")))
      .toMatchObject({ act: "SUPPORT", planId: "B", why: { kind: "support_switch" } }); // rule 5
  });
});

// ---------- pricing failure paths ----------
const hotel = (id: string) => ds.hotels.find((h) => h._id === id)!;
const seat = (p: Plan, id: string) => p.members.find((m) => m.memberId === id)!;
const withBrief = (id: string, patch: Partial<PricingMember["brief"]>): PricingMember[] =>
  EXPO_CREW.map((m) => (m.memberId === id ? { ...m, brief: { ...m.brief, ...patch } } : m));

describe("O2-065: pricing failure paths", () => {
  it("no_flight: a member with no flight from their origin has no flight line and doesn't fit", () => {
    // no curated flight and no modelled one either: an airport the flight model doesn't know
    const crew = EXPO_CREW.map((m) => (m.memberId === "rae" ? { ...m, origin: "ZZZ" } : m));
    const p = buildPlan(ds, crew, "LIS", "W1", hotel("LIS-h-casa-alfama"));
    const rae = seat(p, "rae");
    expect(rae.reasons).toContain("no_flight");
    expect(rae).toMatchObject({ fits: false, flightId: "", satisfaction: 0 });
    expect(rae.lines.some((l) => l.kind === "flight")).toBe(false);
    expect(seat(p, "maya").fits).toBe(true);
    expect(p.fitsEveryone).toBe(false);
  });

  it("date_mismatch: a window a member can't do is flagged for them only (W2 flights are derived from W1)", () => {
    const p = buildPlan(ds, EXPO_CREW, "LIS", "W2", hotel("LIS-h-casa-alfama"));
    expect(seat(p, "rae")).toMatchObject({ fits: false, reasons: ["date_mismatch"] });
    expect(seat(p, "maya")).toMatchObject({ fits: false, reasons: ["date_mismatch"] });
    expect(seat(p, "dev").reasons).not.toContain("date_mismatch"); // Dev can do W1 or W2
    expect(seat(p, "dev").flightId).not.toBe("");
    // the chart book only prices the windows the most members can do
    expect(buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"], 50).every((q) => q.dateWindowId === "W1")).toBe(true);
  });

  it("dealbreaker:hostel: a hostel doesn't fit the member who ruled it out, and the chart book skips hostels", () => {
    const p = buildPlan(ds, EXPO_CREW, "LIS", "W1", hotel("LIS-h-bairro-hostel"));
    expect(seat(p, "maya").reasons).toContain("dealbreaker:hostel");
    expect(seat(p, "rae").reasons).not.toContain("dealbreaker:hostel");
    const book = buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"], 50);
    expect(book.some((q) => q.hotelId.includes("hostel"))).toBe(false);
    const noRule = withBrief("maya", { dealbreakers: [] });
    expect(buildChartBook(ds, noRule, ["LIS", "MEX", "YUL"], 50).some((q) => q.hotelId.includes("hostel"))).toBe(true);
  });

  it("dealbreaker:long_walks: a plan with a long walk doesn't fit a member who ruled them out", () => {
    const crew = withBrief("maya", { dealbreakers: ["long_walks"] });
    const p = buildPlan(ds, crew, "LIS", "W1", hotel("LIS-h-casa-alfama")); // the 30-min uphill walk to fado
    expect(seat(p, "maya").flags.some((f) => f.type === "long_walk")).toBe(true);
    expect(seat(p, "maya")).toMatchObject({ fits: false, reasons: ["dealbreaker:long_walks"], satisfaction: 0 });
    const mex = buildPlan(ds, crew, "MEX", "W1", hotel("MEX-h-roma-flat"));
    expect(seat(mex, "maya").reasons).not.toContain("dealbreaker:long_walks");
  });

  describe("shortlist() with fewer than two considered plans", () => {
    const book = buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"], 12);

    it("nothing considered: the fairest plan and the best plan in another city", () => {
      const [a, b] = shortlist(book, newTableState());
      expect(a._id).toBe(book[0]._id);
      expect(b.cityId).not.toBe(a.cityId);
    });

    it("one plan considered: it is padded with the next plans, and B is still another city", () => {
      const st = newTableState();
      const only = book[book.length - 1];
      apply(st, "rae", { act: "PROPOSE", planId: only._id, why: { kind: "propose", seconding: false } });
      const [a, b] = shortlist(book, st);
      expect(a._id).not.toBe(b._id);
      expect(a.cityId).not.toBe(b.cityId);
    });

    it("every plan in one city: B is the next plan there, never A twice", () => {
      const lisbon = book.filter((p) => p.cityId === "LIS");
      expect(lisbon.length).toBeGreaterThanOrEqual(2);
      const [a, b] = shortlist(lisbon, newTableState());
      expect(b._id).not.toBe(a._id);
      expect(b.cityId).toBe("LIS");
    });

    it("a single plan can't make a shortlist (reported by name)", () => {
      expect(() => shortlist(book.slice(0, 1), newTableState())).toThrow(/second plan/);
    });
  });
});
