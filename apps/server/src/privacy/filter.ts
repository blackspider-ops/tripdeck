/**
 * Budget privacy filter + price validator (docs/05-agent-spec.md §7.1–7.2).
 * Runs on every spoken line, ribbon and hail before it reaches the shared room.
 *
 * Text is normalised first (NFKC, zero-width characters, digits from any script, `9_0_0`), so
 * look-alike spellings of a secret read the same as plain digits (SEC-017).
 */

export interface PrivacyContext {
  /** Secret dollar amounts: every cap, share and headroom (cap − share). */
  sensitiveDollars: number[];
  /** Exact public dollar amounts that may be said (listing prices, group totals). */
  allowedDollars: number[];
  /** Crew first names, for "Maya can't afford…" rewrites. */
  names: string[];
}

export interface FilterResult {
  text: string; leak: boolean; invalidPrice: boolean; rewrites: number;
  /** O2-044: the amounts found in `text` (normalised), so a caller stripping them doesn't scan it again. */
  amounts: Amount[];
}

/** A number the text might be saying, with the span it came from (in the normalised text). */
export interface Amount { value: number; currency: boolean; start: number; end: number }

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** Slang for hundred / thousand. */
const HUNDRED = new Set(["hundred", "hundo", "hunnid"]);
const THOUSAND = new Set(["thousand", "grand", "k"]);
/** "oh" as a spoken zero ("nine-oh-oh"); never starts a number. */
const ZERO_WORDS = new Set(["oh", "zero"]);
const SCALE = new Set([...HUNDRED, ...THOUSAND]);
const LEXICON = [...Object.keys(UNITS), ...Object.keys(TENS), ...HUNDRED, "thousand", "grand", "oh"].sort((a, b) => b.length - a.length);
const isNumWord = (w: string) => w in UNITS || w in TENS || SCALE.has(w) || ZERO_WORDS.has(w);
const isDigitWord = (w: string) => (w in UNITS && UNITS[w] <= 9) || ZERO_WORDS.has(w);

const ZERO_WIDTH = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;

