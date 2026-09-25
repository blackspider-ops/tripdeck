/**
 * Ordered, coalescing write-through (TR5-005, OPT-041). One write in flight per (collection, _id): persists that
 * arrive meanwhile only mark the document dirty, and the latest snapshot is written once the current write finishes,
 * so an older state can never land after a newer one. Snapshots are taken with structuredClone when the write is
 * dispatched (never the live object on the wire). Failures are retried with backoff and counted for /api/health;
 * a write that can never succeed (a unique-key clash) is parked and reported instead of retried forever.
 *
 * L5-001: a write parked after `maxAttempts` (e.g. during a mid-run MongoDB outage) is not left behind: any later
 * successful write, and a low-frequency timer while anything is parked, give every parked write another go. A write
 * parked by a PermanentWriteError stays parked (only a fresh persist of that document retries it).
 */

export type WriteOutcome = "ok" | "stale";
export type Writer = (col: string, doc: { _id: string } & Record<string, unknown>) => Promise<WriteOutcome>;

export interface WriteQueueOptions {
  /** First retry delay; doubles each attempt up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Attempts before a write is parked as failed (it is retried again by retryFailed(), e.g. on reconnect). */
  maxAttempts?: number;
  /** L5-001: while writes are parked, they are retried this often (0 = never by timer). */
  retryParkedMs?: number;
  log?: (msg: string) => void;
}

export interface WriteStats {
  pending: number; inFlight: number; retrying: number; failed: number;
  totalWrites: number; totalFailures: number; staleSkipped: number; lastError?: string; lastErrorAt?: string;
}

interface Slot {
  col: string; id: string;
  doc: ({ _id: string } & Record<string, unknown>) | null; // latest doc not yet dispatched
  inFlight: boolean;
  attempts: number;
  timer?: NodeJS.Timeout;
  failed?: boolean;
  /** Parked by a PermanentWriteError: retrying the same snapshot can't help (L5-001). */
  permanent?: boolean;
  waiters: (() => void)[];
}

/** An error that retrying won't fix (e.g. E11000 on a unique index other than _id). */
export class PermanentWriteError extends Error {}

/**
 * O2-032: retry pacing (250 ms doubling to 30 s, 8 tries, then parked and retried every 45 s) and the flush bound.
 * Kept here, not in util/limits.ts LIMITS: that module imports store/db.ts, which builds a queue at load time.
 */
const DEFAULTS = { baseDelayMs: 250, maxDelayMs: 30_000, maxAttempts: 8, retryParkedMs: 45_000 } as const;
const FLUSH_ROUNDS = 50;

export class WriteQueue {
  private slots = new Map<string, Slot>();
  private stats = { totalWrites: 0, totalFailures: 0, staleSkipped: 0, lastError: undefined as string | undefined, lastErrorAt: undefined as string | undefined };
  private opts: Required<Omit<WriteQueueOptions, "log">> & { log: (m: string) => void };
  private parkedTimer?: NodeJS.Timeout;

  constructor(private readonly writer: Writer, opts: WriteQueueOptions = {}) {
    this.opts = {
      baseDelayMs: opts.baseDelayMs ?? DEFAULTS.baseDelayMs, maxDelayMs: opts.maxDelayMs ?? DEFAULTS.maxDelayMs,
      maxAttempts: opts.maxAttempts ?? DEFAULTS.maxAttempts, retryParkedMs: opts.retryParkedMs ?? DEFAULTS.retryParkedMs,
      log: opts.log ?? ((m) => console.warn(m)),
    };
  }

  /** Marks the document dirty; the latest version is written (in order) as soon as the previous write is done. */
  enqueue(col: string, doc: { _id: string } & Record<string, unknown>) {
    const key = `${col}\u0000${doc._id}`;
    let s = this.slots.get(key);
    if (!s) { s = { col, id: doc._id, doc: null, inFlight: false, attempts: 0, waiters: [] }; this.slots.set(key, s); }
    s.doc = doc;
    if (s.failed) { s.failed = false; s.permanent = false; s.attempts = 0; } // a fresh persist gives a parked write another go
    if (!s.inFlight && !s.timer) queueMicrotask(() => this.pump(key));
  }

