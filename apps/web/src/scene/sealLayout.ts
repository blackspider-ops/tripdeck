// The seal chart's footprint on the table (kept apart from SealChart's meshes so the director can size it headless).

/** The sheet's width (m). */
export const SEAL_W = 0.3;
/** Past the sheet's south end: the roll, the twine and the reference tag (m). */
const TAIL = 0.045;
/** The lectern tilt (rad): the south edge lifts off the chart. */
export const SEAL_TILT = 0.18;

/**
 * The seal chart's scale (<= 1) so that, laid from `z0` (its north edge, in the chart's frame) toward the viewer, every
 * corner of the sheet (and its roll/tag) stays within `clearR` of the chart's centre: inside the ring of pieces.
 */
export function sealFit(length: number, z0: number, clearR: number): number {
  const L = (length + TAIL) * Math.cos(SEAL_TILT);
  const fits = (s: number) => Math.hypot((SEAL_W / 2 + 0.01) * s, z0 + L * s) <= clearR;
  if (fits(1)) return 1;
  let lo = 0.3, hi = 1;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
  return lo;
}
