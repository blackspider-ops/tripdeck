/**
 * Runs one meeting at the table (docs/05-agent-spec.md §4): Captain OPEN → Watch 1 PROPOSE →
 * Watch 2 responses (+ hails) → early exit or Watch 3 → Captain DECIDE.
 * Decisions are deterministic; lines come from Gemini when configured, templates otherwise.
 * Every line goes through the privacy filter before anyone hears it.
 */
import type { Act, CityId, Dataset, Plan, Speaker } from "@all-ayes/shared";
import { MAX_WATCHES } from "@all-ayes/shared";
import type { PricingMember } from "../fit/pricing.js";
import type { PrivacyContext } from "../privacy/filter.js";
import { buildPrivacyContext } from "../privacy/context.js";
import { sanitizeSpoken } from "../privacy/guard.js";
import { config, features } from "../config.js";
import { sleep } from "../util/ids.js";
import {
  apply, backingCounts, consensus, decideResponse, decideWatch1, newTableState, parseHail, planById, shortlist, view,
  type Decision, type HailNote,
} from "./rules.js";
import {
  DECIDE_RIBBON, clampRibbon, clampToSentences, concedeLine, decideLine, objectMissingLine, objectUnfitLine, openLine,
  proposeLine, safeLine, supportHoldLine, supportSwitchLine, type LineOut,
} from "./phrasing.js";
import { generateLine } from "./gemini.js";
import {
  advocateFacts, advocateLineRequest, captainLineRequest, decideInstruction, legalActs, modelChoiceRequest, openInstruction,
} from "./prompts.js";
import { cityName } from "../data/loader.js";

export interface EmittedTurn {
  speaker: Speaker; act: Act; planId?: string; cityId?: CityId; text: string; ribbon: string; voiced: boolean; redactions: number;
}

export interface EngineIO {
  /** Persist + broadcast a turn; returns its id. */
  emitTurn(t: EmittedTurn, watch: number): Promise<string>;
  /** Synthesize voice for a turn; resolves with duration (ms) once audio is ready, or null. */
  voice(turnId: string, text: string, voiceKey: string): Promise<number | null>;
  onWatch(watch: number): void;
  takeHails(): { memberId: string; text: string }[];
  cancelled(): boolean;
  memory(memberId: string): string[];
  /** Called just before the Captain decides: no hail can be acted on after this (TR4-011). */
  closeHails?(): void;
}

export interface EngineCrew extends PricingMember { band: number }

export interface EngineResult { shortlist: [Plan, Plan] }

/** O2-033: words per spoken line (Expo mode keeps them short). */
const MAX_WORDS_EXPO = 20;
const MAX_WORDS = 35;
/**
 * O2-033: the pause after a line: its voice's length (or, without one, ~380 ms a word, 2.5 to 9 s) plus a 400 ms
 * breath, never under 2.5 s, counted from when the voice was asked for and scaled by PACE_SCALE.
 */
const PACE = { msPerWord: 380, minEstimateMs: 2_500, maxEstimateMs: 9_000, breathMs: 400, minLineMs: 2_500 } as const;

export class NegotiationEngine {
  private st = newTableState();
  private maxWords = config.expoMode ? MAX_WORDS_EXPO : MAX_WORDS;
  /** The table's one privacy context (OPT-013): passed in by the service, or built from `plans`. */
  readonly privacy: PrivacyContext;
  private hails = new Map<string, HailNote>(); // pending per member
  private prepared: Promise<unknown> = Promise.resolve();

  constructor(
    private ds: Dataset,
    private crew: EngineCrew[],
    private plans: Plan[],
    private cityIds: CityId[],
    /** Dates everyone can do, or null when there is no common window (TR4-005). */
    private datesLabel: string | null,
    private io: EngineIO,
    privacy?: PrivacyContext,
  ) {
    this.privacy = privacy ?? buildPrivacyContext(ds, crew, plans);
  }

  /** Seating order: everyone left of the Organizer, Organizer last (doc 05 §4). */
  private order(): EngineCrew[] {
    const others = this.crew.filter((c) => c.role !== "organizer");
    const org = this.crew.filter((c) => c.role === "organizer");
    return [...others, ...org];
  }

