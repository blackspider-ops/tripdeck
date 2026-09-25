/**
 * O2-012: the budget bands a memory note may carry instead of a cap (doc 05 §9). The prompt guard
 * (privacy/guard.ts `memoryForPrompt`) builds its scrub from BUDGET_BANDS, so rewording a band here can never let
 * it reach a model prompt. Pure: no store, no network.
 */
export const BUDGET_BANDS = [
  { word: "tight", belowCents: 80_000 },
  { word: "mid", belowCents: 130_000 },
  { word: "comfortable", belowCents: Infinity },
] as const;

/** "tight budget" / "mid budget" / "comfortable budget" for a cap. */
export function budgetBand(capCents: number): string {
  return `${(BUDGET_BANDS.find((b) => capCents < b.belowCents) ?? BUDGET_BANDS[BUDGET_BANDS.length - 1]).word} budget`;
}
