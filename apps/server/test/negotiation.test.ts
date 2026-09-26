import { describe, expect, it, vi } from "vitest";
vi.mock("../src/util/ids.js", async (orig) => ({ ...(await orig<typeof import("../src/util/ids.js")>()), sleep: () => Promise.resolve() }));

import type { Plan } from "@all-ayes/shared";
import { isGeneratedPort, loadDataset } from "../src/data/loader.js";
import { randomVoyagePlan } from "../src/demo/seed.js";
import { LINE_VARIANTS, concedeLine, objectUnfitLine, supportHoldLine, supportSwitchLine, variantFor } from "../src/negotiation/phrasing.js";
import { buildChartBook } from "../src/fit/pricing.js";
import { NegotiationEngine, type EmittedTurn } from "../src/negotiation/engine.js";
import { buildPrivacyContext } from "../src/privacy/context.js";
import { advocateFacts } from "../src/negotiation/prompts.js";
import { filterLine } from "../src/privacy/filter.js";
import { EXPO_CREW } from "./fixtures.js";

const ds = loadDataset();
const crew = EXPO_CREW.map((c, i) => ({ ...c, band: i + 1 }));
const plans = buildChartBook(ds, EXPO_CREW, ["LIS", "MEX", "YUL"]);

async function runMeeting(hails: { afterTurn: number; memberId: string; text: string }[] = []) {
  const turns: (EmittedTurn & { watch: number })[] = [];
  let pending: { memberId: string; text: string }[] = [];
  const engine = new NegotiationEngine(ds, crew, plans, ["LIS", "MEX", "YUL"], "Mar 12 to 16", {
    emitTurn: async (t, watch) => {
      turns.push({ ...t, watch });
      for (const h of hails.filter((x) => x.afterTurn === turns.length)) pending.push(h);
      return `t${turns.length}`;
    },
    voice: async () => null,
    onWatch: () => undefined,
    takeHails: () => { const p = pending; pending = []; return p; },
    cancelled: () => false,
    memory: (id) => (id === "maya" ? ["Conceded the city choice last voyage"] : []),
  });
  const result = await engine.run();
  return { turns, result };
}

/** O2-063: the scripted Expo meeting (Rae hails after turn 4) runs once and is shared by the tests that read it. */
let expo: ReturnType<typeof runMeeting> | undefined;
const expoMeeting = () => (expo ??= runMeeting([{ afterTurn: 4, memberId: "rae", text: "I'd pay more for the beach." }]));

describe("negotiation — Expo run (doc 05 §12)", () => {
  it("follows the scripted shape and ends after Watch 2", async () => {
    const { turns, result } = await expoMeeting();
    const shape = turns.map((t) => `${t.speaker.kind === "captain" ? "captain" : (t.speaker as { memberId: string }).memberId}:${t.act}:${t.cityId ?? ""}`);
    expect(shape).toEqual([
      "captain:OPEN:",
      "maya:PROPOSE:LIS", "dev:PROPOSE:MEX", "rae:PROPOSE:MEX",
      "maya:OBJECT:MEX", "dev:SUPPORT:LIS", "rae:CONCEDE:LIS",
      "captain:DECIDE:MEX",
    ]);
    // consensus after Watch 2: the Captain decides straight after the Watch-2 turns (no Watch 3 in the shape above)
    expect(result.shortlist.map((p) => p._id)).toEqual(["MEX-W1-roma-flat", "LIS-W1-casa-alfama"]);
    expect(turns[6].text).toMatch(/^Heard you, Rae\./); // the meeting's first concede: the classic wording
    expect(turns[1].text).toMatch(/gave up the city pick/);
  });

  it("without a hail, Rae's mate still concedes to Lisbon (objection rule)", async () => {
    const { turns } = await runMeeting();
    expect(turns[6].act).toBe("CONCEDE");
    expect(turns[6].text).not.toMatch(/Rae/);
  });

  it("every line is within 20 words, ribbons within 8, and nothing leaks", async () => {
    const { turns } = await expoMeeting();
    const ctx = buildPrivacyContext(ds, EXPO_CREW, plans);
    for (const t of turns) {
      expect(t.text.split(/\s+/).length, t.text).toBeLessThanOrEqual(20);
      expect(t.ribbon.split(/\s+/).length, t.ribbon).toBeLessThanOrEqual(8);
      expect(filterLine(t.text, ctx).leak, t.text).toBe(false);
    }
  });
});

