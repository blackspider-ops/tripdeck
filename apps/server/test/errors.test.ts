/** R2-WP-13: the one code → status table (O2-025), the timeout helpers (O2-011) and the band scrub (O2-012). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HTTP_STATUS, HelmError } from "../src/util/errors.js";
import { withAbort, withTimeout } from "../src/util/timeout.js";
import { BUDGET_BANDS, budgetBand } from "../src/memory/bands.js";
import { memoryForPrompt } from "../src/privacy/guard.js";
import { REASONS } from "../src/payments/orchestrator.js";
import { VOID_HEADLINE } from "@all-ayes/shared";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
});

describe("O2-025: one code → HTTP status table", () => {
  it("every code thrown in src has an entry", () => {
    const codes = new Set<string>();
    for (const f of files(SRC)) for (const m of readFileSync(f, "utf8").matchAll(/new HelmError\(\s*"([A-Z_]+)"/g)) codes.add(m[1]);
    expect(codes.size).toBeGreaterThan(30);
    const missing = [...codes].filter((c) => !(c in HTTP_STATUS));
    expect(missing).toEqual([]);
  });

  it("a refusal's status comes from the table; an explicit one only where a code has two answers", () => {
    expect(new HelmError("BAD_PHASE", "x").status).toBe(409);
    expect(new HelmError("NOT_MEMBER", "x").status).toBe(403);
    expect(new HelmError("NO_STT", "x").status).toBe(503);
    expect(new HelmError("NO_STT", "x", 501).status).toBe(501);
    expect(new HelmError("SOMETHING_NEW", "x").status).toBe(400);
  });
});

describe("O2-011: timeouts clear their timers", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("withTimeout clears its timer when the promise wins", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(1), 6_000, () => null)).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withTimeout answers onTimeout() when the promise is late, and passes a rejection through", async () => {
    vi.useFakeTimers();
    const late = withTimeout(new Promise<number>(() => undefined), 1_000, () => "late");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(late).resolves.toBe("late");
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000, () => null)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withAbort aborts a slow call and clears its timer when the call is quick", async () => {
    vi.useFakeTimers();
    await expect(withAbort(1_000, async () => 2)).resolves.toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    let aborted = false;
    const slow = withAbort(1_000, (signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); })));
    await vi.advanceTimersByTimeAsync(1_000);
    await slow;
    expect(aborted).toBe(true);
  });
});

describe("O2-012: strings that must match", () => {
  it("no budget band reaches a prompt through memory, whatever the band is called", () => {
    for (const cap of [30_000, 79_999, 80_000, 129_999, 130_000, 300_000]) {
      const note = `voyage: Lisbon, Mar 12 to 16 · booked · ${budgetBand(cap)} · liked: Food tour`;
      const [line] = memoryForPrompt([note]);
      for (const b of BUDGET_BANDS) expect(line, note).not.toMatch(new RegExp(`\\b${b.word}\\s+budget\\b`, "i"));
      expect(line).toMatch(/liked: Food tour/);
    }
  });

  it("the declined reason is the phones' void headline", () => {
    expect(REASONS.declined).toBe(VOID_HEADLINE);
  });
});
