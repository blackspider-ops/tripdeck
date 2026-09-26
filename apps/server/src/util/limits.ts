/**
 * Abuse limits & resource bounds (WP-07; docs/04 §12 "Limits").
 *   - Lru / RateLimiter / Concurrency: one shared, bounded implementation for every limiter (SEC-007, OPT-023).
 *   - clientIp: the caller's address with exactly `trustProxyHops` trusted proxies, the same rule Express uses for
 *     `req.ip`, so a spoofed X-Forwarded-For can't pick a fresh address per request (TR3-015).
 *   - spend: per-voyage and global daily budgets for the paid APIs (SEC-005). Over budget → the caller takes the
 *     no-key fallback (template lines, captions, local memory, "type your hail"). R2-WP-12: the counters are stored
 *     (L5-011) and part of each daily budget is held back for voyages past the table (S2-014).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.js";
import { dbConnected, loadWhere, persist, type SpendDoc } from "../store/db.js";
import { HelmError } from "./errors.js";
import { MAX_CREW } from "@all-ayes/shared";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * O2-032: the helm's fixed per-address / per-socket limits and field caps in one place (the env-tunable ones are
 * `config.limits`; text caps the phones mirror are in @all-ayes/shared). Rates are "hits per window" and scale with
 * RATE_LIMIT_SCALE like every RateLimiter.
 */
export const LIMITS = {
  /** REST (api/routes.ts, passkeyRoutes.ts), per client address unless noted. */
  http: {
    jsonBody: "32kb",
    /** joinPerMinute: a full crew (MAX_CREW 12: 11 joins) on one venue Wi-Fi fits well inside a minute's budget. */
    createPerMinute: 10, lookupPerMinute: 60, lookupMissPerMinute: 20, joinPerMinute: 30,
    claimFailPerMinute: 10, handoffFailPerMinute: 10, pairFailPerMinute: 10, passkeyPerMinute: 30,
    /** TR3-014 / SEC-005: spoken hails per member: 2 per 5 s and 6 per minute; 2 uploads in flight per address. */
    hailBurst: 2, hailBurstWindowMs: 5_000, hailPerMinute: 6, uploadsInFlight: 2,
    /** L5-011: how long the hail-audio gate waits for the stored spend counters before going on. */
    spendLoadWaitMs: 2_000,
    /** Cache-Control max-age of a turn's voice (content-addressed, never changes). */
    audioMaxAgeS: 86_400,
  },
  /** Socket.io (realtime/io.ts). */
  socket: {
    /** One message ≤ 64 kB (socket.io's default is 1 MB): nothing the clients send comes close. */
    maxMessageBytes: 64_000,
    connectPerMinute: 120, socketsPerAddress: 64,
    /** joinPerMinute: 12 phones + the Gallery + a headset (14 sockets) can each rejoin ~4× a minute from one address. */
    joinPerMinute: 60, joinMissPerMinute: 20, joinPerSocketPerMinute: 10,
    /** Per socket: 60 events per 10 s, and client:log's own 5 a second (SEC-014). */
    events: 60, eventsWindowMs: 10_000, logsPerSecond: 5,
  },
  /**
   * SEC-020: the longest field a socket payload may carry before the handler refuses it as BAD_INPUT (the service then
   * cleans and cuts it to its real cap, e.g. NOTE_MAX_CHARS / HAIL_MAX_CHARS).
   */
  fields: { id: 200, joinCode: 40, text: 2_000, listItems: 16, listItem: 64, memberIds: MAX_CREW },
  /** Dev routes (api/devAccess.ts): the sign-in cookie's life and wrong keys per address per minute. */
  dev: { sessionMs: HOUR_MS, loginFailPerMinute: 10 },
  /** SEC-015 (index.ts): how often idle voyages are swept from memory, and the voice cache is pruned. */
  sweepIntervalMs: 15 * MINUTE_MS,
  audioPruneIntervalMs: HOUR_MS,
  /** Keys a RateLimiter remembers (an LRU), and voyages whose paid-call counters stay in memory. */
  limiterKeys: 10_000,
  spendLedgers: 5_000,
} as const;

