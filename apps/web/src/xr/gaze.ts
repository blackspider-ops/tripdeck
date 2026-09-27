// 3DoF gaze input for the VR chart room (Gear VR / Cardboard): a reticle at the centre of the view, a ray from the
// viewer (or a 'gaze' input source), and four ways to select what it rests on:
//   - the XR session's `select` (native Cardboard: a screen tap / the viewer's button)
//   - a tap / click on the page (webxr-polyfill; the Gear VR touchpad arrives as a tap)
//   - Enter or Space
//   - dwell: rest the reticle on a target for DWELL_MS while its ring fills; it fires once, and not again until the
//     gaze leaves the target and comes back
// A long press (tap held ≥ LONG_PRESS_MS) or a long gaze (LONG_GAZE_MS) on a target with a long action — the brass
// wheel: Recenter — runs that instead. Back / Escape exits.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import type { Interactable } from "../scene/Buttons";
import { pickTarget, sameTarget } from "./input";

export const DWELL_MS = 1600;
export const LONG_GAZE_MS = 3200;
export const LONG_PRESS_MS = 700;
/** One physical press can reach us twice (a session `select` and a page tap, or a tap then its click). */
export const SELECT_DEDUPE_MS = 250;

// ---------------------------------------------------------------- dwell (pure)

export interface DwellState {
  /** What the gaze rests on (compared by identity; pass the picked mesh). */
  target: unknown;
  since: number;
  fired: boolean;
  longFired: boolean;
}

export function newDwell(): DwellState { return { target: null, since: 0, fired: false, longFired: false }; }

export interface DwellStep {
  /** 0…1 while the ring fills; 1 once fired. */
  progress: number;
  /** 0…1 for the second (long-gaze) ring; only for targets with a long action. */
  longProgress: number;
  /** Fire the target's select now (at most once per visit). */
  fire: boolean;
  /** Fire the target's long action now (at most once per visit). */
  long: boolean;
}

/**
 * Advance the dwell timer. A new target (or none) restarts it; a target fires once after `dwellMs`, then its long
 * action once after `longMs` if it has one; nothing fires again until the gaze leaves and returns.
 */
export function stepDwell(s: DwellState, target: unknown, now: number, hasLong = false, dwellMs = DWELL_MS, longMs = LONG_GAZE_MS): DwellStep {
  if (target !== s.target) {
    s.target = target;
    s.since = now;
    s.fired = false;
    s.longFired = false;
  }
  if (target == null) return { progress: 0, longProgress: 0, fire: false, long: false };
  const t = now - s.since;
  let fire = false, long = false;
  if (!s.fired && t >= dwellMs) { s.fired = true; fire = true; }
  if (hasLong && s.fired && !s.longFired && t >= longMs) { s.longFired = true; long = true; }
  return {
    progress: s.fired ? 1 : Math.max(0, Math.min(1, t / dwellMs)),
    longProgress: hasLong && s.fired && !s.longFired ? Math.max(0, Math.min(1, (t - dwellMs) / (longMs - dwellMs))) : s.longFired ? 1 : 0,
    fire,
    long,
  };
}

/** A tap/select already acted on this target: don't let the dwell fire it again during this visit. */
export function markFired(s: DwellState, target: unknown) {
  if (s.target === target) s.fired = true;
}

// ---------------------------------------------------------------- the input

type EventSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface GazeOptions {
  /** Everything selectable (the same list the controllers and the mouse use). */
  getTargets: () => readonly Interactable[];
  /** Where page taps and keys come from (window). */
  win: EventSource;
  /** A long action for this target (the wheel → Recenter), if any. */
  longAction?: (t: Interactable) => (() => void) | null;
  onEmptySelect?: () => void;
  onEmptyLongPress?: () => void;
  onBack?: () => void;
  now?: () => number;
}

/** Reticle + dwell ring (drawn on top of everything) and the select dispatch. */
export class GazeInput {
  readonly reticle = new THREE.Group();
  hover: Interactable | null = null;
  enabled = false;
  private raycaster = new THREE.Raycaster();
  private dwell = newDwell();
  private lastSelect = -Infinity;
  private downAt: number | null = null;
  private dot: THREE.Mesh;
  private ring: THREE.Mesh;
  private fill: THREE.Mesh;
  private longFill: THREE.Mesh;
  private dotMat: THREE.MeshBasicMaterial;
  private session: XRSession | null = null;
  private now: () => number;
  /** Where the gaze ray last met its target (a side panel's control, a spot on the globe). */
  private lastHit: THREE.Intersection | undefined;

