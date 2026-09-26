/**
 * Persistence & restore (OPT-031): boot restore with per-voyage repair, booking reconciliation and standing
 * instructions; the reconnect sync; on-demand loading of archived voyages (`hydrate`) and the lookups that use it.
 */
import { adoptPack } from "../world/packs.js";
import type { Turn } from "@all-ayes/shared";
import { REASONS, STANDING_TTL_MS, type BookingRec, type StoredStanding } from "../payments/orchestrator.js";
import { loadPasskeysFor, persistAllPasskeys } from "../passkeys/passkeys.js";
import { restoreTurnAudio } from "../voice/voice.js";
import { useMongoMemory } from "../memory/memory.js";
import { dbConnected, dbHealth, loadWhere, onDbConnected, persist, type BookingDoc, type EventDoc, type TurnDoc } from "../store/db.js";
import { HelmError } from "../util/errors.js";
import { DAY_MS, Lru } from "../util/limits.js";
import { config } from "../config.js";
import {
  DEBUG_ROWS_PER_TRIP, HYDRATE_MISS_MAX, HYDRATE_MISS_TTL_MS, REASON_CHARTS_CHANGED, REASON_TABLE_RESTART,
  REASON_TERMS_MISSING, SHORTLIST_PHASES, datasetHash, tripDoc,
  type BriefRec, type MemberRec, type ShortlistDoc, type TripRec,
} from "./records.js";
import type { Helm } from "./core.js";

type Lookup = { tripId?: string; joinCode?: string };

/**
 * L5-007: what is stored of an absent member's standing instruction: its ref and ORIGINAL expiry, never the limit
 * (that is their private cap, stored only in their brief; restore re-derives it from there). The in-memory
 * instruction (payments.standing) keeps the limit.
 */
export function storedStanding(ins: StoredStanding): StoredStanding {
  return { memberId: ins.memberId, instructionRef: ins.instructionRef, expiresAt: ins.expiresAt };
}

export class Persistence {
  constructor(private helm: Helm) {}
  private hydrating = new Map<string, Promise<TripRec | undefined>>();
  /** R2-WP-12 (S2-007): an LRU, so cycling past HYDRATE_MISS_MAX ids forgets the oldest misses, not all of them. */
  private hydrateMisses = new Lru<string, number>(HYDRATE_MISS_MAX);

  // ---------- lookups ----------
  trip(tripId: string): TripRec {
    const t = this.helm.trips.get(tripId);
    if (!t) return this.missing({ tripId }, new HelmError("NO_TRIP", "That voyage doesn't exist."));
    return t;
  }
  tripByCode(code: string): TripRec {
    const t = this.helm.findByCode(code);
    if (!t) return this.missing({ joinCode: code }, new HelmError("NO_TRIP", "No voyage with that code."));
    return t;
  }
  /**
   * Sync lookups that miss start loading an archived voyage; the caller is told to try again (503). L5-004: while
   * MongoDB is configured but unreachable (reconnecting), a stored voyage may well exist, so the answer is the same
   * retryable 503 LOADING, never a 404 that tells the phone the voyage doesn't exist.
   */
  private missing(q: Lookup, notFound: HelmError): never {
    if (dbConnected() && !this.recentMiss(missKey(q))) {
      void this.hydrate(q).catch((e) => console.warn("[helm] archived voyage load failed", e));
      throw new HelmError("LOADING", "Fetching that voyage from the ship's log. Try again in a moment.");
    }
    const mode = dbConnected() ? "mongo" : dbHealth().mode;
    if (mode === "reconnecting" || mode === "unavailable") {
      throw new HelmError("LOADING", "The ship's log is out of reach for a moment. Try again shortly.");
    }
    throw notFound;
  }
  private recentMiss(key: string) { return (this.hydrateMisses.peek(key) ?? 0) > Date.now(); }