  private pump(key: string) {
    const s = this.slots.get(key);
    if (!s || s.inFlight || s.timer || s.failed || !s.doc) return;
    let snapshot: { _id: string } & Record<string, unknown>;
    try {
      snapshot = structuredClone(s.doc);
    } catch {
      snapshot = JSON.parse(JSON.stringify(s.doc));
    }
    const dispatched = s.doc;
    s.doc = null;
    s.inFlight = true;
    this.writer(s.col, snapshot).then((outcome) => {
      s.inFlight = false;
      s.attempts = 0;
      this.stats.totalWrites++;
      if (outcome === "stale") this.stats.staleSkipped++;
      this.after(key, s);
      // L5-001: the database answers again, so the writes parked meanwhile get another go
      if (this.hasRetriableParked()) this.retryFailed();
    }, (e: Error) => {
      s.inFlight = false;
      this.stats.totalFailures++;
      this.stats.lastError = `${s.col}/${s.id}: ${e?.message ?? e}`;
      this.stats.lastErrorAt = new Date().toISOString();
      s.doc ??= dispatched; // retry with the newest state we have
      s.attempts++;
      if (e instanceof PermanentWriteError || s.attempts >= this.opts.maxAttempts) {
        s.failed = true;
        s.permanent = e instanceof PermanentWriteError;
        this.opts.log(`[db] write ${s.col}/${s.id} ${s.permanent ? "can't succeed" : "parked"} after ${s.attempts} attempt(s): ${e?.message ?? e}`);
        this.release(s);
        if (!s.permanent) this.armParkedRetry();
        return;
      }
      const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (s.attempts - 1));
      this.opts.log(`[db] write ${s.col}/${s.id} failed (attempt ${s.attempts}), retrying in ${delay} ms: ${e?.message ?? e}`);
      s.timer = setTimeout(() => { s.timer = undefined; this.pump(key); }, delay);
      s.timer.unref?.();
    });
  }

  private after(key: string, s: Slot) {
    if (s.doc) return this.pump(key);
    this.release(s);
    if (!s.failed && !s.timer) this.slots.delete(key);
  }

  private release(s: Slot) {
    const w = s.waiters.splice(0);
    for (const f of w) f();
  }

  /**
   * Parked (failed) writes get another go — after a reconnect, a later successful write, or the parked-retry timer
   * (L5-001). A permanently failed one (PermanentWriteError) stays parked: the same snapshot would fail again.
   */
  retryFailed() {
    for (const [key, s] of this.slots) {
      if (!s.failed || s.permanent) continue;
      s.failed = false; s.attempts = 0;
      this.pump(key);
    }
  }

  /** Every parked write, `(collection, _id)`, and whether it is permanent (logged on shutdown, L5-001). */
  parked(): { col: string; id: string; permanent: boolean }[] {
    return [...this.slots.values()].filter((s) => s.failed).map((s) => ({ col: s.col, id: s.id, permanent: Boolean(s.permanent) }));
  }

  /** Stops the parked-retry timer (shutdown, tests). */
  stop() { if (this.parkedTimer) { clearInterval(this.parkedTimer); this.parkedTimer = undefined; } }

  private hasRetriableParked() {
    for (const s of this.slots.values()) if (s.failed && !s.permanent) return true;
    return false;
  }

  /** L5-001: while anything retriable is parked, retry it every `retryParkedMs`; the timer stops once none is left. */
  private armParkedRetry() {
    if (this.parkedTimer || !this.opts.retryParkedMs) return;
    this.parkedTimer = setInterval(() => {
      if (!this.hasRetriableParked()) return this.stop();
      this.retryFailed();
    }, this.opts.retryParkedMs);
    this.parkedTimer.unref?.();
  }

  /** Resolves when every dirty document has been written (or parked as failed). Retry timers are fired early. */
  async flush(): Promise<void> {
    for (let round = 0; round < FLUSH_ROUNDS; round++) {
      const busy = [...this.slots.entries()].filter(([, s]) => !s.failed && (s.inFlight || s.doc || s.timer));
      if (!busy.length) return;
      await Promise.all(busy.map(([key, s]) => new Promise<void>((r) => {
        s.waiters.push(r);
        if (s.timer) { clearTimeout(s.timer); s.timer = undefined; }
        if (!s.inFlight) this.pump(key);
        if (!s.inFlight && !s.doc) this.release(s);
      })));
    }
  }

  health(): WriteStats {
    let pending = 0, inFlight = 0, retrying = 0, failed = 0;
    for (const s of this.slots.values()) {
      if (s.failed) failed++;
      else if (s.timer) retrying++;
      else if (s.inFlight) inFlight++;
      if (s.doc && !s.failed) pending++;
    }
    return { pending, inFlight, retrying, failed, ...this.stats };
  }
}
