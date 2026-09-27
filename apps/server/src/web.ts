/**
 * HTTP hardening and production web serving (WP-08). Hand-rolled, no extra dependencies.
 *   securityHeaders — SEC-012: CSP, frame-ancestors, HSTS (production), nosniff, Referrer-Policy, Permissions-Policy
 *   apiNotFound     — TR3-006 / TR3-017: an unknown /api/* path is a JSON 404, never the SPA's index.html
 *   mountWeb        — OPT-059 / TR3-017: the built web app on the same origin, with the right cache headers
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { Lru } from "./util/limits.js";

/** Google Photorealistic 3D Tiles (only fetched when the web build has VITE_GOOGLE_MAP_TILES_KEY or VITE_CESIUM_ION_TOKEN). */
const TILES = "https://tile.googleapis.com";
/** Cesium ion: hands out the Google tiles' root URL for the ion token (then tiles load from TILES). */
const ION = "https://api.cesium.com";

/**
 * The CSP for everything the helm serves. Why each source:
 *   script-src blob:  troika-three-text builds its text-layout workers from blob: URLs and importScripts() them
 *   worker-src blob:  same workers
 *   connect-src       the API + Socket.io (same origin; ws(s):// spelled out for older Safari), Google tiles, Cesium ion
 *   img-src data: blob:  QR codes are data: URLs; tile textures arrive as blobs
 *   media-src blob:   ElevenLabs voices come from same-origin /api/audio; recorded hails are previewed as blobs
 *   media-src data:   the Gear VR / Cardboard fallback (webxr-polyfill) keeps an old phone's screen awake with a tiny
 *                     looping data: video where the Screen Wake Lock API is missing (Samsung Internet <= 12)
 *   style-src 'unsafe-inline'  the /api/debug page's <style>; React's style props don't need it
 */
function contentSecurityPolicy(host: string | undefined): string {
  // O2-042: built once per Host header (a small LRU, so a flood of odd hosts can't grow it)
  const key = `${config.production ? 1 : 0}|${config.publicBaseUrl}|${host ?? ""}`;
  const hit = cspByHost.get(key);
  if (hit !== undefined) return hit;
  const csp = buildCsp(host);
  cspByHost.set(key, csp);
  return csp;
}
const cspByHost = new Lru<string, string>(64);
function buildCsp(host: string | undefined): string {
  const ws = new Set<string>();
  if (config.publicBaseUrl) ws.add(config.publicBaseUrl.replace(/^http/, "ws"));
  const h = (host ?? "").replace(/[^A-Za-z0-9.:\-[\]]/g, "");
  if (h) { ws.add(`wss://${h}`); if (!config.production) ws.add(`ws://${h}`); }
  return [
    "default-src 'self'",
    "script-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src 'self' blob: data: ${[...ws].join(" ")} ${TILES} ${ION}`.replace(/\s+/g, " "),
    `img-src 'self' data: blob: ${TILES}`,
    "media-src 'self' blob: data:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** WebXR and the hail microphone for this origin only; nothing else. */
const PERMISSIONS = "xr-spatial-tracking=(self), microphone=(self), camera=(), geolocation=(), payment=(), usb=()";

export function securityHeaders() {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", contentSecurityPolicy(req.headers.host));
    res.setHeader("X-Content-Type-Options", "nosniff");
    // L3-007: same-origin keeps the Referer on the app's own requests (the passkey status GET resolves its relying party
    // from it; same-origin GETs carry no Origin) and still sends none cross-origin
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", PERMISSIONS);
    if (config.production) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}


/** SPA routes: anything but /api(/…) and /socket.io(/…) — `/apiary` is an app route (TR3-017). */
const SPA_ROUTE = /^(?!\/(api|socket\.io)(\/|$)).*/;

/**
 * Serves the built web app when config.serveWeb (production, or SERVE_WEB=1): `/assets/*` are content-hashed, so
 * they're immutable for a year; everything else in public/ (fonts, textures) for an hour; index.html is never cached,
 * so a deploy is picked up on the next load. Source maps are not served in production. A missing file (anything with
 * an extension) is a 404, not index.html — a stale hashed chunk must fail loudly, not parse HTML as JS.
 */
export function mountWeb(app: Express, dir = config.webDist): boolean {
  if (!config.serveWeb) return false;
  const index = join(dir, "index.html");
  if (!existsSync(index)) {
    if (config.production) console.warn(`[web] no web build at ${dir} (run npm run build); serving the API only`);
    return false;
  }
  if (config.production) app.use((req, res, next) => (/\.map$/i.test(req.path) ? void res.status(404).end() : next()));
  const assets = join(dir, "assets");
  app.use(express.static(dir, {
    index: false,
    setHeaders: (res, file) => {
      res.setHeader("Cache-Control", file === index ? "no-cache"
        : file.startsWith(assets) ? "public, max-age=31536000, immutable" : "public, max-age=3600");
    },
  }));
  app.get(SPA_ROUTE, (req, res) => {
    if (/\.[A-Za-z0-9]+$/.test(req.path)) return void res.status(404).end();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(index);
  });
  return true;
}

/** Hosts a developer's phones and headset reach the dev server on: loopback, the LAN, cloudflared quick tunnels. */
const DEV_HOST = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|.+\.local|.+\.trycloudflare\.com)$/i;

/**
 * SEC-026: may a browser page from `origin` open a socket? Non-browser clients send no Origin (allowed; they carry
 * tokens, not cookies). Otherwise: the page's own origin (Origin host = Host), PUBLIC_BASE_URL, CORS_ORIGINS, and —
 * outside production only — loopback/LAN/tunnel pages (Vite's proxy rewrites Host, so same-origin can't be seen).
 */
export function originAllowed(origin: string | undefined, host?: string): boolean {
  if (!origin) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin === config.publicBaseUrl || config.corsOrigins.includes(u.origin)) return true;
  if (host && u.host.toLowerCase() === host.toLowerCase()) return true;
  return !config.production && DEV_HOST.test(u.hostname);
}
