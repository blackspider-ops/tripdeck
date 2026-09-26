import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Minimal .env loader (repo root or apps/server). Real env vars win.
for (const p of ["../../../.env", "../../.env", "../.env"]) {
  const file = fileURLToPath(new URL(p, import.meta.url));
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    // `KEY=   # comment` is empty (not "# comment"); a quoted value keeps what's inside the quotes
    const q = m[2].match(/^(["'])(.*?)\1/);
    process.env[m[1]] = q ? q[2] : m[2].replace(/(^|\s+)#.*$/, "").trim();
  }
}

/** A blank line in .env (`ELEVEN_VOICE_BAND1=`) means "use the default", same as leaving it out. */
const env = (k: string, d = "") => process.env[k]?.trim() || d;
const num = (k: string, d: number) => { const raw = env(k); const v = Number(raw); return raw !== "" && Number.isFinite(v) && v >= 0 ? v : d; };
const bool = (k: string, d = false) => { const raw = env(k); return raw ? /^(1|true|yes)$/i.test(raw) : d; };
/** A positive number from the env, or `d` (the lazily read keys below). */
const positive = (k: string, d: number) => { const raw = env(k); const v = Number(raw); return raw !== "" && Number.isFinite(v) && v > 0 ? v : d; };
let perProcessPairingSecret: string | null = null;
/**
 * OPT-061: one of a fixed set of values (case-insensitive), else the default — with a warning, so a typo such as
 * AGENT_DECISIONS=modle doesn't silently mean something else.
 */
export function oneOf<T extends string>(k: string, allowed: readonly T[], d: T, e: NodeJS.ProcessEnv = process.env): T {
  const raw = (e[k] ?? "").trim();
  if (!raw) return d;
  const hit = allowed.find((a) => a.toLowerCase() === raw.toLowerCase());
  if (!hit) console.warn(`[config] ${k}=${raw} is not one of ${allowed.join(", ")}; using ${d}`);
  return hit ?? d;
}

/**
 * SEC-013 / OPT-073: one notion of "production", fail closed. Production if NODE_ENV or APP_ENV says so, or if
 * PUBLIC_BASE_URL names a real (non-localhost) host — unless APP_ENV=development explicitly says otherwise (a dev
 * tunnel). Dev conveniences (demo seeding and /api/debug without the key) need an explicit dev signal on top:
 * APP_ENV=development, `npm run dev`, or the test runner. Anything else (e.g. a bare `npm start`) is neither: dev
 * routes need DEV_KEY, but production-only extras (HSTS, startup checks) stay off.
 */
export function resolveMode(e: NodeJS.ProcessEnv) {
  const v = (k: string) => (e[k] ?? "").trim().toLowerCase();
  const origin = originOf(e.PUBLIC_BASE_URL);
  const host = origin ? new URL(origin).hostname : "";
  const local = !host || host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" || host === "0.0.0.0";
  const production = v("NODE_ENV") === "production" || v("APP_ENV") === "production" || (!local && v("APP_ENV") !== "development");
  const dev = !production && (v("APP_ENV") === "development" || v("NODE_ENV") === "test" || Boolean(e.VITEST) || e.npm_lifecycle_event === "dev");
  return { production, dev, publicBaseUrl: origin };
}

/** "https://allayes.tech/x" → "https://allayes.tech"; anything that isn't an http(s) URL → "". */
export function originOf(u: string | undefined): string {
  try { const url = new URL((u ?? "").trim()); return /^https?:$/.test(url.protocol) ? url.origin : ""; } catch { return ""; }
}

const mode = resolveMode(process.env);
// Libraries and older call sites (express, passkeys.ts) read NODE_ENV: make them agree with the derived mode.
if (mode.production) process.env.NODE_ENV = "production";

export const config = {
  port: num("PORT", 8787),
  /** OPT-006: the public origin (normalized): CSP/socket origins, the production switch, passkeys' default origin. */
  publicBaseUrl: mode.publicBaseUrl,
  production: mode.production,
  /** SEC-013: dev conveniences without DEV_KEY (never in production). */
  devMode: mode.dev,
  devKey: env("DEV_KEY", ""),
  /** SEC-026: extra browser origins allowed to open a socket (comma-separated), besides the page's own origin. */
  corsOrigins: env("CORS_ORIGINS").split(",").map(originOf).filter(Boolean),
  /** TR3-017: the helm serves the built web app only in production or with SERVE_WEB=1 (dev uses Vite on :5173). */
  serveWeb: mode.production || bool("SERVE_WEB"),
  mongoUri: env("MONGODB_URI"),
  mongoDb: env("MONGODB_DB", "all_ayes"),
  gemini: { apiKey: env("GEMINI_API_KEY"), model: env("GEMINI_MODEL", "gemini-2.5-flash") },
  agentDecisions: oneOf("AGENT_DECISIONS", ["rules", "model"] as const, "rules"),
  eleven: {
    apiKey: env("ELEVENLABS_API_KEY"),
    model: env("ELEVEN_MODEL", "eleven_flash_v2_5"),
    sttModel: env("ELEVEN_STT_MODEL", "scribe_v1"),
    // Default voices every account has, free plan included (free plans get 402 on library voices via the API).
    // Captain George (British storyteller); mates Liam, Sarah, Chris, Jessica (bands 1–4), then Roger, Laura, Charlie,
    // Alice, Will, Matilda, Eric, Lily (bands 5–12): one distinct premade voice per band. Override with your picks
    // (ELEVEN_VOICE_BAND1…12, doc 05 §8).
    voices: {
      captain: env("ELEVEN_VOICE_CAPTAIN", "JBFqnCBsd6RMkjVDRZzb"),
      1: env("ELEVEN_VOICE_BAND1", "TX3LPaxmHKxFdv7VOQHJ"),
      2: env("ELEVEN_VOICE_BAND2", "EXAVITQu4vr4xnSDxMaL"),
      3: env("ELEVEN_VOICE_BAND3", "iP95p4xoKVk53GoZ742B"),
      4: env("ELEVEN_VOICE_BAND4", "cgSgspJ2msm6clMCkdW9"),
      5: env("ELEVEN_VOICE_BAND5", "CwhRBWXzGAHq8TQ4Fs17"),
      6: env("ELEVEN_VOICE_BAND6", "FGY2WhTYpPnrIDTdsKH5"),
      7: env("ELEVEN_VOICE_BAND7", "IKne3meq5aSn9XLyUdCD"),
      8: env("ELEVEN_VOICE_BAND8", "Xb7hH8MSUJpSbSDYk0k2"),
      9: env("ELEVEN_VOICE_BAND9", "bIHbv24MWmeRgasZH58o"),
      10: env("ELEVEN_VOICE_BAND10", "XrExE9yKIg1WjnnlVkGX"),
      11: env("ELEVEN_VOICE_BAND11", "cjVigY5qzO86Huf0OWal"),
      12: env("ELEVEN_VOICE_BAND12", "pFZP5JQG7iQjIQuC4Bku"),
    } as Record<string, string>,
  },
  backboard: { apiKey: env("BACKBOARD_API_KEY"), baseUrl: env("BACKBOARD_BASE_URL") },
  /**
   * RouteStack.ai live inventory (providers/routestack, docs/12-routestack.md). Read at call time so tests can switch
   * them. ROUTESTACK_MODE: off | sandbox | live; unset = sandbox when both keys are present, else off. The base URL
   * defaults to the sandbox gateway (production when the mode is live). Billable searches count against
   * ROUTESTACK_DAILY_CAP / ROUTESTACK_TRIP_CAP (limits.spend below).
   */
  routestack: {
    apiKey: () => env("ROUTESTACK_API_KEY"),
    apiSecret: () => env("ROUTESTACK_API_SECRET"),
    accountId: () => env("ROUTESTACK_ACCOUNT_ID"),
    mode: (): "off" | "sandbox" | "live" => {
      const keys = Boolean(env("ROUTESTACK_API_KEY") && env("ROUTESTACK_API_SECRET"));
      const m = oneOf("ROUTESTACK_MODE", ["off", "sandbox", "live"] as const, keys ? "sandbox" : "off");
      return keys ? m : "off";
    },
    baseUrl: () => env("ROUTESTACK_BASE_URL", env("ROUTESTACK_MODE").toLowerCase() === "live" ? "https://mcp.routestack.ai" : "https://evolvemcp.routestack.ai").replace(/\/+$/, ""),
    /** Billable searches (hotel/flight): our UX waits at most this long (RouteStack's own default is 180 s). */
    searchTimeoutMs: () => positive("ROUTESTACK_SEARCH_TIMEOUT_MS", 90_000),
    /** Everything else (token, destinations, flight session). */
    timeoutMs: () => positive("ROUTESTACK_TIMEOUT_MS", 30_000),
    /** The same query within this window is answered from the cache (memory + DATA_DIR/routestack), never billed twice. */
    cacheTtlMs: () => positive("ROUTESTACK_CACHE_HOURS", 6) * 3_600_000,
    /**
     * A voyage's background prefetch (trips/live.ts) sends at most this many billable searches (and never more than
     * ROUTESTACK_TRIP_CAP): whole port × window sets, in the order the chart book ranks them.
     */
    prefetchMax: () => positive("ROUTESTACK_PREFETCH_MAX", 12),
  },
  payments: {
    mode: oneOf("PAYMENTS_MODE", ["sim", "visa_sandbox"] as const, "sim"),
    simDeclineMember: env("SIM_DECLINE_MEMBER"),
    simTimeoutMember: env("SIM_TIMEOUT_MEMBER"),
    /** OPT-009: Visa Intelligent Commerce sandbox credentials (both needed). Read at call time. */
    visa: () => ({ apiBase: env("VISA_VIC_API_BASE"), apiKey: env("VISA_VIC_API_KEY") }),
  },
  /**
   * WP-08 follow-up / O2-024 (was util/settings.ts): keys the helm, payments and restore paths read at call time, so a
   * test can set them at runtime.
   */
  helm: {
    /** A booking whose seals aren't all set by then is voided (SEC-011). Default 10 min. */
    sealDeadlineMs: () => positive("SEAL_DEADLINE_MS", 10 * 60_000),
    /** Boot keeps BOOKED/VOIDED voyages touched this recently in memory; older ones load on demand (TR5-016). */
    restoreRecentDays: () => positive("RESTORE_RECENT_DAYS", 7),
    /** WP-07: table meetings allowed per voyage (each one costs model/voice calls). Default 6. */
    tableRunsMax: () => positive("TABLE_RUNS_MAX", 6),
    /**
     * Headset pair codes are stored as an HMAC under this secret (SEC-018). Without PAIRING_SECRET it is per process:
     * a pending code dies with a restart (codes last 10 minutes anyway).
     */
    pairingSecret: () => env("PAIRING_SECRET") || (perProcessPairingSecret ??= randomBytes(32).toString("hex")),
  },
  expoMode: bool("EXPO_MODE", true),
  /** Multiplies the pauses between spoken lines (tests use ~0). */
  paceScale: num("PACE_SCALE", 1),
  demoReplay: oneOf("DEMO_REPLAY", ["live", "cached"] as const, "live"),
  /** WP-07 abuse limits & spend caps (docs/04 §12 "Limits"; util/limits.ts). */
  limits: {
    /** Proxies in front of the server. Unset: 1 on Render/Fly (they set RENDER / FLY_APP_NAME), else 0 = ignore X-Forwarded-For. */
    trustProxyHops: num("TRUST_PROXY_HOPS", process.env.RENDER || process.env.FLY_APP_NAME ? 1 : 0),
    rateLimitsOff: /^(off|0|false)$/i.test(env("RATE_LIMITS", "on")),
    rateScale: Math.max(0.01, num("RATE_LIMIT_SCALE", 1)),
    hailAudioMaxBytes: Math.max(16_384, num("HAIL_AUDIO_MAX_BYTES", 524_288)),
    /** Paid calls allowed per UTC day (whole server) and per voyage. 0 switches that provider off. */
    spend: {
      daily: { gemini: num("DAILY_CAP_GEMINI", 3000), tts: num("DAILY_CAP_TTS", 1500), stt: num("DAILY_CAP_STT", 500), backboard: num("DAILY_CAP_BACKBOARD", 3000), routestack: num("ROUTESTACK_DAILY_CAP", 200) },
      trip: { gemini: num("TRIP_CAP_GEMINI", 150), tts: num("TRIP_CAP_TTS", 100), stt: num("TRIP_CAP_STT", 30), backboard: num("TRIP_CAP_BACKBOARD", 60), routestack: num("ROUTESTACK_TRIP_CAP", 20) },
    },
    /**
     * R2-WP-12 (S2-014): the share (%) of each daily cap held back for voyages past the table (Dry Run, sealing,
     * booked), so a burst of new voyages can't switch voices and models off for a crew that is about to book.
     */
    spendReservePct: num("SPEND_RESERVE_PCT", 20),
    /** R2-WP-12 (S2-007): unknown voyage ids per address per minute under /api/trips/:tripId before 429 SLOW_DOWN. */
    tripMissPerMinute: num("TRIP_MISS_RATE", 20),
    /** R2-WP-12 (S2-008): wrong headset codes per minute per IPv6 /48 (next to 10 per address; no global cap). */
    pairFailPer48PerMinute: num("PAIR_FAIL_RATE_48", 30),
    /** Idle voyages leave memory: BRIEFING after VOYAGE_IDLE_HOURS, BOOKED/VOIDED after VOYAGE_DONE_DAYS. */
    voyageIdleMs: num("VOYAGE_IDLE_HOURS", 48) * 3_600_000,
    voyageDoneMs: num("VOYAGE_DONE_DAYS", 7) * 86_400_000,
    /**
     * R2-WP-11 (S2-006): a BRIEFING voyage nobody else joined (≤ 1 seat, no sealed terms) leaves memory after
     * VOYAGE_LONE_HOURS; with MongoDB it still opens by link or code (loaded on demand).
     */
    voyageLoneMs: num("VOYAGE_LONE_HOURS", 1) * 3_600_000,
    /** R2-WP-11 (L5-008): a Dry Run nobody touched for VOYAGE_STALE_DAYS leaves memory and isn't loaded at boot. */
    voyageStaleMs: num("VOYAGE_STALE_DAYS", 30) * 86_400_000,
    /** R2-WP-11 (S2-006): voyages held in memory at once; past it, new voyages are refused (503 HELM_FULL). */
    maxLiveVoyages: num("MAX_LIVE_VOYAGES", 2000),
    /** R2-WP-11 (S2-006): new voyages per minute, whole server and per IPv6 /48 (next to the per-address 10/min). */
    createPerMinute: num("CREATE_RATE_GLOBAL", 60),
    createPer48PerMinute: num("CREATE_RATE_48", 30),
    /** TTS mp3 cache bound (the Expo warm cache lives here too, so keep it roomy). */
    ttsCacheMaxFiles: num("TTS_CACHE_MAX_FILES", 3000),
    ttsCacheMaxAgeMs: num("TTS_CACHE_MAX_DAYS", 30) * 86_400_000,
  },
  /**
   * TR5-008 / TR5-017: both dirs are overridable. CACHE_DIR holds regenerable files only (TTS mp3s): losing it costs
   * a re-synthesis, never data. DATA_DIR holds the local memory + Backboard assistant map when MongoDB is off (with
   * Mongo they live in the `memories` / `backboard_assistants` collections instead). On a host with an ephemeral
   * disk, point DATA_DIR at a mounted persistent disk (see DEPLOY.md). Tests point both at a temp dir.
   */
  cacheDir: process.env.CACHE_DIR?.trim() ? resolve(env("CACHE_DIR")) : fileURLToPath(new URL("../.cache/", import.meta.url)),
  dataDir: process.env.DATA_DIR?.trim() ? resolve(env("DATA_DIR")) : fileURLToPath(new URL("../data/", import.meta.url)),
  webDist: process.env.WEB_DIST?.trim() ? resolve(env("WEB_DIST")) : fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  /**
   * WP-08 follow-up: the passkeys' relying party, read at call time (the passkey tests switch these keys at runtime).
   * `origin` is WEBAUTHN_ORIGIN, else PUBLIC_BASE_URL (raw; passkeys.ts normalizes it). `production` follows NODE_ENV,
   * which this file syncs with the derived mode at boot, so it pins the relying party exactly when `config.production` does.
   */
  webauthn: {
    origin: () => env("WEBAUTHN_ORIGIN") || env("PUBLIC_BASE_URL"),
    rpId: () => env("WEBAUTHN_RP_ID"),
    production: () => env("NODE_ENV") === "production",
  },
};

export const features = {
  /** DEMO_REPLAY=cached = the Expo emergency button: no live model calls, voices only from the warmed cache. */
  cached: () => config.demoReplay === "cached",
  gemini: () => Boolean(config.gemini.apiKey) && !features.cached(),
  eleven: () => Boolean(config.eleven.apiKey),
  mongo: () => Boolean(config.mongoUri),
  backboard: () => Boolean(config.backboard.apiKey),
};

/**
 * SEC-013: production refuses to start with a guessable dev key or without a public origin (passkeys would otherwise
 * follow the request's Origin/Host). Returns the problems; index.ts exits non-zero when there are any.
 */
export function productionProblems(c: Pick<typeof config, "production" | "devKey" | "publicBaseUrl"> = config): string[] {
  if (!c.production) return [];
  const out: string[] = [];
  if (c.devKey && (c.devKey.length < 32 || /^change-?me$/i.test(c.devKey))) out.push("DEV_KEY is too weak (use 32+ random characters, or leave it empty to switch dev routes off)");
  if (!c.publicBaseUrl) out.push("PUBLIC_BASE_URL is not set (e.g. https://allayes.tech)");
  return out;
}
