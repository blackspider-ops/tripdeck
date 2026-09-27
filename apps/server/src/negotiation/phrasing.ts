/**
 * Template lines for every act (docs/05-agent-spec.md §12). Used directly in rules mode and as the
 * safe fallback when the model is slow, invalid or leaks. Expo mode keeps lines ≤ 20 words.
 */
import type { Act, Dataset, FitReason, Plan, Tag } from "@all-ayes/shared";
import { cityName, indexOf } from "../data/loader.js";
import { view } from "./rules.js";
import { RIBBON_MAX_WORDS, clampWords } from "../util/text.js";
import * as L from "./lines.js";

export interface LineOut { line: string; ribbon: string }

/** O2-012: the ribbon under every Captain DECIDE (template, model line and last-resort line alike). */
export const DECIDE_RIBBON = "Two charts. Run them dry.";

const NUM = ["zero", "One", "Two", "Three", "Four", "Five"];
const TAG_WORD: Record<Tag, string> = {
  beach: "beach", food: "food scene", nightlife: "nightlife", museums: "museums", nature: "outdoors",
  chill: "slow days", history: "history", music: "music",
};
/** A broken dealbreaker as a noun phrase ("Cartagena means an early start — …") and as its ribbon ("no early starts"). */
const DEALBREAKER_PHRASE: Partial<Record<FitReason, { means: string; ribbon: string }>> = {
  "dealbreaker:red_eye": { means: "an overnight flight", ribbon: "no overnight flights" },
  "dealbreaker:early_start": { means: "an early start", ribbon: "no early starts" },
  "dealbreaker:long_walks": { means: "long walks", ribbon: "no long walks" },
  "dealbreaker:layovers_2plus": { means: "two layovers", ribbon: "too many layovers" },
  "dealbreaker:hostel": { means: "a hostel", ribbon: "no hostels" },
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
/** A Title Case place name that still takes "the" ("the Van Gogh Museum", "the Botanical Gardens"). */
const THE_NOUNS = new Set([
  "Museum", "House", "Gardens", "Garden", "Tower", "Theatre", "Theater", "Centre", "Center", "Capitol", "Aquarium", "Market",
  "Memorial", "Lighthouse", "Arboretum", "Cathedral", "Palace", "Bridge", "Library", "Zoo", "Club", "Brewhouse", "Alliance",
  "District", "Opera", "Hall", "Pier", "Observatory", "Gallery", "Basilica", "Mosque", "Bazaar", "Souk", "Quarter", "Coast",
]);
const isTitleCase = (words: string[]) => words.filter((w) => /\p{L}/u.test(w[0] ?? "")).every((w) => w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase());
/**
 * "Food tour" → "the food tour", "Cascais beach day" → "the Cascais beach day", "Belém" → "Belém"; a proper name
 * from any port reads as itself ("Sagrada Família", "Table Mountain") unless it ends in a noun that takes "the"
 * ("the Van Gogh Museum").
 */
function np(short: string): string {
  if (!short.includes(" ")) return short;
  const words = short.split(" ");
  if (isTitleCase(words) && !THE_NOUNS.has(words.at(-1)!)) return short;
  if (/night out$/i.test(short)) return `a ${short}`;
  const [first, ...rest] = short.split(" ");
  return `the ${COMMON_FIRST.has(first) ? first.toLowerCase() : first} ${rest.join(" ")}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Who the Captain says the dates suit (counts only, never names: availability is private). */
export type DatesWho = "everyone" | "most of the crew";
const nps = (xs: string[]) => list(xs.map(np));

/**
 * Captain OPEN. `dates` is the window everyone can do, or null when there is none (TR4-005). `who`: a date-range
 * voyage whose best window suits most (not all) of the crew says "for most of the crew" — never who is missing.
 * `scope`: a region / anywhere voyage says what was asked for and which ports the pre-rank put on the chart.
 */
export function openLine(dates: string | null, cities: string[], scope?: string, who: DatesWho = "everyone", variant = 0): LineOut {
  const n = String(NUM[cities.length] ?? cities.length), ports = list(cities);
  if (scope) {
    const where = scope === "anywhere" ? "We could go anywhere." : `We're looking at ${scope}.`;
    const when = dates ? `${dates} works for ${who}. ` : "No dates suit everyone; we'll weigh the closest. ";
    return {
      line: L.pick(L.OPEN_SCOPE, variant, { when, where, ports, isAre: cities.length === 1 ? "is" : "are" }),
      ribbon: clampRibbon(`${scope === "anywhere" ? "Anywhere" : scope} · ${NUM[cities.length]?.toLowerCase() ?? cities.length} ports`),
    };
  }
  if (!dates) {
    return {
      line: L.pick(L.OPEN_NO_DATES, variant, { n, ports }),
      ribbon: `No common dates · ${NUM[cities.length]?.toLowerCase() ?? cities.length} ports`,
    };
  }
  return {
    line: L.pick(L.OPEN_DATES, variant, { dates, who, n, ports }),
    ribbon: `${dates.replace(" to ", "–")} · ${NUM[cities.length]?.toLowerCase() ?? cities.length} ports`,
  };
}

const hlSlots = (city: string, hl: string[]): L.HlSlots => ({ city, has: nps(hl), Has: cap(nps(hl)), are: hl.length > 1 ? "are" : "is" });

