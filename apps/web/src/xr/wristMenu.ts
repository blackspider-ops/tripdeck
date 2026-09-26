// Q5 — the always-available menu (doc 03 §4): palm up (left hand), squeeze a controller,
// or pinch the brass wheel on the chart's edge.
import * as THREE from "three";
import { PaperMenu, type Interactable } from "../scene/Buttons";
import { M, disposeObject, mergedGeometry, shadowDecal, sharedGeometry } from "../scene/materials";
import { CARD } from "../scene/copy";
import type { Tweens } from "../scene/tween";

/** The brass ship's wheel: rim + hub in one geometry, the eight spokes in another (was ten meshes, O2-056). */
let wheelGeo: { brass: THREE.BufferGeometry; spokes: THREE.BufferGeometry } | null = null;
function wheelGeometry() {
  if (wheelGeo) return wheelGeo;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.002, 6, 24));
  rim.rotation.x = Math.PI / 2;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.004, 10));
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.0009, 0.0009, 0.036, 5));
    spoke.rotation.z = Math.PI / 2;
    spoke.rotation.y = (i / 8) * Math.PI;
    return spoke;
  });
  return (wheelGeo = { brass: sharedGeometry(mergedGeometry([rim, hub])), spokes: sharedGeometry(mergedGeometry(spokes)) });
}

export interface MenuActions {
  recenter(): void;
  captions(): string;   // returns new label
  motion(): string;
  sound(): string;
  /** "Photoreal cities: on/off" (Google 3D tiles in the Dry Run cloches). Optional: no item without it. */
  photoreal?(): string;
  /** The item's label when the menu is built. */
  photorealLabel?: string;
  /** "Lens spacing: narrow/normal/wide" (the Cardboard lens profile). Optional: no item without it. */
  lens?(): string;
  lensLabel?: string;
  debug(): string;
  exit(): void;
}

/** The menu's first item: turns the chart (and in VR the whole room) to face the viewer. */
export const RECENTER_LABEL = "Recenter";

export class WristMenu {
  readonly group = new THREE.Group();
  readonly wheel = new THREE.Group();
  private menu: PaperMenu;
  private palmSince = 0;
  private w = new THREE.Vector3();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  open = false;
  /** How far ahead and how far below the eye the menu floats when opened by the wheel or a squeeze. */
  placement = { dist: 0.45, drop: 0.12 };

  private wheelHit: THREE.Mesh;

  constructor(tw: Tweens, actions: MenuActions) {
    const items: { label: string; onSelect: () => void }[] = [];
    const relabel = (label: string, act: () => string) => {
      const i = items.length;
      items.push({ label, onSelect: () => this.menu.buttons[i].btn.setLabel(act()) });
    };
    items.push({ label: RECENTER_LABEL, onSelect: () => { this.toggle(false); actions.recenter(); } });
    relabel("Captions: M", actions.captions);
    relabel("Reduce motion: off", actions.motion);
    relabel("Sound: on", actions.sound);
    if (actions.photoreal) relabel(actions.photorealLabel ?? "Photoreal cities: on", actions.photoreal);
    if (actions.lens) relabel(actions.lensLabel ?? "Lens spacing: normal", actions.lens);
    relabel("Debug: off", actions.debug);
    items.push({ label: "Exit", onSelect: () => actions.exit() });
    this.menu = new PaperMenu(tw, CARD.menuTitle, items, 0.17);
    this.group.add(this.menu.group);
    this.group.visible = false;

    // a small brass ship's wheel on the chart's south-east edge opens the menu
    const g = wheelGeometry();
    this.wheel.add(new THREE.Mesh(g.brass, M.brass()), new THREE.Mesh(g.spokes, M.brassDark()), shadowDecal(0.022));
    this.wheel.position.set(0.27, 0.006, 0.22);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.012, 12), new THREE.MeshBasicMaterial({ visible: false }));
    this.wheel.add(hit);
    this.wheelHit = hit;
  }

  interactables(): Interactable[] {
    return [
      { object: this.wheelHit, onSelect: () => this.toggle() },
      ...this.menu.interactables(() => this.open),
    ];
  }

  /**
   * Laptop view only: the orbit camera. It looks down at the table (~35°), so the menu is placed along its full view
   * direction and faces it square-on (L2-001: the level placement put the top half above the frame). Null in XR.
   */
  deskCamera: THREE.Camera | null = null;

  /** Relabel an item by its current label prefix (e.g. "Photoreal cities") — VR flips defaults on entry. */
  setLabel(prefix: string, label: string) {
    this.menu.buttons.find((b) => b.btn.labelText.startsWith(prefix))?.btn.setLabel(label);
  }

  /** Show the menu floating in front of the viewer (45 cm; VR: `placement`), facing them. */
  toggle(force?: boolean, camera?: THREE.Camera) {
    this.open = force ?? !this.open;
    this.group.visible = this.open;
    const cam = camera ?? this.deskCamera ?? this.lastCamera;
    if (this.open && cam) this.placeInFront(cam, cam === this.deskCamera);
  }
  private lastCamera: THREE.Camera | null = null;

  /** `pitched`: along the camera's view, square to it (laptop); else level, a little below the eye (headset). */
  placeInFront(camera: THREE.Camera, pitched = false) {
    camera.updateMatrixWorld();
    const pos = camera.getWorldPosition(new THREE.Vector3());
    const q = camera.getWorldQuaternion(new THREE.Quaternion());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    if (pitched) {
      this.group.position.copy(pos).addScaledVector(fwd, 0.45);
      this.group.quaternion.copy(q);
      return;
    }
    fwd.y = 0; fwd.normalize();
    this.group.position.copy(pos).addScaledVector(fwd, this.placement.dist).add(new THREE.Vector3(0, -this.placement.drop, 0));
    this.group.lookAt(pos.x, this.group.position.y, pos.z);
  }

  /** Free the card and the wheel (O2-053: they live outside the director's root). */
  dispose() {
    for (const o of [this.group, this.wheel]) { o.removeFromParent(); disposeObject(o); }
  }

  /** Left palm facing up for 600 ms opens the menu above the wrist. */
  update(camera: THREE.Camera, leftHand: THREE.XRHandSpace | null) {
    this.lastCamera = camera;
    if (!leftHand || !leftHand.joints) return;
    const j = leftHand.joints as Record<string, THREE.Object3D | undefined>;
    const wrist = j["wrist"], index = j["index-finger-metacarpal"], pinky = j["pinky-finger-metacarpal"];
    if (!wrist || !index || !pinky || !wrist.visible) { this.palmSince = 0; return; }
    const w = wrist.getWorldPosition(this.w);
    const a = index.getWorldPosition(this.a).sub(w);
    const b = pinky.getWorldPosition(this.b).sub(w);
    const n = a.cross(b); // per-frame: reuse scratch vectors
    const palmUp = n.lengthSq() > 0 && n.normalize().y < -0.65; // left hand: palm up ⇔ index×pinky points down
    const now = performance.now();
    if (palmUp) {
      if (!this.palmSince) this.palmSince = now;
      if (!this.open && now - this.palmSince > 600) {
        this.open = true;
        this.group.visible = true;
        this.group.position.copy(w).add(new THREE.Vector3(0, 0.14, 0));
        const cam = camera.getWorldPosition(new THREE.Vector3());
        this.group.lookAt(cam.x, this.group.position.y, cam.z);
      }
    } else {
      this.palmSince = 0;
    }
  }
}
