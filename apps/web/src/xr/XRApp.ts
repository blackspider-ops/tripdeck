// The headset app (doc 04 §9.1): WebXR immersive-ar with passthrough on Quest 3; immersive-vr on a phone in a
// Gear VR / Cardboard viewer (a virtual chart room, 3DoF gaze input — native WebXR or webxr-polyfill); on a laptop
// the very same chart room runs non-immersively with orbit controls so it can be built and tested.
import * as THREE from "three";
import { MAX_WATCHES, PALETTE, type TripState } from "@all-ayes/shared";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { TripStore } from "../net/tripStore";
import { Stage } from "../scene/Stage";
import { PaperButton, PaperMenu, type Interactable } from "../scene/Buttons";
import { disposeObject } from "../scene/materials";
import { sound } from "../scene/audio";
import { CARD, HAIL_PRESETS } from "../scene/copy";
import { TABLE_TARGET } from "../scene/layout";
import { Placement } from "./placement";
import { MouseInput, XRInput } from "./input";
import { WristMenu } from "./wristMenu";
import { DebugOverlay, installConsoleRelay } from "./debugOverlay";
import { GazeInput } from "./gaze";
import { LazyFollow, VRRig } from "./vrRig";
import { LENS_MM, ipdFromSearch, nextLensSpacing, vrBufferScale, type LensSpacing } from "./vrMode";
import { SidePanel, type SideOpts } from "./panel/SidePanel";
import { canPin, type Viewer } from "./panel/views";
import { alignYaw, rayOnPlane } from "./placement";
import { pinAt, type PinPort } from "./pins";
import { seatAngle } from "../shared-ui/seating";

/** The tag on the table's near-right edge that opens and closes the side panel (the log book). */
export const LOG_TAG_LABEL = "Log book";
/** The alignment step's card (Quest MR, after the chart is laid down). */
export const ALIGN_TITLE = "Pinch the table corner nearest you";
/** A held pinch on the globe pins the whole region (ms). */
export const REGION_HOLD_MS = 600;
/** A pinch that moves this far on the globe (m) is a spin, not a pin. */
const SPIN_SLOP_M = 0.012;

/** VR: the caption card floats ~1.5 m ahead at this scale (its body text is then ~1.1°, ~14 px on a Gear VR phone). */
const VR_CAPTION_SCALE = 1.7;
/** VR: menu and hail card float this far ahead of the eye, nearly level (clear of the gaze down at the table). */
const VR_CARD = { dist: 0.55, drop: 0.03 };
const PHOTOREAL = "Photoreal cities";
const photorealLabel = (on: boolean) => `${PHOTOREAL}: ${on ? "on" : "off"}`;
const LENS = "Lens spacing";
const lensLabel = (s: LensSpacing | "auto") => `${LENS}: ${s}`;
/** The plaque below the eyes that leaves VR (no Back button on an iPhone in a lens shell). */
export const EXIT_VR_LABEL = "Exit VR";
/** The tag on the table's near-left edge that opens the preset hails in VR. */
export const HAIL_TAG_LABEL = "Hail the table";

/**
 * The server takes a hail only while the mates are talking: AT_TABLE, running, from Watch 1 (the Captain's opening is
 * TABLE_OPENING) until the last Watch (then CAPTAINS_CALLING). R2-WP-07 / L2-005: offer the card and toolbar button
 * exactly then (table.ts `hail`).
 */
export function hailOpen(trip: TripState | null | undefined): boolean {
  if (trip?.status !== "AT_TABLE" || !trip.negotiation.running) return false;
  const w = trip.negotiation.watch;
  return w >= 1 && w < MAX_WATCHES;
}

/** Captions S / M / L. */
const CAPTION_SIZES = [
  { scale: 0.85, label: "S" },
  { scale: 1, label: "M" },
  { scale: 1.3, label: "L" },
] as const;