  constructor(private opts: GazeOptions) {
    this.now = opts.now ?? (() => performance.now());
    const onTop = (color: string, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.dotMat = onTop(PALETTE.paper, 0.9);
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(0.006, 16), this.dotMat);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.014, 0.017, 40), onTop(PALETTE.paper, 0.35));
    // fill rings: a draw range over the ring's (theta-ordered) triangles shows the progress, no per-frame geometry
    this.fill = new THREE.Mesh(new THREE.RingGeometry(0.0135, 0.0175, 40, 1, Math.PI / 2, -Math.PI * 2), onTop(PALETTE.soundingRed));
    this.longFill = new THREE.Mesh(new THREE.RingGeometry(0.019, 0.0215, 40, 1, Math.PI / 2, -Math.PI * 2), onTop(PALETTE.brass));
    for (const m of [this.dot, this.ring, this.fill, this.longFill]) { m.renderOrder = 1000; m.frustumCulled = false; this.reticle.add(m); }
    this.reticle.visible = false;
    this.setFill(this.fill, 0);
    this.setFill(this.longFill, 0);
    opts.win.addEventListener("pointerdown", this.onPointerDown);
    opts.win.addEventListener("pointerup", this.onPointerUp);
    opts.win.addEventListener("pointercancel", this.onPointerCancel);
    opts.win.addEventListener("keydown", this.onKey);
  }

  /** Start listening to this session's `select` (native Cardboard / a gaze input source). */
  attach(session: XRSession | null) {
    this.session?.removeEventListener("select", this.onSessionSelect);
    this.session = session;
    session?.addEventListener("select", this.onSessionSelect);
    this.enabled = true;
    this.dwell = newDwell();
    this.downAt = null;
  }

  detach() {
    this.attach(null);
    this.enabled = false;
    this.hover = null;
    this.reticle.visible = false;
  }

  /**
   * Per frame: cast from `origin` along `dir` (world space), move the reticle, run the dwell timer.
   * The reticle rests on what it hits, or 1.5 m out; it is scaled with distance so it always looks the same size.
   */
  update(origin: THREE.Vector3, dir: THREE.Vector3, camQuat?: THREE.Quaternion) {
    if (!this.enabled) return;
    this.raycaster.ray.origin.copy(origin);
    this.raycaster.ray.direction.copy(dir).normalize();
    const found = pickTarget(this.raycaster, this.opts.getTargets());
    this.lastHit = found?.hit;
    const t = found?.target ?? null;
    // keep the wrapper stable while the same mesh is under the ray (lists may be rebuilt)
    if (!sameTarget(t, this.hover)) this.hover = t;
    const dist = found ? Math.max(0.2, found.hit.distance - 0.01) : 1.5;
    this.reticle.visible = true;
    this.reticle.position.copy(this.raycaster.ray.origin).addScaledVector(this.raycaster.ray.direction, dist);
    if (camQuat) this.reticle.quaternion.copy(camQuat);
    else this.reticle.lookAt(origin);
    this.reticle.scale.setScalar(dist);
    this.dotMat.color.set(this.hover ? PALETTE.soundingRed : PALETTE.paper);
    this.ring.visible = !!this.hover;

    const long = this.hover ? this.opts.longAction?.(this.hover) ?? null : null;
    const step = stepDwell(this.dwell, this.hover?.object ?? null, this.now(), !!long);
    this.setFill(this.fill, step.fire || this.dwell.fired ? 0 : step.progress);
    this.setFill(this.longFill, long ? step.longProgress : 0);
    if (step.fire && this.hover) this.hover.onSelect(this.lastHit);
    if (step.long && long) long();
  }

  /** Select what the reticle rests on (or the empty action). Returns false for a duplicate of the last press. */
  select(): boolean {
    const now = this.now();
    if (now - this.lastSelect < SELECT_DEDUPE_MS) return false;
    this.lastSelect = now;
    const h = this.hover;
    if (h && (h.enabled?.() ?? true)) {
      markFired(this.dwell, h.object);
      h.onSelect(this.lastHit);
    } else {
      this.opts.onEmptySelect?.();
    }
    return true;
  }

  /** A long press: the target's long action (wheel → Recenter), or the empty-space one (the hail card). */
  longPress() {
    const now = this.now();
    this.lastSelect = now;
    const h = this.hover;
    const long = h ? this.opts.longAction?.(h) ?? null : null;
    if (long) { markFired(this.dwell, h!.object); long(); }
    else if (!h) this.opts.onEmptyLongPress?.();
    else this.select();
  }

  private onSessionSelect = () => { if (this.enabled) this.select(); };

  private onPointerDown = (ev: Event) => {
    const e = ev as PointerEvent;
    if (!this.enabled || (e.button ?? 0) !== 0) return;
    this.downAt = this.now();
  };
  private onPointerUp = (ev: Event) => {
    const e = ev as PointerEvent;
    if (!this.enabled || (e.button ?? 0) !== 0 || this.downAt === null) return;
    const held = this.now() - this.downAt;
    this.downAt = null;
    if (held >= LONG_PRESS_MS) this.longPress();
    else this.select();
  };
  private onPointerCancel = () => { this.downAt = null; };

  private onKey = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (!this.enabled) return;
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault?.();
      if (!e.repeat) this.select();
    } else if (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack") {
      e.preventDefault?.();
      this.opts.onBack?.();
    }
  };

  private setFill(m: THREE.Mesh, p: number) {
    const g = m.geometry as THREE.BufferGeometry;
    const total = g.index ? g.index.count : 0;
    const n = Math.round(Math.max(0, Math.min(1, p)) * (total / 6)) * 6;
    g.setDrawRange(0, n);
    m.visible = n > 0;
  }

  dispose() {
    this.detach();
    this.opts.win.removeEventListener("pointerdown", this.onPointerDown);
    this.opts.win.removeEventListener("pointerup", this.onPointerUp);
    this.opts.win.removeEventListener("pointercancel", this.onPointerCancel);
    this.opts.win.removeEventListener("keydown", this.onKey);
    this.reticle.removeFromParent();
    this.reticle.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    });
  }
}
