/**
 * L5-002: one helm writes at a time. Restore voids every live booking and resets every live table, which is only
 * right when the previous process is gone; an overlapping instance (a zero-downtime deploy, a second replica) would
 * void the seals the other one is still gathering. So the helm holds a lease in MongoDB (`helm_lease`,
 * `{_id:"helm", owner, expiresAt}`, renewed every `renewMs`): a new instance waits for it (or for it to expire)
 * before it restores, and an instance that finds it lost stops writing (store/db.ts) and reports `degraded`.
 * Pure logic over a small store interface, so it is tested without a database.
 */
import { randomBytes } from "node:crypto";

export interface LeaseStore {
  /** Takes or renews the lease for `owner` when it is free, expired or already theirs. False = someone else holds it. */
  take(owner: string, ttlMs: number): Promise<boolean>;
  /** Gives it up (only if `owner` still holds it). */
  release(owner: string): Promise<void>;
}

export type LeaseState = "waiting" | "held" | "lost" | "released";

export class HelmLease {
  readonly owner: string;
  state: LeaseState = "waiting";
  private renewTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly pollMs: number;
  private readonly log: (m: string) => void;
  private readonly onLost?: () => void;

  constructor(private store: LeaseStore, opts: { owner?: string; ttlMs?: number; renewMs?: number; pollMs?: number; log?: (m: string) => void; onLost?: () => void } = {}) {
    this.owner = opts.owner ?? `${process.pid}-${randomBytes(6).toString("hex")}`;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.renewMs = opts.renewMs ?? 10_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.onLost = opts.onLost;
  }

  get held() { return this.state === "held"; }

  /**
   * Waits until this process holds the lease (the other helm released it on shutdown, or it expired). A store error
   * (MongoDB blip) is retried like a refusal. Resolves false only when stop() was called while waiting.
   */
  async acquire(): Promise<boolean> {
    let told = false;
    while (!this.stopped) {
      let ok = false;
      try { ok = await this.store.take(this.owner, this.ttlMs); } catch (e) { this.log(`[db] helm lease: ${(e as Error).message}; retrying`); }
      if (this.stopped) break;
      if (ok) {
        if (told) this.log("[db] helm lease acquired; restoring");
        this.state = "held";
        this.armRenew();
        return true;
      }
      if (!told) { this.log(`[db] another helm holds the lease; waiting (up to ${Math.round(this.ttlMs / 1000)} s after it stops) before restoring`); told = true; }
      await new Promise((r) => { const t = setTimeout(r, this.pollMs); t.unref?.(); });
    }
    return false;
  }

  private armRenew() {
    clearInterval(this.renewTimer);
    this.renewTimer = setInterval(() => void this.renew(), this.renewMs);
    this.renewTimer.unref?.();
  }

  /** One renewal. A refusal means another helm took over: this one is fenced (stops writing) for good. */
  async renew() {
    if (this.state !== "held") return;
    let ok: boolean;
    try { ok = await this.store.take(this.owner, this.ttlMs); } catch (e) {
      this.log(`[db] helm lease renewal failed (${(e as Error).message}); still writing, retrying`);
      return;
    }
    if (!ok && this.state === "held") {
      this.state = "lost";
      clearInterval(this.renewTimer);
      console.error("[db] WARNING: another helm took the lease: this instance stops writing to MongoDB (restart it to recover)");
      this.onLost?.();
    }
  }

  /** Shutdown: stop renewing and hand the lease over at once (the next helm needn't wait for it to expire). */
  async release() {
    this.stop();
    const was = this.state;
    this.state = "released";
    if (was === "held") await this.store.release(this.owner).catch(() => undefined);
  }

  stop() { this.stopped = true; clearInterval(this.renewTimer); }
}

/** In-memory lease store (tests; a single process). */
export function memoryLeaseStore(): LeaseStore & { holder(): string | null } {
  let lease: { owner: string; expiresAt: number } | null = null;
  return {
    async take(owner, ttlMs) {
      const now = Date.now();
      if (lease && lease.owner !== owner && lease.expiresAt > now) return false;
      lease = { owner, expiresAt: now + ttlMs };
      return true;
    },
    async release(owner) { if (lease?.owner === owner) lease = null; },
    holder: () => (lease && lease.expiresAt > Date.now() ? lease.owner : null),
  };
}