  /**
   * TR5-016 / WP-10: a voyage that was archived at boot (BOOKED/VOIDED and older than RESTORE_RECENT_DAYS, or evicted
   * by the sweep) is loaded on demand, by id or join code. Callers that can wait (REST by-code, socket trip:join)
   * should `await helm.hydrate(...)` before the sync `trip()`/`tripByCode()`, so nobody sees the 503 LOADING retry.
   * Resolves with the voyage, or undefined when there is none (or MongoDB is off). Misses are remembered for a
   * minute so a bad code doesn't hit the database each time; concurrent calls for the same key share one load.
   */
  async hydrate(q: Lookup): Promise<TripRec | undefined> {
    const code = q.joinCode ? String(q.joinCode).toUpperCase() : "";
    const inMem = q.tripId ? this.helm.trips.get(q.tripId) : code ? this.helm.findByCode(code) : undefined;
    if (inMem || !dbConnected() || (!q.tripId && !code)) return inMem;
    const key = missKey(q);
    if (this.recentMiss(key)) return undefined;
    let p = this.hydrating.get(key);
    if (!p) {
      p = (async () => {
        const docs = await loadWhere<TripRec>("trips", q.tripId ? { _id: q.tripId } : { joinCode: code }, { limit: 1 });
        const loaded = await this.loadVoyages(docs);
        await this.settleRestored(loaded);
        const t = loaded.trips[0];
        if (!t) {
          this.hydrateMisses.set(key, Date.now() + HYDRATE_MISS_TTL_MS);
        }
        return t;
      })().finally(() => this.hydrating.delete(key));
      this.hydrating.set(key, p);
    }
    return p;
  }

  // ---------- boot ----------
  /**
   * Boot: reloads the live voyages (TR5-016: every voyage that isn't BOOKED/VOIDED, plus the ones touched in the last
   * RESTORE_RECENT_DAYS; older ones stay in MongoDB and are loaded on demand by `hydrate`), their members, briefs,
   * bookings, turns and recent debug events. Unsettled bookings are loaded whatever their voyage, so no hold is
   * forgotten. Each voyage is restored on its own: a broken one is logged and skipped, never stops the boot (TR5-002).
   * With `merge` (MongoDB came back after a failed boot connect) voyages already in memory win.
   * R2-WP-11 (L5-008): a BRIEFING or DRY_RUN voyage untouched for VOYAGE_STALE_DAYS isn't loaded at boot (it still
   * opens by link or code); AT_TABLE and SEALING always are (they need their restart repair).
   */
  async restore(opts: { merge?: boolean } = {}) {
    onDbConnected(() => this.syncAfterReconnect());
    const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
    const recent = iso(config.helm.restoreRecentDays() * DAY_MS);
    const stale = iso(config.limits.voyageStaleMs);
    const docs = await loadWhere<TripRec>("trips", { $or: [
      { status: { $in: ["AT_TABLE", "SEALING"] } },
      { status: { $in: ["BRIEFING", "DRY_RUN"] }, updatedAt: { $gte: stale } },
      { updatedAt: { $gte: recent } },
    ] });
    const before = opts.merge ? [...this.helm.members.keys()] : [];
    const loaded = await this.loadVoyages(docs, true);
    // WP-05: registered passkeys survive a restart, so the seal gate still holds (loadVoyages loads those of the
    // voyages it restores). L5-003: the reconnect merge also loads them for the voyages already in memory
    // (idempotent per credential id), before syncAfterReconnect writes what is in memory
    if (before.length) await loadPasskeysFor(before);
    await this.settleRestored(loaded);
    if (loaded.trips.length) console.log(`[helm] restored ${loaded.trips.length} voyages from MongoDB`);
  }

