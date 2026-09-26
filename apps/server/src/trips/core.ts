/**
 * The helm's shared core (OPT-031): the in-memory records, the two emit paths (trip room / one member) with the
 * debug + audit log, the state machine, saving, O(1) lookups, auth checks and eviction. The feature modules
 * (crew, identity, table, dryrun, sealing, replay, persistence) build on it and on each other through `Helm`
 * (O2-027: never through the TripService facade, which is the public surface for the API, sockets and tests).
 */
import type { CrewPublic, Dataset, Plan, S2CPayload, ServerToClient, TripRoomEvent, TripStatus, Turn } from "@all-ayes/shared";
import { JOIN_REFUSAL, PRIVATE_EVENTS } from "@all-ayes/shared";
import { loadDataset } from "../data/loader.js";
import type { PrivacyContext } from "../privacy/filter.js";
import { personKey, recall } from "../memory/memory.js";
import { PaymentsOrchestrator, type BookingRec } from "../payments/orchestrator.js";
import { selectPaymentProvider } from "../payments/select.js";
import { audioKeyOf } from "../voice/voice.js";
import { evictPasskeys } from "../passkeys/passkeys.js";
import { config } from "../config.js";
import { append, persist, writesOn } from "../store/db.js";
import { HelmError } from "../util/errors.js";
import { nowIso, sameHash } from "../util/ids.js";
import {
  CLIENT_LOG_LEVELS, CLIENT_LOG_MSG_MAX, CLIENT_LOG_SURFACE_MAX, DEBUG_ROWS_PER_TRIP, DEBUG_SUMMARY_MAX, DEBUG_TRIPS,
  HAIL_STAMP_KEEP_MS, HOT_CACHE_MS, TRANSITIONS, bookingDoc, holdsSeat, memberOfRoom, memberRoom, shortlistDoc, tripDoc,
  type Actor, type Bus, type DebugRow, type MemberRec, type BriefRec, type TripRec,
} from "./records.js";
import type { Crew } from "./crew.js";
import type { Identity } from "./identity.js";
import type { Table } from "./table.js";
import type { DryRun } from "./dryrun.js";
import type { Sealing } from "./sealing.js";
import type { Replayer } from "./replay.js";
import type { Persistence } from "./persistence.js";
import type { LivePrices } from "./live.js";
import type { LiveInventory } from "../fit/live.js";

/** What every trips module sees: the core and its sibling modules (O2-027). TripService implements it. */
export interface Helm extends HelmCore {
  readonly crew: Crew; readonly identity: Identity; readonly table: Table; readonly dryrun: DryRun;
  readonly sealing: Sealing; readonly replayer: Replayer; readonly archive: Persistence; readonly live: LivePrices;
}

/** O2-010: the organizer-action checks, in the order they have always run (who, then which voyage, then its phase). */
export interface OrganizerCheck {
  /** Refused (NOT_ORGANIZER) unless the organizer's phone asks: the headset may not. */
  phoneOnly?: string;
  /** Refused (BAD_PHASE, with `phaseMessage`) unless the voyage is in one of these. */
  phases?: readonly TripStatus[];
  phaseMessage?: string;
}

export abstract class HelmCore {
  ds: Dataset = loadDataset();
  trips = new Map<string, TripRec>();
  members = new Map<string, MemberRec>();
  briefs = new Map<string, BriefRec>(); // key memberId
  chartBooks = new Map<string, Plan[]>();
  privacy = new Map<string, PrivacyContext>();
  /** docs/12: each voyage's live (RouteStack) overlay — never the shared Dataset. Recomputable (the provider caches 6 h). */
  liveInventory = new Map<string, LiveInventory>();
  pendingHails = new Map<string, { memberId: string; text: string }[]>();
  lastHailAt = new Map<string, number>();
  /** Trips whose Captain is deciding: hails are refused from here on (TR4-011). */
  hailsClosed = new Set<string>();
  debugLog = new Map<string, DebugRow[]>();
  payments: PaymentsOrchestrator;
  protected bus: Bus = { trip: () => undefined, member: () => undefined };

