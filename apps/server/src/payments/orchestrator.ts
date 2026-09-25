/**
 * All-or-nothing group checkout (docs/06-payments-spec.md §4–5).
 * Invariants (tested): Σ seals == group total · no capture unless every seal is AUTHORIZED ·
 * after VOIDED nothing stays held · idempotent provider calls · new attempt = fresh seals.
 *
 * Public seal statuses (doc 06 §7, SEC-002) never carry an authorization outcome: a seal is PENDING until its
 * member sets it, then "set" (AUTHORIZED on the wire) whatever the card network says, until the booking settles
 * and every seal turns CAPTURED or VOIDED together. Only the owner learns a decline (seal:declinedPrivate).
 *
 * S2-001 (collect, then settle together): a "set" only puts the member's instruction on file. Nothing is authorized
 * while seals are being gathered, standing seals included. When the last seal is set (a lift counts as set), every
 * seal is authorized at once, and the outcome is published at the fixed settle point `settleAt` = last set +
 * `settleMs` (or when the provider is done, if that is later), so neither the order nor the timing of public events
 * depends on whose seal failed. Only the deadline and a call-off end a booking before every seal is set.
 */
import type { BookingPublic, BookingStatus, DeclineReason, SealStatus } from "@all-ayes/shared";
import { SEAL_TIMEOUT_MS, VOID_HEADLINE } from "@all-ayes/shared";
import { MERCHANT, type PaymentProvider } from "./provider.js";
import { newId, newRef, nowIso } from "../util/ids.js";
import { withTimeout } from "../util/timeout.js";
import { config } from "../config.js";

/** Standing instruction lifetime (doc 06 §3): 24 h from when the absent member sealed their terms. */
export const STANDING_TTL_MS = 24 * 3600_000;
/** A live seal's instruction: its limit allows 2 % over the share (rounding, FX), and it lasts 30 minutes. */
const LIVE_LIMIT_HEADROOM = 1.02;
const LIVE_INSTRUCTION_TTL_MS = 30 * 60_000;
/**
 * S2-001: the fixed settle point, after the last seal is set. Long enough for every authorization and the captures
 * or releases on a normal day (SIM: 0.6 to 1.2 s), fixed (no jitter), and scaled by PACE_SCALE (tests run near 0).
 */
export const SEAL_SETTLE_MS = 2_500;
/** A booking reference: `AA-<city>-` plus this many characters. */
const REFERENCE_CHARS = 4;

/**
 * What a seal tap did (WP-09 follow-up): `locked` = that seal can no longer change (already set, or the booking is
 * capturing / settled); `none` = no such booking or seat on it (the helm has already checked both).
 */
export type SealOutcome = "ok" | "locked" | "none";
/**
 * What a call-off did (L4-004): `voided` = this call voided it; `voiding` = already voiding or voided by a call-off or
 * the deadline (idempotent); `settling` = every seal is set, so the outcome is being decided (and is not revealed).
 */
export type CallOffOutcome = "voided" | "voiding" | "settling" | "none";

export const REASONS = {
  /** O2-012: byte-for-byte the phones' and chart room's void headline (Voided.tsx compares against it). */
  declined: VOID_HEADLINE,
  deadline: "Not every seal was set in time, so nobody was charged.",
  calledOff: "The organizer called it off, so nobody was charged.",
  restarted: "The helm restarted mid-seal, so nobody was charged.",
  captureFailedNoCharge: "The card network had a problem, so nobody was charged.",
  refunded: "The card network had a problem logging it. Refunded — nobody ends up paying.",
  refundPending: "The card network had a problem logging it. A refund is being sorted out — nobody ends up paying.",
} as const;

