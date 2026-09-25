/** Small helpers shared by the REST routers (routes.ts, passkeyRoutes.ts, debug.ts, devAccess.ts). */
import type { NextFunction, Request, Response } from "express";
import { HelmError } from "../util/errors.js";
import { clientIp } from "../util/limits.js";
import type { TripService } from "../trips/service.js";

export const bearer = (req: Request) => req.headers.authorization?.replace(/^Bearer\s+/i, "") || undefined;

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
/** An async handler whose rejection reaches the router's error handler. */
export const asyncRoute = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

/** TR3-005 / SEC-020: a JSON body, or `{}` (no body, a text/plain body, or a JSON array/scalar) — never `undefined`. */
export const jsonBody = (req: Request): Record<string, unknown> =>
  (req.body && typeof req.body === "object" && !Array.isArray(req.body) && !Buffer.isBuffer(req.body) ? req.body : {});

/** SEC-007: the real client address (X-Forwarded-For only counts through TRUST_PROXY_HOPS trusted proxies). */
export const ipOf = (req: Request) => clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"]);

/** A route param as a string (express types them loosely). */
export const param = (req: Request, name: string) => String(req.params[name]);

/** O2-014: the crew member whose bearer token this is, on the route's voyage, or 403 NOT_MEMBER. */
export function bearerMember(helm: TripService, req: Request, message: string) {
  const m = helm.memberByToken(param(req, "tripId"), bearer(req));
  if (!m) throw new HelmError("NOT_MEMBER", message);
  return m;
}

/** HTML-escape for the dev pages. */
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
