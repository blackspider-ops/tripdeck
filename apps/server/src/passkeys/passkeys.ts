/**
 * Passkey approval for seals (PRD E2, docs/06-payments-spec.md §4.1, §9).
 * A member registers a passkey once on their phone; after that, "Set your seal" requires a fresh
 * passkey assertion, exchanged for a single-use token bound to that member AND that booking.
 *
 * Policy (WP-05):
 *  - Members with no passkey anywhere fall back to the confirm tap (PRD E2: "if unsupported, confirm fallback").
 *  - Once a member has a passkey on any relying party, every seal needs an assertion token (gate is unscoped;
 *    the token itself carries the rpID it was minted for, so the gate and the status check agree).
 *  - One passkey per member per rpID, never replaced by the member (409 PASSKEY_EXISTS).
 *  - S2-009: registering needs more than the member token: the passkey claim minted when that phone created, joined
 *    or claimed the seat (an HttpOnly cookie, passkeyRoutes.ts). A token that leaked on its own (a screenshot, a
 *    shared link) can't bind its own authenticator. The organizer's seat reset (crew.ts resetSeat) revokes the
 *    member's passkeys and claim, and the rightful member re-claims the seat with a fresh link.
 *  - A passkey for a second rpID (e.g. dev: localhost first, then a tunnel) is allowed only outside production;
 *    in production the rpID is pinned (WEBAUTHN_ORIGIN / PUBLIC_BASE_URL), so there is only ever one rpID.
 *  - Credentials persist to MongoDB (`passkeys` collection); the counter persists too. R2-WP-11: memory holds the
 *    passkeys of members whose voyage is in memory (loaded with the voyage, dropped when the sweep evicts it).
 */
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON, type WebAuthnCredential,
} from "@simplewebauthn/server";
import { hash, newToken, sameHash } from "../util/ids.js";
import { loadAll, loadWhere, persist } from "../store/db.js";
import { config, originOf } from "../config.js";

interface Stored { credential: WebAuthnCredential; rpID: string; memberId: string; createdAt: string }

/** Mongo shape: publicKey is base64url so the doc survives any JSON/BSON round trip. (A type, so it is a plain record.) */
type PasskeyDoc = {
  _id: string;            // credential id (base64url)
  memberId: string;
  rpID: string;
  publicKey: string;      // base64url of the COSE public key
  counter: number;
  transports?: string[];
  createdAt: string;
};

/**
 * S2-009: the passkey claim, one per member: the hash of a random nonce the claiming phone holds. Stored in the
 * `passkeys` collection as `{_id: "claim:<memberId>", kind: "claim", …}`; a revoked one (and a revoked credential)
 * is a tombstone without `nonceHash` / `publicKey`, which loadPasskeys skips.
 */
export type PasskeyClaimDoc = { _id: string; kind: "claim"; memberId: string; nonceHash?: string; createdAt: string };

interface Challenge { challenge: string; at: number; kind: "reg" | "auth"; rpID: string }
interface Assertion { memberId: string; bookingId: string; rpID: string; credentialId: string; exp: number }

export const CHALLENGE_TTL_MS = 5 * 60_000;
const ASSERTION_TTL_MS = 120_000;

const credentials = new Map<string, Stored[]>();      // memberId → passkeys
const challenges = new Map<string, Challenge>();      // memberId → pending challenge
const assertions = new Map<string, Assertion>();      // single-use tokens
const claims = new Map<string, PasskeyClaimDoc>();    // memberId → passkey claim (S2-009)

// ---------- relying party ----------
export interface Origin { origin: string; rpID: string }
export interface OriginHeaders {
  origin?: string; referer?: string; host?: string; forwardedHost?: string; forwardedProto?: string;
}

/** O2-019: an http(s) URL's origin (config's one parser), or undefined (a missing or "null" Origin included). */
const originFromUrl = (u: string | undefined) => originOf(u) || undefined;
const first = (v: string | undefined) => v?.split(",")[0]?.trim() || undefined;

