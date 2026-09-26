/**
 * RouteStack.ai HTTP client (docs/12-routestack.md): partner-token auth with HMAC, token cache, 401 retry, per-call
 * timeouts, and a query cache (memory + DATA_DIR/routestack) so the same billable search is never paid for twice.
 *
 * Auth (RouteStack EXTERNAL_MCP_INTEGRATION.md §1):
 *   hmac = base64url(HMAC_SHA256(apiSecret, `${apiKey}:${timestamp}:${nonce}`)), timestamp in unix seconds (±5 min)
 *   POST {BASE}/mcp/auth/partner-token {apiKey, hmac, timestamp, nonce} → {token, expiresIn: "24h"}
 *   then every /mcp/{hotel,flight,car}/* call carries `Authorization: Bearer <token>` (no other auth headers).
 * There is no refresh endpoint: mint again before expiry (we do it 5 min early) or after a 401 (retry once).
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config.js";
import { Lru, spend } from "../../util/limits.js";

export const TOKEN_REFRESH_EARLY_MS = 5 * 60_000;
/** Used when the token response carries neither a JWT `exp` nor a readable `expiresIn`. */
const DEFAULT_TOKEN_LIFE_MS = 60 * 60_000;

export type RouteStackErrorCode =
  | "NOT_CONFIGURED" | "AUTH_FAILED" | "UNAUTHORIZED" | "QUOTA_EXCEEDED" | "RATE_LIMITED" | "TIMEOUT"
  | "HTTP_ERROR" | "NETWORK" | "BAD_RESPONSE" | "TOOL_ERROR" | "CAP_REACHED" | "COOLDOWN" | "BAD_INPUT";

export class RouteStackError extends Error {
  constructor(readonly code: RouteStackErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "RouteStackError";
  }
}

/** The documented signature: base64url HMAC-SHA256 of `apiKey:timestamp:nonce` under the partner secret. */
export function signPartnerHmac(apiKey: string, apiSecret: string, timestamp: number, nonce: string): string {
  return createHmac("sha256", apiSecret).update(`${apiKey}:${timestamp}:${nonce}`).digest("base64url");
}

