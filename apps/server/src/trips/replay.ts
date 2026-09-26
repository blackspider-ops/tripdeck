/**
 * Snapshots and replay (OPT-031): `trip:state`, and everything a (re)joining client needs (doc 04 §7.3).
 */
import type { Brief, S2CPayload, TripState, TripStateUpdate } from "@all-ayes/shared";
import { indexOf } from "../data/loader.js";
import { toPrivate } from "../fit/pricing.js";
import {
  BOOKING_PHASES, REPLAY_TURNS, SHORTLIST_PHASES, TABLE_RESET_NOTICE_MS, briefOut, tallies,
  type Emit, type MemberRec, type TripRec,
} from "./records.js";
import type { Helm } from "./core.js";
import { destinationPublic, tripWindows } from "./course.js";

const SLOW = Symbol("slow");
/** One macrotask: long enough for a recall served from memory, short enough not to hold a join back. */
const afterTick = () => new Promise<typeof SLOW>((r) => setImmediate(() => r(SLOW)));

export class Replayer {
  constructor(private helm: Helm) {}

  /** The shared snapshot: public by construction (ids, public views, tallies; no shares, caps or plan bodies). */
  state(t: TripRec): TripState {
    const cities = indexOf(this.helm.ds).city;
    return {
      ...this.update(t),
      candidateCities: t.candidateCityIds.flatMap((id) => {
        const c = cities.get(id);
        return c ? [{ cityId: id, name: c.name, lat: c.centerLat, lng: c.centerLng }] : [];
      }),
      // only the windows this voyage offers (older voyages: W1 and W2)
      dateWindows: tripWindows(this.helm.ds, t),
      destination: destinationPublic(this.helm.ds, t),
    };
  }

  /**
   * O2-040: the live `trip:state` broadcast: the snapshot without its static fields (the ports and date windows never
   * change once the voyage exists; a (re)joining client gets them with its replay and keeps them).
   */
  update(t: TripRec): TripStateUpdate {
    const { helm } = this;
    // after "back to the charts" (VOIDED → DRY_RUN) or VOIDED → BRIEFING the old attempt is history (TR4-013)
    const live = BOOKING_PHASES.includes(t.status);
    const b = live ? helm.sealing.currentBooking(t) : undefined;
    return {
      tripId: t._id, joinCode: t.joinCode, name: t.name, status: t.status, version: t.version, organizerId: t.organizerId,
      crew: helm.crewPublic(t), crewClosed: Boolean(t.crewClosed),
      negotiation: { watch: t.negotiation.watch, running: t.negotiation.running },
      // ids only: the plan bodies go once in table:decided (OPT-042)
      shortlistIds: t.shortlistIds && SHORTLIST_PHASES.includes(t.status) ? t.shortlistIds : undefined,
      votes: tallies(t),
      autoPick: t.autoPick ?? null,
      chosenPlanId: live ? t.chosenPlanId : undefined,
      booking: b ? helm.payments.toPublic(b) : undefined,
      paymentsMode: helm.payments.mode,
      serverNow: Date.now(),
    };
  }

  /**
   * WP-11 follow-up: `brief:private` goes at once. If the member's memory lines aren't ready within a tick (first
   * load of the store, a Backboard fetch), the brief goes without them and a second `brief:private` follows with
   * them; `later` settles when that follow-up is sent (at once when memory was quick).
   */
  async briefPrivate(m: MemberRec, brief: Brief | null, send: (p: S2CPayload<"brief:private">) => void): Promise<{ later: Promise<void> }> {
    const r = await this.recall(m);
    if (r.quick) { send({ brief, memory: r.quick }); return { later: Promise.resolve() }; }
    send({ brief });
    return { later: r.memory.then((lines) => send({ brief, memory: lines })) };
  }

  /** The member's memory lines: `quick` when they came within a tick, else only the pending `memory`. */
  private async recall(m: MemberRec): Promise<{ quick?: string[]; memory: Promise<string[]> }> {
    const memory = this.helm.memoryFor(m).catch((e) => {
      console.warn(`[helm] memory recall for ${m._id} failed`, (e as Error).message);
      return [] as string[];
    });
    const quick = await Promise.race([memory, afterTick()]);
    return quick === SLOW ? { memory } : { quick, memory };
  }

