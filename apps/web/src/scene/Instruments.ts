// Brass instruments: the compass-rose Watch timer (doc 02 §7.5) and the carriage clock (§7.6).
import * as THREE from "three";
import { DRYRUN_DAY1_LABEL, MAX_WATCHES, PALETTE, minToClock } from "@all-ayes/shared";
import { M, mergedGeometry, shadowDecal } from "./materials";
import { makeText, setText } from "./text";
import type { Text } from "troika-three-text";
import { ease, type Tweens } from "./tween";
import { COMPASS_POS } from "./ChartTable";

const REST = Math.PI; // pointing south, toward the globe: "not yet sailed"
const WATCH_ANGLE = [-0.62, 0, 0.62];

export class CompassTimer {
  readonly group = new THREE.Group();
  private needles: THREE.Group[] = [];
  private watch = 0;
  /** After the Captain calls it, pointers stay north until a new meeting resets the Watch. */
  private north = false;

  constructor(private tw: Tweens) {
    this.group.position.copy(COMPASS_POS);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.044, 0.0022, 6, 48));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.001;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.006, 12));
    hub.position.y = 0.004;
    this.group.add(new THREE.Mesh(mergedGeometry([ring, hub]), M.brass())); // one draw (O2-056)
    const lengths = [0.038, 0.032, 0.026];
    for (let i = 0; i < MAX_WATCHES; i++) {
      const pivot = new THREE.Group();
      const shape = new THREE.Shape();
      const L = lengths[i];
      shape.moveTo(-0.0022, 0); shape.lineTo(0, -L); shape.lineTo(0.0022, 0); shape.lineTo(0, 0.006); shape.closePath();
      const needle = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.0008, bevelEnabled: false }), i === 1 ? M.brass() : M.brassDark());
      needle.rotation.x = Math.PI / 2; // shape's −y becomes −z (north)
      needle.position.y = 0.0025 + i * 0.0011;
      pivot.add(needle);
      pivot.rotation.y = REST;
      this.needles.push(pivot);
      this.group.add(pivot);
    }
    this.group.add(shadowDecal(0.05));
  }

  setWatch(w: number, instant = false) {
    // sync() runs on every store change; without this the pointers jumped back off north
    if (this.north && w >= this.watch) return;
    this.north = false;
    for (let i = 0; i < MAX_WATCHES; i++) {
      const target = i < w ? WATCH_ANGLE[i] : REST;
      const n = this.needles[i];
      if (instant || i !== w - 1 || w <= this.watch) { n.rotation.y = target; continue; }
      void this.tw.prop(n.rotation, "y", target, 1100, ease.inOut, `needle-${i}`);
    }
    this.watch = w;
  }

  /** Captain calls it: every pointer snaps to north. */
  snapNorth(instant = false) {
    for (let i = 0; i < MAX_WATCHES; i++) {
      const n = this.needles[i];
      if (instant) { n.rotation.y = 0; continue; }
      void this.tw.prop(n.rotation, "y", 0, 220, ease.out, `needle-${i}`);
    }
    this.north = true; // `watch` keeps the last value so only a new meeting (lower watch) clears north
  }

}

export class CarriageClock {
  readonly group = new THREE.Group();
  readonly hit: THREE.Mesh;
  private time: Text;
  private day: Text;
  private lastHour = -1;
  private lastSlot = -1;
  private lastLabel = "";
  onHour?: () => void;

  constructor() {
    const W = 0.052, Hh = 0.06, D = 0.03;
    const box = new THREE.Mesh(new THREE.BoxGeometry(W, Hh, D));
    box.position.y = Hh / 2 + 0.004;
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0018, 6, 20, Math.PI));
    handle.position.y = Hh + 0.008;
    const top = new THREE.Mesh(new THREE.BoxGeometry(W + 0.006, 0.004, D + 0.006));
    top.position.y = Hh + 0.006;
    const base = new THREE.Mesh(new THREE.BoxGeometry(W + 0.004, 0.004, D + 0.004));
    base.position.y = 0.002;
    // brass case + handle, dark brass top + feet: two draws instead of four (O2-056)
    const caseMesh = new THREE.Mesh(mergedGeometry([box, handle]), M.brass());
    const trim = new THREE.Mesh(mergedGeometry([top, base]), M.brassDark());
    const face = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.012, Hh - 0.02), M.paper());
    face.position.set(0, Hh / 2 + 0.006, D / 2 + 0.0006);
    this.time = makeText({ text: "08:00", font: "mono", size: 0.0125, color: PALETTE.ink });
    this.time.position.set(0, Hh / 2 + 0.008, D / 2 + 0.0012);
    this.day = makeText({ text: DRYRUN_DAY1_LABEL.toUpperCase(), font: "heading", size: 0.0055, color: PALETTE.inkSoft, letterSpacing: 0.12 });
    this.day.position.set(0, Hh / 2 - 0.004, D / 2 + 0.0012);
    this.group.add(shadowDecal(0.045), caseMesh, trim, face, this.time, this.day);
    this.hit = caseMesh;
  }

  /** Called every frame in the Dry Run: string work only when the shown 5-minute slot or day changes (OPT-052). */
  setMinute(min: number, label = DRYRUN_DAY1_LABEL) {
    const slot = Math.floor(min / 5);
    if (slot !== this.lastSlot) { this.lastSlot = slot; setText(this.time, minToClock(slot * 5)); }
    if (label !== this.lastLabel) { this.lastLabel = label; setText(this.day, label.toUpperCase()); }
    const hour = Math.floor(min / 60);
    if (hour !== this.lastHour) {
      if (this.lastHour >= 0) this.onHour?.();
      this.lastHour = hour;
    }
  }
}
