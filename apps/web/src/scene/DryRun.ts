// Dry Run (doc 02 §7.6, doc 03 Q3): each of the two charts plays out as a miniature city under a glass
// cloche. The crew walks its group moments as a cluster of unlabeled beads; "some of the crew" picks get a
// lone neutral bead. The shared table only has the public plan (SEC-001): no member ids, no per-member legs
// or arrivals, so beads carry no band colour and nothing here can be tied to one member. Long walks are
// inked in red with a margin note.
import * as THREE from "three";
import { PALETTE, formatDollars, type CrewPublic, type PlanPublic, type PublicScheduleItem } from "@all-ayes/shared";
import { M, disposeObject, inkA, inkCheck, mergedGeometry, paintPaper, paperCard, rng, shadowDecal, sharedGeometry, sharedSheet, sheetTexture } from "./materials";
import { makeText, setText } from "./text";
import { BatchedText, type Text } from "troika-three-text";
import { metersFrom } from "./geo";
import { ease, type Tweens } from "./tween";
import { billboard } from "./billboard";
import { pinInstances } from "./props";

const CLOCHE_R = 0.13;
/** Inner paper disc radius the city is scaled to (CityTiles clips photoreal tiles just inside it). */
export const CITY_R = 0.115;
const DISC_Y = 0.016;

interface Key { t: number; p: THREE.Vector3 }
interface Place { id: string; pos: THREE.Vector3; outside: boolean; name: string }
interface Bead { keys: Key[]; radius: number; hideBefore: number; hideAfter: number }

/** The printed street plate, designed at 1024² (512² on a headset). Cached per city seed, so re-entering
 *  the Dry Run (e.g. after void → retry) never repaints it. */
/** A stable seed from the whole city id (O2-055: the first letter alone gave two cities the same plate). */
function citySeed(cityId: string) {
  let h = 7;
  for (let i = 0; i < cityId.length; i++) h = (h * 31 + cityId.charCodeAt(i)) >>> 0;
  return h % 100_000;
}

function streetTexture(seed: number) {
  return sharedSheet(`street:${seed}`, () => sheetTexture(1024, 1024, (g, W, H) => {
    paintPaper(g, W, H, PALETTE.paper, seed);
    const r = rng(seed);
    const cx = W / 2, cy = H / 2;
    // a loose street grid, slightly rotated per district
    for (let d = 0; d < 5; d++) {
      const ox = cx + (r() - 0.5) * W * 0.6, oy = cy + (r() - 0.5) * H * 0.6, rot = r() * Math.PI, sp = 26 + r() * 18;
      g.save(); g.translate(ox, oy); g.rotate(rot);
      g.strokeStyle = inkA(0.16); g.lineWidth = 2;
      for (let i = -8; i <= 8; i++) {
        g.beginPath(); g.moveTo(i * sp, -W * 0.3); g.lineTo(i * sp + (r() - 0.5) * 10, W * 0.3); g.stroke();
        g.beginPath(); g.moveTo(-W * 0.3, i * sp); g.lineTo(W * 0.3, i * sp + (r() - 0.5) * 10); g.stroke();
      }
      g.restore();
    }
    // avenues
    g.strokeStyle = inkA(0.32); g.lineWidth = 5;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      const a = r() * Math.PI * 2;
      g.moveTo(cx + Math.cos(a) * W * 0.55, cy + Math.sin(a) * H * 0.55);
      g.quadraticCurveTo(cx + (r() - 0.5) * 200, cy + (r() - 0.5) * 200, cx - Math.cos(a) * W * 0.55, cy - Math.sin(a) * H * 0.55);
      g.stroke();
    }
    // edge vignette so the disc reads as a printed plate
    const grd = g.createRadialGradient(cx, cy, W * 0.38, cx, cy, W * 0.5);
    grd.addColorStop(0, "rgba(0,0,0,0)");
    grd.addColorStop(1, "rgba(120,95,55,0.18)");
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
  }));
}

