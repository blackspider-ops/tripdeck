// Ink ribbons replace chat bubbles (doc 02 §7.4): a paper strip unrolls across the chart from the
// speaking piece, with ≤ 8 handwritten words. The next speaker's ribbon rolls the old one up.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import { M, disposeObject, paperCard, sharedGeometry } from "./materials";
import { makeText } from "./text";
import type { Text } from "troika-three-text";
import { ease, type Tweens } from "./tween";

const H = 0.021;
const ROLL_GEO = sharedGeometry(new THREE.CylinderGeometry(0.0034, 0.0034, H * 0.98, 12));
const UNROLL_MS = 400;
/** The write-on never drags on past this, however long the voice line. */
const MAX_WRITE_MS = 6000;

export class InkRibbon {
  readonly group = new THREE.Group();
  private strip = new THREE.Group();
  private roll: THREE.Mesh;
  private text: Text;
  private width: number;

  constructor(private tw: Tweens, words: string, color: string = PALETTE.ink) {
    const clipped = words.split(/\s+/).slice(0, 8).join(" ");
    // 5 mm steps (the plain card no longer has its own texture, O2-055, but the strip lengths stay as they were)
    this.width = Math.ceil(Math.min(0.3, 0.03 + clipped.length * 0.0068) * 200) / 200;
    const card = paperCard(this.width, H);
    card.position.x = this.width / 2;
    this.strip.add(card);
    this.text = makeText({ text: clipped, font: "hand", size: 0.0098, color, anchorX: "left", anchorY: "middle" });
    this.text.position.set(0.006, 0.0005, 0.0006);
    this.roll = new THREE.Mesh(ROLL_GEO, M.paper());
    this.group.add(this.strip, this.text, this.roll); // text is a sibling so the unroll reveals it rather than squashing it
    this.group.rotation.x = -Math.PI / 2; // lies flat on the chart, readable from the Organizer's side
  }

  /** Place so the strip starts near `from` and runs toward the chart's center. */
  placeNear(from: THREE.Vector3) {
    const x = THREE.MathUtils.clamp(from.x - this.width / 2, -0.3, 0.3 - this.width);
    this.group.position.set(x, 0.0045, from.z);
  }

  /** The strip unrolls in 400 ms; the handwriting is written on over `writeMs` — the voice's length when
   *  the helm sent one (Turn.durationMs), else in step with the paper. */
  unroll(writeMs = UNROLL_MS) {
    const write = Math.min(MAX_WRITE_MS, Math.max(UNROLL_MS, writeMs));
    const paper = this.tw.to(UNROLL_MS, (t) => {
      this.strip.scale.x = Math.max(0.001, t);
      this.roll.position.set(this.width * t, 0, 0.0034);
      this.roll.visible = t < 1;
      if (write === UNROLL_MS && !this.rolling) this.reveal(t);
    }, ease.out);
    if (write === UNROLL_MS) return paper;
    this.reveal(0);
    // the next speaker may roll this one up mid-sentence: the write-on then just stops
    return Promise.all([paper, this.tw.to(write, (t) => { if (!this.rolling) this.reveal(t); }, ease.linear)]).then(() => undefined);
  }

  private revealed = 1;
  private rolling = false;
  private reveal(t: number) {
    this.revealed = t;
    this.text.clipRect = [-1, -1, this.width * t - 0.006, 1];
  }

  rollUp() {
    this.roll.visible = true;
    this.rolling = true;
    const from = this.revealed;
    return this.tw.to(350, (t) => {
      const k = 1 - t;
      this.strip.scale.x = Math.max(0.001, k);
      this.reveal(Math.min(from, k));
      this.roll.position.set(this.width * k, 0, 0.0034);
    }, ease.in).then(() => this.dispose());
  }

  dispose() {
    this.group.removeFromParent();
    disposeObject(this.group); // strip geometry + text; the plain-card material is shared
  }
}