interface SealRec {
  memberId: string; amountCents: number; capCents: number; status: SealStatus;
  idempotencyKey: string; instructionRef?: string; authRef?: string; declineReason?: DeclineReason;
  standing: boolean; updatedAt: string;
  /** Last status sent to the trip room (SEC-002: only public transitions are announced). */
  published?: SealStatus;
  /** Durable intents (TR5-006): written before the provider call, so a restart can re-drive it idempotently. */
  authorizeRequestedAt?: string; capturedAt?: string; releasedAt?: string; refundedAt?: string;
}
export interface BookingRec {
  _id: string; tripId: string; planId: string; cityId: string; attempt: number; status: BookingStatus;
  mode: "visa_sandbox" | "sim"; groupCents: number; reference?: string; seals: SealRec[]; createdAt: string; updatedAt: string;
  /** After this, seals that aren't all set void the booking (SEC-011). */
  sealDeadlineAt?: string;
  /** S2-001: set when the last seal is set; authorizations start then and the outcome is published at this moment. */
  settleAt?: string;
  /** A refund (or release) the provider refused: logged, re-driven on restore and on retry; blocks retry (SEC-016). */
  needsAttention?: boolean;
  /** Bumped on every persist: the write guard never lets an older snapshot replace a newer one (TR5-005). */
  version?: number;
}
export interface StandingInstruction { memberId: string; instructionRef: string; limitCents: number; expiresAt: number }
/** L5-007: what is stored of a standing instruction: its ref and ORIGINAL expiry, never the limit (the member's cap). */
export type StoredStanding = Omit<StandingInstruction, "limitCents">;

interface PaymentEvents {
  sealStatus(b: BookingRec, memberId: string, status: SealStatus): void;
  declinedPrivate(b: BookingRec, memberId: string, reason: DeclineReason): void;
  result(b: BookingRec, status: "CAPTURED" | "VOIDED", publicReason?: string): void;
  persist(b: BookingRec): void;
}

export class PaymentsOrchestrator {
  bookings = new Map<string, BookingRec>();
  standing = new Map<string, StandingInstruction>(); // memberId → standing instruction (absent members)
  /** SEC-011: SEAL_DEADLINE_MS (default 10 min), read when the helm starts; tests shorten it per instance. */
  sealDeadlineMs = config.helm.sealDeadlineMs();
  private deadlines = new Map<string, NodeJS.Timeout>();
  /** Seals whose member tap is being processed (idempotency keys). */
  private setting = new Set<string>();
  /** S2-001: how long after the last "set" the outcome is published; tests set it per instance. */
  settleMs = Math.round(SEAL_SETTLE_MS * Math.max(0, config.paceScale));
  /** Bookings whose outcome is decided (or being decided) but not yet published: the trip room still sees "set". */
  private held = new Set<string>();
  private settling = new Map<string, Promise<void>>();

  constructor(private provider: PaymentProvider, private events: PaymentEvents) {}

  get mode() { return this.provider.mode; }

  async cardLast4(memberId: string) { return (await this.provider.ensureAgentCard(memberId)).last4; }

  /**
   * Absent member's advance permission: limit = their cap, 24 h from when they sealed (doc 06 §3, §6).
   * The caller persists the returned instruction (SEC-009) and restores it with restoreStanding(), never re-issues it.
   */
  async createStanding(memberId: string, capCents: number, expiresAt = Date.now() + STANDING_TTL_MS): Promise<StandingInstruction | null> {
    if (expiresAt <= Date.now()) { this.standing.delete(memberId); return null; }
    const card = await this.provider.ensureAgentCard(memberId);
    const { instructionRef } = await this.provider.createInstruction({
      memberId, cardRef: card.cardRef, limitCents: capCents, merchantName: MERCHANT, expiresAt: new Date(expiresAt).toISOString(),
    });
    const ins = { memberId, instructionRef, limitCents: capCents, expiresAt };
    this.standing.set(memberId, ins);
    return ins;
  }

  /**
   * Boot: bring back a persisted standing instruction with its ORIGINAL expiry (SEC-009). An expired one is dropped
   * (that member seals live). Returns whether it is live.
   */
  async restoreStanding(ins: StandingInstruction): Promise<boolean> {
    if (!(ins.expiresAt > Date.now())) { this.standing.delete(ins.memberId); return false; }
    if (this.provider.resumeInstruction && !(await this.provider.resumeInstruction(ins))) { this.standing.delete(ins.memberId); return false; }
    this.standing.set(ins.memberId, { ...ins });
    return true;
  }

