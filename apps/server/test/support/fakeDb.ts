/**
 * In-memory stand-in for src/store/db.ts (WP-10). Documents go through a BSON round trip with the driver's old
 * default (`ignoreUndefined: false`, so `undefined` becomes `null`, TR5-010), which is what production restores saw.
 * Use with: vi.mock("../src/store/db.js", async () => (await import("./support/fakeDb.js")).fakeDb)
 */
import { BSON } from "mongodb";
import { stripNulls } from "../../src/store/normalize.js";

type Doc = { _id: string } & Record<string, unknown>;
const store = new Map<string, Map<string, Doc>>();
const state = {
  connected: false, hook: null as null | (() => void | Promise<void>), writes: [] as { col: string; id: string }[],
  /** R2-WP-06: the health mode while disconnected ("reconnecting" = MongoDB configured but unreachable). */
  mode: "memory" as string,
  /** R2-WP-06: collections whose loads throw (a network blip), each for this many more calls. */
  failLoads: {} as Record<string, number>,
};
const blip = (c: string) => { if ((state.failLoads[c] ?? 0) > 0) { state.failLoads[c]--; throw new Error(`fakeDb: ${c} load failed`); } };
let seq = 0;

const bson = <T>(d: T): T => BSON.deserialize(BSON.serialize(d as Record<string, unknown>, { ignoreUndefined: false })) as T;
const col = (name: string) => { let m = store.get(name); if (!m) store.set(name, (m = new Map())); return m; };

function cmp(v: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
    return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
      switch (op) {
        case "$in": return (arg as unknown[]).includes(v);
        case "$nin": return !(arg as unknown[]).includes(v);
        case "$gte": return v != null && (v as number) >= (arg as number);
        case "$lte": return v != null && (v as number) <= (arg as number);
        case "$lt": return v != null && (v as number) < (arg as number);
        case "$exists": return (v !== undefined) === Boolean(arg);
        default: throw new Error(`fakeDb: unsupported operator ${op}`);
      }
    });
  }
  return v === cond;
}
export function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return (cond as Record<string, unknown>[]).some((f) => matches(doc, f));
    return cmp(doc[k], cond);
  });
}

export const fakeDb = {
  COLLECTIONS: ["trips", "members", "briefs", "bookings", "events", "passkeys", "turns", "memories", "backboard_assistants", "spend", "shortlists"],
  persist: (c: string, doc: Doc) => { state.writes.push({ col: c, id: doc._id }); col(c).set(doc._id, bson(doc)); },
  append: (c: string, doc: Record<string, unknown>) => { const _id = `e${++seq}`; col(c).set(_id, bson({ _id, ...doc })); },
  // O2-039: like the real loader, loaded docs come back without `null` fields (the helm doesn't strip them again)
  loadAll: async (c: string) => { blip(c); return [...col(c).values()].map((d) => stripNulls(bson(d))); },
  loadWhere: async (c: string, filter: Record<string, unknown>, opts: { sort?: Record<string, 1 | -1>; limit?: number } = {}) => {
    blip(c);
    let rows = [...col(c).values()].filter((d) => matches(d, filter));
    const [key, dir] = Object.entries(opts.sort ?? {})[0] ?? [];
    if (key) rows = rows.sort((a, b) => ((a[key] as number) > (b[key] as number) ? 1 : -1) * (dir as number));
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows.map((d) => stripNulls(bson(d)));
  },
  /** R2-WP-11: turns of rounds before `round` are deleted. */
  deleteOldTurns: (tripId: string, round: number) => { for (const [id, d] of col("turns")) if (d.tripId === tripId && ((d.round as number) ?? 0) < round) col("turns").delete(id); },
  dbConnected: () => state.connected,
  /** O2-038: the fake always takes writes (connected or not), so tests see every persist. */
  writesOn: () => true,
  onDbConnected: (fn: () => void | Promise<void>) => { state.hook = fn; },
  dbHealth: () => ({ mode: state.connected ? "mongo" : state.mode, degraded: false }),
  connectDb: async () => state.connected,
  flushDb: async () => undefined,
  closeDb: async () => undefined,
};

/** Test controls. */
export const fake = {
  state,
  /** The stored docs of a collection (live: mutate them to simulate lost or partial writes). */
  docs: <T = Record<string, unknown>>(c: string) => [...col(c).values()] as unknown as T[],
  get: <T = Record<string, unknown>>(c: string, id: string) => col(c).get(id) as unknown as T | undefined,
  delete: (c: string, id: string) => col(c).delete(id),
  reset() { store.clear(); state.writes = []; state.connected = false; state.hook = null; state.mode = "memory"; state.failLoads = {}; },
  /** A frozen copy of the whole database, to restore several helms from the same moment. */
  snapshot() { return new Map([...store].map(([k, m]) => [k, new Map([...m].map(([id, d]) => [id, bson(d)]))])); },
  load(snap: Map<string, Map<string, Doc>>) { store.clear(); for (const [k, m] of snap) store.set(k, new Map([...m].map(([id, d]) => [id, bson(d)]))); },
};
