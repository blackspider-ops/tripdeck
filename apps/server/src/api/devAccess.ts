/**
 * SEC-013 / SEC-025: who may use the dev routes (/api/demo/seed, /api/debug/*, /api/health details).
 *
 * - Dev mode (config.devMode: APP_ENV=development, `npm run dev`, tests) is open to a loopback client only (S2-004 /
 *   S2-005): a request through a tunnel, a proxy or from the LAN needs the key like anywhere else. Production never is.
 * - Otherwise the DEV_KEY is required, compared in constant time, and only ever sent as the `X-Dev-Key` header —
 *   never a query string (it would land in logs, history and Referer).
 * - The browser-opened /api/debug page can't set headers, so /api/debug/login takes the key once in a POSTed form and
 *   sets a short-lived (1 h), HttpOnly, SameSite=Strict cookie scoped to /api/debug, signed with a per-process secret.
 *   A restart signs everyone out. Failed logins are rate-limited per client address and logged.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { safeEqual as same } from "../util/ids.js";
import { LIMITS, MINUTE_MS, RateLimiter } from "../util/limits.js";
import { esc, ipOf } from "./http.js";

const COOKIE = "aa_dev";
const COOKIE_PATH = "/api/debug";
const TTL_MS = LIMITS.dev.sessionMs;
const SECRET = randomBytes(32);
const failures = new RateLimiter(LIMITS.dev.loginFailPerMinute, MINUTE_MS);
const sign = (exp: string) => createHmac("sha256", SECRET).update(exp).digest("base64url");

function devKeyMatches(key: unknown): boolean {
  return typeof key === "string" && key.length > 0 && Boolean(config.devKey) && same(key, config.devKey);
}

function cookieOf(req: Request): string {
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : "";
}

function cookieValid(v: string): boolean {
  const [exp, mac] = v.split(".");
  return Boolean(exp && mac) && Number(exp) > Date.now() && same(mac, sign(exp));
}

const LOOPBACK_HOST = /^(localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;
const loopbackAddr = (a: string) => /^(127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/i.test(a.trim());
/** "localhost:5173" / "[::1]:8787" / "http://127.0.0.1:5173/x" → is the host part loopback? */
function loopbackHost(v: string): boolean {
  let h = v.trim();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) h = new URL(h).host; } catch { return false; }
  h = h.replace(/:\d+$/, "");
  return LOOPBACK_HOST.test(h);
}
const header = (req: Request, k: string) => { const v = req.headers[k]; return Array.isArray(v) ? v.join(",") : v; };

/**
 * S2-004 / S2-005: did this request come from this machine, not through a tunnel, a proxy or the LAN? The socket peer,
 * the Host, and whatever the dev proxy (vite.config.ts `x-dev-proxy-*`, always overwritten there) or a forwarder
 * (X-Forwarded-*, Forwarded, cloudflared's Cf-* headers) says about the original client must all be loopback, and so
 * must a browser's Origin/Referer. Anything unclear counts as remote.
 */
export function isLoopbackRequest(req: Request): boolean {
  if (!loopbackAddr(req.socket.remoteAddress ?? "")) return false;
  if (!loopbackHost(header(req, "host") ?? "")) return false;
  if (header(req, "forwarded") !== undefined || header(req, "cf-connecting-ip") !== undefined || header(req, "cf-ray") !== undefined) return false;
  const client = header(req, "x-dev-proxy-client");
  if (client !== undefined && !loopbackAddr(client)) return false;
  for (const k of ["x-dev-proxy-host", "x-forwarded-host", "origin", "referer"]) {
    const v = header(req, k);
    if (v !== undefined && !v.split(",").every(loopbackHost)) return false;
  }
  const xff = header(req, "x-forwarded-for");
  if (xff !== undefined && !xff.split(",").every(loopbackAddr)) return false;
  return true;
}

export function devAllowed(req: Request): boolean {
  if (config.devMode && isLoopbackRequest(req)) return true;
  if (!config.devKey) return false;
  return devKeyMatches(req.headers["x-dev-key"]) || cookieValid(cookieOf(req));
}

const safeNext = (v: unknown) => (typeof v === "string" && /^\/api\/debug\/[A-Za-z0-9_-]{1,64}$/.test(v) ? v : "");

/** The sign-in form (also the body of a refused /api/debug/:id, so the page stays browser-openable). */
export function devLoginPage(res: Response, next = "", status = 403) {
  res.status(status).type("html").send(`<!doctype html><meta charset="utf-8"><title>debug sign-in</title>
<style>body{font:14px ui-monospace,monospace;background:#1B2130;color:#E8DFC9;padding:24px}input,button{font:inherit;padding:6px}</style>
<form method="post" action="/api/debug/login"><p>Dev key</p><input type="password" name="key" autocomplete="off" autofocus>
<input type="hidden" name="next" value="${esc(safeNext(next))}"><button>Open</button></form>`);
}

/** POST /api/debug/login (form or JSON body {key, next}) → cookie + 303 back to the debug page. */
export function devLogin(req: Request, res: Response) {
  const ip = ipOf(req);
  if (failures.blocked(ip)) return void res.status(429).type("text").send("Too many wrong keys — wait a minute.");
  const body = (req.body ?? {}) as { key?: unknown; next?: unknown };
  if (!devKeyMatches(body.key)) {
    failures.note(ip);
    console.warn(`[debug] refused dev sign-in from ${ip}`);
    return devLoginPage(res, String(body.next ?? ""));
  }
  const exp = String(Date.now() + TTL_MS);
  res.setHeader("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=${COOKIE_PATH}; Max-Age=${TTL_MS / 1000}; HttpOnly; SameSite=Strict${config.production ? "; Secure" : ""}`);
  console.log(`[debug] dev sign-in from ${ip}`);
  res.redirect(303, safeNext(body.next) || COOKIE_PATH + "/login");
}

/**
 * SEC-025 / S2-004: the debug view names nobody: a short reference instead of a member's name or id. Keyed with the
 * per-process secret (and scoped to the voyage), so it can't be recomputed from the public member id; stable within
 * one voyage for the life of the process.
 */
export const redactRef = (tripId: string, memberId: string) =>
  "crew-" + createHmac("sha256", SECRET).update(`debug-ref|${tripId}|${memberId}`).digest("hex").slice(0, 6);
