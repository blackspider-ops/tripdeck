/**
 * OPT-009: which payment provider runs, chosen explicitly and reported honestly. PAYMENTS_MODE=visa_sandbox with Visa
 * Developer credentials (VISA_USER_ID / VISA_PASSWORD and the two-way SSL PEMs in .visa/, see payments/visa/config.ts)
 * runs the SIM plus a REAL Visa sandbox card check at each seal (visa/provider.ts, mode "visa_sandbox"). Anything short
 * of that logs why and runs the SIM alone, whose `mode` is "sim", so the phones and /api/health label it a simulation.
 */
import type { PaymentProvider } from "./provider.js";
import { SimProvider } from "./sim.js";
import { VisaSandboxProvider } from "./visa/provider.js";
import { visaCredentials } from "./visa/config.js";

export function selectPaymentProvider(requested: "visa_sandbox" | "sim"): PaymentProvider {
  if (requested !== "visa_sandbox") return new SimProvider();
  if (!visaCredentials()) {
    console.warn("[payments] PAYMENTS_MODE=visa_sandbox but the Visa credentials (VISA_USER_ID, VISA_PASSWORD, .visa/cert.pem + key.pem) are not set: running the SIM (mode \"sim\", labelled Simulated).");
    return new SimProvider();
  }
  return new VisaSandboxProvider(new SimProvider());
}
