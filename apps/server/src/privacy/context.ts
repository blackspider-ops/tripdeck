/**
 * The one privacy context for a table (OPT-013 / TR4-012): built once, from the same plan set the
 * Advocates argue over (the top-12 chart book), and shared by the engine's line filter, the hail
 * filter and the memory/note text that goes into prompts.
 */
import type { Dataset, Plan } from "@all-ayes/shared";
import { publicTotalRange, type PricingMember } from "../fit/pricing.js";
import type { PrivacyContext } from "./filter.js";

/**
 * Secret = caps, shares, headroom — and each plan's exact group total, the sum of the shares (S2-002). Allowed =
 * public listing prices + the public group-total range of these plans (doc 05 §7.1).
 */
/** O2-033: headroom (cap − share) above this is itself a secret; below it, it is too small to say anything. */
const HEADROOM_SECRET_MIN_CENTS = 2_000;

export function buildPrivacyContext(ds: Dataset, crew: PricingMember[], plans: Plan[]): PrivacyContext {
  const sensitive = new Set<number>();
  for (const c of crew) sensitive.add(c.brief.capCents / 100);
  for (const p of plans) sensitive.add(Math.round(p.groupCents / 100));
  for (const p of plans) for (const m of p.members) {
    sensitive.add(Math.round(m.amountCents / 100));
    const cap = crew.find((c) => c.memberId === m.memberId)?.brief.capCents ?? 0;
    if (cap - m.amountCents > HEADROOM_SECRET_MIN_CENTS) sensitive.add(Math.round((cap - m.amountCents) / 100));
  }
  const allowed = new Set<number>();
  for (const f of ds.flights) allowed.add(f.priceCents / 100);
  for (const h of ds.hotels) allowed.add(h.nightlyCents / 100);
  for (const a of ds.activities) allowed.add(a.priceCents / 100);
  for (const p of plans) {
    const r = publicTotalRange(ds, p);
    allowed.add(r.lowCents / 100);
    allowed.add(r.highCents / 100);
  }
  return { sensitiveDollars: [...sensitive], allowedDollars: [...allowed], names: crew.map((c) => c.name) };
}
