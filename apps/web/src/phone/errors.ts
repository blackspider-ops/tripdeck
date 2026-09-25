import { ApiError } from "../net/api";

/**
 * Phone copy for server refusals the phone can explain better than the raw message (doc 02 §11 voice:
 * plain, warm, at most one nautical word a sentence). Anything not listed keeps the server's own message.
 */
const COPY: Record<string, string> = {
  // hails (WP-12 codes)
  HAIL_WAITING: "Your mate still has your last hail. It goes to the table next watch.",
  HAIL_AMOUNTS: "Keep numbers out of hails. Say it in words, like \"somewhere cheaper\".",
  CAPTAINS_CALLING: "Captain's calling it. Hails are closed for this table.",
  // R2-WP-04 / L4-005: a hail during the Captain's opening (Watch 0) is refused
  TABLE_OPENING: "The Captain is opening the table. Hail once the mates start speaking.",
  // booking (WP-04 codes). R2-WP-02: every seal is collected, then the booking settles together (~2.5 s later)
  CAPTURING: "Too late to call it off: every seal is set and the booking is settling.",
  NEEDS_ATTENTION: "A refund from the last try is still being sorted out. Give it a moment, then try again.",
  // setup
  TOO_FEW: "Invite at least one friend first. A table needs two.",
  NO_STT: "Voice isn't on here. Type it instead.",
  INVITE_CLAIMED: "They've already opened their link, so there's nothing to resend.",
  // WP-14 codes: a seal that can't change any more, and a voyage whose table has met its limit
  SEAL_LOCKED: "Your seal is already set.",
  TOO_MANY_RUNS: "The table has met enough times for this voyage.",
};

/** Copy keyed by code and the action it answers (`error.event`), when one code means two things. */
const COPY_BY_EVENT: Record<string, string> = {
  "SEAL_LOCKED seal:cancel": "Too late to lift — every seal is set.",
  // L3-008: only a refused hail gets the hail copy; any other SLOW_DOWN (joins, the socket budget, REST) keeps
  // the server's own message
  "SLOW_DOWN table:hail": "One hail every few seconds. Your words are still in the box.",
};

export function errorCopy(refusal: { code?: string; message: string; event?: string }): string {
  const { code, message, event } = refusal;
  if (!code) return message;
  return (event && COPY_BY_EVENT[`${code} ${event}`]) || COPY[code] || message;
}

/**
 * O2-016: the copy for a failed REST action — the phone's own words for a known refusal (errorCopy), the server's
 * message otherwise, and `fallback` for anything that isn't a helm answer (a thrown TypeError, an empty transcript).
 */
export function actionError(e: unknown, fallback: string): string {
  return e instanceof ApiError ? errorCopy(e) : fallback;
}

/** O2-017: said by the hail dock whenever a take or a preview is dropped because the Captain is calling it. */
export const HAIL_DROPPED = "That one didn't go out: the Captain was already calling it.";

/** Codes a hail can be refused with; the Hail dock shows these next to the words (only for `table:hail`). */
export const HAIL_CODES = ["HAIL_WAITING", "HAIL_AMOUNTS", "CAPTAINS_CALLING", "TABLE_OPENING", "SLOW_DOWN", "BAD_INPUT"] as const;
/** The action a hail refusal answers (`error.event`). */
export const HAIL_EVENTS = ["table:hail"] as const;

/**
 * L1-008: does an inline owner claim this refusal? The code must be one of `codes` and, when `events` is given,
 * the refusal must answer one of those actions — so a SLOW_DOWN from `trip:join` isn't taken by the hail dock.
 */
export function ownsError(
  e: { code?: string; event?: string } | null | undefined, codes: readonly string[], events?: readonly string[],
): boolean {
  if (!e?.code || !codes.includes(e.code)) return false;
  return !events || (!!e.event && events.includes(e.event));
}
