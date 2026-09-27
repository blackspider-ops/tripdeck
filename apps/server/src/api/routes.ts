/**
 * REST API (docs/04-technical-design.md §6). O2-020: `apiRouter` composes one small router per job, mounted in this
 * order (it matters: the voyage-exists check runs before every /trips/:tripId route, the JSON 404 and the error
 * handler come last):
 *   trips      create, look up by code, the voyage-exists check
 *   crew       join, absent friends and their invites, seat resets, demo handoffs
 *   headset    pairing codes, unpairing, /xr/pair
 *   hail audio the authenticated, budgeted voice-clip upload
 *   passkeys   passkeyRoutes.ts
 *   misc       turn audio, demo seed, cities, health
 *   debug      debug.ts
 */
import { visaHealth } from "../payments/visa/status.js";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { AIRPORTS, HAIL_MAX_CHARS, MAX_CREW, NOTE_MAX_CHARS, REGIONS, type Band, type CityId, type Destination, type Origin } from "@all-ayes/shared";
import type { TripService } from "../trips/service.js";
import { SPEND_PRIORITY_PHASES, VOICE_PHASES } from "../trips/records.js";
import { audioFile, transcribe } from "../voice/voice.js";
import { seedExpo, seedRandom } from "../demo/seed.js";
import { upcomingWindows } from "../trips/course.js";
import { memoryHealth } from "../memory/memory.js";
import { config, features } from "../config.js";
import { dbConnected, dbHealth } from "../store/db.js";
import { HelmError, INTERNAL_MESSAGE, slow } from "../util/errors.js";
import {
  Concurrency, LIMITS, MINUTE_MS, RateLimiter, anyBlocked, countFailures, loadSpend, setSpendPriority, spend, spendFlags, type Bucket,
} from "../util/limits.js";
import { withTimeout } from "../util/timeout.js";
import { devAllowed } from "./devAccess.js";
import { routestackStatus } from "../providers/routestack/index.js";
import { mountDebugRoutes } from "./debug.js";
import { issuePasskeyClaim, mountPasskeyRoutes } from "./passkeyRoutes.js";
import { worldRouter } from "./worldRoutes.js";
import { asyncRoute, bearer, bearerMember, ipOf, jsonBody, param } from "./http.js";

/** R2-WP-11 (S2-006): the IPv6 /48 of an address keyed on its /64 (`2001:db8:1:2::/64` → `2001:db8:1::/48`). */
export function prefix48(ip: string): string | undefined {
  if (!ip.endsWith("::/64")) return undefined;
  const g = ip.slice(0, -5).split(":");
  return g.length >= 3 ? `${g.slice(0, 3).join(":")}::/48` : undefined;
}

/** SEC-007 / OPT-023: the REST limiters (util/limits.ts), keyed on the real client address (http.ts ipOf). */
function apiLimiters() {
  const L = LIMITS.http;
  const perMinute = (n: number) => new RateLimiter(Math.max(1, n), MINUTE_MS);
  return {
    create: perMinute(L.createPerMinute),
    // R2-WP-11 (S2-006): new voyages per IPv6 /48 and for the whole server too
    createAll: perMinute(config.limits.createPerMinute), create48: perMinute(config.limits.createPer48PerMinute),
    lookup: perMinute(L.lookupPerMinute), lookupMiss: perMinute(L.lookupMissPerMinute),
    join: perMinute(L.joinPerMinute),
    claimFail: perMinute(L.claimFailPerMinute), handoffFail: perMinute(L.handoffFailPerMinute),
    // TR2-011: only wrong codes count, so venue NAT can't lock a valid code out. R2-WP-12 (S2-008): no global cap
    // (30 /64s kept it full and blocked every pairing); per address and per IPv6 /48 instead, with the 40-bit,
    // 10-minute, single-use codes doing the rest
    pairFail: perMinute(L.pairFailPerMinute), pairFail48: perMinute(config.limits.pairFailPer48PerMinute),
    // Quest-first: headset seat requests and their polls per address; seal-PIN changes per member
    attach: perMinute(10), attachPoll: perMinute(90), attachFail: perMinute(10), pinSet: perMinute(5),
    // R2-WP-12 (S2-007): unknown voyage ids under /trips/:tripId (each one a MongoDB lookup), counted per address
    tripMiss: perMinute(config.limits.tripMissPerMinute),
    // TR3-014 / SEC-005: spoken hails per member
    hailBurst: new RateLimiter(L.hailBurst, L.hailBurstWindowMs), hailMinute: perMinute(L.hailPerMinute),
    uploads: new Concurrency(L.uploadsInFlight), // in-flight audio uploads per address
  };
}
type Limiters = ReturnType<typeof apiLimiters>;