export class XRApp {
  readonly stage: Stage;
  private placement: Placement;
  private menu: WristMenu;
  private debug: DebugOverlay;
  private hailCard: PaperMenu;
  private session: XRSession | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private orbit: OrbitControls | null = null;
  private mouse: MouseInput | null = null;
  private input: XRInput;
  /** Hand-space listeners, removed on dispose. */
  private handsOff: (() => void)[] = [];
  private captionSize = 1; // index into CAPTION_SIZES
  private hailItems: readonly Interactable[];
  private menuItems: readonly Interactable[];
  private targetList: Interactable[] = [];
  private targetsFrom: readonly Interactable[] | null = null;
  private reduceMotion = false;
  /** "Photoreal cities" (Google 3D tiles in the Dry Run cloches). Off in VR by default so the demo stays smooth. */
  private photoreal = true;
  private unsubStore: () => void;
  /** The VR chart room while an immersive-vr session runs (Gear VR / Cardboard). */
  private vr: VRState | null = null;
  private gaze: GazeInput;
  /** VR only: a paper tag on the table that opens the hail card (no pinch-hold with a gaze). */
  private hailTag: PaperButton;
  /** VR only: look down at it (dwell) or tap while on it to leave VR. */
  private exitPlaque: PaperButton;
  private lensSpacing: LensSpacing = "normal";
  private wheelObject: THREE.Object3D;
  private headPos = new THREE.Vector3();
  private headQuat = new THREE.Quaternion();
  private rayOrigin = new THREE.Vector3();
  private rayQuat = new THREE.Quaternion();
  private rayDir = new THREE.Vector3();
  private wakeLock: { release(): Promise<void> } | null = null;
  /** The side panel beside the table (docs/03 §4): trip, crew, my terms, my seal, approvals. */
  readonly panel: SidePanel;
  private logTag: PaperButton;
  private alignCard: PaperMenu;
  /** Quest MR: the chart is down, waiting for "the table corner nearest you". */
  private alignPending = false;
  private viewer: Viewer;
  private pinPorts: PinPort[] | null = null;
  private pendingPin: string | null = null;
  private globePress: { at: THREE.Vector3; moved: boolean } | null = null;
  private lastAsk: string | null = null;
  onExit?: () => void;

