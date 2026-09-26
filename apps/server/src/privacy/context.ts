/**
 * The one privacy context for a table (OPT-013 / TR4-012): built once, from the same plan set the
 * Advocates argue over (the top-12 chart book), and shared by the engine's line filter, the hail
 * filter and the memory/note text that goes into prompts.
 */
import type { Dataset, Plan } from "@all-ayes/shared";
import { publicTotalRange, roomsFor, type PricingMember } from "../fit/pricing.js";
import { publicFlights } from "../fit/flights.js";
import { indexOf } from "../data/loader.js";
import type { PrivacyContext } from "./filter.js";

/**
 * Secret = caps, shares, headroom — and each plan's exact group total, the sum of the shares (S2-002). Allowed =
 * public listing prices + the public group-total range of these plans (doc 05 §7.1).
 */
/** O2-033: headroom (cap − share) above this is itself a secret; below it, it is too small to say anything. */
const HEADROOM_SECRET_MIN_CENTS = 2_000;

export function buildPrivacyContext(ds: Dataset, crew: PricingMember[], plans: Plan[], keepSensitive: readonly number[] = []): PrivacyContext {
  // docs/12: a re-priced chart book (live prices) keeps the earlier secrets too, so nothing said before becomes sayable
  const sensitive = new Set<number>(keepSensitive);
  for (const c of crew) sensitive.add(c.brief.capCents / 100);
  for (const p of plans) sensitive.add(Math.round(p.groupCents / 100));
  for (const p of plans) for (const m of p.members) {
    sensitive.add(Math.round(m.amountCents / 100));
    const cap = crew.find((c) => c.memberId === m.memberId)?.brief.capCents ?? 0;
    if (cap - m.amountCents > HEADROOM_SECRET_MIN_CENTS) sensitive.add(Math.round((cap - m.amountCents) / 100));
  }
  // public listing prices of the ports and windows on this table: every home airport's flights there (curated or
  // modelled), the stays and activities
  const allowed = new Set<number>();
  const ix = indexOf(ds);
  const cities = [...new Set(plans.map((p) => p.cityId))];
  const windows = [...new Set(plans.map((p) => p.dateWindowId))];
  for (const c of cities) for (const w of windows) for (const f of publicFlights(ds, c, w)) if (f.priceCents) allowed.add(f.priceCents / 100);
  // a stay's listing price, and its nightly for the rooms/units this crew books (a public count: crew size ÷ sleeps)
  for (const c of cities) for (const h of ix.hotelsOf(c)) {
    allowed.add(h.nightlyCents / 100);
    allowed.add((h.nightlyCents * roomsFor(h, crew.length)) / 100);
  }
  // live stays (docs/12) are listings too: their price depends only on the port, window and crew size. Live fares are
  // not added: they exist only for the crew's own home airports, so saying one would say where someone flies from.
  for (const p of plans) if (p.stay) {
    allowed.add(p.stay.nightlyCents / 100);
    allowed.add((p.stay.nightlyCents * roomsFor(p.stay, crew.length)) / 100);
  }
  for (const c of cities) for (const a of ix.activitiesOf(c)) allowed.add(a.priceCents / 100);
  for (const p of plans) {
    const r = publicTotalRange(ds, p);
    allowed.add(r.lowCents / 100);
    allowed.add(r.highCents / 100);
  }
  // A public price that sits on a secret (within the filter's $1 tolerance) would let that secret be said aloud:
  // it is dropped from the allowed list, so the secret wins (with ~40 home airports the listing prices are dense).
  const clash = (v: number) => [...sensitive].some((s) => s >= 20 && Math.abs(s - v) <= 1);
  return { sensitiveDollars: [...sensitive], allowedDollars: [...allowed].filter((v) => !clash(v)), names: crew.map((c) => c.name) };
}
