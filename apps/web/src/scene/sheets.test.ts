// O2-068 / OPT-049: shared sheets are memoised; beyond MAX_SHEETS the least recently used *street plate* goes
// (the chart and the globe never do). No canvas needed: `make` hands back a plain texture.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";

type Mod = typeof import("./materials");
let mod: Mod;
beforeEach(async () => {
  vi.resetModules(); // the sheet cache is module state
  mod = await import("./materials");
});

const tex = () => new THREE.CanvasTexture({} as HTMLCanvasElement);

describe("sharedSheet", () => {
  it("paints once per key and returns the same texture", () => {
    const make = vi.fn(tex);
    const a = mod.sharedSheet("chart", make);
    expect(mod.sharedSheet("chart", make)).toBe(a);
    expect(make).toHaveBeenCalledOnce();
  });

  it("evicts the least recently used street plate past 8, and disposes it", () => {
    const chart = mod.sharedSheet("chart", tex);
    const globe = mod.sharedSheet("globe", tex);
    const streets = Array.from({ length: 6 }, (_, i) => mod.sharedSheet(`street:${i}`, tex)); // 8 in the cache
    const spies = streets.map((s) => vi.spyOn(s, "dispose"));
    mod.sharedSheet("street:0", tex); // touch: 0 is now the most recent
    mod.sharedSheet("street:6", tex); // 9 → evict the oldest street, which is 1
    expect(spies.map((s) => s.mock.calls.length)).toEqual([0, 1, 0, 0, 0, 0]);
    // street:1 is gone (a new paint), street:0 and the chart/globe are still cached
    const make = vi.fn(tex);
    mod.sharedSheet("street:0", make);
    mod.sharedSheet("chart", make);
    mod.sharedSheet("globe", make);
    expect(make).not.toHaveBeenCalled();
    expect(mod.sharedSheet("street:1", make)).not.toBe(streets[1]);
    expect(make).toHaveBeenCalledOnce();
    expect(chart).toBe(mod.sharedSheet("chart", tex));
    expect(globe).toBe(mod.sharedSheet("globe", tex));
  });

  it("never evicts non-street sheets, even past the limit", () => {
    const all = Array.from({ length: 10 }, (_, i) => mod.sharedSheet(`chart:${i}`, tex));
    const spies = all.map((t) => vi.spyOn(t, "dispose"));
    const make = vi.fn(tex);
    all.forEach((t, i) => expect(mod.sharedSheet(`chart:${i}`, make)).toBe(t));
    expect(make).not.toHaveBeenCalled();
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true);
  });

  it("a shared sheet survives disposeObject; releaseSharedTextures frees its GPU copy", () => {
    const t = mod.sharedSheet("globe", tex);
    const spy = vi.spyOn(t, "dispose");
    const m = new THREE.MeshBasicMaterial({ map: t });
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.PlaneGeometry(), m));
    mod.disposeObject(root);
    expect(spy).not.toHaveBeenCalled();
    mod.releaseSharedTextures();
    expect(spy).toHaveBeenCalledOnce();
  });
});