  /** `gfx.antialias: false` on phones (XRPage decides from the user agent before the renderer exists). `vrMenu`: this
   *  browser may open the VR chart room (a phone, or `?vr=cardboard`), so the menu also gets "Photoreal cities" and
   *  "Lens spacing"; the Quest / laptop menu is unchanged. */
  constructor(container: HTMLElement, readonly store: TripStore, gfx: { antialias?: boolean; vrMenu?: boolean } = {},
    seat: { viewer: Viewer; rest?: SideOpts["rest"]; api?: SideOpts["api"]; ports?: () => Promise<PinPort[]> } = { viewer: { organizer: true } }) {
    this.stage = new Stage(container, store, { controls: true, voices: true, speechFallback: true, photoreal: () => this.photoreal }, true, gfx);
    const { scene, renderer, anchor } = this.stage;
    // Without this, three renders an immersive session with the flat desk camera (no stereo, no head
    // tracking) and never updates renderer.xr.getCamera(). Harmless while not presenting.
    renderer.xr.enabled = true;
    installConsoleRelay(store);

    this.viewer = seat.viewer;
    this.loadPorts = seat.ports ?? null;
    this.placement = new Placement(anchor);
    scene.add(this.placement.reticle);
    this.placement.onPlaced = () => {
      sound.play("paper");
      void this.stage.director.table.unroll();
      // Quest MR: line the chart up with the real table (co-located crews share its centre and turn it to their seat)
      if (this.session && !this.vr) this.startAlign();
    };

    const origin = typeof location !== "undefined" ? location.origin : "";
    this.panel = new SidePanel(store, { viewer: seat.viewer, rest: seat.rest, api: seat.api, host: typeof location !== "undefined" ? location.host : "", origin });
    scene.add(this.panel.group);
    this.logTag = new PaperButton(this.stage.tweens, LOG_TAG_LABEL, 0.12, 0.028);
    this.logTag.group.position.set(0.25, 0.03, 0.27);
    this.logTag.group.rotation.x = -0.75;
    anchor.add(this.logTag.group);
    this.alignCard = new PaperMenu(this.stage.tweens, ALIGN_TITLE, [
      { label: "Skip", onSelect: () => this.endAlign("Skipped. Recenter from the menu any time.") },
    ], 0.2);
    this.alignCard.group.position.set(0, 0.42, 0.05);
    this.alignCard.group.visible = false;
    anchor.add(this.alignCard.group);

    this.hailCard = this.buildHailCard();
    anchor.add(this.hailCard.group);
    this.menu = this.buildMenu(!!gfx.vrMenu);
    scene.add(this.menu.group);
    anchor.add(this.menu.wheel);

    this.debug = new DebugOverlay(store);
    this.debug.group.position.set(0.3, 0.14, -0.1);
    this.debug.group.rotation.y = -0.5;
    anchor.add(this.debug.group);

    this.hailTag = new PaperButton(this.stage.tweens, HAIL_TAG_LABEL, 0.13, 0.026);
    this.hailTag.group.position.set(-0.25, 0.03, 0.27);
    this.hailTag.group.rotation.x = -0.75;
    this.hailTag.group.visible = false;
    anchor.add(this.hailTag.group);
    this.exitPlaque = new PaperButton(this.stage.tweens, EXIT_VR_LABEL, 0.16, 0.04, true);
    this.exitPlaque.group.visible = false;

    this.hailItems = [
      ...this.panel.interactables(() => this.eye()),
      { object: this.logTag.hit, enabled: () => this.placement.placed && !this.alignPending, onSelect: () => { void this.logTag.press(); this.togglePanel(); } },
      ...this.alignCard.interactables(() => this.alignCard.group.visible),
      this.globeTarget(),
      ...this.hailCard.interactables(() => this.hailCard.group.visible),
      { object: this.hailTag.hit, enabled: () => !!this.vr && this.canHail() && !this.hailCard.group.visible, onSelect: () => this.openHail() },
      { object: this.exitPlaque.hit, enabled: () => !!this.vr, onSelect: () => this.exit() },
    ];
    this.menuItems = this.menu.interactables();
    this.wheelObject = this.menuItems[0].object;
    this.input = this.wireInput();
    this.gaze = new GazeInput({
      getTargets: this.targets,
      win: window,
      // the brass wheel: a long press or a long gaze recenters (a tap or a dwell opens the menu)
      longAction: (t) => (t.object === this.wheelObject ? () => { this.menu.toggle(false); this.recenter(); } : null),
      onEmptyLongPress: () => this.openHail(),
      onBack: () => this.exit(),
    });

    this.stage.onFrame((dt, frame) => {
      if (this.session && this.vr) {
        this.vrFrame(dt, frame);
      } else if (this.session) {
        const cam = renderer.xr.getCamera();
        this.placement.update(frame, this.refSpace);
        this.input.update();
        this.menu.update(cam, renderer.xr.getHand(0).userData.handedness === "left" ? renderer.xr.getHand(0) : renderer.xr.getHand(1));
        // fall back to placing in front of the user if no table was found
        if (!this.placement.placed && this.placement.canFallback && !this.placement.reticle.visible) void this.placement.place(cam);
      }
      this.orbit?.update();
      this.stage.director.globe.tickSpin(dt);
      this.panel.update();
      this.debug.update(dt, this.stage.fps, renderer.info.render.calls);
    });

    this.unsubStore = store.subscribe(() => {
      // a headset seat has the organizer's controls only if it is the organizer's seat
      if (this.viewer.memberId) this.viewer.organizer = store.state.trip?.organizerId === this.viewer.memberId;
      // the hail card only makes sense while the Captain is still listening (else CAPTAINS_CALLING)
      if (this.hailCard.group.visible && !this.canHail()) this.hailCard.group.visible = false;
      // a headset asking to sit in my seat: the panel opens on it (one tap to answer)
      const ask = store.state.headsetRequest?.requestId ?? null;
      if (ask && ask !== this.lastAsk && this.viewer.memberId && this.placement.placed) this.panel.show(this.panel.state.tab, this.stage.anchor, this.eye());
      this.lastAsk = ask;
    });

    for (let i = 0; i < 2; i++) {
      const hand = renderer.xr.getHand(i);
      const onConnected = (e: unknown) => { hand.userData.handedness = (e as { data: XRInputSource }).data.handedness; };
      hand.addEventListener("connected", onConnected);
      scene.add(hand);
      this.handsOff.push(() => { hand.removeEventListener("connected", onConnected); hand.removeFromParent(); });
    }
  }

  /** The hail card: the presets, then "Never mind". */
  private buildHailCard() {
    const card = new PaperMenu(this.stage.tweens, CARD.hailTitle, [
      ...HAIL_PRESETS.map((h) => ({ label: h, onSelect: () => { this.store.emit("table:hail", { text: h }); card.group.visible = false; } })),
      { label: CARD.hailCancel, onSelect: () => { card.group.visible = false; } },
    ], 0.22);
    card.group.position.set(0, 0.16, 0.34);
    card.group.rotation.x = -0.35;
    card.group.visible = false;
    return card;
  }

