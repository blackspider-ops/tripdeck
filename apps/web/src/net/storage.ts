/**
 * O2-017: the one wrapper around localStorage / sessionStorage. Storage can be blocked (private mode, a full quota,
 * Node in tests): a write that can't persist is kept in memory for this page, and reads see it, so a phone in
 * private mode still keeps its seat until the tab closes. Every key the web app stores is listed in KEYS.
 */
export type Area = "local" | "session";

/** Every key the web app keeps in the browser (one registry, so nothing is written under an ad-hoc name). */
export const KEYS = {
  /** local — this phone's member seat on a voyage (member token). */
  session: (code: string) => `aa:session:${code.toUpperCase()}`,
  /** local — a paired headset / laptop view's device token (TR2-010: never shares the member key). */
  headset: (code: string) => `aa:headset:${code.toUpperCase()}`,
  /** local — this phone's private memory identity across voyages (SEC-003). */
  crewKey: "aa:crewKey",
  /** local — the voyage Landing's "Back to voyage" opens. */
  last: "aa:last",
  /** local — TR1-007: when this organizer's phone first saw each crew member unsealed (removed once all have sealed). */
  unsealedSince: (tripId: string) => `aa:unsealedSince:${tripId}`,
  /** session — the invite links the organizer made on this tab, by member id. */
  invites: (tripId: string) => `aa:invites:${tripId}`,
  /** session — the dev key for /demo (SEC-019: this tab only). */
  devKey: "aa:devKey",
  /** local, dev only — `off` turns passkeys off in this browser. */
  passkeysOff: "aa:passkeys",
} as const;

const memory: Record<Area, Map<string, string>> = { local: new Map(), session: new Map() };
const backing = (area: Area): Storage => (area === "local" ? localStorage : sessionStorage);

export function readRaw(key: string, area: Area = "local"): string | null {
  const m = memory[area];
  if (m.has(key)) return m.get(key)!;
  try { return backing(area).getItem(key); } catch { return null; }
}

export function writeRaw(key: string, value: string, area: Area = "local") {
  try {
    backing(area).setItem(key, value);
    memory[area].delete(key);
  } catch {
    memory[area].set(key, value); // blocked: lives only in memory for this page
  }
}

export function removeKey(key: string, area: Area = "local") {
  memory[area].delete(key);
  try { backing(area).removeItem(key); } catch { /* blocked */ }
}

export function readJSON<T>(key: string, area: Area = "local"): T | null {
  const raw = readRaw(key, area);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export function writeJSON(key: string, value: unknown, area: Area = "local") {
  writeRaw(key, JSON.stringify(value), area);
}