/** "24h" / "30m" / "3600s" / "3600" / 3600 → ms; anything else → null. */
export function parseExpiresIn(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v * 1000;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!m) return null;
  const unit = { "": 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "" | "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

/** The JWT's `exp` (unix seconds) as epoch ms, without verifying it (we only need to know when to re-mint). */
export function jwtExpiryMs(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const exp = (JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface ClientOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  /** General calls (token, destinations, flight session). */
  timeoutMs: number;
  /** Billable searches. */
  searchTimeoutMs: number;
  now?: () => number;
}

export interface CallOptions {
  /** Billable search: uses the search timeout and is never retried after a timeout (a retry would bill again). */
  billable?: boolean;
  timeoutMs?: number;
}

export class RouteStackClient {
  private token: { value: string; expiresAt: number } | null = null;
  private minting: Promise<string> | null = null;
  private readonly now: () => number;
  /** Diagnostics for routestackStatus(): counts only, never payloads or secrets. */
  readonly stats = { tokenMints: 0, calls: 0, billableCalls: 0 };

  constructor(readonly opts: ClientOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** A valid bearer token: cached until 5 minutes before it expires; concurrent callers share one mint. */
  async bearer(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.token.expiresAt - TOKEN_REFRESH_EARLY_MS) return this.token.value;
    if (force) this.token = null;
    this.minting ??= this.mint().finally(() => { this.minting = null; });
    return this.minting;
  }

  private async mint(): Promise<string> {
    const { apiKey, apiSecret, baseUrl } = this.opts;
    const timestamp = Math.floor(this.now() / 1000);
    const nonce = randomUUID();
    const hmac = signPartnerHmac(apiKey, apiSecret, timestamp, nonce);
    const res = await this.fetchJson(`${baseUrl}/mcp/auth/partner-token`, { apiKey, hmac, timestamp, nonce }, undefined, this.opts.timeoutMs);
    if (!res.ok) throw new RouteStackError(res.status === 401 || res.status === 403 ? "AUTH_FAILED" : codeFor(res.status), `partner-token HTTP ${res.status}`, res.status);
    const body = (res.body ?? {}) as Record<string, unknown>;
    const value = [body.token, body.partnerToken, body.accessToken].find((t): t is string => typeof t === "string" && t.length > 0);
    if (!value) throw new RouteStackError("BAD_RESPONSE", "partner-token response has no token");
    const now = this.now();
    const expiresAt = jwtExpiryMs(value) ?? (parseExpiresIn(body.expiresIn) !== null ? now + (parseExpiresIn(body.expiresIn) as number) : now + DEFAULT_TOKEN_LIFE_MS);
    this.token = { value, expiresAt };
    this.stats.tokenMints++;
    return value;
  }

  /**
   * POST {baseUrl}{path} with the bearer token. A 401 mints a fresh token and retries once; a timeout is never
   * retried. Returns the parsed JSON body; throws RouteStackError otherwise.
   */
  async post<T = unknown>(path: string, body: unknown, opts: CallOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? (opts.billable ? this.opts.searchTimeoutMs : this.opts.timeoutMs);
    const url = `${this.opts.baseUrl}${path}`;
    let token = await this.bearer();
    for (let attempt = 0; ; attempt++) {
      this.stats.calls++;
      if (opts.billable) this.stats.billableCalls++;
      const res = await this.fetchJson(url, body, token, timeoutMs);
      if (res.status === 401 && attempt === 0) {
        token = await this.bearer(true);
        continue;
      }
      if (!res.ok) throw new RouteStackError(res.status === 401 ? "UNAUTHORIZED" : codeFor(res.status), `${path} HTTP ${res.status}`, res.status);
      return res.body as T;
    }
  }

  private async fetchJson(url: string, body: unknown, token: string | undefined, timeoutMs: number): Promise<{ ok: boolean; status: number; body: unknown }> {
    const ctl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); reject(new RouteStackError("TIMEOUT", `no answer within ${timeoutMs} ms`)); }, timeoutMs);
    });
    try {
      const run = (async () => {
        const res = await globalThis.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body ?? {}),
          signal: ctl.signal,
        });
        const text = await res.text();
        let parsed: unknown = null;
        if (text) {
          try { parsed = JSON.parse(text); } catch { if (res.ok) throw new RouteStackError("BAD_RESPONSE", "response is not JSON", res.status); }
        }
        return { ok: res.ok, status: res.status, body: parsed };
      })();
      run.catch(() => undefined); // a late rejection after the timeout won the race must not go unhandled
      return await Promise.race([run, timeout]);
    } catch (e) {
      if (e instanceof RouteStackError) throw e;
      if (ctl.signal.aborted) throw new RouteStackError("TIMEOUT", `no answer within ${timeoutMs} ms`);
      throw new RouteStackError("NETWORK", (e as Error)?.message ?? "network error");
    } finally {
      clearTimeout(timer);
    }
  }
}

function codeFor(status: number): RouteStackErrorCode {
  if (status === 402) return "QUOTA_EXCEEDED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 401) return "UNAUTHORIZED";
  return "HTTP_ERROR";
}

// ---------- the configured client ----------
let shared: { key: string; client: RouteStackClient } | null = null;

/** The client for the current config (rebuilt when keys / base URL change), or null when RouteStack is off. */
export function configuredClient(): RouteStackClient | null {
  const rs = config.routestack;
  if (rs.mode() === "off") return null;
  const opts: ClientOptions = { apiKey: rs.apiKey(), apiSecret: rs.apiSecret(), baseUrl: rs.baseUrl(), timeoutMs: rs.timeoutMs(), searchTimeoutMs: rs.searchTimeoutMs() };
  const key = [opts.baseUrl, opts.apiKey, createHash("sha256").update(opts.apiSecret).digest("hex").slice(0, 12), opts.timeoutMs, opts.searchTimeoutMs].join("|");
  if (shared?.key !== key) shared = { key, client: new RouteStackClient(opts) };
  return shared.client;
}

