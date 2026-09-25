import { useEffect, useState } from "react";

/**
 * O2-017: "now", ticking every `intervalMs` while `active` (countdowns, the sail-without clock). It jumps to the
 * current time whenever it (re)starts, and stops ticking when inactive, so an idle screen doesn't redraw.
 */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);
  return now;
}
