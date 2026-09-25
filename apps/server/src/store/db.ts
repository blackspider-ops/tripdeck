/**
 * Persistence: the server keeps live state in memory (fast, simple) and writes through to MongoDB Atlas
 * when MONGODB_URI is set (doc 04 §4). On boot it reloads the live voyages so a restart resumes them.
 *
 * WP-10:
 *  - writes are ordered and coalesced per document (store/writeQueue.ts, TR5-005/OPT-041), guarded by `version`
 *    when the document has one (an older snapshot never replaces a newer one), retried with backoff, and counted in
 *    /api/health (dbHealth);
 *  - a failed connect at boot retries in the background (store/reconnect.ts, TR5-007) and index creation is separate
 *    from connecting (an index error is logged, it doesn't disable persistence);
 *  - the driver ignores `undefined` (TR5-010) and loaded docs are normalized (no `null` optional fields);
 *  - collections are typed (OPT-063): `persist("members", tripDoc)` doesn't compile.
 * R2-WP-06:
 *  - parked writes are retried after any successful write and on a timer (L5-001); a shutdown logs what is parked;
 *  - one writer at a time (L5-002): the helm holds a lease (store/lease.ts) before it restores or writes; losing it
 *    fences this instance (no more writes) and, like a stale (version-guarded) write, raises `degraded`;
 *  - a duplicate join code on a trip write asks the helm for a new code (L5-010, store/hooks.ts).
 */
import { MongoClient, type Db, type Filter, type Document } from "mongodb";
import type { Turn } from "@all-ayes/shared";
import { config, features } from "../config.js";
import { WriteQueue, PermanentWriteError, type WriteOutcome } from "./writeQueue.js";
import { startReconnect, type Reconnector } from "./reconnect.js";
import { stripNulls } from "./normalize.js";
import { HelmLease, type LeaseState, type LeaseStore } from "./lease.js";
import { raiseJoinCodeClash } from "./hooks.js";
import { EventBuffer } from "./eventBuffer.js";
import type { MemberRec, TripDoc, BriefRec, ShortlistDoc } from "../trips/records.js";
import type { BookingRec } from "../payments/orchestrator.js";

let db: Db | null = null;
let client: MongoClient | null = null;
let reconnector: Reconnector | null = null;
let onConnectedHook: (() => void | Promise<void>) | null = null;
let lease: HelmLease | null = null;
const inserts = new Set<Promise<unknown>>();
let eventErrors = 0;
let lastEventErrorLog = 0;

export const COLLECTIONS = ["trips", "members", "briefs", "bookings", "events", "passkeys", "turns", "memories", "backboard_assistants", "spend", "shortlists"] as const;
export type Collection = (typeof COLLECTIONS)[number];

/**
 * R2-WP-12 (L5-011 / S2-014): paid-call counters (util/limits.ts `spend`). `_id` = `day:<utcDay>` (whole server) or
 * `trip:<tripId>` (one voyage); replaced whole through the write queue. Old ones expire (TTL on `updatedAt`).
 */
export type SpendDoc = { _id: string; gemini: number; tts: number; stt: number; backboard: number; tripId?: string; updatedAt: Date };
/** Spend counters untouched this long are dropped by Mongo (a day's are only read that day; a voyage's while it lives). */
export const SPEND_TTL_SECONDS = 90 * 24 * 3600;

/** docs/04 §4.8: append-only audit, bounded by a TTL index on `at`. */
export interface EventDoc {
  tripId: string; type: string; audience: string; payloadRedacted: string; at: Date;
}
/** docs/04 §4.6: one document per turn (`_id` = turnId), keyed by (tripId, round, seq). */
export type TurnDoc = Turn & {
  _id: string; round: number;
  /** Server-only: the TTS cache key of the turn's voice, so a restart can serve it again (voice.ts restoreTurnAudio). */
  audioKey?: string;
};
/** Persisted booking: seals never carry the member's private cap (TR5-015). */
export type BookingDoc = Omit<BookingRec, "seals"> & { seals: Omit<BookingRec["seals"][number], "capCents">[]; version: number };