  /**
   * TR5-007: MongoDB came back after the boot connect failed. Stored voyages not in memory are merged in, then what
   * was held in memory before the merge is written (the write queue orders and coalesces it), passkeys included
   * (WP-10). R2-WP-11 (O2-035): only that: every write made while the database was away was dropped, so those
   * records are the dirty ones; what the merge just read from MongoDB (and anything the merge changed, which
   * persisted itself) isn't written back.
   */
  async syncAfterReconnect() {
    const { helm } = this;
    const dirty = {
      trips: new Set(helm.trips.keys()), members: new Set(helm.members.keys()), briefs: new Set(helm.briefs.keys()),
      bookings: new Set(helm.payments.bookings.keys()),
    };
    await this.restore({ merge: true });
    // L5-003: memory written to local files while MongoDB was away moves into it, and later writes go there
    await useMongoMemory().catch((e) => console.warn("[memory] moving local memory into MongoDB failed", (e as Error).message));
    for (const id of dirty.trips) {
      const t = helm.trips.get(id);
      if (!t) continue;
      persist("trips", tripDoc(t));
      helm.persistShortlist(t);
      for (const turn of t.negotiation.turns) helm.persistTurn(t, turn);
    }
    for (const id of dirty.members) { const m = helm.members.get(id); if (m) persist("members", m); }
    for (const id of dirty.briefs) { const b = helm.briefs.get(id); if (b) persist("briefs", b); }
    for (const id of dirty.bookings) { const b = helm.payments.bookings.get(id); if (b) helm.persistBooking(b); }
    persistAllPasskeys();
  }

  /**
   * Loads the given trip docs (and everything hanging off them) that aren't in memory yet.
   * O2-039: loaded docs are already normalized by the loader (`loadWhere` strips nulls), and only each voyage's
   * current round of turns is read.
   */
  private async loadVoyages(raw: TripRec[], unsettledBookings = false) {
    const { helm } = this;
    const fresh = raw.filter((d) => d?._id && !helm.trips.has(d._id));
    const ids = fresh.map((t) => t._id);
    const byTrip = { tripId: { $in: ids } };
    const none = <T>() => Promise.resolve([] as T[]);
    const [members, briefs, bookings, turns, events, shortlists] = await Promise.all([
      ids.length ? loadWhere<MemberRec>("members", byTrip).then(async (ms) => {
        // R2-WP-11: the passkeys of these members only (never the whole collection), loaded before any voyage is
        // visible, so the seal gate holds from the first request
        await loadPasskeysFor(ms.map((m) => m?._id));
        return ms;
      }) : none<MemberRec>(),
      ids.length ? loadWhere<BriefRec>("briefs", byTrip) : none<BriefRec>(),
      // unsettled attempts of any voyage (TR5-001/TR5-006): their holds must be released whatever else is archived
      unsettledBookings
        ? loadWhere<BookingDoc>("bookings", { $or: [byTrip, { status: { $nin: ["CAPTURED", "VOIDED"] } }, { needsAttention: true }] })
        : ids.length ? loadWhere<BookingDoc>("bookings", byTrip) : none<BookingDoc>(),
      // O2-039: the current round's turns only (older rounds are deleted by the next table: R2-WP-11, L5-008)
      ids.length ? loadWhere<TurnDoc>("turns", currentRounds(fresh)) : none<TurnDoc>(),
      eventsPerVoyage(ids),
      // O2-036: the Two Charts' plan bodies (older trip docs embed them)
      ids.length ? loadWhere<ShortlistDoc>("shortlists", { _id: { $in: ids } }) : none<ShortlistDoc>(),
    ]);
    for (const m of members) if (!helm.members.has(m._id)) helm.members.set(m._id, m);
    for (const b of briefs) if (!helm.briefs.has(b.memberId)) helm.briefs.set(b.memberId, b);
    const newBookings: BookingRec[] = [];
    for (const d of bookings) {
      if (!d?._id || helm.payments.bookings.has(d._id)) continue;
      // L5-009: one malformed booking doc is logged and skipped; it never stops the boot
      let b: BookingRec;
      try { b = this.bookingFromDoc(d); } catch (e) {
        console.error(`[helm] booking ${d._id} could not be restored; skipped`, (e as Error).message);
        continue;
      }
      helm.payments.bookings.set(b._id, b);
      newBookings.push(b);
    }
    this.hydrateDebugLog(events.reverse());
    const turnsByTrip = new Map<string, TurnDoc[]>();
    for (const d of turns) {
      const list = turnsByTrip.get(d.tripId);
      if (list) list.push(d); else turnsByTrip.set(d.tripId, [d]);
    }
    const shortlistOf = new Map(shortlists.map((d) => [d._id, d]));
    const trips: TripRec[] = [];
    for (const doc of fresh) {
      try {
        const stored = turnsByTrip.get(doc._id) ?? [];
        const t = normalizeTrip(doc, stored);
        // docs/11: generated ports travel with their voyage; re-added (validated, no network) before any plan is built
        for (const p of t.worldPacks ?? []) await adoptPack(p);
        // LEGACY (O2-036): plans embedded in an older trip doc move to their own doc (the next trip save drops them)
        if (attachShortlist(t, shortlistOf.get(t._id)) === "embedded") helm.persistShortlist(t);
        await restoreAudio(t.negotiation.turns, stored);
        helm.addTrip(t);
        this.repairTrip(t);
        trips.push(t);
      } catch (e) {
        const partial = helm.trips.get(doc._id);
        if (partial) helm.removeTrip(partial);
        console.error(`[helm] voyage ${doc._id} could not be restored; skipped`, e);
      }
    }
    return { trips, bookings: newBookings };
  }

