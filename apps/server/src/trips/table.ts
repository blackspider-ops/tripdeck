/**
 * The table (OPT-031): the chart book and its privacy context, the Two Charts, the negotiation engine's wiring,
 * and hails.
 */
import type { Plan, PlanPublic, TripStatus, Turn } from "@all-ayes/shared";
import { HAIL_MAX_CHARS, MAX_WATCHES, MIN_TABLE_CREW, availableFor, monthDayLabel, stateName } from "@all-ayes/shared";
import { cityName, indexOf } from "../data/loader.js";
import { buildChartBook, buildPlan, planHotel, toPrivate, toPublic, type PricingMember } from "../fit/pricing.js";
import { pickPorts } from "../fit/prerank.js";
import { findWindows } from "../fit/windows.js";
import { destinationLabel, scopeOf, tripWindows } from "./course.js";
import { NegotiationEngine, type EngineIO } from "../negotiation/engine.js";
import type { PrivacyContext } from "../privacy/filter.js";
import { buildPrivacyContext } from "../privacy/context.js";
import { sanitizeHail } from "../privacy/guard.js";
import { synthesize } from "../voice/voice.js";
import { deleteOldTurns } from "../store/db.js";
import { config } from "../config.js";
import { HelmError, slow } from "../util/errors.js";
import { newId, nowIso } from "../util/ids.js";
import { RIBBON_MAX_WORDS, clampWords, clean } from "../util/text.js";
import {
  FIRST_HAIL_WATCH, HAIL_MIN_INTERVAL_MS, REASON_TABLE_FAILED, REASON_TABLE_RESTART, datasetHash, tripWindowIds,
  type Actor, type TripRec,
} from "./records.js";
import type { Helm } from "./core.js";

/**
 * The chart book is the top 12 plans (doc 05 §2.6); at most 60 candidates exist (3 windows × 4 ports × 5 stays; a
 * region / anywhere voyage is pre-ranked down to 4 ports first).
 */
const CHART_BOOK_LIMIT = 12;

export class Table {
  constructor(private helm: Helm) {}

  /** OPT-018: the A/B public views, built once per pair of plans. */
  private publicViews = new WeakMap<Plan, { b: Plan; views: PlanPublic[] }>();

  // ---------- the chart book ----------
  pricingCrew(t: TripRec): PricingMember[] {
    // a date-range voyage: each member "can do" the generated windows they're free for every day of (private; a
    // window they can't make is a date_mismatch on their own share, like any term it breaks)
    const windows = t.dateRange ? tripWindows(this.helm.ds, t) : null;
    // TR5-002: a member without a brief doc isn't priced (restore unseals them and the voyage returns to BRIEFING)
    return this.helm.activeMembers(t).flatMap((m) => {
      const sealed = this.helm.briefs.get(m._id);
      if (!sealed) return [];
      const brief = windows
        ? { ...sealed, dateWindowIds: windows.filter((w) => availableFor(sealed.availability, w.start, w.end)).map((w) => w.id) }
        : sealed;
      return [{ memberId: m._id, name: m.name, role: m.role, origin: m.origin, brief }];
    });
  }

  /** A date-range voyage's generated windows (the chart book counts these instead of the dataset's); else undefined. */
  offered(t: TripRec): string[] | undefined {
    return t.dateRange ? tripWindowIds(t) : undefined;
  }

  /**
   * A date-range voyage: the up-to-3 windows for the seated crew's availability (fit/windows.ts), kept on the voyage.
   * Called when the last terms seal (so live prices can be fetched for them) and again when the table meets. Returns
   * whether they changed.
   */
  generateWindows(t: TripRec): boolean {
    if (!t.dateRange) return false;
    const briefs = this.helm.activeMembers(t).map((m) => this.helm.briefs.get(m._id)?.availability);
    const ids = findWindows(t.dateRange, briefs).map((w) => w.id);
    if (JSON.stringify(ids) === JSON.stringify(t.candidateWindowIds ?? [])) return false;
    t.candidateWindowIds = ids;
    return true;
  }

