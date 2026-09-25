/**
 * Deterministic negotiation protocol (docs/05-agent-spec.md §4–5).
 * Decides *what* each Advocate does; phrasing is separate (templates or Gemini).
 */
import type { Act, Dataset, FitReason, Plan, Tag } from "@all-ayes/shared";
import { advocatePreference } from "../fit/pricing.js";
import { compareFairness } from "../fit/fairness.js";
import { indexOf, mustFind } from "../data/loader.js";

export interface Decision {
  act: Exclude<Act, "OPEN" | "DECIDE" | "HAIL">;
  planId: string;
  /** Why — drives the template and the model prompt. */
  why:
    | { kind: "propose"; seconding: boolean }
    | { kind: "object_missing"; tag: Tag; againstPlanId: string; minePlanId: string }
    | { kind: "object_unfit"; reason: FitReason; againstPlanId: string }
    | { kind: "support_switch" }
    | { kind: "support_hold" }
    | { kind: "concede"; hailFrom?: string };
}

export interface HailNote { memberId: string; name: string; text: string; tags: Tag[]; cheaper: boolean }

interface TableState {
  backing: Map<string, string>;             // memberId → planId currently backed
  proposedBy: Map<string, string>;          // planId → first proposer memberId
  objections: { by: string; planId: string; tag?: Tag }[];
  advocatedBy: Map<string, Set<string>>;    // planId → memberIds that proposed/supported/conceded to it
}

export const newTableState = (): TableState => ({ backing: new Map(), proposedBy: new Map(), objections: [], advocatedBy: new Map() });

// OPT-064: a miss here is a bug (ids come from the table's own plans and crew), reported by name rather than as a TypeError
export const planById = (plans: Plan[], id: string) => mustFind(plans.find((p) => p._id === id), "plan", id);
export const view = (p: Plan, memberId: string) => mustFind(p.members.find((m) => m.memberId === memberId), `member on plan ${p._id}:`, memberId);
/** The member currently backs this plan (every member backs one after Watch 1). */
const backedBy = (st: TableState, memberId: string) => mustFind(st.backing.get(memberId), "backing for", memberId);

/** Best plan per city for this member, then the best of those (so proposals differ by city, not hotel). */
function favourite(plans: Plan[], memberId: string): Plan {
  const ranked = [...plans].sort((a, b) => advocatePreference(b, memberId) - advocatePreference(a, memberId) || compareFairness(a.fairness, b.fairness));
  return ranked[0];
}

export function decideWatch1(plans: Plan[], st: TableState, memberId: string): Decision {
  const fav = favourite(plans, memberId);
  const seconding = st.proposedBy.has(fav._id);
  return { act: "PROPOSE", planId: fav._id, why: { kind: "propose", seconding } };
}

const HAIL_TAGS: [RegExp, Tag][] = [
  [/\b(beach|beaches|sea|ocean|sand|swim)\b/i, "beach"], [/\b(food|eat|eating|tacos|restaurants?)\b/i, "food"],
  [/\b(nightlife|party|night out|bars?|clubs?)\b/i, "nightlife"], [/\b(museums?|art|galler(y|ies))\b/i, "museums"],
  [/\b(nature|hike|hiking|mountains?|outdoors)\b/i, "nature"], [/\b(chill|relax|slow|rest)\b/i, "chill"],
  [/\b(history|historic|castles?|ruins)\b/i, "history"], [/\b(music|jazz|fado|concerts?)\b/i, "music"],
];
export function parseHail(memberId: string, name: string, text: string): HailNote {
  const tags = HAIL_TAGS.filter(([re]) => re.test(text)).map(([, t]) => t);
  return { memberId, name, text, tags, cheaper: /\b(cheap|cheaper|cheapest|save|budget|less money|affordable)\b/i.test(text) };
}

function offersTag(ds: Dataset, p: Plan, tag: Tag): boolean {
  const activity = indexOf(ds).activity;
  return p.days.some((d) => d.items.some((it) => activity.get(it.activityId)?.tags.includes(tag)));
}

/**
 * OPT-021: how many members back each plan, in first-backed order. The one tally behind `mostBackedOther`,
 * the Watch 3 majority check, `consensus` and the model's `backed_by` option counts.
 */
export function backingCounts(st: TableState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pid of st.backing.values()) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  return counts;
}

function mostBackedOther(st: TableState, mine: string): string | undefined {
  let best: string | undefined, n = 0;
  for (const [pid, c] of backingCounts(st)) if (pid !== mine && c > n) { best = pid; n = c; }
  return best;
}

/** O2-033: a switch costing my member at most this much satisfaction is a SUPPORT, more is a CONCEDE. */
const SWITCH_MAX_DROP = 25;
/** A rival within this many preference points of my plan counts as nearly as good. */
const NEARLY_AS_GOOD = 10;

/** What one Watch 2/3 rule looks at (O2-022: one small function per rule, tried in order). */
interface Seat {
  ds: Dataset; plans: Plan[]; st: TableState; memberId: string; watch: number; hail?: HailNote;
  mine: string; minePlan: Plan; myView: ReturnType<typeof view>; rival?: Plan;
}

/** 1) Own member hailed: follow the hail if a backed plan honours it and still fits. */
function followHail({ ds, plans, st, memberId, hail, mine }: Seat): Decision | undefined {
  if (!hail) return undefined;
  const backedIds = [...backingCounts(st).keys()];
  const candidates = backedIds.map((id) => planById(plans, id)).filter((p) => view(p, memberId).fits);
  let target: Plan | undefined;
  if (hail.tags.length) target = candidates.find((p) => hail.tags.every((t) => offersTag(ds, p, t)));
  if (!target && hail.cheaper) target = [...candidates].sort((a, b) => view(a, memberId).amountCents - view(b, memberId).amountCents)[0];
  if (target && target._id !== mine) return { act: "CONCEDE", planId: target._id, why: { kind: "concede", hailFrom: hail.name } };
  if (target) return { act: "SUPPORT", planId: mine, why: { kind: "support_hold" } };
  return undefined;
}

