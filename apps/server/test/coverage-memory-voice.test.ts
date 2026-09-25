/**
 * O2-065 (R2-WP-17): memory and voice failure paths, with fetch stubbed (never the network; the setup blanks every
 * key, and the fake keys set here only reach the stub).
 *   memory: Backboard failure / timeout → local copy, the 60 s back-off, a failed Mongo load, threads past 25 lines.
 *   voice:  TTS non-OK, TTS timeout, an unwritable cache dir, a cached-mode miss, and transcribe().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file's CACHE_DIR sits under a regular file, so the TTS cache dir can never be created (ENOTDIR, even as root).
await vi.hoisted(async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const root = dirname(process.env.DATA_DIR!);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "not-a-dir"), "");
  process.env.CACHE_DIR = join(root, "not-a-dir", "cache");
});

// A fake Mongo (off by default), as in storage.test.ts.
const mongo = vi.hoisted(() => ({ on: false, docs: {} as Record<string, Map<string, unknown>>, failLoads: 0 }));
vi.mock("../src/store/db.js", () => ({
  dbConnected: () => mongo.on,
  loadAll: async (col: string) => {
    if (mongo.failLoads > 0) { mongo.failLoads--; throw new Error("find: connection reset"); }
    return JSON.parse(JSON.stringify([...(mongo.docs[col]?.values() ?? [])]));
  },
  persist: (col: string, doc: { _id: string }) => { (mongo.docs[col] ??= new Map()).set(doc._id, JSON.parse(JSON.stringify(doc))); },
  append: () => undefined,
}));

import { config } from "../src/config.js";
import { __memoryTest, recall, remember, rememberAll } from "../src/memory/memory.js";
import { audioFile, synthesize, transcribe } from "../src/voice/voice.js";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const stubFetch = (fn: FetchFn) => {
  const f = vi.fn(fn);
  vi.stubGlobal("fetch", f);
  return f;
};
/** A fetch that only ends when its signal aborts (a hung provider). */
const hang: FetchFn = (_url, init) => new Promise((_, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
});
/** Resolves once the stub has been called (the abort timer is set just before the fetch, after some real file I/O). */
const calledOnce = (f: ReturnType<typeof stubFetch>) => vi.waitUntil(() => f.mock.calls.length > 0, { interval: 1 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  config.backboard.apiKey = "";
  config.eleven.apiKey = "";
  config.demoReplay = "live";
});

// ---------- memory ----------
/**
 * A Backboard stub: an assistant per person, memories stored per assistant; `down` makes every call a 503. GET pages
 * like the documented API (`page`, `page_size` ≤ 100, `total_count`, `total_pages`), listing in `state.order`.
 */
function backboard() {
  const state = { down: false, created: 0, gets: 0, order: "oldest" as "oldest" | "newest", memories: new Map<string, { id: string; content: string; created_at: string }[]>() };
  let clock = 0;
  const fetch = stubFetch(async (url, init) => {
    if (state.down) return new Response("unavailable", { status: 503 });
    const path = new URL(url).pathname.replace(/^\/api/, "");
    if (init?.method === "POST" && path === "/assistants") return json({ assistant_id: `as-${++state.created}` });
    const m = /^\/assistants\/([^/]+)\/memories$/.exec(path);
    if (m && init?.method === "POST") {
      const list = state.memories.get(m[1]) ?? [];
      list.push({ id: `m${clock + 1}`, content: JSON.parse(String(init.body)).content, created_at: new Date(1_800_000_000_000 + ++clock * 1000).toISOString() });
      state.memories.set(m[1], list);
      return json({ ok: true });
    }
    if (m && init?.method === "GET") {
      state.gets++;
      const q = new URL(url).searchParams;
      const all = [...(state.memories.get(m[1]) ?? [])];
      if (state.order === "newest") all.reverse();
      const size = Math.min(100, Number(q.get("page_size") ?? 25)), n = Number(q.get("page") ?? 1);
      return json({ memories: all.slice((n - 1) * size, n * size), total_count: all.length, page: n, page_size: size, total_pages: Math.ceil(all.length / size) });
    }
    return new Response("not found", { status: 404 });
  });
  return { state, fetch };
}