  constructor() {
    this.payments = new PaymentsOrchestrator(selectPaymentProvider(config.payments.mode), {
      // the orchestrator announces public statuses only (a DECLINED never reaches here)
      sealStatus: (b, memberId, status) => this.toTrip(b.tripId, "seal:status", { bookingId: b._id, memberId, status }),
      declinedPrivate: (b, memberId, reason) => this.toMember(b.tripId, memberId, "seal:declinedPrivate", { bookingId: b._id, reason }),
      result: (b, status, publicReason) => this.onBookingResult(b, status, publicReason),
      persist: (b) => this.persistBooking(b),
    });
  }

  /** The voyage follows its booking's outcome (sealing.ts). */
  protected abstract onBookingResult(b: BookingRec, status: "CAPTURED" | "VOIDED", publicReason?: string): void;
  /** The voyage by id or join code (persistence.ts: a miss starts loading an archived one and answers LOADING). */
  abstract trip(tripId: string): TripRec;
  abstract tripByCode(code: string): TripRec;
  /** The shared snapshot to the trip room (replay.ts builds it). */
  abstract broadcastState(t: TripRec, full?: boolean): void;

  attachBus(bus: Bus) { this.bus = bus; }
  /** TR4-001: a removed member's sockets leave their member room. */
  evictSockets(memberId: string) { this.bus.evict?.(memberId); }

  // ---------- emits & the debug log ----------
  /** Shared-room emit. Refuses private events (privacy guard, doc 04 §12). */
  toTrip<K extends TripRoomEvent>(tripId: string, event: K, payload: S2CPayload<K>) {
    if ((PRIVATE_EVENTS as readonly string[]).includes(event) || (event as string) === "error") throw new Error(`privacy: ${event} may not go to the trip room`);
    this.log(tripId, event, "trip", payload);
    this.bus.trip(tripId, event, payload);
  }
  /** One member's sockets. The payload is never logged (private). */
  toMember<K extends keyof ServerToClient>(tripId: string, memberId: string, event: K, payload: S2CPayload<K>) {
    this.log(tripId, event, memberRoom(memberId), undefined);
    this.bus.member(memberId, event, payload);
  }
  /**
   * Debug log + `events` audit (docs/04 §4.8, TR5-013): `{tripId, type, audience:"trip"|"member:<id>",
   * payloadRedacted, at}`. Member payloads are never recorded (private); shared ones keep a short redacted summary
   * (a turn's filtered text, or a status). The collection has a TTL; the in-memory log is bounded per voyage and in
   * the number of voyages it keeps (TR5-011).
   */
  private log(tripId: string, event: string, audience: string, payload: unknown) {
    // S2-004: whose seal declined is the owner's alone, so its private notice is logged without an addressee
    if (event === "seal:declinedPrivate") audience = "member:*";
    const summary = payload && typeof payload === "object" && "text" in (payload as object) ? String((payload as { text: string }).text).slice(0, DEBUG_SUMMARY_MAX)
      : payload && typeof payload === "object" && "status" in (payload as object) ? String((payload as { status: string }).status) : "";
    const at = new Date();
    this.pushDebug(tripId, { at: at.toISOString(), event, audience: this.audienceLabel(audience), summary });
    append("events", { tripId, type: event, audience, payloadRedacted: summary, at });
  }
  audienceLabel(audience: string) {
    const id = memberOfRoom(audience);
    return id ? memberRoom(this.members.get(id)?.name ?? id) : audience;
  }
  pushDebug(tripId: string, row: DebugRow) {
    const list = this.debugLog.get(tripId) ?? [];
    list.push(row);
    if (list.length > DEBUG_ROWS_PER_TRIP) list.splice(0, list.length - DEBUG_ROWS_PER_TRIP);
    this.debugLog.delete(tripId); // re-insert: Map order = least recently logged first
    this.debugLog.set(tripId, list);
    while (this.debugLog.size > DEBUG_TRIPS) {
      const oldest = this.debugLog.keys().next().value;
      if (oldest === undefined) break;
      this.debugLog.delete(oldest);
    }
  }