// ---------- bounded LRU map ----------
/** A Map that forgets its least recently used entries past `max` (limiter state, per-voyage counters, …). */
export class Lru<K, V> {
  private m = new Map<K, V>();
  constructor(readonly max: number) {}
  get size() { return this.m.size; }
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  peek(k: K) { return this.m.get(k); }
  has(k: K) { return this.m.has(k); }
  set(k: K, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
    return this;
  }
  delete(k: K) { return this.m.delete(k); }
  clear() { this.m.clear(); }
  keys() { return this.m.keys(); }
  entries() { return this.m.entries(); }
}

// ---------- rate limits ----------
/** Limits scale with RATE_LIMIT_SCALE (tests/load rigs may relax them); RATE_LIMITS=off disables them. */
const scaled = (max: number) => (config.limits.rateLimitsOff ? Infinity : Math.max(1, Math.round(max * config.limits.rateScale)));

/** Sliding window: at most `max` hits per `windowMs` per key. State is an LRU, so it can't grow without bound. */
export class RateLimiter {
  readonly max: number;
  private hits: Lru<string, number[]>;
  constructor(max: number, readonly windowMs: number, maxKeys: number = LIMITS.limiterKeys) {
    this.max = scaled(max);
    this.hits = new Lru(maxKeys);
  }
  private live(key: string, now: number) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }
  /** Over the limit right now? (records nothing) */
  blocked(key: string, now = Date.now()) { return this.live(key, now).length >= this.max; }
  /** Records a hit and returns true, or returns false (and records nothing) when over the limit. */
  take(key: string, now = Date.now()) {
    const list = this.live(key, now);
    if (list.length >= this.max) return false;
    list.push(now);
    this.hits.set(key, list.length > this.max ? list.slice(-this.max) : list);
    return true;
  }
  /** Records a hit without checking (count failures only, then test with `blocked`). */
  note(key: string, now = Date.now()) {
    const list = this.live(key, now);
    list.push(now);
    this.hits.set(key, list.slice(-this.max));
  }
  /** ms until the next hit is allowed (0 = now). */
  retryAfterMs(key: string, now = Date.now()) {
    const list = this.live(key, now);
    return list.length < this.max ? 0 : Math.max(0, this.windowMs - (now - list[list.length - this.max]));
  }
  get keys() { return this.hits.size; }
}

/**
 * O2-014: limits that count only failures (wrong codes, unknown ids, bad invites). `anyBlocked` says whether one of
 * the (limiter, key) buckets is full; `countFailures` runs `fn` and, when it throws a counted error (by default a
 * caller-side refusal, status < 500), notes a hit in every bucket and rethrows.
 */
export type Bucket = [RateLimiter, string];
export const anyBlocked = (buckets: Bucket[]) => buckets.some(([l, k]) => l.blocked(k));
const clientRefusal = (e: unknown) => e instanceof HelmError && e.status < 500;
export async function countFailures<T>(buckets: Bucket[], fn: () => T | Promise<T>, counts: (e: unknown) => boolean = clientRefusal): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (counts(e)) for (const [l, k] of buckets) l.note(k);
    throw e;
  }
}

/** At most `max` in-flight operations per key (uploads per IP, sockets per IP). */
export class Concurrency {
  private n = new Map<string, number>();
  readonly max: number;
  constructor(max: number) { this.max = scaled(max); }
  enter(key: string) {
    const c = this.n.get(key) ?? 0;
    if (c >= this.max) return false;
    this.n.set(key, c + 1);
    return true;
  }
  leave(key: string) {
    const c = (this.n.get(key) ?? 1) - 1;
    if (c <= 0) this.n.delete(key); else this.n.set(key, c);
  }
}

