// The root of the chart room: a Ø70 cm paper chart on green baize, held flat by brass weights (doc 02 §7.1).
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import { M, inkA, mergedGeometry, paintPaper, rng, shadowDecal, paperCard, sharedGeometry, sharedSheet, sheetTexture } from "./materials";
import { makeText, setText } from "./text";
import type { Text } from "troika-three-text";
import { ease, type Tweens } from "./tween";
import { CARD } from "./copy";

export const CHART_R = 0.35;
export const COMPASS_POS = new THREE.Vector3(0, 0.0035, -0.285);

type Paint = CanvasRenderingContext2D;

/** Double border and degree ticks on the border band. */
function paintBorder(g: Paint, cx: number, cy: number, R: number) {
  g.strokeStyle = PALETTE.ink;
  g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, R * 0.955, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R * 0.93, 0, Math.PI * 2); g.stroke();
  for (let d = 0; d < 360; d += 5) {
    const a = (d * Math.PI) / 180, r1 = R * 0.93, r2 = R * (d % 30 === 0 ? 0.955 : 0.945);
    g.lineWidth = d % 30 === 0 ? 2.5 : 1.2;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
  }
}

/** Rhumb lines radiating from the compass rose, clipped to the border. */
function paintRhumbs(g: Paint, cx: number, cy: number, R: number, rx: number, ry: number, W: number) {
  g.save();
  g.beginPath(); g.arc(cx, cy, R * 0.93, 0, Math.PI * 2); g.clip();
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    g.strokeStyle = i % 8 === 0 ? inkA(0.3) : i % 4 === 0 ? inkA(0.18) : inkA(0.1);
    g.lineWidth = i % 8 === 0 ? 2 : 1.2;
    g.beginPath(); g.moveTo(rx, ry); g.lineTo(rx + Math.cos(a) * W * 1.4, ry + Math.sin(a) * W * 1.4); g.stroke();
  }
  g.restore();
}

/** The printed compass rose (the brass pointers sit on top of it) with its red N. */
function paintRose(g: Paint, rx: number, ry: number) {
  const star = (r: number, n: number, rot: number, fill: string) => {
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      const l = i % 2 === 0 ? r : r * 0.55;
      g.beginPath();
      g.moveTo(rx, ry);
      g.lineTo(rx + Math.cos(a - 0.12) * l * 0.22, ry + Math.sin(a - 0.12) * l * 0.22);
      g.lineTo(rx + Math.cos(a) * l, ry + Math.sin(a) * l);
      g.lineTo(rx + Math.cos(a + 0.12) * l * 0.22, ry + Math.sin(a + 0.12) * l * 0.22);
      g.closePath();
      g.fillStyle = i % 2 === 0 ? fill : "rgba(0,0,0,0)";
      g.fill();
      g.strokeStyle = PALETTE.ink; g.lineWidth = 1.5; g.stroke();
    }
  };
  g.lineWidth = 2; g.strokeStyle = PALETTE.ink;
  g.beginPath(); g.arc(rx, ry, 150, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(rx, ry, 138, 0, Math.PI * 2); g.stroke();
  star(130, 16, -Math.PI / 2 + Math.PI / 16, inkA(0.25));
  star(150, 8, -Math.PI / 2, PALETTE.ink);
  g.fillStyle = PALETTE.soundingRed;
  g.font = "italic 44px Georgia, serif"; g.textAlign = "center";
  g.fillText("N", rx, ry - 168);
}

/** The "ALL AYES" cartouche, lower left. */
function paintCartouche(g: Paint, x: number, y: number) {
  g.save();
  g.translate(x, y);
  g.rotate(-0.12);
  g.strokeStyle = PALETTE.ink; g.lineWidth = 3;
  g.strokeRect(-190, -62, 380, 124); g.lineWidth = 1.2; g.strokeRect(-180, -52, 360, 104);
  g.fillStyle = PALETTE.ink; g.font = "58px Georgia, serif";
  g.fillText("ALL AYES", 0, 4);
  g.font = "italic 26px Georgia, serif"; g.fillStyle = PALETTE.inkSoft;
  g.fillText("a chart for the whole crew", 0, 40);
  g.restore();
}

/** Designed at 2048² (1024² on a headset, same drawing); painted once per page. */
function chartTexture() {
  return sharedSheet("chart", () => sheetTexture(2048, 2048, (g, W, H) => {
    paintPaper(g, W, H, PALETTE.paper, 11);
    const cx = W / 2, cy = H / 2, R = W / 2;
    // the printed rose sits under the brass compass (O2-034: derived, was a hand-computed 0.8143)
    const rx = cx, ry = cy + R * (COMPASS_POS.z / CHART_R);
    paintBorder(g, cx, cy, R);
    paintRhumbs(g, cx, cy, R, rx, ry, W);
    paintRose(g, rx, ry);
    paintCartouche(g, cx - R * 0.5, cy + R * 0.62);
  }));
}