  /** SEC-014 / OPT-030: the lines behind /api/debug, and a client's console line (io.ts calls this only for
   * authenticated sockets, rate-limited). Levels are whitelisted, fields coerced and capped; not persisted. */
  debugLines(tripId: string) { return this.debugLog.get(tripId) ?? []; }
  clientLog(tripId: string, surface: unknown, level: unknown, msg: unknown) {
    if (!this.trips.has(tripId)) return;
    const lv = typeof level === "string" && (CLIENT_LOG_LEVELS as readonly string[]).includes(level) ? level : "log";
    this.pushDebug(tripId, { at: nowIso(), event: `client:${lv}`, audience: String(surface ?? "?").slice(0, CLIENT_LOG_SURFACE_MAX), summary: String(msg ?? "").slice(0, CLIENT_LOG_MSG_MAX) });
  }

  // ---------- trip state machine (docs/04 §5, TR4-002) ----------
  /**
   * Every status change goes through here. `from` is the caller's precondition (defaults to every status that may
   * lead to `to`); an illegal edge throws BAD_PHASE and changes nothing. `expectVersion`, when given, is the
   * optimistic check: a caller acting on a stale snapshot gets BAD_PHASE too. Staying in the same status is a no-op,
   * but only once `from` holds (L4-006: a precondition is never silently skipped).
   * L4-006: the restore-only edges (BOOKED→VOIDED, VOIDED→BOOKED, DRY_RUN→BRIEFING) need an explicit `from`, so no
   * live caller relying on the default takes them. L4-001: a voyage never enters SEALING or AT_TABLE while any of its
   * bookings still owes a refund or a release (NEEDS_ATTENTION; the re-drive is kicked).
   */
  transition(t: TripRec, to: TripStatus, opts: { from?: TripStatus[]; expectVersion?: number; reason?: string } = {}) {
    if (opts.expectVersion !== undefined && opts.expectVersion !== t.version) {
      throw new HelmError("BAD_PHASE", "The voyage moved on. Here's where it is now.");
    }
    if (opts.from && !opts.from.includes(t.status)) throw new HelmError("BAD_PHASE", `A voyage can't go from ${t.status} to ${to}.`);
    if (t.status === to) return;
    const restoreOnly = (t.status === "BOOKED" && to === "VOIDED") || (t.status === "VOIDED" && to === "BOOKED") || (t.status === "DRY_RUN" && to === "BRIEFING");
    if (!TRANSITIONS[t.status].includes(to) || (restoreOnly && !opts.from)) {
      throw new HelmError("BAD_PHASE", `A voyage can't go from ${t.status} to ${to}.`);
    }
    if ((to === "SEALING" || to === "AT_TABLE") && this.payments.unsettledFor(t._id).length) {
      throw new HelmError("NEEDS_ATTENTION", "A refund or release from an earlier attempt is still being sorted out. Try again in a moment.");
    }
    if (opts.reason) console.log(`[helm] voyage ${t._id}: ${t.status} → ${to} (${opts.reason})`);
    t.status = to;
  }

