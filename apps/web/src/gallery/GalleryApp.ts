// The Gallery (doc 03 §5): the same chart room on a laptop/TV for judges, the audience and the
// Meta video. Read-only, slow orbit (30°/min), camera presets, voices after a click.
import * as THREE from "three";
import type { Turn } from "@all-ayes/shared";
import type { TripStore } from "../net/tripStore";
import { Stage } from "../scene/Stage";
import { ease } from "../scene/tween";
import { TABLE_TARGET } from "../scene/layout";

const ORBIT_RAD_PER_SEC = (30 * Math.PI) / 180 / 60;
/** "Follow the speaker": the camera sits this far out along the speaker's seat direction, and this much higher. */
const SPEAKER_OUT = 1.9;
const SPEAKER_UP = 0.2;

export type Preset = "overhead" | "organizer" | "speaker";

export class GalleryApp {
  readonly stage: Stage;
  orbiting = true;
  private angle = 0.35;
  private radius = 1.15;
  private height = 0.78;
  private preset: Preset | null = null;
  private focus = new THREE.Vector3().copy(TABLE_TARGET);
  private speakerPos: THREE.Vector3 | null = null;
  private want = new THREE.Vector3(); // per-frame scratch (O2-058)

  constructor(container: HTMLElement, readonly store: TripStore) {
    this.stage = new Stage(container, store, { controls: false, voices: true, speechFallback: true }, false);
    this.stage.addRoom();
    void this.stage.director.table.unroll();
    // the page shows its own subtitle strip; the in-scene caption card is for the headset
    this.stage.director.table.caption.group.visible = false;
    this.stage.onFrame((dt) => this.frame(dt));

    // follow the current speaker for the "speaker" preset — at the seat the director actually used (OPT-016), and
    // when their line starts playing, not when it arrives behind the one still being spoken (L2-008)
    this.stage.director.onSpeaker = (t: Turn) => {
      const pos = this.stage.director.crew.speakerPosition(t, this.speakerPos ?? undefined);
      if (pos) this.speakerPos = pos;
    };
  }

  private frame(dt: number) {
    const cam = this.stage.camera;
    if (this.preset === "speaker" && this.speakerPos) {
      const want = this.want.copy(this.speakerPos).multiplyScalar(SPEAKER_OUT);
      want.y += SPEAKER_UP;
      cam.position.lerp(want, Math.min(1, dt * 1.5));
      this.focus.lerp(this.speakerPos, Math.min(1, dt * 2));
      cam.lookAt(this.focus);
      return;
    }
    if (this.preset && this.preset !== "speaker") { cam.lookAt(this.focus); return; }
    if (this.orbiting) this.angle += ORBIT_RAD_PER_SEC * dt;
    cam.position.set(Math.sin(this.angle) * this.radius, this.height, Math.cos(this.angle) * this.radius);
    this.focus.lerp(TABLE_TARGET, Math.min(1, dt * 2));
    cam.lookAt(this.focus);
  }

  setPreset(p: Preset | null) {
    this.preset = p;
    const cam = this.stage.camera;
    const from = cam.position.clone();
    const to =
      p === "overhead" ? new THREE.Vector3(0, 1.05, 0.02)
      : p === "organizer" ? new THREE.Vector3(0, 0.45, 0.58)
      : null;
    if (to) {
      if (p === "overhead") this.focus.set(0, 0, 0);
      else this.focus.copy(TABLE_TARGET);
      void this.stage.tweens.to(900, (t) => cam.position.lerpVectors(from, to, t), ease.inOut, "gallery-cam");
    }
  }

  toggleOrbit() { this.orbiting = !this.orbiting; if (this.preset) this.setPreset(null); }

  dispose() { this.stage.dispose(); }
}
