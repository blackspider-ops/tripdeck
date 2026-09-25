// What the SceneDirector's parts share: the store, the fixed pieces on the table, the Stage's tweens, and the
// director's animation queue and caption card. Each part (crew seating, turn playback, phases, seals) gets this.
import type * as THREE from "three";
import type { Turn } from "@all-ayes/shared";
import type { TripStore } from "../../net/tripStore";
import type { Tweens } from "../tween";
import type { Globe } from "../Globe";
import type { CaptainPiece } from "../CrewPiece";
import type { CompassTimer, CarriageClock } from "../Instruments";

export interface DirectorOptions {
  /** The headset may start the meeting, pick a chart, pause the clock, go back after a void. */
  controls: boolean;
  voices: boolean;
  speechFallback: boolean;
}

export interface DirectorContext {
  readonly store: TripStore;
  readonly opts: DirectorOptions;
  readonly renderer: THREE.WebGLRenderer;
  readonly root: THREE.Group;
  /** The owning Stage's tweens (O2-051): everything built here animates through them. */
  readonly tweens: Tweens;
  readonly globe: Globe;
  readonly compass: CompassTimer;
  readonly captain: CaptainPiece;
  readonly clock: CarriageClock;
  /** Within 1.5 s of the first snapshot: history is applied silently, not animated. */
  isResume(): boolean;
  /** Run after everything already queued (lines being spoken, phase choreography). */
  enqueue(fn: () => Promise<void> | void): void;
  /** Put a line on the caption card (and the Gallery's subtitle strip). */
  caption(speaker: string, text: string, color: string): void;
  /** A turn's line starts playing now (animated), or is the latest line applied on resume (L2-008). */
  speaking(t: Turn): void;
  /** The set of pickable things changed (cloches built or cleared). */
  targetsChanged(): void;
}