  /**
   * The chart book and the table's one privacy context, built together from exactly these plans and shared by the
   * engine, the hail filter and prompts (OPT-013 / TR4-012). Either missing (a restore, the sweep) rebuilds both.
   */
  chartBook(t: TripRec, crew?: PricingMember[]): Plan[] {
    let book = this.helm.chartBooks.get(t._id);
    if (!book || !this.helm.privacy.has(t._id)) {
      const priced = crew ?? this.pricingCrew(t);
      // docs/12: live (RouteStack) stays and fares that have landed for this voyage are preferred; the rest is estimated
      let built = buildChartBook(this.helm.ds, priced, t.candidateCityIds, CHART_BOOK_LIMIT, this.helm.live.inventory(t), this.offered(t));
      // TR5-022: the Two Charts keep the prices they were decided at, even if the dataset changed since
      if (t.shortlistPlans?.length) {
        const stored = new Map(t.shortlistPlans.map((p) => [p._id, p]));
        const inBook = new Set(built.map((p) => p._id));
        built = [...built.map((p) => stored.get(p._id) ?? p), ...t.shortlistPlans.filter((p) => !inBook.has(p._id))];
      }
      book = built;
      this.helm.chartBooks.set(t._id, book);
      this.helm.privacy.set(t._id, buildPrivacyContext(this.helm.ds, priced, book));
    }
    return book;
  }
  /**
   * docs/12: live prices landed while the table is still arguing: each plan of the chart book is priced again on the
   * same port, window and stay with the voyage's live fares (the engine holds this same array, so the Advocates and
   * the Captain see the new numbers), and the privacy context gains the new secrets without losing the old ones.
   * While the Captain is still opening (Watch 0, no plan named yet) the whole book is rebuilt, live stays included.
   * Only while AT_TABLE and before the Captain decides (hails closed): never during the Dry Run or after the pick, so
   * the Two Charts' private shares stay the ones sealed. From Watch 1 on, a plan's identity (port, window, stay)
   * never changes: new live stays wait for the next meeting. Returns how many plans changed.
   */
  repriceLive(t: TripRec): number {
    const { helm } = this;
    if (t.status !== "AT_TABLE" || !t.negotiation.running || helm.hailsClosed.has(t._id)) return 0;
    const book = helm.chartBooks.get(t._id), ctx = helm.privacy.get(t._id), live = helm.live.inventory(t);
    if (!book || !ctx || !live) return 0;
    const crew = this.pricingCrew(t);
    let changed = 0;
    if (t.negotiation.watch === 0) {
      // the Captain is still opening (ports and dates only): no plan has been named yet, so the whole chart book may
      // be built again — live stays included. The engine holds this array, so it is refilled in place.
      const rebuilt = buildChartBook(helm.ds, crew, t.candidateCityIds, CHART_BOOK_LIMIT, live, this.offered(t));
      if (JSON.stringify(rebuilt) !== JSON.stringify(book)) { changed = rebuilt.length; book.splice(0, book.length, ...rebuilt); }
    } else for (let i = 0; i < book.length; i++) {
      const p = book[i];
      const q = buildPlan(helm.ds, crew, p.cityId, p.dateWindowId, planHotel(helm.ds, p), live);
      if (q._id !== p._id || JSON.stringify(q) === JSON.stringify(p)) continue;
      book[i] = q;
      changed++;
    }
    if (changed) {
      Object.assign(ctx, buildPrivacyContext(helm.ds, crew, book, ctx.sensitiveDollars));
      console.log(`[live] voyage ${t._id}: re-priced ${changed} of ${book.length} charts before the Dry Run (${book.filter((p) => p.priceSource === "live").length} live)`);
    }
    return changed;
  }