  /** Standing instructions, booking reconciliation, auto-pick timers, charts; then orphan bookings (TR5-001). */
  private async settleRestored(loaded: { trips: TripRec[]; bookings: BookingRec[] }) {
    const { helm } = this;
    for (const t of loaded.trips) {
      try {
        await this.restoreStanding(t);
        await this.reconcileBooking(t);
        this.checkCharts(t);
        if (t.status === "DRY_RUN" && t.autoPick) helm.dryrun.armAutoPick(t, t.autoPick.planId, Math.max(0, t.autoPick.at - Date.now()));
      } catch (e) {
        console.error(`[helm] voyage ${t._id} restored with errors`, e);
      }
    }
    // a booking no voyage points at (its trip write was lost): release its holds and void it (TR5-001)
    const referenced = new Set([...helm.trips.values()].map((t) => t.bookingId));
    for (const b of loaded.bookings) {
      if (referenced.has(b._id)) continue;
      await helm.payments.recover(b).catch((e) => console.warn(`[helm] orphan booking ${b._id} recovery failed`, e));
    }
  }

  /**
   * TR5-002: partial writes must not crash the boot or every trip:join. Members whose doc is missing are dropped
   * from the crew; a member marked briefSealed without a brief doc is unsealed, and a voyage past BRIEFING that now
   * lacks terms goes back to BRIEFING (unless a booking decides it). TR5-021: a table interrupted by the restart goes
   * back to BRIEFING, is saved, and says so on the next join.
   */
  private repairTrip(t: TripRec) {
    const { helm } = this;
    let changed = false;
    const missing = [...new Set([...t.memberIds, ...t.removedMemberIds])].filter((id) => helm.members.get(id)?.tripId !== t._id);
    if (missing.length) {
      console.warn(`[helm] voyage ${t._id}: member doc(s) missing (${missing.join(", ")}); dropped from the crew`);
      t.memberIds = t.memberIds.filter((id) => !missing.includes(id));
      t.removedMemberIds = t.removedMemberIds.filter((id) => !missing.includes(id));
      for (const id of missing) delete t.votes[id];
      changed = true;
    }
    if (!helm.members.has(t.organizerId)) console.error(`[helm] voyage ${t._id}: organizer ${t.organizerId} is missing; organizer actions need the headset`);
    let unsealed = false;
    for (const m of helm.activeMembers(t)) {
      if (m.briefSealed && !helm.briefs.has(m._id)) {
        console.warn(`[helm] voyage ${t._id}: ${m._id} is marked sealed but has no brief; unsealing`);
        m.briefSealed = false;
        persist("members", m);
        unsealed = true;
      }
    }
    if (t.status === "AT_TABLE") {
      helm.table.resetTable(t, REASON_TABLE_RESTART);
      changed = true;
    } else if (unsealed && (t.status === "DRY_RUN" || t.status === "VOIDED")) {
      helm.table.backToBriefing(t, ["DRY_RUN", "VOIDED"], REASON_TERMS_MISSING, "terms missing after restore");
      changed = true;
    }
    if (changed) helm.save(t);
  }

