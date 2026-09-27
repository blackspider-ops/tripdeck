/**
 * Socket.io rooms + handlers (docs/04-technical-design.md §7).
 *   trip:{id}   — everyone on the voyage (phones, headset, gallery): public data only
 *   member:{id} — one member's phone(s): their private data
 * The headset joins with a device token: organizer controls, never a member room.
 * O2-020: each event is one entry of HANDLERS (plus the join and the client log), run through the same guard.
 */
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  CLIENT_TO_SERVER_EVENTS, JOIN_REFUSAL, UNKNOWN_EVENT, type AckFn, type BriefInput, type ClientToServer, type Dealbreaker, type ErrorPayload,
  type JoinAck, type JoinRefusalCode, type JoinRole, type S2CPayload, type ServerToClient, type Surface, type Tag,
} from "@all-ayes/shared";
import type { TripService } from "../trips/service.js";
import { memberRoom, tripRoom, type Actor } from "../trips/records.js";
import { HelmError, INTERNAL_MESSAGE, slow } from "../util/errors.js";
import { Concurrency, LIMITS, MINUTE_MS, RateLimiter, anyBlocked, clientIp, countFailures, setScopeTrip, withTrip } from "../util/limits.js";
import { originAllowed } from "../web.js";

interface SocketData { tripId?: string; memberId?: string; deviceToken?: string; surface?: Surface; ip?: string }
type HelmSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

const SURFACES: readonly Surface[] = ["phone", "xr", "gallery"];
/** SEC-014: the surface is one of the known three, whatever the client sent. */
const asSurface = (v: unknown): Surface => (SURFACES as readonly unknown[]).includes(v) ? (v as Surface) : "gallery";

/**
 * SEC-020: socket payloads are untrusted. Handlers see a plain object and read each field through these checks, so a
 * wrong type is a `BAD_INPUT` refusal, never a TypeError (and never an `[io]` stack in the log).
 */
type Raw = Record<string, unknown>;
const F = LIMITS.fields;
const badInput = () => new HelmError("BAD_INPUT", "That request didn't make sense.");
const str = (v: unknown, max: number = F.id): string => {
  if (typeof v !== "string" || v.length > max) throw badInput();
  return v;
};
const optStr = (v: unknown, max: number = F.id): string | undefined => (v === undefined || v === null ? undefined : str(v, max));
const strs = (v: unknown, maxItems: number = F.listItems, max: number = F.listItem): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems) throw badInput();
  return v.map((x) => str(x, max));
};
/** "When can you go?": `{any: true}` or up to a year and a bit of ISO days (the helm keeps the ones in range). */
const availabilityInput = (v: unknown): BriefInput["availability"] => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw badInput();
  const a = v as Raw;
  if (a.any === true) return { any: true };
  return { days: strs(a.days, F.days, 10) };
};
const briefInput = (p: Raw): BriefInput => ({
  capCents: typeof p.capCents === "number" || typeof p.capCents === "string" ? Number(p.capCents) : NaN,
  dateWindowIds: strs(p.dateWindowIds),
  availability: availabilityInput(p.availability),
  // "Places I'd love / skip" (validated against the voyage's scope by validateBrief)
  loves: p.loves === undefined ? undefined : strs(p.loves),
  skips: p.skips === undefined ? undefined : strs(p.skips),
  mustHaves: strs(p.mustHaves) as Tag[], // unknown tags are dropped by validateBrief
  dealbreakers: strs(p.dealbreakers) as Dealbreaker[],
  note: optStr(p.note, F.text),
  noteSource: p.noteSource === "voice" ? "voice" : "typed",
});
const DRYRUN_ACTIONS = ["pause", "resume", "restart"] as const;
const KNOWN_EVENTS: ReadonlySet<string> = new Set(CLIENT_TO_SERVER_EVENTS);

/**
 * One typed emit for the bus, the replay and the room broadcasts: `event` and `payload` are checked against
 * ServerToClient by the callers' signatures (Bus, TripService.replayNow). socket.io's own overloads can't be applied to
 * a generic event name, so the single widening happens here.
 */
function emitTyped<K extends keyof ServerToClient>(to: { emit(ev: K, ...args: Parameters<ServerToClient[K]>): unknown }, event: K, payload: S2CPayload<K>) {
  (to.emit as (ev: K, p: S2CPayload<K>) => unknown)(event, payload);
}

