/**
 * TR5-007: MongoDB unavailable at boot no longer means memory-only for the life of the process. The connect is
 * retried in the background with capped exponential backoff; each failure is logged (and /api/health reports the
 * persistence as degraded) and, once it connects, `onConnected` runs (the helm merges what is stored and flushes
 * everything it holds in memory).
 */
/** O2-032: reconnect backoff: 1 s doubling to at most a minute between attempts. */
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export interface Reconnector { stop(): void; readonly attempts: number; readonly running: boolean }

export function startReconnect(opts: {
  attempt: () => Promise<boolean>;
  onConnected: () => void | Promise<void>;
  baseDelayMs?: number; maxDelayMs?: number;
  log?: (msg: string) => void;
}): Reconnector {
  const base = opts.baseDelayMs ?? BASE_DELAY_MS;
  const max = opts.maxDelayMs ?? MAX_DELAY_MS;
  const log = opts.log ?? ((m: string) => console.warn(m));
  let attempts = 0;
  let stopped = false;
  let running = true;
  let timer: NodeJS.Timeout | undefined;
  const next = () => {
    if (stopped) return;
    const delay = Math.min(max, base * 2 ** Math.min(attempts, 20));
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  const tick = async () => {
    if (stopped) return;
    attempts++;
    let ok = false;
    try { ok = await opts.attempt(); } catch (e) { log(`[db] reconnect attempt ${attempts} failed: ${(e as Error).message}`); }
    if (stopped) return;
    if (!ok) { next(); return; }
    running = false;
    log(`[db] MongoDB reachable again after ${attempts} attempt(s); flushing in-memory state`);
    try { await opts.onConnected(); } catch (e) { log(`[db] post-reconnect sync failed: ${(e as Error).message}`); }
  };
  next();
  return {
    stop() { stopped = true; running = false; if (timer) clearTimeout(timer); },
    get attempts() { return attempts; },
    get running() { return running; },
  };
}
