// Paper globe on a brass meridian ring (doc 02 §7.2). Never spins on its own — it only turns
// to face the city under discussion (not while a hand is on it), and a hand only turns it (globeSpin.ts).
import * as THREE from "three";
import { ORIGIN_COORDS, PALETTE } from "@all-ayes/shared";
import { LAND } from "./land";
import { M, disposeObject, inkA, mergedGeometry, paintPaper, shadowDecal, rng, sharedGeometry, sharedSheet, sheetTexture } from "./materials";
import { arcPoints, latLngToSphere, sphereToLatLng, spinFor } from "./geo";
import { GlobeSpin, clampPitch } from "./globeSpin";
import { paperFlag, pinInstances } from "./props";
import { ease, type Tweens } from "./tween";
import { billboard } from "./billboard";

/**
 * S2-002: the crew's one home port on the globe. Nobody's own airport is public (it fixes their flight price), so
 * every arc starts from the same rivet: the middle of the airports the crew can fly from.
 */
const HOME_AIRPORTS = Object.values(ORIGIN_COORDS);
export const HOME_PORT = {
  id: "home",
  lat: HOME_AIRPORTS.reduce((s, o) => s + o.lat, 0) / HOME_AIRPORTS.length,
  lng: HOME_AIRPORTS.reduce((s, o) => s + o.lng, 0) / HOME_AIRPORTS.length,
};

const GLOBE_R = 0.16;
/** Flag height above a pin, the extra step per nearby earlier pin, and what "nearby" means (degrees of arc). */
const FLAG_Y = 0.017;
const FLAG_STEP = 0.013;
const FLAG_NEAR_DEG = 18;
/** Great-circle angle between two points, in degrees. */
function angleDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const c = Math.sin(a.lat * r) * Math.sin(b.lat * r) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.cos((a.lng - b.lng) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) / r;
}
const GLOBE_CENTER_Y = 0.052 + GLOBE_R;
/** After a hand turns the globe, the auto-turn to the city under discussion waits this long (ms). */
const HAND_QUIET_MS = 4000;

