// A tiny tween system. Everything that moves in the chart room moves through here,
// so "reduce motion" and frame timing are handled in one place.
//
// O2-051: each Stage owns its own `Tweens` (passed to every piece it builds), and `clear()` on teardown resolves
// every pending tween/wait and refuses new ones. A module-global queue outlived its Stage: waits never resolved
// once nothing ticked it, so the old director's chain (and its whole scene graph) stayed reachable, and callbacks
// later ran against disposed objects on the next Stage. Reduce-motion speed now dies with its Stage too.

export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  out: (t: number) => 1 - (1 - t) ** 3,
  in: (t: number) => t * t * t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  /** doc 02 §9: cubic-bezier(.3,.7,.4,1) — a firm, physical tip */
  tip: (t: number) => 1 - (1 - t) ** 4,
  step: (t: number) => (t < 1 ? 0 : 1),
} satisfies Record<string, Ease>;

interface Running {
  start: number;
  duration: number;
  ease: Ease;
  fn: (t: number) => void;
  resolve: () => void;
  key?: string;
}

export class Tweens {
  private now = 0;
  private running: Running[] = [];
  private closed = false;
  /** doc 02 §9 reduced motion: halve distances/durations handled by callers; here we just speed up. */
  speed = 1;

  /** Advance every tween. Finished ones are removed in place (no per-frame arrays, O2-058). A tween's `fn` must
   *  not start another tween synchronously; promise continuations run later, as microtasks. */
  update(dtSeconds: number) {
    this.now += dtSeconds * 1000 * this.speed;
    const list = this.running;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const t = r.duration <= 0 ? 1 : Math.min(1, (this.now - r.start) / r.duration);
      r.fn(r.ease(t));
      if (t >= 1) r.resolve();
      else list[w++] = r;
    }
    list.length = w;
  }

  /** Animate t from 0→1. A `key` cancels (and completes) any running tween with the same key. */
  to(durationMs: number, fn: (t: number) => void, e: Ease = ease.out, key?: string): Promise<void> {
    if (this.closed) return Promise.resolve(); // the Stage is gone: nothing ticks, nothing may hold on
    if (key) {
      const prev = this.running.filter((r) => r.key === key);
      if (prev.length) {
        this.running = this.running.filter((r) => r.key !== key);
        for (const p of prev) { p.fn(1); p.resolve(); }
      }
    }
    return new Promise((resolve) => {
      this.running.push({ start: this.now, duration: durationMs, ease: e, fn, resolve, key });
      fn(0);
    });
  }

  /** Tween a numeric property from its current value to `to` (the "capture start, then lerp" pattern, O2-018). */
  prop<T extends object, K extends keyof T & string>(obj: T, prop: K, to: number, ms: number, e: Ease = ease.out, key?: string) {
    const from = obj[prop] as unknown as number;
    return this.to(ms, (t) => { (obj as Record<string, unknown>)[prop] = from + (to - from) * t; }, e, key);
  }

  wait(ms: number): Promise<void> {
    return this.to(ms, () => undefined, ease.linear);
  }

  /** How many tweens (and waits) are pending. */
  get size() { return this.running.length; }

  /** Stage teardown: resolve every pending tween and wait (without running their frames against disposed objects),
   *  drop them, reset reduce-motion, and turn every later `to()` into an already-resolved promise. */
  clear() {
    const pending = this.running;
    this.running = [];
    this.closed = true;
    this.speed = 1;
    for (const r of pending) r.resolve();
  }
}