  // ---------- saving ----------
  save(t: TripRec) { t.version++; t.updatedAt = nowIso(); if (writesOn()) persist("trips", tripDoc(t)); }
  /** O2-036: the Two Charts' plan bodies, once per decision (never with every trip save). */
  persistShortlist(t: TripRec) { const d = shortlistDoc(t); if (d && writesOn()) persist("shortlists", d); }
  /**
   * O2-038: a booking write bumps its version (the write guard, TR5-005) here, and only when it is written: nothing is
   * built (or bumped) while there is no database.
   */
  persistBooking(b: BookingRec) {
    if (!writesOn()) return;
    b.version = (b.version ?? 0) + 1;
    persist("bookings", bookingDoc(b));
  }
  /** One document per turn (TR5-012); re-persisted when its audio is ready (TR4-015), with the audio's cache key. */
  persistTurn(t: TripRec, turn: Turn) {
    const audioKey = turn.audioUrl ? audioKeyOf(turn.turnId) : undefined;
    persist("turns", { ...turn, _id: turn.turnId, round: t.negotiation.round ?? 0, ...(audioKey ? { audioKey } : {}) });
  }

  // ---------- O(1) lookups (SEC-015 / OPT-043 / OPT-044) ----------
  /**
   * joinCode → tripId, and pending headset-code HMAC → tripId. O2-027: every change goes through addTrip / removeTrip /
   * setJoinCode / setHeadset, so the indexes are always in step with `trips` (no rebuild).
   */
  private codeIndex = new Map<string, string>();
  private pairIndex = new Map<string, string>();
  /** Adds a voyage (new, restored or loaded on demand) with its join code and any pending headset code. */
  addTrip(t: TripRec) {
    this.trips.set(t._id, t);
    this.codeIndex.set(t.joinCode, t._id);
    if (t.headset?.codeHash) this.pairIndex.set(t.headset.codeHash, t._id);
  }
  /** Drops a voyage from the map and the indexes (not its members: see evictTrip). */
  removeTrip(t: TripRec) {
    if (t.headset?.codeHash) this.pairIndex.delete(t.headset.codeHash);
    if (this.codeIndex.get(t.joinCode) === t._id) this.codeIndex.delete(t.joinCode);
    this.trips.delete(t._id);
  }
  /** L5-010: the voyage gets a new join code. */
  setJoinCode(t: TripRec, joinCode: string) {
    if (this.codeIndex.get(t.joinCode) === t._id) this.codeIndex.delete(t.joinCode);
    t.joinCode = joinCode;
    this.codeIndex.set(joinCode, t._id);
  }
  /** The headset's pairing changes (a new code, a paired device, or none): a replaced code stops resolving. */
  setHeadset(t: TripRec, headset: TripRec["headset"]) {
    if (t.headset?.codeHash) this.pairIndex.delete(t.headset.codeHash);
    t.headset = headset;
    if (headset?.codeHash) this.pairIndex.set(headset.codeHash, t._id);
  }
  /** The voyage with this join code, or undefined (O(1)). */
  findByCode(code: string): TripRec | undefined {
    const c = String(code ?? "").toUpperCase();
    const t = this.trips.get(this.codeIndex.get(c) ?? "");
    return t && t.joinCode === c ? t : undefined;
  }
  /** The voyage a pending headset code's HMAC belongs to, or undefined (O(1)). */
  findByPairHash(codeHash: string): TripRec | undefined {
    return this.trips.get(this.pairIndex.get(codeHash) ?? "");
  }

