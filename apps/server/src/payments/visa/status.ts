/**
 * Visa sandbox runtime (ported from Samewhere's payments/visa/status.ts): the configured client, the last handshake /
 * PAV outcome (for /api/health, never a secret), and verifyCard() — one real Payment Account Validation call on the
 * Visa sandbox test card, with a hard timeout, that NEVER throws.
 */
import { paymentsModeSetting, visaConfigSummary, visaCredentials } from "./config.js";
import { VisaClient } from "./client.js";
import { validateAccount } from "./pav.js";

export const VISA_VERIFIED_LABEL = "Visa sandbox: card verified";
export const VISA_NOT_VERIFIED_LABEL = "Visa sandbox: card not verified";
export const VISA_UNAVAILABLE_LABEL = "Visa sandbox: unavailable";

/** How the account behind a member's agent card was checked at seal time. Never carries a card number. */
export interface CardVerification {
  result: "verified" | "not_verified" | "unavailable";
  label: string;
  at: number;
  latencyMs?: number;
  /** Visa PAV actionCode ("00"/"85" = valid). */
  actionCode?: string;
}

let client: VisaClient | null | undefined;
let state: { live: boolean | null; lastCheckAt?: number; lastLatencyMs?: number; lastError?: string } = { live: null };

/** The configured client, or null (sim mode, or credentials missing). */
export function visaClient(): VisaClient | null {
  if (client !== undefined) return client;
  if (paymentsModeSetting() !== "visa_sandbox") return (client = null);
  const creds = visaCredentials();
  if (!creds) console.warn("[payments] PAYMENTS_MODE=visa_sandbox but Visa credentials are missing (VISA_USER_ID, VISA_PASSWORD and .visa/cert.pem + key.pem); running the simulation");
  return (client = creds ? new VisaClient(creds) : null);
}

/** Tests: inject a client (null = not configured), or undefined to re-read env. Resets the status. */
export function setVisaClientForTests(c: VisaClient | null | undefined) { client = c; state = { live: null }; }

/** For /api/health: the setting, what is configured (booleans only) and the last live outcome. */
export function visaHealth() {
  return { setting: paymentsModeSetting(), configured: Boolean(visaClient()), files: visaConfigSummary(), ...state };
}

/** Short, secret-free error text for health and logs. */
const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 120);

function record(ok: boolean, latencyMs?: number, err?: unknown) {
  state = { live: ok, lastCheckAt: Date.now(), ...(latencyMs !== undefined ? { lastLatencyMs: latencyMs } : {}), ...(ok ? {} : { lastError: short(err) }) };
}

/** GET /vdp/helloworld: does the two-way SSL handshake work? Updates the live flag. Never throws. */
export async function probeVisa(): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string }> {
  const c = visaClient();
  if (!c) return { ok: false, error: "not configured" };
  const t0 = Date.now();
  try {
    const r = await c.helloWorld();
    record(true, r.latencyMs);
    return { ok: true, status: r.status, latencyMs: r.latencyMs };
  } catch (e) {
    record(false, Date.now() - t0, e);
    return { ok: false, status: (e as { status?: number }).status, latencyMs: Date.now() - t0, error: short(e) };
  }
}

/** One real PAV check on the sandbox test card. null when not configured; `unavailable` on any Visa error. */
export async function verifyCard(): Promise<CardVerification | null> {
  const c = visaClient();
  if (!c) return null;
  const at = Date.now();
  try {
    const r = await validateAccount(c);
    record(true, r.latencyMs);
    return { result: r.valid ? "verified" : "not_verified", label: r.valid ? VISA_VERIFIED_LABEL : VISA_NOT_VERIFIED_LABEL, at, latencyMs: r.latencyMs, ...(r.actionCode ? { actionCode: r.actionCode } : {}) };
  } catch (e) {
    console.warn(`[payments] Visa sandbox PAV failed: ${short(e)}`);
    record(false, Date.now() - at, e);
    return { result: "unavailable", label: VISA_UNAVAILABLE_LABEL, at };
  }
}
