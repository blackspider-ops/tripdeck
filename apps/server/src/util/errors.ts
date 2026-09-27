/**
 * O2-025: the one code → HTTP status table (TR3-013), so the same refusal always has the same status:
 * 400 malformed request · 403 not allowed (a member token is a capability: a missing or wrong one is 403, not 401) ·
 * 404 no such thing · 409 conflicts with the voyage's current state · 411/413 upload framing · 422 well-formed but
 * invalid input · 429 slow down · 5xx the helm or a provider can't serve it right now. Sockets see only the code.
 * Every code thrown in src has an entry (test/errors.test.ts checks it).
 */
export const HTTP_STATUS: Readonly<Record<string, number>> = {
  NOT_JOINED: 400, PASSKEY_FAILED: 400,
  NOT_MEMBER: 403, NOT_ORGANIZER: 403, FORBIDDEN: 403, CREW_CLOSED: 403, OWN_INVITE: 403, BAD_INVITE: 403, BAD_HANDOFF: 403,
  BAD_CODE: 403, PASSKEY_REQUIRED: 403, DEVICE_EXPIRED: 403, PIN_REQUIRED: 403, BAD_PIN: 403,
  NO_TRIP: 404, NOT_FOUND: 404,
  BAD_PHASE: 409, CREW_FULL: 409, BAND_TAKEN: 409, INVITE_CLAIMED: 409, CAPTURING: 409, NEEDS_ATTENTION: 409, TOO_FEW: 409,
  BRIEFS_PENDING: 409, PASSKEY_MISSING: 409, PASSKEY_EXISTS: 409, PASSKEY_ELSEWHERE: 409, PASSKEY_UNBOUND: 409, BAD_BOOKING: 409,
  CAPTAINS_CALLING: 409, TABLE_OPENING: 409, SEAL_LOCKED: 409,
  LENGTH_REQUIRED: 411, TOO_LARGE: 413,
  BAD_INPUT: 422, HAIL_AMOUNTS: 422,
  SLOW_DOWN: 429, HAIL_WAITING: 429, TOO_MANY_RUNS: 429, PIN_LOCKED: 429,
  INTERNAL: 500, STT_FAILED: 502, NO_STT: 503, LOADING: 503, HELM_FULL: 503,
};

/**
 * A refusal the caller sees as `{code, message}` (socket `error` / REST status). The status comes from HTTP_STATUS;
 * `status` is given only where one code means two transport answers (NO_STT: 501 unconfigured vs 503 budget spent).
 */
export class HelmError extends Error {
  readonly status: number;
  constructor(public code: string, message: string, status?: number) {
    super(message);
    this.status = status ?? HTTP_STATUS[code] ?? 400;
  }
}

/** The one "slow down" refusal (REST limiters, socket limiters, hail pacing). */
export const slow = (message: string) => new HelmError("SLOW_DOWN", message);

/** What a caller sees when the helm itself failed (never a stack). */
export const INTERNAL_MESSAGE = "Something went wrong at the helm.";
