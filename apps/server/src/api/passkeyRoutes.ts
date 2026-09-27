/**
 * Passkey routes (PRD E2, docs/06-payments-spec.md §4.1): status, register and auth ceremonies for a member's seal.
 * Mounted by routes.ts on the /api router, after the voyage-exists check and before the JSON 404.
 */
import type { Request, Response, Router } from "express";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { TripService } from "../trips/service.js";
import { HelmError, slow } from "../util/errors.js";
import { DAY_MS, LIMITS, MINUTE_MS, RateLimiter } from "../util/limits.js";
import {
  authenticationOptions, hasPasskey, mintPasskeyClaim, passkeyStatus, registrationBlock, registrationOptions, relyingParty, verifyAuthentication,
  verifyRegistration,
} from "../passkeys/passkeys.js";
import { config } from "../config.js";
import { asyncRoute, bearerMember, ipOf, jsonBody, param } from "./http.js";

const header = (req: Request, name: string) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };

/**
 * One relying party for status, register and auth (TR3-001): Origin → Referer → configured → X-Forwarded-Host → Host.
 * The status GET is same-origin, so browsers send no Origin: it resolves from the Referer, which the app's own
 * `Referrer-Policy: same-origin` (web.ts, L3-007) keeps on same-origin requests.
 */
const originFor = (req: Request) => relyingParty({
  origin: header(req, "origin"), referer: header(req, "referer"), host: header(req, "host"),
  forwardedHost: header(req, "x-forwarded-host"), forwardedProto: header(req, "x-forwarded-proto"),
});

// ---------- the passkey claim (S2-009) ----------
const CLAIM_COOKIE_MAX_AGE_MS = 30 * DAY_MS;
const claimCookieName = (memberId: string) => `aa_pk_${memberId}`;
const claimCookiePath = (tripId: string) => `/api/trips/${encodeURIComponent(tripId)}/passkey`;

/** The passkey-claim nonce this phone holds for this member (the cookie is only ever sent to the passkey routes). */
export function claimNonceOf(req: Request, memberId: string): string | undefined {
  const want = claimCookieName(memberId);
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === want) return decodeURIComponent(part.slice(i + 1).trim()) || undefined;
  }
  return undefined;
}

/**
 * S2-009: the phone that creates, joins or claims a seat (or redeems a demo handoff) gets that seat's passkey claim
 * as an HttpOnly, SameSite=Strict cookie scoped to this voyage's passkey routes. Registering a passkey needs it,
 * so the member token alone (a screenshot, a copied link) can't bind someone else's authenticator.
 */
export function issuePasskeyClaim(req: Request, res: Response, tripId: string, memberId: string) {
  const nonce = mintPasskeyClaim(memberId);
  const https = req.secure || header(req, "x-forwarded-proto")?.split(",")[0]?.trim() === "https" || config.production;
  res.cookie(claimCookieName(memberId), nonce, {
    httpOnly: true, sameSite: "strict", secure: https, path: claimCookiePath(tripId), maxAge: CLAIM_COOKIE_MAX_AGE_MS,
  });
}

/** Registration needs the member's own token AND this phone's passkey claim; a passkey is never replaced (SEC-008). */
const assertCanRegister = (req: Request, memberId: string, rpID: string) => {
  const block = registrationBlock(memberId, rpID, claimNonceOf(req, memberId));
  if (block) throw new HelmError(block.code, block.message);
};

export function mountPasskeyRoutes(r: Router, helm: TripService) {
  // SEC-007: every passkey route is rate-limited per client address
  const limiter = new RateLimiter(LIMITS.http.passkeyPerMinute, MINUTE_MS);
  r.use("/trips/:tripId/passkey", (req, _res, next) => {
    if (!limiter.take(ipOf(req))) return next(slow("Too many passkey tries — wait a minute."));
    next();
  });
  const memberOf = (req: Request) => bearerMember(helm, req, "Only crew can do that.");

  r.get("/trips/:tripId/passkey", asyncRoute((req, res) => {
    const m = memberOf(req);
    // registered: usable on this origin; required: the seal gate will ask for one (a passkey exists somewhere);
    // canRegister (S2-009): this phone may add one here (it holds the seat's passkey claim, and none is in the way)
    const o = originFor(req);
    const { registered, required } = passkeyStatus(m._id, o.rpID);
    // pin (Quest-first): the member set a seal PIN on a headset; a seal then needs it (or a passkey)
    res.json({ registered, required, canRegister: !registrationBlock(m._id, o.rpID, claimNonceOf(req, m._id)), ...(m.sealPin ? { pin: true } : {}) });
  }));
  r.post("/trips/:tripId/passkey/register/options", asyncRoute(async (req, res) => {
    const m = memberOf(req);
    const o = originFor(req);
    assertCanRegister(req, m._id, o.rpID);
    res.json(await registrationOptions(m._id, m.name, o));
  }));
  r.post("/trips/:tripId/passkey/register/verify", asyncRoute(async (req, res) => {
    const m = memberOf(req);
    const o = originFor(req);
    assertCanRegister(req, m._id, o.rpID);
    const ok = await verifyRegistration(m._id, (jsonBody(req) as { response: RegistrationResponseJSON }).response, o, claimNonceOf(req, m._id)).catch(() => false);
    if (!ok) throw new HelmError("PASSKEY_FAILED", "Couldn't set up your passkey.");
    res.json({ ok: true });
  }));
  r.post("/trips/:tripId/passkey/auth/options", asyncRoute(async (req, res) => {
    const m = memberOf(req);
    const o = originFor(req);
    if (!hasPasskey(m._id, o.rpID)) {
      throw new HelmError("PASSKEY_MISSING", "There's no passkey for you on this address. Open the voyage where you set it up.");
    }
    res.json(await authenticationOptions(m._id, o));
  }));
  r.post("/trips/:tripId/passkey/auth/verify", asyncRoute(async (req, res) => {
    const m = memberOf(req);
    const body = jsonBody(req) as { response?: AuthenticationResponseJSON; bookingId?: unknown };
    // the token is bound to this member and this booking (SEC-008)
    const bookingId = typeof body.bookingId === "string" ? body.bookingId : "";
    const b = bookingId ? helm.payments.bookings.get(bookingId) : undefined;
    if (!b || b.tripId !== param(req, "tripId") || !b.seals.some((s) => s.memberId === m._id)) {
      throw new HelmError("BAD_BOOKING", "Nothing to seal right now.");
    }
    const token = await verifyAuthentication(m._id, bookingId, body.response as AuthenticationResponseJSON, originFor(req)).catch(() => null);
    if (!token) throw new HelmError("PASSKEY_FAILED", "Your passkey didn't check out. Try again.");
    res.json({ assertionToken: token });
  }));
}