const take = (l: RateLimiter, key: string, message: string) => { if (!l.take(key)) throw slow(message); };
/** Counts only failures (wrong codes, bad invites) toward the limit; refuses while blocked (O2-014). */
async function failures<T>(buckets: Bucket[], message: string, fn: () => T | Promise<T>): Promise<T> {
  if (anyBlocked(buckets)) throw slow(message);
  return countFailures(buckets, fn);
}
/**
 * WP-10: a voyage archived at boot (or swept from memory) is loaded before the lookup, so nobody sees 503 LOADING.
 * A database error falls back to the sync lookup (which answers LOADING and retries the load in the background).
 */
const loaded = (helm: TripService, q: { tripId?: string; joinCode?: string }) => helm.hydrate(q).catch(() => undefined);

export function apiRouter(helm: TripService) {
  const r = express.Router();
  // R2-WP-12: the paid-call budgets' reserve follows this helm's voyages; today's stored counters are read at boot
  setSpendPriority((tripId) => SPEND_PRIORITY_PHASES.includes(helm.trips.get(tripId)?.status ?? "BRIEFING"));
  void loadSpend();
  // SEC-006: small JSON bodies everywhere (Content-Length over the limit is refused before reading); only the
  // authenticated hail-audio route takes a bigger raw body, after its auth check
  r.use(express.json({ limit: LIMITS.http.jsonBody }));
  const lim = apiLimiters();
  mountTripRoutes(r, helm, lim);
  mountCrewRoutes(r, helm, lim);
  mountHeadsetRoutes(r, helm, lim);
  mountHailAudio(r, helm, lim);
  mountPasskeyRoutes(r, helm); // PRD E2
  mountMiscRoutes(r, helm);
  mountDebugRoutes(r, helm);
  // docs/11: search any city (curated first, then OpenStreetMap) and build a generated port's pack
  r.use("/world", worldRouter(helm));
  // TR3-006: an unknown /api route is a JSON 404 (the router's last handler), never the SPA's HTML or "Cannot GET"
  r.use((_req, res) => void res.status(404).json({ code: "NOT_FOUND", message: "No such route." }));
  r.use(errorToJson);
  return r;
}

/** Errors → JSON: a refusal with its table status (O2-025), a body-parser error as the client's, anything else 500. */
function errorToJson(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HelmError) return void res.status(err.status).json({ code: err.code, message: err.message });
  // SEC-006 / TR3-005: body-parser errors are the client's (413 too large, 400 bad JSON, 415 charset…), not a 500,
  // and they aren't logged as crashes
  const bp = err as { type?: string; status?: number };
  if (bp?.type === "entity.too.large") return void res.status(413).json({ code: "TOO_LARGE", message: "That's too much to send." });
  if (bp?.type === "entity.parse.failed") return void res.status(400).json({ code: "BAD_JSON", message: "That request wasn't valid JSON." });
  if (typeof bp?.status === "number" && bp.status >= 400 && bp.status < 500) return void res.status(bp.status).json({ code: "BAD_REQUEST", message: "That request didn't make sense." });
  console.error("[api]", err);
  res.status(500).json({ code: "INTERNAL", message: INTERNAL_MESSAGE });
}