export function proposeLine(ds: Dataset, p: Plan, memberId: string, opts: { seconding: boolean; memoryNote?: string }, variant = 0): LineOut {
  const city = cityName(ds, p.cityId);
  const hl = highlights(ds, p, memberId);
  const m = view(p, memberId);
  const tag = m.covered[0];
  if (opts.seconding) {
    return {
      line: hl.length ? L.pick(L.SECOND_HL, variant, hlSlots(city, hl)) : L.pick(L.SECOND_PLAIN, variant, { city }),
      ribbon: `${city}, seconded`,
    };
  }
  const body = hl.length ? L.pick(L.PROPOSE_HL, variant, hlSlots(city, hl)) : L.pick(L.PROPOSE_PLAIN, variant, { city });
  return {
    line: `${body}${opts.memoryNote ? ` ${opts.memoryNote}` : ""}`,
    ribbon: tag ? `${city}, for the ${TAG_WORD[tag]}` : `${city}, for my friend`,
  };
}

export function objectMissingLine(ds: Dataset, rival: Plan, mine: Plan, tag: Tag, variant = 0): LineOut {
  const r = cityName(ds, rival.cityId), m = cityName(ds, mine.cityId);
  return {
    line: L.pick(L.OBJECT_MISSING, variant, { rival: r, mine: m, thing: TAG_WORD[tag] }),
    ribbon: `No ${TAG_WORD[tag]} in ${r}`,
  };
}

export function objectUnfitLine(ds: Dataset, rival: Plan, reason: FitReason, variant = 0): LineOut {
  const r = cityName(ds, rival.cityId), s = { rival: r };
  if (reason === "over_cap") return { line: L.pick(L.OBJECT_OVER_CAP, variant, s), ribbon: `${r} — not for us` };
  if (reason === "date_mismatch") return { line: L.pick(L.OBJECT_DATES, variant, s), ribbon: `${r} — wrong dates` };
  if (reason === "no_flight") return { line: L.pick(L.OBJECT_NO_FLIGHT, variant, s), ribbon: `${r} — no flight` };
  const phrase = DEALBREAKER_PHRASE[reason];
  if (!phrase) return { line: L.pick(L.OBJECT_TERMS, variant, s), ribbon: `${r} — not for us` };
  return { line: L.pick(L.OBJECT_DEALBREAKER, variant, { rival: r, means: phrase.means }), ribbon: `${r} — ${phrase.ribbon}` };
}

/**
 * Every act comes in LINE_VARIANTS or more wordings (lines.ts), so a table never hears the same sentence twice.
 * `variantFor` picks a speaker's starting wording from a stable speaker key and the watch (deterministic); the engine
 * walks on from there to one nobody has said yet this meeting.
 */
export const LINE_VARIANTS = 25;
/** FNV-1a of the speaker key, plus the watch: a stable, per-speaker rotation through the wordings. */
export function variantFor(speakerId: string, watch: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < speakerId.length; i++) { h ^= speakerId.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) + watch) % LINE_VARIANTS;
}
const nth = <T>(xs: readonly T[], variant: number): T => xs[((variant % xs.length) + xs.length) % xs.length];

export function supportSwitchLine(ds: Dataset, p: Plan, memberId: string, variant = 0): LineOut {
  const city = cityName(ds, p.cityId);
  const hl = highlights(ds, p, memberId);
  const line = hl.length ? L.pick(L.SWITCH_HL, variant, hlSlots(city, hl)) : L.pick(L.SWITCH_PLAIN, variant, { city });
  return {
    line,
    ribbon: hl.length ? nth([`${city}, with ${np(hl[0])}`, `${city} will do`, `Backing ${city}`, `${city}, with ${np(hl[0])}`, `Over to ${city}`], variant)
      : nth([`${city}, backed`, `${city} will do`, `Backing ${city}`, `${city}, backed`, `Over to ${city}`], variant),
  };
}

export function supportHoldLine(ds: Dataset, p: Plan, variant = 0): LineOut {
  const city = cityName(ds, p.cityId);
  const ribbon = nth([`Still ${city}`, `${city}, still`, `Staying with ${city}`, `No change: ${city}`, `Holding at ${city}`], variant);
  return { line: L.pick(L.HOLD, variant, { city }), ribbon };
}

export function concedeLine(ds: Dataset, p: Plan, memberId: string, hailFrom?: string, variant = 0): LineOut {
  const city = cityName(ds, p.cityId);
  const keep = highlights(ds, p, memberId).find((h) => !isGroup(ds, h));
  const keepText = keep ? ` — as long as we keep ${np(keep)}` : "";
  const line = hailFrom ? L.pick(L.CONCEDE_HAIL, variant, { city, keep: keepText, name: hailFrom }) : L.pick(L.CONCEDE, variant, { city, keep: keepText });
  return { line, ribbon: keep ? clampRibbon(`${city} — keep ${np(keep)}`) : `${city} it is` };
}

/**
 * The last resort against a repeat (the engine never says the same line twice in one meeting): a short sign-off
 * after the line, which makes it a different sentence without changing what it says.
 */
export const REPEAT_TAILS = ["Aye.", "Count my friend in.", "No change.", "Steady as she goes.", "That's our word."] as const;

/** How two lines compare for "said already": case, spacing and punctuation don't count. */
export const lineKey = (line: string) => line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function decideLine(ds: Dataset, a: Plan, b: Plan, noneFit: boolean, variant = 0): LineOut {
  const A = cityName(ds, a.cityId), B = cityName(ds, b.cityId);
  if (noneFit) return { line: L.pick(L.DECIDE_NONE_FIT, variant, { a: A, b: B }), ribbon: "Closest two. Run them dry." };
  const coverage = (p: Plan) => p.members.reduce((s, m) => s + m.covered.length, 0);
  const cheaper = a.groupCents <= b.groupCents ? A : B;
  const richer = coverage(a) >= coverage(b) ? A : B;
  const line = cheaper !== richer ? L.pick(L.DECIDE_SPLIT, variant, { cheaper, richer }) : L.pick(L.DECIDE_SAME, variant, { a: A, b: B });
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
