/**
 * OPT-032 / OPT-029 acceptance: the chart book (plans, public views, private views) is byte-for-byte what it was
 * before buildPlan was split into steps and the dataset lookups moved to maps. Each scenario's JSON is hashed so the
 * snapshot stays small; pricing.test.ts shows the details when a hash moves.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CityId } from "@all-ayes/shared";
import { indexOf, loadDataset } from "../src/data/loader.js";
import { buildChartBook, toPrivate, toPublic, type PricingMember } from "../src/fit/pricing.js";
import { EXPO_CREW } from "./fixtures.js";

const ds = loadDataset();
const CITIES: CityId[] = ["LIS", "MEX", "YUL"];
// docs/12: every plan now says where its prices come from ("estimated" here: no live inventory); the label is left out
// of the digest so the hashes still prove the prices, schedules and views are byte-for-byte unchanged
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v, (k, x) => (k === "priceSource" ? undefined : x))).digest("hex").slice(0, 16);

const withBrief = (m: PricingMember, b: Partial<PricingMember["brief"]>): PricingMember => ({ ...m, brief: { ...m.brief, ...b } });
const SCENARIOS: Record<string, PricingMember[]> = {
  expo: EXPO_CREW,
  pair: EXPO_CREW.slice(0, 2),
  solo: EXPO_CREW.slice(2),
  w2: EXPO_CREW.map((m) => withBrief(m, { dateWindowIds: ["W2"] })),
  noCommonWindow: [withBrief(EXPO_CREW[0], { dateWindowIds: ["W1"] }), withBrief(EXPO_CREW[1], { dateWindowIds: ["W2"] })],
  picky: EXPO_CREW.map((m, i) => withBrief(m, {
    dealbreakers: [["red_eye", "long_walks"], ["early_start", "hostel"], ["layovers_2plus", "red_eye", "long_walks"]][i] as PricingMember["brief"]["dealbreakers"],
    mustHaves: [["music", "history"], ["nature", "beach", "food"], ["museums"]][i] as PricingMember["brief"]["mustHaves"],
    capCents: [60_000, 200_000, 95_000][i],
  })),
  four: [...EXPO_CREW, { memberId: "zed", name: "Zed", role: "member", origin: "ORD",
    brief: { capCents: 120_000, dateWindowIds: ["W1", "W2"], mustHaves: ["nightlife", "music"], dealbreakers: [] } }],
};

describe("chart book snapshot (b-)", () => {
  for (const [name, crew] of Object.entries(SCENARIOS)) {
    it(`${name}: plans, public and private views are unchanged`, () => {
      const book = buildChartBook(ds, crew, CITIES, 50);
      const views = book.map((p) => ({ pub: toPublic(ds, p, "A"), mine: crew.map((m) => toPrivate(p, m.memberId)) }));
      expect({ plans: book.length, book: digest(book), views: digest(views) }).toMatchSnapshot();
    });
  }

  it("four: a crew that fits in one room prices exactly as before multi-room stays (the one-room plans are unchanged)", () => {
    // before MAX_CREW 12 a crew of four only saw stays that sleep four; those plans must be byte-for-byte the same
    const crew = SCENARIOS.four;
    const book = buildChartBook(ds, crew, CITIES, 50).filter((p) => indexOf(ds).hotel.get(p.hotelId)!.sleeps >= crew.length);
    const views = book.map((p) => ({ pub: toPublic(ds, p, "A"), mine: crew.map((m) => toPrivate(p, m.memberId)) }));
    // (views moved once since: the public layout no longer stacks a pick on a group moment — e.g. Belém at 09:30 on
    // top of the Cascais beach day — it moves to the next day; the travel between moments is counted. Plans unchanged.
    // Moved again: picks spread over the stay's days, and share lines read in plain words. Prices unchanged.)
    expect({ plans: book.length, book: digest(book), views: digest(views) }).toEqual({ plans: 6, book: "e3ea217e1cb5c276", views: "38388aa008a69587" });
  });
});