/** Create a voyage, look one up by code, and (before every /trips/:tripId route) check the voyage exists. */
function mountTripRoutes(r: Router, helm: TripService, lim: Limiters) {
  /**
   * R2-WP-11 (S2-006): new voyages are limited per address (/64), per IPv6 /48, and for the whole server, and refused
   * (503 HELM_FULL) while MAX_LIVE_VOYAGES are held in memory, after a sweep has had a go at making room.
   */
  const limitCreate = (req: Request) => {
    const ip = ipOf(req);
    const net48 = prefix48(ip);
    if (net48 && lim.create48.blocked(net48)) throw slow("Too many voyages from your network — try again in a minute.");
    const cap = config.limits.maxLiveVoyages;
    if (cap > 0 && helm.trips.size >= cap && (helm.sweep(), helm.trips.size >= cap)) {
      throw new HelmError("HELM_FULL", "The helm is full right now. Try again in a few minutes.");
    }
    if (lim.createAll.blocked("all")) throw slow("Lots of voyages are being started right now — try again in a minute.");
    take(lim.create, ip, "Too many voyages from here — try again in a minute.");
    if (net48) lim.create48.take(net48);
    lim.createAll.take("all");
  };

  r.post("/trips", asyncRoute((req, res) => {
    limitCreate(req);
    const b = jsonBody(req) as {
      name: string; organizerName: string; band: Band; origin: Origin; cityIds?: CityId[]; destination?: Destination; windowIds?: string[];
      dateRange?: unknown; crewKey?: string; device?: string;
    };
    // the course is validated by the helm (trips/course.ts): named ports, regions / states or anywhere; a date range
    // or 1–3 fixed windows
    const { trip, member, token, crewKey } = helm.createTrip({
      name: b.name, organizerName: b.organizerName, band: Number(b.band) as Band, origin: b.origin,
      cityIds: Array.isArray(b.cityIds) ? b.cityIds : undefined,
      destination: b.destination && typeof b.destination === "object" ? b.destination : undefined,
      windowIds: Array.isArray(b.windowIds) ? b.windowIds : undefined,
      // a date range (new phones) wins over fixed windows (older clients, the Expo); both are validated by the helm
      dateRange: b.dateRange && typeof b.dateRange === "object" ? b.dateRange : undefined, crewKey: b.crewKey,
      device: b.device === "headset" ? "headset" : undefined, // Quest-first: the organizer's seat is this headset
    });
    issuePasskeyClaim(req, res, trip._id, member._id); // S2-009: only this phone may add the seat's passkey
    // crewKey: the phone's private memory identity (SEC-003), echoed or freshly minted; the phone keeps it
    res.json({ tripId: trip._id, joinCode: trip.joinCode, memberId: member._id, memberToken: token, crewKey });
  }));

  r.get("/trips/by-code/:code", asyncRoute(async (req, res) => {
    const ip = ipOf(req);
    take(lim.lookup, ip, "Too many lookups from here — wait a minute.");
    const code = param(req, "code");
    // WP-10: an archived voyage is loaded first, so the caller never sees 503 LOADING
    const t = await failures([[lim.lookupMiss, ip]], "Too many wrong codes — wait a minute.", async () => (await loaded(helm, { joinCode: code })) ?? helm.tripByCode(code));
    const crew = helm.crewPublic(t);
    res.json({ tripId: t._id, joinCode: t.joinCode, name: t.name, status: t.status, crew, takenBands: crew.map((c) => c.band), crewClosed: Boolean(t.crewClosed) });
  }));

  // TR3-013: a voyage that doesn't exist is a 404 before any auth check (it was 403 NOT_ORGANIZER / NOT_MEMBER)
  // (an archived voyage is loaded first: WP-10)
  r.use("/trips/:tripId", (req, _res, next) => {
    const tripId = param(req, "tripId");
    // L3-005: `/trips/by-code/…` is its own route, not a voyage id (a wrong method there is NOT_FOUND, not NO_TRIP)
    if (tripId === "by-code") return next();
    // R2-WP-12 (S2-007): a voyage in memory costs nothing; an unknown id is a database lookup, so an address that
    // keeps sending unknown ids is refused before the lookup (only misses count, like wrong join codes)
    if (helm.trips.has(tripId)) return next();
    const ip = ipOf(req);
    if (lim.tripMiss.blocked(ip)) return next(slow("Too many unknown voyages from here — wait a minute."));
    void loaded(helm, { tripId }).then(() => {
      if (!helm.trips.has(tripId)) lim.tripMiss.note(ip);
      return helm.trip(tripId);
    }).then(() => next(), next);
  });
}