/** Value of a decimal digit from any script (Unicode Nd blocks are runs of 0–9). */
function digitValue(ch: string): number {
  const cp = ch.codePointAt(0)!;
  let start = cp;
  while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/** NFKC, no zero-width/bidi characters, ASCII digits, and `9_0_0` → `900`. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/[’‘]/g, "'")
    .replace(/\p{Nd}/gu, (ch) => (/[0-9]/.test(ch) ? ch : String(digitValue(ch))))
    .replace(/(?<=\d)_+(?=\d)/g, "");
}

/** "ninehundred" → ["nine", "hundred"]; null when the word isn't made only of number words. */
function segment(word: string): string[] | null {
  if (word.length < 6) return null;
  const memo = new Map<number, string[] | null>();
  const go = (i: number): string[] | null => {
    if (i === word.length) return [];
    if (memo.has(i)) return memo.get(i)!;
    let out: string[] | null = null;
    for (const w of LEXICON) {
      if (!word.startsWith(w, i)) continue;
      const rest = go(i + w.length);
      if (rest) { out = [w, ...rest]; break; }
    }
    memo.set(i, out);
    return out;
  };
  const parts = go(0);
  return parts && parts.length > 1 ? parts : null;
}

interface Tok { w: string; start: number; end: number }
function wordTokens(t: string): Tok[] {
  const out: Tok[] = [];
  for (const m of t.toLowerCase().matchAll(/[a-z]+/g)) {
    const start = m.index!, end = start + m[0].length;
    const parts = isNumWord(m[0]) ? null : segment(m[0]);
    if (parts) for (const w of parts) out.push({ w, start, end });
    else out.push({ w: m[0], start, end });
  }
  return out;
}


/** All numbers a sentence might be saying, in dollars (several readings where speech is ambiguous). */
export function extractAmounts(text: string): Amount[] {
  return amountsIn(normalizeText(text));
}

/** O2-044: `extractAmounts` of text that is already normalised (normalizeText is idempotent; this skips redoing it). */
export function amountsIn(t: string): Amount[] {
  const out: Amount[] = [];
  const push = (value: number, currency: boolean, start: number, end: number) => out.push({ value, currency, start, end });

  // "7-5-0", "9 0 0" — digits spelled out one at a time
  for (const m of t.matchAll(/\b(\d)[-\s.,](\d)[-\s.,](\d)(?:[-\s.,](\d))?\b/g)) {
    push(Number(m.slice(1).filter(Boolean).join("")), false, m.index!, m.index! + m[0].length);
  }
  // digits: $1,234.56 · $1 100 · 900 · 7.5k · 1.2 grand · 9 hundred · 900 USD
  const DIGITS = /(\$|US\$|USD\s?)?\s?(\d{1,3}(?:[,   ]\d{3}(?!\d))+|\d+)(?:\.(\d+))?\s*(k\b|grand\b|thousand\b|hundred\b|hundo\b|bucks\b|dollars\b|usd\b)?/gi;
  for (const m of t.matchAll(DIGITS)) {
    const whole = m[2].replace(/[,   ]/g, "");
    let v = Number(whole + (m[3] ? "." + m[3] : ""));
    const suffix = (m[4] ?? "").toLowerCase();
    if (THOUSAND.has(suffix)) v *= 1000;
    if (HUNDRED.has(suffix)) v *= 100;
    const start = m.index! + (m[0].length - m[0].trimStart().length), end = m.index! + m[0].length;
    push(v, Boolean(m[1]) || suffix === "bucks" || suffix === "dollars" || suffix === "usd", start, end);
    // "1.100" read the European way (thousands separator) as well
    if (m[3]?.length === 3 && !suffix) push(Number(whole + m[3]), false, start, end);
  }
  // words: "nine hundred", "seven fifty", "a grand", "nine-oh-oh", "ninehundred", "nine hundo"
  const toks = wordTokens(t);
  let i = 0;
  while (i < toks.length) {
    const w = toks[i].w;
    const starts = (w in UNITS || w in TENS) || (w === "a" && SCALE.has(toks[i + 1]?.w ?? ""));
    if (!starts) { i++; continue; }
    const run: Tok[] = [];
    while (i < toks.length) {
      const cur = toks[i];
      const ok = isNumWord(cur.w) || cur.w === "and" || (cur.w === "a" && SCALE.has(toks[i + 1]?.w ?? ""));
      // a run continues only across spaces, hyphens and commas (not across sentences or other words)
      const gap = run.length ? t.slice(run[run.length - 1].end, cur.start) : "";
      if (!ok || (run.length && !/^[\s,\-–—]*$/.test(gap) && cur.start !== run[run.length - 1].start)) break;
      run.push(cur);
      i++;
    }
    while (run.length && run[run.length - 1].w === "and") run.pop();
    if (!run.length) continue;
    const start = run[0].start, end = run[run.length - 1].end;
    for (const v of readWords(run.map((r) => r.w))) if (v >= 20) push(v, false, start, end);
  }
  foldArithmetic(t, out);
  return out;
}

function readWords(run: string[]): number[] {
  const nums = run.filter((w) => w !== "and");
  let total = 0, current = 0;
  for (const w of nums) {
    if (w === "a") { current = current || 1; continue; }
    if (w in UNITS) current += UNITS[w];
    else if (w in TENS) current += TENS[w];
    else if (HUNDRED.has(w)) current = (current || 1) * 100;
    else if (THOUSAND.has(w)) { total += (current || 1) * 1000; current = 0; }
  }
  const readings = [total + current];
  // colloquial "seven fifty" = 750, "nine twenty-five" = 925
  const head = nums[0], rest = nums.slice(1);
  if (head in UNITS && UNITS[head] > 0 && rest.length && rest.every((w) => w in TENS || w in UNITS)) {
    const tail = rest.reduce((s, w) => s + (UNITS[w] ?? TENS[w] ?? 0), 0);
    if (tail < 100) readings.push(UNITS[head] * 100 + tail);
  }
  // digit by digit: "nine-oh-oh" = 900, "eight six eight" = 868
  if (nums.length >= 2 && nums.every(isDigitWord) && (nums.length >= 3 || nums.some((w) => ZERO_WORDS.has(w)))) {
    readings.push(Number(nums.map((w) => (ZERO_WORDS.has(w) ? 0 : UNITS[w])).join("")));
  }
  return readings;
}

/** Crew-sized divisors in words (a crew is 2–12: MAX_CREW). */
const SMALL: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** "450 plus 450", "a grand minus a hundred", "2869 split three ways" → the result as an extra reading. */
function foldArithmetic(t: string, out: Amount[]) {
  const sorted = [...out].sort((a, b) => a.start - b.start || b.end - a.end);
  for (let k = 0; k < sorted.length; k++) {
    const a = sorted[k];
    // division by a small count
    const div = /^\s*(?:dollars|bucks)?\s*(?:split|divided|shared|\/|over)\s*(?:up\s+)?(?:by|between|among|in|into)?\s*(?:the\s+)?(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.exec(t.slice(a.end, a.end + 40));
    if (div && a.value >= 20) {
      const n = /\d/.test(div[1]) ? Number(div[1]) : SMALL[div[1].toLowerCase()];
      if (n >= 2) out.push({ value: Math.round(a.value / n), currency: false, start: a.start, end: a.end + div[0].length });
    }
    const b = sorted.slice(k + 1).find((x) => x.start >= a.end);
    if (!b) continue;
    const op = t.slice(a.end, b.start).trim().toLowerCase();
    let v: number | undefined;
    if (/^(?:plus|\+|and|add|with)$/.test(op)) v = a.value + b.value;
    else if (/^(?:minus|-|–|less|take away|takeaway|less than)$/.test(op)) v = a.value - b.value;
    else if (/^(?:times|x|\*|×|multiplied by)$/.test(op)) v = a.value * b.value;
    if (v !== undefined && v >= 20) out.push({ value: v, currency: false, start: a.start, end: b.end });
  }
}

const near = (a: number, b: number, pct: number) => Math.abs(a - b) <= Math.max(1, b * pct);
const isAllowed = (ctx: PrivacyContext, v: number) => ctx.allowedDollars.some((a) => Math.abs(a - v) <= 1);

const AFFORD = "(?:can't|cannot|can not|couldn't|could not|won't be able to|isn't able to|is unable to|doesn't have the money to|can't really)\\s+(?:afford|pay|swing|do|stretch|manage|cover)";

/**
 * O2-044: each context's "<name> can't afford" patterns, compiled once (a context lives for a whole table), not per
 * line. Rebuilt if the context's names change.
 */
const namePatterns = new WeakMap<PrivacyContext, { names: string[]; key: string; res: RegExp[] }>();
function affordPatterns(ctx: PrivacyContext): RegExp[] {
  const key = ctx.names.join("\u0000");
  const hit = namePatterns.get(ctx);
  if (hit && hit.names === ctx.names && hit.key === key) return hit.res;
  const res = ctx.names.map((name) => new RegExp(`\\b${escape(name)}\\b((?:\\s+[a-z]+){0,2}?\\s+${AFFORD})`, "gi"));
  namePatterns.set(ctx, { names: ctx.names, key, res });
  return res;
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
/** "Mar 27", and the end of "Mar 27 to 31" / "Mar 27–31" / "Dec 27 to Jan 2", just before a number. */
const DAY_BEFORE = new RegExp(`\\b${MONTH}\\s+$|\\b${MONTH}\\s+\\d{1,2}\\s*(?:to|through|until|–|-)\\s*(?:${MONTH}\\s+)?$`, "i");
/**
 * A day of the month said with its month ("Mar 27", "Mar 27 to 31") is a date, not an amount: the voyage's dates are
 * public (docs/04 §4.12), and without this a day number near some secret dollar value (±5%) would make the Captain's
 * "Mar 27 to 31 works for everyone" a leak. Only whole numbers 1–31 with no currency qualify.
 */
function isCalendarDay(t: string, a: Amount): boolean {
  if (a.currency || a.value < 1 || a.value > 31 || !/^\d{1,2}$/.test(t.slice(a.start, a.end).trim())) return false;
  return DAY_BEFORE.test(t.slice(Math.max(0, a.start - 24), a.start));
}

export function filterLine(input: string, ctx: PrivacyContext): FilterResult {
  let text = normalizeText(input);
  let rewrites = 0;

  // 1) "Maya can't afford…", "Maya simply cannot afford…" → "one of us can't…"
  for (const re of affordPatterns(ctx)) {
    re.lastIndex = 0; // shared global regexes: `test` moves lastIndex
    if (re.test(text)) {
      text = text.replace(re, "one of us$1");
      rewrites++;
    }
  }

  const amounts = amountsIn(text).filter((a) => !isCalendarDay(text, a));
  const allowed = (v: number) => isAllowed(ctx, v);

  // 2) leak: any amount within ±5% of a secret value that isn't an exact public value
  let leak = false;
  for (const a of amounts) {
    if (a.value < 20 || allowed(a.value)) continue;
    if (ctx.sensitiveDollars.some((s) => s >= 20 && near(a.value, s, 0.05))) leak = true;
  }
  const nonPublic = amounts.some((a) => a.value >= 100 && !allowed(a.value));
  // 3) money talk about limits with any non-public number ≥ 100
  if (/\b(budget|cap|limit|afford|spend|spending|max|maximum|ceiling|tops)\b/i.test(text) && nonPublic) leak = true;
  // 4) per-member share talk ("about 950 each", "my share is 1,000") with any non-public number ≥ 100
  if (/\b(each|apiece|per (?:person|head|member|traveller|traveler)|a head|a person|(?:my|your|her|his|their|our) (?:share|cut|part|portion)|each of us|everyone pays)\b/i.test(text) && nonPublic) leak = true;
  // 5) price validator: currency amounts must be exact public values
  const invalidPrice = amounts.some((a) => a.currency && a.value >= 1 && !allowed(a.value));

  return { text, leak, invalidPrice, rewrites, amounts };
}

const CONNECTORS = "for|at|of|about|around|roughly|only|just|under|over|like|maybe|approximately|nearly|almost|near|some|to";
const DANGLING_END = /\b(?:is|are|was|were|costs?|runs?|comes?|be|to|for|at|of|and|or|about|with)\s*[.!?]*\s*$/i;

/**
 * Remove the amounts `pick` selects, with the connecting words around them ("for $150 a night").
 * A sentence left too thin to make sense is dropped; the rest of the text is kept (doc 05 §7.2).
 */
export function stripAmounts(input: string, pick: (a: Amount) => boolean, found?: Amount[]): { text: string; removed: number } {
  // O2-044: `found` = amountsIn(input) when the caller already has them (input is then normalised already)
  const t = found ? input : normalizeText(input);
  const spans = (found ?? amountsIn(t)).filter(pick).map((a) => [a.start, a.end] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (!spans.length) return { text: t, removed: 0 };
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  let marked = "";
  let pos = 0;
  for (const [s, e] of merged) { marked += t.slice(pos, s) + "\u0000"; pos = e; }
  marked += t.slice(pos);
  marked = marked
    .replace(new RegExp(`(?:\\s+(?:${CONNECTORS}))*\\s*\\$?\\u0000`, "gi"), " \u0000")
    .replace(/\u0000(?:\s*(?:a|per)\s+(?:night|person|head|day|week|pop))?(?:\s*(?:each|apiece|tops|max|maximum|total|or so|ish|dollars|bucks))*/gi, "\u0000");
  const sentences = marked.match(/[^.!?]+[.!?]*/g) ?? [marked];
  const kept: string[] = [];
  for (const raw of sentences) {
    if (!raw.includes("\u0000")) { kept.push(raw.trim()); continue; }
    const s = raw.replace(/\u0000/g, " ").replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").replace(/([,;:])\s*([.!?])/g, "$2").replace(/^[\s,;:]+/, "").trim();
    const words = s.replace(/[^\p{L}\p{N}\s']/gu, " ").trim().split(/\s+/).filter(Boolean);
    if (words.length < 3 || DANGLING_END.test(s)) continue;
    kept.push(s);
  }
  return { text: kept.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(), removed: merged.length };
}

/** Price validator rewrite: drop currency amounts that aren't exact public values ("the hotel is $150" → gone). */
export function stripInvalidPrices(text: string, ctx: PrivacyContext, found?: Amount[]) {
  return stripAmounts(text, (a) => a.currency && a.value >= 1 && !isAllowed(ctx, a.value), found);
}

function escape(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export { isAllowed as isPublicAmount };