describe("negotiation — privacy & quality (WP-12)", () => {
  const io = (turns: EmittedTurn[], extra: Partial<import("../src/negotiation/engine.js").EngineIO> = {}) => ({
    emitTurn: async (t: EmittedTurn) => { turns.push(t); return `t${turns.length}`; },
    voice: async () => null, onWatch: () => undefined, takeHails: () => [], cancelled: () => false, memory: () => [],
    ...extra,
  });

  it("TR4-005: with no common window the Captain doesn't claim one", async () => {
    const turns: EmittedTurn[] = [];
    await new NegotiationEngine(ds, crew, plans, ["LIS", "MEX", "YUL"], null, io(turns)).run();
    expect(turns[0].text).toMatch(/^No dates suit everyone/);
    expect(turns[0].text).not.toMatch(/works for everyone/);
    expect(turns[0].text.split(/\s+/).length).toBeLessThanOrEqual(20);
  });

  it("TR4-010: a template that trips the filter falls back to a safe line for that act, not an affordability hint", async () => {
    const turns: EmittedTurn[] = [];
    // a dates label carrying a secret-looking number makes the OPEN template leak
    await new NegotiationEngine(ds, crew, plans, ["LIS", "MEX", "YUL"], "Mar 900 to 16", io(turns)).run();
    expect(turns[0].act).toBe("OPEN");
    expect(turns[0].text).toBe("The ports are on the chart. Let's hear it.");
    expect(turns[0].redactions).toBe(1);
    expect(turns.map((t) => t.text).join(" ")).not.toMatch(/past what my friend can do/);
  });

  it("OPT-013: the engine uses the privacy context it is given", () => {
    const ctx = buildPrivacyContext(ds, EXPO_CREW, plans);
    const e = new NegotiationEngine(ds, crew, plans, ["LIS"], "Mar 12 to 16", io([]), ctx);
    expect(e.privacy).toBe(ctx);
  });

  it("TR4-011: hails close before the Captain decides", async () => {
    const turns: EmittedTurn[] = [];
    let closedAt = -1;
    await new NegotiationEngine(ds, crew, plans, ["LIS", "MEX", "YUL"], "Mar 12 to 16", io(turns, { closeHails: () => { closedAt = turns.length; } })).run();
    expect(closedAt).toBe(turns.length - 1);
    expect(turns.at(-1)!.act).toBe("DECIDE");
  });

  it("TR4-006: the note reaches only its own member's Advocate, without amounts", () => {
    const withNotes = crew.map((c) => (c.memberId === "maya" ? { ...c, brief: { ...c.brief, note: "I get tired walking hills. I can do $900, nine hundred tops." } } : c));
    const d = { act: "PROPOSE" as const, planId: plans[0]._id, why: { kind: "propose" as const, seconding: false } };
    const facts = (id: string) => advocateFacts(ds, withNotes.find((c) => c.memberId === id)!, d, plans[0], 1, []);
    const maya = facts("maya");
    expect(maya.wishes.private_note).toMatch(/tired walking hills/);
    expect(JSON.stringify(maya)).not.toMatch(/900|nine hundred/i);
    for (const id of ["rae", "dev"]) {
      const other = JSON.stringify(facts(id));
      expect(other).not.toMatch(/hills/);
    }
  });
});