/**
 * One relying-party resolution for status, register and auth (TR3-001).
 * Production with WEBAUTHN_ORIGIN/PUBLIC_BASE_URL: pinned. Otherwise the browser's Origin, then Referer
 * (same-origin GETs carry no Origin), then the configured origin, then X-Forwarded-Host, and only last
 * the Host header (which the Vite proxy rewrites to localhost:8787, so it can't be trusted).
 */
export function relyingParty(hdr: OriginHeaders): Origin {
  const wa = config.webauthn;
  const configured = originFromUrl(wa.origin());
  const rpOf = (origin: string) => ({ origin, rpID: (configured === origin && wa.rpId()) || new URL(origin).hostname });
  if (wa.production() && configured) return rpOf(configured);
  const fwd = first(hdr.forwardedHost);
  const origin = originFromUrl(hdr.origin) ?? originFromUrl(hdr.referer) ?? configured
    ?? (fwd ? originFromUrl(`${first(hdr.forwardedProto) ?? "https"}://${fwd}`) : undefined)
    ?? originFromUrl(`https://${hdr.host ?? "localhost"}`) ?? "https://localhost";
  return rpOf(origin);
}

// ---------- persistence ----------
const toDoc = (s: Stored): PasskeyDoc => ({
  _id: s.credential.id, memberId: s.memberId, rpID: s.rpID,
  publicKey: Buffer.from(s.credential.publicKey).toString("base64url"),
  counter: s.credential.counter, transports: s.credential.transports, createdAt: s.createdAt,
});
const fromDoc = (d: PasskeyDoc): Stored => ({
  memberId: d.memberId, rpID: d.rpID, createdAt: d.createdAt,
  credential: {
    id: d._id, counter: Number(d.counter) || 0,
    publicKey: new Uint8Array(Buffer.from(d.publicKey, "base64url")),
    transports: d.transports as AuthenticatorTransportFuture[] | undefined,
  },
});
const save = (s: Stored) => persist("passkeys", toDoc(s));

/**
 * Re-queues every credential held in memory (WP-10): after the database reconnects, writes made while it was down
 * (a registration, a counter bump) reach it. Returns how many were queued.
 */
export function persistAllPasskeys(): number {
  let n = 0;
  for (const list of credentials.values()) for (const s of list) { save(s); n++; }
  for (const c of claims.values()) { persist("passkeys", c); n++; }
  return n;
}

/** Reload every persisted credential (whole collection; the helm loads per member with loadPasskeysFor). */
export async function loadPasskeys() {
  mergePasskeyDocs(await loadAll<PasskeyDoc | PasskeyClaimDoc>("passkeys"));
}

/**
 * R2-WP-11 (L5-008 / S2-011): loads the passkeys and claims of these members only (the voyages restored at boot, or
 * one loaded on demand), so memory holds the passkeys of voyages in memory, not every passkey ever registered.
 */
export async function loadPasskeysFor(memberIds: string[]) {
  const ids = [...new Set(memberIds)].filter(Boolean);
  if (!ids.length) return;
  mergePasskeyDocs(await loadWhere<PasskeyDoc | PasskeyClaimDoc>("passkeys", { memberId: { $in: ids } }));
}

/**
 * R2-WP-11 (S2-011): the sweep evicted these members' voyage. Their credentials, claim, pending challenge and unspent
 * assertion tokens leave memory; nothing is written (the stored records stay, and come back with the voyage).
 */
export function evictPasskeys(memberIds: string[]) {
  if (!memberIds.length) return;
  const gone = new Set(memberIds);
  for (const id of gone) { credentials.delete(id); claims.delete(id); challenges.delete(id); }
  for (const [k, a] of assertions) if (gone.has(a.memberId) || a.exp <= Date.now()) assertions.delete(k);
}

/** Test hook (R2-WP-11): how many members have something in each passkey map. */
export const passkeyMapSizes = () => ({ credentials: credentials.size, challenges: challenges.size, assertions: assertions.size, claims: claims.size });