/**
 * The client's address given the direct peer and X-Forwarded-For, trusting exactly `hops` proxies: the same address
 * Express picks for `req.ip` with `trust proxy = hops`. With 0 hops the header is ignored (bare host: not spoofable).
 */
export function clientIp(remote: string | undefined, xff: string | string[] | undefined, hops = config.limits.trustProxyHops) {
  const chain = [remote || "?"];
  if (hops > 0 && xff) {
    const list = (Array.isArray(xff) ? xff.join(",") : String(xff)).split(",").map((s) => s.trim()).filter(Boolean);
    chain.push(...list.reverse());
  }
  return normalizeIp(chain[Math.min(hops, chain.length - 1)]);
}
/**
 * IPv4 as is (an IPv4-mapped IPv6 address unwrapped). IPv6 is keyed on its /64: one subscriber is routinely handed a
 * whole /64, so keying on the full address would let a single client rotate through 2^64 "addresses" and walk past
 * every per-address limit (join-code enumeration, trip creation, wrong-code counters).
 */
function normalizeIp(raw: string): string {
  const ip = raw.trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail, extra] = ip.split("::");
  if (extra !== undefined) return ip; // not an address (two "::"); keep it whole
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length < 4 || !groups.slice(0, 4).every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

// ---------- spend caps (SEC-005) ----------
export type Paid = "gemini" | "tts" | "stt" | "backboard" | "routestack";
const PAID: Paid[] = ["gemini", "tts", "stt", "backboard", "routestack"];
type Counts = Record<Paid, number>;
const zero = (): Counts => ({ gemini: 0, tts: 0, stt: 0, backboard: 0, routestack: 0 });

/**
 * R2-WP-12 (L5-011 / S2-014): one set of counters and whether its stored value has been read. With MongoDB the
 * counters live in the `spend` collection: `day:<utcDay>` for the whole server, `trip:<tripId>` per voyage. They are
 * written only once the stored doc has been read and added in, so a restart (or a voyage's counters leaving the LRU)
 * carries on from the stored counts instead of starting from zero. Until the read lands, spending counts in memory
 * (a restart can let a few calls through, never a whole budget).
 */
interface Ledger { id: string; counts: Counts; loaded: boolean; loading?: Promise<void>; tripId?: string }
const ledger = (id: string, tripId?: string): Ledger => ({ id, counts: zero(), loaded: false, tripId });

const utcDay = () => new Date().toISOString().slice(0, 10);
let day = utcDay();
let daily = ledger(`day:${day}`);
const perTrip = new Lru<string, Ledger>(LIMITS.spendLedgers);
const warned = new Set<string>();

/** Reads a ledger's stored counts once (when MongoDB is up) and adds them to what was counted meanwhile. */
function load(l: Ledger): Promise<void> {
  if (l.loaded || !dbConnected()) return l.loading ?? Promise.resolve();
  l.loading ??= (async () => {
    try {
      const [doc] = await loadWhere<SpendDoc>("spend", { _id: l.id }, { limit: 1 });
      for (const k of PAID) l.counts[k] += Number((doc as Partial<Record<Paid, number>> | undefined)?.[k]) || 0;
      l.loaded = true;
      save(l);
    } catch (e) {
      console.warn(`[limits] spend counters ${l.id} not read yet:`, (e as Error).message);
    } finally {
      l.loading = undefined;
    }
  })();
  return l.loading;
}
/** Whole-doc upsert through the write queue (coalesced per doc; one writer holds the lease). */
function save(l: Ledger) {
  if (!l.loaded) return;
  persist("spend", { _id: l.id, ...l.counts, ...(l.tripId ? { tripId: l.tripId } : {}), updatedAt: new Date() });
}
function tripLedger(tripId: string): Ledger {
  let l = perTrip.get(tripId);
  if (!l) perTrip.set(tripId, (l = ledger(`trip:${tripId}`, tripId)));
  void load(l);
  return l;
}

