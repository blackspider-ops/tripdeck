// The Seal ceremony (doc 02 §7.7): the chosen chart unrolls with one line per crew member.
// Amounts are never shown on the shared table — every line reads "— sealed —".
import * as THREE from "three";
import { BANDS, PALETTE, type CrewPublic, type PlanPublic } from "@all-ayes/shared";
import { CARD } from "./copy";
import { M, paperCard, bandMaterial, disposeObject, inkCheck, mergedGeometry, sharedGeometry } from "./materials";
import { makeText, setText, type TextOpts } from "./text";
import type { Text } from "troika-three-text";
import { ease, type Tweens } from "./tween";
import { sound } from "./audio";
import { cardText, foldedLetter, hangingTag } from "./props";

import { SEAL_W as W, SEAL_TILT as TILT } from "./sealLayout";
const ROW = 0.032;
/** Rows for a crew of more than COMPACT_FROM: 12 rows fit a sheet that stays on the chart. */
const COMPACT_FROM = 6;
const COMPACT_ROW = 0.022;
const HEAD = 0.062;
/** Just above the paper, where everything written on the chart lies. */
const ON_PAPER = 0.0008;

// shared by every seal and row (O2-056)
const G = {
  halves: [0, 1].map((i) => sharedGeometry(new THREE.CylinderGeometry(0.0105, 0.011, 0.0035, 18, 1, false, i * Math.PI, Math.PI))),
  ring: sharedGeometry(new THREE.TorusGeometry(0.0068, 0.0009, 5, 24)),
  slot: sharedGeometry(new THREE.RingGeometry(0.0105, 0.0114, 32)),
  swatch: sharedGeometry(new THREE.PlaneGeometry(0.006, 0.016)),
  roll: sharedGeometry(new THREE.CylinderGeometry(0.009, 0.009, W * 1.02, 20)),
  twine: sharedGeometry(new THREE.TorusGeometry(0.0098, 0.0013, 5, 20)),
};

/** Text lying flat on the chart (the head, each row, the footer). */
function flatText(o: TextOpts, x: number, z: number) {
  const t = makeText(o);
  t.rotation.x = -Math.PI / 2;
  t.position.set(x, ON_PAPER, z);
  return t;
}

/** The chart's two ruled lines under the head, drawn as ink rather than into a unique paper canvas (O2-055).
 *  Children of the paper, so they stretch with it as it unrolls, exactly like the old painted lines. */
function ruledLines(length: number) {
  const px = W / 1024; // the lines were designed on a 1024 px wide sheet
  const rule = (yPx: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry((1024 - 80) * px, 2 * px));
    m.position.set(0, length / 2 - yPx * px, 0.0002);
    return m;
  };
  return new THREE.Mesh(mergedGeometry([rule(150), rule(158)]), M.inkRule());
}

class WaxSeal {
  readonly group = new THREE.Group();
  private halves: THREE.Mesh[] = [];
  private letter: THREE.Object3D | null = null;
  pressed = false;

  constructor(private tw: Tweens) {
    for (const g of G.halves) {
      const half = new THREE.Mesh(g, M.wax());
      half.position.y = 0.00175;
      this.halves.push(half);
      this.group.add(half);
    }
    const ring = new THREE.Mesh(G.ring, M.waxDark());
    ring.rotation.x = Math.PI / 2;
    // a check pressed into the wax, never a letter: an "A" read as "voted for chart A" (the charts keep A/B)
    const a = inkCheck(0.0075, PALETTE.waxDark);
    a.rotation.x = -Math.PI / 2;
    a.position.x = -0.0035;
    a.position.z = 0.0025;
    this.halves[0].add(ring, a);
    ring.position.y = a.position.y = 0.0019;
    a.userData.waxMark = "check";
    this.group.visible = false;
  }

  /** A standing (pre-signed) seal — `seals[].standing` in the public booking, not the member's role —
   *  gets a tiny folded letter beside it. */
  setStanding(standing: boolean) {
    if (standing && !this.letter) {
      const l = foldedLetter(0.012, 0.008, 128, "standing-letter");
      l.rotation.x = -Math.PI / 2;
      l.position.set(0.018, 0.0006, 0.003);
      this.group.add(l);
      this.letter = l;
    }
    if (this.letter) this.letter.visible = standing;
  }

