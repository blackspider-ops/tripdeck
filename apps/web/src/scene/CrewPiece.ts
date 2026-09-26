// Carved walnut crew pieces — the Advocates — and the brass-and-wood Captain (doc 02 §7.3).
// They never float, glow or bob: they tip, bow, turn and slide, like pieces on a table.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import { M, bandInk, bandMaterial, disposeObject, mergedGeometry, shadowDecal, paperCard, sharedGeometry } from "./materials";
import { cardText, foldedLetter, hangingTag, paperFlag } from "./props";
import { ease, type Tweens } from "./tween";
import { billboard } from "./billboard";
import { CARD } from "./copy";

function lathe(profile: [number, number][], segments = 10) {
  const g = new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), segments);
  g.computeVertexNormals();
  return g;
}

// A pawn crossed with a ship's figurehead, 9 cm tall.
const PAWN_PROFILE: [number, number][] = [
  [0, 0], [0.022, 0], [0.023, 0.004], [0.02, 0.008], [0.014, 0.012], [0.0105, 0.02], [0.0088, 0.032],
  [0.0082, 0.045], [0.011, 0.05], [0.011, 0.054], [0.0075, 0.057], [0.0105, 0.064], [0.0128, 0.071],
  [0.0118, 0.079], [0.008, 0.086], [0.003, 0.0895], [0, 0.09],
];
let pawnGeo: THREE.LatheGeometry | null = null;
let pawnEdges: THREE.EdgesGeometry | null = null;

/** Geometry every crew piece shares (O2-056: was rebuilt per piece; the flag card is a unit plane scaled to the name). */
const G = (() => {
  const bulb = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.006, 8));
  bulb.position.y = 0.003;
  const bulb2 = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.006, 8));
  bulb2.rotation.x = Math.PI; bulb2.position.y = 0.009;
  const cap1 = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.001, 10));
  const cap2 = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.001, 10));
  cap2.position.y = 0.012;
  return {
    collar: sharedGeometry(new THREE.TorusGeometry(0.0108, 0.0024, 6, 20)),
    pin: sharedGeometry(new THREE.CylinderGeometry(0.0007, 0.0007, 0.034, 6)),
    strip: sharedGeometry(new THREE.PlaneGeometry(0.004, 0.018)),
    // the hourglass: glass bulbs in one mesh, brass caps in another (was four)
    bulbs: sharedGeometry(mergedGeometry([bulb, bulb2])),
    caps: sharedGeometry(mergedGeometry([cap1, cap2])),
  };
})();

/** The flag's pin rises from the piece's top; the flag (0.018 tall) hangs near the pin's head. */
const PIN_BASE_Y = 0.09;
const PIN_LEN = 0.034;
const FLAG_Y = 0.117;
/** A raised flag sits this much higher: more than a flag's height, so neighbours' flags never overlap edge-on. */
export const FLAG_TIER_STEP = 0.022;

const graphiteLine = new THREE.LineBasicMaterial({ color: PALETTE.graphite, transparent: true, opacity: 0.7 });

export class CrewPiece {
  readonly group = new THREE.Group(); // seat, faces the globe (+z toward center)
  private body = new THREE.Group();  // tips / bows / turns
  private carved: THREE.Mesh;
  private collar: THREE.Mesh;
  private outline: THREE.LineSegments;
  private flag = new THREE.Group();
  private pin: THREE.Mesh;
  private tier = 0;
  private hourglass: THREE.Group;
  private shadow: THREE.Mesh;
  private sealed = false;
  seat = new THREE.Vector3();