  /** The table's privacy context (built with the chart book if a restore left it unset: OPT-064). */
  privacyOf(t: TripRec): PrivacyContext {
    this.chartBook(t);
    const ctx = this.helm.privacy.get(t._id);
    if (!ctx) throw new HelmError("INTERNAL", "The table's privacy context is missing.");
    return ctx;
  }
  /** OPT-020: a plan of this voyage's chart book by id, or undefined. */
  planOf(t: TripRec, planId: string | undefined): Plan | undefined {
    return planId ? this.chartBook(t).find((p) => p._id === planId) : undefined;
  }
  /** The Two Charts, in A/B order (empty before the table decided). */
  shortlist(t: TripRec): Plan[] {
    if (!t.shortlistIds) return [];
    return t.shortlistIds.map((id) => this.planOf(t, id)).filter((p): p is Plan => Boolean(p));
  }
  /** OPT-018: the one builder of the public A/B pair (table:decided live and on replay). */
  publicShortlist(t: TripRec): PlanPublic[] | undefined {
    const [a, b] = this.shortlist(t);
    if (!a || !b) return undefined;
    const memo = this.publicViews.get(a);
    if (memo?.b === b) return memo.views;
    const views = [toPublic(this.helm.ds, a, "A"), toPublic(this.helm.ds, b, "B")];
    this.publicViews.set(a, { b, views });
    return views;
  }

  /**
   * The chosen plan's window once there is one; before that, a window everyone can do — or null when
   * there is none, so the Captain never claims a common window that doesn't exist (TR4-005).
   */
  datesLabel(t: TripRec, crew?: PricingMember[]): string | null {
    return this.dates(t, crew)?.label ?? null;
  }

  /**
   * The dates the Captain may name and who they suit — counts only ("everyone", "most of the crew"), never names.
   * A date-range voyage whose windows suit no one fully but more than half the crew says "most of the crew".
   */
  dates(t: TripRec, crew?: PricingMember[]): { label: string; who: "everyone" | "most of the crew" } | null {
    const chosen = this.planOf(t, t.chosenPlanId);
    const priced = crew ?? (chosen ? [] : this.pricingCrew(t));
    const can = (id: string) => priced.filter((c) => c.brief.dateWindowIds.includes(id)).length;
    const pool = t.dateRange ? tripWindows(this.helm.ds, t) : this.helm.ds.dateWindows;
    let who: "everyone" | "most of the crew" = "everyone";
    let w = chosen ? indexOf(this.helm.ds).window.get(chosen.dateWindowId) : pool.find((x) => can(x.id) === priced.length);
    if (!w && !chosen && t.dateRange && priced.length) {
      const best = [...pool].sort((a, b) => can(b.id) - can(a.id))[0];
      if (best && can(best.id) * 2 > priced.length) { w = best; who = "most of the crew"; }
    }
    if (!w) return null;
    const label = `${monthDayLabel(w.start)} to ${monthDayLabel(w.end).replace(/^[A-Za-z]+ /, "")}`; // O2-043: cached formatter
    return { label: w.start.slice(5, 7) === w.end.slice(5, 7) ? label : `${monthDayLabel(w.start)} to ${monthDayLabel(w.end)}`, who };
  }

  /** The charts, votes, auto-pick and Dry Run clock are forgotten (a new table, new terms, a restore repair). */
  clearCharts(t: TripRec) {
    t.shortlistIds = undefined; t.shortlistPlans = undefined; t.chosenPlanId = undefined;
    t.votes = {}; t.autoPick = null; t.dryrun = undefined;
    this.helm.chartBooks.delete(t._id); this.helm.privacy.delete(t._id);
  }

  /**
   * O2-013: a new negotiation round (a new meeting, new terms, a reset table): the earlier round's turns are history,
   * so a (re)join never replays them (L3-006, TR5-012).
   */
  newRound(t: TripRec, running = false) {
    t.negotiation = { watch: 0, running, seq: 0, turns: [], round: (t.negotiation.round ?? 0) + 1 };
  }

  /**
   * O2-013: back to BRIEFING without the Two Charts, and the phones are told why on their next join (TR5-021).
   * `reason` is the crew's notice; `logReason` the helm log's (defaults to the notice).
   */
  backToBriefing(t: TripRec, from: TripStatus[], reason: string, logReason = reason) {
    this.helm.transition(t, "BRIEFING", { from, reason: logReason });
    this.clearCharts(t);
    t.tableReset = { at: nowIso(), reason };
  }

