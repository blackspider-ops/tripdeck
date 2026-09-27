/**
 * Visa Payment Account Validation (PAV) — sandbox. "Is this Visa account real and in good standing?" with a zero-amount
 * account verification (no money moves). Endpoint: POST /pav/v1/cardvalidation (Two-Way SSL; MLE only if the project
 * requires it). Docs: https://developer.visa.com/capabilities/pav
 *
 * Tripdeck never holds a cardholder's card number. In sandbox we validate the documented Visa **test** card
 * (overridable with VISA_PAV_TEST_PAN / VISA_PAV_TEST_EXPIRY), standing in for the card behind an agent token: the
 * verdict is real Visa sandbox output, the card is a Visa test card. The PAN never leaves this module (not logged,
 * not stored, not sent to clients).
 */
import { randomInt } from "node:crypto";
import { env } from "./config.js";
import type { VisaClient } from "./client.js";

/**
 * Visa's PAV sandbox sample card: the "Account Validation Successful" example in the PAV API reference
 * (https://developer.visa.com/capabilities/pav/reference). Your project's Test Data tab may list others.
 */
export const PAV_SANDBOX_TEST_PAN = "4957030420210462";
export const PAV_SANDBOX_TEST_EXPIRY = "2040-10";
export const PAV_SANDBOX_TEST_CVV2 = "022";

export interface PavResult {
  /** true when Visa's actionCode says the account is valid ("00" approved or "85" no reason to decline). */
  valid: boolean;
  actionCode?: string;
  responseCode?: string;
  cvv2ResultCode?: string;
  addressVerificationResults?: string;
  transactionIdentifier?: string;
  latencyMs: number;
  correlationId?: string;
}

const VALID_ACTION_CODES = new Set(["00", "85"]);
const pad = (n: number, len: number) => String(n).padStart(len, "0");

export function pavRequestBody(pan = env("VISA_PAV_TEST_PAN", PAV_SANDBOX_TEST_PAN), expiry = env("VISA_PAV_TEST_EXPIRY", PAV_SANDBOX_TEST_EXPIRY), cvv2 = env("VISA_PAV_TEST_CVV2", pan === PAV_SANDBOX_TEST_PAN ? PAV_SANDBOX_TEST_CVV2 : "")) {
  const stan = pad(randomInt(0, 1_000_000), 6);
  // RRN: 12 chars, conventionally YDDD + HH + STAN (ydddhhnnnnnn)
  const d = new Date();
  const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
  const rrn = `${String(d.getUTCFullYear()).slice(-1)}${pad(doy, 3)}${pad(d.getUTCHours(), 2)}${stan}`;
  return {
    acquirerCountryCode: "840",
    acquiringBin: "408999",
    cardAcceptor: {
      address: { city: "Atlanta", country: "US", state: "GA", zipCode: "30332" },
      idCode: "111111",
      name: "Tripdeck",
      terminalId: "12345678",
    },
    cardExpiryDate: expiry,
    ...(cvv2 ? { cardCvv2Value: cvv2 } : {}),
    // the documented sample's AVS data for its test card
    ...(pan === PAV_SANDBOX_TEST_PAN ? { addressVerificationResults: { street: "801 Metro Center Blv", postalCode: "94404" } } : {}),
    primaryAccountNumber: pan,
    retrievalReferenceNumber: rrn,
    systemsTraceAuditNumber: stan,
  };
}

type PavBody = { actionCode?: string; responseCode?: string; cvv2ResultCode?: string; addressVerificationResults?: string; transactionIdentifier?: string | number };

/** One PAV call on the sandbox test card. Throws VisaError on transport/HTTP failure (caller falls back to the SIM). */
export async function validateAccount(client: VisaClient, opts: { mle?: boolean } = {}): Promise<PavResult> {
  const res = await client.request<PavBody>({ method: "POST", path: "/pav/v1/cardvalidation", body: pavRequestBody(), auth: "mtls", mle: opts.mle ?? client.canMle });
  const b = res.body ?? {};
  const actionCode = b.actionCode === undefined ? undefined : String(b.actionCode);
  return {
    valid: actionCode !== undefined && VALID_ACTION_CODES.has(actionCode),
    ...(actionCode !== undefined ? { actionCode } : {}),
    ...(b.responseCode !== undefined ? { responseCode: String(b.responseCode) } : {}),
    ...(b.cvv2ResultCode !== undefined ? { cvv2ResultCode: String(b.cvv2ResultCode) } : {}),
    ...(b.addressVerificationResults !== undefined ? { addressVerificationResults: String(b.addressVerificationResults) } : {}),
    ...(b.transactionIdentifier !== undefined ? { transactionIdentifier: String(b.transactionIdentifier) } : {}),
    latencyMs: res.latencyMs,
    ...(res.correlationId ? { correlationId: res.correlationId } : {}),
  };
}
