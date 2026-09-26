// SceneDirector (doc 04 §9.3): the single place that turns server state/events into animation,
// so the headset and the Gallery behave identically. It rebuilds from `store.state` on resume.
//
// It owns the store subscription, the animation queue, the pickable list and the caption card; the work
// is split into parts under ./director (OPT-033):
//   CrewSeating     — crew pieces and their seats
//   TurnPlayer      — each line at the table (pose, globe, arcs, ribbon, voice)
//   PhaseController — phase choreography, the Dry Run cloches, the void card
//   SealCeremony    — the seal chart (owned by PhaseController)
import * as THREE from "three";
import { MAX_WATCHES, MIN_TABLE_CREW, PALETTE, type Turn } from "@all-ayes/shared";
import type { ClientState, TripStore } from "../net/tripStore";
import { ChartTable } from "./ChartTable";
import { Globe, HOME_PORT } from "./Globe";
import { CaptainPiece } from "./CrewPiece";
import { CompassTimer, CarriageClock } from "./Instruments";
import type { Interactable } from "./Buttons";
import { sound } from "./audio";
import { disposeObject } from "./materials";
import { CAPTAIN_POS, SEAT_Y } from "./seats";
import { NARRATOR } from "./copy";
import { CrewSeating } from "./director/CrewSeating";
import { TurnPlayer } from "./director/TurnPlayer";
import { PhaseController } from "./director/PhaseController";
import type { DirectorContext, DirectorOptions } from "./director/context";
import type { Tweens } from "./tween";
import { RESUME_WINDOW_MS } from "../phone/timing";

/** How long a server rejection stays on the caption card before the previous line returns. */
const NOTE_MS = 3000;
const CLOCK_POS = new THREE.Vector3(0, SEAT_Y, 0.135);

/** The slices of client state the table reacts to; anything else (audio, private data) is ignored. */
type Watched = Pick<ClientState, "trip" | "turns" | "votes" | "booking" | "error">;

export class SceneDirector {
  readonly root = new THREE.Group();
  readonly table: ChartTable;
  private globe: Globe;
  private compass: CompassTimer;
  private captain: CaptainPiece;
  private clock = new CarriageClock();
  /** Crew pieces and seats; the Gallery asks it where the speaker sits (`speakerPosition`). */
  readonly crew: CrewSeating;
  private turns: TurnPlayer;
  private phases: PhaseController;
  private ctx: DirectorContext;
  private firstStateAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private unsub: (() => void)[] = [];
  private disposed = false;
  private targets: Interactable[] | null = null; // built lazily; dropped when the cloches change
  private shownError: ClientState["error"] = null;
  private lastCaption: [string, string, string] | null = null;
  private captionSeq = 0;
  private noteTimer: ReturnType<typeof setTimeout> | undefined;
  private last: Watched | null = null;
  private lastPins: unknown = null;
  private homePort = false;
  /** The camera's world position, read once per frame for every billboard (O2-054). */
  private camPos = new THREE.Vector3();
  onCaption?: (speaker: string, text: string, color: string) => void;
  /** The line of turn `t` starts now (queued lines wait for the one being spoken), or is the latest one on resume. */
  onSpeaker?: (t: Turn) => void;

  constructor(private store: TripStore, private opts: DirectorOptions, renderer: THREE.WebGLRenderer, tweens: Tweens) {
    this.table = new ChartTable(tweens);
    this.globe = new Globe(tweens);
    this.compass = new CompassTimer(tweens);
    this.captain = new CaptainPiece(tweens);
    this.root.add(this.table.group, this.globe.group, this.compass.group, this.captain.group, this.clock.group);
    this.clock.group.position.copy(CLOCK_POS);
    this.clock.group.visible = false;
    this.clock.onHour = () => sound.play("tick");

    this.ctx = {
      store, opts, renderer, tweens,
      root: this.root, globe: this.globe, compass: this.compass, captain: this.captain, clock: this.clock,
      isResume: () => this.isResume,
      enqueue: (fn) => this.enqueue(fn),
      caption: (speaker, text, color) => this.caption(speaker, text, color),
      speaking: (t) => this.onSpeaker?.(t),
      targetsChanged: () => { this.targets = null; },
    };
    this.crew = new CrewSeating(this.ctx);
    this.turns = new TurnPlayer(this.ctx, this.crew);
    this.phases = new PhaseController(this.ctx, this.turns);

    this.unsub.push(this.store.subscribe(() => this.sync()));
    this.sync();
  }

  // ---------------------------------------------------------------- interaction

  /** Stable list (same array, same entries) until the cloches change, so input can compare and cache it. */
  get interactables(): Interactable[] {
    return (this.targets ??= this.buildInteractables());
  }

