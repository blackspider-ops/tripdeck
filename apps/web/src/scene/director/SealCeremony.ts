// The Seal ceremony on the table: the chosen chart unrolls, seals drop as shares authorize, standing
// (pre-signed) seals get their letter, and the booked chart is tied with its reference. Public data only.
import type { BookingPublic, TripState } from "@all-ayes/shared";
import { SealChart } from "../SealChart";
import { sealFit } from "../sealLayout";
import { SEAL_RING_R } from "./CrewSeating";

/** The seal chart's north edge (chart frame, m): just in front of the stowed globe. */
export const SEAL_Z0 = 0.02;
/** Everything of the seal chart stays this close to the centre: the pieces' ring less a piece's footprint (m). */
export const SEAL_CLEAR_R = SEAL_RING_R - 0.04;
import type { DirectorContext } from "./context";
import { windowLabel } from "../../phone/format";

/** The chart's window label, the phone's own ("May 1–5", "May 29–Jun 2"); "" for a window not on the trip. */
const fmtWindow = (trip: TripState, id: string) => windowLabel(trip.dateWindows, id);

export class SealCeremony {
  private chart: SealChart | null = null;
  private pressed = new Set<string>();

  constructor(private ctx: DirectorContext) {}

  get open() { return this.chart !== null; }

  /** Unroll the chosen chart (or the first of the Two Charts) with one line per crew member. */
  openChart(trip: TripState, instant: boolean) {
    this.clear();
    const { shortlist } = this.ctx.store.state;
    const plan = shortlist.find((p) => p.planId === trip.chosenPlanId) ?? shortlist[0];
    if (!plan) return;
    this.chart = new SealChart(this.ctx.tweens, plan, trip.crew, fmtWindow(trip, plan.dateWindowId));
    // north edge just clear of the stowed globe; scaled to lie inside the stepped-back pieces (CrewSeating.SEAL_RING_R)
    this.chart.group.position.z = SEAL_Z0;
    this.chart.group.scale.setScalar(sealFit(this.chart.sheetLength ?? 0, SEAL_Z0, SEAL_CLEAR_R));
    this.ctx.root.add(this.chart.group);
    void this.chart.unroll(instant);
    this.sync(this.ctx.store.state.booking, instant);
  }

  /** Mirror the public booking: standing letters, and a seal pressed for each authorized share. */
  sync(b: BookingPublic | null, instant: boolean) {
    const chart = this.chart;
    if (!b || !chart) return;
    for (const seal of b.seals) {
      chart.setStanding(seal.memberId, !!seal.standing);
      const key = `${b.bookingId}:${seal.memberId}`;
      if ((seal.status === "AUTHORIZED" || seal.status === "CAPTURED") && !this.pressed.has(key)) {
        this.pressed.add(key);
        if (instant || this.ctx.isResume()) void chart.pressSeal(seal.memberId, true);
        else this.ctx.enqueue(() => chart.pressSeal(seal.memberId));
      }
    }
  }

  /** Booked: roll up and tie the chart with its reference. */
  tie(reference: string | undefined, instant: boolean) { return this.chart?.tie(reference, instant); }

  /** Voided: the pressed seals crack and lift. */
  voidAll() { return this.chart?.voidAll(); }

  clear() {
    this.chart?.dispose();
    this.chart = null;
    this.pressed.clear();
  }
}
