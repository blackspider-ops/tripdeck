// Phase choreography: what the table does when the voyage moves BRIEFING → AT_TABLE → DRY_RUN → SEALING
// → BOOKED / VOIDED, including the Dry Run cloches and the "Back to the charts" card.
import * as THREE from "three";
import { DRYRUN_DAY1_LABEL, DRYRUN_DAY_START_MIN, PALETTE, type BookingPublic, type PlanPublic, type TripState, type TripStatus } from "@all-ayes/shared";
import { DryRunCloche } from "../DryRun";
import { HOME_PORT } from "../Globe";
import { CityTiles, tilesAvailable } from "../CityTiles";
import { PaperMenu, type Interactable } from "../Buttons";
import { sound } from "../audio";
import { CARD, NARRATOR, phaseCaption } from "../copy";
import { SealCeremony } from "./SealCeremony";
import type { TurnPlayer } from "./TurnPlayer";
import type { DirectorContext } from "./context";

export class PhaseController {
  private seals: SealCeremony;
  private backCard: PaperMenu;
  private status: TripStatus | null = null;
  private cloches = new Map<string, DryRunCloche>();
  private tiles: CityTiles[] = [];
  private briefingLine = "";
  /** A cloche was lifted optimistically; undone if the helm refuses the pick. */
  private pickPending = false;

  constructor(private ctx: DirectorContext, private turns: TurnPlayer) {
    this.seals = new SealCeremony(ctx);
    this.backCard = new PaperMenu(ctx.tweens, CARD.voidTitle, [
      { label: CARD.backToCharts, primary: true, onSelect: () => this.ctx.store.emit("booking:retry", {}) },
    ], 0.17);
    this.backCard.group.position.set(0.15, 0.12, 0.13);
    this.backCard.group.rotation.set(-0.35, -0.35, 0);
    this.backCard.group.visible = false;
    ctx.root.add(this.backCard.group);
  }

  /** Queue the choreography for a new phase; keep the BRIEFING caption current. */
  sync(trip: TripState, hasTurns: boolean, instant: boolean) {
    if (trip.status !== this.status) {
      const prev = this.status;
      this.status = trip.status;
      this.briefingLine = "";
      this.ctx.enqueue(() => this.onStatusChange(prev, trip.status, instant));
      // phase captions wait their turn behind any lines still being spoken
      if (!hasTurns || trip.status !== "AT_TABLE") this.ctx.enqueue(() => this.caption(this.ctx.store.state.trip ?? trip));
    } else if (trip.status === "BRIEFING") {
      // "Waiting on …" updates as terms are sealed; only when the line actually changes
      const line = phaseCaption(trip) ?? "";
      if (line !== this.briefingLine) this.caption(trip);
    }
  }

  private caption(trip: TripState) {
    const line = phaseCaption(trip);
    if (trip.status === "BRIEFING") this.briefingLine = line ?? "";
    if (line) this.ctx.caption(NARRATOR, line, PALETTE.inkSoft);
  }

  setVotes(votes: Record<string, number>) {
    for (const [planId, cl] of this.cloches) cl.setVotes(votes[planId] ?? 0);
  }

  /** Mirror the public booking on the seal chart (seals pressed, standing letters). */
  syncBooking(b: BookingPublic | null, instant: boolean) { this.seals.sync(b, instant); }

  /** What this part offers to pick: the "Back to the charts" card after a void, and the cloches (the headset
   *  lifts one and emits plan:pick). `controls`: this device may act (the headset, not the Gallery). */
  targets(controls: boolean, status: () => TripStatus | undefined): Interactable[] {
    const back = this.backCard;
    return [...back.interactables(() => controls && back.group.visible), ...this.clocheTargets(controls, status)];
  }

  private clocheTargets(controls: boolean, st: () => TripStatus | undefined): Interactable[] {
    return [...this.cloches].map(([planId, cl]) => ({
      object: cl.dome,
      enabled: () => controls && st() === "DRY_RUN",
      onSelect: () => {
        for (const other of this.cloches.values()) void other.lift(other === cl);
        this.pickPending = true; // optimistic lift: undone if the helm refuses the pick
        this.ctx.store.emit("plan:pick", { planId });
      },
    }));
  }

  /** The helm refused something: lower an optimistically lifted cloche. */
  cancelPick() {
    if (!this.pickPending) return;
    this.pickPending = false;
    for (const c of this.cloches.values()) void c.lift(false);
  }

