/**
 * Template lines for every act (docs/05-agent-spec.md §12). Used directly in rules mode and as the
 * safe fallback when the model is slow, invalid or leaks. Expo mode keeps lines ≤ 20 words.
 */
import type { Act, Dataset, FitReason, Plan, Tag } from "@all-ayes/shared";
import { cityName, indexOf } from "../data/loader.js";
import { view } from "./rules.js";
import { RIBBON_MAX_WORDS, clampWords } from "../util/text.js";

export interface LineOut { line: string; ribbon: string }

/** O2-012: the ribbon under every Captain DECIDE (template, model line and last-resort line alike). */
export const DECIDE_RIBBON = "Two charts. Run them dry.";

const NUM = ["zero", "One", "Two", "Three", "Four", "Five"];
const TAG_WORD: Record<Tag, string> = {
  beach: "beach", food: "food scene", nightlife: "nightlife", museums: "museums", nature: "outdoors",
  chill: "slow days", history: "history", music: "music",
};
const DEALBREAKER_PHRASE: Partial<Record<FitReason, string>> = {
  "dealbreaker:red_eye": "an overnight flight",
  "dealbreaker:early_start": "starts before eight",
  "dealbreaker:long_walks": "long walks",
  "dealbreaker:layovers_2plus": "two layovers",
  "dealbreaker:hostel": "a hostel",
};

/** Activities this member attends that cover their must-haves (picks first). */
export function highlights(ds: Dataset, p: Plan, memberId: string): string[] {
  const m = p.members.find((x) => x.memberId === memberId);
  if (!m) return [];
  const activity = indexOf(ds).activity;
  const out: string[] = [];
  for (const d of p.days) for (const it of d.items) {
    if (!it.attendees.includes(memberId)) continue;
    const a = activity.get(it.activityId);
    if (a && a.tags.some((t) => m.covered.includes(t)) && !out.includes(a.short)) out.push(a.short);
  }
  // picks (attended by a subset) read better than group moments
  const group = groupShorts(ds);
  return out.sort((x, y) => Number(group.has(x)) - Number(group.has(y))).slice(0, 2);
}
/** Short names of the dataset's group moments (cached per dataset, OPT-029). */
const groupShortCache = new WeakMap<Dataset, Set<string>>();
function groupShorts(ds: Dataset): Set<string> {
  let s = groupShortCache.get(ds);
  if (!s) {
    // `find` by short returned the first activity with that name, so only that one's role counts
    const firstByShort = new Map<string, boolean>();
    for (const a of ds.activities) if (!firstByShort.has(a.short)) firstByShort.set(a.short, a.role === "group");
    s = new Set([...firstByShort].filter(([, g]) => g).map(([short]) => short));
    groupShortCache.set(ds, s);
  }
  return s;
}
const isGroup = (ds: Dataset, short: string) => groupShorts(ds).has(short);

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const COMMON_FIRST = new Set(["Food", "Street", "Tram", "Fado", "Mezcal", "Bagel", "Fine", "Anthropology", "Lucha", "Tile", "Old", "Jazz"]);
/** "Food tour" → "the food tour", "Cascais beach day" → "the Cascais beach day", "Belém" → "Belém". */
function np(short: string): string {
  if (!short.includes(" ")) return short;
  if (/night out$/i.test(short)) return `a ${short}`;
  const [first, ...rest] = short.split(" ");
  return `the ${COMMON_FIRST.has(first) ? first.toLowerCase() : first} ${rest.join(" ")}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const nps = (xs: string[]) => list(xs.map(np));

/** Captain OPEN. `dates` is the window everyone can do, or null when there is none (TR4-005). */
export function openLine(dates: string | null, cities: string[]): LineOut {
  if (!dates) {
    return {
      line: `No dates suit everyone; we'll weigh the closest. ${NUM[cities.length] ?? cities.length} ports: ${list(cities)}. Let's hear it.`,
      ribbon: `No common dates · ${NUM[cities.length]?.toLowerCase() ?? cities.length} ports`,
    };
  }
  return {
    line: `${dates} works for everyone. ${NUM[cities.length] ?? cities.length} ports on the chart: ${list(cities)}. Let's hear it.`,
    ribbon: `${dates.replace(" to ", "–")} · ${NUM[cities.length]?.toLowerCase() ?? cities.length} ports`,
  };
}

export function proposeLine(ds: Dataset, p: Plan, memberId: string, opts: { seconding: boolean; memoryNote?: string }): LineOut {
  const city = cityName(ds, p.cityId);
  const hl = highlights(ds, p, memberId);
  const m = view(p, memberId);
  const tag = m.covered[0];
  if (opts.seconding) {
    return {
      line: hl.length ? `Seconding ${city}. ${cap(nps(hl))} — exactly what my friend wanted.` : `Seconding ${city}. It suits my friend well.`,
      ribbon: `${city}, seconded`,
    };
  }
  const body = hl.length ? `${cap(nps(hl))} ${hl.length > 1 ? "are" : "is"} right there for my friend.` : `It covers what my friend asked for.`;
  return {
    line: `${city}. ${body}${opts.memoryNote ? ` ${opts.memoryNote}` : ""}`,
    ribbon: tag ? `${city}, for the ${TAG_WORD[tag]}` : `${city}, for my friend`,
  };
}