// geometry shared by every cloche (never disposed with one)
const BLOCK_GEO = sharedGeometry(new THREE.BoxGeometry(1, 1, 1));
const HOUSE_GEO = sharedGeometry(new THREE.BoxGeometry(0.008, 0.006, 0.008));
const ROOF_GEO = sharedGeometry(new THREE.ConeGeometry(0.0068, 0.005, 4));
const NEEDLE_GEO = sharedGeometry(new THREE.CylinderGeometry(0.0006, 0.0006, 0.018, 5));
const HEAD_GEO = sharedGeometry(new THREE.SphereGeometry(0.0022, 8, 6));
const ARROW_GEO = sharedGeometry(new THREE.ConeGeometry(0.004, 0.01, 3));
const BEAD_GEO = sharedGeometry(new THREE.SphereGeometry(1, 10, 8)); // scaled per bead
/** The brass base and knob of a cloche, one mesh (O2-056). */
const BRASS_GEO = (() => {
  const base = new THREE.Mesh(new THREE.CylinderGeometry(CLOCHE_R + 0.006, CLOCHE_R + 0.012, 0.014, 48));
  base.position.y = 0.007;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.009, 12, 8));
  knob.position.y = CLOCHE_R + 0.02;
  return sharedGeometry(mergedGeometry([base, knob]));
})();
const RIM_GEO = sharedGeometry(new THREE.TorusGeometry(CLOCHE_R + 0.002, 0.0025, 6, 64));
const PLATE_GEO = sharedGeometry(new THREE.CircleGeometry(CLOCHE_R, 64));
const DOME_GEO = sharedGeometry(new THREE.SphereGeometry(CLOCHE_R, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2));
const DOME_RIM_GEO = sharedGeometry(new THREE.TorusGeometry(CLOCHE_R, 0.0012, 6, 64));

/** Route strips for one cloche, merged into a single vertex-coloured mesh (was one mesh per leg). */
class StripBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private c = new THREE.Color();

  add(a: THREE.Vector3, b: THREE.Vector3, color: string, bold: boolean) {
    const len = a.distanceTo(b);
    if (len < 0.001) return;
    const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len;
    const hw = (bold ? 0.0022 : 0.0014) / 2;
    const px = -dz * hw, pz = dx * hw;
    const base = this.pos.length / 3;
    const y = 0.0009;
    this.pos.push(a.x + px, y, a.z + pz, a.x - px, y, a.z - pz, b.x + px, y, b.z + pz, b.x - px, y, b.z - pz);
    this.c.set(color);
    for (let i = 0; i < 4; i++) this.col.push(this.c.r, this.c.g, this.c.b);
    this.idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }

  build(): THREE.Mesh | null {
    if (!this.idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    // unlit ink like the old per-leg bandInk strips; vertex colours carry ink / soft ink / sounding red
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }
}

export class DryRunCloche {
  readonly group = new THREE.Group();   // on the table
  readonly city = new THREE.Group();    // the miniature, centered on the plan's city center
  readonly dome: THREE.Mesh;
  private lowPoly: THREE.InstancedMesh;
  private plateTex: THREE.Texture;
  private beads: Bead[] = [];
  private beadMesh: THREE.InstancedMesh | null = null;
  private tag: THREE.Group;
  private votesText!: Text;
  /** Place names and margin notes: billboards inside one batched text (one draw call, O2-056). */
  private labels: Text[] = [];
  private labelBatch = new BatchedText();
  private scale: number;
  private rest: THREE.Vector3;
  private strips = new StripBuilder();

  constructor(private tw: Tweens, readonly plan: PlanPublic, crew: CrewPublic[], side: -1 | 1) {
    this.rest = new THREE.Vector3(side * 0.3, 0, 0.15);
    this.scale = CITY_R / (plan.tileRadiusKm * 1000);
    this.plateTex = streetTexture(citySeed(plan.cityId));
    this.dome = this.buildBase();
    this.city.position.y = DISC_Y;
    this.group.add(this.city);
    // as makeText's; and never culled: its bounds only exist once the members are packed, and packing happens in
    // its own onBeforeRender (a culled batch never packs)
    this.labelBatch.depthOffset = -1;
    this.labelBatch.frustumCulled = false;
    this.city.add(this.labelBatch);

    const items: PublicScheduleItem[] = plan.days[0]?.items ?? [];
    const places = this.places(items);
    this.lowPoly = this.buildCity(places);
    this.buildMarkers(places, items);
    this.buildRoutes(crew.length, items, places);
    this.tag = this.buildTag();
    this.group.add(this.tag);
    this.group.position.copy(this.rest);
  }

