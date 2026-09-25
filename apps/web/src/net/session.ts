// Per-device credentials, kept in localStorage through net/storage.ts (O2-017: storage can be blocked; the keys are
// listed in KEYS there): the member seat per voyage, a paired headset's device token (TR2-010: never shares the
// member key), this phone's crew key (SEC-003; sent on create/join/claim) and the last voyage opened.
import { KEYS, readJSON, readRaw, removeKey, writeJSON, writeRaw } from "./storage";

export interface Session {
  tripId: string;
  joinCode: string;
  memberId?: string;
  memberToken?: string;
  deviceToken?: string; // headset (headset sessions only)
}
interface HeadsetSession { tripId: string; joinCode: string; deviceToken: string }

/** A member seat. A device token never lands here (TR2-010), so pairing a headset can't replace the organizer's seat. */
export function saveSession(s: Session) {
  const { deviceToken: _device, ...seat } = s;
  writeJSON(KEYS.session(s.joinCode), seat);
  // O2-017: through the same fallback, so a private-mode Landing still offers "Back to voyage"
  writeRaw(KEYS.last, s.joinCode.toUpperCase());
}

export function loadSession(code: string): Session | null {
  const s = readJSON<Session>(KEYS.session(code));
  // a record from an older build that only held a headset's device token is not a member seat
  return s && s.memberToken ? s : null;
}

export function lastJoinCode(): string | null {
  return readRaw(KEYS.last);
}

export function clearSession(code: string) {
  removeKey(KEYS.session(code));
}

/**
 * L1-002: the helm has no voyage by this code (NO_TRIP): drop this phone's seat for it, and Landing's "Back to voyage"
 * if it points there, so neither leads back to the dead end.
 */
export function forgetVoyage(code: string) {
  clearSession(code);
  if (readRaw(KEYS.last) === code.toUpperCase()) removeKey(KEYS.last);
}

export function saveHeadsetSession(s: HeadsetSession) {
  writeJSON(KEYS.headset(s.joinCode), { tripId: s.tripId, joinCode: s.joinCode.toUpperCase(), deviceToken: s.deviceToken });
}

export function loadHeadsetSession(code: string): HeadsetSession | null {
  const s = readJSON<HeadsetSession>(KEYS.headset(code));
  return s && s.deviceToken ? s : null;
}

export function clearHeadsetSession(code: string) {
  removeKey(KEYS.headset(code));
}

/** This phone's private crew key (SEC-003): minted by the server at the first join, then carried to every voyage. */
export function loadCrewKey(): string | undefined {
  const k = readRaw(KEYS.crewKey);
  return k && /^[A-Za-z0-9_-]{32,128}$/.test(k) ? k : undefined;
}

export function saveCrewKey(k: string | undefined) {
  if (k && /^[A-Za-z0-9_-]{32,128}$/.test(k)) writeRaw(KEYS.crewKey, k);
}

/** Seat credentials a link carries: a /demo handoff (`as`) or an absent friend's invite key (`k`), for member `m`. */
export type SeatLink = { m: string; as?: string; k?: string };
/**
 * Read from the fragment (SEC-019: never sent to a server). Older absent-friend invites put `m`/`k` in the query and
 * still work; a demo handoff is only read from the fragment (the legacy `?as=` seat link is gone, WP-16).
 */
export function readSeatLink(search: string, hash: string): SeatLink | null {
  const q = new URLSearchParams(search);
  const f = new URLSearchParams(hash.replace(/^#/, ""));
  const as = f.get("as");
  const m = f.get("m") ?? (as ? null : q.get("m"));
  const k = f.get("k") ?? q.get("k");
  if (!m || (!as && !k)) return null;
  return as ? { m, as } : { m, k: k! };
}
