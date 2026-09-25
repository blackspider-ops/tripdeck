// Renderer, lights and render loop shared by the headset (XR + laptop fallback) and the Gallery.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { PALETTE } from "@all-ayes/shared";
import type { TripStore } from "../net/tripStore";
import { SceneDirector } from "./SceneDirector";
import type { DirectorOptions } from "./director/context";
import { M, disposeObject, releaseSharedTextures, shadowDecal } from "./materials";
import { Tweens } from "./tween";
import { sound } from "./audio";
import { TABLE_TARGET } from "./layout";

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Everything that sits on the real table. Positioned by placement in XR. */
  readonly anchor = new THREE.Group();
  readonly director: SceneDirector;
  /** This Stage's animation queue (O2-051): ticked by its loop, cleared on dispose. */
  readonly tweens = new Tweens();
  private lastT = performance.now();
  private lastFrameT = performance.now();
  private bgTimer: number;
  private envMap: THREE.Texture;
  private hooks: ((dt: number, frame?: XRFrame) => void)[] = [];
  private resizeObs: ResizeObserver;
  private roomProps = new THREE.Group();
  fps = 0;
  private frames = 0;
  private fpsT = 0;

  constructor(readonly container: HTMLElement, readonly store: TripStore, opts: DirectorOptions, alpha: boolean) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    if (alpha) this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 30);
    this.camera.position.set(0, 0.62, 0.78);
    this.camera.lookAt(TABLE_TARGET);
    this.scene.add(this.camera);
    sound.attach(this.camera);

    // one warm key light like an oil lamp above-left, plus a soft fill; brass gets a dim room reflection
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envMap = pmrem.fromScene(room, 0.04).texture;
    room.dispose(); // its boxes and lights were only needed for the bake (O2-053)
    pmrem.dispose();
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.35;
    const hemi = new THREE.HemisphereLight(0xfff1dc, 0x3b3026, 1.25);
    const key = new THREE.DirectionalLight(0xffdcae, 1.7);
    key.position.set(-0.6, 1.4, 0.5);
    this.scene.add(hemi, key);

    this.director = new SceneDirector(store, opts, this.renderer, this.tweens);
    this.anchor.add(this.director.root);
    this.scene.add(this.anchor);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    // resizes are ignored while presenting; catch up once the headset session ends
    this.renderer.xr.addEventListener("sessionend", this.onSessionEnd);
    this.renderer.setAnimationLoop((_t, frame) => { this.lastFrameT = performance.now(); this.tick(frame); });
    // Hidden tabs (and a hidden/blurred XR session, headset off) get no animation frames. Keep time
    // and the animation queue moving anyway so the view is current the moment it's shown again —
    // but never render from here: outside a frame that's wasted GPU, and in XR it's invalid.
    this.bgTimer = window.setInterval(() => {
      if (performance.now() - this.lastFrameT > 400) this.tick(undefined, true);
    }, 100);
  }

  /** Laptop/Gallery only: a walnut tabletop and a dim room behind the chart. */
  addRoom() {
    if (this.roomProps.parent) return; // the laptop view can be reopened after Exit
    this.scene.background = new THREE.Color(PALETTE.room);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.04, 64), M.woodDark());
    top.position.y = -0.02;
    this.roomProps.add(top, shadowDecal(0.6));
    this.scene.add(this.roomProps);
  }

  onFrame(fn: (dt: number, frame?: XRFrame) => void) { this.hooks.push(fn); }

  private tick(frame?: XRFrame, background = false) {
    const now = performance.now();
    // background timers are throttled to ≥ 1 s in hidden tabs; don't let time run slow there
    const dt = Math.min(background ? 5 : 0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.tweens.update(dt);
    if (background) return;
    for (const h of this.hooks) h(dt, frame);
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    this.director.update(cam);
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 1) { this.fps = Math.round(this.frames / this.fpsT); this.frames = 0; this.fpsT = 0; }
  }

  private onSessionEnd = () => this.resize();

  private resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    if (this.renderer.xr.isPresenting) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    clearInterval(this.bgTimer);
    this.resizeObs.disconnect();
    this.renderer.xr.removeEventListener("sessionend", this.onSessionEnd);
    this.director.dispose();
    // O2-051: resolve every pending tween/wait now (nothing will tick them again) so the old director's chain and
    // scene graph can be collected, and refuse new ones from its late continuations
    this.tweens.clear();
    disposeObject(this.roomProps);
    this.scene.remove(this.roomProps);
    releaseSharedTextures(); // GPU copies only: the painted sheets are kept for the next Stage (no repaint)
    this.envMap.dispose();
    this.renderer.dispose();
    // free textures/buffers now rather than whenever the context is GC'd (Quest has little headroom,
    // and StrictMode / route changes create a new renderer)
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