  private toScene(p: { lat: number; lng: number }) {
    const m = metersFrom(this.plan.cityCenter, p);
    return new THREE.Vector3(m.x * this.scale, 0, m.z * this.scale);
  }

  /** Brass base, the printed street plate, and the glass dome with its knob. Returns the dome. */
  private buildBase(): THREE.Mesh {
    const brass = new THREE.Mesh(BRASS_GEO, M.brass()); // base + the dome's knob
    const rim = new THREE.Mesh(RIM_GEO, M.brassDark());
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.0145;
    const plate = new THREE.Mesh(PLATE_GEO, new THREE.MeshStandardMaterial({ map: this.plateTex, roughness: 0.95 }));
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.0142;
    this.group.add(shadowDecal(CLOCHE_R + 0.03), brass, rim, plate);

    // glass dome — plain glass, no frosting
    const dome = new THREE.Mesh(DOME_GEO, M.glass());
    dome.position.y = 0.0145;
    const domeRim = new THREE.Mesh(DOME_RIM_GEO, M.glassRim());
    domeRim.rotation.x = Math.PI / 2;
    domeRim.position.y = 0.0152;
    dome.renderOrder = 10;
    this.group.add(dome, domeRim);
    return dome;
  }

  /** The stay first, then the day's stops; anything past the plate is pinned to its rim. */
  private places(items: PublicScheduleItem[]): Place[] {
    const clampRim = (v: THREE.Vector3) => (v.length() > CITY_R - 0.004 ? v.clone().setLength(CITY_R - 0.004) : v.clone());
    const hotelPos = this.toScene({ lat: this.plan.hotelLat, lng: this.plan.hotelLng });
    return [
      { id: this.plan.hotelId, pos: clampRim(hotelPos), outside: hotelPos.length() > CITY_R, name: this.plan.hotelName },
      ...items.map((it) => {
        const p = this.toScene(it);
        return { id: it.activityId, pos: clampRim(p), outside: p.length() > CITY_R - 0.004, name: it.name };
      }),
    ];
  }

  /** Low-poly paper city: instanced blocks on a jittered grid, clear of POIs. */
  private buildCity(places: Place[]): THREE.InstancedMesh {
    const r = rng(this.plan.cityId.charCodeAt(1) * 31);
    const cells: THREE.Matrix4[] = [];
    const step = 0.0105;
    const up = new THREE.Vector3(0, 1, 0);
    for (let x = -CITY_R; x <= CITY_R; x += step) {
      for (let z = -CITY_R; z <= CITY_R; z += step) {
        if (Math.hypot(x, z) > CITY_R - 0.006) continue;
        if (r() < 0.22) continue; // plazas and parks
        if (places.some((p) => !p.outside && Math.hypot(p.pos.x - x, p.pos.z - z) < 0.009)) continue;
        const h = 0.0015 + r() ** 2.2 * 0.012 * (1 - Math.hypot(x, z) / CITY_R * 0.6);
        const w = step * (0.55 + r() * 0.3), d = step * (0.55 + r() * 0.3);
        cells.push(new THREE.Matrix4().compose(
          new THREE.Vector3(x + (r() - 0.5) * 0.002, h / 2, z + (r() - 0.5) * 0.002),
          new THREE.Quaternion().setFromAxisAngle(up, (r() - 0.5) * 0.3),
          new THREE.Vector3(w, h, d),
        ));
      }
    }
    const blockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
    const lowPoly = new THREE.InstancedMesh(BLOCK_GEO, blockMat, cells.length);
    const c1 = new THREE.Color(PALETTE.paper), c2 = new THREE.Color(PALETTE.paperDeep), tmpC = new THREE.Color();
    cells.forEach((m, i) => {
      lowPoly.setMatrixAt(i, m);
      lowPoly.setColorAt(i, tmpC.copy(c1).lerp(c2, r() * 0.9));
    });
    this.city.add(lowPoly);
    return lowPoly;
  }

