/**
 * Hooks the store raises to the helm. A separate module (not db.ts), so tests that fake db.ts keep them.
 *
 * L5-010: join codes are unique in MongoDB, but a new voyage only checks the ones in memory; an archived voyage
 * can hold the code it drew. The trip write then fails with E11000 on `joinCode`, and the helm (crew.ts) draws a new
 * code and saves again, instead of the voyage living in memory only.
 */
let joinCodeClash: ((tripId: string) => void) | null = null;

export function onJoinCodeClash(fn: ((tripId: string) => void) | null) { joinCodeClash = fn; }

/** Raised after the failed write has been parked, so the re-save queues a fresh write of the same document. */
export function raiseJoinCodeClash(tripId: string) {
  const fn = joinCodeClash;
  if (!fn) return;
  const t = setTimeout(() => { try { fn(tripId); } catch (e) { console.warn(`[db] join code clash on ${tripId} not resolved`, (e as Error).message); } }, 0);
  t.unref?.();
}