  async run(): Promise<EngineResult> {
    // WATCH 0 — Captain opens with group-level facts only
    const cities = this.cityIds.map((c) => cityName(this.ds, c));
    await this.say({ kind: "captain" }, "OPEN", undefined, 0, openLine(this.datesLabel, cities), (noAmounts) =>
      this.captainPrompt("OPEN", openInstruction(this.datesLabel, cities), noAmounts));

    let lastWatch = 0;
    for (let watch = 1; watch <= MAX_WATCHES; watch++) {
      if (this.io.cancelled()) break;
      lastWatch = watch;
      this.io.onWatch(watch);
      if (watch > 1) this.collectHails();
      for (const c of this.order()) {
        if (this.io.cancelled()) break;
        const hail = this.hails.get(c.memberId);
        let d = watch === 1 ? decideWatch1(this.plans, this.st, c.memberId) : decideResponse(this.ds, this.plans, this.st, c.memberId, watch, hail);
        if (config.agentDecisions === "model" && features.gemini()) d = await this.modelChoice(c, d, watch, hail) ?? d;
        apply(this.st, c.memberId, d);
        if (hail) this.hails.delete(c.memberId);
        const plan = planById(this.plans, d.planId);
        await this.say({ kind: "advocate", memberId: c.memberId }, d.act, plan, watch, this.template(c, d), (noAmounts) => this.advocatePrompt(c, d, watch, hail, noAmounts));
      }
      // Early exit after Watch 2 when everyone backs the same plan and no hail is waiting
      this.collectHails();
      if (watch >= 2 && consensus(this.st) && this.hails.size === 0) break;
    }

    this.io.closeHails?.();
    const [a, b] = shortlist(this.plans, this.st);
    const noneFit = !a.fitsEveryone && !b.fitsEveryone;
    await this.say({ kind: "captain" }, "DECIDE", a, lastWatch, decideLine(this.ds, a, b, noneFit), (noAmounts) =>
      this.captainPrompt("DECIDE", decideInstruction(this.ds, a, b), noAmounts));
    await this.prepared;

    return { shortlist: [a, b] };
  }

  // ---------- hails ----------
  private collectHails() {
    for (const h of this.io.takeHails()) {
      const who = this.crew.find((c) => c.memberId === h.memberId);
      if (who) this.hails.set(h.memberId, parseHail(h.memberId, who.name, h.text));
    }
  }

  // ---------- speaking ----------
  private template(c: EngineCrew, d: Decision): LineOut {
    const p = planById(this.plans, d.planId);
    switch (d.why.kind) {
      case "propose": {
        const mem = this.io.memory(c.memberId).find((m) => /gave up|conceded/i.test(m));
        return proposeLine(this.ds, p, c.memberId, { seconding: d.why.seconding, memoryNote: mem ? "My friend gave up the city pick last time." : undefined });
      }
      case "object_missing": return objectMissingLine(this.ds, planById(this.plans, d.why.againstPlanId), planById(this.plans, d.why.minePlanId), d.why.tag);
      case "object_unfit": return objectUnfitLine(this.ds, planById(this.plans, d.why.againstPlanId), d.why.reason);
      case "support_switch": return supportSwitchLine(this.ds, p, c.memberId);
      case "support_hold": return supportHoldLine(this.ds, p);
      case "concede": return concedeLine(this.ds, p, c.memberId, d.why.hailFrom);
    }
  }