export function objectMissingLine(ds: Dataset, rival: Plan, mine: Plan, tag: Tag): LineOut {
  const r = cityName(ds, rival.cityId), m = cityName(ds, mine.cityId);
  return {
    line: `${r} has no ${TAG_WORD[tag]} — the one thing my friend asked for. ${m} has it.`,
    ribbon: `No ${TAG_WORD[tag]} in ${r}`,
  };
}

export function objectUnfitLine(ds: Dataset, rival: Plan, reason: FitReason): LineOut {
  const r = cityName(ds, rival.cityId);
  if (reason === "over_cap") return { line: `${r} is past what my friend can do.`, ribbon: `${r} — not for us` };
  const phrase = DEALBREAKER_PHRASE[reason] ?? "something my friend won't do";
  return { line: `${r} means ${phrase}, and my friend won't do that.`, ribbon: `${r} — no ${phrase}` };
}

export function supportSwitchLine(ds: Dataset, p: Plan, memberId: string): LineOut {
  const city = cityName(ds, p.cityId);
  const hl = highlights(ds, p, memberId);
  return {
    line: hl.length ? `Fair. ${city} still has ${nps(hl)} for my friend. I'll back ${city}.` : `Fair. ${city} works for my friend. I'll back it.`,
    ribbon: hl.length ? `${city}, with ${np(hl[0])}` : `${city}, backed`,
  };
}

export function supportHoldLine(ds: Dataset, p: Plan): LineOut {
  const city = cityName(ds, p.cityId);
  return { line: `Still with ${city}. It covers everything my friend asked for.`, ribbon: `Still ${city}` };
}

export function concedeLine(ds: Dataset, p: Plan, memberId: string, hailFrom?: string): LineOut {
  const city = cityName(ds, p.cityId);
  const keep = highlights(ds, p, memberId).find((h) => !isGroup(ds, h));
  const keepText = keep ? ` — as long as we keep ${np(keep)}` : "";
  return {
    line: hailFrom ? `Heard you, ${hailFrom}. ${city} it is${keepText}.` : `I'll come round to ${city}${keepText}.`,
    ribbon: keep ? clampRibbon(`${city} — keep ${np(keep)}`) : `${city} it is`,
  };
}

export function decideLine(ds: Dataset, a: Plan, b: Plan, noneFit: boolean): LineOut {
  const A = cityName(ds, a.cityId), B = cityName(ds, b.cityId);
  if (noneFit) return { line: `No chart fits every purse. Closest two: ${A} and ${B}. Let's run them dry.`, ribbon: "Closest two. Run them dry." };
  const coverage = (p: Plan) => p.members.reduce((s, m) => s + m.covered.length, 0);
  const cheaper = a.groupCents <= b.groupCents ? A : B;
  const richer = coverage(a) >= coverage(b) ? A : B;
  const line = cheaper !== richer
    ? `Two charts, then. ${cheaper} leaves more in everyone's pocket; ${richer} covers the most. Let's run them dry.`
    : `Two charts, then. ${A} is the fairest; ${B} is the other way to go. Let's run them dry.`;
  return { line, ribbon: DECIDE_RIBBON };
}

/** Keep a line within the word budget, cutting at a sentence boundary when possible. */
export function clampToSentences(line: string, max: number): string {
  const words = line.split(/\s+/);
  if (words.length <= max) return line;
  const sentences = line.match(/[^.!?]+[.!?]+/g) ?? [line];
  let out = "";
  for (const s of sentences) {
    const next = (out + " " + s.trim()).trim();
    if (next.split(/\s+/).length > max) break;
    out = next;
  }
  return out || words.slice(0, max).join(" ") + ".";
}

/** The ribbon under a turn: at most RIBBON_MAX_WORDS words (OPT-019). */
export const clampRibbon = (r: string) => clampWords(r, RIBBON_MAX_WORDS);

/** Last-resort line for an act when both the model and the template are unusable (TR4-010). */
export function safeLine(act: Act, city?: string): LineOut {
  switch (act) {
    case "OPEN": return { line: "The ports are on the chart. Let's hear it.", ribbon: "Let's hear it" };
    case "PROPOSE": return city ? { line: `${city} would suit my friend.`, ribbon: `${city}, for my friend` } : { line: "My friend has a chart in mind.", ribbon: "For my friend" };
    case "OBJECT": return city ? { line: `${city} doesn't work for my friend.`, ribbon: `${city}, not for us` } : { line: "That one doesn't work for my friend.", ribbon: "Not for us" };
    case "SUPPORT": return city ? { line: `I'll back ${city}.`, ribbon: `${city}, backed` } : { line: "I'll back that one.", ribbon: "Backed" };
    case "CONCEDE": return city ? { line: `I'll come round to ${city}.`, ribbon: `${city} it is` } : { line: "I'll come round.", ribbon: "Fair enough" };
    case "DECIDE": return { line: "Two charts, then. Let's run them dry.", ribbon: DECIDE_RIBBON };
    default: return { line: "Noted.", ribbon: "Noted" };
  }
}
