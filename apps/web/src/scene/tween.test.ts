// R2-WP-15 / O2-051, O2-058: per-Stage tweens that let go of everything on teardown.
import { describe, expect, it, vi } from "vitest";
import { Tweens, ease } from "./tween";

describe("Tweens", () => {
  it("runs a tween to completion and resolves it", async () => {
    const tw = new Tweens();
    const seen: number[] = [];
    const done = vi.fn();
    void tw.to(100, (t) => seen.push(t), ease.linear).then(done);
    tw.update(0.05);
    tw.update(0.05);
    await Promise.resolve();
    expect(seen).toEqual([0, 0.5, 1]);
    expect(done).toHaveBeenCalledOnce();
    expect(tw.size).toBe(0);
  });

  it("removes finished tweens in place and keeps the running ones in order", () => {
    const tw = new Tweens();
    const order: string[] = [];
    void tw.to(10, () => order.push("a"), ease.linear);
    void tw.to(1000, () => order.push("b"), ease.linear);
    void tw.to(10, () => order.push("c"), ease.linear);
    void tw.to(1000, () => order.push("d"), ease.linear);
    order.length = 0;
    tw.update(0.02);
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(tw.size).toBe(2);
    order.length = 0;
    tw.update(0.02);
    expect(order).toEqual(["b", "d"]);
  });

  it("a key completes the tween it replaces", async () => {
    const tw = new Tweens();
    const first = vi.fn();
    const firstDone = vi.fn();
    void tw.to(1000, first, ease.linear, "k").then(firstDone);
    void tw.to(1000, () => undefined, ease.linear, "k");
    await Promise.resolve();
    expect(first).toHaveBeenLastCalledWith(1);
    expect(firstDone).toHaveBeenCalledOnce();
    expect(tw.size).toBe(1);
  });

  it("prop tweens a number from its current value", () => {
    const tw = new Tweens();
    const o = { y: 2 };
    void tw.prop(o, "y", 4, 100, ease.linear);
    tw.update(0.05);
    expect(o.y).toBe(3);
    tw.update(0.05);
    expect(o.y).toBe(4);
  });

  it("clear() resolves pending waits without running them, resets speed and refuses new tweens (O2-051)", async () => {
    const tw = new Tweens();
    tw.speed = 2; // reduce motion, set in XR
    const frames = vi.fn();
    const waited = vi.fn();
    const tweened = vi.fn();
    void tw.wait(60_000).then(waited);
    void tw.to(60_000, frames, ease.linear).then(tweened);
    frames.mockClear();
    tw.clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(waited).toHaveBeenCalledOnce();
    expect(tweened).toHaveBeenCalledOnce();
    expect(frames).not.toHaveBeenCalled(); // no frame against a disposed object
    expect(tw.size).toBe(0);
    expect(tw.speed).toBe(1);
    // a late continuation of the old director: resolves at once, holds nothing
    const late = vi.fn();
    await tw.to(500, late, ease.linear, "x");
    expect(late).not.toHaveBeenCalled();
    expect(tw.size).toBe(0);
  });

  it("each Stage's tweens are independent", () => {
    const a = new Tweens(), b = new Tweens();
    a.speed = 2;
    const o = { v: 0 };
    void b.prop(o, "v", 1, 100, ease.linear);
    a.update(1);
    expect(o.v).toBe(0);
    a.clear();
    b.update(0.1);
    expect(o.v).toBe(1);
    expect(b.speed).toBe(1);
  });
});

describe("Tweens: speed, wait, keys and eases (O2-068)", () => {
  it("speed scales elapsed time (reduce motion runs at 2×)", () => {
    const tw = new Tweens();
    tw.speed = 2;
    const seen: number[] = [];
    void tw.to(100, (t) => seen.push(t), ease.linear);
    tw.update(0.025);
    expect(seen.at(-1)).toBeCloseTo(0.5);
    tw.update(0.025);
    expect(seen.at(-1)).toBe(1);
    expect(tw.size).toBe(0);
  });

  it("wait resolves only once its time has passed", async () => {
    const tw = new Tweens();
    const done = vi.fn();
    void tw.wait(200).then(done);
    tw.update(0.1);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    tw.update(0.1);
    await Promise.resolve();
    expect(done).toHaveBeenCalledOnce();
  });

  it("a zero-length tween finishes on the next frame at t=1", () => {
    const tw = new Tweens();
    const fn = vi.fn();
    void tw.to(0, fn, ease.linear);
    expect(fn).toHaveBeenLastCalledWith(0);
    tw.update(0);
    expect(fn).toHaveBeenLastCalledWith(1);
    expect(tw.size).toBe(0);
  });

  it("a key only cancels tweens with the same key; different keys run side by side", () => {
    const tw = new Tweens();
    const a = vi.fn(), b = vi.fn(), c = vi.fn();
    void tw.to(1000, a, ease.linear, "needle-0");
    void tw.to(1000, b, ease.linear, "needle-1");
    void tw.to(1000, c, ease.linear); // unkeyed
    void tw.to(1000, () => undefined, ease.linear, "needle-0");
    expect(a).toHaveBeenLastCalledWith(1);
    expect(b).toHaveBeenLastCalledWith(0);
    expect(tw.size).toBe(3);
  });

  it("every ease starts at 0 and ends at 1", () => {
    for (const [name, e] of Object.entries(ease)) {
      expect(e(0), name).toBeCloseTo(0);
      expect(e(1), name).toBeCloseTo(1);
    }
    expect(ease.step(0.99)).toBe(0);
    expect(ease.inOut(0.5)).toBeCloseTo(0.5);
  });
});
