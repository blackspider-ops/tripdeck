/**
 * The helm's records, the bus contract, and the pure helpers the trips/* modules share (OPT-031).
 */
import { createHash } from "node:crypto";
import type { Brief, CityId, Dataset, Destination, Plan, Role, S2CPayload, ServerToClient, TripRoomEvent, TripStatus, Turn, Band, Origin } from "@all-ayes/shared";
import type { BookingRec, StoredStanding } from "../payments/orchestrator.js";
import { datasetRev } from "../data/loader.js";
import type { BookingDoc } from "../store/db.js";

// ---------- records ----------
export interface MemberRec {
  _id: string; tripId: string; name: string; role: Role; band: Band; origin: Origin;
  tokenHash: string; inviteKeyHash?: string; briefSealed: boolean;
  /** Hash of this person's private crew key: their memory thread across voyages (SEC-003). Absent → no memory. */
  crewKeyHash?: string;
  /**
   * Absent member's standing instruction, persisted so a restart keeps its original expiry (SEC-009). Server-only.
   * L5-007: never its limit (the member's cap lives in the brief only).
   */
  standing?: StoredStanding;
}
export interface TripRec {
  _id: string; joinCode: string; name: string; status: TripStatus; version: number;
  organizerId: string; memberIds: string[]; removedMemberIds: string[];
  /**
   * The ports on the chart. Named ports: the organizer's 2–4. Regions / anywhere: empty until the table meets, then
   * the top 4 of the pre-rank (fit/prerank.ts) for this crew.
   */
  candidateCityIds: CityId[];
  /** The date windows on offer (1–3). Absent on voyages from older builds: W1 and W2 (`tripWindowIds`). */
  candidateWindowIds?: string[];
  /** How the course was set. Absent on voyages from older builds: the named ports in candidateCityIds. */
  destination?: Destination;
  /**
   * The packs of generated ports on the chart (docs/11-world-cities.md, ~8 kB each), stored with the voyage so a
   * restore on a fresh disk re-adds the ports without the network (persistence.ts adopts them before any plan).
   */
  worldPacks?: unknown[];
  /**
   * `turns` live in memory only; they are persisted one document each in the `turns` collection (TR5-012), keyed by
   * (tripId, round, seq). `round` counts table meetings, so a restore attaches only the current meeting's turns.
   * OPT-007: the write-only `endedReason` and `advocatedBy` were dropped (older docs may still carry them; harmless).
   */
  negotiation: { watch: number; running: boolean; seq: number; round?: number; turns: Turn[] };
  shortlistIds?: [string, string];
  votes: Record<string, string>; autoPick?: { planId: string; at: number } | null; chosenPlanId?: string; bookingId?: string; attempt: number;
  /** WP-07 follow-up: table meetings started on this voyage (capped by TABLE_RUNS_MAX). Absent on older docs = 0. */
  tableRuns?: number;
  /**
   * Headset pairing (SEC-018/TR5-023): `codeHash` is an HMAC of the 8-char code under the server secret; the device
   * token expires at `deviceExpiresAt` (12 h) and with the voyage (BOOKED), and the organizer can unpair it.
   */
  headset?: { codeHash: string; expiresAt: number; deviceTokenHash?: string; deviceExpiresAt?: number };
  /** SEC-010: the organizer closed the crew; the join code no longer adds anyone. */
  crewClosed?: boolean;
  /** The last booking:result's public reason, so a reload in BOOKED/VOIDED replays it (TR3-003). */
  lastResult?: { bookingId: string; publicReason?: string };
  /** The Dry Run clock, so a restart resumes the tour at the same minute, paused or not (TR5-011). */
  dryrun?: { startedAt: number; pausedAt: number | null };
  /**
   * TR5-022: the Two Charts as priced when the table decided, plus the dataset they came from. A deploy with a changed
   * dataset.json can't silently re-price or lose them: the stored plans win, and the drift is logged on restore.
   * Server-only (per-member shares): never broadcast; the snapshot sends ids and the public/private views only.
   */
  shortlistPlans?: Plan[];
  datasetHash?: string;
  /**
   * docs/12: priced on curated listings only — no live (RouteStack) prefetch. Set for the scripted Expo voyage, whose
   * numbers the pitch and tests rely on.
   */
  curatedOnly?: boolean;
  /** TR5-021: the table was interrupted (engine failure or a restart) and the voyage went back to BRIEFING. */
  tableReset?: { at: string; reason: string };
  createdAt: string; updatedAt: string;
}
/**
 * A trip as stored: the turn log lives in the `turns` collection (TR5-012) and the Two Charts' plan bodies in
 * `shortlists` (R2-WP-14 / O2-036). LEGACY: trip docs written before O2-036 still embed `shortlistPlans`; they load.
 */