  /**
   * The table stops and the voyage goes back to BRIEFING (engine failure, restart). Its turns become history and are
   * deleted (R2-WP-11, L5-008). L4-009: a meeting the helm's restart cut short gives its table run back (the crew
   * didn't choose to stop); an engine failure keeps counting, since its model and voice calls were spent.
   */
  resetTable(t: TripRec, reason: string) {
    this.backToBriefing(t, ["AT_TABLE"], reason);
    this.newRound(t);
    if (reason === REASON_TABLE_RESTART && (t.tableRuns ?? 0) > 0) t.tableRuns = (t.tableRuns ?? 0) - 1;
    deleteOldTurns(t._id, t.negotiation.round ?? 0);
  }

  /** O2-013: a new turn: numbered, kept, stored (one document each, TR5-012) and sent to the room. */
  appendTurn(t: TripRec, fields: Omit<Turn, "turnId" | "tripId" | "seq" | "createdAt">): Turn {
    const turn: Turn = { turnId: newId(), tripId: t._id, seq: ++t.negotiation.seq, ...fields, createdAt: nowIso() };
    t.negotiation.turns.push(turn);
    this.helm.persistTurn(t, turn);
    this.helm.toTrip(t._id, "turn:new", turn);
    return turn;
  }

  // ---------- the meeting ----------
  async startTable(tripId: string, actor: Actor) {
    const { helm } = this;
    const t = helm.organizerTrip(tripId, actor, { phases: ["BRIEFING"], phaseMessage: "The table is already meeting." });
    const members = helm.activeMembers(t);
    if (members.length < MIN_TABLE_CREW) throw new HelmError("TOO_FEW", "You need at least two crew at the table.");
    if (members.some((m) => !m.briefSealed)) throw new HelmError("BRIEFS_PENDING", "Waiting on someone's sealed terms.");
    // WP-07 follow-up: every meeting costs model and voice calls, so a voyage gets a bounded number of them
    const runsMax = config.helm.tableRunsMax();
    if ((t.tableRuns ?? 0) >= runsMax) throw new HelmError("TOO_MANY_RUNS", `This voyage has met ${runsMax} times already. Start a new voyage to meet again.`);
    // A region / anywhere voyage: every port in scope is pre-ranked for this crew and the top 4 go on the chart
    // (fit/prerank.ts). Only the ranking leaves the helm, never anyone's terms.
    // a date-range voyage: its windows come from everyone's availability, fixed from here on (fit/windows.ts)
    if (t.dateRange) {
      this.generateWindows(t);
      if (!tripWindowIds(t).length) throw new HelmError("BAD_INPUT", "The dates don't hold a trip of that length. Start a voyage with a wider range.");
    }
    const scoped = t.destination && t.destination.kind !== "cities";
    const ports = scoped ? pickPorts(helm.ds, this.pricingCrew(t), scopeOf(helm.ds, t.destination!).map((c) => c._id), tripWindowIds(t), t._id) : null;
    if (ports && !ports.length) throw new HelmError("BAD_INPUT", "No port in range has a stay for this crew. Start a voyage with more ports.");
    helm.transition(t, "AT_TABLE", { from: ["BRIEFING"] });
    if (ports) t.candidateCityIds = ports; // (regions / anywhere take curated ports only, so no world packs to add)
    this.clearCharts(t);
    // docs/12: the ports and windows are fixed now: fetch live prices in the background (never awaited; whatever has
    // landed already — e.g. from when the last terms sealed — prices this chart book, the rest re-prices it later)
    void helm.live.prefetch(t, this.pricingCrew(t));
    t.tableRuns = (t.tableRuns ?? 0) + 1;
    // a new meeting = a new round: turns of an earlier (interrupted) meeting are never re-attached (TR5-012)
    this.newRound(t, true);
    deleteOldTurns(tripId, t.negotiation.round ?? 0); // R2-WP-11 (L5-008): earlier rounds are never read again
    t.tableReset = undefined;
    t.datasetHash = datasetHash(helm.ds);
    helm.pendingHails.set(tripId, []); // a hail left over from an earlier meeting must not steer this one
    helm.hailsClosed.delete(tripId);
    // OPT-045: the crew is priced once per meeting
    const crew = this.pricingCrew(t);
    const plans = this.chartBook(t, crew);
    if (helm.live.inventory(t) && !process.env.VITEST) console.log(`[live] voyage ${t._id}: chart book of ${plans.length}, ${plans.filter((p) => p.priceSource === "live").length} priced live`);
    helm.save(t);
    helm.broadcastState(t, Boolean(ports) || Boolean(t.dateRange)); // new ports / generated windows: static fields, so a full snapshot

    const memories = new Map<string, string[]>();
    await Promise.all(members.map(async (m) => memories.set(m._id, await helm.memoryFor(m))));
    const bands = new Map(members.map((m) => [m._id, m.band]));
    const dates = this.dates(t, crew);
    const engine = new NegotiationEngine(
      helm.ds, crew.map((c) => ({ ...c, band: bands.get(c.memberId) ?? 1 })), plans, t.candidateCityIds, dates?.label ?? null,
      this.engineHooks(t, memories), helm.privacy.get(t._id),
      { scopeLabel: scoped ? destinationLabel(helm.ds, t.destination!) : undefined, placeNames: (id) => this.placeName(id), datesWho: dates?.who },
    );
    // TR4-002: the two-argument form, so an error in the success handler isn't taken for an engine failure
    const round = t.negotiation.round;
    const current = () => t.status === "AT_TABLE" && t.negotiation.round === round;
    void engine.run().then((res) => { if (current()) this.onDecided(t, res.shortlist); }, (e) => { if (current()) this.onFailed(t, e); });
  }

