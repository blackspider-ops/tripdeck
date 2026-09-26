// The phone-in-a-lens-shell VR path (lazy chunk, headset route only): webxr-polyfill's Cardboard device renders
// immersive-vr side by side with lens distortion and phone-sensor head tracking (3DoF) where the browser has no WebXR
// VR — iPhone Safari above all (a phone clamped into a Gear VR shell as a plain viewer). Loaded by the Enter card
// only when the browser can't do immersive-ar or immersive-vr itself (or `?vr=cardboard`).
//
// iPhone: no Fullscreen API, so the polyfill presents in place (the chart room's canvas is already full-viewport);
// XRPage asks for motion access in the Enter VR tap and prompts to turn the phone sideways.
// CSP (apps/server/src/web.ts): nothing here needs a new host or eval. The online device database fetch
// (dpdb.webvr.rocks) is turned off — the copy built into the polyfill lists common iPhones and Android phones — and
// the Cardboard settings/back-arrow overlay is off; the Exit plaque, the menu, Back and Escape leave VR.
import WebXRPolyfill from "webxr-polyfill";
import { LENS_MM, LENS_SPACINGS, type LensSpacing } from "./vrMode";

/** A Samsung Gear VR shell used as a plain Cardboard viewer (any phone clamped in, no USB plug): ~100° lenses ~62 mm
 *  apart, the phone centred. Distortion reuses Cardboard 2015's coefficients (the closest published profile). One
 *  profile per lens spacing (menu "Lens spacing"); `?ipd=` (mm) replaces the normal one. */
function gearVrViewer(spacing: LensSpacing, mm: number) {
  return {
    id: `GearVR-${spacing}`,
    label: `Gear VR shell (${spacing}, ${mm} mm)`,
    fov: 50,
    interLensDistance: mm / 1000,
    baselineLensDistance: 0.035,
    screenLensDistance: 0.04,
    distortionCoefficients: [0.34, 0.55],
    inverseCoefficients: [-0.33836704, -0.18162185, 0.862655, -1.2462051, 1.0560602, -0.58208317, 0.21609078, -0.05444823, 0.009177956, -9.904169e-4, 6.183535e-5, -1.6981803e-6],
  };
}

/** The polyfill remembers the last viewer here (its own key). */
const VIEWER_KEY = "WEBVR_CARDBOARD_VIEWER";

/** The globals webxr-polyfill defines (it won't replace a native one, and native classes reject polyfilled sessions). */
const XR_GLOBALS = [
  "XRSystem", "XRSession", "XRSessionEvent", "XRFrame", "XRView", "XRViewport", "XRViewerPose", "XRWebGLLayer",
  "XRSpace", "XRReferenceSpace", "XRReferenceSpaceEvent", "XRInputSource", "XRInputSourceEvent",
  "XRInputSourcesChangeEvent", "XRRenderState", "XRRigidTransform", "XRPose", "XRWebGLBinding",
] as const;

/**
 * Remove a native WebXR that can't present VR (desktop Chrome, an Android browser without VR support) so the
 * polyfill can inject its own. Only ever done on this fallback path, after immersive-ar/-vr were found unsupported
 * (or `?vr=cardboard` asked for it).
 */
function hideNativeWebXR() {
  const w = window as unknown as Record<string, unknown>;
  try { delete (Navigator.prototype as unknown as Record<string, unknown>).xr; } catch { /* not configurable */ }
  try { delete (navigator as unknown as Record<string, unknown>).xr; } catch { /* ditto */ }
  for (const k of XR_GLOBALS) { try { delete w[k]; } catch { /* ditto */ } }
  for (const C of [w.WebGLRenderingContext, w.WebGL2RenderingContext] as ({ prototype: Record<string, unknown> } | undefined)[]) {
    try { if (C) delete C.prototype.makeXRCompatible; } catch { /* ditto */ }
  }
}

let installed = false;

/**
 * iPhones newer than the polyfill's 2019 device list, matched (like its own iOS entries) by physical screen resolution;
 * without a match the lens centres assume the wrong pixel density. `bw`: bezel, mm.
 */
export const MODERN_IPHONES: readonly { res: [number, number]; dpi: number; name: string }[] = [
  { res: [1206, 2622], dpi: 460, name: "iPhone 16 Pro" },
  { res: [1320, 2868], dpi: 460, name: "iPhone 16 Pro Max" },
  { res: [1179, 2556], dpi: 460, name: "iPhone 14 Pro / 15 / 15 Pro / 16" },
  { res: [1290, 2796], dpi: 460, name: "iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus" },
  { res: [1170, 2532], dpi: 460, name: "iPhone 12 / 12 Pro / 13 / 13 Pro / 14" },
  { res: [1284, 2778], dpi: 458, name: "iPhone 12 Pro Max / 13 Pro Max / 14 Plus" },
  { res: [1080, 2340], dpi: 476, name: "iPhone 12 mini / 13 mini" },
];