  /** The chart-room menu and what each item does. */
  private buildMenu(vrMenu: boolean) {
    const vrItems = vrMenu ? {
      photoreal: () => { this.setPhotoreal(!this.photoreal); return photorealLabel(this.photoreal); },
      photorealLabel: photorealLabel(true),
      lens: () => this.cycleLens(),
      lensLabel: lensLabel("normal"),
    } : {};
    return new WristMenu(this.stage.tweens, {
      ...vrItems,
      recenter: () => this.recenter(),
      captions: () => {
        this.captionSize = (this.captionSize + 1) % CAPTION_SIZES.length;
        const size = CAPTION_SIZES[this.captionSize];
        this.stage.director.table.caption.setScale(size.scale);
        return `Captions: ${size.label}`;
      },
      motion: () => { this.reduceMotion = !this.reduceMotion; this.stage.tweens.speed = this.reduceMotion ? 2 : 1; return `Reduce motion: ${this.reduceMotion ? "on" : "off"}`; },
      sound: () => { sound.sfxMuted = !sound.sfxMuted; sound.voiceMuted = sound.sfxMuted; return `Sound: ${sound.sfxMuted ? "off" : "on"}`; },
      debug: () => { this.debug.group.visible = !this.debug.group.visible; return `Debug: ${this.debug.group.visible ? "on" : "off"}`; },
      exit: () => this.exit(),
    });
  }

  /** Controllers and hands: select to act or lay the chart down, hold for the hail card, squeeze for the menu. */
  private wireInput() {
    const { renderer, scene } = this.stage;
    const input = new XRInput(renderer, scene, this.targets);
    input.onEmptySelect = (ray) => {
      if (!this.session) return;
      if (this.alignPending) { this.alignTo(ray); return; }
      // not down yet, or adjusting after a recenter: lay it at the ring
      if (!this.placement.placed || this.placement.adjusting) void this.placement.place(renderer.xr.getCamera());
    };
    input.onLongPress = () => {
      if (!this.placement.placed && this.session) void this.placement.place(renderer.xr.getCamera());
      else if (!this.alignPending) this.openHail();
    };
    input.onSqueeze = () => this.menu.toggle(undefined, renderer.xr.getCamera());
    return input;
  }

  /** Everything selectable, shared by both inputs; rebuilt only when the director's list changes. */
  private targets = (): readonly Interactable[] => {
    const director = this.stage.director.interactables;
    if (director !== this.targetsFrom) {
      this.targetsFrom = director;
      this.targetList = [...director, ...this.hailItems, ...this.menuItems];
    }
    return this.targetList;
  };

  private canHail() { return hailOpen(this.store.state.trip); }

  /** Menu "Lens spacing": narrow → normal → wide (webxr-polyfill's Cardboard lens profile; applied at once). A native
   *  WebXR browser sets its own viewer up, so there it reads "auto". */
  private cycleLens(): string {
    if (!this.vr?.polyfilled && this.vr) return lensLabel("auto");
    this.lensSpacing = nextLensSpacing(this.lensSpacing);
    const s = this.lensSpacing;
    void import("./cardboard").then((m) => m.setLensSpacing(s)).catch(() => undefined);
    const custom = s === "normal" ? ipdFromSearch(window.location.search) : null;
    return lensLabel(s) + (custom ? ` (${custom} mm)` : s === "normal" ? "" : ` (${LENS_MM[s]} mm)`);
  }

  private setPhotoreal(on: boolean) {
    this.photoreal = on;
    this.menu.setLabel(PHOTOREAL, photorealLabel(on));
    this.stage.director.photorealChanged();
  }

  /** Menu "Recenter" / long press or long gaze on the brass wheel. AR: find the table again. VR: turn the room to
   *  face the head (next frame, from its pose). Laptop: put the chart back. */
  recenter() {
    this.menu.toggle(false);
    if (this.vr) { this.vr.recenterPending = true; return; }
    if (!this.session) { this.deskPlace(); this.stage.director.note("Chart recentred."); return; }
    // mixed reality: the chart comes straight back in front, on the table height it had (never hidden, L-recenter);
    // the ring then looks for the table again and a pinch lays it exactly there
    this.placement.recenter(this.stage.renderer.xr.getCamera(), this.session);
    this.stage.director.note("Chart recentred in front of you. Pinch the table to set it down exactly there.");
  }