/** SEC-007: per-client-address limits (the real address: X-Forwarded-For only through TRUST_PROXY_HOPS proxies). */
function socketLimiters() {
  const S = LIMITS.socket;
  return {
    connect: new RateLimiter(S.connectPerMinute, MINUTE_MS),
    joinIp: new RateLimiter(S.joinPerMinute, MINUTE_MS), joinMissIp: new RateLimiter(S.joinMissPerMinute, MINUTE_MS),
    joinSocket: new RateLimiter(S.joinPerSocketPerMinute, MINUTE_MS),
    sockets: new Concurrency(S.socketsPerAddress),
  };
}
type Limiters = ReturnType<typeof socketLimiters>;

/** What a handler knows about its socket: the helm, the socket's identity, and who it acts as. */
interface Ctx {
  helm: TripService; socket: HelmSocket; data: SocketData; ip: string; lim: Limiters;
  tripId(): string; memberId(): string; actor(): Actor;
}

/** Every event but the join and the client log: a plain `{ok:true}` ack on success (TR3-007). */
const HANDLERS: { [K in Exclude<keyof ClientToServer, "trip:join" | "client:log">]: (c: Ctx, p: Raw) => unknown } = {
  "brief:submit": (c, p) => c.helm.submitBrief(c.tripId(), c.memberId(), briefInput(p)),
  "table:start": (c) => c.helm.startTable(c.tripId(), c.actor()),
  "table:sailWithout": (c, p) => c.helm.sailWithout(c.tripId(), c.actor(), strs(p.memberIds, F.memberIds)),
  "table:hail": (c, p) => {
    const id = c.tripId();
    const text = optStr(p.text, F.text) ?? "";
    // the headset hails on behalf of the organizer wearing it
    const who = c.data.memberId ?? (c.helm.deviceOk(id, c.data.deviceToken) ? c.helm.trip(id).organizerId : undefined);
    // L2-002: a headset whose pairing ended since it joined is told to re-pair (not "only crew")
    if (!who && c.data.deviceToken && c.helm.trip(id).status !== "BOOKED") throw new HelmError("DEVICE_EXPIRED", JOIN_REFUSAL.DEVICE_EXPIRED);
    if (!who) throw new HelmError("NOT_MEMBER", "Only crew can hail.");
    c.helm.hail(id, who, text);
  },
  "dryrun:control": (c, p) => {
    const action = DRYRUN_ACTIONS.find((a) => a === p.action);
    if (!action) throw badInput(); // TR3-007: an unknown action is refused, not silently dropped
    c.helm.dryrunControl(c.tripId(), c.actor(), action);
  },
  "plan:vote": (c, p) => c.helm.vote(c.tripId(), c.memberId(), str(p.planId)),
  // the crew's majority picks: a pick from any device (the headset's cloche) is that seat's vote
  "plan:pick": (c, p) => c.helm.pickAsVote(c.tripId(), c.actor(), str(p.planId)),
  "seal:set": (c, p) => c.helm.setSeal(c.tripId(), c.memberId(), str(p.bookingId), optStr(p.assertionToken, F.text), optStr(p.pin, 12)),
  "seal:cancel": (c, p) => c.helm.cancelSeal(c.tripId(), c.memberId(), str(p.bookingId)),
  "booking:retry": (c) => c.helm.retry(c.tripId(), c.actor()),
  // SEC-011: organizer (phone or paired headset) voids a booking that is still gathering seals
  "booking:callOff": (c, p) => c.helm.callOff(c.tripId(), c.actor(), optStr(p.bookingId)),
  // SEC-010: the organizer closes / reopens the crew to joins by code. L3-004: `open` must be a boolean (a string
  // "true" used to close the crew). (The headset is unpaired over REST only, `DELETE /api/trips/:id/headset`.)
  // Quest-first: the seat's own device lets a headset in (or not)
  "headset:approve": (c, p) => {
    if (typeof p.allow !== "boolean") throw badInput();
    c.helm.approveAttach(c.tripId(), c.memberId(), str(p.requestId, F.text), p.allow);
  },
  // chart-room pins: the course (organizer, or the crew while crewPins is on)
  "course:set": (c, p) => c.helm.setCourse(c.tripId(), c.actor(), { destination: p.destination, crewPins: p.crewPins }),
  "crew:setOpen": (c, p) => {
    if (typeof p.open !== "boolean") throw badInput();
    return c.helm.setCrewOpen(c.tripId(), c.actor(), p.open);
  },
};