/** 2) Rival misses one of my member's must-haves that my plan covers → object (only if I proposed mine). */
function objectToRival({ st, memberId, watch, mine, myView, rival }: Seat): Decision | undefined {
  if (!rival || watch !== 2 || st.proposedBy.get(mine) !== memberId) return undefined;
  const rv = view(rival, memberId);
  const tag = rv.missing.find((t) => myView.covered.includes(t));
  if (tag) return { act: "OBJECT", planId: rival._id, why: { kind: "object_missing", tag, againstPlanId: rival._id, minePlanId: mine } };
  if (!rv.fits) return { act: "OBJECT", planId: rival._id, why: { kind: "object_unfit", reason: rv.reasons[0], againstPlanId: rival._id } };
  return undefined;
}

/** 3) Someone objected to my plan for a missing must-have: move to their plan if it works for my member. */
function answerObjection({ plans, st, memberId, mine, myView }: Seat): Decision | undefined {
  const objection = st.objections.find((o) => o.planId === mine && o.by !== memberId && o.tag);
  if (!objection) return undefined;
  const theirs = planById(plans, backedBy(st, objection.by));
  const tv = view(theirs, memberId);
  if (!tv.fits || tv.missing.length !== 0) return undefined;
  return myView.satisfaction - tv.satisfaction <= SWITCH_MAX_DROP
    ? { act: "SUPPORT", planId: theirs._id, why: { kind: "support_switch" } }
    : { act: "CONCEDE", planId: theirs._id, why: { kind: "concede" } };
}

/** 4) Watch 3: fall in with the majority if it fits; otherwise object only for a real reason. */
function majority({ st, memberId, watch, rival }: Seat): Decision | undefined {
  if (watch !== 3 || !rival) return undefined;
  const rv = view(rival, memberId);
  if ((backingCounts(st).get(rival._id) ?? 0) <= st.backing.size / 2) return undefined;
  if (rv.fits) return { act: "CONCEDE", planId: rival._id, why: { kind: "concede" } };
  return { act: "OBJECT", planId: rival._id, why: { kind: "object_unfit", reason: rv.reasons[0], againstPlanId: rival._id } };
}

/** 5) A rival that's nearly as good for my member → support it (else the caller holds). */
function nearlyAsGood({ memberId, minePlan, myView, rival }: Seat): Decision | undefined {
  if (!rival) return undefined;
  const rv = view(rival, memberId);
  const close = advocatePreference(rival, memberId) >= advocatePreference(minePlan, memberId) - NEARLY_AS_GOOD;
  return rv.fits && rv.missing.length <= myView.missing.length && close ? { act: "SUPPORT", planId: rival._id, why: { kind: "support_switch" } } : undefined;
}

const RESPONSE_RULES = [followHail, objectToRival, answerObjection, majority, nearlyAsGood];

/** Watch 2/3 response (doc 05 §4 + example §12): the first rule that applies, else hold. */
export function decideResponse(
  ds: Dataset, plans: Plan[], st: TableState, memberId: string, watch: number, hail?: HailNote,
): Decision {
  const mine = backedBy(st, memberId);
  const minePlan = planById(plans, mine);
  const rivalId = mostBackedOther(st, mine);
  const seat: Seat = {
    ds, plans, st, memberId, watch, hail, mine, minePlan, myView: view(minePlan, memberId),
    rival: rivalId ? planById(plans, rivalId) : undefined,
  };
  for (const rule of RESPONSE_RULES) {
    const d = rule(seat);
    if (d) return d;
  }
  return { act: "SUPPORT", planId: mine, why: { kind: "support_hold" } };
}

/** Apply a decision to the table state (backing, objections, advocatedBy). */
export function apply(st: TableState, memberId: string, d: Decision) {
  const add = (pid: string) => { const set = st.advocatedBy.get(pid) ?? new Set<string>(); set.add(memberId); st.advocatedBy.set(pid, set); };
  if (d.act === "PROPOSE") { if (!st.proposedBy.has(d.planId)) st.proposedBy.set(d.planId, memberId); st.backing.set(memberId, d.planId); add(d.planId); }
  if (d.act === "SUPPORT" || d.act === "CONCEDE") { st.backing.set(memberId, d.planId); add(d.planId); }
  if (d.act === "OBJECT") st.objections.push({ by: memberId, planId: d.planId, tag: d.why.kind === "object_missing" ? d.why.tag : undefined });
}

export function consensus(st: TableState): string | null {
  const counts = backingCounts(st);
  return counts.size === 1 ? [...counts.keys()][0] : null;
}

/** Captain's shortlist (doc 05 §5): fairest considered plan + best different-city alternative. */
export function shortlist(plans: Plan[], st: TableState): [Plan, Plan] {
  let considered = plans.filter((p) => st.advocatedBy.has(p._id));
  if (considered.length < 2) considered = [...considered, ...plans.filter((p) => !considered.includes(p))].slice(0, Math.max(2, considered.length));
  const ranked = [...considered].sort((a, b) => compareFairness(a.fairness, b.fairness));
  const a = ranked[0];
  const b =
    ranked.find((p) => p.cityId !== a.cityId) ??
    [...plans].sort((x, y) => compareFairness(x.fairness, y.fairness)).find((p) => p.cityId !== a.cityId && p._id !== a._id) ??
    ranked.find((p) => p._id !== a._id) ??
    mustFind(plans.find((p) => p._id !== a._id), "second plan besides", a._id);
  return [a, b];
}
