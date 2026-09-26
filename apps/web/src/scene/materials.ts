// Every surface is made of something (doc 02 §1, §5). Textures are drawn procedurally on canvases —
// nothing to download, nothing glowing.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALETTE } from "@all-ayes/shared";

/** `PALETTE.ink` at an alpha, for canvas strokes (O2-034: was `rgba(31,42,68,…)` written out 15 times). */
export function inkA(alpha: number) {
  const c = new THREE.Color(PALETTE.ink);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${alpha})`;
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, g: c.getContext("2d")! };
}

/** Deterministic PRNG so the paper looks the same every load. */
export function rng(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- texture budget (OPT-049)
// Every sheet is drawn in a fixed *logical* pixel space (the sizes the look was designed at) and scaled
// onto a smaller physical canvas where that's enough: the drawing is identical, only the resolution drops.

/** Standalone headset browsers and phones (Gear VR / Cardboard) get half-resolution big sheets (¼ of the GPU memory).
 *  `?lowtex` or `?vr=…` forces it. */
const LOW_TEX = (() => {
  try {
    const q = new URLSearchParams(location.search);
    return /OculusBrowser|Quest|Pico|Android/i.test(navigator.userAgent) || q.has("lowtex") || q.has("vr");
  } catch { return false; }
})();
/** Physical size for a sheet designed at `logical` px (2048 → 1024 on a headset). */
function sheetPx(logical: number) { return LOW_TEX ? Math.max(256, logical / 2) : logical; }
/** Cards never need more than this many texels per metre (text is SDF, not in the canvas). */
const CARD_PX_PER_M = LOW_TEX ? 2048 : 4096;

// Textures that outlive any one mesh: never disposed by `disposeObject`, freed (GPU side) on Stage teardown.
const sharedTex = new Set<THREE.Texture>();
function share<T extends THREE.Texture>(t: T): T { sharedTex.add(t); return t; }
const sharedGeo = new Set<THREE.BufferGeometry>();
/** Geometry reused by many meshes (and Stages): `disposeObject` leaves it alone. */
export function sharedGeometry<T extends THREE.BufferGeometry>(g: T): T { sharedGeo.add(g); return g; }

// ---------------------------------------------------------------- paper

const TILE = 512;
function paintNoise(g: CanvasRenderingContext2D, w: number, h: number, seed: number) {
  const r = rng(seed);
  // drawn wrapped around the edges so the tile repeats without seams
  const wrap = (x: number, y: number, pad: number, fn: (x: number, y: number) => void) => {
    for (const dx of x < pad ? [0, w] : x > w - pad ? [0, -w] : [0]) {
      for (const dy of y < pad ? [0, h] : y > h - pad ? [0, -h] : [0]) fn(x + dx, y + dy);
    }
  };
  // mottling
  for (let i = 0; i < (w * h) / 900; i++) {
    const x = r() * w, y = r() * h, rad = 6 + r() * 40;
    const dark = r() < 0.5;
    wrap(x, y, rad, (px, py) => {
      const grd = g.createRadialGradient(px, py, 0, px, py, rad);
      grd.addColorStop(0, dark ? "rgba(120,95,55,0.035)" : "rgba(255,250,235,0.05)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd;
      g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    });
  }
  // fibers
  g.lineWidth = 0.6;
  for (let i = 0; i < (w * h) / 600; i++) {
    const x = r() * w, y = r() * h, a = r() * Math.PI, l = 3 + r() * 9;
    const style = `rgba(110,90,60,${0.04 + r() * 0.05})`;
    wrap(x, y, 12, (px, py) => {
      g.strokeStyle = style;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
      g.stroke();
    });
  }
}

let noiseTile: HTMLCanvasElement | null = null;
/** Mottling + fibers on transparent, painted once (≈300 gradients + 440 strokes) and tiled everywhere. */
function paperNoise() {
  if (noiseTile) return noiseTile;
  const { c, g } = canvas(TILE, TILE);
  paintNoise(g, TILE, TILE, 3);
  return (noiseTile = c);
}

/** Paper: a base wash plus the shared seamless noise tile, offset per seed. One pattern fill instead of
 *  w·h/900 gradients + w·h/600 strokes per sheet (the old main-thread hitch on Quest). Honours the
 *  context's transform, so a sheet drawn scaled down keeps the same grain in world units. */
export function paintPaper(g: CanvasRenderingContext2D, w: number, h: number, base: string = PALETTE.paper, seed = 3) {
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const pat = g.createPattern(paperNoise(), "repeat");
  if (!pat) return;
  const r = rng(seed);
  const ox = Math.floor(r() * TILE), oy = Math.floor(r() * TILE);
  g.save();
  g.translate(-ox, -oy);
  g.fillStyle = pat;
  g.fillRect(ox, oy, w, h);
  g.restore();
}

let paperTex: THREE.CanvasTexture | null = null;
function paperTexture(): THREE.CanvasTexture {
  if (paperTex) return paperTex;
  const { c, g } = canvas(TILE, TILE);
  g.fillStyle = PALETTE.paper;
  g.fillRect(0, 0, TILE, TILE);
  g.drawImage(paperNoise(), 0, 0);
  paperTex = share(new THREE.CanvasTexture(c));
  paperTex.colorSpace = THREE.SRGBColorSpace;
  paperTex.wrapS = paperTex.wrapT = THREE.RepeatWrapping;
  paperTex.anisotropy = 4;
  return paperTex;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const { c, g } = canvas(w, h);
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A sheet designed at `lw`×`lh` logical px, painted at `sheetPx` resolution with the same drawing. */
export function sheetTexture(lw: number, lh: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const k = sheetPx(lw) / lw;
  return canvasTexture(Math.round(lw * k), Math.round(lh * k), (g) => {
    g.scale(k, k);
    draw(g, lw, lh);
  });
}

/** Memoised shared sheet (chart, globe, street plates): painted once per page, never per phase change. */
const sheets = new Map<string, THREE.CanvasTexture>();
const MAX_SHEETS = 8;
export function sharedSheet(key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture {
  let t = sheets.get(key);
  if (t) { sheets.delete(key); sheets.set(key, t); return t; } // most recently used last
  t = share(make());
  sheets.set(key, t);
  if (sheets.size > MAX_SHEETS) {
    // evict the least recently used street plate (chart and globe stay). Evicting only frees the GPU copy
    // + our reference; a mesh still holding it would simply re-upload.
    const victim = [...sheets.entries()].find(([k]) => k.startsWith("street:"));
    if (!victim) return t;
    const [oldKey, old] = victim;
    sheets.delete(oldKey);
    sharedTex.delete(old);
    old.dispose();
  }
  return t;
}

/** Merge meshes' geometries (already placed by their position/rotation/scale) into one, for one draw call (O2-056). */
export function mergedGeometry(parts: THREE.Mesh[]): THREE.BufferGeometry {
  const geos = parts.map((m) => {
    m.updateMatrix();
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
    return g.applyMatrix4(m.matrix);
  });
  const out = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  for (const m of parts) if (!sharedGeo.has(m.geometry)) m.geometry.dispose();
  if (!out) throw new Error("mergedGeometry: incompatible parts");
  return out;
}

const cache = new Map<string, THREE.Material>();
function once<T extends THREE.Material>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

export const M = {
  paper: () => once("paper", () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: paperTexture(), roughness: 0.95, metalness: 0 })),
  paperDouble: () => once("paperDouble", () => new THREE.MeshStandardMaterial({ color: 0xffffff, map: paperTexture(), roughness: 0.95, side: THREE.DoubleSide })),
  brass: () => once("brass", () => new THREE.MeshStandardMaterial({ color: PALETTE.brass, roughness: 0.38, metalness: 0.85 })),
  brassDark: () => once("brassDark", () => new THREE.MeshStandardMaterial({ color: PALETTE.brassDark, roughness: 0.45, metalness: 0.8 })),
  wood: () => once("wood", () => new THREE.MeshStandardMaterial({ color: PALETTE.wood, roughness: 0.6, flatShading: true })),
  woodDark: () => once("woodDark", () => new THREE.MeshStandardMaterial({ color: PALETTE.woodDark, roughness: 0.65, flatShading: true })),
  wax: () => once("wax", () => new THREE.MeshStandardMaterial({ color: PALETTE.soundingRed, roughness: 0.4, flatShading: true })),
  waxDark: () => once("waxDark", () => new THREE.MeshStandardMaterial({ color: PALETTE.waxDark, roughness: 0.5, flatShading: true })),
  // Plain transparent glass — no transmission pass (too expensive on Quest), no frosting, no glow.
  glass: () => once("glass", () => new THREE.MeshStandardMaterial({ color: 0xf4f7f6, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide })),
  glassRim: () => once("glassRim", () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, transparent: true, opacity: 0.35, depthWrite: false })),
  baize: () => once("baize", () => new THREE.MeshStandardMaterial({ color: PALETTE.baize, roughness: 1 })),
  ink: () => once("ink", () => new THREE.MeshBasicMaterial({ color: PALETTE.ink })),
  /** Faint ruled ink lines on paper (the seal chart's head rule). */
  inkRule: () => once("inkRule", () => new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.55, depthWrite: false })),
  graphite: () => once("graphite", () => new THREE.MeshBasicMaterial({ color: PALETTE.graphite, transparent: true, opacity: 0.55 })),
  twine: () => once("twine", () => new THREE.MeshStandardMaterial({ color: PALETTE.twine, roughness: 1, flatShading: true })),
  shadow: () => once("shadow", () => new THREE.MeshBasicMaterial({ map: contactShadow(), transparent: true, depthWrite: false, opacity: 0.55 })),
  /** Undrawn paper cards (O2-055): the shared paper tile in world units plus one shared deckle alpha strip. */
  cardPlain: () => once("cardPlain", () => {
    const deckle = deckleTexture();
    const m = new THREE.MeshStandardMaterial({ map: paperTexture(), alphaMap: deckle, roughness: 0.95, alphaTest: 0.5, side: THREE.DoubleSide });
    return m;
  }),
};

const bandCache = new Map<string, THREE.Material>();
export function bandMaterial(hex: string) {
  if (!bandCache.has(hex)) bandCache.set(hex, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55, flatShading: true }));
  return bandCache.get(hex)!;
}
/** Unlit ink in a band (or any) colour; `doubleSide` for strips seen from both faces (crew flags, O2-056). */
export function bandInk(hex: string, doubleSide = false) {
  const k = (doubleSide ? "ink2" : "ink") + hex;
  if (!bandCache.has(k)) bandCache.set(k, new THREE.MeshBasicMaterial({ color: hex, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide }));
  return bandCache.get(k)!;
}

let shadowTex: THREE.Texture | null = null;
/** Fake contact shadow: a soft darkened decal under objects (no shadow maps on Quest). */
function contactShadow() {
  if (shadowTex) return shadowTex;
  shadowTex = share(canvasTexture(128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, "rgba(40,28,15,0.55)");
    grd.addColorStop(0.6, "rgba(40,28,15,0.18)");
    grd.addColorStop(1, "rgba(40,28,15,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  }));
  return shadowTex;
}

const SHADOW_GEO = sharedGeometry(new THREE.PlaneGeometry(2, 2));
export function shadowDecal(radius: number) {
  const m = new THREE.Mesh(SHADOW_GEO, M.shadow()); // one geometry for every decal, scaled (O2-056)
  m.scale.setScalar(radius);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.0005;
  m.renderOrder = 1;
  return m;
}

const cards = new Map<string, { tex: THREE.CanvasTexture; mat: THREE.MeshStandardMaterial }>();
/** Inked cards kept for reuse; beyond this the least recently used one is dropped (O2-055). */
const MAX_CARDS = 24;

// ---------------------------------------------------------------- plain cards (O2-055)
// An undrawn card used to paint its own canvas at up to 4096 px/m (caption strip, menus, hail card, cloche tags:
// ≈ 15 MB on desktop). Now every plain card shares the paper tile (mapped in world units) and one small deckle
// strip for the torn bottom edge, whatever its size.

/** Paper tile repeat in world units, and the deckle strip's size. */
const PAPER_TILE_M = 0.15;
const DECKLE_W_M = 0.05;
const DECKLE_H_M = 0.0016;

let deckleTex: THREE.CanvasTexture | null = null;
/** Alpha strip: opaque above a torn line along the bottom (repeats sideways, clamps upward). */
function deckleTexture() {
  if (deckleTex) return deckleTex;
  const W = 256, H = 16;
  const { c, g } = canvas(W, H);
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  const r = rng(17);
  g.fillStyle = "#fff";
  g.beginPath();
  g.moveTo(0, 0);
  for (let x = 0; x <= W; x += 4) g.lineTo(x, H * (0.25 + r() * 0.7)); // canvas y grows down: the tear is near the bottom
  g.lineTo(W, 0);
  g.closePath();
  g.fill();
  deckleTex = share(new THREE.CanvasTexture(c));
  deckleTex.colorSpace = THREE.NoColorSpace;
  deckleTex.wrapS = THREE.RepeatWrapping;
  deckleTex.wrapT = THREE.ClampToEdgeWrapping;
  deckleTex.channel = 1; // its own uv set: card-local metres, not the paper tile's
  return deckleTex;
}

function plainCardGeometry(w: number, h: number) {
  const geo = new THREE.PlaneGeometry(w, h);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const r = rng(Math.round(w * 1000) + Math.round(h * 7919));
  const ox = r(), oy = r();
  const uv1 = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + w / 2, y = pos.getY(i) + h / 2;
    uv.setXY(i, ox + x / PAPER_TILE_M, oy + y / PAPER_TILE_M);
    // canvas row 0 (top) is v = 1 with flipY: the torn edge sits at v ≈ 0, the card's bottom
    uv1[i * 2] = x / DECKLE_W_M;
    uv1[i * 2 + 1] = y / DECKLE_H_M;
  }
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  return geo;
}

/** A flat paper card (plane) with a deckled bottom edge. Plain cards (no `draw`) share one material and texture.
 *  Inked ones draw into their own texture: `draw` works in the card's logical pixel space (`px` wide); the canvas
 *  itself is capped at CARD_PX_PER_M, scaled so the drawing is unchanged. Identical inked cards share one texture +
 *  material when given a `key` naming what `draw` paints. */
export function paperCard(w: number, h: number, draw?: (g: CanvasRenderingContext2D, W: number, H: number) => void, px = 1024, key?: string) {
  if (!draw) return new THREE.Mesh(plainCardGeometry(w, h), M.cardPlain());
  const W = px, H = Math.max(32, Math.round((px * h) / w));
  const k = Math.min(1, Math.max(128, Math.round(w * CARD_PX_PER_M)) / W);
  const id = key ? `${Math.round(w * 1e4)}x${Math.round(h * 1e4)}@${W}:${key}` : null;
  let card = id ? cards.get(id) : undefined;
  if (card && id) { cards.delete(id); cards.set(id, card); } // most recently used last
  if (!card) {
    const tex = canvasTexture(Math.round(W * k), Math.max(16, Math.round(H * k)), (g, pw, ph) => {
      g.scale(pw / W, ph / H);
      paintPaper(g, W, H, PALETTE.paper, Math.round(w * 1000));
      // deckled bottom edge
      g.globalCompositeOperation = "destination-out";
      const r = rng(Math.round(h * 1000));
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += 6) g.lineTo(x, H - 2 - r() * 5);
      g.lineTo(W, H);
      g.closePath();
      g.fill();
      g.globalCompositeOperation = "source-over";
      g.strokeStyle = "rgba(126,98,54,0.35)";
      g.lineWidth = 2;
      g.strokeRect(1, 1, W - 2, H - 8);
      draw(g, W, H);
    });
    // alphaTest alone cuts the deckle; `transparent` would only add sorting + blending cost on Quest
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, alphaTest: 0.5, side: THREE.DoubleSide });
    card = { tex, mat };
    if (id) {
      cards.set(id, card); share(tex); cache.set(`card:${id}`, mat);
      if (cards.size > MAX_CARDS) {
        // a mesh still holding the evicted one simply re-uploads it
        const [oldId, old] = cards.entries().next().value!;
        cards.delete(oldId); cache.delete(`card:${oldId}`); sharedTex.delete(old.tex);
        old.tex.dispose(); old.mat.dispose();
      }
    }
  }
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), card.mat);
}

/** An ink check mark (✓ isn't in the bundled fonts). Lies in the XY plane, `h` tall, left edge at x = 0. */
export function inkCheck(h: number, color: string = PALETTE.ink) {
  const g = new THREE.Group();
  const w = h * 0.16;
  const short = new THREE.Mesh(new THREE.PlaneGeometry(h * 0.5, w), bandInk(color));
  short.rotation.z = -Math.PI / 4;
  short.position.set(h * 0.18, h * 0.3, 0);
  const long = new THREE.Mesh(new THREE.PlaneGeometry(h * 1.05, w), bandInk(color));
  long.rotation.z = Math.PI / 3.2;
  long.position.set(h * 0.6, h * 0.5, 0);
  g.add(short, long);
  return g;
}

/** Free GPU memory for a subtree that's going away (troika text, own geometries/materials/canvas
 *  textures). Shared materials from `M`/band/card caches and the shared textures are kept. */
export function disposeObject(root: THREE.Object3D) {
  const keepMat = new Set<THREE.Material>([...cache.values(), ...bandCache.values()]);
  const keepTex = sharedTex;
  root.traverse((o) => {
    const t = o as unknown as { sync?: unknown; dispose?: () => void; _members?: Map<{ dispose(): void }, unknown> };
    if (typeof t.sync === "function" && typeof t.dispose === "function") {
      // troika Text; a BatchedText's members aren't scene children, so free them here
      if (t._members) for (const m of t._members.keys()) m.dispose();
      t.dispose();
      return;
    }
    const m = o as THREE.Mesh;
    if (!m.geometry) return;
    if (!sharedGeo.has(m.geometry)) m.geometry.dispose();
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      if (keepMat.has(mat)) continue;
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture && !keepTex.has(v)) v.dispose();
      mat.dispose();
    }
  });
}

/** Stage teardown: free the GPU copies of every shared texture. The textures (and their painted canvases)
 *  stay valid, so a new renderer (StrictMode remount, reopening the room) re-uploads without repainting. */
export function releaseSharedTextures() {
  for (const t of sharedTex) t.dispose();
}
