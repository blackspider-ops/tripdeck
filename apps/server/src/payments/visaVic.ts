/**
 * Visa Intelligent Commerce adapter (docs/06-payments-spec.md §2, §4.3) — Mode A/B. A documented stub (OPT-009).
 *
 * TO FILL from github.com/visa/mcp and github.com/visa/vic-reference-agent once sandbox access is granted:
 *   ensureAgentCard   → tokenization / enrollment of a sandbox card for the member's agent
 *   createInstruction → payment instruction (limit, merchant, expiry), approved by the member's passkey
 *   authorize         → credential retrieval for the instruction + gateway auth (Mode A) or simulated hold (Mode B)
 *   capture / void    → gateway capture / void (Mode A) or simulated (Mode B)
 *
 * Until then it returns null and `selectPaymentProvider` (select.ts) runs the SIM, labelled as such (`mode: "sim"`).
 */
import type { PaymentProvider } from "./provider.js";

/** TODO(Visa sandbox): return the real adapter once it is wired. `credentials` are VISA_VIC_API_BASE/_KEY. */
export function createVisaProvider(_credentials: { apiBase: string; apiKey: string }): PaymentProvider | null {
  return null;
}