  private buildInteractables(): Interactable[] {
    const c = this.opts.controls;
    const st = () => this.store.state.trip?.status;
    return [
      // the whole Captain (its tag is a child): registering the tag too cast it twice per pointer per frame (O2-057)
      { object: this.captain.group, enabled: () => c && this.captain.tagVisible, onSelect: () => this.store.emit("table:start", {}) },
      { object: this.clock.hit, enabled: () => c && st() === "DRY_RUN", onSelect: () => this.toggleClock() },
      ...this.phases.targets(c, st),
    ];
  }

  /** The "Photoreal cities" setting changed: start or drop the tiles in any cloches on the table now. */
  photorealChanged() { this.phases.syncTiles(); }

  private toggleClock() {
    const d = this.store.state.dryrun;
    this.store.emit("dryrun:control", { action: d?.pausedAt ? "resume" : "pause" });
  }

  // ---------------------------------------------------------------- state → scene

  private get isResume() { return performance.now() - this.firstStateAt < RESUME_WINDOW_MS; }

  private enqueue(fn: () => Promise<void> | void) {
    this.chain = this.chain.then(async () => { if (!this.disposed) await fn(); }).catch((e) => {
      console.error("[scene]", e);
    });
  }

  /** True when none of the slices the table reacts to changed since the last sync (OPT-051). The store
   *  replaces a slice's object whenever it changes, so reference equality is enough. */
  private unchanged(s: ClientState): boolean {
    const l = this.last;
    const same = !!l && l.trip === s.trip && l.turns === s.turns && l.votes === s.votes && l.booking === s.booking && l.error === s.error;
    this.last = { trip: s.trip, turns: s.turns, votes: s.votes, booking: s.booking, error: s.error };
    return same;
  }

  private sync() {
    const s = this.store.state;
    const trip = s.trip;
    if (!trip || this.disposed) return;
    if (this.unchanged(s)) return; // e.g. turn:audioReady, private events, connection flaps
    if (!this.firstStateAt) this.firstStateAt = performance.now();
    const instant = this.isResume;

    if (this.lastPins !== trip.candidateCities) {
      this.lastPins = trip.candidateCities;
      this.globe.setPins(trip.candidateCities.map((c) => ({ id: c.cityId, name: c.name, lat: c.lat, lng: c.lng })));
    }
    if (trip.crew.length && !this.homePort) {
      this.homePort = true;
      this.globe.setOrigins([HOME_PORT]); // S2-002: one home port, never anyone's own airport
    }
    this.crew.sync(trip.crew, trip.organizerId, instant);

    const allSealed = trip.crew.length > 0 && trip.crew.every((c) => c.briefSealed);
    if (allSealed || trip.status !== "BRIEFING") void this.captain.rise(CAPTAIN_POS, instant);
    // the helm refuses to start with fewer than two crew (TOO_FEW), so don't offer it
    this.captain.showTag(trip.status === "BRIEFING" && allSealed && trip.crew.length >= MIN_TABLE_CREW && this.opts.controls);
    this.compass.setWatch(Math.min(MAX_WATCHES, trip.negotiation.watch), instant);

    this.turns.sync(s.turns, trip, instant);
    this.phases.sync(trip, s.turns.length > 0, instant);

    this.phases.setVotes(s.votes);
    this.phases.syncBooking(s.booking, instant);
    if (s.error && s.error !== this.shownError) { this.shownError = s.error; this.onRejected(s.error); }
    else if (!s.error) this.shownError = null;
  }

  /** The helm refused something this device sent: undo the optimistic lift and say why, briefly. */
  private onRejected(e: NonNullable<ClientState["error"]>) {
    this.phases.cancelPick();
    if (!this.opts.controls) return;
    const restore = this.lastCaption;
    this.table.caption.set(NARRATOR, e.message, PALETTE.soundingRed);
    const seq = ++this.captionSeq;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      if (this.disposed) return;
      if (seq === this.captionSeq && restore) this.table.caption.set(...restore);
      if (this.store.state.error === e) this.store.clearError();
    }, NOTE_MS);
  }

  private caption(speaker: string, text: string, color: string) {
    this.lastCaption = [speaker, text, color];
    this.captionSeq++; // a newer line replaces any rejection note
    this.table.caption.set(speaker, text, color);
    this.onCaption?.(speaker, text, color);
  }

  // ---------------------------------------------------------------- per frame

  update(camera: THREE.Camera) {
    camera.getWorldPosition(this.camPos);
    this.globe.update(this.camPos);
    this.captain.update(this.camPos);
    this.crew.update(this.camPos);
    this.phases.update(camera, this.camPos);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.noteTimer);
    for (const u of this.unsub) u();
    try { window.speechSynthesis?.cancel(); } catch { /* not supported */ }
    this.phases.dispose();
    this.turns.dispose();
    this.crew.dispose();
    this.root.removeFromParent();
    disposeObject(this.root); // chart, globe, pieces, text; shared textures/materials stay for the next Stage
  }
}
