/**
 * Passkeys for "Set your seal" (PRD E2, docs/06-payments-spec.md §4).
 *
 * Policy (server-enforced, see apps/server/src/passkeys/passkeys.ts): members with no passkey anywhere seal with
 * the confirm tap; once a member has a passkey, every seal needs it.
 *
 * LIVE-001: sealing never *registers* a passkey. Setting one up is its own, optional action ("Add a passkey" on
 * the Wait screen, `addPasskey`), so no OS or password-manager "create a passkey" sheet ever opens in the middle
 * of the seal ceremony. Sealing only *asserts* with a passkey that is already on file.
 *
 * S2-009: only the phone that created, joined or claimed the seat may add its passkey. The server hands that phone
 * a claim (an HttpOnly cookie the browser sends by itself; this code never sees it) and says `canRegister` in the
 * passkey status; without it "Add a passkey" isn't offered, and a refusal reads PASSKEY_UNBOUND.
 */
import { api, ApiError } from "./api";
import { KEYS, readRaw } from "./storage";

type PasskeyResult =
  | { kind: "approved"; assertionToken: string }
  | { kind: "fallback" }                          // no passkey on file → the confirm tap seals
  | { kind: "cancelled"; message: string }        // user said no, or the prompt failed → don't seal, may retry
  | { kind: "blocked"; message: string; addHere?: boolean }; // this phone/address can't produce the passkey the seal needs

export type AddPasskeyResult =
  | { kind: "added" }                             // on file now (or already was): seals on this address ask for it
  | { kind: "cancelled"; message: string }
  | { kind: "blocked"; message: string };

export const PASSKEY_COPY = {
  cancelled: "Your passkey didn't go through, so your seal isn't set. Try again when ready.",
  required: "Your seal needs the passkey you added, so it isn't set yet. Tap Set your seal to approve with it.",
  elsewhere: "Your passkey lives on the phone and address you set it up on. Open the voyage there to set your seal.",
  unsupported: "This phone can't use passkeys, and your seal needs the one you set up. Open the voyage on that phone.",
  addCancelled: "No passkey added. You can add one later, or never.",
  addUnsupported: "This phone can't hold a passkey.",
  addUnbound: "A passkey can only be added on the phone that joined this seat. You can still seal with a tap.",
} as const;

const codeOf = (e: unknown) => (e instanceof ApiError ? e.code : undefined);

/** S2-009: the status says whether this phone holds the seat's claim (older helms don't say: assume yes). */
const canRegisterHere = (status: object) => (status as { canRegister?: boolean }).canRegister !== false;

/** Can this browser run a WebAuthn ceremony at all? (The dev kill switch `aa:passkeys=off` says no.) */
function webAuthnSupported() {
  if (import.meta.env.DEV && readRaw(KEYS.passkeysOff) === "off") return false;
  return typeof globalThis.PublicKeyCredential === "function" && typeof navigator !== "undefined" && !!navigator.credentials;
}

/** Can this phone *hold* a passkey (Face ID / Touch ID / screen lock)? Only then is "Add a passkey" offered. */
async function platformAuthenticator() {
  if (!webAuthnSupported()) return false;
  try { return Boolean(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()); } catch { return false; }
}

/**
 * Approve a seal. With no passkey on file this never touches WebAuthn: the confirm tap seals (`fallback`).
 * With one on file it asks for Face ID / Touch ID; a cancelled or failed prompt is `cancelled` (never a seal, L1-001).
 */
export async function approveWithPasskey(tripId: string, memberToken: string, bookingId: string): Promise<PasskeyResult> {
  const status = await api.passkeyStatus(tripId, memberToken); // network failure → caller decides
  if (!status.registered) {
    if (!status.required) return { kind: "fallback" };
    // a passkey exists, but not on this address: the seal can't be approved here (dev may add one here explicitly)
    const canHold = await platformAuthenticator();
    if (!canHold) return { kind: "blocked", message: PASSKEY_COPY.unsupported };
    return { kind: "blocked", message: PASSKEY_COPY.elsewhere, ...(canRegisterHere(status) ? { addHere: true } : {}) };
  }
  if (!webAuthnSupported()) return { kind: "blocked", message: PASSKEY_COPY.unsupported };
  try {
    // OPT-057: the WebAuthn helper loads at seal time only, and only when there's a passkey to ask for
    const { startAuthentication } = await import("@simplewebauthn/browser");
    const opts = await api.passkeyAuthOptions(tripId, memberToken);
    const auth = await startAuthentication({ optionsJSON: opts });
    const { assertionToken } = await api.passkeyAuthVerify(tripId, memberToken, bookingId, auth);
    return { kind: "approved", assertionToken };
  } catch (e) {
    if (codeOf(e) === "PASSKEY_MISSING") return { kind: "blocked", message: PASSKEY_COPY.elsewhere };
    return { kind: "cancelled", message: PASSKEY_COPY.cancelled };
  }
}

/** What Seal does after a tap: send `seal:set` (with the assertion when there is one), or show a note and don't. */
export type SealStep = { kind: "send"; assertionToken?: string } | { kind: "note"; message: string; addHere?: boolean };

export async function prepareSeal(tripId: string, memberToken: string | undefined, bookingId: string): Promise<SealStep> {
  if (!memberToken) return { kind: "send" };
  let r: PasskeyResult;
  try {
    r = await approveWithPasskey(tripId, memberToken, bookingId);
  } catch {
    // passkey status unreachable → confirm tap; if a passkey is on file the server answers PASSKEY_REQUIRED
    return { kind: "send" };
  }
  if (r.kind === "approved") return { kind: "send", assertionToken: r.assertionToken };
  if (r.kind === "fallback") return { kind: "send" };
  return { kind: "note", message: r.message, ...(r.kind === "blocked" && r.addHere ? { addHere: true } : {}) };
}

/** For the "Add a passkey" control: whether to offer it, and whether one is already on file here. */
export async function passkeyAvailability(tripId: string, memberToken: string): Promise<{ canAdd: boolean; registered: boolean }> {
  if (!(await platformAuthenticator())) return { canAdd: false, registered: false };
  const status = await api.passkeyStatus(tripId, memberToken);
  return { canAdd: !status.registered && canRegisterHere(status), registered: status.registered };
}

/**
 * The explicit, optional "Add a passkey" action. Registers only — it never sets a seal. Once added, every seal
 * on this address asks for it (server gate).
 */
export async function addPasskey(tripId: string, memberToken: string): Promise<AddPasskeyResult> {
  if (!(await platformAuthenticator())) return { kind: "blocked", message: PASSKEY_COPY.addUnsupported };
  try {
    const { startRegistration } = await import("@simplewebauthn/browser");
    const opts = await api.passkeyRegisterOptions(tripId, memberToken);
    const reg = await startRegistration({ optionsJSON: opts });
    await api.passkeyRegisterVerify(tripId, memberToken, reg);
    return { kind: "added" };
  } catch (e) {
    const code = codeOf(e);
    if (code === "PASSKEY_EXISTS") return { kind: "added" };
    if (code === "PASSKEY_UNBOUND") return { kind: "blocked", message: PASSKEY_COPY.addUnbound };
    if (code === "PASSKEY_ELSEWHERE") return { kind: "blocked", message: e instanceof ApiError ? e.message : PASSKEY_COPY.elsewhere };
    return { kind: "cancelled", message: PASSKEY_COPY.addCancelled };
  }
}
