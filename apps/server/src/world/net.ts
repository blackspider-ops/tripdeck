/**
 * Outbound calls to the OpenStreetMap services (Nominatim, Overpass): one polite fetch (User-Agent + Referer, a
 * timeout) and a global throttle per service. Tests never reach the network: under vitest the default fetcher
 * refuses unless WORLD_LIVE=1, and tests install a mock with setWorldFetch().
 */
import { HelmError } from "../util/errors.js";
import { config } from "../config.js";

export const WORLD_USER_AGENT = "AllAyes/1.0 (hackathon demo)";
export const WORLD_REFERER = () => config.publicBaseUrl || "https://github.com/all-ayes";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const underTest = () => Boolean(process.env.VITEST) && process.env.WORLD_LIVE !== "1";
const defaultFetch: Fetcher = (url, init) => {
  if (underTest()) return Promise.reject(new Error(`[world] no real network in tests (${new URL(url).host}); use setWorldFetch`));
  return fetch(url, init);
};
let fetcher: Fetcher = defaultFetch;
/** Tests (and the live smoke): replace the fetcher; `null` restores the default. */
export function setWorldFetch(f: Fetcher | null) { fetcher = f ?? defaultFetch; }

/** A service answered "busy" (429/503/504), timed out, or couldn't be reached: the caller shows LOADING + retry. */
export class UpstreamBusy extends Error {
  constructor(readonly service: string, readonly retryAfterS: number, detail: string) { super(`${service}: ${detail}`); }
}

/** GET/POST with the polite headers and a timeout. Non-2xx → UpstreamBusy (busy codes) or Error. */
export async function politeFetch(service: string, url: string, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetcher(url, {
      ...init,
      signal: ctl.signal,
      headers: { "User-Agent": WORLD_USER_AGENT, Referer: WORLD_REFERER(), Accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (e) {
    throw new UpstreamBusy(service, 30, ctl.signal.aborted ? "timed out" : (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 || res.status === 503 || res.status === 504 || res.status === 502) {
    const ra = Number(res.headers.get("retry-after"));
    throw new UpstreamBusy(service, Number.isFinite(ra) && ra > 0 ? Math.min(300, ra) : 60, `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`[world] ${service} answered HTTP ${res.status}`);
  return res;
}

/** UpstreamBusy → the caller's 503 LOADING (with retryAfterS on the error for a Retry-After header). */
export function busyError(e: UpstreamBusy, what: string): HelmError & { retryAfterS: number } {
  const err = new HelmError("LOADING", `${what} is busy right now — try again in a minute.`) as HelmError & { retryAfterS: number };
  err.retryAfterS = e.retryAfterS;
  return err;
}

/**
 * At most one call starts per `intervalMs` (Nominatim's policy: an absolute maximum of 1 request per second), in
 * arrival order, and at most `maxQueue` wait: past that the call is refused at once (never an unbounded backlog).
 */
export class Throttle {
  private next = 0;
  private queued = 0;
  constructor(
    /** Mutable for tests only (the spacing itself is tested on a fresh Throttle). */
    public intervalMs: number,
    readonly maxQueue = 20,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  get waiting() { return this.queued; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.queued >= this.maxQueue) throw new UpstreamBusy("throttle", 5, "too many waiting");
    const t = this.now();
    const at = Math.max(t, this.next);
    this.next = at + this.intervalMs;
    this.queued++;
    try {
      if (at > t) await this.sleep(at - t);
    } finally {
      this.queued--;
    }
    return fn();
  }
}
