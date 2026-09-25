// The headset app (doc 04 §9.1): WebXR immersive-ar with passthrough on Quest 3; on a laptop the
// very same chart room runs non-immersively with orbit controls so it can be built and tested.
import { MAX_WATCHES, type TripState } from "@all-ayes/shared";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { TripStore } from "../net/tripStore";
import { Stage } from "../scene/Stage";
import { PaperMenu, type Interactable } from "../scene/Buttons";
import { disposeObject } from "../scene/materials";
import { sound } from "../scene/audio";
import { CARD, HAIL_PRESETS } from "../scene/copy";
import { TABLE_TARGET } from "../scene/layout";
import { Placement } from "./placement";
import { MouseInput, XRInput } from "./input";
import { WristMenu } from "./wristMenu";
import { DebugOverlay, installConsoleRelay } from "./debugOverlay";

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
  private unsubStore: () => void;
  onExit?: () => void;

  constructor(container: HTMLElement, readonly store: TripStore) {
    this.stage = new Stage(container, store, { controls: true, voices: true, speechFallback: true }, true);
    const { scene, renderer, anchor } = this.stage;
    // Without this, three renders an immersive session with the flat desk camera (no stereo, no head
    // tracking) and never updates renderer.xr.getCamera(). Harmless while not presenting.
    renderer.xr.enabled = true;
    installConsoleRelay(store);

    this.placement = new Placement(anchor);
    scene.add(this.placement.reticle);
    this.placement.onPlaced = () => {
      sound.play("paper");
      void this.stage.director.table.unroll();
    };

    this.hailCard = this.buildHailCard();
    anchor.add(this.hailCard.group);
    this.menu = this.buildMenu();
    scene.add(this.menu.group);
    anchor.add(this.menu.wheel);

    this.debug = new DebugOverlay(store);
    this.debug.group.position.set(0.3, 0.14, -0.1);
    this.debug.group.rotation.y = -0.5;
    anchor.add(this.debug.group);

    this.hailItems = this.hailCard.interactables(() => this.hailCard.group.visible);
    this.menuItems = this.menu.interactables();
    this.input = this.wireInput();

    this.stage.onFrame((dt, frame) => {
      if (this.session) {
        const cam = renderer.xr.getCamera();
        this.placement.update(frame, this.refSpace);
        this.input.update();
        this.menu.update(cam, renderer.xr.getHand(0).userData.handedness === "left" ? renderer.xr.getHand(0) : renderer.xr.getHand(1));
        // fall back to placing in front of the user if no table was found
        if (!this.placement.placed && this.placement.canFallback && !this.placement.reticle.visible) void this.placement.place(cam);
      }
      this.orbit?.update();
      this.debug.update(dt, this.stage.fps, renderer.info.render.calls);
    });

    // the hail card only makes sense while the Captain is still listening (else CAPTAINS_CALLING)
    this.unsubStore = store.subscribe(() => { if (this.hailCard.group.visible && !this.canHail()) this.hailCard.group.visible = false; });

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
  private buildMenu() {
    return new WristMenu(this.stage.tweens, {
      recenter: () => { this.placement.reset(this.session); this.placement.placed = false; if (!this.session) this.deskPlace(); },
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
    input.onEmptySelect = () => { if (!this.placement.placed && this.session) void this.placement.place(renderer.xr.getCamera()); };
    input.onLongPress = () => {
      if (!this.placement.placed && this.session) void this.placement.place(renderer.xr.getCamera());
      else this.openHail();
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


  static async arSupported(): Promise<boolean> {
    try { return !!(await navigator.xr?.isSessionSupported("immersive-ar")); } catch { return false; }
  }

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
    this.orbit = new OrbitControls(camera, renderer.domElement);
    this.orbit.target.copy(TABLE_TARGET);
    this.orbit.enableDamping = true;
    this.orbit.minDistance = 0.3;
    this.orbit.maxDistance = 2.2;
    this.orbit.maxPolarAngle = Math.PI * 0.48;
    this.mouse = new MouseInput(renderer.domElement, camera, this.targets);
    this.mouse.onLongPress = () => this.openHail();
  }

  private deskPlace() {
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
    for (const off of this.handsOff) off();
    this.menu.dispose();
    this.debug.dispose();
    for (const o of [this.hailCard.group, this.placement.reticle]) { o.removeFromParent(); disposeObject(o); }
    this.stage.dispose();
  }
}