/** Joining, absent friends and their invites, seat resets and demo handoffs (each hands out a passkey claim, S2-009). */
function mountCrewRoutes(r: Router, helm: TripService, lim: Limiters) {
  r.post("/trips/:tripId/members", asyncRoute((req, res) => {
    take(lim.join, ipOf(req), "Too many joins from here — wait a minute.");
    const b = jsonBody(req) as { name: string; band: Band; origin: Origin; crewKey?: string; device?: string };
    const { member, token, crewKey } = helm.join(param(req, "tripId"), {
      name: b.name, band: Number(b.band) as Band, origin: b.origin, crewKey: b.crewKey, device: b.device === "headset" ? "headset" : undefined,
    });
    issuePasskeyClaim(req, res, param(req, "tripId"), member._id); // S2-009
    res.json({ memberId: member._id, memberToken: token, crewKey });
  }));

  r.post("/trips/:tripId/absent", asyncRoute((req, res) => {
    const b = jsonBody(req) as { name: string; band: Band; origin: Origin };
    res.json(helm.addAbsent(param(req, "tripId"), { token: bearer(req) }, { name: b.name, band: Number(b.band) as Band, origin: b.origin }));
  }));

  // TR1-001: organizer-only, re-issues an unclaimed absent friend's invite (the previous link stops working)
  r.post("/trips/:tripId/absent/:memberId/invite", asyncRoute((req, res) => {
    res.json(helm.reissueInvite(param(req, "tripId"), { token: bearer(req) }, param(req, "memberId")));
  }));

  r.post("/trips/:tripId/absent/:memberId/claim", asyncRoute(async (req, res) => {
    const b = jsonBody(req) as { inviteKey?: string; crewKey?: string };
    const tripId = param(req, "tripId"), memberId = param(req, "memberId");
    const out = await failures([[lim.claimFail, ipOf(req)]], "Too many tries — wait a minute.", () => helm.claimAbsent(tripId, memberId, String(b.inviteKey ?? ""), b.crewKey));
    issuePasskeyClaim(req, res, tripId, memberId); // S2-009: the claiming phone, not the organizer's, may add a passkey
    res.json(out);
  }));

  // S2-009 / S2-012: organizer-only recovery for a seat someone else took: the seat's token and passkeys are revoked
  // and a fresh invite link (same shape as an absent friend's) is minted for the rightful member to re-claim
  r.post("/trips/:tripId/members/:memberId/reset", asyncRoute((req, res) => {
    res.json(helm.resetSeat(param(req, "tripId"), { token: bearer(req) }, param(req, "memberId")));
  }));

  // SEC-004: a demo link carries a one-time handoff code (minted by the DEV_KEY-gated seed), never a member token
  r.post("/trips/:tripId/members/:memberId/handoff", asyncRoute(async (req, res) => {
    const tripId = param(req, "tripId"), memberId = param(req, "memberId");
    const out = await failures([[lim.handoffFail, ipOf(req)]], "Too many tries — wait a minute.",
      () => helm.redeemHandoff(tripId, memberId, String((jsonBody(req) as { code?: string }).code ?? "")));
    issuePasskeyClaim(req, res, tripId, memberId); // S2-009: the demo phone that took the seat
    res.json(out);
  }));
}