/**
 * Reads the stored counters (today's, and the voyage's when given). spend() does this by itself in the background;
 * callers that can wait (boot, the hail-audio gate) await it so a restart can't let a single extra call through.
 */
export async function loadSpend(tripId?: string): Promise<void> {
  rollover();
  await Promise.all([load(daily), tripId ? load(tripLedger(tripId)) : undefined]);
}

/**
 * S2-014: which voyages may draw on the held-back part of the daily budgets (the reserve): the service registers
 * this (api/routes.ts: voyages past the table — Dry Run, sealing, booked). Voyages that aren't, and calls made
 * outside any voyage, stop at the daily cap minus the reserve.
 */
let priority: (tripId: string) => boolean = () => false;
export function setSpendPriority(fn: (tripId: string) => boolean) { priority = fn; }
/** The held-back part of a daily cap (SPEND_RESERVE_PCT, default 20 %). */
const reserveOf = (cap: number) => Math.floor((cap * Math.min(100, Math.max(0, config.limits.spendReservePct))) / 100);

/** The voyage a paid call is made for, carried through async work (socket handlers, the engine run, timers). */
const scope = new AsyncLocalStorage<{ tripId?: string }>();
export const withTrip = <T>(tripId: string | undefined, fn: () => T): T => scope.run({ tripId }, fn);
/** Sets the voyage for the current scope (trip:join resolves it mid-handler). */
export const setScopeTrip = (tripId: string) => { const s = scope.getStore(); if (s) s.tripId = tripId; };
const scopeTrip = () => scope.getStore()?.tripId;

function rollover() {
  const d = utcDay();
  if (d === day) { void load(daily); return; }
  day = d;
  daily = ledger(`day:${day}`);
  warned.clear();
  void load(daily);
}

/**
 * One paid call about to happen: counts it and returns true, or returns false when the global daily budget or the
 * voyage's budget for that provider is spent. A cap of 0 is a kill switch for that provider. S2-014: a voyage that
 * isn't past the table (and a call outside any voyage) stops where the reserve begins.
 */
export function spend(kind: Paid, tripId: string | undefined = scopeTrip()): boolean {
  rollover();
  const cap = config.limits.spend.daily[kind];
  const used = daily.counts[kind];
  if (used >= cap) return refuse(kind, "daily");
  if (used >= cap - reserveOf(cap) && !(tripId && safePriority(tripId))) return refuse(kind, "daily, outside the reserve");
  const t = tripId ? tripLedger(tripId) : undefined;
  if (t && t.counts[kind] >= config.limits.spend.trip[kind]) return refuse(kind, `voyage ${tripId}`);
  daily.counts[kind]++;
  save(daily);
  if (t) { t.counts[kind]++; save(t); }
  return true;
}
function safePriority(tripId: string) {
  try { return priority(tripId); } catch { return false; }
}
function refuse(kind: Paid, what: string) {
  const k = `${kind}|${what}`;
  if (!warned.has(k)) { warned.add(k); console.warn(`[limits] ${kind} budget (${what}) spent; using the no-key fallback`); }
  if (warned.size > 1000) warned.clear();
  return false;
}

/** Coarse flags for /api/health: never the counts themselves ("reserve" = only voyages past the table get calls). */
export function spendFlags(): Record<Paid, "ok" | "reserve" | "capped"> {
  rollover();
  const caps = config.limits.spend.daily;
  const flag = (k: Paid) => (daily.counts[k] >= caps[k] ? "capped" : daily.counts[k] >= caps[k] - reserveOf(caps[k]) ? "reserve" : "ok");
  return Object.fromEntries(PAID.map((k) => [k, flag(k)])) as Record<Paid, "ok" | "reserve" | "capped">;
}

/** Tests: forget all in-memory counters (like a restart; stored counters are read again on the next spend). */
export function resetSpend() {
  day = utcDay();
  daily = ledger(`day:${day}`);
  perTrip.clear();
  warned.clear();
}
