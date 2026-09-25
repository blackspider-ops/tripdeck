/**
 * R2-WP-14 (O2-066): a regression guard on write volume and payload size. The database is the fake one, but writes go
 * through the real write queue (store/writeQueue.ts: per-document ordering and coalescing), so "writes" here are the
 * MongoDB replaceOne calls a voyage would make. Pinned: the trip document stays small (O2-036, the Two Charts' plans
 * live in their own doc), a tick of votes is one trip write, a booking's persists are bounded (O2-038), every live
 * `trip:state` is small and leaves out the static fields the replay carries (O2-040), and audit rows are batched
 * (O2-037).
 */
import { describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));

const counts = vi.hoisted(() => ({
  persists: {} as Record<string, number>, writes: {} as Record<string, number>, bytes: {} as Record<string, number>,
  maxTripDoc: 0, docs: new Map<string, Record<string, unknown>>(),
}));
vi.mock("../src/store/db.js", async () => {
  const { fakeDb } = await import("./support/fakeDb.js");
  const { WriteQueue } = await import("../src/store/writeQueue.js");
  const inc = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
  const queue = new WriteQueue(async (col, doc) => {
    const size = JSON.stringify(doc).length;
    inc(counts.writes, col); inc(counts.bytes, col, size);
    if (col === "trips") counts.maxTripDoc = Math.max(counts.maxTripDoc, size);
    counts.docs.set(`${col}/${doc._id}`, doc);
    return "ok";
  });
  return {
    ...fakeDb,
    persist: (col: string, doc: { _id: string } & Record<string, unknown>) => { inc(counts.persists, col); queue.enqueue(col, doc); },
    flushQueue: () => queue.flush(),
  };
});

import { TripService } from "../src/trips/service.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";
import { EventBuffer } from "../src/store/eventBuffer.js";
import * as db from "../src/store/db.js";

const flush = () => (db as unknown as { flushQueue(): Promise<void> }).flushQueue();
const until = async (ok: () => boolean) => { for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); expect(ok()).toBe(true); };
const reset = () => { counts.persists = {}; counts.writes = {}; counts.bytes = {}; };
const LIS = "LIS-W1-casa-alfama";

describe("O2-066: write volume and payload size", () => {
  it("a voyage from the table to BOOKED stays within its write and payload budgets", async () => {
    const helm = new TripService();
    const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
    sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
    const states: { bytes: number; p: Record<string, unknown> }[] = [];
    helm.attachBus({ trip: (_t, ev, p) => { if (ev === "trip:state") states.push({ bytes: JSON.stringify(p).length, p: p as Record<string, unknown> }); }, member: () => undefined });
    const seed = await seedExpo(helm);
    const t = helm.trip(seed.tripId);

    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    await until(() => t.status === "DRY_RUN");
    await flush();
    // O2-036: the trip doc carries the Two Charts' ids only; their plan bodies were written once, in their own doc
    const tripDoc = counts.docs.get(`trips/${t._id}`)!;
    expect(tripDoc.shortlistPlans).toBeUndefined();
    expect(JSON.stringify(tripDoc).length).toBeLessThanOrEqual(1500);
    expect(counts.maxTripDoc).toBeLessThanOrEqual(1500);
    expect(counts.writes.shortlists).toBe(1);
    expect((counts.docs.get(`shortlists/${t._id}`)!.plans as unknown[]).length).toBe(2);

    // a tick of votes (every member at once) is one trip write
    reset();
    const [a] = t.shortlistIds!;
    for (const id of [seed.organizer.memberId, seed.maya.memberId]) helm.vote(seed.tripId, id, a);
    await flush();
    expect(counts.writes.trips).toBe(1);

    // O2-038: a booking's persists stay bounded (3 seals here: two live, one standing)
    reset();
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, LIS);
    const n = helm.currentBooking(t)!.seals.length;
    await helm.setSeal(seed.tripId, seed.organizer.memberId, t.bookingId!);
    await helm.setSeal(seed.tripId, seed.maya.memberId, t.bookingId!);
    await until(() => t.status === "BOOKED");
    await helm.payments.whenSettled(t.bookingId!);
    await flush();
    // create, one per seal set (the last with the settle point and every authorization intent), all authorized, the
    // captures (doc 06 §4.2: `capturedAt` as each succeeds), captured, published at the settle point
    expect(counts.persists.bookings).toBeLessThanOrEqual(2 * n + 3);

    // O2-040: every live trip:state is small and leaves out the static fields; the replay carries them
    expect(states.length).toBeGreaterThan(3);
    for (const s of states) {
      expect(s.bytes).toBeLessThanOrEqual(1600);
      expect(s.p.candidateCities).toBeUndefined();
      expect(s.p.dateWindows).toBeUndefined();
    }
    const replayed: Record<string, unknown>[] = [];
    await helm.replayer.replay(t, (ev, p) => { if (ev === "trip:state") replayed.push(p as Record<string, unknown>); });
    expect((replayed[0].candidateCities as unknown[]).length).toBeGreaterThan(0);
    expect((replayed[0].dateWindows as unknown[]).length).toBeGreaterThan(0);
  });

  it("O2-037: audit rows appended within one tick go out as one insert; a full batch goes at once; flush drains", async () => {
    vi.useFakeTimers(); // O2-063: the 250 ms batch timer is advanced, not slept through
    const batches: number[][] = [];
    const buf = new EventBuffer<number>((rows) => batches.push(rows), { delayMs: 250, maxRows: 5 });
    for (let i = 0; i < 3; i++) buf.push(i);
    expect(batches).toHaveLength(0);
    buf.flush();
    expect(batches).toEqual([[0, 1, 2]]);
    for (let i = 0; i < 7; i++) buf.push(i);
    expect(batches).toHaveLength(2); // the 5th row filled a batch
    expect(buf.waiting).toBe(2);
    vi.advanceTimersByTime(249);
    expect(batches).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(3);
    expect(batches[2]).toEqual([5, 6]);
    buf.flush(); // nothing waiting: no empty insert
    expect(batches).toHaveLength(3);
    vi.useRealTimers();
  });
});
