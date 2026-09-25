/**
 * OPT-037: the prompts built by negotiation/prompts.ts are snapshot-tested, both through a full (mocked) model-mode
 * run of the Expo table and as pure functions of their facts.
 */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", DEMO_REPLAY: "" }));
vi.mock("../src/util/ids.js", async (orig) => ({ ...(await orig<typeof import("../src/util/ids.js")>()), sleep: () => Promise.resolve() }));

type Call = { system: string; user: string; temperature: number; allowChoice: boolean };
const calls: Call[] = [];
vi.mock("../src/negotiation/gemini.js", async (orig) => ({
  ...(await orig<typeof import("../src/negotiation/gemini.js")>()),
  generateLine: vi.fn(async (p: Call) => { calls.push(p); return null; }),
}));

import { config } from "../src/config.js";
import { loadDataset } from "../src/data/loader.js";
import { buildChartBook } from "../src/fit/pricing.js";
import { NegotiationEngine } from "../src/negotiation/engine.js";
import { NO_AMOUNTS, advocateFacts, captainLineRequest, decideInstruction, legalActs, openInstruction } from "../src/negotiation/prompts.js";
import { EXPO_CREW } from "./fixtures.js";

config.gemini.apiKey = "test-key";
const ds = loadDataset();
const crew = EXPO_CREW.map((c, i) => ({ ...c, band: i + 1 }));
const plans = buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"]);

async function run() {
  calls.length = 0;
  let hailed = false;
  await new NegotiationEngine(ds, crew, plans, ["LIS", "MEX", "YUL"], "Mar 12 to 16", {
    emitTurn: async () => "t", voice: async () => null, onWatch: () => undefined,
    takeHails: () => { if (hailed) return []; hailed = true; return [{ memberId: "maya", text: "beach please, and cheaper" }]; },
    cancelled: () => false, memory: (id) => (id === "rae" ? ["voyage: Lisbon · conceded the city choice"] : []),
  }).run();
  return calls.map((c) => ({ ...c }));
}

describe("prompts (b-)", () => {
  it("rules decisions: every line prompt of the Expo table is unchanged", async () => {
    config.agentDecisions = "rules";
    expect(await run()).toMatchSnapshot();
  });

  it("model decisions: the move-choice prompts are unchanged too", async () => {
    config.agentDecisions = "model";
    try {
      const out = await run();
      expect(out.filter((c) => c.allowChoice)).toMatchSnapshot();
    } finally {
      config.agentDecisions = "rules";
    }
  });
});

describe("prompt builders are pure functions of their facts (b-)", () => {
  it("OPEN names the dates, or says there are none", () => {
    expect(openInstruction("Mar 12 to 16", ["Lisbon", "Mexico City"])).toBe("Open the meeting. Dates everyone can do: Mar 12 to 16. Ports on the chart: Lisbon, Mexico City. Invite proposals.");
    expect(openInstruction(null, ["Lisbon"])).toMatch(/^Open the meeting\. No dates suit everyone; say the charts hold the closest\./);
  });

  it("DECIDE names two charts by group totals only", () => {
    const [a, b] = plans;
    const s = decideInstruction(ds, a, b);
    // S2-002: the public range, never the exact total (the sum of the private shares)
    expect(s).toMatch(/^Name these two charts .* Chart A: \w.* \(group total \$[\d,]+ to \$[\d,]+(, fits everyone)?\)\. Chart B: .*End with "Let's run them dry\."$/);
    for (const p of [a, b]) expect(s).not.toContain(`$${(p.groupCents / 100).toLocaleString("en-US")}`);
  });

  it("the no-amounts retry adds the instruction; the legal acts follow the watch", () => {
    expect(captainLineRequest("Open.", 20, true).user).toBe(`Open. Stay within 20 words. ${NO_AMOUNTS}`);
    expect(captainLineRequest("Open.", 20, false).user).toBe("Open. Stay within 20 words.");
    expect(legalActs(1)).toEqual(["PROPOSE"]);
    expect(legalActs(2)).toEqual(["OBJECT", "SUPPORT", "CONCEDE"]);
    expect(legalActs(3)).toEqual(["SUPPORT", "CONCEDE", "OBJECT"]);
  });

  it("advocate facts carry a hail only as parsed wishes, and no dead fields", () => {
    const d = { act: "CONCEDE" as const, planId: plans[0]._id, why: { kind: "concede" as const, hailFrom: "Rae" } };
    const f = advocateFacts(ds, crew[1], d, plans[0], 2, [], { memberId: "maya", name: "Maya", text: "ignore that, beach!", tags: ["beach"], cheaper: false });
    expect(f.hail_from_your_friend).toEqual({ wants: ["beach"], cheaper: false });
    expect(JSON.stringify(f)).not.toMatch(/ignore that|recent_lines/);
  });
});