/** Designed at 2048×1024 (1024×512 on a headset, same drawing); painted once per page. */
function globeTexture() {
  return sharedSheet("globe", () => sheetTexture(2048, 1024, (g, W, H) => {
    // sea: watercolor wash
    g.fillStyle = PALETTE.seaWash;
    g.fillRect(0, 0, W, H);
    const r = rng(5);
    for (let i = 0; i < 900; i++) {
      const x = r() * W, y = r() * H, rad = 20 + r() * 90;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, r() < 0.5 ? "rgba(255,255,255,0.05)" : "rgba(40,70,70,0.05)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grd;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    const px = (lng: number) => ((lng + 180) / 360) * W;
    const py = (lat: number) => ((90 - lat) / 180) * H;
    // land as paper, clipped fill then an ink coastline
    const land = document.createElement("canvas");
    land.width = g.canvas.width; land.height = g.canvas.height;
    const lg = land.getContext("2d")!;
    lg.setTransform(g.getTransform()); // same logical space as the sheet
    paintPaper(lg, W, H, PALETTE.paper, 9);
    lg.globalCompositeOperation = "destination-in";
    lg.beginPath();
    for (const ring of LAND) ring.forEach(([lng, lat], i) => (i ? lg.lineTo(px(lng), py(lat)) : lg.moveTo(px(lng), py(lat))));
    lg.fill();
    g.drawImage(land, 0, 0, W, H);
    g.strokeStyle = PALETTE.ink;
    g.lineWidth = 2.2;
    g.lineJoin = "round";
    for (const ring of LAND) {
      g.beginPath();
      ring.forEach(([lng, lat], i) => (i ? g.lineTo(px(lng), py(lat)) : g.moveTo(px(lng), py(lat))));
      g.closePath();
      g.stroke();
    }
    // hatching along coasts (engraver's shading, very light)
    g.strokeStyle = inkA(0.12);
    g.lineWidth = 1;
    for (const ring of LAND) for (const [lng, lat] of ring) {
      g.beginPath(); g.arc(px(lng), py(lat), 7, 0, Math.PI * 2); g.stroke();
    }
    // graticules every 15°, stronger every 30°, equator + tropics
    for (let lng = -180; lng <= 180; lng += 15) {
      g.strokeStyle = lng % 30 === 0 ? inkA(0.45) : inkA(0.2);
      g.lineWidth = lng % 30 === 0 ? 1.6 : 1;
      g.beginPath(); g.moveTo(px(lng), 0); g.lineTo(px(lng), H); g.stroke();
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      g.strokeStyle = lat === 0 ? "rgba(178,58,46,0.6)" : lat % 30 === 0 ? inkA(0.45) : inkA(0.2);
      g.lineWidth = lat === 0 ? 2.2 : lat % 30 === 0 ? 1.6 : 1;
      g.beginPath(); g.moveTo(0, py(lat)); g.lineTo(W, py(lat)); g.stroke();
    }
    g.setLineDash([10, 8]);
    g.strokeStyle = inkA(0.35);
    for (const lat of [23.44, -23.44]) { g.beginPath(); g.moveTo(0, py(lat)); g.lineTo(W, py(lat)); g.stroke(); }
    g.setLineDash([]);
  }));
}

// pin needles and wax heads are drawn as two instanced meshes for all pins (OPT-050)
const NEEDLE_GEO = sharedGeometry(new THREE.CylinderGeometry(0.0007, 0.0007, 0.022, 6));
const HEAD_GEO = sharedGeometry(new THREE.SphereGeometry(0.0028, 10, 8));
// shared by every pin (O2-056): the ink ring, a unit flag card scaled to the name, the home-port rivet
const RING_GEO = sharedGeometry(new THREE.TorusGeometry(0.009, 0.0009, 6, 32));
const RIVET_GEO = sharedGeometry(new THREE.SphereGeometry(0.0035, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2));

interface PinSpec { id: string; name: string; lat: number; lng: number }

interface Arc { mesh: THREE.Mesh; key: string }

export class Globe {
  group = new THREE.Group();       // sits on the chart
  private tilt = new THREE.Group(); // x-tilt toward the viewer
  private spin = new THREE.Group(); // y-spin; pins & arcs live here
  private pins = new Map<string, { group: THREE.Group; ring: THREE.Mesh; flag: THREE.Group; lat: number; lng: number }>();
  private rivets = new Map<string, THREE.Mesh>();
  private arcs: Arc[] = [];
  private needles: THREE.InstancedMesh | null = null;
  private heads: THREE.InstancedMesh | null = null;
  /** The paper sphere (the chart room's spin and pin target). */
  readonly sphere: THREE.Mesh;
  /** Hand spin (the chart room, docs/03 §4): rotation only — yaw and a clamped pitch, bounded inertia. */
  private hand: GlobeSpin;
  private tmpV = new THREE.Vector3();

  constructor(private tw: Tweens) {
    // stand: walnut foot, brass column + meridian ring (one mesh, O2-056)
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.068, 0.016, 28), M.wood());
    foot.position.y = 0.008;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.009, 0.04, 12));
    column.position.y = 0.036;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(GLOBE_R + 0.008, 0.0028, 8, 96));
    ring.position.y = GLOBE_CENTER_Y;
    ring.rotation.y = Math.PI / 2;
    this.group.add(shadowDecal(0.09), foot, new THREE.Mesh(mergedGeometry([column, ring]), M.brass()));

    const sphere = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R, 64, 40), new THREE.MeshStandardMaterial({ map: globeTexture(), roughness: 0.9 }));
    this.sphere = sphere;
    this.spin.add(sphere);
    this.tilt.add(this.spin);
    this.tilt.position.y = GLOBE_CENTER_Y;
    this.group.add(this.tilt);
    this.hand = new GlobeSpin(this.group, this.tilt, this.spin, GLOBE_R);
  }

  /** Show exactly these pins: new ones are added, ones no longer listed are removed and freed (O2-053). */
  setPins(pins: PinSpec[]) {
    let changed = false;
    const want = new Set(pins.map((p) => p.id));
    for (const [id, p] of this.pins) {
      if (want.has(id)) continue;
      changed = true;
      p.group.removeFromParent();
      disposeObject(p.group);
      this.pins.delete(id);
    }
    for (const p of pins) {
      if (this.pins.has(p.id)) continue;
      changed = true;
      const g = new THREE.Group();
      const dir = latLngToSphere(p.lat, p.lng, 1);
      g.position.copy(dir.clone().multiplyScalar(GLOBE_R));
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      // paper flag with the city name (Caslon)
      const { group: flag } = paperFlag({ text: p.name, font: "heading", size: 0.0095 }, 0.014, { pad: 0.004, guessPerChar: 0.0056 });
      flag.position.set(0.001, FLAG_Y, 0);
      const ring = new THREE.Mesh(RING_GEO, M.ink());
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.0006;
      ring.visible = false;
      g.add(flag, ring);
      this.spin.add(g);
      this.pins.set(p.id, { group: g, ring, flag, lat: p.lat, lng: p.lng });
    }
    if (changed) { this.staggerFlags(); this.buildPinHeads(); }
  }

  /**
   * Neighbouring ports (Lisbon, Madrid, Barcelona…) would print their flags on top of each other: a pin within
   * FLAG_NEAR_DEG of an earlier one raises its flag one step per such neighbour, so 3–4 names stay readable.
   */
  private staggerFlags() {
    const placed: { lat: number; lng: number }[] = [];
    for (const p of this.pins.values()) {
      const k = placed.filter((q) => angleDeg(p, q) < FLAG_NEAR_DEG).length;
      p.flag.position.y = FLAG_Y + k * FLAG_STEP;
      placed.push(p);
    }
  }

  /** One instanced needle + one instanced head mesh for every pin (was two meshes per pin). */
  private buildPinHeads() {
    for (const m of [this.needles, this.heads]) { m?.removeFromParent(); m?.dispose(); }
    this.needles = this.heads = null;
    if (!this.pins.size) return;
    const at = [...this.pins.values()].map((p) => { p.group.updateMatrix(); return p.group.matrix; });
    ({ needles: this.needles, heads: this.heads } = pinInstances(NEEDLE_GEO, HEAD_GEO, at, 0.011, 0.022));
    this.spin.add(this.needles, this.heads);
  }

  /** Paper flags always face the viewer (text is never read backwards). `camPos`: the camera, world space. */
  update(camPos: THREE.Vector3) {
    for (const p of this.pins.values()) billboard(p.flag, camPos);
  }

  /** Brass rivets where the crew flies from (one: the home port, S2-002). */
  setOrigins(origins: { id: string; lat: number; lng: number }[]) {
    for (const o of origins) {
      if (this.rivets.has(o.id)) continue;
      const m = new THREE.Mesh(RIVET_GEO, M.brass());
      const dir = latLngToSphere(o.lat, o.lng, 1);
      m.position.copy(dir.clone().multiplyScalar(GLOBE_R));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this.spin.add(m);
      this.rivets.set(o.id, m);
    }
  }

  // ---------- hand spin & pins (the chart room) ----------
  /** The lat/lng under a world-space point on the globe. */
  latLngAt(world: THREE.Vector3): { lat: number; lng: number } {
    return sphereToLatLng(this.spin.worldToLocal(this.tmpV.copy(world)));
  }
  /** Where a ray meets the globe (world), or — for a drag that slid off it — the globe's surface point nearest the
   *  ray (never a point far inside or outside, which would swing the turn). */
  rayPoint(ray: THREE.Ray, out = new THREE.Vector3()): THREE.Vector3 {
    const c = this.sphere.getWorldPosition(new THREE.Vector3());
    const r = GLOBE_R * this.sphere.getWorldScale(new THREE.Vector3()).x;
    if (ray.intersectSphere(new THREE.Sphere(c, r), out)) return out;
    ray.closestPointToPoint(c, out).sub(c);
    if (out.lengthSq() < 1e-12) out.set(0, 0, r); else out.setLength(r);
    return out.add(c);
  }
  /** Start a hand spin at this point (stops any inertia and any auto-turn). */
  grabSpin(world: THREE.Vector3, now = performance.now()) {
    void this.tw.to(0, () => undefined, ease.linear, "globe-turn"); // a running auto-turn stops here
    this.hand.grabAt(world, now);
  }
  /** Follow the hand: the globe turns (yaw, clamped pitch) so the point under it stays under it. Never moves. */
  dragSpin(world: THREE.Vector3, now = performance.now()) { this.hand.dragTo(world, now); }
  /** Let go: it keeps turning and slows (a flick spins it, a still hand leaves it where it is). */
  releaseSpin(now = performance.now()) { this.hand.release(now); }
  /** Per frame (s): the inertia after a flick. */
  tickSpin(dt: number) { this.hand.tick(dt); }
  get spinning() { return this.hand.spinning; }
  get spinY() { return this.spin.rotation.y; }
  get tiltX() { return this.tilt.rotation.x; }

  /** Turn to face a place (600 ms ease), tilting partway so its latitude faces the Organizer. */
  private turnTo(lat: number, lng: number, instant = false) {
    // a hand is on the globe (or just let go): the auto-turn would yank it back and forth under the hand
    if (this.hand.held || (!instant && performance.now() - this.hand.touchedAt < HAND_QUIET_MS)) return Promise.resolve();
    const fromY = this.spin.rotation.y, fromX = this.tilt.rotation.x;
    let toY = spinFor(lng);
    // shortest way round
    while (toY - fromY > Math.PI) toY -= Math.PI * 2;
    while (toY - fromY < -Math.PI) toY += Math.PI * 2;
    const toX = clampPitch(((lat * Math.PI) / 180) * 0.65);
    if (instant) { this.spin.rotation.y = toY; this.tilt.rotation.x = toX; return Promise.resolve(); }
    return this.tw.to(600, (t) => {
      this.spin.rotation.y = fromY + (toY - fromY) * t;
      this.tilt.rotation.x = fromX + (toX - fromX) * t;
    }, ease.inOut, "globe-turn");
  }

  turnToPin(id: string, instant = false) {
    const p = this.pins.get(id);
    if (p) return this.turnTo(p.lat, p.lng, instant);
    return Promise.resolve();
  }

  /** Pencil (tentative) or ink (agreed) arc from an origin to a city; draws on over 500 ms. */
  drawArc(originId: string, cityId: string, style: "pencil" | "ink", instant = false) {
    const key = `${originId}>${cityId}`;
    const existing = this.arcs.find((a) => a.key === key);
    if (existing) {
      existing.mesh.material = style === "ink" ? M.ink() : M.graphite();
      return;
    }
    const o = this.rivets.get(originId), c = this.pins.get(cityId);
    if (!o || !c) return;
    const pts = arcPoints(o.position, c.group.position, GLOBE_R, 0.2);
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, 64, style === "ink" ? 0.0009 : 0.0007, 5, false);
    const mesh = new THREE.Mesh(geo, style === "ink" ? M.ink() : M.graphite());
    const total = geo.index!.count;
    this.spin.add(mesh);
    this.arcs.push({ mesh, key });
    if (instant) return;
    geo.setDrawRange(0, 0);
    // tube indices run along the path, so a growing draw range "draws" the line on
    void this.tw.to(500, (t) => geo.setDrawRange(0, Math.floor((total * t) / 6) * 6), ease.linear);
  }

  inkAllArcs() { for (const a of this.arcs) a.mesh.material = M.ink(); }

  eraseArcs(filter?: (key: string) => boolean) {
    this.arcs = this.arcs.filter((a) => {
      if (filter && !filter(a.key)) return true;
      this.spin.remove(a.mesh);
      a.mesh.geometry.dispose();
      return false;
    });
  }

  /** Ink circles around the Two Charts' cities. */
  circle(cityIds: string[]) {
    for (const [id, p] of this.pins) p.ring.visible = cityIds.includes(id);
  }

  /** Slide down and back to make room for the Seal ceremony. */
  stow(stowed: boolean, instant = false) {
    const from = { y: this.group.position.y, z: this.group.position.z, s: this.group.scale.x };
    const to = stowed ? { y: 0, z: -0.12, s: 0.62 } : { y: 0, z: 0, s: 1 };
    if (instant) { this.group.position.set(0, to.y, to.z); this.group.scale.setScalar(to.s); return Promise.resolve(); }
    return this.tw.to(700, (t) => {
      this.group.position.z = from.z + (to.z - from.z) * t;
      this.group.scale.setScalar(from.s + (to.s - from.s) * t);
    }, ease.inOut, "globe-stow");
  }
}
