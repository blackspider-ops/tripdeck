/**
 * Satisfaction per member, 0–100 (docs/05-agent-spec.md §5):
 *   0 if the plan doesn't fit, else
 *   45·mustHaveCoverage + 25·min(headroom,0.3)/0.3 + 20·(1 − min(flags,3)/3) + 10·rating/5
 */
export function satisfaction(p: {
  fits: boolean; coverage: number; capCents: number; shareCents: number; flagCount: number; hotelRating: number;
}): number {
  if (!p.fits) return 0;
  const headroom = p.capCents > 0 ? (p.capCents - p.shareCents) / p.capCents : 0;
  const s =
    45 * p.coverage +
    (25 * Math.min(Math.max(headroom, 0), 0.3)) / 0.3 +
    20 * (1 - Math.min(p.flagCount, 3) / 3) +
    10 * (p.hotelRating / 5);
  return round1(s);
}

/** Plan score = (maximin, sum): protect the worst-off member first. */
export function fairness(sats: number[]): { maximin: number; sum: number } {
  if (!sats.length) return { maximin: 0, sum: 0 };
  return { maximin: round1(Math.min(...sats)), sum: round1(sats.reduce((a, b) => a + b, 0)) };
}

export function compareFairness(a: { maximin: number; sum: number }, b: { maximin: number; sum: number }): number {
  return b.maximin - a.maximin || b.sum - a.sum;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
