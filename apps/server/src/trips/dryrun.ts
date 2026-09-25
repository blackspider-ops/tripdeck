/**
 * The Dry Run (OPT-031): votes on the Two Charts, the majority auto-pick countdown (D5), and the one shared clock.
 */
import { AUTOPICK_MS, DRYRUN_DAY_END_MIN, DRYRUN_DAY_START_MIN, DRYRUN_MIN_PER_SEC } from "@all-ayes/shared";
import { HelmError } from "../util/errors.js";
import { tallies, type Actor, type TripRec } from "./records.js";
import type { Helm } from "./core.js";

export class DryRun {
  constructor(private helm: Helm) {}
  private autoPickTimers = new Map<string, NodeJS.Timeout>();

  vote(tripId: string, memberId: string, planId: string) {
    const { helm } = this;
    const { t } = helm.memberTrip(tripId, memberId);
    if (t.status !== "DRY_RUN" || !t.shortlistIds?.includes(planId)) throw new HelmError("BAD_PHASE", "Votes are for the two charts.");
    t.votes[memberId] = planId;
    // D5: a strict majority of the crew on one chart starts a countdown; a split cancels it
    const counts = tallies(t);
    const crewSize = helm.activeMembers(t).length;
    const leader = Object.entries(counts).find(([, n]) => n > crewSize / 2)?.[0];
    if (leader && t.autoPick?.planId !== leader) this.armAutoPick(t, leader);
    if (!leader) this.cancelAutoPick(t);
    helm.save(t);
    helm.toTrip(tripId, "plan:votes", { tallies: counts, autoPick: t.autoPick ?? null, serverNow: Date.now() });
    helm.toMember(tripId, memberId, "plan:myVote", { planId });
  }

  /** Picks `planId` for the organizer after `ms`, unless the vote moved or the voyage did (restore re-arms it). */
  armAutoPick(t: TripRec, planId: string, ms = AUTOPICK_MS) {
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
