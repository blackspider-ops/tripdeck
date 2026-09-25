/**
 * TR5-010: documents written by an older build (or by the driver without `ignoreUndefined`) carry `null` where the
 * types say "absent". Restored docs are normalized so optional fields are missing again, never `null`. Array
 * elements are normalized recursively but kept (a `null` inside an array is data). Callers re-apply the few fields
 * whose absent value really is `null` (e.g. `trips.autoPick`).
 */
export function stripNulls<T>(doc: T): T {
  if (Array.isArray(doc)) return doc.map((x) => (x && typeof x === "object" ? stripNulls(x) : x)) as T;
  if (!doc || typeof doc !== "object" || doc instanceof Date) return doc;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[k] = v && typeof v === "object" ? stripNulls(v) : v;
  }
  return out as T;
}
