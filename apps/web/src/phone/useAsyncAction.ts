import { useCallback, useEffect, useRef, useState } from "react";
import { actionError } from "./errors";

/**
 * O2-016: the busy / error / try-catch shape every REST action on the phone shares. `run(fn, fallback)` does
 * nothing while one is in flight, clears the last error, and on a failure keeps `err` as phone copy (`actionError`:
 * never the raw error text). Resolves true when `fn` succeeded. State isn't touched after unmount.
 */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inflight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const run = useCallback(async (fn: () => Promise<unknown>, fallback: string): Promise<boolean> => {
    if (inflight.current) return false;
    inflight.current = true;
    setBusy(true); setErr(null);
    try {
      await fn();
      return true;
    } catch (e) {
      if (alive.current) setErr(actionError(e, fallback));
      return false;
    } finally {
      inflight.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  const clear = useCallback(() => setErr(null), []);
  return { busy, err, run, clear };
}
