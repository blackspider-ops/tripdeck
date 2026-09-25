/**
 * O2-063: wait for the payments machinery to go quiet instead of sleeping a fixed 80 ms. `trackSim` counts the SIM's
 * provider calls in flight (every authorize/capture/void/refund goes through its private `once`); `quiet()` resolves
 * once none is in flight and a few event-loop turns have passed with nothing new starting, so the orchestrator's
 * follow-ups (a published result, a re-drive) have run. Negative checks ("nothing voids yet") hold after it too.
 */
import type { SimProvider } from "../../src/payments/sim.js";

let inFlight = 0;

export function trackSim(sim: SimProvider): SimProvider {
  const s = sim as unknown as { once<T>(key: string, fn: () => Promise<T>): Promise<T> };
  const once = s.once.bind(sim);
  s.once = <T>(key: string, fn: () => Promise<T>) => once(key, async () => {
    inFlight++;
    try { return await fn(); } finally { inFlight--; }
  });
  return sim;
}

const turn = () => new Promise<void>((r) => setImmediate(r));

/** Resolves when no tracked provider call is in flight for `turns` consecutive event-loop turns (gives up after 2 s). */
export async function quiet(turns = 3): Promise<void> {
  const end = Date.now() + 2_000;
  for (let still = 0; still < turns && Date.now() < end;) {
    await turn();
    still = inFlight === 0 ? still + 1 : 0;
  }
}

/** Polls `pred` every event-loop turn until it holds (gives up after `maxMs`). */
export async function until(pred: () => boolean, maxMs = 2_000): Promise<void> {
  const end = Date.now() + maxMs;
  while (!pred() && Date.now() < end) await turn();
}
