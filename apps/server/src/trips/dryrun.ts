/**
 * The Dry Run (OPT-031): votes on the Two Charts, the crew's majority picks after a countdown (D5; no organizer
 * privilege), mates vote for away seats, ties are broken in public, and the one shared clock.
 */
import { AUTOPICK_MS, DRYRUN_DAY_END_MIN, DRYRUN_DAY_START_MIN, DRYRUN_MIN_PER_SEC } from "@all-ayes/shared";
import { HelmError } from "../util/errors.js";
import type { Plan, VoteBoard } from "@all-ayes/shared";
import { cityName } from "../data/loader.js";
import { tallies, type Actor, type TripRec } from "./records.js";
import type { Helm } from "./core.js";

export class DryRun {
  constructor(private helm: Helm) {}
  private autoPickTimers = new Map<string, NodeJS.Timeout>();
  /** The countdown before the crew's choice is picked (tests shorten it). */
  autoPickMs = AUTOPICK_MS;

  vote(tripId: string, memberId: string, planId: string) {
    const { helm } = this;
    const { t } = helm.memberTrip(tripId, memberId);
    if (t.status !== "DRY_RUN" || !t.shortlistIds?.includes(planId)) throw new HelmError("BAD_PHASE", "Votes are for the two charts.");
    t.votes[memberId] = planId;
    // their own vote replaces anything their mate cast (or withheld) for them
    t.mateVotes = (t.mateVotes ?? []).filter((id) => id !== memberId);
    t.mateAbstain = (t.mateAbstain ?? []).filter((id) => id !== memberId);
    this.settle(t);
    helm.save(t);
    this.broadcast(t);
    helm.toMember(tripId, memberId, "plan:myVote", { planId });
  }

  /**
   * The crew's majority picks (no organizer privilege): when the Dry Run opens, each away seat's mate votes per their
   * sealed terms: the chart that fits them; if neither fits, the one cheaper for them; if both fit, the mate abstains
   * (and the seat leaves the count). Only "Jae's mate voted" is ever said, never why.
   */
  openVoting(t: TripRec) {
    t.votes = {}; t.mateVotes = []; t.mateAbstain = []; t.voteNote = null;
    this.cancelAutoPick(t);
    const [a, b] = (t.shortlistIds ?? []).map((id) => this.helm.table.planOf(t, id));
    if (a && b) {
      for (const m of this.helm.activeMembers(t)) {
        if (m.role !== "absent") continue;
        const choice = mateChoice(a, b, m._id);
        if (choice) { t.votes[m._id] = choice; t.mateVotes.push(m._id); } else t.mateAbstain.push(m._id);
      }
    }
    this.settle(t);
  }

  /** The public board: X of N have voted, whose mate voted, the tie-break note. Counts only. */
  board(t: TripRec): VoteBoard {
    const { helm } = this;
    const active = helm.activeMembers(t);
    const abstain = new Set(t.mateAbstain ?? []);
    const counts = tallies(t);
    const mates = (t.mateVotes ?? []).flatMap((id) => { const m = active.find((x) => x._id === id); return m ? [m.name] : []; });
    return {
      voted: Object.values(counts).reduce((n, x) => n + x, 0),
      eligible: active.filter((m) => !abstain.has(m._id)).length,
      mates, note: t.voteNote ?? null,
    };
  }

  broadcast(t: TripRec) {
    this.helm.toTrip(t._id, "plan:votes", { tallies: tallies(t), autoPick: t.autoPick ?? null, board: this.board(t), serverNow: Date.now() });
  }

  /**
   * D5, the crew's majority: a strict majority of the voting crew on one chart arms the countdown; once everyone has
   * voted and it's a tie, the tie is broken (more of the crew's terms fit → lower group total → Chart A) and announced.
   * Anything else (a split before everyone voted) cancels it.
   */
  settle(t: TripRec) {
    const counts = tallies(t);
    const { voted, eligible } = this.board(t);
    const leader = Object.entries(counts).find(([, n]) => n > eligible / 2)?.[0];
    if (leader) {
      t.voteNote = null;
      if (t.autoPick?.planId !== leader) this.armAutoPick(t, leader);
      return;
    }
    if (voted >= eligible && t.shortlistIds) {
      const { planId, note } = this.tieBreak(t);
      t.voteNote = note;
      if (t.autoPick?.planId !== planId) this.armAutoPick(t, planId);
      return;
    }
    t.voteNote = null;
    this.cancelAutoPick(t);
  }