  // ---------- members & auth ----------
  memberByToken(tripId: string, token?: string): MemberRec | null {
    if (!token || typeof token !== "string") return null;
    const t = this.trips.get(tripId);
    if (!t) return null;
    // members removed via "sail without them" lose their seat: no votes, hails or private replays
    for (const id of t.memberIds) {
      if (t.removedMemberIds.includes(id)) continue;
      const m = this.members.get(id);
      if (m && sameHash(token, m.tokenHash)) return m;
    }
    return null;
  }
  deviceOk(tripId: string, deviceToken?: string) {
    const t = this.trips.get(tripId);
    const h = t?.headset;
    if (!t || !h?.deviceTokenHash || typeof deviceToken !== "string" || !deviceToken) return false;
    // SEC-018: device tokens expire (12 h; tokens from older builds have no expiry and must re-pair) and end with the voyage
    if (!(Number(h.deviceExpiresAt) > Date.now()) || t.status === "BOOKED") return false;
    return sameHash(deviceToken, h.deviceTokenHash);
  }
  /**
   * TR4-001 / OPT-022: every member action checks the seat is still held, not just `trip:join`. A socket that joined
   * before "sail without them" keeps its memberId, so the service refuses it here. Returns the member.
   */
  requireActive(t: TripRec, memberId: string): MemberRec {
    const m = this.members.get(memberId);
    if (!m || !holdsSeat(t, memberId)) throw new HelmError("NOT_MEMBER", "You're not on this crew anymore.");
    return m;
  }
  /** Organizer-only actions accept the organizer (by id or token) or the paired headset. */
  private requireOrganizer(tripId: string, a: Actor) {
    const m = a.memberId ? this.members.get(a.memberId) : this.memberByToken(tripId, a.token);
    if ((m && m.tripId === tripId && m.role === "organizer") || this.deviceOk(tripId, a.deviceToken)) return;
    // R2-WP-07 / L2-002: a headset whose pairing ended (replaced, unpaired, 12 h TTL) is told to re-pair, not that the
    // organizer wearing it isn't the organizer. Once BOOKED the voyage is over and there is nothing to re-pair for.
    if (!m && a.deviceToken && this.trips.get(tripId)?.status !== "BOOKED") throw new HelmError("DEVICE_EXPIRED", JOIN_REFUSAL.DEVICE_EXPIRED);
    throw new HelmError("NOT_ORGANIZER", "Only the organizer can do that.");
  }
  /**
   * O2-010: an organizer action's voyage: the actor must be the organizer (or the paired headset, unless `phoneOnly`),
   * then the voyage must exist, then be in one of `phases`.
   */
  organizerTrip(tripId: string, actor: Actor, check: OrganizerCheck = {}): TripRec {
    if (check.phoneOnly !== undefined && !actor.memberId && !actor.token) throw new HelmError("NOT_ORGANIZER", check.phoneOnly);
    this.requireOrganizer(tripId, actor);
    const t = this.trip(tripId);
    if (check.phases && !check.phases.includes(t.status)) throw new HelmError("BAD_PHASE", check.phaseMessage ?? "Not right now.");
    return t;
  }
  /** O2-010: a member action's voyage and member: the voyage must exist, the seat be held, then the phase fit. */
  memberTrip(tripId: string, memberId: string, phases?: readonly TripStatus[], phaseMessage = "Not right now."): { t: TripRec; m: MemberRec } {
    const t = this.trip(tripId);
    const m = this.requireActive(t, memberId);
    if (phases && !phases.includes(t.status)) throw new HelmError("BAD_PHASE", phaseMessage);
    return { t, m };
  }
  /** Seats still held whose member doc exists (TR5-002: a dangling id never reaches a caller). */
  activeMembers(t: TripRec) {
    return t.memberIds.filter((id) => !t.removedMemberIds.includes(id)).map((id) => this.members.get(id)).filter((m): m is MemberRec => Boolean(m));
  }
  /** S2-002: no home airport — it fixes the member's flight price, which with the public plan narrows their share. */
  crewPublic(t: TripRec): CrewPublic[] {
    return this.activeMembers(t).map((m) => {
      const c: CrewPublic = { memberId: m._id, name: m.name, role: m.role, band: m.band, briefSealed: m.briefSealed };
      // L1-009 / S2-012: an invited seat (an absent friend, or a seat the organizer reset) says whether its link was
      // opened, so everyone sees a claim and the organizer stops offering a spent link
      if (m.role === "absent" || m.inviteKeyHash) c.inviteOpen = !m.inviteKeyHash;
      return c;
    });
  }