  /** Brass house for the stay, ink needles (instanced) for stops; outside stops become rim arrows. */
  private buildMarkers(places: Place[], items: PublicScheduleItem[]) {
    const pins = places.filter((pl, i) => i > 0 && !pl.outside);
    if (pins.length) {
      const at = pins.map((pl) => new THREE.Matrix4().makeTranslation(pl.pos.x, pl.pos.y, pl.pos.z));
      const { needles, heads } = pinInstances(NEEDLE_GEO, HEAD_GEO, at, 0.009, 0.018);
      this.city.add(needles, heads);
    }
    places.forEach((pl, i) => {
      const g = new THREE.Group();
      g.position.copy(pl.pos);
      if (i === 0) {
        const house = new THREE.Mesh(HOUSE_GEO, M.brass()); house.position.y = 0.003;
        const roof = new THREE.Mesh(ROOF_GEO, M.brassDark()); roof.position.y = 0.0085; roof.rotation.y = Math.PI / 4;
        g.add(house, roof);
      }
      if (pl.outside && i > 0) {
        const arrow = new THREE.Mesh(ARROW_GEO, M.ink());
        arrow.rotation.z = -Math.PI / 2;
        const holder = new THREE.Group();
        holder.add(arrow);
        holder.position.y = 0.003;
        holder.rotation.y = Math.atan2(-pl.pos.z, pl.pos.x);
        g.add(holder);
      }
      const leg = i > 0 ? items[i - 1].leg : undefined;
      const label = pl.outside && i > 0 && leg ? `to ${pl.name} · ${leg.minutes} min` : pl.name;
      const t = makeText({ text: label, font: "heading", size: 0.0052, color: PALETTE.ink, anchorX: "center", anchorY: "bottom" });
      t.position.set(pl.pos.x, pl.pos.y + (i === 0 ? 0.014 : 0.022), pl.pos.z);
      this.addLabel(t);
      if (g.children.length) this.city.add(g);
    });
  }

  /** Group route (anonymised): the whole crew walks the group moments together — one unlabeled bead per
   *  seat in plain ink, no band colours, no member ids. Picks ("some of the crew") get one neutral bead
   *  that walks stay → pick → stay. Legs are the public, crew-independent ones. */
  private buildRoutes(crewCount: number, items: PublicScheduleItem[], places: Place[]) {
    const plan = this.plan;
    const posOf = (id: string) => places.find((p) => p.id === id)?.pos ?? places[0].pos;
    const hotel = posOf(plan.hotelId);
    const walkNote = plan.cityNotes.some((n) => n.includes("hill")) ? "uphill" : "walk";
    const beadColors: string[] = [];
    const addBead = (keys: Key[], off: THREE.Vector3 | null, radius: number, color: string, hideBefore: number, hideAfter: number) => {
      this.beads.push({ keys: keys.map((k) => ({ t: k.t, p: off ? k.p.clone().add(off) : k.p.clone() })), radius, hideBefore, hideAfter });
      beadColors.push(color);
    };
    const leg = (a: THREE.Vector3, b: THREE.Vector3, color: string, flagged: boolean, minutes: number) => {
      this.strips.add(a, b, color, flagged);
      if (flagged) this.marginNote(a, b, `${minutes} min ${walkNote}`);
    };

    const group = items.filter((it) => it.kind === "group").sort((a, b) => a.startMin - b.startMin);
    if (group.length) {
      const keys: Key[] = [];
      let cur = hotel.clone();
      let lastEnd = -Infinity;
      for (const it of group) {
        const dest = posOf(it.activityId);
        const minutes = it.leg?.minutes ?? 15;
        if ((!it.leg || it.leg.fromId === plan.hotelId) && !cur.equals(hotel)) {
          keys.push({ t: lastEnd, p: cur.clone() }, { t: lastEnd + Math.min(minutes, 30), p: hotel.clone() });
          this.strips.add(cur, hotel, PALETTE.ink, false);
          cur = hotel.clone();
        }
        keys.push({ t: it.startMin - minutes, p: cur.clone() }, { t: it.startMin, p: dest.clone() }, { t: it.endMin, p: dest.clone() });
        const flagged = !!it.leg?.flagged;
        leg(cur, dest, flagged ? PALETTE.soundingRed : PALETTE.ink, flagged, minutes);
        cur = dest.clone();
        lastEnd = it.endMin;
      }
      keys.push({ t: lastEnd, p: cur.clone() }, { t: lastEnd + 25, p: hotel.clone() });
      const n = Math.max(1, crewCount);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        addBead(keys, new THREE.Vector3(Math.cos(a) * 0.0032, 0, Math.sin(a) * 0.0032), 0.003, PALETTE.ink, keys[0].t, Infinity);
      }
    }