function mergePasskeyDocs(docs: (PasskeyDoc | PasskeyClaimDoc)[]) {
  for (const d of docs) {
    if ("kind" in d && d.kind === "claim") {
      // a claim minted in this process since (e.g. while the database was down) wins over the stored one
      if (d.memberId && d.nonceHash && !claims.has(d.memberId)) claims.set(d.memberId, d);
      continue;
    }
    if (!d?._id || !d.memberId || !("publicKey" in d) || !d.publicKey) continue; // revoked: a tombstone
    const list = credentials.get(d.memberId) ?? [];
    if (!list.some((c) => c.credential.id === d._id)) credentials.set(d.memberId, [...list, fromDoc(d)]);
  }
}

/** Test hook: forget everything held in memory (simulates a process restart). */
export function resetPasskeysForTests() { credentials.clear(); challenges.clear(); assertions.clear(); claims.clear(); }

// ---------- the passkey claim (S2-009) ----------
/**
 * Minted when a phone creates, joins or claims a seat (and again at every re-claim): the returned nonce goes to that
 * phone only (an HttpOnly cookie), and replaces any earlier claim for the member.
 */
export function mintPasskeyClaim(memberId: string): string {
  const nonce = newToken();
  const doc: PasskeyClaimDoc = { _id: `claim:${memberId}`, kind: "claim", memberId, nonceHash: hash(nonce), createdAt: new Date().toISOString() };
  claims.set(memberId, doc);
  persist("passkeys", doc);
  return nonce;
}

/** Does this nonce match the member's passkey claim? (Constant time.) */
export const holdsPasskeyClaim = (memberId: string, nonce: string | undefined) =>
  Boolean(nonce) && sameHash(nonce!, claims.get(memberId)?.nonceHash);

/**
 * S2-009 recovery (the organizer's seat reset): every passkey of this member is revoked (tombstoned in the store,
 * so a restart doesn't bring it back), with its claim, pending challenge and unspent assertion tokens. The seal
 * gate then falls back to the confirm tap until the rightful member, re-claimed, adds a passkey again.
 */
export function revokePasskeys(memberId: string) {
  const revokedAt = new Date().toISOString();
  for (const s of credentials.get(memberId) ?? []) persist("passkeys", { _id: s.credential.id, memberId, rpID: s.rpID, revokedAt });
  credentials.delete(memberId);
  if (claims.delete(memberId)) persist("passkeys", { _id: `claim:${memberId}`, kind: "claim", memberId, createdAt: revokedAt } satisfies PasskeyClaimDoc);
  challenges.delete(memberId);
  for (const [k, a] of assertions) if (a.memberId === memberId) assertions.delete(k);
}

// ---------- queries ----------
/** Without rpID: does this member have a passkey anywhere (→ the seal gate requires one). */
export const hasPasskey = (memberId: string, rpID?: string) =>
  (credentials.get(memberId) ?? []).some((c) => !rpID || c.rpID === rpID);

/** What the phone needs to know: a passkey usable here, and whether one is required at all. */
export const passkeyStatus = (memberId: string, rpID: string) =>
  ({ registered: hasPasskey(memberId, rpID), required: hasPasskey(memberId), rpID });

/** Why this member can't register a passkey on this rpID (with this passkey claim), or null if they can. */
export function registrationBlock(memberId: string, rpID: string, claimNonce?: string): { code: string; message: string } | null {
  if (hasPasskey(memberId, rpID)) return { code: "PASSKEY_EXISTS", message: "You already have a passkey for this voyage." };
  if (hasPasskey(memberId) && config.webauthn.production()) {
    return { code: "PASSKEY_ELSEWHERE", message: "Your passkey was set up on another address. Open the voyage there to set your seal." };
  }
  if (!holdsPasskeyClaim(memberId, claimNonce)) {
    return { code: "PASSKEY_UNBOUND", message: "A passkey can only be added on the phone that joined this seat. You can still seal with a tap." };
  }
  return null;
}

// ---------- ceremonies ----------
function takeChallenge(memberId: string, kind: Challenge["kind"], rpID: string) {
  const c = challenges.get(memberId);
  if (!c || c.kind !== kind || c.rpID !== rpID) return null;
  challenges.delete(memberId);
  return Date.now() - c.at <= CHALLENGE_TTL_MS ? c : null;
}