  private async onStatusChange(prev: TripStatus | null, next: TripStatus, instant: boolean) {
    const { store, globe, opts } = this.ctx;
    const s = store.state;
    const trip = s.trip!;
    if (next === "BRIEFING" || next === "AT_TABLE") {
      this.clearDryRun();
      this.seals.clear();
      this.backCard.group.visible = false;
      // a new meeting (e.g. after "Adjust my terms") starts on a clean globe. Not on resume (prev null),
      // where this table's history has just been drawn.
      if (prev && prev !== "BRIEFING") { globe.circle([]); globe.eraseArcs(); }
      await globe.stow(false, instant);
      if (next === "AT_TABLE" && prev === "BRIEFING" && !instant) sound.play("bell");
    }
    if (next === "DRY_RUN") {
      this.backCard.group.visible = false;
      if (this.seals.open) { this.seals.clear(); await globe.stow(false, instant); }
      this.turns.markShortlist();
      this.buildDryRun(s.shortlist, trip, instant);
    }
    if (next === "SEALING") {
      this.pickPending = false;
      const chosen = trip.chosenPlanId ? this.cloches.get(trip.chosenPlanId) : undefined;
      if (!instant && chosen) await chosen.lift();
      if (!instant) await Promise.all([...this.cloches.values()].map((c) => c.slideBack()));
      this.clearDryRun();
      await globe.stow(true, instant);
      this.seals.openChart(trip, instant);
    }
    if (next === "BOOKED") {
      if (!this.seals.open) { this.clearDryRun(); await globe.stow(true, true); this.seals.openChart(trip, true); } // resumed straight into BOOKED
      this.seals.sync(s.booking, true);
      // booking.reference is in the snapshot too, so a headset resumed into BOOKED still has it (TR3-003)
      await this.seals.tie(s.lastResult?.reference ?? s.booking?.reference ?? trip.booking?.reference, instant);
      if (!instant) sound.play("bell", { strikes: 2 });
      const city = s.shortlist.find((p) => p.planId === trip.chosenPlanId)?.cityId;
      if (city) {
        globe.eraseArcs((k) => !k.endsWith(`>${city}`));
        globe.drawArc(HOME_PORT.id, city, "ink", instant); // S2-002: from the home port
        globe.inkAllArcs();
      }
    }
    if (next === "VOIDED") {
      if (this.seals.open && !instant) await this.seals.voidAll();
      this.backCard.group.visible = opts.controls;
    }
  }

  /**
   * Fresh cloches every time. DRY_RUN is only entered from AT_TABLE or VOIDED (server: table.ts / sealing.ts), and
   * every way out of it (AT_TABLE/BRIEFING, SEALING, a resume into BOOKED) already disposed them, so there is never a
   * set to reuse; the old "same shortlist, reuse the cloches" branch could not run and was removed.
   */
  private buildDryRun(shortlist: PlanPublic[], trip: TripState, instant: boolean) {
    this.clearDryRun();
    shortlist.slice(0, 2).forEach((plan, i) => {
      const cl = new DryRunCloche(this.ctx.tweens, plan, trip.crew, i === 0 ? -1 : 1);
      this.ctx.root.add(cl.group);
      this.cloches.set(plan.planId, cl);
      void cl.slideOut(instant);
    });
    this.syncTiles();
    this.ctx.targetsChanged();
    if (!instant) sound.play("clink");
    this.ctx.clock.group.visible = true;
    this.ctx.clock.setMinute(this.ctx.store.dryrunMinute() ?? DRYRUN_DAY_START_MIN, this.dayLabel());
  }

  private photorealOn() { return tilesAvailable() && (this.ctx.opts.photoreal?.() ?? true); }

  /** Start or drop the photoreal tiles to match the "Photoreal cities" setting (the paper cities stay either way). */
  syncTiles() {
    if (!this.photorealOn()) {
      for (const t of this.tiles) t.dispose();
      this.tiles = [];
      return;
    }
    if (this.tiles.length || !this.cloches.size) return;
    for (const cl of this.cloches.values()) this.tiles.push(new CityTiles(cl, this.ctx.renderer));
  }

  private dayLabel() { return this.ctx.store.state.shortlist[0]?.days[0]?.label ?? DRYRUN_DAY1_LABEL; }

  private clearDryRun() {
    for (const t of this.tiles) t.dispose();
    this.tiles = [];
    const had = this.cloches.size > 0;
    for (const c of this.cloches.values()) c.dispose();
    this.cloches.clear();
    if (had) this.ctx.targetsChanged();
    this.pickPending = false;
    this.ctx.clock.group.visible = false;
  }

  /** Per frame: beads walk the in-trip minute, labels face the viewer (`camPos`, world space), the carriage clock
   *  follows the minute, tiles stream (they need the camera itself). */
  update(camera: THREE.Camera, camPos: THREE.Vector3) {
    if (!this.cloches.size && !this.tiles.length && !this.ctx.clock.group.visible) return;
    const min = this.ctx.store.dryrunMinute();
    for (const c of this.cloches.values()) c.update(min, camPos);
    if (min !== null && this.ctx.clock.group.visible) this.ctx.clock.setMinute(min, this.dayLabel());
    for (const t of this.tiles) t.update(camera, this.ctx.renderer);
  }

  dispose() {
    this.clearDryRun();
    this.seals.clear();
  }
}
