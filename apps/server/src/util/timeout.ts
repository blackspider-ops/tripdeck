/**
 * O2-011: the helm's two timeout shapes, each clearing (and unref'ing) its timer, so a settled call never leaves a
 * timer behind that keeps a shutting-down process alive.
 */

/** `p`, or `onTimeout()` if `p` hasn't settled within `ms`. A rejection of `p` passes through. */
export function withTimeout<T, F>(p: Promise<T>, ms: number, onTimeout: () => F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Runs `fn` with a signal that aborts after `ms` (a fetch, or a fetch and its body); the timer ends with `fn`. */
export async function withAbort<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  timer.unref?.();
  try {
    return await fn(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}
