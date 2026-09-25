import { MAX_MUST_HAVES, TAGS, type Tag } from "@all-ayes/shared";

/**
 * TR1-013: what the Brief can pencil in from a returning member's memory (doc 03 P4 "banner + pre-fill").
 * The helm remembers booked voyages as one line, e.g.
 *   "voyage: Lisbon, Mar 12–16 · booked · mid budget · liked: Street food tour, Fado night"
 * (never an amount — only a budget band), and voided ones without a band. We read the newest booked line.
 */
interface MemoryPrefill { capCents?: number; mustHaves: Tag[] }

/** A dial position inside each remembered band (memory.ts budgetBand: < $800, < $1,300, above). */
const BAND_CAP: Record<string, number> = {
  "tight budget": 70_000,
  "mid budget": 100_000,
  "comfortable budget": 150_000,
};

export function prefillFromMemory(memory: string[]): MemoryPrefill | null {
  const line = [...memory].reverse().find((m) => / · booked · /.test(m));
  if (!line) return null;
  const parts = line.split(" · ").map((p) => p.trim());
  const band = parts.find((p) => p in BAND_CAP);
  const liked = (parts.find((p) => p.startsWith("liked:")) ?? "").slice("liked:".length).toLowerCase();
  const mustHaves: Tag[] = [];
  for (const t of TAGS) {
    const stem = t.id.replace(/s$/, ""); // "museums" → "museum"
    if (new RegExp(`\\b${stem}`).test(liked)) mustHaves.push(t.id);
    if (mustHaves.length >= MAX_MUST_HAVES) break;
  }
  if (!band && !mustHaves.length) return null;
  return { capCents: band ? BAND_CAP[band] : undefined, mustHaves };
}

/** The newest memory line, for the banner (after "Remembered from your last voyage:", so without its own "voyage:" label). */
export function latestMemory(memory: string[]): string | null {
  return memory.length ? memory[memory.length - 1].replace(/^voyage:\s*/i, "") : null;
}