// ---------- no line said twice (the live demo heard "Still with Milwaukee…" three times) ----------
describe("negotiation — varied lines, never the same one twice", () => {
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  it("SUPPORT / CONCEDE come in distinct wordings; the start rotates by speaker and watch, deterministically", () => {
    const p = plans[0];
    const holds = Array.from({ length: LINE_VARIANTS }, (_, v) => supportHoldLine(ds, p, v).line);
    const switches = Array.from({ length: LINE_VARIANTS }, (_, v) => supportSwitchLine(ds, p, "dev", v).line);
    const concedes = Array.from({ length: LINE_VARIANTS }, (_, v) => concedeLine(ds, p, "rae", undefined, v).line);
    const hailed = Array.from({ length: LINE_VARIANTS }, (_, v) => concedeLine(ds, p, "rae", "Rae", v).line);
    for (const set of [holds, switches, concedes, hailed]) {
      expect(new Set(set.map(key)).size).toBe(LINE_VARIANTS);
      for (const l of set) expect(l.split(/\s+/).length, l).toBeLessThanOrEqual(20);
    }
    expect(variantFor("maya", 2)).toBe(variantFor("maya", 2));
    expect(variantFor("maya", 3)).not.toBe(variantFor("maya", 2));
    expect(new Set(["a", "b", "c", "d", "e", "f"].map((id) => variantFor(id, 1))).size).toBeGreaterThan(1);
  });

  it("20 random voyages: every meeting's lines are all different, and repeated holds were varied", async () => {
    const ports = ds.cities.map((c) => c._id).filter((id) => !isGeneratedPort(id));
    let repeatedActs = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const v = randomVoyagePlan(seed, ports, ds.dateWindows.map((w) => w.id));
      const members = v.crew.map((c, i) => ({ memberId: `m${i}`, name: c.name, role: c.role, origin: c.origin, brief: c.brief, band: i + 1 }));
      const book = buildChartBook(ds, members, v.ports);
      const turns: EmittedTurn[] = [];
      await new NegotiationEngine(ds, members, book, v.ports, "Mar 10 to 15", {
        emitTurn: async (t) => { turns.push(t); return `t${turns.length}`; },
        voice: async () => null, onWatch: () => undefined, takeHails: () => [], cancelled: () => false, memory: () => [],
      }).run();
      const keys = turns.map((t) => key(t.text));
      expect(new Set(keys).size, `seed ${seed}: ${turns.map((t) => t.text).join(" | ")}`).toBe(turns.length);
      // the same act for the same port more than once in a meeting: before, these were word-for-word the same
      const seen = new Set<string>();
      for (const t of turns.filter((x) => x.act === "SUPPORT" || x.act === "CONCEDE")) {
        const k = `${t.act}|${t.cityId}`;
        if (seen.has(k)) repeatedActs++;
        seen.add(k);
      }
      for (const t of turns) expect(t.text.split(/\s+/).length, t.text).toBeLessThanOrEqual(20);
    }
    expect(repeatedActs).toBeGreaterThan(0);
  }, 60_000);
});

describe("OBJECT on a rival that breaks a member's terms", () => {
  const ds = loadDataset();
  const rival = { cityId: ds.cities.find((c) => c._id === "CTG")?._id ?? ds.cities[0]._id } as Plan;
  const r = ds.cities.find((c) => c._id === rival.cityId)!.name;
  const reasons = ["dealbreaker:red_eye", "dealbreaker:early_start", "dealbreaker:long_walks", "dealbreaker:layovers_2plus", "dealbreaker:hostel", "date_mismatch", "no_flight", "ok"] as const;

  it("says each reason once, in one clean sentence (no 'something my friend won't do, and my friend won't do that')", () => {
    expect(objectUnfitLine(ds, rival, "dealbreaker:early_start").line).toBe(`${r} means an early start — my friend won't do that.`);
    expect(objectUnfitLine(ds, rival, "dealbreaker:early_start").ribbon).toBe(`${r} — no early starts`);
    expect(objectUnfitLine(ds, rival, "date_mismatch").line).toBe(`${r} is on dates my friend can't make.`);
    for (const why of reasons) {
      const { line, ribbon } = objectUnfitLine(ds, rival, why);
      expect(line.match(/won't do/g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(line).not.toMatch(/something my friend|means starts|, and my friend/);
      expect(ribbon).not.toMatch(/no an? /);
      expect(line.startsWith(r)).toBe(true);
    }
  });
});
