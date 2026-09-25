// Optional Google Photorealistic 3D Tiles inside a cloche (doc 04 §9.2). Loads with VITE_GOOGLE_MAP_TILES_KEY (direct,
// needs a Google Cloud billing account) or else VITE_CESIUM_ION_TOKEN (the same Google tiles through Cesium ion's
// asset 2275207; a free ion account, no card). If no tile arrives within 4 s of rendering we keep the paper city.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import { CITY_R, type DryRunCloche } from "./DryRun";
import { makeText } from "./text";

const KEY = (import.meta.env.VITE_GOOGLE_MAP_TILES_KEY as string | undefined) ?? "";
const ION_TOKEN = (import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined) ?? "";
/** Cesium ion's copy of Google Photorealistic 3D Tiles. */
const ION_GOOGLE_3D_TILES = "2275207";
const CLIP_SIDES = 12;
/** Tiles are clipped just inside the paper city's plate. */
const CLIP_R = CITY_R - 0.002;
/** How long streaming may take to put real ground under the plate, counted from the first rendered frame. */
const FIRST_TILE_MS = 4000;
/** A longer gap between two frames is a pause (hidden tab), not time spent waiting on the network. */
const FRAME_GAP_MS = 250;

type Tiles = import("3d-tiles-renderer").TilesRenderer;

export function tilesAvailable() { return KEY.length > 0 || ION_TOKEN.length > 0; }

export class CityTiles {
  private tiles: Tiles | null = null;
  /** ReorientationPlugin owns tiles.group's transform (it resets the scale), so scale and lift live on this parent. */
  private holder = new THREE.Group();
  private grounded = 0;
  /** A tile arrived since the last frame: re-fit the ground once, in the next update (O2-057). */
  private groundPending = false;
  private ray = new THREE.Raycaster();
  private hits: THREE.Intersection[] = [];
  private from = new THREE.Vector3();
  private down = new THREE.Vector3();
  private planes: THREE.Plane[] = Array.from({ length: CLIP_SIDES }, () => new THREE.Plane());
  private loaded = false;
  private dead = false;
  /** When, in rendered time, we stop waiting for a first tile and keep the paper city. */
  private giveUpAt: number | null = null;
  private lastFrame = 0;
  private attribution: THREE.Object3D | null = null;
  private center = new THREE.Vector3();
  private scaleV = new THREE.Vector3();
  private n = new THREE.Vector3();
  private p = new THREE.Vector3();

  constructor(private cloche: DryRunCloche, renderer: THREE.WebGLRenderer) {
    renderer.localClippingEnabled = true;
    void this.start();
  }