export interface Docs {
  trips: TripDoc;
  members: MemberRec;
  briefs: BriefRec;
  bookings: BookingDoc;
  turns: TurnDoc;
  passkeys: { _id: string } & Record<string, unknown>;
  /** WP-11 memory stores: one `{_id: key, v}` doc per entry. */
  memories: { _id: string; v: unknown };
  backboard_assistants: { _id: string; v: unknown };
  spend: SpendDoc;
  /** R2-WP-14 (O2-036): the Two Charts' plan bodies, one doc per voyage (`_id` = tripId), written when the table decides. */
  shortlists: ShortlistDoc;
}
export type DocCollection = keyof Docs;

/** Events older than this are dropped by Mongo (TTL index), so the collection stays bounded (TR5-013). */
export const EVENTS_TTL_SECONDS = 30 * 24 * 3600;
/** O2-032: how long a connect waits for a server, and how often a failing event insert is logged. */
const SERVER_SELECTION_MS = 5_000;
const EVENT_ERROR_LOG_EVERY_MS = 60_000;
/** O2-037: audit rows are inserted in batches: whatever arrived within this long, or this many at once. */
const EVENT_BATCH_MS = 250;
const EVENT_BATCH_ROWS = 100;

/**
 * What a failed write means (L5-010 / TR5-005): `stale` = a newer version is already stored; `joinCode` = a trip's
 * join code is taken (the helm draws a new one); `permanent` = another unique-key clash (retrying can't fix it);
 * `retry` = anything else (network, failover).
 */
export function classifyWriteError(col: string, err: { code?: number; keyPattern?: Record<string, unknown>; message?: string }): "stale" | "joinCode" | "permanent" | "retry" {
  if (err?.code !== 11000) return "retry";
  const msg = String(err.message ?? "");
  // the version filter missed and the upsert then clashed on _id: a newer write already landed
  if (err.keyPattern ? "_id" in err.keyPattern : /_id_/.test(msg)) return "stale";
  if (col === "trips" && (err.keyPattern ? "joinCode" in err.keyPattern : /joinCode/.test(msg))) return "joinCode";
  return "permanent";
}

/** L5-002: writes need the lease once one is in play; a fenced instance never writes again. */
const fenced = () => lease !== null && !lease.held;

async function writeDoc(col: string, doc: { _id: string } & Record<string, unknown>): Promise<WriteOutcome> {
  if (!db) throw new Error("MongoDB not connected");
  if (fenced()) throw new PermanentWriteError("another helm holds the lease; this instance no longer writes");
  // Optimistic guard (docs/04 §4.1 `version`): never replace a stored doc that has a higher version.
  const filter: Filter<Document> = typeof doc.version === "number"
    ? { _id: doc._id as never, $or: [{ version: { $lte: doc.version } }, { version: { $exists: false } }] }
    : { _id: doc._id as never };
  try {
    await db.collection(col).replaceOne(filter, doc, { upsert: true });
    return "ok";
  } catch (e) {
    const err = e as { code?: number; keyPattern?: Record<string, unknown>; message: string };
    const kind = classifyWriteError(col, err);
    if (kind === "stale") return "stale";
    if (kind === "joinCode") raiseJoinCodeClash(doc._id); // parked now; the helm re-saves with a new code
    if (kind !== "retry") throw new PermanentWriteError(err.message); // retrying this snapshot can't fix it
    throw e;
  }
}

const queue = new WriteQueue(writeDoc);

