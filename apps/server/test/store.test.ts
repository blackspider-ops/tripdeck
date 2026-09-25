/**
 * WP-10 — the persistence layer itself: ordered/coalesced writes (TR5-005, OPT-041), background reconnect (TR5-007),
 * null normalization (TR5-010) and the /api/health block. No MongoDB needed.
 */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { MONGODB_URI: "" }));

import { WriteQueue, PermanentWriteError, type Writer } from "../src/store/writeQueue.js";
import { startReconnect } from "../src/store/reconnect.js";
import { stripNulls } from "../src/store/normalize.js";
import { dbHealth, persist, EVENTS_TTL_SECONDS, COLLECTIONS, classifyWriteError, isDegraded } from "../src/store/db.js";
import { HelmLease, memoryLeaseStore } from "../src/store/lease.js";
import { restoreOrRetry } from "../src/store/restoreRetry.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("TR5-005: one ordered write per document, latest state wins", () => {
  it("a slow first write can't land after a newer one; the DB ends equal to the last in-memory state", async () => {
    const db = new Map<string, Record<string, unknown>>();
    let calls = 0;
    const writer: Writer = async (col, doc) => {
      const n = ++calls;
      await sleep(n === 1 ? 40 : 1); // the first write is slow (a different pool connection, say)
      db.set(`${col}/${doc._id}`, doc);
      return "ok";
    };
    const q = new WriteQueue(writer);
    const live = { _id: "t1", version: 1, status: "BRIEFING" };
    q.enqueue("trips", live);
    await sleep(5); // first write in flight
    for (const s of ["AT_TABLE", "DRY_RUN", "SEALING"]) { live.version++; live.status = s; q.enqueue("trips", live); }
    await q.flush();
    expect(db.get("trips/t1")).toEqual({ _id: "t1", version: 4, status: "SEALING" });
    expect(calls).toBe(2); // the three later persists were coalesced into one write
  });

  it("the snapshot is taken at dispatch: mutating the live object mid-write doesn't change what was sent", async () => {
    const sent: unknown[] = [];
    const q = new WriteQueue(async (_c, doc) => { sent.push(doc); await sleep(5); return "ok"; });
    const live = { _id: "m1", seals: [{ status: "PENDING" }] };
    q.enqueue("bookings", live);
    await sleep(1);
    live.seals[0].status = "AUTHORIZED";
    await q.flush();
    expect(sent[0]).toEqual({ _id: "m1", seals: [{ status: "PENDING" }] });
  });

  it("failures are retried with backoff; a write that keeps failing is reported, and a permanent one isn't retried", async () => {
    let fail = 2;
    const logs: string[] = [];
    const ok = new WriteQueue(async () => { if (fail-- > 0) throw new Error("socket closed"); return "ok"; }, { baseDelayMs: 1, log: (m) => logs.push(m) });
    ok.enqueue("trips", { _id: "a" });
    await sleep(30);
    await ok.flush();
    expect(ok.health()).toMatchObject({ failed: 0, totalFailures: 2, totalWrites: 1 });

    const bad = new WriteQueue(async () => { throw new Error("no primary"); }, { baseDelayMs: 1, maxAttempts: 3, log: (m) => logs.push(m) });
    bad.enqueue("trips", { _id: "b" });
    await sleep(40);
    expect(bad.health()).toMatchObject({ failed: 1, totalFailures: 3 });
    expect(bad.health().lastError).toContain("trips/b");

    let tries = 0;
    const dup = new WriteQueue(async () => { tries++; throw new PermanentWriteError("E11000 duplicate key joinCode"); }, { baseDelayMs: 1, log: () => undefined });
    dup.enqueue("trips", { _id: "c" });
    await sleep(20);
    expect(tries).toBe(1);
    expect(dup.health().failed).toBe(1);
    // a later persist of the same doc gives it another go
    dup.enqueue("trips", { _id: "c" });
    await sleep(10);
    expect(tries).toBe(2);
  });

  it("stale writes (a newer version already stored) are skipped and counted, not failed", async () => {
    const q = new WriteQueue(async () => "stale");
    q.enqueue("trips", { _id: "t", version: 1 });
    await q.flush();
    expect(q.health()).toMatchObject({ staleSkipped: 1, failed: 0 });
  });
});

