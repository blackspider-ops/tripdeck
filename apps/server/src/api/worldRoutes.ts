/**
 * /api/world (docs/11-world-cities.md): search any city (curated first, then OpenStreetMap Nominatim) and build a
 * city pack for a place from OpenStreetMap. Not mounted yet: the wiring is `r.use("/world", worldRouter(helm))` in
 * api/routes.ts (before the JSON 404), or `app.use("/api/world", worldRouter(helm))` — this router answers its own
 * errors either way.
 *
 *   GET  /search?q=split          → WorldSearchResponse
 *   POST /packs {osmId:"R123"}    → { pack: CityPack, cached, registered }   (10/min per address)
 *   GET  /packs/:id               → CityPack (stored packs only; never builds)
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { loadDataset } from "../data/loader.js";
import { HelmError, INTERNAL_MESSAGE, slow } from "../util/errors.js";
import { MINUTE_MS, RateLimiter } from "../util/limits.js";
import { UpstreamBusy, busyError } from "../world/net.js";
import { isOsmRef } from "../world/nominatim.js";
import { packFor, readStoredPack } from "../world/packs.js";
import { worldSearch, type CuratedCity } from "../world/search.js";
import { asyncRoute, ipOf, jsonBody, param } from "./http.js";

export const WORLD_LIMITS = { searchPerMinute: 30, packsPerMinute: 10, maxQueryChars: 100 } as const;

/** What the router needs from the helm: its dataset's cities (curated ones match first). */
export interface WorldHelm { ds?: { cities: CuratedCity[] } }

export function worldRouter(helm?: WorldHelm) {
  const r = express.Router();
  const searchLimit = new RateLimiter(WORLD_LIMITS.searchPerMinute, MINUTE_MS);
  const packLimit = new RateLimiter(WORLD_LIMITS.packsPerMinute, MINUTE_MS);
  const cities = (): CuratedCity[] => (helm?.ds?.cities ?? loadDataset().cities) as CuratedCity[];

  r.get("/search", asyncRoute(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (q.length > WORLD_LIMITS.maxQueryChars) throw new HelmError("BAD_INPUT", "That search is too long.");
    if (!searchLimit.take(ipOf(req))) throw slow("Too many searches — try again in a minute.");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json(await worldSearch(q, cities()));
  }));

  r.post("/packs", express.json({ limit: "2kb" }), asyncRoute(async (req, res) => {
    const osmId = jsonBody(req).osmId;
    if (!isOsmRef(osmId)) throw new HelmError("BAD_INPUT", "osmId must look like R123, W123 or N123.");
    if (!packLimit.take(ipOf(req))) throw slow("Too many cities at once — try again in a minute.");
    try {
      const out = await packFor(osmId);
      if (!out) throw new HelmError("NOT_FOUND", "That place isn't on the map.");
      res.json(out);
    } catch (e) {
      if (e instanceof UpstreamBusy) throw busyError(e, "The map");
      throw e;
    }
  }));

  r.get("/packs/:id", asyncRoute(async (req, res) => {
    const id = param(req, "id");
    const p = /^W-[NWR][0-9A-Z]{1,14}$/.test(id) ? await readStoredPack(id) : undefined;
    if (!p) throw new HelmError("NOT_FOUND", "No such city pack.");
    res.json(p);
  }));

  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof HelmError) {
      const ra = (err as HelmError & { retryAfterS?: number }).retryAfterS;
      if (ra) res.setHeader("Retry-After", String(ra));
      return void res.status(err.status).json({ code: err.code, message: err.message, ...(ra ? { retryAfterS: ra } : {}) });
    }
    const bp = err as { type?: string; status?: number };
    if (bp?.type === "entity.parse.failed") return void res.status(400).json({ code: "BAD_JSON", message: "That request wasn't valid JSON." });
    if (bp?.type === "entity.too.large") return void res.status(413).json({ code: "TOO_LARGE", message: "That's too much to send." });
    console.error("[world]", err);
    res.status(500).json({ code: "INTERNAL", message: INTERNAL_MESSAGE });
  });
  return r;
}