export type TripDoc = Omit<TripRec, "negotiation" | "shortlistPlans"> & { negotiation: Omit<TripRec["negotiation"], "turns">; shortlistPlans?: Plan[] };
/**
 * R2-WP-14 (O2-036): the Two Charts as priced when the table decided (TR5-022), written once per decision instead of
 * with every trip save. `_id` = tripId (a new decision replaces it); `round` and `planIds` tie it to the trip doc, so
 * a restore attaches it only while they still match.
 */
export interface ShortlistDoc { _id: string; tripId: string; round: number; planIds: [string, string]; plans: Plan[]; datasetHash?: string; at: string }
export type BriefRec = Brief & { _id: string };
export interface DebugRow { at: string; event: string; audience: string; summary: string }

/**
 * OPT-062: typed against the shared contract. `trip` takes only trip-room events (no private event, no caller-only
 * `error`), so the privacy guard is a compile-time check as well as the runtime one in `toTrip`.
 */
export interface Bus {
  trip<K extends TripRoomEvent>(tripId: string, event: K, payload: S2CPayload<K>): void;
  member<K extends keyof ServerToClient>(memberId: string, event: K, payload: S2CPayload<K>): void;
  /** TR4-001: a removed member's sockets leave their member room and lose their member identity. */
  evict?(memberId: string): void;
}

/** Who is asking: an authenticated member id (sockets), a bearer token (REST), or the headset. */
export interface Actor { memberId?: string; token?: string; deviceToken?: string }

/** Emits one event to a single client (a (re)joining socket's replay). */
export type Emit = <K extends keyof ServerToClient>(event: K, payload: S2CPayload<K>) => void;

/** O2-014: the socket rooms, and the `member:<id>` audience of the debug/audit log. */
export const tripRoom = (tripId: string) => `trip:${tripId}`;
export const memberRoom = (memberId: string) => `member:${memberId}`;
/** The member id of a `member:<id>` room or audience, or "" for anything else. */
export const memberOfRoom = (room: string) => (room.startsWith("member:") ? room.slice("member:".length) : "");

// ---------- phases & the state machine ----------
/** The Two Charts exist (and are replayed) in these phases. */
export const SHORTLIST_PHASES: TripStatus[] = ["DRY_RUN", "SEALING", "BOOKED", "VOIDED"];
/** The voyage's current booking attempt is live or just settled; after "back to the charts" it is history. */
export const BOOKING_PHASES: TripStatus[] = ["SEALING", "BOOKED", "VOIDED"];
/** O2-028: no money moves: terms can be (re)sealed and a seat reset (before the table, or after a void). */
export const OPEN_PHASES: TripStatus[] = ["BRIEFING", "VOIDED"];
/** Voice clips are for terms (a dictated note) and hails. */
export const VOICE_PHASES: TripStatus[] = ["BRIEFING", "VOIDED", "AT_TABLE"];
/** R2-WP-12 (S2-014): voyages past the table may draw on the held-back part of the daily paid-call budgets. */
export const SPEND_PRIORITY_PHASES: TripStatus[] = ["DRY_RUN", "SEALING", "BOOKED"];

/**
 * docs/04 §5: every edge a voyage may take (TR4-002). The recovery edges are marked; everything else is BAD_PHASE.
 */
export const TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  BRIEFING: ["AT_TABLE"],
  AT_TABLE: ["DRY_RUN", "BRIEFING"], // Captain DECIDE · the table failed or the helm restarted mid-table
  DRY_RUN: ["SEALING", "BRIEFING"], // pick · restore: terms or charts missing (TR5-002/TR5-022)
  SEALING: ["BOOKED", "VOIDED"], // booking CAPTURED · booking VOIDED (incl. restart with no live booking)
  BOOKED: ["VOIDED"], // restore only: the booking record says it was voided (TR5-001)
  VOIDED: ["DRY_RUN", "BRIEFING", "BOOKED"], // back to the charts · new terms · restore: the booking record says CAPTURED
};

