/**
 * Guards shared by the engine and the service (OPT-013): what may be said out loud, what a hail may
 * carry into the room, and what untrusted text may go into a model prompt (SEC-017, SEC-023, TR4-006).
 */
import { NAME_MAX_CHARS, NOTE_MAX_CHARS } from "@all-ayes/shared";
import { BUDGET_BANDS } from "../memory/bands.js";
import { amountsIn, extractAmounts, filterLine, isPublicAmount, normalizeText, stripAmounts, stripInvalidPrices, type Amount, type PrivacyContext } from "./filter.js";

export interface Spoken { line: string; ribbon: string }

/**
 * Filter a line + ribbon. Invented prices are stripped (the rest of the line is kept); a secret leak or a
 * role impersonation rejects the whole line (null) so the caller regenerates or falls back.
 * `redactions` counts every removal and rewrite.
 */
export function sanitizeSpoken(out: Spoken, ctx: PrivacyContext): (Spoken & { redactions: number }) | null {
  let redactions = 0;
  const one = (text: string): string | null => {
    const f = filterLine(text, ctx);
    if (f.leak) return null;
    redactions += f.rewrites;
    if (!f.invalidPrice) return f.text;
    const s = stripInvalidPrices(f.text, ctx, f.amounts); // O2-044: no second scan
    redactions += s.removed;
    if (!s.text || filterLine(s.text, ctx).leak) return null;
    return s.text;
  };
  if (impersonates(out.line) || impersonates(out.ribbon)) return null;
  const line = one(out.line);
  if (line === null || !line.trim()) return null;
  const ribbon = one(out.ribbon);
  if (ribbon === null) return null;
  return { line, ribbon, redactions };
}

/** Strip passes before a hail that still carries a non-public amount is refused outright. */
const HAIL_STRIP_PASSES = 8;

/** O2-019: an amount that means money when said: 20 or more, or anything with a currency. */
const moneyAmount = (a: Amount) => a.value >= 20 || a.currency;

/**
 * A hail may carry no amount except exact public ones. Every other amount is removed — whether or not
 * it is near a secret — so the sender learns nothing about anyone's numbers from what gets through
 * (SEC-017 oracle). Returns null when nothing sensible is left (the caller rejects privately).
 *
 * S2-003: the result must be a function of the text and the *public* context only. The secrets are
 * dropped from the context before anything runs, stripping repeats to a fixpoint (removing `$5000` from
 * `9 $5000 0 0` leaves `9 0 0`, which is itself an amount and goes next), and acceptance depends only on
 * what is left — never on a leak check against the secrets.
 */
export function sanitizeHail(raw: string, ctx: PrivacyContext): { text: string; redactions: number } | null {
  const pub: PrivacyContext = { sensitiveDollars: [], allowedDollars: ctx.allowedDollars, names: ctx.names };
  const f = filterLine(raw, pub); // name + affordability rewrite (names are public)
  const nonPublic = (a: Amount) => moneyAmount(a) && !isPublicAmount(pub, a.value);
  let text = f.text;
  let redactions = f.rewrites;
  // O2-044: one scan per pass (the strip reuses it, on the same normalised text)
  let norm = text; // filterLine's text is normalised
  let found = f.amounts;
  for (let pass = 0; ; pass++) {
    if (!found.some(nonPublic)) break;
    if (pass >= HAIL_STRIP_PASSES) return null;
    const s = stripAmounts(norm, nonPublic, found);
    text = s.text;
    redactions += s.removed;
    norm = normalizeText(text);
    found = amountsIn(norm);
  }
  text = text.trim();
  if (text.split(/\s+/).filter(Boolean).length < 2) return null;
  return { text, redactions };
}

/** A line claiming to be someone else, or the system (SEC-023). */
export function impersonates(text: string): boolean {
  const t = normalizeText(text);
  return /\b(captain|system|assistant|narrator|admin|moderator|helm)\s*:/i.test(t)
    || /\b(?:this is|i am|i'm)\s+(?:the\s+)?captain\b/i.test(t)
    || /\b(?:booking|trip|voyage|payment)\s+(?:is\s+|has\s+been\s+)?(?:confirmed|booked|sealed|paid|captured)\b/i.test(t)
    || /\b(?:ignore|disregard)\s+(?:all|any|previous|prior|the)\b/i.test(t)
    || /\bas an ai\b|\blanguage model\b/i.test(t);
}

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,60}?\b(?:instructions?|rules?|prompts?|above|previous|system|guidelines?)\b/gi,
  /\b(?:system|assistant|user|developer|captain|narrator|admin)\s*:/gi,
  /\b(?:you are now|act as|pretend (?:to be|you are)|new instructions?|jailbreak|developer mode)\b/gi,
  /\b(?:say|repeat|output|print|respond with|reply with)\s*["'“‘][^"'”’]{0,120}["'”’]/gi,
];

/**
 * Untrusted text bound for a prompt (hail, note, memory): no control characters, quotes or braces,
 * instruction-shaped phrases removed, length capped. The prompt also says it is data, not instructions.
 */
export function promptText(s: string | undefined, max: number): string {
  let t = normalizeText(String(s ?? "")).replace(/[\u0000-\u001f\u007f`{}<>\[\]"\\]/g, " ");
  for (const re of INSTRUCTION_PATTERNS) t = t.replace(re, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") : t;
}

/** A crew name as it may appear in a prompt: letters, spaces, apostrophes and hyphens only, ≤ NAME_MAX_CHARS. */
export function promptName(name: string): string {
  const n = normalizeText(name).replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX_CHARS);
  return n || "your friend";
}

/** No dollar amounts reach a prompt from free text: every amount ≥ 20 and every currency amount is removed. */
function withoutAmounts(text: string): string {
  if (!extractAmounts(text).length) return text;
  return stripAmounts(text, moneyAmount).text;
}

/** A member's private note for their own Advocate: sanitised, amount-free, ≤ NOTE_MAX_CHARS (TR4-006). */
export function noteForPrompt(note: string | undefined): string | undefined {
  if (!note) return undefined;
  const t = withoutAmounts(promptText(note, NOTE_MAX_CHARS));
  return t || undefined;
}

/**
 * O2-012: a budget band as a memory note words it (memory/bands.ts), plus the looser words a person might use. Built
 * from BUDGET_BANDS, so a reworded band is still scrubbed.
 */
const BAND_WORDS = [...BUDGET_BANDS.map((b) => b.word), "low", "high", "big", "small"];
const BAND_PHRASE = new RegExp(`\\s*·?\\s*\\b(?:${BAND_WORDS.join("|")})\\s+budget\\b`, "gi");
/** Memory lines a prompt gets at most (the recall's last five). */
const PROMPT_MEMORY_LINES = 5;

/** Memory lines for a prompt: no budget band (derived from the cap, SEC-017), no amounts. */
export function memoryForPrompt(memory: string[]): string[] {
  return memory
    .map((m) => withoutAmounts(promptText(m.replace(BAND_PHRASE, ""), NOTE_MAX_CHARS)))
    .filter(Boolean)
    .slice(0, PROMPT_MEMORY_LINES);
}