  /** The viewer's eye (world), for billboards and the panel. */
  private eye(): THREE.Vector3 {
    const cam = this.session ? this.stage.renderer.xr.getCamera() : this.stage.camera;
    return cam.getWorldPosition(new THREE.Vector3());
  }

  togglePanel() { this.panel.toggle(this.stage.anchor, this.eye()); sound.play("paper"); }

  /** Entering the chart room: the organizer's panel opens on the trip (the join QR and code) while the crew musters. */
  private openStartPanel() {
    const t = this.store.state.trip;
    if (this.viewer.organizer && t?.status === "BRIEFING" && !this.panel.open) this.panel.show("trip", this.stage.anchor, this.eye());
  }

  // ---------- Quest MR alignment (docs/03 §4) ----------
  private startAlign() {
    this.alignPending = true;
    this.alignCard.group.visible = true;
    this.stage.director.note("Pinch the table corner nearest you, so everyone's chart lines up.");
  }
  private endAlign(say: string) {
    this.alignPending = false;
    this.alignCard.group.visible = false;
    this.stage.director.note(say);
    this.openStartPanel();
  }
  /** The corner pinch: turn the chart so this viewer's seat points at that corner. */
  alignTo(ray: THREE.Ray): boolean {
    const a = this.stage.anchor;
    const corner = rayOnPlane(ray, a.position.y);
    if (!corner) return false;
    if (corner.distanceTo(a.position) < 0.15) { this.stage.director.note("That's the middle of the chart. Pinch a corner of the table."); return false; }
    this.placement.setYaw(alignYaw(a.position, corner, this.viewerSeatDeg()));
    sound.play("click");
    this.endAlign("Lined up. Your piece is on your side of the table.");
    return true;
  }
  private viewerSeatDeg(): number {
    const t = this.store.state.trip;
    if (!t) return 90;
    return seatAngle(t.crew, t.organizerId, this.viewer.memberId ?? t.organizerId);
  }

  // ---------- the globe: hand spin and pins ----------
  private loadPorts: (() => Promise<PinPort[]>) | null;
  private globeTarget(): Interactable {
    const globe = this.stage.director.globe;
    return {
      object: globe.sphere,
      enabled: () => this.placement.placed && !this.alignPending,
      onPress: (_ray, hit) => { globe.grabSpin(hit.point); this.globePress = { at: hit.point.clone(), moved: false }; },
      onDrag: (ray) => {
        const p = globe.rayPoint(ray);
        if (this.globePress && p.distanceTo(this.globePress.at) > SPIN_SLOP_M) this.globePress.moved = true;
        if (this.globePress?.moved) globe.dragSpin(p);
      },
      onRelease: (_ray, held) => {
        const press = this.globePress;
        this.globePress = null;
        globe.releaseSpin();
        if (!press) return false;
        if (!press.moved) void this.pinAtPoint(press.at, held >= REGION_HOLD_MS);
        return true; // handled here (a pin or a spin), never also a select
      },
      // gaze (the VR chart room): a dwell on the globe pins
      onSelect: (hit) => { if (hit) void this.pinAtPoint(hit.point, false); },
    };
  }

  /** A pinch at this spot on the globe: pin, unpin, or the region (canPin: the organizer, or the crew if allowed). */
  async pinAtPoint(point: THREE.Vector3, long: boolean) {
    const s = this.store.state;
    const trip = s.trip;
    if (!trip) return;
    if (!canPin(s, this.viewer)) {
      if (trip.status === "BRIEFING") this.stage.director.note("Only the organizer pins the chart. Ask them to let the crew pin.");
      return;
    }
    const at = this.stage.director.globe.latLngAt(point);
    if (!this.pinPorts) this.pinPorts = this.loadPorts ? await this.loadPorts().catch(() => []) : [];
    const r = pinAt(at, long, trip, this.pinPorts, this.pendingPin);
    this.stage.director.note(r.say);
    if (r.kind === "pending") { this.pendingPin = r.cityId; sound.play("pencil"); return; }
    if (r.kind === "note") return;
    this.pendingPin = null;
    sound.play("click");
    this.store.emit("course:set", { destination: r.destination }, (ack) => { if (!ack.ok) this.stage.director.note(ack.message); });
  }

  static async arSupported(): Promise<boolean> {
    try { return !!(await navigator.xr?.isSessionSupported("immersive-ar")); } catch { return false; }
  }