/**
 * `trip:join`: resolves the voyage (an archived one is loaded first, WP-10), joins the rooms, resolves the role and
 * replays. Joins are limited per socket and per address, and wrong codes/ids per address (SEC-007: enumeration).
 */
async function join(c: Ctx, p: Raw): Promise<JoinAck> {
  const { helm, socket, data, ip, lim } = c;
  const want = { tripId: optStr(p.tripId), joinCode: optStr(p.joinCode, F.joinCode), memberToken: optStr(p.memberToken), deviceToken: optStr(p.deviceToken) };
  const miss: [RateLimiter, string][] = [[lim.joinMissIp, ip]];
  if (anyBlocked(miss)) throw slow("Too many wrong codes — wait a minute.");
  if (!lim.joinSocket.take(socket.id) || !lim.joinIp.take(ip)) throw slow("Too many joins — wait a minute.");
  // L3-005: a join naming no voyage is a bad request (not a miss, and never a LOADING that no retry can end)
  if (!want.tripId && !want.joinCode) throw badInput();
  // WP-10: an archived (or swept) voyage is loaded first, so a join never answers 503 LOADING; any failure is a miss
  const trip = await countFailures(miss, async () => {
    const q = want.tripId ? { tripId: want.tripId } : { joinCode: want.joinCode ?? "" };
    return (await helm.hydrate(q).catch(() => undefined)) ?? (want.tripId ? helm.trip(want.tripId) : helm.tripByCode(want.joinCode ?? ""));
  }, () => true);
  setScopeTrip(trip._id);
  for (const room of socket.rooms) if (room !== socket.id) socket.leave(room);
  Object.assign(data, { tripId: trip._id, surface: asSurface(p.surface), memberId: undefined, deviceToken: undefined });
  const m = helm.memberByToken(trip._id, want.memberToken);
  let as: JoinRole = "spectator";
  let rejected: JoinAck["tokenRejected"];
  if (m) {
    data.memberId = m._id;
    socket.join(memberRoom(m._id));
    as = "member";
  } else if (helm.deviceOk(trip._id, want.deviceToken)) {
    data.deviceToken = want.deviceToken;
    as = "device";
  } else if (want.memberToken) {
    rejected = "member";
  } else if (want.deviceToken && trip.status !== "BOOKED") {
    // R2-WP-07 / L3-001: a replaced, unpaired or expired headset is told so (once BOOKED it just watches)
    rejected = "device";
  }
  socket.join(tripRoom(trip._id));
  // L3-001: a credential that was sent but not accepted still joins as a spectator, but the caller is told first
  if (rejected) {
    const code: JoinRefusalCode = rejected === "member" ? "TOKEN_REJECTED" : "DEVICE_EXPIRED";
    socket.emit("error", { code, message: JOIN_REFUSAL[code], event: "trip:join" });
  }
  // L3-002: ack once the rooms are joined and the replay proper is sent; a slow memory recall's second
  // `brief:private` follows the ack, so the phone's queued actions aren't held back by it
  const { later } = await helm.replayNow(trip, (ev, payload) => emitTyped(socket, ev, payload), m?._id);
  void later.catch((e) => console.warn("[io] memory follow-up failed", (e as Error).message));
  return { ok: true, as, ...(rejected ? { tokenRejected: rejected } : {}) } satisfies JoinAck;
}

export function attachRealtime(http: HttpServer, helm: TripService) {
  // OPT-062: the server is typed against the shared contract (packages/shared/src/events.ts)
  const io = new Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>(http, { path: "/socket.io", maxHttpBufferSize: LIMITS.socket.maxMessageBytes,
    // SEC-026: only the page's own origin, PUBLIC_BASE_URL / CORS_ORIGINS (and dev hosts outside production)
    cors: { origin: (o, cb) => cb(null, originAllowed(o)) },
    allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin, req.headers.host)),
  });

  const lim = socketLimiters();
  io.use((socket, next) => {
    const ip = clientIp(socket.handshake.address, socket.handshake.headers["x-forwarded-for"]);
    if (!lim.connect.take(ip) || !lim.sockets.enter(ip)) return next(new Error("SLOW_DOWN"));
    socket.data.ip = ip;
    socket.once("disconnect", () => lim.sockets.leave(ip));
    next();
  });

  helm.attachBus({
    trip: (tripId, event, payload) => emitTyped(io.to(tripRoom(tripId)), event, payload),
    member: (memberId, event, payload) => emitTyped(io.to(memberRoom(memberId)), event, payload),
    // TR4-001: a member removed by "sail without them" stays a spectator of the trip room, but loses its member
    // room and identity, so it gets no more private events and can't act as that member
    // O2-045: only that member's room is visited (a member's sockets are in it: set with memberId), not every socket
    evict: (memberId) => {
      const ns = io.of("/");
      const room = memberRoom(memberId);
      for (const id of [...(ns.adapter.rooms.get(room) ?? [])]) {
        const s = ns.sockets.get(id);
        if (!s) continue;
        if (s.data.memberId === memberId) s.data.memberId = undefined;
        void s.leave(room);
      }
    },
  });

  io.on("connection", (socket) => onConnection(socket, helm, lim));
  return io;
}

