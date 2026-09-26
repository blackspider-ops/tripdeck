// Gear VR / Cardboard: which headset path the Enter card offers (mocked navigator.xr).
import { describe, expect, it, vi } from "vitest";
import { cardboardRequested, detectXRMode, ipdFromSearch, isPhoneUA, nextLensSpacing, requestMotionPermission, vrBufferScale } from "./vrMode";

function fakeXR(modes: string[], throws = false) {
  return { isSessionSupported: vi.fn(async (m: string) => { if (throws) throw new Error("SecurityError"); return modes.includes(m); }) };
}

function rig(opts: { native?: string[] | null; afterPolyfill?: string[] | null; search?: string; phone?: boolean; polyfillFails?: boolean }) {
  let xr = opts.native === null || opts.native === undefined ? undefined : fakeXR(opts.native);
  const loadPolyfill = vi.fn(async () => {
    if (opts.polyfillFails) throw new Error("chunk failed");
    xr = opts.afterPolyfill ? fakeXR(opts.afterPolyfill) : undefined;
  });
  return { deps: { getXR: () => xr, search: opts.search ?? "", phone: opts.phone ?? false, loadPolyfill }, loadPolyfill };
}

describe("detectXRMode", () => {
  it("immersive-ar wins (Quest mixed reality, unchanged) and never loads the polyfill", async () => {
    const r = rig({ native: ["immersive-ar", "immersive-vr"], phone: true });
    expect(await detectXRMode(r.deps)).toEqual({ kind: "ar", polyfilled: false });
    expect(r.loadPolyfill).not.toHaveBeenCalled();
  });

  it("native immersive-vr without AR → the VR path, no polyfill", async () => {
    const r = rig({ native: ["immersive-vr"], phone: true });
    expect(await detectXRMode(r.deps)).toEqual({ kind: "vr", polyfilled: false });
    expect(r.loadPolyfill).not.toHaveBeenCalled();
  });

  it("a phone with no WebXR at all → the Cardboard polyfill, then VR", async () => {
    const r = rig({ native: null, afterPolyfill: ["immersive-vr"], phone: true });
    expect(await detectXRMode(r.deps)).toEqual({ kind: "vr", polyfilled: true });
    expect(r.loadPolyfill).toHaveBeenCalledWith(false); // nothing native to hide
  });

  it("a phone whose native WebXR can't present VR → the polyfill replaces it", async () => {
    const r = rig({ native: [], afterPolyfill: ["immersive-vr"], phone: true });
    expect(await detectXRMode(r.deps)).toEqual({ kind: "vr", polyfilled: true });
    expect(r.loadPolyfill).toHaveBeenCalledWith(true);
  });

  it("a laptop without XR keeps the laptop view and never loads the polyfill", async () => {
    const r = rig({ native: [], phone: false });
    expect(await detectXRMode(r.deps)).toEqual({ kind: "desk", polyfilled: false });
    expect(r.loadPolyfill).not.toHaveBeenCalled();
  });

  it("?vr=cardboard forces the polyfill even where AR is supported", async () => {
    const r = rig({ native: ["immersive-ar"], afterPolyfill: ["immersive-vr"], search: "?vr=cardboard", phone: false });
    expect(await detectXRMode(r.deps)).toEqual({ kind: "vr", polyfilled: true });
    expect(r.loadPolyfill).toHaveBeenCalledWith(true);
  });

  it("falls back to the laptop view when the polyfill fails to load or still can't present", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await detectXRMode(rig({ native: null, phone: true, polyfillFails: true }).deps)).toEqual({ kind: "desk", polyfilled: false });
    expect(warn).toHaveBeenCalled();
    expect(await detectXRMode(rig({ native: null, afterPolyfill: [], phone: true }).deps)).toEqual({ kind: "desk", polyfilled: false });
  });

  it("an isSessionSupported that throws counts as unsupported", async () => {
    const xr = fakeXR([], true);
    const loadPolyfill = vi.fn(async () => undefined);
    expect(await detectXRMode({ getXR: () => xr, search: "", phone: false, loadPolyfill })).toEqual({ kind: "desk", polyfilled: false });
    expect(xr.isSessionSupported).toHaveBeenCalledWith("immersive-ar");
    expect(xr.isSessionSupported).toHaveBeenCalledWith("immersive-vr");
  });
});

describe("helpers", () => {
  it("reads the flag", () => {
    expect(cardboardRequested("?vr=cardboard")).toBe(true);
    expect(cardboardRequested("?x=1&vr=cardboard")).toBe(true);
    expect(cardboardRequested("?vr=1")).toBe(false);
    expect(cardboardRequested("")).toBe(false);
  });

  it("phones yes (iPhone 16 Pro Safari too), Quest no", () => {
    expect(isPhoneUA("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe(true);
    expect(isPhoneUA("Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/12.1 Chrome/79.0 Mobile Safari/537.36")).toBe(true);
    expect(isPhoneUA("Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0 Chrome/126 VR Safari/537.36")).toBe(false);
    expect(isPhoneUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36")).toBe(false);
  });

  it("buffer scale ≤ 0.75 and never above pixel ratio 2", () => {
    expect(vrBufferScale(2)).toBe(0.75);
    expect(vrBufferScale(3)).toBeCloseTo(2 / 3); // iPhone 16 Pro
    expect(vrBufferScale(4)).toBe(0.5);
    expect(vrBufferScale(NaN)).toBe(0.75);
  });
});

describe("iOS motion permission (asked in the Enter VR tap)", () => {
  it("asks orientation and motion together, synchronously; granted only if both are", async () => {
    const o = { requestPermission: vi.fn(async () => "granted") };
    const m = { requestPermission: vi.fn(async () => "granted") };
    const p = requestMotionPermission(o, m);
    expect(o.requestPermission).toHaveBeenCalledOnce(); // before any await: keeps the tap's user activation
    expect(m.requestPermission).toHaveBeenCalledOnce();
    expect(await p).toBe("granted");
    expect(await requestMotionPermission(o, { requestPermission: async () => "denied" })).toBe("denied");
    expect(await requestMotionPermission({ requestPermission: async () => { throw new Error("NotAllowedError"); } }, undefined)).toBe("denied");
  });

  it("nothing to ask outside iOS", async () => {
    expect(await requestMotionPermission({}, undefined)).toBe("not-needed");
  });
});

describe("lens spacing", () => {
  it("?ipd= in mm, clamped; cycles narrow → normal → wide", () => {
    expect(ipdFromSearch("?ipd=60")).toBe(60);
    expect(ipdFromSearch("?ipd=90")).toBe(75);
    expect(ipdFromSearch("?ipd=abc")).toBeNull();
    expect(ipdFromSearch("")).toBeNull();
    expect(nextLensSpacing("narrow")).toBe("normal");
    expect(nextLensSpacing("wide")).toBe("narrow");
  });
});