async function ensureIndexes(d: Db) {
  const specs: [string, Record<string, 1 | -1>, Record<string, unknown>?][] = [
    ["trips", { joinCode: 1 }, { unique: true }],
    ["trips", { status: 1, updatedAt: -1 }],
    ["members", { tripId: 1 }],
    ["briefs", { tripId: 1, memberId: 1 }, { unique: true }],
    ["bookings", { tripId: 1 }],
    ["bookings", { status: 1 }],
    ["turns", { tripId: 1, round: 1, seq: 1 }, { unique: true }],
    ["events", { tripId: 1, at: 1 }],
    ["events", { at: 1 }, { expireAfterSeconds: EVENTS_TTL_SECONDS }],
    ["passkeys", { memberId: 1 }],
    ["spend", { updatedAt: 1 }, { expireAfterSeconds: SPEND_TTL_SECONDS }],
  ];
  // TR5-007: an index failure (e.g. an existing duplicate joinCode) is logged; persistence stays on
  const results = await Promise.allSettled(specs.map(([col, keys, opts]) => d.collection(col).createIndex(keys, opts ?? {})));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`[db] index ${specs[i][0]} ${JSON.stringify(specs[i][1])} failed:`, (r.reason as Error).message);
  });
}

async function tryConnect(): Promise<boolean> {
  const c = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: SERVER_SELECTION_MS, ignoreUndefined: true });
  try {
    await c.connect();
    const d = c.db(config.mongoDb);
    await d.command({ ping: 1 });
    client = c; db = d;
    await ensureIndexes(d);
    return true;
  } catch (e) {
    await c.close().catch(() => undefined);
    console.warn("[db] MongoDB unavailable:", (e as Error).message);
    return false;
  }
}

export async function connectDb(): Promise<boolean> {
  if (!features.mongo()) {
    if (config.production) console.error("[db] ⚠ NODE_ENV=production without MONGODB_URI: voyages live in memory only and are lost on restart");
    return false;
  }
  if (await tryConnect()) {
    console.log(`[db] MongoDB connected (${config.mongoDb})`);
    return true;
  }
  console.error("[db] ⚠ running in memory only while MongoDB is unreachable; retrying in the background");
  reconnector = startReconnect({
    attempt: tryConnect,
    onConnected: async () => {
      reconnector = null;
      await acquireHelmLease(); // L5-002: nothing is merged or written while another helm holds it
      queue.retryFailed();
      await onConnectedHook?.();
    },
  });
  return false;
}

/** Called once the database comes back after a failed boot connect (the helm merges and flushes its state). */
export function onDbConnected(fn: () => void | Promise<void>) { onConnectedHook = fn; }

export const dbConnected = () => db !== null;

/** L5-002: the lease lives in its own collection; `_id` is unique, so a live lease held by another owner refuses. */
function mongoLeaseStore(d: Db): LeaseStore {
  const c = d.collection<{ _id: string; owner: string; expiresAt: Date }>("helm_lease");
  return {
    async take(owner, ttlMs) {
      const now = new Date();
      try {
        await c.updateOne({ _id: "helm", $or: [{ owner }, { expiresAt: { $lt: now } }] }, { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } }, { upsert: true });
        return true;
      } catch (e) {
        if ((e as { code?: number }).code === 11000) return false; // held by another, unexpired
        throw e;
      }
    },
    async release(owner) { await c.deleteOne({ _id: "helm", owner }); },
  };
}

/**
 * L5-002: waits until this process holds the helm lease (at boot before restore, and after a reconnect before the
 * merge). No-op without MongoDB, or when it is already held. Until it is held nothing is written.
 */
export async function acquireHelmLease(): Promise<void> {
  if (!db || lease?.held) return;
  lease?.stop();
  lease = new HelmLease(mongoLeaseStore(db));
  await lease.acquire();
}

/** Pure part of the health block (tested): what counts as the alarm. */
export function isDegraded(p: { mode: string; failed: number; retrying: number; staleSkipped: number; lease: LeaseState | "off"; production: boolean }) {
  return p.mode === "reconnecting" || p.mode === "unavailable" || p.failed > 0 || p.retrying > 0
    // L5-002: a version-guarded write that lost, or a lost lease, means another instance is writing
    || p.staleSkipped > 0 || p.lease === "lost" || p.lease === "waiting"
    || (p.production && p.mode === "memory");
}

