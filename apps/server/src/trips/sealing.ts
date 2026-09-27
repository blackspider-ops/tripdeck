/**
 * Sealing (OPT-031): the pick, each member's seal, calling it off, going back to the charts, the booking's outcome
 * and the memory notes it leaves.
 */
import type { S2CPayload } from "@all-ayes/shared";
import { rememberAll } from "../memory/memory.js";
import { budgetBand } from "../memory/bands.js";
import { REASONS, type BookingRec } from "../payments/orchestrator.js";
import { consumeAssertion, hasPasskey } from "../passkeys/passkeys.js";
import { cityName } from "../data/loader.js";
import { HelmError } from "../util/errors.js";
import { persist } from "../store/db.js";
import { CARD_LAST4_UNKNOWN, REASON_CHARTS_CHANGED, type Actor, type TripRec } from "./records.js";
import type { Helm } from "./core.js";

/** L4-001 / S2-010: nobody is asked to pay again while an earlier attempt still owes a refund or a release. */
const UNSETTLED_MESSAGE = "A refund or release from an earlier attempt is still being sorted out. Try again in a moment.";

export class Sealing {
  constructor(private helm: Helm) {}

  async pick(tripId: string, actor: Actor, planId: string) {
    const { helm } = this;
    const t = helm.organizerTrip(tripId, actor);
    if (t.status !== "DRY_RUN" || !t.shortlistIds?.includes(planId)) throw new HelmError("BAD_PHASE", "Pick one of the two charts.");
    const plan = helm.table.planOf(t, planId);
    if (!plan) throw new HelmError("BAD_PHASE", "That chart is no longer on the table."); // TR5-022
    // TR4-016: everything that can throw happens before the trip changes; after the booking exists, pick succeeds
    const shares = plan.members.map((m) => {
      const brief = helm.briefs.get(m.memberId);
      if (!brief) throw new HelmError("BRIEFS_PENDING", "Someone's sealed terms are missing.");
      return { memberId: m.memberId, amountCents: m.amountCents, capCents: brief.capCents };
    });
    // L4-001: the single money choke point. Every booking of the voyage counts, not only its current one (a new
    // table after a void replaces t.bookingId); the re-drive is kicked by unsettledFor
    if (helm.payments.unsettledFor(tripId).length) throw new HelmError("NEEDS_ATTENTION", UNSETTLED_MESSAGE);
    helm.dryrun.cancelAutoPick(t);
    t.chosenPlanId = planId;
    t.attempt += 1;
    const booking = helm.payments.create({ tripId, planId, cityId: plan.cityId, attempt: t.attempt, shares }, { deferStanding: true });
    t.bookingId = booking._id;
    helm.transition(t, "SEALING", { from: ["DRY_RUN"] });
    helm.save(t);
    helm.toTrip(tripId, "booking:created", { ...helm.payments.toPublic(booking), serverNow: Date.now() });
    // standing seals start only now, so their seal:status never precedes booking:created (TR1-015)
    helm.payments.startStanding(booking._id);
    // one member's provider hiccup must not keep the others' seal screens back, nor fail the pick (TR4-016)
    await Promise.allSettled(plan.members.map(async (m) => {
      const p = await this.sealPrivateFor(t, m.memberId);
      if (p) helm.toMember(t._id, m.memberId, "seal:private", p);
    }));
    helm.broadcastState(t);
  }

  /**
   * OPT-018: the one builder of a member's `seal:private` (live after the pick, and on replay): their share of the
   * chosen plan for the voyage's current booking, or null when there is none.
   */
  async sealPrivateFor(t: TripRec, memberId: string): Promise<S2CPayload<"seal:private"> | null> {
    const b = this.currentBooking(t);
    const v = this.helm.table.planOf(t, t.chosenPlanId)?.members.find((x) => x.memberId === memberId);
    if (!b || !v) return null;
    const cardLast4 = await this.helm.payments.cardLast4(memberId).catch((e) => {
      console.warn(`[helm] agent card for ${memberId} unavailable`, (e as Error).message);
      return CARD_LAST4_UNKNOWN;
    });
    return { bookingId: b._id, amountCents: v.amountCents, lines: v.lines, fits: v.fits, cardLast4, mode: this.helm.payments.mode };
  }

