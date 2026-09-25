/**
 * The table (OPT-031): the chart book and its privacy context, the Two Charts, the negotiation engine's wiring,
 * and hails.
 */
import type { Plan, PlanPublic, TripStatus, Turn } from "@all-ayes/shared";
import { HAIL_MAX_CHARS, MAX_WATCHES, MIN_TABLE_CREW, monthDayLabel } from "@all-ayes/shared";
import { cityName, indexOf } from "../data/loader.js";
import { buildChartBook, toPrivate, toPublic, type PricingMember } from "../fit/pricing.js";
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
  FIRST_HAIL_WATCH, HAIL_MIN_INTERVAL_MS, REASON_TABLE_FAILED, REASON_TABLE_RESTART, datasetHash,
  type Actor, type TripRec,
} from "./records.js";
import type { Helm } from "./core.js";

/** The chart book is the top 12 plans (doc 05 §2.6); at most 30 candidates exist (2 windows × 3 cities × 5 hotels). */
const CHART_BOOK_LIMIT = 12;

export class Table {
  constructor(private helm: Helm) {}

  /** OPT-018: the A/B public views, built once per pair of plans. */
  private publicViews = new WeakMap<Plan, { b: Plan; views: PlanPublic[] }>();

  // ---------- the chart book ----------
  pricingCrew(t: TripRec): PricingMember[] {
    // TR5-002: a member without a brief doc isn't priced (restore unseals them and the voyage returns to BRIEFING)
    return this.helm.activeMembers(t).flatMap((m) => {
      const brief = this.helm.briefs.get(m._id);
      return brief ? [{ memberId: m._id, name: m.name, role: m.role, origin: m.origin, brief }] : [];
    });
  }

  /**
   * The chart book and the table's one privacy context, built together from exactly these plans and shared by the
   * engine, the hail filter and prompts (OPT-013 / TR4-012). Either missing (a restore, the sweep) rebuilds both.
   */
  chartBook(t: TripRec, crew?: PricingMember[]): Plan[] {
    let book = this.helm.chartBooks.get(t._id);
    if (!book || !this.helm.privacy.has(t._id)) {
      const priced = crew ?? this.pricingCrew(t);
      let built = buildChartBook(this.helm.ds, priced, t.candidateCityIds, CHART_BOOK_LIMIT);
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
    const chosen = this.planOf(t, t.chosenPlanId);
    const w = chosen
      ? indexOf(this.helm.ds).window.get(chosen.dateWindowId)
      : this.helm.ds.dateWindows.find((x) => (crew ?? this.pricingCrew(t)).every((c) => c.brief.dateWindowIds.includes(x.id)));
    if (!w) return null;
    return `${monthDayLabel(w.start)} to ${monthDayLabel(w.end).replace(/^[A-Za-z]+ /, "")}`; // O2-043: cached formatter
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
    helm.transition(t, "AT_TABLE", { from: ["BRIEFING"] });
    this.clearCharts(t);
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
    helm.save(t);
    helm.broadcastState(t);

    const memories = new Map<string, string[]>();
    await Promise.all(members.map(async (m) => memories.set(m._id, await helm.memoryFor(m))));
    const bands = new Map(members.map((m) => [m._id, m.band]));
    const engine = new NegotiationEngine(
      helm.ds, crew.map((c) => ({ ...c, band: bands.get(c.memberId) ?? 1 })), plans, t.candidateCityIds, this.datesLabel(t, crew),
      this.engineHooks(t, memories), helm.privacy.get(t._id),
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

  /** "voyage: Lisbon, Mar 12 to 16" — the head of a memory note. */
  voyageLine(t: TripRec, plan: Plan) {
    return `voyage: ${cityName(this.helm.ds, plan.cityId)}, ${this.datesLabel(t)}`;
  }
}