  /**
   * Records the booking. Standing seals start right away unless `deferStanding` is set; the helm defers them and
   * calls startStanding() after it has announced the booking, so no seal:status precedes booking:created (TR1-015).
   */
  create(p: { tripId: string; planId: string; cityId: string; attempt: number; shares: { memberId: string; amountCents: number; capCents: number }[] }, opts: { deferStanding?: boolean } = {}): BookingRec {
    const _id = newId();
    const now = nowIso();
    const b: BookingRec = {
      _id, tripId: p.tripId, planId: p.planId, cityId: p.cityId, attempt: p.attempt, status: "PENDING", mode: this.provider.mode,
      groupCents: p.shares.reduce((s, x) => s + x.amountCents, 0),
      seals: p.shares.map((s) => ({
        memberId: s.memberId, amountCents: s.amountCents, capCents: s.capCents, status: "PENDING", published: "PENDING",
        idempotencyKey: `${_id}:${s.memberId}`, standing: this.liveStanding(s.memberId), updatedAt: now,
      })),
      sealDeadlineAt: new Date(Date.now() + this.sealDeadlineMs).toISOString(),
      createdAt: now, updatedAt: now,
    };
    this.bookings.set(_id, b);
    this.persistSoon(b);
    this.armDeadline(b);
    if (!opts.deferStanding) this.startStanding(b._id);
    return b;
  }

  /**
   * Absent members with a live standing instruction are set at once (doc 06 §4.2). S2-001: set, not authorized: their
   * authorization runs with everyone else's at the settle point, so a standing seal never answers first.
   */
  startStanding(bookingId: string) {
    const b = this.bookings.get(bookingId);
    if (!b) return;
    for (const s of b.seals) {
      const ins = this.standing.get(s.memberId);
      if (s.standing && ins) this.markSet(b, s, ins.instructionRef);
    }
    this.maybeSettle(b);
  }

  /** Test hook: resolves once a booking that started settling has published its outcome. */
  whenSettled(bookingId: string) { return this.settling.get(bookingId) ?? Promise.resolve(); }

  /**
   * R2-WP-11 (O2-035 / L4-010 / S2-011): the sweep evicted this voyage, so its settled bookings leave memory (they are
   * in MongoDB; `hydrate` brings them back with the voyage), with their deadline timers and the provider's records of
   * them. A booking that is not final, is being settled, needs attention, or still owes a release or a refund
   * (`unsettled`) is kept: its money must be re-driven, never forgotten. Returns the ids kept.
   */
  forget(tripId: string): string[] {
    const kept: string[] = [];
    for (const b of [...this.bookings.values()]) {
      if (b.tripId !== tripId) continue;
      if (!isFinal(b.status) || b.needsAttention || this.unsettled(b) || this.held.has(b._id) || this.settling.has(b._id)) { kept.push(b._id); continue; }
      this.bookings.delete(b._id);
      clearTimeout(this.deadlines.get(b._id)); this.deadlines.delete(b._id);
      for (const s of b.seals) this.setting.delete(s.idempotencyKey);
      (this.provider as ForgetfulProvider).forget?.({
        idempotencyPrefix: `${b._id}:`,
        authRefs: b.seals.flatMap((s) => (s.authRef ? [s.authRef] : [])),
        instructionRefs: b.seals.flatMap((s) => (s.instructionRef && !this.standingRef(s.instructionRef) ? [s.instructionRef] : [])),
      });
    }
    return kept;
  }
  /** A standing instruction still in use (an absent member's, for a later attempt) is not the provider's to forget. */
  private standingRef(ref: string) { for (const ins of this.standing.values()) if (ins.instructionRef === ref) return true; return false; }

  /** Seals are still being gathered: the booking can still be voided by the deadline, a call-off, or change. */
  private gathering(b: BookingRec) { return (b.status === "PENDING" || b.status === "AUTHORIZING") && !b.settleAt; }

  /** An expired standing instruction is not used: that member seals live instead (doc 06 §9). */
  private liveStanding(memberId: string) {
    const ins = this.standing.get(memberId);
    return Boolean(ins && ins.expiresAt > Date.now());
  }