describe("TR5-007: reconnect in the background", () => {
  it("retries with backoff until MongoDB answers, then runs the sync once", async () => {
    let n = 0;
    const synced = vi.fn();
    const r = startReconnect({ attempt: async () => ++n >= 3, onConnected: synced, baseDelayMs: 1, maxDelayMs: 4, log: () => undefined });
    await sleep(60);
    expect(n).toBe(3);
    expect(r.attempts).toBe(3);
    expect(r.running).toBe(false);
    expect(synced).toHaveBeenCalledTimes(1);
  });

  it("stop() ends the loop", async () => {
    let n = 0;
    const r = startReconnect({ attempt: async () => { n++; return false; }, onConnected: () => undefined, baseDelayMs: 1, maxDelayMs: 2, log: () => undefined });
    await sleep(15);
    r.stop();
    const at = n;
    await sleep(15);
    expect(n).toBe(at);
  });
});

describe("TR5-010: normalize nulls on load", () => {
  it("drops null/undefined keys at any depth, keeps array elements, Dates and falsy values", () => {
    const at = new Date();
    expect(stripNulls({ a: null, b: 0, c: "", d: false, e: { f: null, g: [1, null, { h: null, i: 2 }] }, at })).toEqual({ b: 0, c: "", d: false, e: { g: [1, null, { i: 2 }] }, at });
  });
});

describe("health and schema", () => {
  it("/api/health's persistence block: memory mode without MONGODB_URI, write stats, no alarm outside production", () => {
    persist("trips", { _id: "x" } as never); // no database: a no-op, never queued
    const h = dbHealth();
    expect(h.mode).toBe("memory");
    expect(h.degraded).toBe(false);
    expect(h.writes).toMatchObject({ pending: 0, failed: 0 });
  });
  it("events are bounded by a TTL and turns have their own collection (TR5-013/TR5-012)", () => {
    expect(EVENTS_TTL_SECONDS).toBe(30 * 24 * 3600);
    expect(COLLECTIONS).toContain("turns");
  });
});

describe("L5-001: parked writes are retried without a new persist", () => {
  const until = async (pred: () => boolean, ms = 500) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(2); };

  it("a doc parked during an outage is stored once the database answers again (timer), and failed returns to 0", async () => {
    const stored = new Map<string, unknown>();
    let down = true;
    const q = new WriteQueue(async (col, doc) => { if (down) throw new Error("no primary"); stored.set(`${col}/${doc._id}`, doc); return "ok"; },
      { baseDelayMs: 1, maxAttempts: 2, retryParkedMs: 15, log: () => undefined });
    q.enqueue("bookings", { _id: "b1", version: 3, status: "CAPTURED" });
    await until(() => q.health().failed === 1);
    expect(q.health().failed).toBe(1);
    expect(q.parked()).toEqual([{ col: "bookings", id: "b1", permanent: false }]);
    down = false; // Atlas is back; nothing touches b1 again
    await until(() => stored.has("bookings/b1"));
    expect(stored.get("bookings/b1")).toEqual({ _id: "b1", version: 3, status: "CAPTURED" });
    expect(q.health()).toMatchObject({ failed: 0 });
    q.stop();
  });

  it("any later successful write retries every parked doc at once; a permanent (joinCode) slot stays parked", async () => {
    const stored = new Set<string>();
    let down = true;
    let dupTries = 0;
    const q = new WriteQueue(async (col, doc) => {
      if (doc._id === "dup") { dupTries++; throw new PermanentWriteError("E11000 joinCode"); }
      if (down) throw new Error("socket closed");
      stored.add(`${col}/${doc._id}`);
      return "ok";
    }, { baseDelayMs: 1, maxAttempts: 2, retryParkedMs: 0, log: () => undefined });
    q.enqueue("trips", { _id: "t1" });
    q.enqueue("members", { _id: "m1" });
    q.enqueue("trips", { _id: "dup" });
    await until(() => q.health().failed === 3);
    expect(q.health().failed).toBe(3);
    down = false;
    q.enqueue("briefs", { _id: "fresh" }); // an unrelated write succeeds…
    await until(() => stored.size === 3);
    expect([...stored].sort()).toEqual(["briefs/fresh", "members/m1", "trips/t1"]); // …and the parked ones follow
    expect(q.health().failed).toBe(1);
    expect(q.parked()).toEqual([{ col: "trips", id: "dup", permanent: true }]);
    q.retryFailed();
    await sleep(10);
    expect(dupTries).toBe(1); // retrying the same snapshot can't help: never re-sent
  });
});