  private async start() {
    try {
      // OPT-055: only the two plugins we use, by path (the plugins barrel drags in pmtiles, fflate, pbf, vector-tile)
      const [{ TilesRenderer }, auth, { ReorientationPlugin }] = await Promise.all([
        import("3d-tiles-renderer"),
        KEY
          ? import("3d-tiles-renderer/src/three/plugins/GoogleCloudAuthPlugin.js").then((m) => new m.GoogleCloudAuthPlugin({ apiToken: KEY, autoRefreshToken: true }))
          : import("3d-tiles-renderer/src/three/plugins/CesiumIonAuthPlugin.js").then((m) => new m.CesiumIonAuthPlugin({ apiToken: ION_TOKEN, assetId: ION_GOOGLE_3D_TILES, autoRefreshToken: true })),
        import("3d-tiles-renderer/src/three/plugins/ReorientationPlugin.js"),
      ]);
      if (this.dead) return;
      const tiles = new TilesRenderer();
      tiles.registerPlugin(auth);
      tiles.registerPlugin(new ReorientationPlugin({ lat: this.cloche.plan.cityCenter.lat * THREE.MathUtils.DEG2RAD, lon: this.cloche.plan.cityCenter.lng * THREE.MathUtils.DEG2RAD, recenter: true }));
      tiles.errorTarget = 30;
      tiles.lruCache.minSize = 60;
      tiles.lruCache.maxSize = 260;
      tiles.addEventListener("load-model", ({ scene }: { scene: THREE.Object3D }) => {
        scene.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m) { m.clippingPlanes = this.planes; m.needsUpdate = true; }
        });
        // Ground height differs per city (sea level vs Mexico City's 2.2 km, above the ellipsoid): re-fit as finer
        // tiles arrive. O2-057: a burst of tiles in one frame used to cast one ray each against the whole tileset;
        // now the next frame casts once.
        if (this.grounded < 60) this.groundPending = true;
      });
      tiles.addEventListener("load-error", () => undefined);
      // meters → scene: same scale as the paper city (on the holder; see above); ground() lifts it onto the plate
      this.holder.scale.setScalar(this.cloche.cityScale);
      this.holder.add(tiles.group);
      this.cloche.city.add(this.holder);
      this.tiles = tiles;
      // the 4 s wait for a first tile starts with the first rendered frame (update), not here: a hidden tab or a
      // Gallery still behind its "Take a seat" card renders nothing, so a wall-clock timer gave up before any request
    } catch {
      this.dispose();
    }
  }

  /** Casts straight down through the city centre and lifts the tiles so the ground there sits on the plate. */
  private ground(): boolean {
    if (!this.tiles) return false;
    const g = this.tiles.group;
    this.holder.updateMatrixWorld(true);
    // in holder space (metres): from 9 km up, straight down the local +Y axis the plugin aligned to the city's "up"
    const origin = this.from.set(0, 9000, 0).applyMatrix4(this.holder.matrixWorld);
    const dir = this.down.set(0, -9000, 0).applyMatrix4(this.holder.matrixWorld).sub(origin);
    this.ray.far = dir.length();
    this.ray.set(origin, dir.normalize());
    // three.js also hits hidden meshes: skip the coarse parent tiles the renderer has already swapped out
    const shown = (o: THREE.Object3D | null): boolean => { for (let x = o; x && x !== g; x = x.parent) if (!x.visible) return false; return true; };
    this.hits.length = 0;
    const hit = this.ray.intersectObject(g, true, this.hits).find((h) => shown(h.object));
    this.hits.length = 0;
    if (!hit) return false;
    const local = this.holder.worldToLocal(this.from.copy(hit.point)); // metres, relative to the ellipsoid surface point
    this.holder.position.y = 0.0005 - local.y * this.cloche.cityScale;
    return true;
  }

  private addAttribution() {
    const t = makeText({ text: KEY ? "Map data ©Google" : "Map data ©Google · Cesium ion", font: "body", size: 0.004, color: PALETTE.inkSoft });
    t.position.set(0, 0.002, 0.118);
    t.rotation.x = -Math.PI / 2;
    this.cloche.city.add(t);
    this.attribution = t;
  }

  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer) {
    if (!this.tiles || this.dead) return;
    if (this.groundPending) {
      this.groundPending = false;
      // only swap out the paper city once real ground is under the plate
      if (this.ground()) {
        this.grounded++;
        if (!this.loaded) {
          this.loaded = true;
          this.cloche.showLowPoly(false);
          this.addAttribution();
        }
      }
    }
    if (!this.loaded) {
      // count rendered time only: a pause in frames (hidden tab, a stall) moves the deadline out by the same amount
      const now = performance.now();
      if (this.giveUpAt === null) this.giveUpAt = now + FIRST_TILE_MS;
      else if (now - this.lastFrame > FRAME_GAP_MS) this.giveUpAt += now - this.lastFrame;
      this.lastFrame = now;
      if (now > this.giveUpAt) { this.dispose(); return; }
    }
    // clip to a 12-sided prism around the plate, in world space
    const m = this.cloche.city.matrixWorld;
    const center = this.center.setFromMatrixPosition(m);
    const s = this.scaleV.setFromMatrixScale(m).x;
    for (let i = 0; i < CLIP_SIDES; i++) {
      const a = (i / CLIP_SIDES) * Math.PI * 2;
      this.n.set(-Math.cos(a), 0, -Math.sin(a));
      this.p.copy(center).addScaledVector(this.n, -CLIP_R * s);
      this.planes[i].setFromNormalAndCoplanarPoint(this.n, this.p);
    }
    const cam = (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera) as THREE.PerspectiveCamera;
    this.tiles.setCamera(cam);
    this.tiles.setResolutionFromRenderer(cam, renderer);
    this.tiles.update();
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    this.holder.removeFromParent();
    if (this.tiles) this.tiles.dispose();
    this.attribution?.removeFromParent();
    (this.attribution as unknown as { dispose?: () => void } | null)?.dispose?.();
    this.cloche.showLowPoly(true);
  }
}