// ---------- query cache ----------
/**
 * Answers for the same query (same endpoint + normalized body + base URL) within the TTL come from memory, then from
 * DATA_DIR/routestack/<sha256>.json (survives restarts), so a repeated search never bills twice. Concurrent identical
 * queries share one in-flight call. Failures are not cached.
 */
interface Entry { savedAt: number; value: unknown }
const memory = new Lru<string, Entry>(500);
const inflight = new Map<string, Promise<unknown>>();
export const cacheStats = { hits: 0, misses: 0 };

const cacheDir = () => join(config.dataDir, "routestack");
export const cacheKey = (parts: unknown) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function readDisk(key: string): Entry | null {
  try {
    const e = JSON.parse(readFileSync(join(cacheDir(), `${key}.json`), "utf8")) as Entry;
    return typeof e?.savedAt === "number" ? e : null;
  } catch {
    return null;
  }
}
function writeDisk(key: string, e: Entry) {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const file = join(cacheDir(), `${key}.json`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(e));
    renameSync(tmp, file);
  } catch (err) {
    console.warn("[routestack] cache write failed:", (err as Error).message);
  }
}

/** The cached value for `key` if younger than `ttlMs`, else runs `fn` once (shared by concurrent callers) and stores it. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, now = Date.now()): Promise<T> {
  const fresh = (e: Entry | null | undefined): e is Entry => Boolean(e) && now - (e as Entry).savedAt < ttlMs;
  const m = memory.get(key);
  if (fresh(m)) { cacheStats.hits++; return m.value as T; }
  const d = readDisk(key);
  if (fresh(d)) { memory.set(key, d); cacheStats.hits++; return d.value as T; }
  const running = inflight.get(key);
  if (running) { cacheStats.hits++; return running as Promise<T>; }
  cacheStats.misses++;
  const p = (async () => {
    const value = await fn();
    const e = { savedAt: Date.now(), value };
    memory.set(key, e);
    writeDisk(key, e);
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------- billable searches ----------
/**
 * A timed-out billable search was very likely billed upstream anyway: the same query is not sent again for this long
 * (callers get null and use curated/modelled data), so a slow gateway can't drain the budget with retries.
 */
export const TIMEOUT_COOLDOWN_MS = 10 * 60_000;
const cooldown = new Lru<string, number>(500);

/** One billable search: refused during a timeout cooldown or when the spend cap says no; counts one unit otherwise. */
export async function billable<T>(key: string, tripId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const t = cooldown.get(key);
  if (t !== undefined && Date.now() - t < TIMEOUT_COOLDOWN_MS) throw new RouteStackError("COOLDOWN", "the same search timed out a moment ago");
  if (!spend("routestack", tripId)) throw new RouteStackError("CAP_REACHED", "RouteStack search budget spent");
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RouteStackError && e.code === "TIMEOUT") cooldown.set(key, Date.now());
    throw e;
  }
}

// ---------- outcome log for routestackStatus() ----------
export const outcomes = { lastOkAt: 0, lastError: null as null | { code: RouteStackErrorCode | "ERROR"; at: number; what: string } };

/**
 * Runs a provider call and never throws: any failure (not configured, timeout, cap, HTTP error, odd payload) is
 * logged once as a code (no payloads, no secrets) and becomes null, so callers fall back to curated/modelled data.
 */
export async function guard<T>(what: string, fn: () => Promise<T | null>): Promise<T | null> {
  try {
    const v = await fn();
    if (v !== null) outcomes.lastOkAt = Date.now();
    return v;
  } catch (e) {
    const code = e instanceof RouteStackError ? e.code : "ERROR";
    outcomes.lastError = { code, at: Date.now(), what };
    console.warn(`[routestack] ${what}: ${code}${e instanceof RouteStackError && e.status ? ` (HTTP ${e.status})` : ""}; using the fallback`);
    return null;
  }
}

/** Tests: forget the client, the memory cache and the counters (disk entries stay; tests use a private DATA_DIR). */
export function resetRouteStackClient() {
  shared = null;
  memory.clear();
  inflight.clear();
  cooldown.clear();
  outcomes.lastOkAt = 0;
  outcomes.lastError = null;
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}