function onConnection(socket: HelmSocket, helm: TripService, lim: Limiters) {
  const data = socket.data;
  // per-socket event budget (all events), and client:log's own smaller one (SEC-014)
  const events = new RateLimiter(LIMITS.socket.events, LIMITS.socket.eventsWindowMs, 1);
  const logs = new RateLimiter(LIMITS.socket.logsPerSecond, 1_000, 1);
  const ctx: Ctx = {
    helm, socket, data, ip: data.ip ?? "?", lim,
    tripId: () => {
      if (!data.tripId) throw new HelmError("NOT_JOINED", "Join the voyage first.");
      return data.tripId;
    },
    memberId: () => {
      ctx.tripId();
      if (!data.memberId) throw new HelmError("NOT_MEMBER", "Only crew members can do that.");
      return data.memberId;
    },
    actor: () => ({ memberId: data.memberId, deviceToken: data.deviceToken }),
  };

  /**
   * Every handler runs in its voyage's spend scope, so paid calls it causes count against that voyage (SEC-005).
   * TR3-007: the ack (if the client sent one) is answered exactly once — `{ok:true}` also for an action that changed
   * nothing — and a refusal is also sent as a caller-only `error` naming the event that caused it. `trip:join`
   * answers with a JoinAck (the role it resolved, R2-WP-07); every other event with a plain `{ok:true}`.
   */
  const guard = (event: keyof ClientToServer, fn: (p: Raw) => unknown, budget = true) => async (raw: unknown, ack?: unknown) => {
    const reply = typeof ack === "function" ? (ack as AckFn) : undefined;
    try {
      if (budget && !events.take("s")) throw slow("Easy there — too many actions at once.");
      const out = await withTrip(data.tripId, () => fn(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Raw) : {}));
      reply?.(event === "trip:join" && out && typeof out === "object" ? (out as JoinAck) : { ok: true });
    } catch (e) {
      if (!(e instanceof HelmError)) console.error("[io]", event, e);
      const err: ErrorPayload = e instanceof HelmError ? { code: e.code, message: e.message, event } : { code: "INTERNAL", message: INTERNAL_MESSAGE, event };
      socket.emit("error", err);
      reply?.({ ok: false, code: err.code, message: err.message });
    }
  };
  const on = (event: keyof ClientToServer, handler: (raw: unknown, ack?: unknown) => unknown) =>
    (socket.on as (ev: string, h: (raw: unknown, ack?: unknown) => unknown) => void)(event, handler);

  on("trip:join", guard("trip:join", (p) => join(ctx, p)));
  for (const [event, fn] of Object.entries(HANDLERS) as [keyof typeof HANDLERS, (c: Ctx, p: Raw) => unknown][]) {
    on(event, guard(event, (p) => fn(ctx, p)));
  }
  // SEC-014 / OPT-030: only an authenticated socket (a member, or the paired headset) may write debug lines,
  // at most 5 a second; the service whitelists the level and caps every field
  // L3-004: fire and forget — a trailing ack function is ignored, never answered (the contract says so)
  const clientLog = guard("client:log", (p) => {
    if (!data.tripId) return;
    if (!data.memberId && !helm.deviceOk(data.tripId, data.deviceToken)) return;
    if (!logs.take("s")) return;
    helm.clientLog(data.tripId, data.surface, p.level, p.msg);
  }, false);
  on("client:log", (raw: unknown) => void clientLog(raw));
  // L3-004: an event outside the contract (a mistyped or old client) gets its ack answered, never left hanging
  socket.onAny((event: string, ...args: unknown[]) => {
    if (KNOWN_EVENTS.has(event)) return;
    const ack = args[args.length - 1];
    if (typeof ack === "function") (ack as AckFn)({ ok: false, code: UNKNOWN_EVENT, message: "The helm doesn't know that request." });
  });
}
