/**
 * The Helm: trip lifecycle (docs/04-technical-design.md §5), privacy rooms (§7), and the glue between pricing, the
 * negotiation engine, voices, memory and payments.
 *
 * OPT-031 / O2-001: TripService is the one public surface of trips/: the REST routes, the socket handlers and the
 * tests call these methods (and read the core's maps). The records, emits, state machine, lookups and eviction live
 * in core.ts (which it extends); each job is its own module, and the modules reach each other through `Helm`
 * (core.ts), never through this facade:
 *   crew.ts        voyages, joining, absent friends, briefs, seat resets, "sail without them"
 *   identity.ts    headset pairing, demo handoffs
 *   table.ts       chart book + privacy context, the meeting, hails, the Two Charts
 *   dryrun.ts      votes, auto-pick, the Dry Run clock
 *   sealing.ts     pick, seals, call-off, retry, the booking's outcome and memory notes
 *   replay.ts      trip:state and (re)join replay
 *   persistence.ts boot restore, reconnect sync, on-demand hydrate, trip lookups (`archive`)
 */
import { JOIN_REFUSAL, type Band, type BriefInput, type Origin } from "@all-ayes/shared";
import { HelmError } from "../util/errors.js";
import type { BookingRec } from "../payments/orchestrator.js";
import { HelmCore, type Helm } from "./core.js";
import { Crew, type CreateTrip } from "./crew.js";
import { Identity } from "./identity.js";
import { Table } from "./table.js";
import { DryRun } from "./dryrun.js";
import { Sealing } from "./sealing.js";
import { Replayer } from "./replay.js";
import { Persistence } from "./persistence.js";
import { LivePrices } from "./live.js";
import type { Actor, Emit, TripRec } from "./records.js";

export class TripService extends HelmCore implements Helm {
  readonly crew: Crew = new Crew(this);
  readonly identity: Identity = new Identity(this);
  readonly table: Table = new Table(this);
  readonly dryrun: DryRun = new DryRun(this);
  readonly sealing: Sealing = new Sealing(this);
  readonly replayer: Replayer = new Replayer(this);
  readonly archive: Persistence = new Persistence(this);
  readonly live: LivePrices = new LivePrices(this);

  protected onBookingResult(b: BookingRec, status: "CAPTURED" | "VOIDED", publicReason?: string) { return this.sealing.onBookingResult(b, status, publicReason); }

  // ---------- persistence & lookups ----------
  restore(opts: { merge?: boolean } = {}) { return this.archive.restore(opts); }
  syncAfterReconnect() { return this.archive.syncAfterReconnect(); }
  /** Loads an archived voyage by id or join code (await it before `trip()`/`tripByCode()` to avoid 503 LOADING). */
  hydrate(q: { tripId?: string; joinCode?: string }) { return this.archive.hydrate(q); }
  trip(tripId: string) { return this.archive.trip(tripId); }
  tripByCode(code: string) { return this.archive.tripByCode(code); }

  // ---------- crew ----------
  createTrip(p: CreateTrip) { return this.crew.createTrip(p); }
  join(tripId: string, p: { name: string; band: Band; origin: Origin; crewKey?: unknown; device?: unknown }) { return this.crew.join(tripId, p); }
  setCourse(tripId: string, actor: Actor, p: { destination?: unknown; crewPins?: unknown }) { return this.crew.setCourse(tripId, actor, p); }
  setCrewOpen(tripId: string, actor: Actor, open: boolean) { return this.crew.setCrewOpen(tripId, actor, open); }
  addAbsent(tripId: string, actor: Actor, p: { name: string; band: Band; origin: Origin }) { return this.crew.addAbsent(tripId, actor, p); }
  reissueInvite(tripId: string, actor: Actor, memberId: string) { return this.crew.reissueInvite(tripId, actor, memberId); }
  resetSeat(tripId: string, actor: Actor, memberId: string) { return this.crew.resetSeat(tripId, actor, memberId); }
  claimAbsent(tripId: string, memberId: string, inviteKey: string, crewKey?: unknown) { return this.crew.claimAbsent(tripId, memberId, inviteKey, crewKey); }
  submitBrief(tripId: string, memberId: string, input: BriefInput) { return this.crew.submitBrief(tripId, memberId, input); }
  sailWithout(tripId: string, actor: Actor, memberIds: string[]) { return this.crew.sailWithout(tripId, actor, memberIds); }