  /** SEC-011: seals that aren't all set by the deadline void the booking (unless captures are already under way). */
  private armDeadline(b: BookingRec) {
    const at = b.sealDeadlineAt ? Date.parse(b.sealDeadlineAt) : NaN;
    if (!Number.isFinite(at)) return;
    const timer = setTimeout(() => {
      this.deadlines.delete(b._id);
      if (this.gathering(b)) void this.voidAll(b, REASONS.deadline).catch((e) => console.warn("[payments] deadline void failed", e));
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.deadlines.set(b._id, timer);
  }

  /**
   * Organizer "call it off" (SEC-011): voids the attempt while seals are still being gathered. Once every seal is set
   * the booking is settling and the answer is `settling` whatever the outcome will be (S2-001); a booking already
   * voiding or voided by a call-off or the deadline answers `voiding` (L4-004), never "captures under way".
   */
  async callOff(bookingId: string): Promise<CallOffOutcome> {
    const b = this.bookings.get(bookingId);
    if (!b) return "none";
    if (this.gathering(b)) { await this.voidAll(b, REASONS.calledOff); return "voided"; }
    if (this.held.has(b._id) || (b.settleAt && !isFinal(b.status))) return "settling";
    if (b.status === "ANY_DECLINED" || b.status === "VOIDED") return "voiding";
    return "settling"; // ALL_AUTHORIZED (re-driven captures after a restart) or CAPTURED
  }

  /**
   * Restart recovery (TR5-006). Every step is idempotent, so running it again after another crash is safe:
   *  - non-final, not yet all authorized (in-flight auths died with the old process): void it, release every hold
   *    that has an authRef whatever its recorded status, and ask the provider (same idempotency key) about
   *    authorizations that were requested but never answered, releasing any late hold;
   *  - ALL_AUTHORIZED (crashed mid-capture): re-drive the captures with the same keys: they either complete the
   *    booking or fall into the refund path;
   *  - final: re-drive any release or refund that didn't finish.
   * The outcome is published at once (finish(): a restored booking is never held, so a past or future `settleAt`
   * isn't waited for). L5-006: when the re-driven captures all fail without charging anyone (e.g. the SIM forgot its
   * holds with the old process), the crew hears `publicReason` (the restart), not a card-network problem.
   */
  async recover(b: BookingRec, publicReason: string = REASONS.restarted) {
    if (isFinal(b.status)) return this.redrive(b);
    for (const s of b.seals) {
      if (s.status === "AUTHORIZING" && s.authorizeRequestedAt && !s.authRef && s.instructionRef) void this.settleOrphanAuth(b, s);
    }
    if (b.status === "ALL_AUTHORIZED") return this.captureAll(b, publicReason);
    if (b.status === "ANY_DECLINED") b.status = "AUTHORIZING";
    await this.voidAll(b, publicReason);
  }

  /** Re-drives unfinished releases/refunds of a final booking; clears needsAttention when they all went through. */
  async redrive(b: BookingRec) {
    if (!isFinal(b.status)) return;
    const results = await Promise.all(b.seals.map((s) => (b.status === "VOIDED" && s.capturedAt ? this.refund(b, s) : b.status === "VOIDED" ? this.release(b, s) : true)));
    const ok = results.every(Boolean);
    if (ok !== !b.needsAttention) { b.needsAttention = !ok; this.persistSoon(b); }
    return ok;
  }

  /** Money was captured and not yet refunded: the voyage can't retry until that is settled (SEC-016). */
  owesRefund(b: BookingRec) { return b.seals.some((s) => s.capturedAt && !s.refundedAt) && b.status !== "CAPTURED"; }

  /** S2-010: a voided booking still has a hold the provider never confirmed released. */
  holdsOutstanding(b: BookingRec) { return b.status === "VOIDED" && b.seals.some((s) => s.authRef && !s.releasedAt && !s.capturedAt); }

  /** A refund still owed or a hold still outstanding: nobody is asked to pay again until it clears (SEC-016, S2-010). */
  unsettled(b: BookingRec) { return this.owesRefund(b) || this.holdsOutstanding(b); }

  /**
   * L4-001: every booking of this voyage (not only its current one) that is still unsettled. Each is re-driven in the
   * background, so a caller that refuses with NEEDS_ATTENTION also kicks the fix.
   */
  unsettledFor(tripId: string): BookingRec[] {
    const out = [...this.bookings.values()].filter((b) => b.tripId === tripId && this.unsettled(b));
    for (const b of out) void this.redrive(b).catch((e) => console.warn(`[payments] re-drive of ${b._id} failed`, e));
    return out;
  }

  private async settleOrphanAuth(b: BookingRec, s: SealRec) {
    try {
      const res = await withTimeout(
        this.provider.authorize({ sealId: s.idempotencyKey, memberId: s.memberId, instructionRef: s.instructionRef!, amountCents: s.amountCents, idempotencyKey: `${s.idempotencyKey}:auth` }),
        SEAL_TIMEOUT_MS, () => null,
      );
      if (res?.approved) { s.authRef = res.authRef; this.persistSoon(b); await this.release(b, s); }
    } catch (e) {
      console.warn(`[payments] orphan authorization on ${s.idempotencyKey} could not be settled`, (e as Error).message);
    }
  }

  toPublic(b: BookingRec): BookingPublic {
    const held = this.held.has(b._id);
    return {
      bookingId: b._id, planId: b.planId, attempt: b.attempt, status: publicBookingStatus(b, held), mode: b.mode,
      reference: held ? undefined : b.reference,
      seals: b.seals.map((s) => ({ memberId: s.memberId, status: publicSealOf(b, s, held), standing: s.standing })),
      // WP-04 follow-up: the phones can count down to the seal deadline (only while seals can still be set)
      sealDeadlineAt: this.gathering(b) ? b.sealDeadlineAt : undefined,
    };
  }

  /**
   * Member taps "Set your seal". The caller has run the passkey gate; `approvedWithPasskey` says it verified one
   * (TR4-014: a flag, never the spent token). A seal that isn't PENDING any more is `locked` (the helm refuses it
   * with SEAL_LOCKED instead of a silent no-op).
   */
  async setSeal(bookingId: string, memberId: string, opts: { approvedWithPasskey?: boolean } = {}): Promise<SealOutcome> {
    const b = this.bookings.get(bookingId);
    const s = b?.seals.find((x) => x.memberId === memberId);
    if (!b || !s) return "none";
    // a second tap while the first is still asking the provider is the same seal: locked, not a second instruction
    if (s.status !== "PENDING" || !this.gathering(b) || this.setting.has(s.idempotencyKey)) return "locked";
    this.setting.add(s.idempotencyKey);
    try {
      const card = await this.provider.ensureAgentCard(memberId);
      const limitCents = Math.min(s.capCents, Math.ceil(s.amountCents * LIVE_LIMIT_HEADROOM));
      const expiresAt = Date.now() + LIVE_INSTRUCTION_TTL_MS;
      const { instructionRef } = await this.provider.createInstruction({
        memberId, cardRef: card.cardRef, limitCents, merchantName: MERCHANT, expiresAt: new Date(expiresAt).toISOString(),
        ...(opts.approvedWithPasskey ? { approvedWithPasskey: true } : {}),
      });
      // S2-001: the instruction is on file, so the seal is "set"; it is authorized with every other one at the settle point
      if (this.markSet(b, s, instructionRef)) this.maybeSettle(b);
      return "ok";
    } finally {
      this.setting.delete(s.idempotencyKey);
    }
  }

  /**
   * Lifting a seal (S2-001) declines it privately and, publicly, counts as that seal being "set": nothing is voided
   * mid-gathering, so the lift can't be told from a decline or pinned on anyone. The booking then settles like any
   * other once every seal is set (it voids, having authorized nobody). Once settling has begun the seal is `locked`;
   * a booking already voided by a call-off or the deadline changes nothing (`ok`).
   */
  cancelSeal(bookingId: string, memberId: string): SealOutcome {
    const b = this.bookings.get(bookingId);
    const s = b?.seals.find((x) => x.memberId === memberId);
    if (!b || !s) return "none";
    if (this.gathering(b)) {
      if (s.status === "PENDING" || s.status === "AUTHORIZING") {
        s.declineReason = "user_cancelled";
        if (b.status === "PENDING") this.setBooking(b, "AUTHORIZING");
        this.setSealStatus(b, s, "DECLINED"); // publicly "set", like any other seal
        this.events.declinedPrivate(b, s.memberId, "user_cancelled");
        this.maybeSettle(b);
      }
      return "ok";
    }
    if (this.held.has(b._id) || b.status === "ALL_AUTHORIZED" || b.status === "CAPTURED" || (b.settleAt && !isFinal(b.status))) return "locked";
    return "ok";
  }

  /** A seal is "set" (public AUTHORIZED): its instruction is on file. False when it can't be set any more. */
  private markSet(b: BookingRec, s: SealRec, instructionRef: string) {
    if (s.status !== "PENDING" || !this.gathering(b)) return false;
    s.instructionRef = instructionRef;
    if (b.status === "PENDING") this.setBooking(b, "AUTHORIZING"); // one write with the seal's (persistSoon)
    this.setSealStatus(b, s, "AUTHORIZING"); // public: "set" (no outcome); internally: waiting for the settle point
    return true;
  }

  /** S2-001: when the last seal is set, the settle point is fixed and every seal is authorized together. */
  private maybeSettle(b: BookingRec) {
    if (!this.gathering(b) || b.seals.some((s) => s.status === "PENDING")) return;
    b.settleAt = new Date(Date.now() + this.settleMs).toISOString();
    this.held.add(b._id);
    clearTimeout(this.deadlines.get(b._id)); this.deadlines.delete(b._id); // every seal is set: the deadline is met
    const p = this.settle(b) // persists the settle point with the intents, before any provider call
      .catch((e) => console.warn(`[payments] settling ${b._id} failed`, e))
      .finally(() => { this.settling.delete(b._id); this.held.delete(b._id); });
    this.settling.set(b._id, p);
  }

  /**
   * Authorizes every seal at once (none if one was already lifted, so no hold is placed for a booking that can't
   * complete), waits for every answer, then captures all or voids all. The outcome is published at the settle point.
   */
  private async settle(b: BookingRec) {
    // the durable intents (TR5-006), every seal's at once and with the settle point: one write (O2-038)
    const toAuthorize = b.seals.some((s) => s.status === "DECLINED") ? [] : b.seals.filter((s) => s.status === "AUTHORIZING" && s.instructionRef);
    const at = nowIso();
    for (const s of toAuthorize) s.authorizeRequestedAt = at;
    this.persistSoon(b);
    await Promise.all(toAuthorize.map((s) => this.authorizeSeal(b, s)));
    if (b.status !== "AUTHORIZING") return; // a restart recovery or another path already settled it
    if (b.seals.every((s) => s.status === "AUTHORIZED")) {
      this.setBooking(b, "ALL_AUTHORIZED");
      await this.captureAll(b);
    } else {
      await this.voidAll(b, REASONS.declined);
    }
  }

  private async authorizeSeal(b: BookingRec, s: SealRec) {
    if (s.status !== "AUTHORIZING" || !s.instructionRef) return;
    const ins = { instructionRef: s.instructionRef };

    const auth = this.provider.authorize({ sealId: s.idempotencyKey, memberId: s.memberId, instructionRef: ins.instructionRef, amountCents: s.amountCents, idempotencyKey: `${s.idempotencyKey}:auth` });
    let res: Awaited<ReturnType<PaymentProvider["authorize"]>>;
    try {
      res = await withTimeout(auth, SEAL_TIMEOUT_MS, () => ({ approved: false as const, reason: "timeout" as DeclineReason }));
    } catch {
      res = { approved: false, reason: "provider_error" };
    }
    if (!res.approved && res.reason === "timeout") {
      // the network may still approve after we gave up: release that late hold (doc 06 §5.3.3)
      auth.then(async (late) => { if (late.approved) { s.authRef ??= late.authRef; await this.release(b, s); } }).catch(() => undefined);
    }

    const after = b.status as BookingStatus; // it may have moved on while we awaited the network
    if (isFinal(after) || after === "ANY_DECLINED") {
      // booking already failed while we were authorizing (voidAll marked this seal VOIDED) → release this hold now
      if (res.approved) { s.authRef = res.authRef; this.persistSoon(b); await this.release(b, s); }
      return;
    }
    if (!res.approved) {
      // Not announced (publicly it stays "set"): the owner learns it privately when the outcome is published
      // O2-038: not written on its own: once every answer is in, voidAll persists it (ANY_DECLINED) before any void
      s.declineReason = res.reason;
      s.status = "DECLINED";
      s.updatedAt = nowIso();
      return;
    }
    s.authRef = res.authRef;
    // no public change (it is already "set"), so no write of its own (O2-038): ALL_AUTHORIZED or ANY_DECLINED follows
    // once every answer is in; a restart before that asks again with the same key and releases (recover)
    this.setSealStatus(b, s, "AUTHORIZED");
  }

  /**
   * Releases a seal's hold (idempotent). Released = the provider voided it, or says the hold doesn't exist any more
   * (`gone`). A thrown call or a plain refusal (S2-010) stays outstanding for a later re-drive: needs_attention.
   */
  private async release(b: BookingRec, s: SealRec) {
    if (!s.authRef || s.releasedAt || s.capturedAt) return true;
    try {
      const r = await this.provider.void({ authRef: s.authRef, idempotencyKey: `${s.idempotencyKey}:void` });
      if (r.ok || r.gone) {
        s.releasedAt = nowIso();
        this.persistSoon(b);
        return true;
      }
      console.warn(`[payments] needs_attention: the provider refused to release ${s.authRef}`);
    } catch (e) {
      console.warn(`[payments] needs_attention: void failed for ${s.authRef}`, (e as Error).message);
    }
    return false;
  }

  /** Refunds a captured seal (SEC-016): a void does not undo a capture. False = still owed (needs_attention). */
  private async refund(b: BookingRec, s: SealRec) {
    if (!s.capturedAt || s.refundedAt) return true;
    try {
      const r = await this.provider.refund({ authRef: s.authRef!, amountCents: s.amountCents, idempotencyKey: `${s.idempotencyKey}:refund` });
      if (r.ok) { s.refundedAt = nowIso(); this.persistSoon(b); return true; }
    } catch (e) {
      console.warn(`[payments] refund call failed for ${s.authRef}`, (e as Error).message);
    }
    console.warn(`[payments] needs_attention: refund outstanding for ${s.authRef} on booking ${b._id}`);
    return false;
  }

  private async voidAll(b: BookingRec, publicReason: string) {
    if (b.status === "ANY_DECLINED" || isFinal(b.status)) return;
    // Every seal is voided in one step, in-flight (AUTHORIZING) ones included: their late approvals are released
    // by startSeal. The decliner keeps DECLINED internally (for their private replay) but is announced like the rest.
    for (const s of b.seals) if (s.status !== "DECLINED" && s.status !== "CAPTURED") { s.status = "VOIDED"; s.updatedAt = nowIso(); }
    this.setBooking(b, "ANY_DECLINED"); // persisted: every hold with an authRef and no releasedAt is owed a void (TR5-006)
    // Every hold is released, including the decliner's own (a member may lift a seal that was already AUTHORIZED).
    const released = await Promise.all(b.seals.map((s) => this.release(b, s)));
    if (!released.every(Boolean)) b.needsAttention = true;
    await this.finish(b, "VOIDED", publicReason);
  }

  /**
   * Settles the booking internally (persisted), then publishes it: at the settle point when one is set (S2-001),
   * with the owners' private decline reasons, every seal in seat order, and a single booking:result.
   */
  private async finish(b: BookingRec, status: "CAPTURED" | "VOIDED", publicReason?: string) {
    this.setBooking(b, status);
    const wait = b.settleAt && this.held.has(b._id) ? Date.parse(b.settleAt) - Date.now() : 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    for (const s of b.seals) {
      if (s.status === "DECLINED" && s.declineReason && s.declineReason !== "user_cancelled") this.events.declinedPrivate(b, s.memberId, s.declineReason);
    }
    this.held.delete(b._id);
    this.announce(b);
    this.events.result(b, status, publicReason);
  }

  private async captureAll(b: BookingRec, noChargeReason: string = REASONS.captureFailedNoCharge) {
    const results = await Promise.all(b.seals.map((s) =>
      (s.capturedAt ? Promise.resolve({ ok: true }) : this.provider.capture({ authRef: s.authRef!, amountCents: s.amountCents, idempotencyKey: `${s.idempotencyKey}:capture` }))
        .then((r) => {
          if (r.ok && !s.capturedAt) { s.capturedAt = nowIso(); this.persistSoon(b); } // durable before any refund decision
          return { s, ok: r.ok };
        }, () => ({ s, ok: false }))));
    if (isFinal(b.status)) return;
    if (results.every((r) => r.ok)) {
      for (const { s } of results) s.status = "CAPTURED";
      b.reference = `AA-${b.cityId}-${newRef(REFERENCE_CHARS)}`;
      await this.finish(b, "CAPTURED");
      return;
    }
    // rare: a capture failed → refund the captured seals (a void can't undo a capture) and release the rest
    console.warn(`[payments] needs_attention: capture failed on booking ${b._id}`);
    for (const { s } of results) { s.status = "VOIDED"; s.updatedAt = nowIso(); }
    this.setBooking(b, "ANY_DECLINED");
    const settled = await Promise.all(results.map(({ s, ok }) => (ok ? this.refund(b, s) : this.release(b, s))));
    const refunded = results.some((r) => r.ok);
    b.needsAttention = !settled.every(Boolean) || undefined;
    await this.finish(b, "VOIDED", !refunded ? noChargeReason : b.needsAttention ? REASONS.refundPending : REASONS.refunded);
  }

  /**
   * Sends every seal whose public status changed, in seat order (never decliner-first). O2-038: written only when one
   * did (`published` changed).
   */
  private announce(b: BookingRec) {
    const held = this.held.has(b._id);
    let changed = false;
    for (const s of b.seals) {
      const pub = publicSealOf(b, s, held);
      if (pub === s.published) continue;
      s.published = pub;
      changed = true;
      this.events.sealStatus(b, s.memberId, pub);
    }
    if (changed) this.persistSoon(b);
  }

  /** A seal's status: announced (and written) when its public status changed; the lift of a seal is always written. */
  private setSealStatus(b: BookingRec, s: SealRec, status: SealStatus) {
    s.status = status;
    s.updatedAt = nowIso();
    this.announce(b);
    if (status === "DECLINED") this.persistSoon(b);
  }

  /**
   * O2-038: the booking's writes within one synchronous step (a seal set with the booking's status, the settle point
   * with every authorization intent, a status with its announcement) go out as one persist, at the end of that step:
   * before any provider answer can come back, so an intent is still queued ahead of the call's outcome (TR5-006).
   */
  private pendingPersist = new Set<BookingRec>();
  private persistSoon(b: BookingRec) {
    if (!this.pendingPersist.size) queueMicrotask(() => this.flushPersists());
    this.pendingPersist.add(b);
  }
  private flushPersists() {
    const list = [...this.pendingPersist];
    this.pendingPersist.clear();
    for (const b of list) this.events.persist(b);
  }

  private setBooking(b: BookingRec, status: BookingStatus) {
    b.status = status;
    b.updatedAt = nowIso();
    if (isFinal(status)) { clearTimeout(this.deadlines.get(b._id)); this.deadlines.delete(b._id); }
    this.persistSoon(b);
  }
}

const isFinal = (s: BookingStatus) => s === "CAPTURED" || s === "VOIDED";

/**
 * R2-WP-11: a provider that keeps per-booking records in memory (the SIM) may drop them once the booking is settled
 * and evicted. Optional, and outside the PaymentProvider contract: a real provider keeps its own records.
 */
type ForgetfulProvider = PaymentProvider & { forget?(p: { idempotencyPrefix: string; authRefs: string[]; instructionRefs: string[] }): void };

/**
 * What the trip room may see of one seal (SEC-002, doc 06 §7): PENDING until set, then AUTHORIZED ("set") with no
 * authorization outcome, until the booking's outcome is published and every seal turns CAPTURED or VOIDED together.
 * While `held` (S2-001: settling, outcome not yet published) every seal simply reads "set".
 */
function publicSealOf(b: BookingRec, s: SealRec, held: boolean): SealStatus {
  if (!held && b.status === "CAPTURED") return "CAPTURED";
  if (!held && (b.status === "VOIDED" || b.status === "ANY_DECLINED")) return "VOIDED";
  return s.status === "PENDING" ? "PENDING" : "AUTHORIZED";
}

/**
 * ANY_DECLINED is momentary and would only say "someone declined"; publicly the booking is simply voiding. While
 * held (settling) it reads AUTHORIZING whatever was decided (S2-001).
 */
const publicBookingStatus = (b: BookingRec, held: boolean): BookingStatus => (held ? "AUTHORIZING" : b.status === "ANY_DECLINED" ? "VOIDED" : b.status);

/** Events already carry public statuses; a DECLINED never reaches the trip room. */
export const publicSealStatus = (s: SealStatus): SealStatus => (s === "DECLINED" ? "VOIDED" : s);