/** The headset: a pairing code from the organizer's phone, unpairing (SEC-018), and the headset's side of pairing. */
function mountHeadsetRoutes(r: Router, helm: TripService, lim: Limiters) {
  r.post("/trips/:tripId/headset-code", asyncRoute((req, res) => {
    res.json(helm.headsetCode(param(req, "tripId"), { token: bearer(req) }));
  }));

  r.delete("/trips/:tripId/headset", asyncRoute((req, res) => {
    helm.unpairHeadset(param(req, "tripId"), { token: bearer(req) });
    res.json({ ok: true });
  }));

  /**
   * Quest-first (docs/04 §6): a headset asks to sit in an existing seat of the voyage with this join code. The seat's
   * own device gets a one-tap "Let this headset in?" (socket `headset:request`); the headset polls with its secret.
   * Requests per address are limited, and so are wrong secrets on the poll.
   */
  r.post("/xr/attach", asyncRoute(async (req, res) => {
    const b = jsonBody(req) as { joinCode?: unknown; memberId?: unknown };
    take(lim.attach, ipOf(req), "Too many headset requests from here — wait a minute.");
    const joinCode = String(b.joinCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    await loaded(helm, { joinCode });
    const out = helm.requestAttach(joinCode, String(b.memberId ?? ""));
    res.json(out);
  }));
  r.post("/xr/attach/status", asyncRoute(async (req, res) => {
    const b = jsonBody(req) as { requestId?: unknown; secret?: unknown };
    take(lim.attachPoll, ipOf(req), "Checking too often — wait a moment.");
    res.json(await failures([[lim.attachFail, ipOf(req)]], "Too many wrong headset requests — wait a minute.",
      () => helm.attachStatus(String(b.requestId ?? ""), String(b.secret ?? ""))));
  }));
  // the seat's own device (phone or the headset itself) ends the headset it let in
  r.delete("/trips/:tripId/my-headset", asyncRoute((req, res) => {
    const m = bearerMember(helm, req, "Only crew can do that.");
    helm.detachHeadset(param(req, "tripId"), m._id);
    res.json({ ok: true });
  }));

  /**
   * Quest-first: the seal PIN, for a headset whose browser can't hold a passkey (4–6 digits, hashed with scrypt, bound
   * to the member; wrong tries are counted in sealing and here). GET says whether one is set.
   */
  r.get("/trips/:tripId/seal-pin", asyncRoute((req, res) => {
    const m = bearerMember(helm, req, "Only crew can do that.");
    res.json({ set: Boolean(m.sealPin) });
  }));
  r.post("/trips/:tripId/seal-pin", asyncRoute((req, res) => {
    const m = bearerMember(helm, req, "Only crew can do that.");
    take(lim.pinSet, m._id, "Too many PIN changes — wait a minute.");
    const b = jsonBody(req) as { pin?: unknown; currentPin?: unknown };
    res.json(helm.setSealPin(param(req, "tripId"), m._id, b.pin, b.currentPin));
  }));

  r.post("/xr/pair", asyncRoute(async (req, res) => {
    const code = String((jsonBody(req) as { code?: string }).code ?? "").trim();
    const ip = ipOf(req);
    const net48 = prefix48(ip);
    const buckets: Bucket[] = [[lim.pairFail, ip], ...(net48 ? [[lim.pairFail48, net48] as Bucket] : [])];
    res.json(await failures(buckets, "Too many headset codes tried — wait a minute.", () => helm.pairHeadset(code)));
  }));
}

/**
 * SEC-006 / SEC-005 / TR3-014: authenticate, phase-check, rate-limit and budget-check BEFORE reading the body; then
 * read at most HAIL_AUDIO_MAX_BYTES (~20 s of voice). Unauthenticated callers never get a byte buffered.
 */
function mountHailAudio(r: Router, helm: TripService, lim: Limiters) {
  const maxAudio = config.limits.hailAudioMaxBytes;
  const gate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tripId = param(req, "tripId");
      const m = bearerMember(helm, req, "Only crew can hail.");
      if (!features.eleven()) throw new HelmError("NO_STT", "Voice hails need ElevenLabs — type your hail instead.", 501);
      if (!VOICE_PHASES.includes(helm.trip(tripId).status)) throw new HelmError("BAD_PHASE", "Voice notes are for your terms and hails.");
      const len = Number(req.headers["content-length"]);
      if (!req.headers["content-length"] || !Number.isFinite(len)) throw new HelmError("LENGTH_REQUIRED", "Send the clip with a length.");
      if (len > maxAudio) throw new HelmError("TOO_LARGE", "That clip is too long — keep it short.");
      // R2-WP-12 (L1-010): an empty clip is refused before it can use a rate-limit slot or the STT budget
      if (len === 0) throw new HelmError("BAD_INPUT", "That clip was empty — try again.");
      take(lim.hailBurst, m._id, "One voice clip every few seconds.");
      take(lim.hailMinute, m._id, "That's a lot of voice clips — type for a minute.");
      // L5-011: the stored counters first, so a restart can't hand out extra clips (a slow database doesn't hold the clip up)
      await withTimeout(loadSpend(tripId), LIMITS.http.spendLoadWaitMs, () => undefined);
      if (!spend("stt", tripId)) throw new HelmError("NO_STT", "Voice is resting for now — type your hail instead.");
      const ip = ipOf(req);
      if (!lim.uploads.enter(ip)) throw slow("One clip at a time.");
      res.on("close", () => lim.uploads.leave(ip));
      next();
    } catch (e) {
      next(e); // the unread body is discarded by Node as it arrives, never buffered
    }
  };
  r.post("/trips/:tripId/hail-audio", gate, express.raw({ type: () => true, limit: maxAudio }), asyncRoute(async (req, res) => {
    const transcript = await transcribe(req.body as Buffer, String(req.headers["content-type"] ?? "audio/webm"));
    if (!transcript) throw new HelmError("STT_FAILED", "Couldn't hear that — try typing it.");
    // R2-WP-12 (L1-005): the Brief's dictated note (?kind=note) keeps the note's 200 characters, a hail its 160
    res.json({ transcript: transcript.slice(0, req.query.kind === "note" ? NOTE_MAX_CHARS : HAIL_MAX_CHARS) });
  }));
}

