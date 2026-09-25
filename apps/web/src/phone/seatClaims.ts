import type { CrewPublic } from "@all-ayes/shared";
import { api, ApiError } from "../net/api";

/**
 * Each claim mints a fresh member token and invalidates the last one, so the claim must happen once per
 * link even when StrictMode runs the effect twice (otherwise the saved token can be the dead one).
 * Demo handoffs are single use too.
 */
const claims = new Map<string, Promise<string>>();
function once(key: string, run: () => Promise<string>): Promise<string> {
  let p = claims.get(key);
  if (!p) {
    p = run();
    p.catch(() => claims.delete(key));
    claims.set(key, p);
  }
  return p;
}

/** An absent friend's invite key (#m=<id>&k=<key>) → that seat's member token. */
export function claimOnce(tripId: string, memberId: string, inviteKey: string): Promise<string> {
  return once(`claim:${tripId}:${memberId}:${inviteKey}`, () => api.claimAbsent(tripId, memberId, inviteKey).then((r) => r.memberToken));
}

/** A /demo one-time handoff code (#as=<code>&m=<id>, SEC-004) → that seat's member token. */
export function redeemOnce(tripId: string, memberId: string, code: string): Promise<string> {
  return once(`handoff:${tripId}:${memberId}:${code}`, () => api.redeemHandoff(tripId, memberId, code).then((r) => r.memberToken));
}

/**
 * S2-009 / S2-012: the organizer resets a seat someone else took (an invite opened by the wrong person, a leaked
 * token that added its own passkey). Kept here, next to the claim it undoes; the request is `api.resetSeat`.
 */
export async function resetSeat(tripId: string, organizerToken: string, memberId: string): Promise<{ memberId: string; invitePath: string }> {
  const r = await api.resetSeat(tripId, organizerToken, memberId);
  if (!r?.invitePath) throw new ApiError(500, "Couldn't reset that seat. Try again.");
  return { memberId: r.memberId ?? memberId, invitePath: r.invitePath };
}

/**
 * L1-009 (Muster): which seats show an invite row (absent friends, and seats the organizer reset), and which the
 * organizer may reset from "Someone else on a seat?" (members who joined by code, or re-claimed after a reset).
 */
export function seatLists(crew: CrewPublic[], meId: string | undefined) {
  return {
    invited: crew.filter((c) => c.role === "absent" || c.inviteOpen === false),
    others: crew.filter((c) => c.role === "member" && c.inviteOpen !== false && c.memberId !== meId),
  };
}

/** One invite row: opened (the link is spent: no link, no remake), the link this phone kept, or "make a new link". */
export const inviteView = (friend: CrewPublic, url: string | undefined): "opened" | "link" | "remake" =>
  friend.inviteOpen ? "opened" : url ? "link" : "remake";