  /**
   * TR5-022: the charts were priced from the dataset at the time. The stored Two Charts (shortlistPlans) win over a
   * changed dataset; a drift is logged. A voyage in DRY_RUN whose two charts can't be resolved at all (older doc,
   * changed dataset) goes back to BRIEFING with a reason instead of failing on pick. L4-007 (second half): so does a
   * VOIDED one, whose "back to the charts" would otherwise offer charts that are gone.
   */
  private checkCharts(t: TripRec) {
    const { helm } = this;
    const current = datasetHash(helm.ds);
    if (t.datasetHash && t.datasetHash !== current && SHORTLIST_PHASES.includes(t.status)) {
      console.warn(`[helm] voyage ${t._id}: dataset changed since it was charted (${t.datasetHash.slice(0, 8)} → ${current.slice(0, 8)}); ${t.shortlistPlans?.length ? "keeping its stored plan prices" : "no stored plans"}`);
    }
    if ((t.status === "DRY_RUN" || t.status === "VOIDED") && helm.table.shortlist(t).length !== 2) {
      console.warn(`[helm] voyage ${t._id}: its two charts no longer resolve; back to BRIEFING`);
      helm.table.backToBriefing(t, ["DRY_RUN", "VOIDED"], REASON_CHARTS_CHANGED, "charts missing after restore");
      helm.save(t);
    }
  }

  /** Bookings are stored without caps (TR5-015); the cap comes back from the member's brief. */
  private bookingFromDoc(d: BookingDoc): BookingRec {
    return {
      ...d,
      // LEGACY (remove once no booking doc from before TR5-015 is unsettled): such docs still carry capCents; the brief wins
      seals: d.seals.map((s) => ({ ...s, capCents: this.helm.briefs.get(s.memberId)?.capCents ?? (s as { capCents?: number }).capCents ?? s.amountCents })),
    };
  }

  /** O2-006: events have a 30-day TTL, so every stored row has this build's shape (docs/04 §4.8). */
  private hydrateDebugLog(rows: EventDoc[]) {
    for (const e of rows) {
      const at = e.at instanceof Date ? e.at.toISOString() : String(e.at ?? "");
      this.helm.pushDebug(e.tripId, { at, event: e.type ?? "?", audience: this.helm.audienceLabel(e.audience ?? ""), summary: e.payloadRedacted ?? "" });
    }
  }

  /**
   * SEC-009: an absent member's standing instruction comes back with its ORIGINAL expiry and is never re-issued at
   * boot. Expired ones (and those of booked voyages) are dropped, so that member seals live. Docs from older builds
   * without `standing` derive the expiry from when the brief was sealed. L5-007: the limit comes from the brief (the
   * stored instruction has none); a doc that still carries one is rewritten without it, and a dropped instruction is
   * unset in the database too.
   */
  private async restoreStanding(t: TripRec) {
    const { helm } = this;
    for (const m of helm.activeMembers(t)) {
      if (m.role !== "absent") continue;
      const brief = helm.briefs.get(m._id);
      try {
        if (t.status === "BOOKED" || !brief) {
          helm.payments.standing.delete(m._id);
          if (m.standing) { m.standing = undefined; persist("members", m); }
          continue;
        }
        if (m.standing) {
          const live = await helm.payments.restoreStanding({ ...m.standing, limitCents: brief.capCents });
          if (!live) { m.standing = undefined; persist("members", m); }
          else if ("limitCents" in m.standing) { m.standing = storedStanding(m.standing); persist("members", m); }
          continue;
        }
        const expiresAt = Date.parse(brief.sealedAt ?? "") + STANDING_TTL_MS;
        if (!(expiresAt > Date.now())) continue;
        const ins = await helm.payments.createStanding(m._id, brief.capCents, expiresAt);
        if (ins) { m.standing = storedStanding(ins); persist("members", m); }
      } catch (e) {
        console.warn(`[helm] standing instruction for ${m._id} not restored`, (e as Error).message);
      }
    }
  }