// ---------- limits & timings (OPT-060) ----------
export const DEBUG_ROWS_PER_TRIP = 400;
export const DEBUG_TRIPS = 200;
/** SEC-014: client log levels kept in the debug log, and the caps on a client line. */
export const CLIENT_LOG_LEVELS = ["log", "info", "warn", "error"] as const;
export const CLIENT_LOG_SURFACE_MAX = 16;
export const CLIENT_LOG_MSG_MAX = 300;
/** How much of a turn's text a debug/event row keeps. */
export const DEBUG_SUMMARY_MAX = 120;
/** How long a (re)joining phone is told the table was interrupted. */
export const TABLE_RESET_NOTICE_MS = 6 * 3_600_000;
/** SEC-015: how long a settled voyage keeps its recomputable hot caches. */
export const HOT_CACHE_MS = 2 * 3_600_000;
/** How long a hail rate-limit stamp is kept once it no longer matters. */
export const HAIL_STAMP_KEEP_MS = 60_000;
/** One hail per member this often (the socket limiter is separate). */
export const HAIL_MIN_INTERVAL_MS = 5_000;
/** Hails reach the table at the start of Watch 2 at the earliest. */
export const FIRST_HAIL_WATCH = 2;
/** SEC-018: a headset pair code lasts 10 minutes, a paired device 12 hours. */
export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const PAIR_CODE_CHARS = 8;
export const DEVICE_TTL_MS = 12 * 3_600_000;
/** SEC-004: a demo handoff code lasts 2 hours. */
export const HANDOFF_TTL_MS = 2 * 3_600_000;
/** A bad code / id isn't looked up in MongoDB again for a minute; the miss list is an LRU of this many (R2-WP-12, S2-007). */
export const HYDRATE_MISS_TTL_MS = 60_000;
export const HYDRATE_MISS_MAX = 1000;
/** A (re)joining client gets at most this many recent turns. */
export const REPLAY_TURNS = 50;
/** The fallback voyage name. */
export const DEFAULT_TRIP_NAME = "Our voyage";
/** The seal screen's card digits when the provider can't say (TR4-016). */
export const CARD_LAST4_UNKNOWN = "••••";

export const REASON_TABLE_RESTART = "The helm restarted while the table was meeting. Weigh anchor again.";
export const REASON_TABLE_FAILED = "The table lost its bearings. Weigh anchor again.";
export const REASON_TERMS_MISSING = "Someone's sealed terms were lost in a restart. Seal them again, then weigh anchor.";
export const REASON_CHARTS_CHANGED = "The charts changed since the table met. Weigh anchor again.";

// ---------- pure helpers ----------
/** TR3-004: `brief:private` carries the Brief of the contract, not the stored record (no `_id`). */
export function briefOut(rec: BriefRec | undefined): Brief | null {
  if (!rec) return null;
  const { _id: _omit, ...brief } = rec;
  return brief;
}

let dsHashCache: { ds: Dataset; rev: number; hash: string } | null = null;
/** The voyage's date windows (older voyages offered W1 and W2). */
export const LEGACY_WINDOW_IDS = ["W1", "W2"];
export function tripWindowIds(t: TripRec): string[] {
  return t.candidateWindowIds?.length ? t.candidateWindowIds : LEGACY_WINDOW_IDS;
}

/** A stable fingerprint of the loaded dataset (TR5-022). */
export function datasetHash(ds: Dataset): string {
  // a runtime-added port (loader addCityPack) bumps the dataset's revision, and with it the hash
  if (dsHashCache?.ds !== ds || dsHashCache.rev !== datasetRev(ds)) {
    dsHashCache = { ds, rev: datasetRev(ds), hash: createHash("sha256").update(JSON.stringify(ds)).digest("hex").slice(0, 16) };
  }
  return dsHashCache.hash;
}

/** The stored trip: without its turn log (TR5-012) or the Two Charts' plan bodies (O2-036: see `shortlistDoc`). */
export function tripDoc(t: TripRec): TripDoc {
  const { turns: _turns, ...negotiation } = t.negotiation;
  const { shortlistPlans: _plans, ...rest } = t;
  return { ...rest, negotiation };
}

/** O2-036: the stored Two Charts of the current decision, or undefined when there are none. */
export function shortlistDoc(t: TripRec): ShortlistDoc | undefined {
  if (!t.shortlistIds || t.shortlistPlans?.length !== 2) return undefined;
  return { _id: t._id, tripId: t._id, round: t.negotiation.round ?? 0, planIds: t.shortlistIds, plans: t.shortlistPlans, datasetHash: t.datasetHash, at: t.updatedAt };
}

/**
 * The stored booking (TR5-015): no seal carries the member's cap (it is re-derived from the brief on restore).
 * O2-038: pure; the caller bumps `b.version` when it actually writes (core.ts `persistBooking`).
 */
export function bookingDoc(b: BookingRec): BookingDoc {
  return { ...b, version: b.version ?? 0, seals: b.seals.map(({ capCents: _cap, ...s }) => ({ ...s })) };
}

/** A seat still held: on the crew and not sailed without (TR4-001). */
export function holdsSeat(t: TripRec, memberId: string): boolean {
  return t.memberIds.includes(memberId) && !t.removedMemberIds.includes(memberId);
}

/**
 * OPT-021: the one count of votes per chart. Only seats still held count (TR4-001): a vote left by a removed member
 * never makes a majority.
 */
export function tallies(t: TripRec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [memberId, pid] of Object.entries(t.votes)) {
    if (!holdsSeat(t, memberId)) continue;
    out[pid] = (out[pid] ?? 0) + 1;
  }
  return out;
}