  /** The voyage's booking attempt, whatever its phase. */
  currentBooking(t: TripRec): BookingRec | undefined {
    return t.bookingId ? this.helm.payments.bookings.get(t.bookingId) : undefined;
  }

  async setSeal(tripId: string, memberId: string, bookingId: string, assertionToken?: string, pin?: string) {
    const { helm } = this;
    const { t, m } = helm.memberTrip(tripId, memberId);
    if (t.status !== "SEALING" || t.bookingId !== bookingId) throw new HelmError("BAD_PHASE", "Nothing to seal right now.");
    // Members who registered a passkey (on any relying party) must approve with it; members with none fall back to
    // the confirm tap (PRD E2). The single-use token is bound to this member and this booking, and carries the rpID
    // it was minted for, so the gate agrees with the phone's status check.
    // Quest-first: a member with a seal PIN (a headset that can't hold a passkey) approves with the PIN instead; a
    // passkey still works where they have one (their phone's Face ID). Wrong PINs are counted (identity.ts).
    const needsPasskey = hasPasskey(memberId);
    const hasPin = Boolean(m.sealPin);
    const viaPasskey = needsPasskey && assertionToken ? Boolean(consumeAssertion(memberId, bookingId, assertionToken)) : false;
    if ((needsPasskey || hasPin) && !viaPasskey) {
      if (hasPin && pin !== undefined) helm.identity.headsets.checkSealPin(m, pin);
      else if (needsPasskey) throw new HelmError("PASSKEY_REQUIRED", "Approve with your passkey to set your seal.");
      else throw new HelmError("PIN_REQUIRED", "Enter your seal PIN to set your seal.");
    }
    // TR4-014: the spent token isn't a WebAuthn assertion, so only the fact that one was verified reaches the provider
    const outcome = await helm.payments.setSeal(bookingId, memberId, { approvedWithPasskey: viaPasskey });
    if (outcome === "locked") throw new HelmError("SEAL_LOCKED", "Your seal can't change now.");
  }

  cancelSeal(tripId: string, memberId: string, bookingId: string) {
    const { helm } = this;
    const { t } = helm.memberTrip(tripId, memberId);
    if (t.status !== "SEALING" || t.bookingId !== bookingId) throw new HelmError("BAD_PHASE", "Nothing to lift right now.");
    // WP-09 follow-up: once every seal is set the booking is settling; lifting one is refused, not ignored
    if (helm.payments.cancelSeal(bookingId, memberId) === "locked") {
      throw new HelmError("SEAL_LOCKED", "Every seal is set; the booking is settling.");
    }
  }

  /**
   * SEC-011: the organizer (phone or paired headset) calls off a booking that is still gathering seals: every hold is
   * released and the voyage goes VOIDED, so they can go back to the charts. Refused once captures are under way.
   */
  async callOff(tripId: string, actor: Actor, bookingId?: string) {
    const { helm } = this;
    const t = helm.organizerTrip(tripId, actor);
    if (t.status !== "SEALING" || !t.bookingId || (bookingId !== undefined && bookingId !== t.bookingId)) {
      throw new HelmError("BAD_PHASE", "Nothing to call off right now.");
    }
    // L4-004: a second call-off (or one during a deadline void) is the same call-off, not "captures under way"; once
    // every seal is set the booking is settling, whatever its outcome will be (S2-001)
    const outcome = await helm.payments.callOff(t.bookingId);
    if (outcome === "none") throw new HelmError("BAD_PHASE", "Nothing to call off right now.");
    if (outcome === "settling") throw new HelmError("CAPTURING", "Every seal is set; the booking is settling.");
  }

  /** "Back to the charts" after a void: the same Two Charts, fresh votes and clock. */
  retry(tripId: string, actor: Actor) {
    const { helm } = this;
    const t = helm.organizerTrip(tripId, actor, { phases: ["VOIDED"], phaseMessage: "Only after a voided booking." });
    // SEC-016 / S2-010: a refund still owed, or a hold never confirmed released, on any attempt of this voyage must
    // be settled before anyone is asked to pay again (unsettledFor kicks the re-drive)
    if (helm.payments.unsettledFor(tripId).length) throw new HelmError("NEEDS_ATTENTION", UNSETTLED_MESSAGE);
    // L4-007: the Two Charts must still resolve before the voyage commits to DRY_RUN; if not, back to BRIEFING
    if (helm.table.shortlist(t).length !== 2) {
      helm.table.backToBriefing(t, ["VOIDED"], REASON_CHARTS_CHANGED, "charts missing on retry");
      // L3-006 (R2-WP-13): a new round, like new terms after a void: a rejoin doesn't replay the old meeting's turns
      helm.table.newRound(t);
      helm.save(t);
      helm.broadcastState(t);
      throw new HelmError("BAD_PHASE", "Those two charts are no longer on the table. Weigh anchor again for new ones.");
    }
    helm.transition(t, "DRY_RUN", { from: ["VOIDED"] });
    t.votes = {};
    helm.dryrun.cancelAutoPick(t);
    helm.dryrun.startClock(t);
    helm.save(t);
    helm.table.emitShortlist(t);
    helm.broadcastState(t);
  }