  /** Drop and press: 400 ms fall, 60 ms squash with one overshoot, then a thud. */
  async press(instant = false) {
    if (this.pressed) return;
    this.pressed = true;
    this.group.visible = true;
    if (instant) return;
    this.group.position.y = 0.05;
    await this.tw.prop(this.group.position, "y", 0, 400, ease.in);
    sound.play("thud");
    await this.tw.to(220, (t) => {
      const s = 1 - 0.4 * Math.sin(Math.PI * Math.min(1, t * 2.2)) * (1 - t);
      this.group.scale.set(1 + (1 - s) * 0.5, s, 1 + (1 - s) * 0.5);
    }, ease.linear);
    this.group.scale.set(1, 1, 1);
  }

  async crack() {
    this.group.visible = true;
    sound.play("snap");
    await this.tw.to(300, (t) => {
      this.halves[0].position.x = -0.0015 * t;
      this.halves[1].position.x = 0.0015 * t;
      this.halves[0].rotation.z = 0.08 * t;
      this.halves[1].rotation.z = -0.08 * t;
    }, ease.step);
  }

  async lift() {
    if (!this.group.visible) return;
    await this.tw.prop(this.group.position, "y", this.group.position.y + 0.04, 450, ease.out);
    this.group.visible = false;
    this.pressed = false;
    this.group.position.y = 0;
    this.halves.forEach((h) => { h.position.x = 0; h.rotation.z = 0; });
    if (this.letter) this.letter.visible = false;
  }
}

export class SealChart {
  readonly group = new THREE.Group();
  private sheet = new THREE.Group();
  private paper: THREE.Mesh;
  private roll: THREE.Mesh;
  private rows = new Map<string, { row: THREE.Group; seal: WaxSeal; status: Text; tick: THREE.Object3D }>();
  private twine: THREE.Mesh;
  private refTag: THREE.Group | null = null;
  private length: number;
  private pitch: number;
  private footer: Text;
  private headTexts: Text[] = [];
  private state: "rolled" | "open" | "tied" = "rolled";

  constructor(private tw: Tweens, plan: PlanPublic, crew: CrewPublic[], dates: string) {
    // a big crew (7–12) gets tighter, smaller rows so the sheet still ends on the chart
    this.pitch = crew.length > COMPACT_FROM ? COMPACT_ROW : ROW;
    this.length = HEAD + this.pitch * crew.length + 0.03;
    this.paper = paperCard(W, this.length);
    this.paper.add(ruledLines(this.length));
    // pivot at the north edge; unrolls toward the Organizer
    this.paper.rotation.x = -Math.PI / 2;
    this.paper.position.z = this.length / 2;
    this.sheet.add(this.paper);

    const title = flatText({ text: `${plan.cityName} · ${dates}`, font: "heading", size: 0.014, anchorX: "left", anchorY: "top" }, -W / 2 + 0.014, 0.012);
    const sub = flatText({ text: `${plan.hotelName} — the crew's seals`, font: "body", size: 0.0075, color: PALETTE.inkSoft, anchorX: "left", anchorY: "top" }, -W / 2 + 0.014, 0.032);
    this.sheet.add(title, sub);
    this.headTexts = [title, sub];

    crew.forEach((m, i) => this.buildRow(m, i));
    this.footer = flatText({ text: CARD.sealFooter, font: "body", size: 0.0072, color: PALETTE.inkSoft, anchorX: "center", anchorY: "top" }, 0, HEAD + this.pitch * crew.length + 0.004);
    this.sheet.add(this.footer);

    this.roll = new THREE.Mesh(G.roll, M.paper());
    this.roll.rotation.z = Math.PI / 2;
    this.twine = new THREE.Mesh(G.twine, M.twine());
    this.twine.rotation.y = Math.PI / 2;
    this.twine.visible = false;
    this.roll.add(this.twine);

    this.group.add(this.sheet, this.roll);
    this.group.position.set(0, 0.006, -0.01);
    this.group.rotation.x = -TILT; // lectern tilt: the south (Organizer's) edge lifts off the chart
    this.setOpen(0);
  }

