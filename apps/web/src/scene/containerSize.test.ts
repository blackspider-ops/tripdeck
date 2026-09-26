// @vitest-environment happy-dom
// The Gallery canvas follows its container, not the window: a tab loaded in the background (no ResizeObserver
// callbacks, a stale size) catches up on visibilitychange / focus / resize or on the next frame's check.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContainerSize } from "./containerSize";

function box(w: number, h: number) {
  const el = document.createElement("div");
  let size = { w, h };
  Object.defineProperty(el, "clientWidth", { get: () => size.w });
  Object.defineProperty(el, "clientHeight", { get: () => size.h });
  return { el, set: (nw: number, nh: number) => { size = { w: nw, h: nh }; } };
}

const made: ContainerSize[] = [];
afterEach(() => { for (const s of made.splice(0)) s.dispose(); vi.unstubAllGlobals(); });

describe("ContainerSize", () => {
  it("sizes from the container at construction, not from the window", () => {
    const { el } = box(1280, 720);
    const apply = vi.fn();
    made.push(new ContainerSize(el, apply));
    expect(apply).toHaveBeenCalledWith(1280, 720);
    expect(apply).not.toHaveBeenCalledWith(window.innerWidth, window.innerHeight);
  });

  it("a container not laid out yet (0 × 0) is skipped, then applied once it has a size", () => {
    const b = box(0, 0);
    const apply = vi.fn();
    const s = new ContainerSize(b.el, apply);
    made.push(s);
    expect(apply).not.toHaveBeenCalled();
    b.set(1440, 900);
    s.check();
    expect(apply).toHaveBeenCalledWith(1440, 900);
  });

  it("a background tab's stale size catches up on visibilitychange, focus and resize (no observer callback)", () => {
    const b = box(860, 600); // what the hidden tab measured
    const apply = vi.fn();
    made.push(new ContainerSize(b.el, apply));
    b.set(1440, 900); // shown: the page is really this big
    document.dispatchEvent(new Event("visibilitychange"));
    expect(apply).toHaveBeenLastCalledWith(1440, 900);
    b.set(1500, 900);
    window.dispatchEvent(new Event("focus"));
    expect(apply).toHaveBeenLastCalledWith(1500, 900);
    b.set(1600, 1000);
    window.dispatchEvent(new Event("resize"));
    expect(apply).toHaveBeenLastCalledWith(1600, 1000);
  });

  it("the per-frame check is a no-op while nothing changes; a refused apply (XR presenting) is retried", () => {
    const b = box(800, 600);
    let presenting = false;
    const apply = vi.fn(() => !presenting);
    const s = new ContainerSize(b.el, apply);
    made.push(s);
    expect(s.check()).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    presenting = true;
    b.set(1024, 768);
    expect(s.check()).toBe(false);
    expect(s.size).toEqual({ w: 800, h: 600 });
    presenting = false;
    expect(s.check()).toBe(true);
    expect(s.size).toEqual({ w: 1024, h: 768 });
  });

  it("dispose stops listening", () => {
    const b = box(800, 600);
    const apply = vi.fn();
    const s = new ContainerSize(b.el, apply);
    s.dispose();
    b.set(1200, 800);
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