describe("O2-065: memory failure paths", () => {
  beforeEach(() => { __memoryTest.reset(); mongo.on = false; mongo.docs = {}; mongo.failLoads = 0; });

  it("a Backboard failure falls back to the local copy, and the next minute's recalls don't call Backboard", async () => {
    const warn = quietWarn();
    const bb = backboard();
    config.backboard.apiKey = "test-key";
    await remember("crew:k1|maya", "voyage: Lisbon — liked the beach");
    expect(bb.state.memories.get("as-1")).toHaveLength(1);

    __memoryTest.reset(); // a restart: the recall cache is empty, the local copy (disk) isn't
    vi.useFakeTimers({ toFake: ["Date"] });
    bb.state.down = true;
    expect(await recall("crew:k1|maya")).toEqual(["voyage: Lisbon — liked the beach"]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Backboard recall failed"))).toBe(true);
    const calls = bb.fetch.mock.calls.length;

    // back-off: within 60 s nobody waits on Backboard again (the local copy answers)
    vi.setSystemTime(Date.now() + 59_000);
    expect(await recall("crew:k1|maya")).toEqual(["voyage: Lisbon — liked the beach"]);
    expect(bb.fetch.mock.calls.length).toBe(calls);

    // after the minute, Backboard is tried again (and, now up, answers)
    bb.state.down = false;
    vi.setSystemTime(Date.now() + 2_000);
    expect(await recall("crew:k1|maya")).toEqual(["voyage: Lisbon — liked the beach"]);
    expect(bb.fetch.mock.calls.length).toBeGreaterThan(calls);
    expect(bb.state.gets).toBe(1);
  });

  it("a Backboard call that hangs gives up after 5 s and the local copy answers", async () => {
    quietWarn();
    await remember("crew:k2|dev", "voyage: Mexico City — conceded on the beach");
    __memoryTest.reset();
    config.backboard.apiKey = "test-key";
    const f = stubFetch(hang);
    vi.useFakeTimers();
    const p = recall("crew:k2|dev");
    await calledOnce(f);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toEqual(["voyage: Mexico City — conceded on the beach"]);
    expect(f).toHaveBeenCalledTimes(1); // the assistant POST, aborted
  });

  it("a failed Backboard write keeps the line locally", async () => {
    const warn = quietWarn();
    const bb = backboard();
    bb.state.down = true;
    config.backboard.apiKey = "test-key";
    await remember("crew:k3|rae", "voyage: Montréal — budget band 2");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Backboard write failed"))).toBe(true);
    config.backboard.apiKey = "";
    expect(await recall("crew:k3|rae")).toEqual(["voyage: Montréal — budget band 2"]);
  });

  it("a failed Mongo load reads as empty for that call only; the next recall loads again", async () => {
    quietWarn();
    mongo.on = true;
    mongo.docs.memories = new Map([["crew:k4|maya", { _id: "crew:k4|maya", v: ["voyage: Lisbon"] }]]);
    mongo.failLoads = 1;
    expect(await recall("crew:k4|maya")).toEqual([]);
    expect(await recall("crew:k4|maya")).toEqual(["voyage: Lisbon"]);
    expect(__memoryTest.loads()).toBe(2);
  });

  it("a thread past 25 lines: the local copy keeps the last 20 and recall gives the newest 5", async () => {
    mongo.on = true;
    const key = "crew:k5|dev";
    for (let i = 1; i <= 30; i++) await remember(key, `voyage ${i}`);
    expect((mongo.docs.memories.get(key) as { v: string[] }).v).toEqual(Array.from({ length: 20 }, (_, i) => `voyage ${i + 11}`));
    expect(await recall(key)).toEqual(["voyage 26", "voyage 27", "voyage 28", "voyage 29", "voyage 30"]);
    await rememberAll([{ key, text: "voyage 31" }, { key: "crew:k6|rae", text: "first" }]);
    expect(await recall(key)).toEqual(["voyage 27", "voyage 28", "voyage 29", "voyage 30", "voyage 31"]);
  });

  it("Backboard: a page in any order is sorted by created_at, so recall gives the newest 5 of the page; remember keeps it fresh", async () => {
    const bb = backboard();
    config.backboard.apiKey = "test-key";
    const key = "crew:k7|maya";
    for (let i = 1; i <= 25; i++) await remember(key, `line ${i}`);
    bb.state.order = "newest"; // newest first, as a "latest page" API would send
    __memoryTest.reset();
    expect(await recall(key)).toEqual(["line 21", "line 22", "line 23", "line 24", "line 25"]);
    const url = String(bb.fetch.mock.calls.find((c) => (c[1]?.method ?? "GET") === "GET")![0]);
    expect(url).toMatch(/\/memories\?page=1&page_size=100$/); // the API's largest page
    // past 25 lines the cached thread keeps the last 25, and recall still ends with the newest line
    for (let i = 26; i <= 28; i++) await remember(key, `line ${i}`);
    expect(await recall(key)).toEqual(["line 24", "line 25", "line 26", "line 27", "line 28"]);
    expect(bb.state.gets).toBe(1);
  });

  it.each(["oldest", "newest"] as const)("Backboard: a thread longer than a page (%s-first) recalls its newest lines, in at most 3 GETs", async (order) => {
    const bb = backboard();
    config.backboard.apiKey = "test-key";
    const key = `crew:k8-${order}|rae`;
    for (let i = 1; i <= 201; i++) await remember(key, `line ${i}`); // 3 pages: 100, 100, 1
    bb.state.order = order;
    __memoryTest.reset();
    bb.state.gets = 0;
    expect(await recall(key)).toEqual(["line 197", "line 198", "line 199", "line 200", "line 201"]);
    expect(bb.state.gets).toBe(3); // page 1 + the last two (the last has one line)
    const pages = bb.fetch.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "GET").map((c) => new URL(String(c[0])).searchParams.get("page"));
    expect(pages.sort()).toEqual(["1", "2", "3"]);
    // a longer thread still costs 3 GETs (page 1, the second-last, the last), never the pages in between
    for (let i = 202; i <= 450; i++) await remember(key, `line ${i}`);
    __memoryTest.reset();
    bb.state.gets = 0;
    expect(await recall(key)).toEqual(["line 446", "line 447", "line 448", "line 449", "line 450"]);
    expect(bb.state.gets).toBe(3);
  });
});

