/**
 * SIM provider (docs/06-payments-spec.md §4.4): same contract as Visa Intelligent Commerce,
 * enforces instruction limits and expiry for real, and is idempotent per key.
 */
import type { PaymentProvider } from "./provider.js";
import { config } from "../config.js";
import { newRef, sleep } from "../util/ids.js";
import { Lru } from "../util/limits.js";

/** The SIM's instruction and authorization references: this many characters. */
const SIM_REF_CHARS = 4;
const ref = () => newRef(SIM_REF_CHARS);
/**
 * R2-WP-11 (S2-011 / O2-042): the SIM's records are bounded. Settled bookings are forgotten when the sweep evicts
 * their voyage (`forget`); the LRU cap is the backstop for anything never evicted. It is far above what the live
 * voyages hold (a few records per seal), so a record still in use is never the least recently used.
 */
export const SIM_MAX_RECORDS = 50_000;
/** A provider call takes this long (ms, uniform), like a card network on a normal day (doc 06 §4.4). */
const SIM_LATENCY_MS: readonly [number, number] = [600, 1200];

export class SimProvider implements PaymentProvider {
  mode = "sim" as const;
  private instructions = new Lru<string, { memberId: string; limitCents: number; expiresAt: number }>(SIM_MAX_RECORDS);
  private auths = new Lru<string, { amountCents: number; state: "held" | "captured" | "voided" | "refunded" }>(SIM_MAX_RECORDS);
  private results = new Lru<string, unknown>(SIM_MAX_RECORDS);
  /** Test hooks. */
  latency: [number, number] = [...SIM_LATENCY_MS];
  declineMember = config.payments.simDeclineMember;
  timeoutMember = config.payments.simTimeoutMember;
  failCaptureFor = "";
  failRefundFor = "";
  calls = { authorize: 0, capture: 0, void: 0, refund: 0 };

  async ensureAgentCard(memberId: string) {
    return { cardRef: `sim_card_${memberId}`, last4: "4242" };
  }

  async createInstruction(p: { memberId: string; limitCents: number; expiresAt: string }) {
    const instructionRef = `sim_ins_${ref()}`;
    this.instructions.set(instructionRef, { memberId: p.memberId, limitCents: p.limitCents, expiresAt: Date.parse(p.expiresAt) });
    return { instructionRef };
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.results.has(key)) return this.results.get(key) as Promise<T>;
    const p = fn();
    this.results.set(key, p);
    return p;
  }

  authorize(p: { memberId: string; instructionRef: string; amountCents: number; idempotencyKey: string }) {
    return this.once(p.idempotencyKey, async () => {
      this.calls.authorize++;
      if (this.timeoutMember && p.memberId === this.timeoutMember) await new Promise(() => undefined);
      await sleep(this.latency[0] + Math.random() * (this.latency[1] - this.latency[0]));
      const ins = this.instructions.get(p.instructionRef);
      if (!ins || Date.now() > ins.expiresAt) return { approved: false as const, reason: "provider_error" as const };
      if ((this.declineMember && p.memberId === this.declineMember) || p.amountCents > ins.limitCents) {
        return { approved: false as const, reason: "over_limit" as const };
      }
      const authRef = `sim_auth_${ref()}`;
      this.auths.set(authRef, { amountCents: p.amountCents, state: "held" });
      return { approved: true as const, authRef };
    });
  }

  capture(p: { authRef: string; idempotencyKey: string }) {
    return this.once(p.idempotencyKey, async () => {
      this.calls.capture++;
      const a = this.auths.get(p.authRef);
      if (!a || a.state !== "held" || (this.failCaptureFor && p.authRef === this.failCaptureFor)) return { ok: false };
      a.state = "captured";
      return { ok: true };
    });
  }

  /** Releases a hold. Like a real network, a void can't undo a capture (SEC-016). */
  void(p: { authRef: string; idempotencyKey: string }) {
    return this.once(p.idempotencyKey, async () => {
      this.calls.void++;
      const a = this.auths.get(p.authRef);
      if (!a || a.state !== "held") return { ok: false, gone: a?.state !== "captured" }; // a capture can't be voided
      a.state = "voided";
      return { ok: true };
    });
  }

  refund(p: { authRef: string; idempotencyKey: string }) {
    return this.once(p.idempotencyKey, async () => {
      this.calls.refund++;
      const a = this.auths.get(p.authRef);
      if (!a || a.state !== "captured" || (this.failRefundFor && p.authRef === this.failRefundFor)) return { ok: false };
      a.state = "refunded";
      return { ok: true };
    });
  }

  /** The SIM forgets instructions when the process restarts; a real provider keeps them. */
  async resumeInstruction(p: { memberId: string; instructionRef: string; limitCents: number; expiresAt: number }) {
    if (p.expiresAt <= Date.now()) return false;
    if (!this.instructions.has(p.instructionRef)) this.instructions.set(p.instructionRef, { memberId: p.memberId, limitCents: p.limitCents, expiresAt: p.expiresAt });
    return true;
  }

  /** R2-WP-11: a settled, evicted booking's records (the orchestrator's `forget`). */
  forget(p: { idempotencyPrefix: string; authRefs: string[]; instructionRefs: string[] }) {
    if (p.idempotencyPrefix) for (const k of [...this.results.keys()]) if (k.startsWith(p.idempotencyPrefix)) this.results.delete(k);
    for (const a of p.authRefs) this.auths.delete(a);
    for (const i of p.instructionRefs) this.instructions.delete(i);
  }

  /** Test hook: how many records the SIM holds (R2-WP-11). */
  sizes() { return { instructions: this.instructions.size, auths: this.auths.size, results: this.results.size }; }

  /** Test hook: when a registered instruction expires. */
  instructionExpiry(instructionRef: string) { return this.instructions.get(instructionRef)?.expiresAt; }

  private count(state: string) { let n = 0; for (const [, a] of this.auths.entries()) if (a.state === state) n++; return n; }
  heldCount() { return this.count("held"); }
  refundedCount() { return this.count("refunded"); }
  capturedCount() { return this.count("captured"); }
}