  /** Everything a (re)joining client needs (doc 04 §7.3), including the memory follow-up. */
  async replay(t: TripRec, emit: Emit, memberId?: string) {
    const { later } = await this.replayNow(t, emit, memberId);
    await later;
  }

  /**
   * L3-002: the replay proper. Every wait comes first (one tick for the memory recall, the member's card digits), then
   * the whole replay is built and sent in one synchronous pass from the voyage as it is *now*, so a pick, void or retry
   * that landed during the wait is never replayed stale (the socket is already in its rooms, so it also got that live).
   * Resolves once that pass is sent; `later` settles when a slow memory recall's second `brief:private` has gone.
   * `trip:join` acks on the first, not the second (a cold Backboard recall can take seconds).
   */
  async replayNow(t: TripRec, emit: Emit, memberId?: string): Promise<{ later: Promise<void> }> {
    const { helm } = this;
    const m0 = memberId ? helm.members.get(memberId) : undefined;
    const [mem, seal0] = m0
      ? await Promise.all([this.recall(m0), helm.sealing.sealPrivateFor(t, m0._id)])
      : [undefined, null];
    const short = SHORTLIST_PHASES.includes(t.status) ? helm.table.shortlist(t) : [];
    const views = short.length === 2 ? helm.table.publicShortlist(t) : undefined;
    // the plan bodies first: trip:state carries only shortlistIds, which then resolve at once (OPT-042)
    if (views) emit("table:decided", { shortlist: views });
    emit("trip:state", this.state(t));
    // TR5-021: the table was interrupted (restart or failure): say so, so the phone doesn't wait on a dead table
    if (t.status === "BRIEFING" && t.tableReset && Date.now() - Date.parse(t.tableReset.at) < TABLE_RESET_NOTICE_MS) {
      emit("error", { code: "TABLE_INTERRUPTED", message: t.tableReset.reason });
    }
    for (const turn of t.negotiation.turns.slice(-REPLAY_TURNS)) {
      emit("turn:new", turn);
      if (turn.audioUrl) emit("turn:audioReady", { turnId: turn.turnId, audioUrl: turn.audioUrl, durationMs: turn.durationMs });
    }
    if (short.length === 2 && t.status === "DRY_RUN") emit("dryrun:script", helm.dryrun.script(t, short.map((p) => p._id)));
    // after "back to the charts" the voided attempt is history: don't replay its seal screens
    const b = BOOKING_PHASES.includes(t.status) ? helm.sealing.currentBooking(t) : undefined;
    if (b) emit("booking:created", { ...helm.payments.toPublic(b), serverNow: Date.now() });
    // a final booking's outcome (reference, public reason) survives a reload (TR3-003)
    if (b && (b.status === "CAPTURED" || b.status === "VOIDED") && (t.status === "BOOKED" || t.status === "VOIDED")) {
      const publicReason = t.lastResult?.bookingId === b._id ? t.lastResult.publicReason : undefined;
      emit("booking:result", { bookingId: b._id, status: b.status, reference: b.reference, publicReason });
    }
    // re-read: the member may have been sailed without during the wait
    const m = m0 && !t.removedMemberIds.includes(m0._id) ? helm.members.get(m0._id) : undefined;
    if (!m || !mem) return { later: Promise.resolve() };
    const brief = () => briefOut(helm.briefs.get(m._id));
    emit("brief:private", mem.quick ? { brief: brief(), memory: mem.quick } : { brief: brief() });
    for (const p of short) { const priv = toPrivate(p, m._id); if (priv) emit("plan:private", priv); }
    if (t.status === "DRY_RUN") emit("plan:myVote", { planId: t.votes[m._id] ?? null });
    if (b && t.chosenPlanId) {
      // only the digits were worth the wait: the share itself belongs to the booking that is current now
      if (seal0 && seal0.bookingId === b._id) emit("seal:private", seal0);
      const s = b.seals.find((x) => x.memberId === m._id);
      if (s?.status === "DECLINED" && s.declineReason) emit("seal:declinedPrivate", { bookingId: b._id, reason: s.declineReason });
    }
    const later = mem.quick ? Promise.resolve() : mem.memory.then((lines) => emit("brief:private", { brief: brief(), memory: lines }));
    return { later };
  }
}