// ---------- voice ----------
describe("O2-065: TTS failure paths → captions (null)", () => {
  it("a non-OK answer: null, no audio for the turn, one warning with the status", async () => {
    const warn = quietWarn();
    config.eleven.apiKey = "test-key";
    const f = stubFetch(async () => new Response("quota exceeded", { status: 401 }));
    expect(await synthesize("t-401", "Lisbon it is.", "captain")).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toContain("api.elevenlabs.io/v1/text-to-speech/");
    expect(audioFile("t-401")).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[1]).includes("TTS 401"))).toBe(true);
  });

  it("a request that hangs is aborted after 8 s", async () => {
    quietWarn();
    config.eleven.apiKey = "test-key";
    const f = stubFetch(hang);
    vi.useFakeTimers();
    const p = synthesize("t-hang", "Mexico City has tacos.", "1");
    await calledOnce(f);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(f.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(await p).toBeNull();
    expect(audioFile("t-hang")).toBeNull();
  });

  it("an unwritable cache dir: the mp3 isn't served, voices fall back to captions with one warning", async () => {
    const warn = quietWarn();
    config.eleven.apiKey = "test-key";
    stubFetch(async () => new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]), { status: 200 }));
    expect(await synthesize("t-ro1", "One line.", "2")).toBeNull();
    expect(await synthesize("t-ro2", "Another line.", "2")).toBeNull();
    expect(audioFile("t-ro1")).toBeNull();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("is not writable"))).toHaveLength(1);
  });

  it("cached mode never calls the network: a line that isn't cached is captions only", async () => {
    config.demoReplay = "cached";
    const f = stubFetch(async () => new Response("no", { status: 500 }));
    expect(await synthesize("t-cached", "Not in the warmed cache.", "3")).toBeNull();
    config.eleven.apiKey = "test-key"; // even with a key
    expect(await synthesize("t-cached2", "Still not cached.", "3")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("without a key nothing is attempted", async () => {
    const f = stubFetch(async () => new Response("no", { status: 500 }));
    expect(await synthesize("t-nokey", "Hello.", "1")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("O2-065: transcribe (hail speech-to-text)", () => {
  const clip = Buffer.from("fake-webm-bytes");

  it("without a key: null, no request", async () => {
    const f = stubFetch(async () => json({ text: "x" }));
    expect(await transcribe(clip, "audio/webm")).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("posts the clip and model as multipart form data and returns the trimmed text", async () => {
    config.eleven.apiKey = "test-key";
    const f = stubFetch(async () => json({ text: "  somewhere cheaper with a beach  " }));
    expect(await transcribe(clip, "audio/mp4")).toBe("somewhere cheaper with a beach");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    const form = init?.body as FormData;
    expect(form.get("model_id")).toBe(config.eleven.sttModel);
    const file = form.get("file") as File;
    expect(file.type).toBe("audio/mp4");
    expect(file.size).toBe(clip.length);
  });

  it("a non-OK answer, an empty transcript, a network error or a hang (15 s) → null", async () => {
    quietWarn();
    config.eleven.apiKey = "test-key";
    stubFetch(async () => new Response("bad", { status: 422 }));
    expect(await transcribe(clip, "")).toBeNull();
    stubFetch(async () => json({ text: "   " }));
    expect(await transcribe(clip, "audio/webm")).toBeNull();
    stubFetch(async () => json({}));
    expect(await transcribe(clip, "audio/webm")).toBeNull();
    stubFetch(async () => { throw new TypeError("fetch failed"); });
    expect(await transcribe(clip, "audio/webm")).toBeNull();
    const f = stubFetch(hang);
    vi.useFakeTimers();
    const p = transcribe(clip, "audio/webm");
    await calledOnce(f);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await p).toBeNull();
  });
});
