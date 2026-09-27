/**
 * PAYMENTS_MODE=visa_sandbox provider: the SIM (instructions, holds, all-or-nothing capture — same contract, clearly
 * labelled "Simulated") plus ONE real Visa Developer sandbox call per seal: Payment Account Validation (PAV) of the
 * sandbox test card standing in for the member's agent card (two-way SSL + MLE when configured). A card Visa does not
 * verify — or a sandbox that doesn't answer — declines that seal privately, so the booking voids and nobody is charged.
 */
import type { PaymentProvider } from "../provider.js";
import { verifyCard, type CardVerification } from "./status.js";

export class VisaSandboxProvider implements PaymentProvider {
  readonly mode = "visa_sandbox" as const;
  constructor(readonly sim: PaymentProvider, private verify: () => Promise<CardVerification | null> = verifyCard) {}

  ensureAgentCard(memberId: string) { return this.sim.ensureAgentCard(memberId); }
  createInstruction(p: Parameters<PaymentProvider["createInstruction"]>[0]) { return this.sim.createInstruction(p); }
  authorize(p: Parameters<PaymentProvider["authorize"]>[0]) { return this.sim.authorize(p); }
  capture(p: Parameters<PaymentProvider["capture"]>[0]) { return this.sim.capture(p); }
  void(p: Parameters<PaymentProvider["void"]>[0]) { return this.sim.void(p); }
  refund(p: Parameters<PaymentProvider["refund"]>[0]) { return this.sim.refund(p); }
  resumeInstruction(p: Parameters<NonNullable<PaymentProvider["resumeInstruction"]>>[0]) { return this.sim.resumeInstruction?.(p) ?? Promise.resolve(true); }

  /** R2-WP-11: the SIM's settled records leave memory with their voyage. */
  forget(p: { idempotencyPrefix: string; authRefs: string[]; instructionRefs: string[] }) {
    (this.sim as PaymentProvider & { forget?(q: typeof p): void }).forget?.(p);
  }

  /** REAL: PAV on the Visa sandbox test card. null = no check (not configured). */
  async verifyAccount(_memberId: string): Promise<CardVerification | null> {
    return this.verify();
  }
}