  /**
   * TR5-001: the trip follows its booking. A final booking whose trip write was lost settles the trip (CAPTURED →
   * BOOKED, VOIDED → VOIDED); a live one is recovered (in-flight auths died with the old process), which settles the
   * trip through onBookingResult; unfinished releases/refunds are re-driven (TR5-006).
   * L5-006: a SEALING trip settles through onBookingResult like a live outcome (lastResult with a public reason, the
   * save, the memory notes). R2-WP-02 (collect, then settle): a booking restored mid-gathering (seals set, nothing
   * authorized) or mid-settle (settleAt passed or not, some authorizations answered) is voided with the restart
   * reason and published at once (the settle point isn't held across a restart); requested-but-unanswered
   * authorizations are asked again with their key and released. An ALL_AUTHORIZED one re-drives its captures.
   */
  private async reconcileBooking(t: TripRec) {
    const { helm } = this;
    const b = helm.sealing.currentBooking(t);
    if (!b) {
      if (t.status === "SEALING") {
        helm.transition(t, "VOIDED", { reason: "restart: no booking record" });
        t.lastResult = { bookingId: t.bookingId ?? "", publicReason: REASONS.restarted };
        helm.save(t);
      }
      return;
    }
    if (b.status === "CAPTURED" || b.status === "VOIDED") {
      const settled = b.status === "CAPTURED" ? "BOOKED" : "VOIDED";
      if (t.status === "SEALING") {
        helm.sealing.onBookingResult(b, b.status, b.status === "VOIDED" ? restoredVoidReason(b) : undefined);
      } else if ((t.status === "BOOKED" && settled === "VOIDED") || (t.status === "VOIDED" && settled === "BOOKED")) {
        helm.transition(t, settled, { from: ["SEALING", "BOOKED", "VOIDED"], reason: "restart: the booking record decides" });
        helm.save(t);
      }
      await helm.payments.redrive(b).catch((e) => console.warn(`[helm] booking ${b._id} re-drive failed`, e));
      return;
    }
    await helm.payments.recover(b);
    if (t.status === "SEALING") { // recovery settled without us (defensive)
      helm.transition(t, "VOIDED", { from: ["SEALING"], reason: "restart: recovery" });
      t.lastResult = { bookingId: b._id, publicReason: REASONS.restarted };
      helm.save(t);
    }
  }
}

/**
 * L5-006: the public reason of a VOIDED booking whose trip write was lost. The reason itself isn't stored; money that
 * was captured says whether it came back, and otherwise the restart is what the crew sees (nobody was charged).
 */
function restoredVoidReason(b: BookingRec): string {
  const captured = b.seals.filter((s) => s.capturedAt);
  if (!captured.length) return REASONS.restarted;
  return captured.every((s) => s.refundedAt) && !b.needsAttention ? REASONS.refunded : REASONS.refundPending;
}

/**
 * R2-WP-11 (L5-008): each voyage's latest debug events on its own (a busy voyage can't crowd the others out of a
 * shared limit), a few voyages at a time, oldest first.
 */
async function eventsPerVoyage(ids: string[]): Promise<EventDoc[]> {
  const out: EventDoc[] = [];
  for (let i = 0; i < ids.length; i += EVENT_LOAD_BATCH) {
    const lists = await Promise.all(ids.slice(i, i + EVENT_LOAD_BATCH).map((tripId) =>
      loadWhere<EventDoc>("events", { tripId }, { sort: { at: -1 }, limit: DEBUG_ROWS_PER_TRIP })));
    for (const l of lists) out.push(...l);
  }
  return out;
}
const EVENT_LOAD_BATCH = 16;