  // ---------- memory ----------
  /** SEC-003: memory is keyed on the member's private crew key; a seat without one recalls nothing. */
  memKey(m: MemberRec) { return m.crewKeyHash ? personKey(m.crewKeyHash, m.name) : null; }
  async memoryFor(m: MemberRec): Promise<string[]> { const k = this.memKey(m); return k ? recall(k) : []; }

  // ---------- eviction (SEC-015) ----------
  /**
   * Evicts idle voyages from memory with their members, briefs, caches, settled bookings and passkeys, and drops the
   * recomputable hot caches of voyages settled for 2 h. Idle means: BRIEFING > VOYAGE_IDLE_HOURS (R2-WP-11 / S2-006: a
   * lone BRIEFING voyage, ≤ 1 seat and no sealed terms, > VOYAGE_LONE_HOURS), BOOKED/VOIDED > VOYAGE_DONE_DAYS, and
   * (L5-008) DRY_RUN > VOYAGE_STALE_DAYS. AT_TABLE and SEALING are never touched (the table ends, a booking's deadline
   * voids it). With MongoDB an evicted voyage still opens by link or code (`hydrate`). Returns the evicted trip ids.
   */
  sweep(now = Date.now()): string[] {
    const { voyageIdleMs, voyageDoneMs, voyageLoneMs, voyageStaleMs } = config.limits;
    const evicted: string[] = [];
    for (const t of [...this.trips.values()]) {
      const idle = now - (Date.parse(t.updatedAt) || 0);
      const settled = t.status === "BOOKED" || t.status === "VOIDED";
      const lone = t.status === "BRIEFING" && idle > voyageLoneMs && this.activeMembers(t).length <= 1 && !this.activeMembers(t).some((m) => m.briefSealed);
      if ((t.status === "BRIEFING" && idle > voyageIdleMs) || lone || (settled && idle > voyageDoneMs) || (t.status === "DRY_RUN" && idle > voyageStaleMs)) {
        this.evictTrip(t);
        evicted.push(t._id);
      } else if (settled && idle > HOT_CACHE_MS) {
        this.dropHot(t._id);
      }
    }
    // O2-035: bookings whose voyage isn't in memory (orphans reloaded at boot, a voyage evicted while one was unsettled)
    // leave once they are settled
    const orphanTrips = new Set<string>();
    for (const b of this.payments.bookings.values()) if (!this.trips.has(b.tripId)) orphanTrips.add(b.tripId);
    for (const id of orphanTrips) this.payments.forget(id);
    for (const [m, at] of this.lastHailAt) if (now - at > HAIL_STAMP_KEEP_MS) this.lastHailAt.delete(m);
    for (const [code, id] of this.pairIndex) {
      const hs = this.trips.get(id)?.headset;
      if (!hs || hs.codeHash !== code || now >= hs.expiresAt) this.pairIndex.delete(code);
    }
    return evicted;
  }
  /** Drops a voyage's recomputable caches (chart book, privacy context, hails). */
  dropHot(tripId: string) {
    this.chartBooks.delete(tripId);
    this.privacy.delete(tripId);
    this.liveInventory.delete(tripId);
    this.pendingHails.delete(tripId);
    this.hailsClosed.delete(tripId);
  }
  /**
   * O2-035 / L4-010 / S2-011: settled bookings go too (`payments.forget` keeps any booking that isn't final or still
   * owes a release or refund), and the members' passkeys, claims and challenges leave memory (reloaded per member when
   * the voyage is loaded again). Standing instructions are dropped first, so the provider may forget their records.
   */
  private evictTrip(t: TripRec) {
    this.dropHot(t._id);
    this.debugLog.delete(t._id);
    const ids = [...new Set([...t.memberIds, ...t.removedMemberIds])];
    for (const id of ids) {
      this.members.delete(id);
      this.briefs.delete(id);
      this.lastHailAt.delete(id);
      this.payments.standing.delete(id);
    }
    this.payments.forget(t._id);
    evictPasskeys(ids);
    this.removeTrip(t);
  }
}
