// TR3-006 / TR1-014: api.* always rejects with an ApiError carrying the HTTP status, whatever the body.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, CALL_TIMEOUT_MS, api, captureDevKey } from "./api";

const reply = (status: number, body: string, type = "application/json") =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status, headers: { "Content-Type": type } }));
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("resolved"); }, (e: unknown) => e);
afterEach(() => vi.restoreAllMocks());

describe("api error bodies", () => {
  it("a JSON refusal keeps its code and message", async () => {
    reply(404, JSON.stringify({ code: "NO_TRIP", message: "No voyage with that code." }));
    const e = await failure(api.tripByCode("ZZZZZZ"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 404, code: "NO_TRIP", message: "No voyage with that code." });
  });

  it("an HTML proxy page (502) is an ApiError with the status, not a SyntaxError", async () => {
    reply(502, "<html><body>Bad Gateway</body></html>", "text/html");
    const e = await failure(api.health());
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(502);
  });

  it("an empty error body still carries the status", async () => {
    reply(504, "", "text/plain");
    expect(await failure(api.health())).toMatchObject({ status: 504 });
  });

  it("no network at all is ApiError status 0", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await failure(api.health())).toMatchObject({ status: 0, code: "OFFLINE" });
  });
});

describe("O2-048: REST calls time out and can be aborted", () => {
  afterEach(() => vi.useRealTimers());
  it("a fetch that never answers (and ignores its signal) rejects with TIMEOUT, and the request is aborted", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); });
    const p = failure(api.health());
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
    let settled = false; void p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ status: 0, code: "TIMEOUT" });
    expect(signal?.aborted).toBe(true);
  });

  it("the caller's signal aborts it with ABORTED (not OFFLINE)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => new Promise<Response>((_, rej) =>
      init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const ctl = new AbortController();
    const p = failure(api.tripByCode("ABCDEF", { signal: ctl.signal }));
    ctl.abort();
    expect(await p).toMatchObject({ status: 0, code: "ABORTED" });
  });

  it("an already-aborted signal never waits", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    const ctl = new AbortController(); ctl.abort();
    expect(await failure(api.cities({ signal: ctl.signal }))).toMatchObject({ code: "ABORTED" });
  });
});

describe("S2-013: the dev key comes from the fragment only", () => {
  function atUrl(url: string) {
    const u = new URL(url, "https://allayes.test");
    const store = new Map<string, string>();
    const loc = { pathname: u.pathname, search: u.search, hash: u.hash };
    vi.stubGlobal("location", loc);
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal("history", { state: null, replaceState: (_s: unknown, _t: string, next: string) => Object.assign(loc, { search: "", hash: "", pathname: next }) });
    return { store, loc };
  }
  afterEach(() => vi.unstubAllGlobals());
  const seedHeaders = async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    await api.seedDemo().catch(() => undefined);
    return new Headers((f.mock.calls[0][1] as RequestInit).headers);
  };

  it("/demo?key=x stores nothing and the key is wiped from the address bar", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, loc } = atUrl("/demo?key=x");
    captureDevKey();
    expect([...store.values()]).toEqual([]);
    expect(loc.pathname).toBe("/demo");
    expect((await seedHeaders()).get("X-Dev-Key")).toBeNull();
  });

  it("/demo#key=x stores it for this tab and sends it as a header", async () => {
    const { store, loc } = atUrl("/demo#key=x");
    captureDevKey();
    expect([...store.values()]).toEqual(["x"]);
    expect(loc.pathname).toBe("/demo");
    expect((await seedHeaders()).get("X-Dev-Key")).toBe("x");
  });
});

describe("L1-005 (R2-WP-12): a dictated note asks for the note's length", () => {
  it("hailAudio sends ?kind=note for the Brief's voice note and nothing extra for a hail", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ transcript: "ok" }), { headers: { "Content-Type": "application/json" } }));
    await api.hailAudio("T1", "tok", new Blob(["a"]), "note");
    await api.hailAudio("T1", "tok", new Blob(["a"]));
    expect(String(f.mock.calls[0][0])).toBe("/api/trips/T1/hail-audio?kind=note");
    expect(String(f.mock.calls[1][0])).toBe("/api/trips/T1/hail-audio");
  });
});
