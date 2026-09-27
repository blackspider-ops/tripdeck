/**
 * L5-009: the boot restore is retried instead of crashing the process. The first attempt is a normal restore; if it
 * throws, later attempts merge (`merge: true`: voyages already in memory win, so anything created meanwhile is kept),
 * with capped exponential backoff, until one succeeds. Meanwhile lookups of stored voyages answer 503 LOADING or
 * load on demand (trips/persistence.ts).
 */
export interface Restorable { restore(opts?: { merge?: boolean }): Promise<unknown> }

export async function restoreOrRetry(helm: Restorable, opts: { baseDelayMs?: number; maxDelayMs?: number; log?: (m: string, e?: unknown) => void } = {}): Promise<boolean> {
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(m, e ?? ""));
  const base = opts.baseDelayMs ?? 2_000;
  const max = opts.maxDelayMs ?? 60_000;
  try {
    await helm.restore();
    return true;
  } catch (e) {
    log("[helm] WARNING: restore failed; starting anyway and retrying it in the background", e);
  }
  let attempt = 0;
  const next = () => {
    const t = setTimeout(async () => {
      attempt++;
      try {
        await helm.restore({ merge: true });
        log(`[helm] restore succeeded after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
      } catch (e) {
        log(`[helm] restore retry ${attempt} failed`, e);
        next();
      }
    }, Math.min(max, base * 2 ** Math.min(attempt, 20)));
    t.unref?.();
  };
  next();
  return false;
}