export class CaptionStrip {
  group = new THREE.Group();
  private speaker: Text;
  private line: Text;
  private card: THREE.Mesh;
  private shown: [string, string, string] | null = null;

  constructor() {
    this.card = paperCard(0.6, 0.085);
    this.group.add(this.card);
    this.speaker = makeText({ text: "", font: "heading", size: 0.0115, color: PALETTE.inkSoft, anchorX: "left", anchorY: "top", letterSpacing: 0.06 });
    this.speaker.position.set(-0.285, 0.036, 0.001);
    this.line = makeText({ text: CARD.captionIdle, font: "body", size: 0.0175, anchorX: "left", anchorY: "top", maxWidth: 0.57, lineHeight: 1.18 });
    this.line.position.set(-0.285, 0.019, 0.001);
    this.group.add(this.speaker, this.line);
    // stands at the south edge, leaning back toward the Organizer like a place card
    this.group.position.set(0, 0.046, CHART_R + 0.02);
    this.group.rotation.x = -0.55;
  }

  set(speaker: string, text: string, color: string = PALETTE.ink) {
    const s = this.shown;
    if (s && s[0] === speaker && s[1] === text && s[2] === color) return; // no troika re-layout (OPT-051)
    this.shown = [speaker, text, color];
    // colour first: it's applied at render, so the speaker is laid out once (O2-058; was sync() twice)
    this.speaker.color = color;
    setText(this.speaker, speaker.toUpperCase());
    setText(this.line, text);
  }

  setScale(s: number) {
    this.speaker.fontSize = 0.0115 * s;
    this.line.fontSize = 0.0175 * s;
    this.speaker.sync(); this.line.sync();
  }
}

/** A brass weight's body and cap in one geometry (the four weights are one instanced mesh, O2-056). */
let weightGeo: THREE.BufferGeometry | null = null;
function weightGeometry() {
  if (weightGeo) return weightGeo;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.014, 20));
  body.position.y = 0.007;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8));
  cap.position.y = 0.016;
  return (weightGeo = sharedGeometry(mergedGeometry([body, cap])));
}

export class ChartTable {
  group = new THREE.Group();
  caption = new CaptionStrip();
  private sheet: THREE.Mesh;

  constructor(private tw: Tweens) {
    // baize under the chart
    const baize = new THREE.Mesh(new THREE.CircleGeometry(CHART_R + 0.06, 72), M.baize());
    baize.rotation.x = -Math.PI / 2;
    baize.position.y = 0.0008;
    this.group.add(baize);

    // paper disc with a deckled edge
    const r = rng(21);
    const shape = new THREE.Shape();
    const N = 160;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const rad = CHART_R + (r() - 0.5) * 0.004;
      const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    const geo = new THREE.ShapeGeometry(shape, 1);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / (2 * CHART_R) + 0.5, pos.getY(i) / (2 * CHART_R) + 0.5);
    geo.rotateX(-Math.PI / 2);
    this.sheet = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: chartTexture(), roughness: 0.95 }));
    this.sheet.position.y = 0.0025;
    this.group.add(this.sheet);

    // four brass weights: one instanced brass mesh and one instanced shadow (was 12 meshes)
    const angles = [40, 140, 220, 320];
    const weights = new THREE.InstancedMesh(weightGeometry(), M.brass(), angles.length);
    const decal = shadowDecal(0.03);
    const shadows = new THREE.InstancedMesh(decal.geometry, decal.material, angles.length);
    shadows.renderOrder = decal.renderOrder;
    const m = new THREE.Matrix4(), p = new THREE.Vector3();
    angles.forEach((deg, i) => {
      const a = (deg * Math.PI) / 180;
      p.set(Math.cos(a) * (CHART_R - 0.012), 0.0025, Math.sin(a) * (CHART_R - 0.012));
      weights.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
      decal.position.copy(p).add(new THREE.Vector3(0, 0.0005, 0));
      decal.updateMatrix();
      shadows.setMatrixAt(i, decal.matrix);
    });
    this.group.add(weights, shadows);
    this.group.add(this.caption.group);
  }

  /** Paper unroll on placement (doc 03 Q0): 700 ms. */
  unroll() {
    this.sheet.scale.set(1, 1, 0.02);
    return this.tw.to(700, (t) => this.sheet.scale.set(1, 1, Math.max(0.02, t)), ease.out);
  }
}