  onBookingResult(b: BookingRec, status: "CAPTURED" | "VOIDED", publicReason?: string) {
    const { helm } = this;
    const t = helm.trips.get(b.tripId);
    // only the voyage's current attempt, only while it is sealing (L4-006: a late or duplicate result never takes the
    // restore-only BOOKED↔VOIDED edges live; restore settles through reconcileBooking), never after it moved on
    if (!t || t.bookingId !== b._id || t.status !== "SEALING") return;
    helm.transition(t, status === "CAPTURED" ? "BOOKED" : "VOIDED", { from: ["SEALING"] });
    t.lastResult = { bookingId: b._id, publicReason };
    helm.save(t);
    helm.toTrip(t._id, "booking:result", { bookingId: b._id, status, reference: b.reference, publicReason });
    helm.broadcastState(t);
    if (status === "CAPTURED") this.dropStanding(t);
    // L4-008: one voided note per voyage at most (its first attempt), and none for a restart void
    const write = status === "CAPTURED" ? this.writeMemories(t)
      : t.attempt === 1 && publicReason !== REASONS.restarted ? this.writeVoidedMemories(t) : Promise.resolve();
    void write.catch((e) => console.warn("[helm] memory write failed", e));
  }

  /** L5-007: a booked voyage needs no standing instruction any more: dropped in memory and unset on the member doc. */
  private dropStanding(t: TripRec) {
    for (const m of this.helm.activeMembers(t)) {
      this.helm.payments.standing.delete(m._id);
      if (m.standing) { m.standing = undefined; persist("members", m); }
    }
  }

  /**
   * TR4-018 (doc 05 §9): a voided attempt leaves a smaller, neutral note for every member: no budget band and no
   * attribution, since nobody learns whose seal failed (doc 06 §7). L4-008: only for the voyage's first attempt, so
   * retries don't push real history out of the last-5 recall.
   */
  private async writeVoidedMemories(t: TripRec) {
    const plan = this.helm.table.planOf(t, t.chosenPlanId);
    if (!plan) return;
    const note = `${this.helm.table.voyageLine(t, plan)} · not booked (nobody was charged)`;
    // O2-041: one local write for the whole crew
    await rememberAll(this.helm.activeMembers(t).flatMap((m) => { const key = this.helm.memKey(m); return key ? [{ key, text: note }] : []; }));
  }

  private async writeMemories(t: TripRec) {
    const { helm } = this;
    const plan = helm.table.planOf(t, t.chosenPlanId);
    if (!plan) return;
    const head = helm.table.voyageLine(t, plan); // OPT-045: once, not per member
    const notes: { key: string; text: string }[] = [];
    for (const m of helm.activeMembers(t)) {
      const v = plan.members.find((x) => x.memberId === m._id);
      const k = helm.memKey(m);
      const brief = helm.briefs.get(m._id);
      if (!v || !k || !brief) continue;
      const firstProposal = t.negotiation.turns.find((x) => x.act === "PROPOSE" && x.speaker.kind === "advocate" && x.speaker.memberId === m._id);
      const conceded = firstProposal?.cityId && firstProposal.cityId !== plan.cityId ? ` · conceded the city choice (wanted ${cityName(helm.ds, firstProposal.cityId)})` : "";
      const liked = v.lines.filter((l) => l.kind === "activity").map((l) => l.label).join(", ");
      notes.push({ key: k, text: `${head} · booked · ${budgetBand(brief.capCents)} · liked: ${liked}${conceded}` });
    }
    await rememberAll(notes); // O2-041: one local write for the whole crew
  }
}