/** Health block for /api/health (TR5-005/TR5-007). `degraded` is the alarm. */
export function dbHealth() {
  const w = queue.health();
  const mode = db ? "mongo" : reconnector ? "reconnecting" : features.mongo() ? "unavailable" : "memory";
  const leaseState: LeaseState | "off" = lease?.state ?? "off";
  return {
    mode,
    degraded: isDegraded({ mode, failed: w.failed, retrying: w.retrying, staleSkipped: w.staleSkipped, lease: leaseState, production: config.production }),
    reconnectAttempts: reconnector?.attempts ?? 0,
    lease: leaseState,
    writes: w,
    eventErrors,
  };
}

/**
 * O2-038: whether a persist would be written at all (MongoDB connected and this instance holds the lease), so a
 * caller can skip building a document that would be dropped.
 */
export const writesOn = () => db !== null && !fenced();

/** Ordered, coalesced upsert (see writeQueue.ts); never blocks the caller. */
export function persist<C extends DocCollection>(col: C, doc: Docs[C]) {
  // L5-002: without the lease nothing is queued (a reconnect merge re-persists everything once it is held)
  if (!db || fenced()) return;
  queue.enqueue(col, doc as unknown as { _id: string } & Record<string, unknown>);
}

/** O2-037: one unordered `insertMany` per batch. Errors are counted per row and logged (at most once a minute). */
const events = new EventBuffer<EventDoc>((rows) => {
  if (!db || fenced()) return;
  const p = db.collection("events").insertMany(rows.map((r) => ({ ...r })), { ordered: false }).catch((e: Error & { insertedCount?: number }) => {
    eventErrors += Math.max(1, rows.length - Number(e.insertedCount ?? 0)); // MongoBulkWriteError says how many landed
    if (Date.now() - lastEventErrorLog > EVENT_ERROR_LOG_EVERY_MS) { lastEventErrorLog = Date.now(); console.warn(`[db] event insert failed (${eventErrors} so far):`, e.message); }
  }).finally(() => inserts.delete(p));
  inserts.add(p);
}, { delayMs: EVENT_BATCH_MS, maxRows: EVENT_BATCH_ROWS });

/** Append-only audit rows (docs/04 §4.8), batched (O2-037); flushed on shutdown. */
export function append(_col: "events", doc: EventDoc) {
  if (!db || fenced()) return;
  events.push(doc);
}

/**
 * R2-WP-11 (L5-008): a voyage's turns of earlier rounds (interrupted or replaced meetings) are never read again, so a
 * new round deletes them. Fire and forget like `append` (a failure is logged; the next round tries again); a write of
 * an old turn still queued can land after it and is removed by the next round.
 */
export function deleteOldTurns(tripId: string, round: number) {
  if (!db || fenced()) return;
  const p = db.collection("turns").deleteMany({ tripId, round: { $lt: round } })
    .catch((e: Error) => console.warn(`[db] old turns of ${tripId} not deleted:`, e.message))
    .finally(() => inserts.delete(p));
  inserts.add(p);
}

export async function loadAll<T>(col: Collection): Promise<T[]> {
  return loadWhere<T>(col, {});
}

/** Filtered load (TR5-016: restore reads only live and recent voyages). */
export async function loadWhere<T>(col: Collection, filter: Record<string, unknown>, opts: { sort?: Record<string, 1 | -1>; limit?: number } = {}): Promise<T[]> {
  if (!db) return [];
  let cursor = db.collection(col).find(filter as Filter<Document>);
  if (opts.sort) cursor = cursor.sort(opts.sort);
  if (opts.limit) cursor = cursor.limit(opts.limit);
  return (await cursor.toArray()).map((d) => stripNulls(d)) as unknown as T[];
}

async function flushDb() {
  events.flush();
  await queue.flush();
  await Promise.allSettled([...inserts]);
}

export async function closeDb() {
  reconnector?.stop();
  await flushDb();
  queue.stop();
  // L5-001: whatever never reached MongoDB is named, so it can be repaired by hand
  const parked = queue.parked();
  if (parked.length) console.error(`[db] ⚠ ${parked.length} write(s) never reached MongoDB: ${parked.map((p) => `${p.col}/${p.id}${p.permanent ? " (permanent)" : ""}`).join(", ")}`);
  await lease?.release(); // L5-002: the next helm can restore at once
  await client?.close();
}