  /**
   * Phrase (model or template) → privacy filter → emit → voice → wait until spoken.
   * The next line is prepared while this one plays (pipelining, doc 04 §8.1).
   */
  private async say(speaker: Speaker, act: Act, plan: Plan | undefined, watch: number, fallback: LineOut, prompt: Prompt) {
    const phrased = await this.phrase(act, plan, fallback, prompt);
    const turnId = await this.io.emitTurn({
      speaker, act, planId: plan?._id, cityId: plan?.cityId, text: phrased.line, ribbon: phrased.ribbon, voiced: true, redactions: phrased.redactions,
    }, watch);
    const voiceKey = speaker.kind === "captain" ? "captain" : String(this.crew.find((c) => c.memberId === (speaker as { memberId: string }).memberId)?.band ?? 1);
    const t0 = Date.now();
    const duration = await this.io.voice(turnId, phrased.line, voiceKey);
    const estimate = Math.min(PACE.maxEstimateMs, Math.max(PACE.minEstimateMs, phrased.line.split(/\s+/).length * PACE.msPerWord));
    const wait = (Math.max(PACE.minLineMs, (duration ?? estimate) + PACE.breathMs) - (Date.now() - t0)) * config.paceScale;
    if (wait > 0) await sleep(wait);
  }

  /**
   * Model line → filter; on a leak, regenerate once with a "state no amount" instruction; then the
   * act's template; then a safe line for that act (doc 05 §7.1.5). Invented prices are stripped, not
   * fatal (§7.2). `redactions` counts every rejected attempt, stripped amount and rewrite (TR4-010).
   */
  private async phrase(act: Act, plan: Plan | undefined, fallback: LineOut, prompt: Prompt): Promise<LineOut & { redactions: number }> {
    let redactions = 0;
    const clean = (l: LineOut): LineOut | null => {
      const s = sanitizeSpoken(l, this.privacy);
      if (!s) { redactions++; return null; }
      redactions += s.redactions;
      return { line: clampToSentences(s.line, this.maxWords), ribbon: clampRibbon(s.ribbon) };
    };
    if (features.gemini()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await prompt(attempt > 0);
        if (!out) break;
        const ok = clean(out);
        if (ok) return { ...ok, redactions };
      }
    }
    const t = clean(fallback) ?? clean(safeLine(act, plan ? cityName(this.ds, plan.cityId) : undefined)) ?? safeLine(act);
    return { ...t, redactions };
  }

  // ---------- prompts (worded in prompts.ts) ----------
  private async advocatePrompt(c: EngineCrew, d: Decision, watch: number, hail?: HailNote, noAmounts = false): Promise<LineOut | null> {
    const facts = advocateFacts(this.ds, c, d, planById(this.plans, d.planId), watch, this.io.memory(c.memberId), hail);
    const out = await generateLine(advocateLineRequest(c.name, facts, this.maxWords, noAmounts));
    return out ? { line: out.line, ribbon: out.ribbon } : null;
  }

  private async captainPrompt(act: "OPEN" | "DECIDE", instruction: string, noAmounts = false): Promise<LineOut | null> {
    const out = await generateLine(captainLineRequest(instruction, this.maxWords, noAmounts));
    return out ? { line: out.line, ribbon: act === "DECIDE" ? DECIDE_RIBBON : out.ribbon } : null;
  }

  /** AGENT_DECISIONS=model: Gemini may choose among the legal moves; the rule decision is the default. */
  private async modelChoice(c: EngineCrew, rule: Decision, watch: number, hail?: HailNote): Promise<Decision | null> {
    const out = await generateLine(modelChoiceRequest(this.ds, c, rule, watch, this.plans, backingCounts(this.st), this.maxWords, hail));
    if (!out?.act || !out.planId || !(legalActs(watch) as string[]).includes(out.act) || !this.plans.some((p) => p._id === out.planId)) return null;
    const v = view(planById(this.plans, out.planId), c.memberId);
    if ((out.act === "SUPPORT" || out.act === "CONCEDE") && !v.fits) return null;
    if (out.act === rule.act && out.planId === rule.planId) return rule;
    const why: Decision["why"] = out.act === "PROPOSE" ? { kind: "propose", seconding: this.st.proposedBy.has(out.planId) }
      : out.act === "CONCEDE" ? { kind: "concede", hailFrom: hail?.name }
      : out.act === "SUPPORT" ? { kind: "support_switch" }
      : { kind: "object_unfit", reason: v.fits ? "over_cap" : v.reasons[0], againstPlanId: out.planId };
    return { act: out.act as Decision["act"], planId: out.planId, why };
  }
}

type Prompt = (noAmounts: boolean) => Promise<LineOut | null>;