  /**
   * Enter the VR chart room (Gear VR / Cardboard; native immersive-vr or webxr-polyfill). Must be called from a user
   * gesture: requestSession is the first await. 3DoF: reference space 'local' (origin = the eye at the start).
   */
  async enterVR(polyfilled: boolean) {
    const { renderer, scene, anchor } = this.stage;
    const session = await navigator.xr!.requestSession("immersive-vr", { optionalFeatures: ["local"] });
    try {
      renderer.xr.setFramebufferScaleFactor(vrBufferScale(window.devicePixelRatio || 1));
    } catch { /* only while not presenting */ }
    renderer.xr.setReferenceSpaceType("local");
    try {
      await renderer.xr.setSession(session);
    } catch (e) {
      void session.end().catch(() => undefined);
      throw e;
    }
    this.session = session;
    this.refSpace = renderer.xr.getReferenceSpace();
    // a fixed 60 fps budget where the browser lets us choose (old Galaxy phones: 60 Hz panels anyway)
    const rates = (session as unknown as { supportedFrameRates?: Float32Array }).supportedFrameRates;
    if (rates && Array.from(rates).includes(60)) void session.updateTargetFrameRate?.(60).catch(() => undefined);

    // the room: floor, walls, a walnut table under the chart at a seated pose; the Gallery's background and lights
    const rig = new VRRig();
    scene.add(rig.group);
    rig.seat(anchor);
    rig.mountExit(this.exitPlaque.group);
    this.exitPlaque.group.visible = true;
    const background = scene.background;
    scene.background = new THREE.Color(PALETTE.room);
    renderer.setClearColor(PALETTE.room, 1);
    if (polyfilled) void import("./cardboard").then((m) => { this.lensSpacing = m.currentLensSpacing(); this.menu.setLabel(LENS, lensLabel(this.lensSpacing)); }).catch(() => undefined);
    else this.menu.setLabel(LENS, lensLabel("auto"));
    scene.remove(this.placement.reticle);
    this.placement.placed = true;
    this.input.enabled = false;
    scene.add(this.gaze.reticle);
    this.gaze.attach(session);

    // captions: off the table's edge, floating ahead at reading size
    const cap = this.stage.director.table.caption.group;
    const capHome = { parent: cap.parent, pos: cap.position.clone(), rot: cap.rotation.clone(), scale: cap.scale.clone() };
    scene.add(cap);
    cap.scale.setScalar(VR_CAPTION_SCALE);
    this.captionOnTop(cap, true);
    // hail card and menu float in front, level (clear of the gaze at the table)
    const hail = this.hailCard.group;
    const hailHome = { parent: hail.parent, pos: hail.position.clone(), rot: hail.rotation.clone() };
    scene.add(hail);
    const menuPlacement = { ...this.menu.placement };
    this.menu.placement = { ...VR_CARD };
    this.setPhotoreal(false);
    this.hailTag.group.visible = this.canHail();

    const follow = new LazyFollow(cap);
    const onPop = () => { if (this.session === session) this.exit(); };
    // the browser drops a wake lock when the page is hidden: take a new one when it's back
    const onVisible = () => { if (document.visibilityState === "visible" && this.session === session) { this.wakeLock = null; void this.keepAwake(); } };
    // Android Back leaves VR (not the page): a history entry to pop
    try { history.pushState({ ...(history.state ?? {}), aaVr: true }, ""); } catch { /* sandboxed */ }
    window.addEventListener("popstate", onPop);
    document.addEventListener("visibilitychange", onVisible);
    void this.keepAwake();
    try { void (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.("landscape")?.catch(() => undefined); } catch { /* not allowed */ }

    this.vr = { rig, follow, polyfilled, recenterPending: true };
    void this.stage.director.table.unroll();
    this.openStartPanel();

    session.addEventListener("end", () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("visibilitychange", onVisible);
      void this.wakeLock?.release().catch(() => undefined);
      this.wakeLock = null;
      try { (screen.orientation as unknown as { unlock?: () => void }).unlock?.(); } catch { /* ditto */ }
      try { if ((history.state as { aaVr?: boolean } | null)?.aaVr) history.back(); } catch { /* ditto */ }
      this.gaze.detach();
      this.input.enabled = true;
      // hand the chart, captions and cards back to the table (the laptop view can open next)
      scene.add(anchor);
      anchor.scale.setScalar(1);
      this.exitPlaque.group.visible = false;
      this.exitPlaque.group.removeFromParent();
      rig.dispose();
      scene.background = background;
      renderer.setClearColor(0x000000, 0);
      this.captionOnTop(cap, false);
      if (capHome.parent) capHome.parent.add(cap);
      cap.position.copy(capHome.pos); cap.rotation.copy(capHome.rot); cap.scale.copy(capHome.scale);
      if (hailHome.parent) hailHome.parent.add(hail);
      hail.position.copy(hailHome.pos); hail.rotation.copy(hailHome.rot);
      this.menu.placement = menuPlacement;
      this.hailTag.group.visible = false;
      this.vr = null;
      this.session = null;
      this.refSpace = null;
      this.hailCard.group.visible = false;
      this.menu.toggle(false);
      this.onExit?.();
    });
  }

