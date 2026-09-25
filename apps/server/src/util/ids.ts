import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { customAlphabet, nanoid } from "nanoid";
import { JOIN_CODE_LEN } from "@all-ayes/shared";

/** OPT-028: the one human-facing alphabet (32 letters and digits, no lookalikes: no 0/O/1/I). */
export const NO_LOOKALIKES = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const refMakers = new Map<number, () => string>();
/** A random code of `n` characters from NO_LOOKALIKES (join codes, pair codes, booking references, SIM refs). */
export function newRef(n: number): string {
  let make = refMakers.get(n);
  if (!make) { make = customAlphabet(NO_LOOKALIKES, n); refMakers.set(n, make); }
  return make();
}

/** JOIN_CODE_LEN (6) chars, no lookalikes. */
export const newJoinCode = () => newRef(JOIN_CODE_LEN);
export const newId = () => nanoid(12);
export const newToken = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * O2-014: the helm's constant-time comparisons. `sameHex`: two hex digests (a malformed one never matches);
 * `sameHash`: a plain secret against its stored sha256; `safeEqual`: two strings of any length (hashed first).
 */
export function sameHex(aHex: string, bHex: string | undefined): boolean {
  if (!bHex) return false;
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
export const sameHash = (plain: string, hashed?: string) => sameHex(hash(plain), hashed);
const digest = (s: string) => createHash("sha256").update(s).digest();
export const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