    for (const it of items.filter((x) => x.kind === "pick")) {
      const dest = posOf(it.activityId);
      const from = it.leg ? posOf(it.leg.fromId) : hotel; // the stay, or the group moment just before
      const minutes = it.leg?.minutes ?? 15;
      const back = Math.min(minutes, 30);
      const keys: Key[] = [
        { t: it.startMin - minutes, p: from.clone() }, { t: it.startMin, p: dest.clone() },
        { t: it.endMin, p: dest.clone() }, { t: it.endMin + back, p: hotel.clone() },
      ];
      const flagged = !!it.leg?.flagged;
      leg(from, dest, flagged ? PALETTE.soundingRed : PALETTE.inkSoft, flagged, minutes);
      addBead(keys, null, 0.0026, PALETTE.inkSoft, keys[0].t, keys[3].t);
    }

    const strips = this.strips.build();
    if (strips) this.city.add(strips);
    if (this.beads.length) {
      // every bead in one instanced mesh; white base × per-bead ink colour = the old band material
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, flatShading: true });
      const mesh = new THREE.InstancedMesh(BEAD_GEO, mat, this.beads.length);
      const c = new THREE.Color();
      beadColors.forEach((hex, i) => mesh.setColorAt(i, c.set(hex)));
      mesh.frustumCulled = false; // instances move every frame; the plate is always in view anyway
      this.beadMesh = mesh;
      this.city.add(mesh);
      this.placeBeads(-Infinity, true);
    }
  }

  /** Paper tag leaning on the base: city · stay · public total, public flags in red hand. */
  private buildTag(): THREE.Group {
    const plan = this.plan;
    const tag = new THREE.Group();
    const flags = [...plan.publicFlags.map((f) => f.detail), ...plan.cityNotes.filter((n) => !plan.publicFlags.some((f) => n.includes(f.detail)))].slice(0, 2);
    const card = paperCard(0.15, 0.062);
    card.position.y = 0.031;
    const texts = new BatchedText(); // the tag's lines in one draw call (O2-056)
    texts.depthOffset = -1;
    texts.frustumCulled = false;
    const title = makeText({ text: `${plan.label ? plan.label + " · " : ""}${plan.cityName}`, font: "heading", size: 0.011, anchorX: "left", anchorY: "top" });
    title.position.set(-0.068, 0.058, 0.0008);
    const sub = makeText({ text: plan.hotelName, font: "body", size: 0.0068, color: PALETTE.inkSoft, anchorX: "left", anchorY: "top", maxWidth: 0.1 });
    sub.position.set(-0.068, 0.044, 0.0008);
    // S2-002: the public range (from public facts only), never the exact total
    const price = makeText({ text: `${formatDollars(plan.groupRange.lowCents)}–${formatDollars(plan.groupRange.highCents).slice(1)}`, font: "mono", size: 0.0095, anchorX: "right", anchorY: "top" });
    price.position.set(0.068, 0.058, 0.0008);
    const notes = makeText({ text: flags.join(" · "), font: "hand", size: 0.0056, color: PALETTE.soundingRed, anchorX: "left", anchorY: "top", maxWidth: 0.135 });
    notes.position.set(-0.068, 0.03, 0.0008);
    this.votesText = makeText({ text: "", font: "heading", size: 0.0068, color: PALETTE.inkSoft, anchorX: "right", anchorY: "bottom" });
    this.votesText.position.set(0.068, 0.006, 0.0008);
    texts.add(title, sub, price, notes, this.votesText);
    tag.add(card, texts);
    if (plan.fitsEveryone) {
      const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.013, 0.002), M.brass());
      plaque.position.set(0.034, 0.012, 0.0012);
      const pt = makeText({ text: "Fits everyone", font: "heading", size: 0.0062, color: PALETTE.ink });
      pt.position.set(0.03, 0.012, 0.0028);
      texts.add(pt);
      const tick = inkCheck(0.0062);
      tick.position.set(0.054, 0.009, 0.0028);
      tag.add(plaque, tick);
    }
    tag.position.set(0, 0, CLOCHE_R + 0.03);
    tag.rotation.x = -0.5;
    return tag;
  }

  private marginNote(a: THREE.Vector3, b: THREE.Vector3, text: string) {
    const t = makeText({ text, font: "hand", size: 0.0068, color: PALETTE.soundingRed, anchorX: "center", anchorY: "bottom" });
    t.position.set((a.x + b.x) / 2, 0.02, (a.z + b.z) / 2);
    this.addLabel(t);
  }

  private addLabel(t: Text) {
    this.labelBatch.add(t);
    this.labels.push(t);
  }

  /** Slide out from under the chart (700 ms, glass clink). */
  slideOut(instant = false) {
    const from = new THREE.Vector3(this.rest.x * 0.2, 0, 0);
    if (instant) { this.group.position.copy(this.rest); this.group.scale.setScalar(1); return Promise.resolve(); }
    this.group.scale.setScalar(0.3);
    return this.tw.to(700, (t) => {
      this.group.position.lerpVectors(from, this.rest, t);
      this.group.scale.setScalar(0.3 + 0.7 * t);
    }, ease.out, `cloche-${this.plan.planId}`);
  }

  slideBack() {
    const from = this.group.position.clone();
    const to = new THREE.Vector3(this.rest.x * 0.2, 0, 0);
    return this.tw.to(600, (t) => {
      this.group.position.lerpVectors(from, to, t);
      this.group.scale.setScalar(1 - 0.7 * t);
    }, ease.in, `cloche-${this.plan.planId}`).then(() => (this.group.visible = false));
  }

  /** Grab-and-lift feedback when chosen: 5 cm above rest (repeat picks don't stack). */
  lift(up = true) {
    const y0 = this.group.position.y, y1 = up ? 0.05 : 0;
    if (y0 === y1) return Promise.resolve();
    return this.tw.prop(this.group.position, "y", y1, 350, ease.out, `lift-${this.plan.planId}`);
  }

  setVotes(n: number) { setText(this.votesText, n ? `${n} ${n === 1 ? "aye" : "ayes"}` : ""); }

  private beadM = new THREE.Matrix4();
  private beadS = new THREE.Vector3();
  private static readonly NO_ROT = new THREE.Quaternion();
  private lastMin: number | null = null;

  /** Move every bead to in-trip minute `min` (hidden beads get zero scale). The clock moves a fraction of a minute
   *  per frame, so beads move in 0.1-minute steps (O2-058: the old exact compare re-placed them every frame). */
  private placeBeads(min: number, force = false) {
    const mesh = this.beadMesh;
    min = Math.round(min * 10) / 10;
    if (!mesh || (!force && min === this.lastMin)) return;
    this.lastMin = min;
    for (let i = 0; i < this.beads.length; i++) {
      const b = this.beads[i];
      const k = b.keys;
      let p = k[k.length - 1].p;
      for (let j = 0; j < k.length - 1; j++) {
        if (min < k[0].t) { p = k[0].p; break; }
        if (min >= k[j].t && min <= k[j + 1].t) {
          const span = k[j + 1].t - k[j].t;
          p = span <= 0 ? k[j + 1].p : this.tmp.lerpVectors(k[j].p, k[j + 1].p, (min - k[j].t) / span);
          break;
        }
      }
      const shown = force || (min >= b.hideBefore && min <= b.hideAfter);
      this.cam.set(p.x, 0.004, p.z); // scratch position
      this.beadS.setScalar(shown ? b.radius : 0);
      mesh.setMatrixAt(i, this.beadM.compose(this.cam, DryRunCloche.NO_ROT, this.beadS));
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Move beads to in-trip minute `min`; labels face the camera (`camPos`, world space). */
  update(min: number | null, camPos: THREE.Vector3) {
    if (min !== null) this.placeBeads(min);
    // batch members aren't scene children: they're placed relative to the batch
    for (const l of this.labels) billboard(l, camPos, this.labelBatch);
  }
  private cam = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  /** Swap low-poly blocks for photoreal tiles when they arrive (routes/pins stay). */
  showLowPoly(v: boolean) { this.lowPoly.visible = v; }

  get cityScale() { return this.scale; }

  dispose() {
    this.group.removeFromParent();
    disposeObject(this.group); // own geometry/materials + text; the shared geometry and plain-card material stay
    this.plateTex.dispose(); // GPU copy only: the painted plate stays cached for a re-entry (O2-055)
  }
}