  /** A tie among the whole crew: (1) the chart that fits more of the crew's terms, (2) the lower group total, (3) Chart A. */
  tieBreak(t: TripRec): { planId: string; note: string } {
    const [idA, idB] = t.shortlistIds!;
    const a = this.helm.table.planOf(t, idA);
    const b = this.helm.table.planOf(t, idB);
    const city = (p: Plan | undefined, id: string) => (p ? cityName(this.helm.ds, p.cityId) : id);
    if (a && b) {
      const fa = a.members.filter((m) => m.fits).length;
      const fb = b.members.filter((m) => m.fits).length;
      if (fa !== fb) {
        const w = fa > fb ? a : b;
        return { planId: w._id, note: `It's a tie, so the chart that fits more of the crew's terms wins: ${city(w, w._id)}.` };
      }
      if (a.groupCents !== b.groupCents) {
        const w = a.groupCents < b.groupCents ? a : b;
        return { planId: w._id, note: `It's a tie and both fit the same number of people, so the lower group total wins: ${city(w, w._id)}.` };
      }
    }
    return { planId: idA, note: `It's a tie on every count, so Chart A wins: ${city(a, idA)}.` };
  }

  /** Picks `planId` (the crew's decision) after `ms`, unless the vote moved or the voyage did (restore re-arms it). */
  armAutoPick(t: TripRec, planId: string, ms = this.autoPickMs) {
    this.cancelAutoPick(t);
    t.autoPick = { planId, at: Date.now() + ms };
    const timer = setTimeout(() => {
      this.autoPickTimers.delete(t._id);
      // R2-WP-11: a voyage the sweep evicted meanwhile isn't picked (nor loaded back just to be picked)
      if (t.status !== "DRY_RUN" || t.autoPick?.planId !== planId || this.helm.trips.get(t._id) !== t) return;
      void this.helm.sealing.pick(t._id, { memberId: t.organizerId }, planId).catch((e) => console.warn("[helm] auto-pick failed", e));
    }, ms);
    timer.unref?.(); // O2-042: a pending auto-pick never keeps the process alive (a restart re-arms it)
    this.autoPickTimers.set(t._id, timer);
  }

  cancelAutoPick(t: TripRec) {
    const timer = this.autoPickTimers.get(t._id);
    if (timer) clearTimeout(timer);
    this.autoPickTimers.delete(t._id);
    t.autoPick = null;
  }

  dryrunControl(tripId: string, actor: Actor, action: "pause" | "resume" | "restart") {
    const t = this.helm.organizerTrip(tripId, actor, { phases: ["DRY_RUN"], phaseMessage: "The clock only runs during the Dry Run." });
    const now = Date.now();
    const c = t.dryrun ?? this.startClock(t, now);
    // a duplicate pause (or a resume while running) changes nothing, so nothing is broadcast (TR2-006)
    if (action === "pause") { if (c.pausedAt) return; c.pausedAt = now; }
    if (action === "resume") { if (!c.pausedAt) return; c.startedAt += now - c.pausedAt; c.pausedAt = null; }
    if (action === "restart") { c.startedAt = now; c.pausedAt = null; }
    this.helm.save(t); // TR5-011: a restart resumes the tour at the same minute, paused or not
    this.helm.toTrip(tripId, "dryrun:control", { action, at: now, startedAt: c.startedAt, pausedAt: c.pausedAt, serverNow: now });
  }

  /** O2-013: the Dry Run clock (re)starts now, running (the table decided, or back to the charts). */
  startClock(t: TripRec, now = Date.now()) {
    return (t.dryrun = { startedAt: now, pausedAt: null });
  }

  /** One Dry Run clock per voyage (persisted on the trip, TR5-011), so reloads, late joiners and restarts see the same minute. */
  script(t: TripRec, planIds: string[]) {
    const c = t.dryrun ?? this.startClock(t);
    return { planIds, dayStartMin: DRYRUN_DAY_START_MIN, dayEndMin: DRYRUN_DAY_END_MIN, minPerSec: DRYRUN_MIN_PER_SEC, startedAt: c.startedAt, pausedAt: c.pausedAt, serverNow: Date.now() };
  }
}

/**
 * An away member's mate votes per their terms: the chart that fits them; if neither does, the one cheaper for them;
 * if both fit (or both cost the same), the mate abstains (null).
 */
export function mateChoice(a: Plan, b: Plan, memberId: string): string | null {
  const va = a.members.find((m) => m.memberId === memberId);
  const vb = b.members.find((m) => m.memberId === memberId);
  if (!va || !vb) return null;
  if (va.fits !== vb.fits) return va.fits ? a._id : b._id;
  if (va.fits) return null;
  if (va.amountCents === vb.amountCents) return null;
  return va.amountCents < vb.amountCents ? a._id : b._id;
}