  /** One line per crew member: band swatch, name, "— sealed —", the seal's slot, the seal and its tick. */
  private buildRow(m: CrewPublic, i: number) {
    const row = new THREE.Group();
    row.position.z = HEAD + i * this.pitch;
    if (this.pitch !== ROW) row.scale.setScalar(this.pitch / ROW);
    const swatch = new THREE.Mesh(G.swatch, bandMaterial(BANDS[m.band].hex));
    swatch.rotation.x = -Math.PI / 2;
    swatch.position.set(-W / 2 + 0.018, ON_PAPER, 0);
    const name = flatText({ text: m.name + (m.role === "absent" ? " (away)" : ""), font: "heading", size: 0.011, anchorX: "left" }, -W / 2 + 0.028, 0);
    const status = flatText({ text: "— sealed —", font: "mono", size: 0.0085, color: PALETTE.inkSoft, anchorX: "right" }, W / 2 - 0.045, 0);
    const slot = new THREE.Mesh(G.slot, M.ink());
    slot.rotation.x = -Math.PI / 2;
    slot.position.set(W / 2 - 0.024, ON_PAPER, 0);
    const seal = new WaxSeal(this.tw);
    seal.group.position.set(W / 2 - 0.024, 0.0009, 0);
    // "sealed ✓" once booked — the check is drawn (✓ isn't in the bundled fonts)
    const tick = inkCheck(0.0075);
    tick.rotation.x = -Math.PI / 2;
    tick.position.set(W / 2 - 0.043, ON_PAPER, 0.0037);
    tick.visible = false;
    row.add(swatch, name, status, slot, seal.group, tick);
    this.sheet.add(row);
    this.rows.set(m.memberId, { row, seal, status, tick });
  }

  private setOpen(k: number) {
    const L = Math.max(0.004, this.length * k);
    // only the paper stretches; text rows are revealed as the edge passes them (never squashed)
    this.paper.scale.y = Math.max(0.02, k);
    this.paper.position.z = L / 2;
    for (const { row } of this.rows.values()) row.visible = row.position.z < L - 0.008;
    this.footer.visible = k > 0.98;
    for (const t of this.headTexts) t.visible = t.position.z < L - 0.004;
    this.roll.position.set(0, 0.009, L);
  }

  async unroll(instant = false) {
    if (this.state === "open") return;
    this.state = "open";
    if (instant) return this.setOpen(1);
    sound.play("paper");
    await this.tw.to(700, (t) => this.setOpen(t), ease.out, "sealchart");
  }

  /** From the public booking: which seals are standing (pre-signed). */
  setStanding(memberId: string, standing: boolean) { this.rows.get(memberId)?.seal.setStanding(standing); }

  pressSeal(memberId: string, instant = false) {
    return this.rows.get(memberId)?.seal.press(instant) ?? Promise.resolve();
  }

  /** Voided: the seals that were set crack together, then lift off. Never points at a member —
   *  the shared table must not say whose share didn't clear (doc 03 §2, doc 02 §11). */
  async voidAll() {
    const set = [...this.rows.values()].filter((r) => r.seal.pressed);
    await Promise.all(set.map((r) => r.seal.crack()));
    await this.tw.wait(350);
    await Promise.all([...this.rows.values()].map((r) => r.seal.lift()));
  }

  /** Booked: the chart rolls up and is tied with twine; the booking reference hangs off it on a tag. */
  async tie(reference?: string, instant = false) {
    this.state = "tied";
    for (const { status, tick } of this.rows.values()) { setText(status, "sealed"); tick.visible = true; }
    if (!instant) {
      await this.tw.wait(500);
      sound.play("paper");
      await this.tw.to(650, (t) => this.setOpen(1 - t), ease.in, "sealchart");
    } else this.setOpen(0);
    this.twine.visible = true;
    if (reference) this.hangTag(reference);
  }

  /** A small paper tag on the twine with the booking reference (public: it's in BookingPublic). */
  private hangTag(reference: string) {
    if (this.refTag) return;
    const label = cardText({ text: reference, font: "mono", size: 0.0058, color: PALETTE.ink }, 0, 0);
    const tag = hangingTag(paperCard(0.05, 0.016), label, { length: 0.012, x: -0.026, y: 0.009, tilt: 0.7 });
    // hangs off the tied roll's south side, leaning back toward the Organizer
    tag.position.set(0.04, 0.006, this.roll.position.z + 0.022);
    tag.rotation.x = -1.1;
    this.group.add(tag);
    this.refTag = tag;
  }

  /** The sheet's full length when open (m), before any scale. */
  get sheetLength() { return this.length; }

  dispose() { this.group.removeFromParent(); disposeObject(this.group); }
}