/**
 * O2-039: each voyage's current round of turns (`negotiation.round`, 0 when absent). LEGACY: round-0 turns written
 * without a `round` field still match.
 */
function currentRounds(trips: TripRec[]): Record<string, unknown> {
  return { $or: trips.map((t) => {
    const round = t.negotiation?.round ?? 0;
    return round === 0 ? { tripId: t._id, $or: [{ round: 0 }, { round: { $exists: false } }] } : { tripId: t._id, round };
  }) };
}

/**
 * O2-036: the stored Two Charts come back with the voyage while they belong to its current decision (same round, same
 * two plan ids). LEGACY: a trip doc that still embeds `shortlistPlans` keeps them. Otherwise the charts resolve from the
 * chart book (and a voyage whose charts no longer resolve goes back to BRIEFING: checkCharts).
 */
function attachShortlist(t: TripRec, d: ShortlistDoc | undefined): "embedded" | "stored" | "none" {
  if (t.shortlistPlans?.length) return d ? "stored" : "embedded";
  if (!d || !t.shortlistIds) return "none";
  if ((d.round ?? 0) !== (t.negotiation.round ?? 0) || d.planIds?.[0] !== t.shortlistIds[0] || d.planIds?.[1] !== t.shortlistIds[1]) return "none";
  if (d.plans?.length !== 2) return "none";
  t.shortlistPlans = d.plans;
  return "stored";
}

const missKey = (q: Lookup) => (q.tripId ? `id:${q.tripId}` : `code:${String(q.joinCode ?? "").toUpperCase()}`);

/**
 * Re-attaches the current meeting's turns (TR5-012), and fills fields older builds didn't write.
 * O2-006 — LEGACY trip shapes (review by 2027-03-31): the `??=` defaults and pre-TR5-012 embedded turns only matter
 * for trip docs written before those fields existed; they cost nothing for current docs. A one-time migration that
 * rewrites the stored docs would let them go (it writes to MongoDB, so it is a deploy step, not done at boot).
 */
function normalizeTrip(t: TripRec, turns: TurnDoc[]): TripRec {
  t.memberIds ??= []; t.removedMemberIds ??= []; t.votes ??= {}; t.attempt ??= 0; t.autoPick ??= null;
  t.candidateCityIds ??= [];
  t.version ??= 0;
  t.negotiation ??= { watch: 0, running: false, seq: 0, turns: [] };
  t.negotiation.round ??= 0;
  t.negotiation.seq ??= 0; t.negotiation.watch ??= 0; t.negotiation.running ??= false;
  const round = t.negotiation.round;
  const stored = turns.filter((d) => (d.round ?? 0) === round).sort((a, b) => a.seq - b.seq)
    .map(({ _id, round: _r, audioKey: _k, ...turn }) => ({ ...turn, turnId: turn.turnId ?? _id }) as Turn);
  // documents from before TR5-012 embed their turns; newer ones keep them in `turns`
  t.negotiation.turns = t.negotiation.turns?.length ? t.negotiation.turns : stored;
  if (t.dryrun) t.dryrun.pausedAt ??= null;
  return t;
}

/**
 * WP-07 follow-up: a restored turn's voice is served again from the TTS cache when its file is still there; when
 * it isn't (pruned, wiped, or a doc from before the key was stored), the turn loses its audioUrl so clients show
 * captions instead of fetching a 404.
 */
async function restoreAudio(turns: Turn[], docs: TurnDoc[]) {
  const keys = new Map(docs.map((d) => [d.turnId ?? d._id, d.audioKey]));
  await Promise.all(turns.filter((turn) => turn.audioUrl).map(async (turn) => {
    const key = keys.get(turn.turnId);
    if (key && (await restoreTurnAudio(turn.turnId, key))) return;
    turn.audioUrl = undefined;
    turn.durationMs = undefined;
  }));
}
