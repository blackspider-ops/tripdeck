// Small paper-and-brass props more than one piece builds (O2-018): pin needles with wax heads, paper name flags,
// tags hung on twine and folded letters. One builder each instead of near-copies with different constants.
import * as THREE from "three";
import type { Text } from "troika-three-text";
import { M, inkA, paperCard, sharedGeometry } from "./materials";
import { makeText, type TextOpts } from "./text";

/** Map pins: one instanced ink needle mesh and one instanced wax head mesh for all of them (two draws in all). */
export function pinInstances(needle: THREE.BufferGeometry, head: THREE.BufferGeometry, at: readonly THREE.Matrix4[], needleUp: number, headUp: number) {
  const needles = new THREE.InstancedMesh(needle, M.ink(), at.length);
  const heads = new THREE.InstancedMesh(head, M.wax(), at.length);
  const n = new THREE.Matrix4().makeTranslation(0, needleUp, 0), h = new THREE.Matrix4().makeTranslation(0, headUp, 0);
  const m = new THREE.Matrix4();
  at.forEach((base, i) => {
    needles.setMatrixAt(i, m.multiplyMatrices(base, n));
    heads.setMatrixAt(i, m.multiplyMatrices(base, h));
  });
  return { needles, heads };
}

const FLAG_GEOS = new Map<number, THREE.PlaneGeometry>();
/** A unit-wide card plane of height `h`, scaled to its label's width. */
function flagGeometry(h: number) {
  let g = FLAG_GEOS.get(h);
  if (!g) FLAG_GEOS.set(h, (g = sharedGeometry(new THREE.PlaneGeometry(1, h))));
  return g;
}

/**
 * A paper name flag: a double-sided card that starts at x = `x0` and fits its label (sized from the laid-out text
 * once troika has it; `guessPerChar` until then). The label is left-anchored `pad` in from the card's edge.
 */
export function paperFlag(label: TextOpts, h: number, opts: { x0?: number; pad: number; guessPerChar: number }) {
  const group = new THREE.Group();
  const x0 = opts.x0 ?? 0;
  const card = new THREE.Mesh(flagGeometry(h), M.paperDouble());
  const fit = (w: number) => { card.scale.x = w; card.position.x = x0 + w / 2; };
  fit(opts.pad * 2 + label.text.length * opts.guessPerChar);
  const text = makeText({ ...label, anchorX: "left", anchorY: "middle" });
  text.position.set(x0 + opts.pad, 0, 0.0004);
  text.addEventListener("synccomplete", () => {
    const b = text.textRenderInfo?.blockBounds;
    if (b) fit(b[2] - b[0] + opts.pad * 2);
  });
  group.add(card, text);
  return { group, card, text };
}

/** A paper tag hanging off a twine string (the Captain's "Weigh anchor", the booked chart's reference). */
export function hangingTag(card: THREE.Mesh, label: Text, twine: { length: number; x: number; y: number; tilt: number }) {
  const tag = new THREE.Group();
  const string = new THREE.Mesh(twineGeometry(twine.length), M.twine());
  string.position.set(twine.x, twine.y, 0);
  string.rotation.z = twine.tilt;
  tag.add(card, label, string);
  return tag;
}

const TWINE_GEOS = new Map<number, THREE.CylinderGeometry>();
function twineGeometry(length: number) {
  let g = TWINE_GEOS.get(length);
  if (!g) TWINE_GEOS.set(length, (g = sharedGeometry(new THREE.CylinderGeometry(0.0003, 0.0003, length, 4))));
  return g;
}

/** A folded letter: a small card with the fold drawn in ink, an optional red wax dot at the point. */
export function foldedLetter(w: number, h: number, px: number, key: string, wax?: string) {
  return paperCard(w, h, (g, W, H) => {
    g.strokeStyle = inkA(wax ? 0.5 : 0.6); g.lineWidth = 3;
    const tip = wax ? 0.55 : 0.6;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(W / 2, H * tip); g.lineTo(W, 0); g.stroke();
    if (wax) { g.fillStyle = wax; g.beginPath(); g.arc(W / 2, H * tip, H * 0.14, 0, Math.PI * 2); g.fill(); }
  }, px, key);
}

/** Label text for a tag or card, placed a hair in front of it. */
export function cardText(o: TextOpts, x: number, y: number, z = 0.0006) {
  const t = makeText(o);
  t.position.set(x, y, z);
  return t;
}