/** Turn audio, the demo seed, the cities, and health. */
function mountMiscRoutes(r: Router, helm: TripService) {
  // OPT-040: served straight from the content-addressed TTS cache; sendFile's own 404 replaces existsSync.
  // dotfiles: the default cache dir is apps/server/.cache, and send ignores (404s) any path with a dot segment.
  // The path is ours (turnId → sha1 key), never the caller's, so allowing it exposes nothing else.
  r.get("/audio/:turnId", (req, res) => {
    const file = audioFile(param(req, "turnId"));
    // L3-005: every error is JSON, this one too (an <audio> element just sees the 404)
    const gone = () => void res.status(404).json({ code: "NOT_FOUND", message: "No such audio." });
    if (!file) return gone();
    res.setHeader("Cache-Control", `public, max-age=${LIMITS.http.audioMaxAgeS}`);
    res.type("audio/mpeg").sendFile(file, { dotfiles: "allow" }, (err) => {
      if (err && !res.headersSent) { res.removeHeader("Cache-Control"); gone(); }
    });
  });

  // docs/09: a random voyage by default (?kind=random, optional &seed=<n> to replay one); ?kind=expo is the scripted
  // Lisbon crew the tests and the pitch use
  r.post("/demo/seed", asyncRoute(async (req, res) => {
    if (!devAllowed(req)) throw new HelmError("FORBIDDEN", "Demo seeding is disabled here.");
    const kind = String(req.query.kind ?? "random");
    if (kind !== "random" && kind !== "expo") throw new HelmError("BAD_INPUT", "kind is random or expo.");
    const seed = Number(req.query.seed);
    const crew = req.query.crew === undefined ? undefined : Number(req.query.crew);
    if (crew !== undefined && !(Number.isInteger(crew) && crew >= 2 && crew <= MAX_CREW)) throw new HelmError("BAD_INPUT", `crew is 2 to ${MAX_CREW}.`);
    res.json(kind === "expo" ? await seedExpo(helm) : await seedRandom(helm, Number.isInteger(seed) && seed >= 0 ? seed : undefined, crew));
  }));

  r.get("/cities", (_req, res) => {
    res.json(helm.ds.cities.map((c) => ({
      cityId: c._id, name: c.name, notes: c.publicFlags, country: c.country, region: c.region, state: c.state,
      lat: c.centerLat, lng: c.centerLng,
    })));
  });

  // The Create screen's catalog: every port (grouped by region on the phone), the regions that have ports, the date
  // windows with the default two, and the home airports
  r.get("/catalog", (_req, res) => {
    const regions = REGIONS.filter((reg) => helm.ds.cities.some((c) => c.region === reg || (reg === "United States" && c.state)));
    res.json({
      cities: helm.ds.cities.map((c) => ({ cityId: c._id, name: c.name, country: c.country, region: c.region, state: c.state, notes: c.publicFlags })),
      regions,
      windows: [...helm.ds.dateWindows].sort((a, b) => a.start.localeCompare(b.start)),
      defaultWindowIds: upcomingWindows(helm.ds).slice(0, 2).map((w) => w.id),
      airports: AIRPORTS,
    });
  });

  r.get("/health", (req, res) => {
    // SEC-022: the public answer is liveness + coarse booleans (the phone asks whether voice input exists);
    // configuration, usage and budgets only with the dev key
    const persistence = dbHealth();
    if (!devAllowed(req)) return void res.json({ ok: true, eleven: features.eleven(), degraded: Boolean(persistence.degraded) });
    res.json({
      ok: true,
      mongo: dbConnected(),
      // TR5-005/TR5-007: write-queue and connection state; `persistence.degraded` is the alarm
      persistence,
      gemini: features.gemini() ? config.gemini.model : false,
      eleven: features.eleven(),
      backboard: features.backboard(),
      // RouteStack live inventory configured (docs/12-routestack.md); never the keys
      routestack: routestackStatus().enabled,
      payments: helm.payments.mode,
      // PAYMENTS_MODE=visa_sandbox: what is configured (booleans) and the last live handshake / PAV outcome, never a secret
      visa: visaHealth(),
      agentDecisions: config.agentDecisions,
      expoMode: config.expoMode,
      demoReplay: config.demoReplay,
      voyages: helm.trips.size,
      // TR5-019 (WP-11): where crew memory lives and whether its local store is degraded
      memory: memoryHealth(),
      // SEC-005: coarse per-provider flags ("ok" | "capped"), never the counts
      budgets: spendFlags(),
    });
  });
}
