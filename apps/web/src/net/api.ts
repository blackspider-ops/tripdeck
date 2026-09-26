// REST client (docs/04-technical-design.md §6). All paths are relative; Vite proxies /api in dev.
import type { Airport, Band, CityPack, CrewPublic, DateRange, DateWindow, Destination, Origin, Region, TripStatus } from "@all-ayes/shared";
// type-only: the WebAuthn helper itself still loads lazily at seal time (OPT-057)
import type {
  AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { loadCrewKey, saveCrewKey } from "./session";
import { KEYS, readRaw, writeRaw } from "./storage";

/** O2-048: a REST call gives up after this long (a hung request over venue Wi-Fi must not leave a button busy forever). */
export const CALL_TIMEOUT_MS = 15_000;
/** signal: the caller's abort (an effect's cleanup); timeoutMs: this call's limit. */
export interface CallOpts { signal?: AbortSignal; timeoutMs?: number }

async function call<T>(method: string, path: string, body?: unknown, token?: string, extraHeaders?: Record<string, string>, opts: CallOpts = {}): Promise<T> {
  const { signal, timeoutMs = CALL_TIMEOUT_MS } = opts;
  // O2-048: one controller aborts the fetch (and its body) on the timeout or the caller's signal; `cut` rejects at
  // once with TIMEOUT / ABORTED, even from a fetch that ignores its signal
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const cut = new Promise<never>((_, reject) => {
    const stop = (e: ApiError) => { ctl.abort(); reject(e); };
    timer = setTimeout(() => stop(new ApiError(0, "The helm took too long to answer. Try again.", "TIMEOUT")), timeoutMs);
    onAbort = () => stop(new ApiError(0, "That request was cancelled.", "ABORTED"));
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([request<T>(method, path, body, token, extraHeaders, ctl.signal), cut]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function request<T>(method: string, path: string, body: unknown, token: string | undefined, extraHeaders: Record<string, string> | undefined, signal: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      ...(body !== undefined && !(body instanceof Blob) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  }).catch(() => { throw new ApiError(0, "Couldn't reach the helm. Check your connection.", "OFFLINE"); });
  const text = await res.text();
  // TR3-006 / TR1-014: a proxy's HTML/text error page (502/504, "Cannot GET") must still reject with an ApiError
  // that carries the HTTP status, never a SyntaxError
  let data: { message?: unknown; code?: unknown } | null = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new ApiError(res.status, "The helm answered with something that isn't JSON.", "BAD_RESPONSE");
  }
  if (!res.ok) {
    const message = typeof data?.message === "string" && data.message ? data.message : res.statusText || `The helm answered ${res.status}.`;
    throw new ApiError(res.status, message, typeof data?.code === "string" ? data.code : undefined);
  }
  return data as T;
}

export interface CatalogCity { cityId: string; name: string; notes: string[]; country?: string; region?: Region; state?: string; lat?: number; lng?: number }
export interface Catalog { cities: CatalogCity[]; regions: Region[]; windows: DateWindow[]; defaultWindowIds: string[]; airports: Airport[] }
export interface DemoSeat { name: string; role: "organizer" | "member" | "absent"; band: Band; memberId: string; memberToken: string; handoff: string }
export interface DemoSeed {
  kind: "random" | "expo"; seed?: number; tripId: string; joinCode: string; tripName: string;
  organizer: DemoSeat; crew: DemoSeat[]; ports: string[]; headsetCode: string; maya?: DemoSeat; dev?: DemoSeat;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

/** SEC-003: create/join/claim carry this phone's crew key (if any) and keep the one the server hands back. */
async function withCrewKey<T extends { crewKey?: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  saveCrewKey(r.crewKey);
  return r;
}

export const api = {
  cities: (opts?: CallOpts) => call<CatalogCity[]>("GET", "/cities", undefined, undefined, undefined, opts),

  /** The Create screen's catalog: every port, the regions that have ports, the date windows (+ the default two), home airports. */
  catalog: (opts?: CallOpts) => call<Catalog>("GET", "/catalog", undefined, undefined, undefined, opts),

  /** docs/11: build (or fetch) a generated port from OpenStreetMap; 503 LOADING while the map is busy, 409 TOO_FEW. */
  worldPack: (osmId: string) => call<{ pack: CityPack; cached: boolean; registered: boolean }>("POST", "/world/packs", { osmId }, undefined, undefined, { timeoutMs: 90_000 }),

  /** A new voyage: a date range (`dateRange`), or the older fixed windows (`windowIds`, still accepted by the helm). */
  createTrip: (p: { name: string; organizerName: string; band: Band; origin: Origin; cityIds?: string[]; destination?: Destination; windowIds?: string[]; dateRange?: DateRange }) =>
    withCrewKey(call<{ tripId: string; joinCode: string; memberId: string; memberToken: string; crewKey?: string }>("POST", "/trips", { ...p, crewKey: loadCrewKey() })),

  tripByCode: (code: string, opts?: CallOpts) =>
    call<{ tripId: string; joinCode: string; name: string; status: TripStatus; crew: CrewPublic[]; takenBands: Band[]; crewClosed?: boolean }>(
      "GET", `/trips/by-code/${encodeURIComponent(code)}`, undefined, undefined, undefined, opts),

  join: (tripId: string, p: { name: string; band: Band; origin: Origin }) =>
    withCrewKey(call<{ memberId: string; memberToken: string; crewKey?: string }>("POST", `/trips/${tripId}/members`, { ...p, crewKey: loadCrewKey() })),

  addAbsent: (tripId: string, token: string, p: { name: string; band: Band; origin: Origin }) =>
    call<{ memberId: string; inviteKey: string; invitePath: string }>("POST", `/trips/${tripId}/absent`, p, token),

  /** TR1-001: organizer only — a fresh link for an absent friend who hasn't opened theirs (the old one stops working). */
  reissueInvite: (tripId: string, token: string, memberId: string) =>
    call<{ memberId: string; inviteKey: string; invitePath: string }>("POST", `/trips/${tripId}/absent/${memberId}/invite`, {}, token),

  /**
   * S2-009 / S2-012 (R2-WP-10): the organizer resets a seat someone else took. The seat's token and passkeys stop
   * working and a fresh invite link comes back for the rightful member.
   */
  resetSeat: (tripId: string, token: string, memberId: string) =>
    call<{ memberId: string; invitePath: string }>("POST", `/trips/${encodeURIComponent(tripId)}/members/${encodeURIComponent(memberId)}/reset`, {}, token),

  claimAbsent: (tripId: string, memberId: string, inviteKey: string) =>
    withCrewKey(call<{ memberToken: string; crewKey?: string }>("POST", `/trips/${tripId}/absent/${memberId}/claim`, { inviteKey, crewKey: loadCrewKey() })),

  /** SEC-004: a /demo link's one-time handoff code → that seat's member token. */
  redeemHandoff: (tripId: string, memberId: string, code: string) =>
    call<{ memberToken: string }>("POST", `/trips/${tripId}/members/${memberId}/handoff`, { code }),

  headsetCode: (tripId: string, token: string) =>
    call<{ code: string; expiresAt: string }>("POST", `/trips/${tripId}/headset-code`, {}, token),

  pairHeadset: (code: string) =>
    call<{ tripId: string; joinCode: string; deviceToken: string }>("POST", "/xr/pair", { code }),

  /** SEC-018: the organizer revokes the paired headset. */
  unpairHeadset: (tripId: string, token: string) => call<{ ok: true }>("DELETE", `/trips/${tripId}/headset`, undefined, token),

  /**
   * Upload + speech-to-text. L1-005 (R2-WP-12): `kind: "note"` (the Brief's "Say it instead") is kept to the note's
   * 200 characters; a hail to the hail's 160.
   */
  hailAudio: (tripId: string, token: string, audio: Blob, kind: "hail" | "note" = "hail") =>
    call<{ transcript: string }>("POST", `/trips/${tripId}/hail-audio${kind === "note" ? "?kind=note" : ""}`, audio, token, undefined, { timeoutMs: 60_000 }),

  /** docs/09: a random voyage by default; "expo" is the scripted Lisbon crew. */
  seedDemo: (kind: "random" | "expo" = "random") =>
    call<DemoSeed>("POST", `/demo/seed?kind=${kind}`, {}, undefined, devKeyHeader()),

  health: () => call<Record<string, unknown>>("GET", "/health"),

  // passkeys (PRD E2)
  /** registered: usable on this address; required: the seal needs a passkey (one exists somewhere). */
  passkeyStatus: (tripId: string, token: string) => call<{ registered: boolean; required?: boolean }>("GET", `/trips/${tripId}/passkey`, undefined, token),
  passkeyRegisterOptions: (tripId: string, token: string) => call<PublicKeyCredentialCreationOptionsJSON>("POST", `/trips/${tripId}/passkey/register/options`, {}, token),
  passkeyRegisterVerify: (tripId: string, token: string, response: RegistrationResponseJSON) => call<{ ok: true }>("POST", `/trips/${tripId}/passkey/register/verify`, { response }, token),
  passkeyAuthOptions: (tripId: string, token: string) => call<PublicKeyCredentialRequestOptionsJSON>("POST", `/trips/${tripId}/passkey/auth/options`, {}, token),
  /** The assertion token that comes back is single use and only valid for this booking. */
  passkeyAuthVerify: (tripId: string, token: string, bookingId: string, response: AuthenticationResponseJSON) =>
    call<{ assertionToken: string }>("POST", `/trips/${tripId}/passkey/auth/verify`, { response, bookingId }, token),
};

/**
 * In production (or through a tunnel) the demo seeder needs the dev key: open /demo#key=<DEV_KEY>. SEC-019: the key
 * is read once, kept in sessionStorage (this tab only), stripped from the address bar, and sent as a header, never a
 * query. S2-013: only the fragment counts, because a fragment never leaves the browser; `?key=` has already travelled
 * in the request line (proxy and CDN logs), so it is ignored — just wiped from the address bar.
 */
export function captureDevKey() {
  if (typeof location === "undefined") return;
  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (!search.has("key") && !hash.has("key")) return;
  const key = hash.get("key");
  if (key) writeRaw(KEYS.devKey, key, "session");
  else console.warn("[demo] ?key= is ignored (it travels in request logs); open /demo#key=… instead");
  search.delete("key"); hash.delete("key");
  const rest = (q: URLSearchParams, p: string) => (q.toString() ? `${p}${q}` : "");
  history.replaceState(history.state, "", `${location.pathname}${rest(search, "?")}${rest(hash, "#")}`);
}
function devKeyHeader(): Record<string, string> {
  const key = readRaw(KEYS.devKey, "session");
  return key ? { "X-Dev-Key": key } : {};
}
// strip it before the router first reads the URL (this module loads before any screen renders)
captureDevKey();