describe("L5-002: one writer", () => {
  it("a stale (version-guarded) write and a lost lease raise degraded", () => {
    const ok = { mode: "mongo", failed: 0, retrying: 0, staleSkipped: 0, lease: "held" as const, production: true };
    expect(isDegraded(ok)).toBe(false);
    expect(isDegraded({ ...ok, staleSkipped: 1 })).toBe(true);
    expect(isDegraded({ ...ok, lease: "lost" })).toBe(true);
    expect(isDegraded({ ...ok, lease: "waiting" })).toBe(true);
    expect(dbHealth().lease).toBe("off"); // no MongoDB: no lease
  });

  it("the lease: a second helm waits until the first releases it; a helm whose lease was taken is fenced", async () => {
    const store = memoryLeaseStore();
    const a = new HelmLease(store, { owner: "a", ttlMs: 1000, renewMs: 1000, pollMs: 2, log: () => undefined });
    expect(await a.acquire()).toBe(true);
    const b = new HelmLease(store, { owner: "b", ttlMs: 1000, renewMs: 1000, pollMs: 2, log: () => undefined });
    let bHeld = false;
    const bDone = b.acquire().then(() => { bHeld = true; });
    await sleep(20);
    expect(bHeld).toBe(false);
    expect(store.holder()).toBe("a");
    await a.release(); // SIGTERM on the old instance
    await bDone;
    expect(b.held).toBe(true);
    expect(store.holder()).toBe("b");
    b.stop();

    // an old helm that stalled past its TTL finds the lease taken on its next renewal: it stops writing
    const s2 = memoryLeaseStore();
    const lost = vi.fn();
    const old = new HelmLease(s2, { owner: "old", ttlMs: 5, renewMs: 10_000, pollMs: 1, log: () => undefined, onLost: lost });
    await old.acquire();
    await sleep(10);
    const neu = new HelmLease(s2, { owner: "new", ttlMs: 1000, renewMs: 10_000, pollMs: 1, log: () => undefined });
    await neu.acquire();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await old.renew();
    err.mockRestore();
    expect(old.state).toBe("lost");
    expect(lost).toHaveBeenCalledTimes(1);
    expect(s2.holder()).toBe("new");
    old.stop(); neu.stop();
  });
});

describe("L5-010: write errors are classified", () => {
  it("_id clash = stale, joinCode clash on trips = a new code, other unique clash = permanent, else retry", () => {
    expect(classifyWriteError("trips", { code: 11000, keyPattern: { _id: 1 } })).toBe("stale");
    expect(classifyWriteError("trips", { code: 11000, message: "E11000 duplicate key error index: _id_ dup key" })).toBe("stale");
    expect(classifyWriteError("trips", { code: 11000, keyPattern: { joinCode: 1 } })).toBe("joinCode");
    expect(classifyWriteError("trips", { code: 11000, message: "E11000 duplicate key error index: joinCode_1" })).toBe("joinCode");
    expect(classifyWriteError("turns", { code: 11000, keyPattern: { tripId: 1, round: 1, seq: 1 } })).toBe("permanent");
    expect(classifyWriteError("trips", { code: 6, message: "host unreachable" })).toBe("retry");
  });
});

describe("L5-009: a failed boot restore is retried in the background, never crashes the boot", () => {
  it("the first restore throws; a later merge succeeds", async () => {
    const calls: unknown[] = [];
    let fail = 2;
    const helm = { restore: async (o?: { merge?: boolean }) => { calls.push(o ?? {}); if (fail-- > 0) throw new Error("find failed"); } };
    expect(await restoreOrRetry(helm, { baseDelayMs: 1, maxDelayMs: 2, log: () => undefined })).toBe(false);
    for (let i = 0; i < 100 && calls.length < 3; i++) await sleep(2);
    expect(calls).toEqual([{}, { merge: true }, { merge: true }]);
  });
});
