import { useEffect, useState } from "react";
import { CONFIRM_MS } from "../timing";

/**
 * Inline two-tap confirm (no browser dialog): the first tap arms it and relabels the button, a second tap within
 * CONFIRM_MS runs it; otherwise it disarms by itself.
 */
export function useTwoTap<A extends unknown[]>(run: (...args: A) => void) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [armed]);
  const tap = (...args: A) => {
    if (!armed) { setArmed(true); return; }
    setArmed(false);
    run(...args);
  };
  return [armed, tap] as const;
}