interface DpdbLike { dpdb?: { devices?: unknown[] }; recalculateDeviceParams_?: () => void; getDeviceParams?: () => unknown }

/** Teach the polyfill's device database the modern iPhones, then recompute the lens geometry. */
function addModernIPhones() {
  const d = cardboardDisplay() as (CardboardDisplay & { dpdb_?: DpdbLike; onDeviceParamsUpdated_?: (p: unknown) => void }) | null;
  const db = d?.dpdb_;
  const devices = db?.dpdb?.devices;
  if (!d || !db || !devices) return;
  if (!devices.some((x) => (x as { name?: string }).name === MODERN_IPHONES[0].name)) {
    for (const p of MODERN_IPHONES) devices.push({ type: "ios", name: p.name, rules: [{ res: p.res }], dpi: p.dpi, bw: 3, ac: 1000 });
  }
  db.recalculateDeviceParams_?.();
  const params = db.getDeviceParams?.();
  if (params) d.onDeviceParamsUpdated_?.(params);
}

export async function installCardboard(force: boolean, opts: { bufferScale: number; ipdMm?: number | null }) {
  if (installed) return;
  if (force && "xr" in navigator) hideNativeWebXR();
  const hasWakeLock = "wakeLock" in navigator;
  const viewers = LENS_SPACINGS.map((s) => gearVrViewer(s, s === "normal" && opts.ipdMm ? opts.ipdMm : LENS_MM[s]));
  // the lens spacing picked last time (the polyfill reads it back from VIEWER_KEY); `?ipd=` starts on its own profile
  const initial = `GearVR-${opts.ipdMm ? "normal" : currentLensSpacing()}`;
  try { localStorage.setItem(VIEWER_KEY, initial); } catch { /* private mode */ }
  new WebXRPolyfill({
    webvr: false, // a stale WebVR 1.1 display (old Samsung Internet) would win over Cardboard
    cardboard: true,
    allowCardboardOnDesktop: true, // `?vr=cardboard` on a laptop: stereo, no head tracking (for testing)
    cardboardConfig: {
      ADDITIONAL_VIEWERS: viewers,
      DEFAULT_VIEWER: initial,
      DPDB_URL: null,
      CARDBOARD_UI_DISABLED: true,
      // XRPage shows its own "Turn your phone sideways" (iPhone has no orientation lock)
      ROTATE_INSTRUCTIONS_DISABLED: true,
      BUFFER_SCALE: opts.bufferScale,
      // XRApp takes a Screen Wake Lock where the browser has one (iOS 16.4+, Chrome 84+); older ones need the
      // polyfill's silent looping video instead (a data: URL — CSP media-src allows data:)
      MOBILE_WAKE_LOCK: !hasWakeLock,
    },
  });
  installed = true;
  // the device is attached to navigator.xr asynchronously; once it's there, fix up the phone's screen geometry
  try { await (navigator as unknown as { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr?.isSessionSupported("immersive-vr"); } catch { /* reported by detection */ }
  addModernIPhones();
}

interface CardboardDisplay {
  viewerSelector_?: { selectedKey: string; getCurrentViewer(): unknown };
  onViewerChanged_?: (viewer: unknown) => void;
}

/** The polyfill's Cardboard display (kept behind private symbols on navigator.xr). */
function cardboardDisplay(): CardboardDisplay | null {
  const xr = (navigator as unknown as { xr?: object }).xr;
  if (!xr) return null;
  for (const sym of Object.getOwnPropertySymbols(xr)) {
    const priv = (xr as Record<symbol, unknown>)[sym] as { device?: { display?: CardboardDisplay } } | undefined;
    const d = priv?.device?.display;
    if (d?.viewerSelector_ && d.onViewerChanged_) return d;
  }
  return null;
}

/** Switch the lens profile (menu "Lens spacing"); applies immediately, also mid-session, and is remembered. */
export function setLensSpacing(spacing: LensSpacing): boolean {
  const id = `GearVR-${spacing}`;
  try { localStorage.setItem(VIEWER_KEY, id); } catch { /* private mode */ }
  const d = cardboardDisplay();
  if (!d?.viewerSelector_ || !d.onViewerChanged_) return false;
  d.viewerSelector_.selectedKey = id;
  const viewer = d.viewerSelector_.getCurrentViewer();
  if (!viewer) return false;
  d.onViewerChanged_(viewer);
  return true;
}

/** The lens spacing the polyfill will use (remembered from last time). */
export function currentLensSpacing(): LensSpacing {
  try {
    const s = localStorage.getItem(VIEWER_KEY)?.replace("GearVR-", "");
    if (s && (LENS_SPACINGS as readonly string[]).includes(s)) return s as LensSpacing;
  } catch { /* private mode */ }
  return "normal";
}