  /** O2-022: the engine's view of this voyage: its turns, voices, watches, hails and the members' memory lines. */
  private engineHooks(t: TripRec, memories: Map<string, string[]>): EngineIO {
    const { helm } = this;
    const tripId = t._id;
    return {
      closeHails: () => { helm.hailsClosed.add(tripId); },
      // TR5-012: one small insert per turn; the trip doc (seq, watch) is saved when the table decides
      emitTurn: async (e, watch) => this.appendTurn(t, { ...e, watch }).turnId,
      voice: async (turnId, text, key) => {
        const ms = await synthesize(turnId, text, key);
        if (ms === null) return null;
        const turn = t.negotiation.turns.find((x) => x.turnId === turnId);
        // TR4-015: durable at once, with its length (and its cache key), so a replay after a restart carries both
        if (turn) { turn.audioUrl = `/api/audio/${turnId}`; turn.durationMs = ms; helm.persistTurn(t, turn); }
        helm.toTrip(tripId, "turn:audioReady", { turnId, audioUrl: `/api/audio/${turnId}`, durationMs: ms });
        return ms;
      },
      onWatch: (watch) => { t.negotiation.watch = watch; helm.toTrip(tripId, "table:watch", { watch }); },
      takeHails: () => { const list = helm.pendingHails.get(tripId) ?? []; helm.pendingHails.set(tripId, []); return list; },
      cancelled: () => t.status !== "AT_TABLE",
      memory: (id) => memories.get(id) ?? [],
    };
  }

  /** The Captain decided: the Two Charts, then the Dry Run. */
  private onDecided(t: TripRec, [a, b]: [Plan, Plan]) {
    const { helm } = this;
    helm.transition(t, "DRY_RUN", { from: ["AT_TABLE"] });
    t.negotiation.running = false;
    // docs/12: the chart book holds exactly the plans the Captain decided on (a late re-price can't swap them)
    const book = helm.chartBooks.get(t._id);
    if (book) for (const p of [a, b]) { const i = book.findIndex((x) => x._id === p._id); if (i >= 0) book[i] = p; }
    t.shortlistIds = [a._id, b._id];
    t.shortlistPlans = [a, b]; // TR5-022: the prices the crew saw survive a dataset change
    helm.dryrun.startClock(t);
    helm.save(t);
    helm.persistShortlist(t); // O2-036: stored once, in its own doc (the trip doc carries only the ids)
    try {
      this.emitShortlist(t);
      helm.broadcastState(t);
    } catch (e) {
      console.error(`[helm] voyage ${t._id}: announcing the two charts failed (the voyage stays in DRY_RUN)`, e);
    }
  }

  /** The engine failed: back to BRIEFING, with a neutral public notice. */
  private onFailed(t: TripRec, e: unknown) {
    const { helm } = this;
    console.error("[helm] negotiation failed", e);
    this.resetTable(t, REASON_TABLE_FAILED);
    helm.save(t);
    // TR3-007: a neutral public notice, not a room-wide `error` (that is caller-only)
    helm.toTrip(t._id, "table:failed", { code: "TABLE_FAILED", message: REASON_TABLE_FAILED });
    helm.broadcastState(t);
  }