  constructor(private tw: Tweens, readonly memberId: string, name: string, bandHex: string, absent: boolean) {
    pawnGeo ??= sharedGeometry(lathe(PAWN_PROFILE, 10));
    pawnEdges ??= sharedGeometry(new THREE.EdgesGeometry(pawnGeo, 25));
    this.carved = new THREE.Mesh(pawnGeo, M.wood());
    this.collar = new THREE.Mesh(G.collar, bandMaterial(bandHex));
    this.collar.rotation.x = Math.PI / 2;
    this.collar.position.y = 0.052;
    this.outline = new THREE.LineSegments(pawnEdges, graphiteLine);

    // brass pin with a paper name flag
    const pin = new THREE.Mesh(G.pin, M.brass());
    pin.position.y = PIN_BASE_Y + PIN_LEN / 2;
    this.pin = pin;
    const bandStrip = new THREE.Mesh(G.strip, bandInk(bandHex, true)); // cached, not a material per piece
    bandStrip.position.x = 0.002;
    const { group: flag } = paperFlag({ text: name, font: "heading", size: 0.0105 }, 0.018, { x0: 0.002, pad: 0.0035, guessPerChar: 0.0062 });
    this.flag.add(flag, bandStrip);
    this.flag.position.y = FLAG_Y;

    // hourglass shown while terms are unsealed
    this.hourglass = new THREE.Group();
    this.hourglass.add(new THREE.Mesh(G.bulbs, M.glassRim()), new THREE.Mesh(G.caps, M.brass()));
    this.hourglass.position.set(0.02, 0.001, 0.0);

    this.body.add(this.carved, this.collar, this.outline, pin, this.flag);
    if (absent) {
      // represented by letter: a folded note tucked against the base
      const letter = foldedLetter(0.022, 0.015, 256, "absent-letter", PALETTE.soundingRed);
      letter.position.set(0, 0.009, 0.021);
      letter.rotation.x = -0.35;
      this.body.add(letter);
    }
    this.shadow = shadowDecal(0.03);
    this.group.add(this.shadow, this.body, this.hourglass);
    this.setSealed(false, true);
  }


  /** Raises the name flag (and lengthens its pin) by `tier` notches, so neighbouring flags stand at different heights. */
  setFlagTier(tier: number) {
    if (tier === this.tier) return;
    this.tier = tier;
    const len = PIN_LEN + tier * FLAG_TIER_STEP;
    this.pin.scale.y = len / PIN_LEN;
    this.pin.position.y = PIN_BASE_Y + len / 2;
    this.flag.position.y = FLAG_Y + tier * FLAG_TIER_STEP;
  }

  get flagTier() { return this.tier; }

  /** Pencil outline until the member's terms are sealed; then a carved piece. */
  setSealed(sealed: boolean, instant = false) {
    if (this.sealed === sealed && !instant) return;
    this.sealed = sealed;
    this.carved.visible = sealed;
    this.collar.visible = sealed;
    this.outline.visible = !sealed;
    this.hourglass.visible = !sealed;
    this.shadow.visible = sealed;
  }

  get isSealed() { return this.sealed; }

  /** Place at a seat, facing the globe. `arrive` slides in from the chart edge. */
  placeAt(seat: THREE.Vector3, arrive = false) {
    this.seat.copy(seat);
    this.group.position.copy(seat);
    this.group.lookAt(0, seat.y, 0);
    if (!arrive) return Promise.resolve();
    const from = seat.clone().multiplyScalar(1.45);
    return this.tw.to(450, (t) => this.group.position.lerpVectors(from, seat, t), ease.out, `arrive-${this.memberId}`);
  }

  private pose(tip: number, slide: number, yaw: number, ms: number) {
    const f = { x: this.body.rotation.x, z: this.body.position.z, y: this.body.rotation.y };
    return this.tw.to(ms, (t) => {
      this.body.rotation.x = f.x + (tip - f.x) * t;
      this.body.position.z = f.z + (slide - f.z) * t;
      this.body.rotation.y = f.y + (yaw - f.y) * t;
    }, ease.tip, `pose-${this.memberId}`);
  }

  speak() { return this.pose(THREE.MathUtils.degToRad(12), 0.02, 0, 250); }
  object() { return this.pose(0, 0.012, THREE.MathUtils.degToRad(15), 300); }
  concede() { return this.pose(THREE.MathUtils.degToRad(20), -0.006, 0, 350); }
  settle() { return this.pose(0, 0, 0, 300); }

  /** World-space point just in front of the base, for ribbons. */
  frontPoint(out = new THREE.Vector3()) {
    return out.copy(this.seat).multiplyScalar(0.72);
  }

  /** The name flag turns to the viewer; `camPos` is the camera's world position, read once per frame (O2-054). */
  update(camPos: THREE.Vector3) { billboard(this.flag, camPos); }

  /** O2-050: free the piece's own GPU resources (its text; the shared geometry and cached materials stay). */
  dispose() {
    this.group.removeFromParent();
    disposeObject(this.group);
  }
}

// ---------------- the Captain ----------------

