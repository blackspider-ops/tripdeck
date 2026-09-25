/**
 * WP-11 — local file stores & test isolation: atomic JSON store (TR5-009/OPT-024), memory recall cache (OPT-039),
 * Mongo-backed memory (TR5-008), read-only disk degrade (TR5-019), and tests never touching apps/server/data (TR5-017).
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

// A fake Mongo (off by default); flip `mongo.on` per test.
const mongo = vi.hoisted(() => ({ on: false, docs: {} as Record<string, Map<string, unknown>>, failLoads: 0 }));
vi.mock("../src/store/db.js", () => ({
  dbConnected: () => mongo.on,
  loadAll: async (col: string) => {
    if (mongo.failLoads > 0) { mongo.failLoads--; throw new Error("find: connection reset"); } // R2-WP-06: a network blip
    return JSON.parse(JSON.stringify([...(mongo.docs[col]?.values() ?? [])]));
  },
  persist: (col: string, doc: { _id: string }) => { (mongo.docs[col] ??= new Map()).set(doc._id, JSON.parse(JSON.stringify(doc))); },
  append: () => undefined,
}));

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { JsonStore } from "../src/util/jsonStore.js";
import { __memoryTest, memoryHealth, recall, remember, useMongoMemory } from "../src/memory/memory.js";
import { audioFile, pruneAudioCache, restoreTurnAudio } from "../src/voice/voice.js";
import { statSync, utimesSync } from "node:fs";

const scratch = () => mkdtempSync(join(process.env.DATA_DIR ? resolve(process.env.DATA_DIR, "..") : tmpdir(), "s-"));
const realData = fileURLToPath(new URL("../data/", import.meta.url));

describe("TR5-017 / TR4-008: tests are isolated from the real data dir", () => {
  it("DATA_DIR and CACHE_DIR point at a temp dir, never apps/server/data or .cache", () => {
    expect(resolve(config.dataDir)).not.toBe(resolve(realData));
    expect(resolve(config.dataDir).startsWith(resolve(tmpdir())) || resolve(config.dataDir).startsWith("/private" + resolve(tmpdir()))).toBe(true);
    expect(config.cacheDir).not.toMatch(/apps\/server\/\.cache/);
  });
});

describe("TR5-009 / OPT-024: JsonStore", () => {
  it("serializes concurrent read-modify-writes: no lost updates, valid JSON, no temp files left", async () => {
    const dir = scratch();
    const file = join(dir, "s.json");
    const store = new JsonStore<Record<string, number>>(file, () => ({}));
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.update((d) => { d[`k${i}`] = i; d.n = (d.n ?? 0) + 1; })));
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.n).toBe(50);
    expect(Object.keys(onDisk)).toHaveLength(51);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(store.loads).toBe(1);
  });

  it("a truncated file is kept aside as .corrupt-*, not treated as empty and overwritten", async () => {
    const dir = scratch();
    const file = join(dir, "memory.json");
    writeFileSync(file, '{"crew:abc|maya": ["voyage: Lis');
    const store = new JsonStore<Record<string, string[]>>(file, () => ({}));
    await store.update((d) => { d.x = ["new"]; });
    const aside = readdirSync(dir).find((f) => f.startsWith("memory.json.corrupt-"));
    expect(aside).toBeTruthy();
    expect(readFileSync(join(dir, aside!), "utf8")).toContain("voyage: Lis");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ x: ["new"] });
  });

  it.skipIf(process.getuid?.() === 0)("TR5-019: a read-only dir degrades to memory with one warning, never throws", async () => {
    const dir = scratch();
    chmodSync(dir, 0o555);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const store = new JsonStore<Record<string, number>>(join(dir, "sub", "s.json"), () => ({}));
      await store.update((d) => { d.a = 1; });
      await store.update((d) => { d.b = 2; });
      expect(await store.read()).toEqual({ a: 1, b: 2 });
      expect(store.degraded).toMatch(/EACCES|EROFS|EPERM/);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("not writable"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      chmodSync(dir, 0o755);
    }
  });
});

describe("OPT-039 / TR5-008 / TR5-009 / TR5-019: memory storage", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { __memoryTest.reset(); mongo.on = false; mongo.docs = {}; mongo.failLoads = 0; config.backboard.apiKey = ""; });
  afterEach(() => { globalThis.fetch = realFetch; config.backboard.apiKey = ""; vi.restoreAllMocks(); });

  it("local recall loads the store once, however many members join and rejoin", async () => {
    await remember("crew:aa|maya", "voyage: Nashville · booked · mid budget · conceded the city choice");
    __memoryTest.reset(); // fresh process: memory.json is on disk
    const keys = ["crew:aa|maya", "crew:bb|rae", "crew:cc|dev"];
    for (let rejoin = 0; rejoin < 10; rejoin++) await Promise.all(keys.map((k) => recall(k)));
    expect(__memoryTest.loads()).toBe(1);
    expect(await recall("crew:aa|maya")).toEqual(["voyage: Nashville · booked · mid budget · conceded the city choice"]);
    expect(JSON.parse(readFileSync(join(config.dataDir, "memory.json"), "utf8"))["crew:aa|maya"]).toHaveLength(1);
  });

  it("Backboard: one GET per member across rejoins, one assistant per key under concurrent recalls, no lost map keys", async () => {
    config.backboard.apiKey = "test";
    const calls: string[] = [];
    let n = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "");
      calls.push(`${init?.method} ${path}`);
      await new Promise((r) => setTimeout(r, 5)); // let concurrent callers overlap
      const body = init?.method === "POST" && path === "/assistants" ? { assistant_id: `as${++n}` } : path.includes("/memories") && init?.method === "GET" ? { memories: [{ content: "voyage: earlier", created_at: "1" }] } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await Promise.all([recall("crew:k1|a"), recall("crew:k1|a"), recall("crew:k2|b"), recall("crew:k2|b")]);
    for (let i = 0; i < 5; i++) await Promise.all([recall("crew:k1|a"), recall("crew:k2|b")]);
    expect(calls.filter((c) => c === "POST /assistants")).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(2);
    const map = JSON.parse(readFileSync(join(config.dataDir, "backboard-assistants.json"), "utf8"));
    expect(Object.keys(map).sort()).toEqual(["crew:k1|a", "crew:k2|b"]);

    // remember keeps the cached thread fresh without another GET
    await remember("crew:k1|a", "voyage: Lisbon · booked");
    expect(await recall("crew:k1|a")).toEqual(["voyage: earlier", "voyage: Lisbon · booked"]);
    expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(2);
  });

  it("with MongoDB connected, memory and the assistant map live in Mongo (survive a fresh container), not on disk", async () => {
    mongo.on = true;
    config.backboard.apiKey = "test";
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "");
      const body = path === "/assistants" ? { assistant_id: "as-mongo" } : {};
      if (init?.method === "GET") return new Response("down", { status: 503 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await remember("crew:mm|maya", "voyage: Nashville · conceded the city choice");
    const disk = (f: string) => { const p = join(config.dataDir, f); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
    expect(disk("memory.json")).not.toContain("crew:mm|maya");
    expect(disk("backboard-assistants.json")).not.toContain("crew:mm|maya");
    expect(mongo.docs.memories.get("crew:mm|maya")).toEqual({ _id: "crew:mm|maya", v: ["voyage: Nashville · conceded the city choice"] });
    expect(mongo.docs.backboard_assistants.get("crew:mm|maya")).toEqual({ _id: "crew:mm|maya", v: "as-mongo" });

    __memoryTest.reset(); // redeploy: fresh process, same Mongo; Backboard GET down → local (Mongo) copy
    config.backboard.apiKey = "test";
    mongo.on = true;
    expect(await recall("crew:mm|maya")).toEqual(["voyage: Nashville · conceded the city choice"]);
    expect(memoryHealth().local).toBe("mongo");
  });

  it.skipIf(process.getuid?.() === 0)("TR5-019: remember with an unwritable DATA_DIR still posts to Backboard and recalls from memory", async () => {
    const ro = config.dataDir;
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o555);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    config.backboard.apiKey = "test";
    const posts: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "");
      if (init?.method === "POST") posts.push(path);
      const body = path === "/assistants" ? { assistant_id: "as-ro" } : { memories: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      await remember("crew:ro|dev", "voyage: Lisbon · booked");
      expect(posts).toEqual(["/assistants", "/assistants/as-ro/memories"]);
      config.backboard.apiKey = "";
      expect(await recall("crew:ro|dev")).toEqual(["voyage: Lisbon · booked"]);
      expect(memoryHealth().degraded).toMatch(/EACCES|EROFS|EPERM/);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("not writable")).length).toBeGreaterThanOrEqual(1);
    } finally {
      chmodSync(ro, 0o755);
    }
  });
});

describe("L5-005: a failed first load of the Mongo memory stores isn't cached as empty", () => {
  beforeEach(() => { __memoryTest.reset(); mongo.on = true; mongo.docs = {}; mongo.failLoads = 0; config.backboard.apiKey = ""; });
  afterEach(() => { vi.restoreAllMocks(); mongo.on = false; });
  const three = ["voyage: A · booked", "voyage: B · booked", "voyage: C · booked"];

  it("after the blip, recall returns the stored lines and remember appends (4 lines), never replaces", async () => {
    mongo.docs.memories = new Map([["crew:k|maya", { _id: "crew:k|maya", v: three }]]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mongo.failLoads = 1;
    expect(await recall("crew:k|maya")).toEqual([]); // the blip: nothing to show this once
    expect(await recall("crew:k|maya")).toEqual(three); // loaded again, not cached as empty
    await remember("crew:k|maya", "voyage: D · booked");
    expect(mongo.docs.memories.get("crew:k|maya")).toEqual({ _id: "crew:k|maya", v: [...three, "voyage: D · booked"] });
  });

  it("a remember during the blip writes nothing over the stored thread", async () => {
    mongo.docs.memories = new Map([["crew:k|maya", { _id: "crew:k|maya", v: three }]]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mongo.failLoads = 1;
    await remember("crew:k|maya", "voyage: D · booked");
    expect(mongo.docs.memories.get("crew:k|maya")).toEqual({ _id: "crew:k|maya", v: three });
  });

  it("an assistant map that didn't load never makes a second Backboard assistant", async () => {
    config.backboard.apiKey = "test";
    mongo.docs.backboard_assistants = new Map([["crew:k|maya", { _id: "crew:k|maya", v: "as-1" }]]);
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).replace(/^.*\/api/, "")}`);
      return new Response(JSON.stringify(init?.method === "POST" ? { assistant_id: "as-2" } : { memories: [] }), { status: 200 });
    }) as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mongo.failLoads = 2; // both memory collections' first loads fail
    await recall("crew:k|maya");
    expect(calls.filter((c) => c === "POST /assistants")).toHaveLength(0);
    expect(mongo.docs.backboard_assistants.get("crew:k|maya")).toEqual({ _id: "crew:k|maya", v: "as-1" });
  });
});

describe("L5-003: memory moves into MongoDB once it connects after a failed boot connect", () => {
  beforeEach(() => { __memoryTest.reset(); mongo.on = false; mongo.docs = {}; mongo.failLoads = 0; config.backboard.apiKey = ""; });
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); config.backboard.apiKey = ""; mongo.on = false; });

  it("a line written offline is recalled after a restart with MongoDB up; no second assistant for that person", async () => {
    config.backboard.apiKey = "test";
    let assistants = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "");
      if (init?.method === "POST" && path === "/assistants") return new Response(JSON.stringify({ assistant_id: `as-${++assistants}` }), { status: 200 });
      return new Response(JSON.stringify({ memories: [] }), { status: 200 });
    }) as typeof fetch;
    const key = `crew:${Date.now().toString(36)}|dev`;
    mongo.docs.memories = new Map([[key, { _id: key, v: ["voyage: earlier · booked"] }]]);
    await remember(key, "voyage: offline · booked"); // MongoDB down: the local files are used
    expect(memoryHealth().local).toBe("file");
    expect(assistants).toBe(1);

    mongo.on = true; // reconnected: the helm's sync moves memory into MongoDB
    await useMongoMemory();
    expect(memoryHealth().local).toBe("mongo");
    expect(mongo.docs.memories.get(key)).toEqual({ _id: key, v: ["voyage: earlier · booked", "voyage: offline · booked"] });
    expect(mongo.docs.backboard_assistants.get(key)).toEqual({ _id: key, v: "as-1" });

    __memoryTest.reset(); // next boot, MongoDB up
    config.backboard.apiKey = "";
    expect(await recall(key)).toEqual(["voyage: earlier · booked", "voyage: offline · booked"]);
    config.backboard.apiKey = "test";
    await recall(key);
    expect(assistants).toBe(1); // the same assistant, not a new one
  });
});

describe("L5-012: the audio pruner keeps an mp3 a restored turn points at", () => {
  it("restoreTurnAudio marks the file used, so an old file survives the next prune", async () => {
    const dir = join(config.cacheDir, "tts");
    mkdirSync(dir, { recursive: true });
    const key = "a".repeat(40);
    const file = join(dir, `${key}.mp3`);
    writeFileSync(file, Buffer.from([0]));
    const old = new Date(Date.now() - 40 * 86_400_000); // older than the 30-day cut
    utimesSync(file, old, old);
    expect(await restoreTurnAudio("turn-1", key)).toBe(true);
    expect(statSync(file).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    await pruneAudioCache({ maxAgeMs: 30 * 86_400_000 });
    expect(existsSync(file)).toBe(true);
    expect(audioFile("turn-1")).toBe(file);
  });
});