  /** The Two Charts: the public pair to the room, each member's own share privately, then the Dry Run script. */
  emitShortlist(t: TripRec) {
    const { helm } = this;
    const shortlist = this.shortlist(t);
    const views = this.publicShortlist(t);
    if (!views) throw new Error(`voyage ${t._id}: the two charts don't resolve`);
    helm.toTrip(t._id, "table:decided", { shortlist: views });
    for (const m of helm.activeMembers(t)) for (const p of shortlist) {
      const priv = toPrivate(p, m._id);
      if (priv) helm.toMember(t._id, m._id, "plan:private", priv);
    }
    helm.toTrip(t._id, "dryrun:script", helm.dryrun.script(t, shortlist.map((p) => p._id)));
  }

  /**
   * A hail (doc 05 §4, §11). Amounts other than exact public prices are removed from it — all of them, so
   * what gets through says nothing about anyone's numbers (SEC-017) — and the rest is kept (TR4-011).
   * A hail that can't be used is refused privately to the sender (HelmError → `error`), never dropped.
   * S2-003: whether a hail is accepted depends only on its words and the public prices, and a refused hail
   * costs the same `HAIL_MIN_INTERVAL_MS` as an accepted one, so refusals can't be used as free probes.
   * L4-005: a hail during the Captain's OPEN (Watch 0) is refused with `TABLE_OPENING`; hails open once
   * Watch 1 starts, so the HAIL turn never lands in the log ahead of the Watch-1 proposals.
   */
  hail(tripId: string, memberId: string, text: string): void {
    const { helm } = this;
    const { t } = helm.memberTrip(tripId, memberId);
    // after the last Watch (or once the Captain is deciding) no Advocate speaks again, so the hail can't be used
    if (t.status !== "AT_TABLE" || !t.negotiation.running || t.negotiation.watch >= MAX_WATCHES || helm.hailsClosed.has(tripId)) {
      throw new HelmError("CAPTAINS_CALLING", "Captain's calling it.");
    }
    if (t.negotiation.watch < 1) throw new HelmError("TABLE_OPENING", "The Captain is opening the table. Hail once the mates start speaking.");
    const list = helm.pendingHails.get(tripId) ?? [];
    if (list.some((x) => x.memberId === memberId)) {
      throw new HelmError("HAIL_WAITING", "Your mate hasn't used your last hail yet. It speaks next watch.");
    }
    const now = Date.now();
    if (now - (helm.lastHailAt.get(memberId) ?? 0) < HAIL_MIN_INTERVAL_MS) throw slow("One hail every few seconds.");
    helm.lastHailAt.set(memberId, now); // S2-003: stamped before sanitising, so a refused hail counts too
    const safe = sanitizeHail(clean(text, HAIL_MAX_CHARS), this.privacyOf(t));
    if (!safe) throw new HelmError("HAIL_AMOUNTS", "Keep amounts out of hails. Say it in words, like \"somewhere cheaper\".");
    this.appendTurn(t, {
      // stamped with the Watch it is acted on: the next one (hails reach the table at the start of Watch 2 or 3)
      watch: Math.max(FIRST_HAIL_WATCH, t.negotiation.watch + 1), speaker: { kind: "human", memberId }, act: "HAIL",
      text: safe.text, ribbon: clampWords(safe.text, RIBBON_MAX_WORDS), voiced: false, redactions: safe.redactions,
    });
    list.push({ memberId, text: safe.text });
    helm.pendingHails.set(tripId, list);
  }

  /** A love/skip entry as said aloud: a port's name, a region, or a US state's name. */
  placeName(entry: string): string {
    return indexOf(this.helm.ds).city.get(entry)?.name ?? (entry.length === 2 ? stateName(entry) : entry);
  }

  /** "voyage: Lisbon, Mar 12 to 16" — the head of a memory note. */
  voyageLine(t: TripRec, plan: Plan) {
    return `voyage: ${cityName(this.helm.ds, plan.cityId)}, ${this.datesLabel(t)}`;
  }
}

