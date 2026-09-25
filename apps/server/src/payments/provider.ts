import type { DeclineReason } from "@all-ayes/shared";

/** docs/06-payments-spec.md §4.3 */
export interface PaymentProvider {
  mode: "visa_sandbox" | "sim";
  ensureAgentCard(memberId: string): Promise<{ cardRef: string; last4: string }>;
  /**
   * `approvedWithPasskey`: the helm verified this member's passkey for this booking before asking (TR4-014). It is a
   * flag, never the assertion itself: the single-use token is spent by the seal gate and goes nowhere else.
   */
  createInstruction(p: { memberId: string; cardRef: string; limitCents: number; merchantName: string; expiresAt: string; approvedWithPasskey?: boolean }): Promise<{ instructionRef: string }>;
  authorize(p: { sealId: string; memberId: string; instructionRef: string; amountCents: number; idempotencyKey: string }): Promise<{ approved: true; authRef: string } | { approved: false; reason: DeclineReason }>;
  capture(p: { authRef: string; amountCents: number; idempotencyKey: string }): Promise<{ ok: boolean }>;
  /**
   * Releases an uncaptured hold. It does NOT undo a capture: use refund() for that (SEC-016). `gone`: the provider has
   * no such hold any more (never placed, already released, expired), which counts as released; a plain `ok:false`
   * does not (S2-010).
   */
  void(p: { authRef: string; idempotencyKey: string }): Promise<{ ok: boolean; gone?: boolean }>;
  /** Returns captured money. Used when a group capture fails after some captures went through (all-or-nothing). */
  refund(p: { authRef: string; amountCents: number; idempotencyKey: string }): Promise<{ ok: boolean }>;
  /**
   * Boot (SEC-009): confirm a persisted instruction is still on file with its original limit and expiry. Optional:
   * a real provider keeps instructions itself; the SIM re-registers the record it lost with the process.
   */
  resumeInstruction?(p: { memberId: string; instructionRef: string; limitCents: number; expiresAt: number }): Promise<boolean>;
}

export const MERCHANT = "All Ayes Voyages";