export async function registrationOptions(memberId: string, name: string, o: Origin) {
  const opts = await generateRegistrationOptions({
    rpName: "All Ayes",
    rpID: o.rpID,
    userName: `${name} · All Ayes`,
    userDisplayName: name,
    userID: new TextEncoder().encode(memberId),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    excludeCredentials: (credentials.get(memberId) ?? []).map((c) => ({ id: c.credential.id, transports: c.credential.transports })),
  });
  challenges.set(memberId, { challenge: opts.challenge, at: Date.now(), kind: "reg", rpID: o.rpID });
  return opts;
}

export async function verifyRegistration(memberId: string, response: RegistrationResponseJSON, o: Origin, claimNonce?: string) {
  const c = takeChallenge(memberId, "reg", o.rpID);
  if (!c || registrationBlock(memberId, o.rpID, claimNonce)) return false;
  const res = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: o.origin, expectedRPID: o.rpID });
  if (!res.verified || !res.registrationInfo) return false;
  const cred = res.registrationInfo.credential;
  if ([...credentials.values()].flat().some((s) => s.credential.id === cred.id)) return false; // never re-bind a credential
  // R2-WP-11: memory holds only the passkeys of voyages in memory, so the store is asked too (a tombstone counts)
  if ((await loadWhere<{ _id: string }>("passkeys", { _id: cred.id }, { limit: 1 })).length) return false;
  const stored: Stored = { credential: cred, rpID: o.rpID, memberId, createdAt: new Date().toISOString() };
  credentials.set(memberId, [...(credentials.get(memberId) ?? []), stored]);
  save(stored);
  return true;
}

export async function authenticationOptions(memberId: string, o: Origin) {
  const mine = (credentials.get(memberId) ?? []).filter((c) => c.rpID === o.rpID);
  const opts = await generateAuthenticationOptions({
    rpID: o.rpID,
    userVerification: "preferred",
    allowCredentials: mine.map((c) => ({ id: c.credential.id, transports: c.credential.transports })),
  });
  challenges.set(memberId, { challenge: opts.challenge, at: Date.now(), kind: "auth", rpID: o.rpID });
  return opts;
}

/** Verifies the assertion and returns a single-use token for this member + booking, valid for 2 minutes. */
export async function verifyAuthentication(memberId: string, bookingId: string, response: AuthenticationResponseJSON, o: Origin): Promise<string | null> {
  if (!bookingId) return null;
  const c = takeChallenge(memberId, "auth", o.rpID);
  const stored = (credentials.get(memberId) ?? []).find((x) => x.credential.id === response?.id && x.rpID === o.rpID);
  if (!c || !stored) return null;
  const res = await verifyAuthenticationResponse({
    response, expectedChallenge: c.challenge, expectedOrigin: o.origin, expectedRPID: o.rpID, credential: stored.credential,
  });
  if (!res.verified) return null;
  stored.credential.counter = res.authenticationInfo.newCounter;
  save(stored);
  return mintAssertion({ memberId, bookingId, rpID: o.rpID, credentialId: stored.credential.id });
}

/** Internal (exported for tests): mints the single-use token after a verified assertion. */
export function mintAssertion(a: Omit<Assertion, "exp">): string {
  const now = Date.now();
  for (const [k, v] of assertions) if (v.exp <= now) assertions.delete(k);
  const token = newToken();
  assertions.set(token, { ...a, exp: now + ASSERTION_TTL_MS });
  return token;
}

/** Consumes an assertion token (single use, even when it doesn't match). Valid only for its member and booking. */
export function consumeAssertion(memberId: string, bookingId: string, token: string | undefined): Assertion | null {
  if (!token) return null;
  const a = assertions.get(token);
  assertions.delete(token);
  if (!a || a.memberId !== memberId || a.bookingId !== bookingId || a.exp <= Date.now()) return null;
  // the credential it was minted from must still be on file for that rpID
  return hasPasskey(memberId, a.rpID) ? a : null;
}
