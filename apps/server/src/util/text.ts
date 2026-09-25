/**
 * OPT-019 / OPT-068: the sanitizer every human-typed string goes through. The text caps the phones mirror
 * (NAME_MAX_CHARS, TRIP_NAME_MAX_CHARS, HAIL_MAX_CHARS, NOTE_MAX_CHARS) live in @all-ayes/shared (R2-WP-13).
 */

/** The ribbon under a turn: its first few words. */
export const RIBBON_MAX_WORDS = 8;

/** Control characters and angle brackets removed, trimmed, then cut to `max` characters. */
export function clean(s: unknown, max: number): string {
  return String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
}

/** The first `n` whitespace-separated words, joined by single spaces. */
export function clampWords(s: string, n: number): string {
  return s.split(/\s+/).slice(0, n).join(" ");
}