  /**
   * VR: the caption card floats 1.5 m out, beyond the table, so it is drawn over the scene (no depth test) instead of
   * vanishing behind the globe. Troika texts own their (derived) material, so that is flipped in place; the card's
   * plain paper material is shared, so the card gets a clone while in VR.
   */
  private captionOnTop(cap: THREE.Object3D, on: boolean) {
    if (!on) {
      for (const r of this.captionUndo) r();
      this.captionUndo = [];
      return;
    }
    let order = 990;
    cap.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const prevOrder = m.renderOrder;
      m.renderOrder = order++;
      if (isTroikaText(o)) {
        const mat = m.material as THREE.Material;
        mat.depthTest = false;
        mat.depthWrite = false;
        this.captionUndo.push(() => { const now = m.material as THREE.Material; now.depthTest = true; now.depthWrite = true; m.renderOrder = prevOrder; });
      } else {
        const prev = m.material;
        const mat = (prev as THREE.Material).clone();
        mat.depthTest = false;
        mat.depthWrite = false;
        m.material = mat;
        this.captionUndo.push(() => { m.material = prev; mat.dispose(); m.renderOrder = prevOrder; });
      }
    });
  }
  private captionUndo: (() => void)[] = [];

  /** Keep the phone's screen on while in the headset (Screen Wake Lock; older browsers: the polyfill's video). */
  private async keepAwake() {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && !this.wakeLock) this.wakeLock = await wl.request("screen");
    } catch { this.wakeLock = null; }
  }

  /** Per VR frame: head pose → recenter (when asked), the gaze ray and reticle, the lazy caption. */
  private vrFrame(dt: number, frame?: XRFrame) {
    const vr = this.vr!;
    const ref = this.refSpace;
    this.menu.update(this.stage.renderer.xr.getCamera(), null); // remembers the camera the wheel opens the menu along
    this.hailTag.group.visible = this.canHail();
    const pose = frame && ref ? frame.getViewerPose(ref) : null;
    if (!pose) return;
    const { position: p, orientation: o } = pose.transform;
    this.headPos.set(p.x, p.y, p.z);
    this.headQuat.set(o.x, o.y, o.z, o.w);
    // a 'gaze' input source (native Cardboard) if there is one, else the viewer itself
    let ray: XRPose | undefined | null = null;
    for (const src of this.session?.inputSources ?? []) {
      if (src.targetRayMode === "gaze") { ray = frame!.getPose(src.targetRaySpace, ref!); break; }
    }
    const t = ray?.transform ?? pose.transform;
    this.rayOrigin.set(t.position.x, t.position.y, t.position.z);
    this.rayQuat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
    this.rayDir.set(0, 0, -1).applyQuaternion(this.rayQuat);
    if (vr.recenterPending) {
      vr.recenterPending = false;
      vr.rig.recenter(this.headPos, this.headQuat);
      vr.follow.reset();
    }
    this.gaze.update(this.rayOrigin, this.rayDir, this.headQuat);
    vr.follow.update(dt, this.headPos, this.headQuat);
  }

  /** Float a card in front of the head, nearly level, facing it (VR menu / hail card). */
  private placeAhead(obj: THREE.Object3D) {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.headQuat);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    obj.position.copy(this.headPos).addScaledVector(fwd, VR_CARD.dist);
    obj.position.y -= VR_CARD.drop;
    obj.rotation.set(0, 0, 0);
    obj.lookAt(this.headPos.x, obj.position.y, this.headPos.z);
  }

  get inVR() { return !!this.vr; }

  /** Enter mixed reality. Must be called from a user gesture. */
  async enterAR() {
    const { renderer } = this.stage;
    const session = await navigator.xr!.requestSession("immersive-ar", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["plane-detection", "hit-test", "anchors", "hand-tracking"],
    });
    renderer.xr.setReferenceSpaceType("local-floor");
    await renderer.xr.setSession(session);
    renderer.setClearColor(0x000000, 0); // transparent → passthrough visible
    renderer.xr.setFoveation(1);
    this.session = session;
    this.refSpace = renderer.xr.getReferenceSpace();
    session.addEventListener("end", () => {
      this.session = null;
      this.refSpace = null;
      this.alignPending = false;
      this.alignCard.group.visible = false;
      this.placement.adjusting = false;
      this.placement.stop();
      this.hailCard.group.visible = false;
      this.menu.toggle(false);
      this.onExit?.();
    });
    await this.placement.start(session);
  }

  /** Laptop fallback: same scene, orbit controls, mouse selection. */
  startDesk() {
    const { camera, renderer, scene } = this.stage;
    this.stage.addRoom();
    scene.remove(this.placement.reticle);
    this.deskPlace();
    this.menu.deskCamera = camera; // L2-001: the menu opens along the orbit camera's view, pitch included
    // the mouse listens first, so a press on the globe or the panel's bar can hold the orbit camera still
    this.mouse = new MouseInput(renderer.domElement, camera, this.targets);
    this.mouse.onLongPress = () => this.openHail();
    this.mouse.onDragging = (on) => { if (this.orbit) this.orbit.enabled = !on; };
    this.orbit = new OrbitControls(camera, renderer.domElement);
    this.orbit.target.copy(TABLE_TARGET);
    this.orbit.enableDamping = true;
    this.orbit.minDistance = 0.3;
    this.orbit.maxDistance = 2.2;
    this.orbit.maxPolarAngle = Math.PI * 0.48;
    this.openStartPanel();
  }

  private deskPlace() {
    this.stage.anchor.scale.setScalar(1);
    this.stage.anchor.position.set(0, 0, 0);
    this.stage.anchor.rotation.set(0, 0, 0);
    this.stage.anchor.visible = true;
    this.placement.placed = true;
    void this.stage.director.table.unroll();
  }

  toggleMenu() { this.menu.toggle(undefined, this.stage.camera); }

  /** The hail card, when the helm takes a hail (toolbar button, long press). */
  openHail() {
    if (!this.canHail()) return;
    if (this.vr) { this.menu.toggle(false); this.placeAhead(this.hailCard.group); }
    this.hailCard.group.visible = true;
    sound.play("pencil");
  }

  exit() {
    this.menu.toggle(false);
    this.hailCard.group.visible = false;
    if (this.session) { void this.session.end(); return; }
    // laptop view: stop listening to the canvas until the chart room is opened again
    this.menu.deskCamera = null;
    this.mouse?.dispose();
    this.mouse = null;
    this.orbit?.dispose();
    this.orbit = null;
    this.onExit?.();
  }

  dispose() {
    this.unsubStore();
    this.mouse?.dispose();
    this.orbit?.dispose();
    if (this.session) void this.session.end().catch(() => undefined);
    // O2-053 / L2-007: everything outside the director's root — the hail card, menu and wheel, debug card (and its
    // store tap), placement reticle, controller rays and hand listeners — is freed here, not left to context loss
    this.input.dispose();
    this.gaze.dispose();
    for (const off of this.handsOff) off();
    this.menu.dispose();
    this.debug.dispose();
    this.panel.dispose();
    for (const o of [this.hailCard.group, this.hailTag.group, this.exitPlaque.group, this.placement.reticle, this.logTag.group, this.alignCard.group]) { o.removeFromParent(); disposeObject(o); }
    this.stage.dispose();
  }
}

/** A troika-three-text Text (its `material` is its own derived one; cloning that breaks the SDF shader). */
function isTroikaText(o: THREE.Object3D): boolean {
  const t = o as unknown as { sync?: unknown; text?: unknown };
  return typeof t.sync === "function" && typeof t.text === "string";
}

interface VRState {
  rig: VRRig;
  follow: LazyFollow;
  polyfilled: boolean;
  /** Turn the room to the head on the next frame (entry, menu "Recenter", long press / long gaze on the wheel). */
  recenterPending: boolean;
}