  // ---------- devices & handoffs ----------
  mintHandoff(tripId: string, memberId: string, memberToken: string) { return this.identity.mintHandoff(tripId, memberId, memberToken); }
  redeemHandoff(tripId: string, memberId: string, code: string) { return this.identity.redeemHandoff(tripId, memberId, code); }
  headsetCode(tripId: string, actor: Actor) { return this.identity.headsetCode(tripId, actor); }
  pairHeadset(code: string) { return this.identity.pairHeadset(code); }
  unpairHeadset(tripId: string, actor: Actor) { return this.identity.unpairHeadset(tripId, actor); }
  // Quest-first: headsets as crew devices
  requestAttach(joinCode: string, memberId: string) { return this.identity.headsets.requestAttach(joinCode, memberId); }
  approveAttach(tripId: string, memberId: string, requestId: string, allow: boolean) { return this.identity.headsets.approveAttach(tripId, memberId, requestId, allow); }
  attachStatus(requestId: string, secret: string) { return this.identity.headsets.attachStatus(requestId, secret); }
  detachHeadset(tripId: string, memberId: string) { return this.identity.headsets.detach(tripId, memberId); }
  setSealPin(tripId: string, memberId: string, pin: unknown, current?: unknown) { return this.identity.headsets.setSealPin(tripId, memberId, pin, current); }

  // ---------- the table ----------
  startTable(tripId: string, actor: Actor) { return this.table.startTable(tripId, actor); }
  hail(tripId: string, memberId: string, text: string) { return this.table.hail(tripId, memberId, text); }

  // ---------- dry run & sealing ----------
  vote(tripId: string, memberId: string, planId: string) { return this.dryrun.vote(tripId, memberId, planId); }
  dryrunControl(tripId: string, actor: Actor, action: "pause" | "resume" | "restart") { return this.dryrun.dryrunControl(tripId, actor, action); }
  /** Internal: commits the crew's decision (the auto-pick uses it). Not reachable from a socket. */
  pick(tripId: string, actor: Actor, planId: string) { return this.sealing.pick(tripId, actor, planId); }
  /**
   * The crew's majority picks: nobody (the organizer included) picks by hand. A `plan:pick` (the headset lifting a
   * cloche) is that seat's vote: the member's own seat, or the organizer's for the paired headset.
   */
  pickAsVote(tripId: string, actor: Actor, planId: string) {
    const memberId = actor.memberId ?? (this.deviceOk(tripId, actor.deviceToken) ? this.trip(tripId).organizerId : undefined);
    if (!memberId) {
      if (actor.deviceToken && this.trip(tripId).status !== "BOOKED") throw new HelmError("DEVICE_EXPIRED", JOIN_REFUSAL.DEVICE_EXPIRED);
      throw new HelmError("NOT_MEMBER", "Only crew can vote.");
    }
    return this.dryrun.vote(tripId, memberId, planId);
  }
  setSeal(tripId: string, memberId: string, bookingId: string, assertionToken?: string, pin?: string) { return this.sealing.setSeal(tripId, memberId, bookingId, assertionToken, pin); }
  cancelSeal(tripId: string, memberId: string, bookingId: string) { return this.sealing.cancelSeal(tripId, memberId, bookingId); }
  callOff(tripId: string, actor: Actor, bookingId?: string) { return this.sealing.callOff(tripId, actor, bookingId); }
  retry(tripId: string, actor: Actor) { return this.sealing.retry(tripId, actor); }

  // ---------- snapshots & replay ----------
  state(t: TripRec) { return this.replayer.state(t); }
  /** O2-040: without the static fields (the replay carries them). */
  /** `full`: with the static fields too (the ports changed: a region voyage's pre-rank at the table). */
  broadcastState(t: TripRec, full = false) { this.toTrip(t._id, "trip:state", full ? this.replayer.state(t) : this.replayer.update(t)); }
  /** A (re)joining socket's replay; `later` settles once a slow memory recall's follow-up is sent (replay.ts). */
  replayNow(t: TripRec, emit: Emit, memberId?: string) { return this.replayer.replayNow(t, emit, memberId); }
  /** The voyage's booking attempt, whatever its phase. */
  currentBooking(t: TripRec) { return this.sealing.currentBooking(t); }

  /**
   * WP-04 follow-up: what /api/debug may show of a voyage besides its log lines: phase, table progress and the
   * current booking, including `needsAttention` (a refund or release the provider refused) and the seal deadline.
   * No member names, shares or caps.
   */
  debugSummary(tripId: string) {
    const t = this.trips.get(tripId);
    if (!t) return null;
    const b = this.sealing.currentBooking(t);
    return {
      status: t.status, version: t.version, watch: t.negotiation.watch, turns: t.negotiation.turns.length, tableRuns: t.tableRuns ?? 0,
      payments: this.payments.mode,
      booking: b ? { status: b.status, reference: b.reference, attempt: b.attempt, needsAttention: Boolean(b.needsAttention), sealDeadlineAt: b.sealDeadlineAt } : null,
    };
  }
}
