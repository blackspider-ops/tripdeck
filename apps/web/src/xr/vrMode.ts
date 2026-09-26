// Which headset path this browser gets. No three.js import: the Enter card runs this before anything 3D is needed,
// and the tests drive it with a fake `navigator.xr`.
//   immersive-ar supported → the Quest mixed-reality path (unchanged)
//   else immersive-vr      → the VR chart room on native WebXR (Chrome on Android: side-by-side Cardboard)
//   else, on a phone or with `?vr=cardboard` → load webxr-polyfill (lazy, its own chunk) and use the VR path. This is
//                            the primary path: an iPhone (Safari has no WebXR) or any phone clamped into a Gear VR
//                            shell as a plain lens viewer (no USB plug, no Gear VR service).
//   else                   → the laptop view

export type XRKind = "ar" | "vr" | "desk";

export interface XRDetection {
  kind: XRKind;
  /** The VR path runs on webxr-polyfill's Cardboard device (no native immersive-vr). */
  polyfilled: boolean;
}

interface XRSystemLike { isSessionSupported(mode: string): Promise<boolean> }

export interface DetectDeps {
  /** The live `navigator.xr` (read again after the polyfill is installed). */
  getXR: () => XRSystemLike | undefined;
  /** `location.search`. */
  search: string;
  /** A phone browser (Gear VR / Cardboard candidate); desktops without the flag keep the laptop view. */
  phone: boolean;
  /** Install webxr-polyfill's Cardboard device. `force`: hide a native navigator.xr that can't do immersive-vr. */
  loadPolyfill: (force: boolean) => Promise<void>;
}

/** The URL flag that forces the Cardboard (polyfill) path, e.g. `/t/ABC123/xr?vr=cardboard`. */
export const CARDBOARD_FLAG = "cardboard";

export function cardboardRequested(search: string): boolean {
  try { return new URLSearchParams(search).get("vr") === CARDBOARD_FLAG; } catch { return false; }
}

async function supports(xr: XRSystemLike | undefined, mode: string): Promise<boolean> {
  try { return !!(await xr?.isSessionSupported(mode)); } catch { return false; }
}

/** Detection order: AR, native VR, then the Cardboard polyfill (phones or `?vr=cardboard`), then the laptop view. */
export async function detectXRMode(deps: DetectDeps): Promise<XRDetection> {
  const forced = cardboardRequested(deps.search);
  if (!forced) {
    if (await supports(deps.getXR(), "immersive-ar")) return { kind: "ar", polyfilled: false };
    if (await supports(deps.getXR(), "immersive-vr")) return { kind: "vr", polyfilled: false };
    if (!deps.phone) return { kind: "desk", polyfilled: false };
  }
  try {
    await deps.loadPolyfill(forced || !!deps.getXR());
  } catch (e) {
    console.warn("[xr] Cardboard polyfill unavailable:", e instanceof Error ? e.message : String(e));
    return { kind: "desk", polyfilled: false };
  }
  if (await supports(deps.getXR(), "immersive-vr")) return { kind: "vr", polyfilled: true };
  return { kind: "desk", polyfilled: false };
}

/** A phone or small tablet browser (not a standalone headset): Gear VR / Cardboard candidates, low-end GPU budget. */
export function isPhoneUA(ua: string): boolean {
  if (/OculusBrowser|Quest|Pico/i.test(ua)) return false;
  return /Android|iPhone|iPod|Mobile/i.test(ua);
}

/** Framebuffer scale for the VR path: at most 0.75 and never above an effective pixel ratio of 2 (an iPhone 16 Pro's
 *  DPR 3 panel renders at 2/3: 1748×804 instead of 2622×1206 — sharper than the lenses resolve, and a third the fill). */
export function vrBufferScale(dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.max(0.4, Math.min(0.75, 2 / d));
}

// ---------------------------------------------------------------- iOS motion permission

export type MotionPermission = "granted" | "denied" | "not-needed";

type PermissionAPI = { requestPermission?: () => Promise<string> } | undefined;

/**
 * iOS 13+ Safari only sends device orientation/motion (the head tracking) after the page asks inside a tap. Both asks
 * start synchronously so they share the Enter VR tap's user activation; elsewhere there is nothing to ask.
 */
export function requestMotionPermission(
  orientation: PermissionAPI = (globalThis as unknown as { DeviceOrientationEvent?: PermissionAPI }).DeviceOrientationEvent,
  motion: PermissionAPI = (globalThis as unknown as { DeviceMotionEvent?: PermissionAPI }).DeviceMotionEvent,
): Promise<MotionPermission> {
  const asks = [orientation, motion].filter((a) => typeof a?.requestPermission === "function").map((a) => a!.requestPermission!().catch(() => "denied"));
  if (!asks.length) return Promise.resolve("not-needed");
  return Promise.all(asks).then((r) => (r.every((x) => x === "granted") ? "granted" : "denied"));
}

/** Shown on the Enter card when motion access was refused (the Enter VR button stays there to try again). */
export const MOTION_DENIED =
  "Head tracking needs motion access. Allow it: Settings → Safari → Motion & Orientation Access (on iOS 13+ the prompt appears on Enter VR; if you tapped Don't Allow, close and reopen this tab), then tap Enter VR again.";

// ---------------------------------------------------------------- lens spacing (Cardboard viewer fit)

export type LensSpacing = "narrow" | "normal" | "wide";
export const LENS_SPACINGS: readonly LensSpacing[] = ["narrow", "normal", "wide"];
/** Distance between the lens centres, millimetres. "normal" is a Gear VR's ~62 mm; `?ipd=` (mm) replaces it. */
export const LENS_MM: Record<LensSpacing, number> = { narrow: 58, normal: 62, wide: 66 };

/** `?ipd=60` → 60 (mm), clamped to 50–75; anything else → null. */
export function ipdFromSearch(search: string): number | null {
  try {
    const v = Number(new URLSearchParams(search).get("ipd"));
    return Number.isFinite(v) && v > 0 ? Math.min(75, Math.max(50, v)) : null;
  } catch { return null; }
}

export function nextLensSpacing(s: LensSpacing): LensSpacing {
  return LENS_SPACINGS[(LENS_SPACINGS.indexOf(s) + 1) % LENS_SPACINGS.length];
}
