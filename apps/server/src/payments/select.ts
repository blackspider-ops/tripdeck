/**
 * OPT-009: which payment provider runs, chosen explicitly and reported honestly. PAYMENTS_MODE=visa_sandbox needs
 * VISA_VIC_API_BASE and VISA_VIC_API_KEY *and* a wired adapter (visaVic.ts is a stub today). Anything short of that
 * logs why and runs the SIM, whose `mode` is "sim", so the phones and /api/health label the demo as a simulation.
 */
import type { PaymentProvider } from "./provider.js";
import { SimProvider } from "./sim.js";
import { createVisaProvider } from "./visaVic.js";
import { config } from "../config.js";

export function selectPaymentProvider(requested: "visa_sandbox" | "sim"): PaymentProvider {
  if (requested !== "visa_sandbox") return new SimProvider();
  const creds = config.payments.visa();
  if (!creds.apiBase || !creds.apiKey) {
    console.warn("[payments] PAYMENTS_MODE=visa_sandbox but VISA_VIC_API_BASE / VISA_VIC_API_KEY are not set: running the SIM (mode \"sim\", labelled Simulation).");
    return new SimProvider();
  }
  const visa = createVisaProvider(creds);
  if (!visa) {
    console.warn("[payments] PAYMENTS_MODE=visa_sandbox: the Visa Intelligent Commerce adapter is not wired yet (payments/visaVic.ts): running the SIM (mode \"sim\", labelled Simulation).");
    return new SimProvider();
  }
  return visa;
}
