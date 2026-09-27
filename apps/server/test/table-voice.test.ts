import { describe, expect, it, vi } from "vitest";
vi.mock("../src/util/ids.js", async (orig) => ({ ...(await orig<typeof import("../src/util/ids.js")>()), sleep: () => Promise.resolve() }));

import { isGeneratedPort, loadDataset } from "../src/data/loader.js";
import { randomVoyagePlan } from "../src/demo/seed.js";
import { buildChartBook } from "../src/fit/pricing.js";
import { NegotiationEngine, type EmittedTurn } from "../src/negotiation/engine.js";
import { buildPrivacyContext } from "../src/privacy/context.js";
import { filterLine } from "../src/privacy/filter.js";
import { CAPTAIN_OPENERS, OPENERS, POOLS, TAGS, hash, humanize, rng } from "../src/negotiation/lines.js";

const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const SLOTS = {
  city: "Lisbon", has: "the food tour", Has: "The food tour", are: "is", rival: "Porto", mine: "Lisbon", thing: "beach",
  means: "an early start", keep: " — as long as we keep the food tour", name: "Rae", dates: "Mar 12 to 16", who: "everyone",
  n: "Three", ports: "Lisbon, Porto and Madrid", when: "Mar 12 to 16 works for everyone. ", where: "We're looking at Europe.", isAre: "are",
  cheaper: "Porto", richer: "Lisbon", a: "Lisbon", b: "Porto",
} as never;

describe("table voice — lots of wordings, spoken like friends", () => {
  it("every template category has at least 25 distinct wordings, each within the Expo cap and free of numbers", () => {
    for (const [name, pool] of Object.entries(POOLS)) {
      // a scoped OPEN also says the dates (as the classic line always has, the engine clamps it at a sentence)
      const slots = name === "open_scope" ? ({ ...(SLOTS as object), when: "" } as never) : SLOTS;
      const lines = (pool as readonly ((s: never) => string)[]).map((f) => f(slots));
      expect(new Set(lines.map(key)).size, name).toBeGreaterThanOrEqual(25);
      for (const l of lines) {
        expect(l.split(/\s+/).length, `${name}: ${l}`).toBeLessThanOrEqual(20);
        expect(l.replace(/Mar 12 to 16/g, ""), `${name}: ${l}`).not.toMatch(/\d|\$/);
      }
    }
  });

  it("has a big filler pool and adds at most one filler, at a modest rate, never the same twice in a row", () => {
    expect(OPENERS.length + TAGS.length).toBeGreaterThanOrEqual(40);
    let added = 0, last: string | null = null;
    const base = "Lisbon. The food tour is right there for my friend.";
    for (let i = 0; i < 1000; i++) {
      const h = humanize(base, rng(hash(`t${i}`)), { maxWords: 20, avoid: last });
      if (!h.filler) continue;
      added++;
      expect(h.filler).not.toBe(last);
      last = h.filler;
      const fillers = [...OPENERS, ...TAGS].filter((f) => h.line.includes(f.trim()));
      expect(fillers.length, h.line).toBeGreaterThanOrEqual(1);
      expect(h.line).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(h.line.split(/\s+/).length).toBeLessThanOrEqual(20);
    }
    expect(added / 1000).toBeGreaterThan(0.3);
    expect(added / 1000).toBeLessThan(0.5);
    // the Captain only gets calm openers
    for (let i = 0; i < 200; i++) {
      const h = humanize("Two charts, then. Let's run them dry.", rng(i + 1), { maxWords: 20, captain: true });
      if (h.filler) expect(CAPTAIN_OPENERS as readonly string[]).toContain(h.filler);
    }
    // never pushes a line over the cap
    const long = Array.from({ length: 20 }, () => "word").join(" ");
    for (let i = 0; i < 100; i++) expect(humanize(long, rng(i), { maxWords: 20 }).line).toBe(long);
  });

  it("40 random tables: no line repeats, no line over 20 words, no budget leaks, and they don't all sound the same", async () => {
    const ports = ds.cities.map((c) => c._id).filter((id) => !isGeneratedPort(id));
    const opens = new Set<string>();
    let humanized = 0, total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const v = randomVoyagePlan(seed, ports, ds.dateWindows.map((w) => w.id));
      const members = v.crew.map((c, i) => ({ memberId: `m${i}`, name: c.name, role: c.role, origin: c.origin, brief: c.brief, band: i + 1 }));
      const book = buildChartBook(ds, members, v.ports);
      const ctx = buildPrivacyContext(ds, members, book);
      const turns: EmittedTurn[] = [];
      await new NegotiationEngine(ds, members, book, v.ports, "Mar 10 to 15", {
        emitTurn: async (t) => { turns.push(t); return `t${turns.length}`; },
        voice: async () => null, onWatch: () => undefined, takeHails: () => [], cancelled: () => false, memory: () => [],
      }, ctx).run();
      expect(new Set(turns.map((t) => key(t.text))).size, turns.map((t) => t.text).join(" | ")).toBe(turns.length);
      for (const t of turns) {
        total++;
        expect(t.text.split(/\s+/).length, t.text).toBeLessThanOrEqual(20);
        expect(filterLine(t.text, ctx).leak, t.text).toBe(false);
        if (OPENERS.some((f) => t.text.startsWith(f)) || TAGS.some((f) => t.text.endsWith(f))) humanized++;
      }
      opens.add(key(turns[0].text).replace(/[a-z]+ \d+ to \d+/, ""));
    }
    expect(opens.size).toBeGreaterThan(10);
    expect(humanized / total).toBeGreaterThan(0.15);
  }, 90_000);
});

const ds = loadDataset();