const CAPTAIN_PROFILE: [number, number][] = [
  [0, 0], [0.026, 0], [0.027, 0.005], [0.022, 0.01], [0.015, 0.016], [0.011, 0.03], [0.0095, 0.05],
  [0.0095, 0.068], [0.013, 0.073], [0.013, 0.078], [0.009, 0.082], [0.012, 0.09], [0.0145, 0.099],
  [0.0135, 0.108], [0.009, 0.115], [0.0035, 0.1195], [0, 0.12],
];

export class CaptainPiece {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private tag: THREE.Group;

  constructor(private tw: Tweens) {
    // lower section turned in brass, upper in wood (split at the band)
    const split = CAPTAIN_PROFILE.findIndex(([, y]) => y >= 0.073);
    const lower = CAPTAIN_PROFILE.slice(0, split + 1).concat([[0, CAPTAIN_PROFILE[split][1]]]);
    const upper = ([[0, CAPTAIN_PROFILE[split][1]]] as [number, number][]).concat(CAPTAIN_PROFILE.slice(split));
    const woodPart = new THREE.Mesh(lathe(upper, 12), M.wood());
    const lowerPart = new THREE.Mesh(lathe(lower, 12));
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.0132, 0.0022, 6, 24));
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.0755;
    // spyglass tucked under the arm; its brass tube joins the lower body and band in one mesh (O2-056)
    const glass = new THREE.Group();
    const tube1 = new THREE.Mesh(new THREE.CylinderGeometry(0.0032, 0.0032, 0.03, 12));
    const tube2 = new THREE.Mesh(new THREE.CylinderGeometry(0.0026, 0.0026, 0.02, 12), M.brassDark());
    tube2.position.y = 0.024;
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.0036, 0.0036, 0.002, 12), M.woodDark());
    lens.position.y = -0.015;
    glass.add(tube2, lens);
    glass.rotation.z = Math.PI / 2 - 0.3;
    glass.position.set(0.018, 0.07, 0.004);
    glass.updateMatrix();
    tube1.updateMatrix();
    tube1.matrix.premultiply(glass.matrix).decompose(tube1.position, tube1.quaternion, tube1.scale);
    const brassPart = new THREE.Mesh(mergedGeometry([lowerPart, band, tube1]), M.brass());
    this.body.add(woodPart, brassPart, glass);

    // "Weigh anchor" paper tag — pinch it (or tap the phone) to start the meeting
    const card = paperCard(0.07, 0.024, (gc, W, H) => {
      gc.fillStyle = PALETTE.soundingRed;
      gc.beginPath(); gc.arc(W * 0.1, H * 0.45, H * 0.18, 0, Math.PI * 2); gc.fill();
    }, 512, "weigh-anchor");
    const label = cardText({ text: CARD.weighAnchor, font: "heading", size: 0.0092, anchorX: "left" }, -0.023, 0.001);
    this.tag = hangingTag(card, label, { length: 0.02, x: -0.03, y: 0.02, tilt: 0.6 });
    this.tag.position.set(0, 0.06, 0.03);
    this.tag.visible = false;

    this.group.add(shadowDecal(0.035), this.body, this.tag);
    this.group.visible = false;
  }

  /** Rise at the compass rose (500 ms). */
  rise(at: THREE.Vector3, instant = false) {
    if (this.group.visible) return Promise.resolve(); // already standing: no copy/lookAt per store event (OPT-051)
    this.group.position.copy(at);
    this.group.lookAt(0, at.y, 0);
    this.group.visible = true;
    if (instant) return Promise.resolve();
    this.body.position.y = -0.12;
    return this.tw.prop(this.body.position, "y", 0, 500, ease.out, "captain-rise");
  }

  showTag(v: boolean) { this.tag.visible = v; }

  /** The tag always turns to whoever is looking (it's the one thing you must be able to read). */
  update(camPos: THREE.Vector3) {
    if (this.tag.visible) billboard(this.tag, camPos);
  }
  get tagVisible() { return this.tag.visible; }

  speak() { return this.tw.prop(this.body.rotation, "x", THREE.MathUtils.degToRad(8), 250, ease.tip, "captain-pose"); }
  settle() { return this.tw.prop(this.body.rotation, "x", 0, 300, ease.tip, "captain-pose"); }
}
