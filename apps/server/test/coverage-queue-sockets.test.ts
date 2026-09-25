/**
 * O2-064 (R2-WP-17): the write queue's backoff and explicit retryFailed (the reconnect path, store/db.ts), the helm's
 * reconnect sync writing everything it made while MongoDB was away, and the socket guards in realtime/io.ts: the
 * per-socket 60-events-per-10 s budget, the per-address concurrency cap and the per-address connect rate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));
vi.mock("../src/store/db.js", async () => (await import("./support/fakeDb.js")).fakeDb);

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { fake } from "./support/fakeDb.js";
import { WriteQueue, PermanentWriteError } from "../src/store/writeQueue.js";
import { TripService } from "../src/trips/service.js";
import { attachRealtime } from "../src/realtime/io.js";
import { Concurrency, LIMITS, RateLimiter } from "../src/util/limits.js";
import type { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";
import { resetPasskeysForTests } from "../src/passkeys/passkeys.js";
import type { TripRec } from "../src/trips/records.js";

const settle = (ms = 2) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, tries = 400) => { for (let i = 0; i < tries && !pred(); i++) await settle(); };

afterEach(() => { vi.useRealTimers(); });

describe("O2-064: WriteQueue backoff and retryFailed", () => {
  it("retries back off 1×, 2×, 4× … up to maxDelayMs, then park; nothing retries a parked write until retryFailed()", async () => {
    vi.useFakeTimers();
    const tries: number[] = [];
    let down = true;
    const stored: unknown[] = [];
    const q = new WriteQueue(async (_c, doc) => { tries.push(Date.now()); if (down) throw new Error("no primary"); stored.push(doc); return "ok"; },
      { baseDelayMs: 100, maxDelayMs: 300, maxAttempts: 5, retryParkedMs: 0, log: () => undefined });
    const t0 = Date.now();
    q.enqueue("trips", { _id: "t1", v: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tries.map((t) => t - t0)).toEqual([0, 100, 300, 600, 900]); // delays 100, 200, 300 (capped), 300
    expect(q.health()).toMatchObject({ failed: 1, retrying: 0, totalFailures: 5 });
    expect(q.parked()).toEqual([{ col: "trips", id: "t1", permanent: false }]);

    down = false; // the database is back, but nothing tells this queue (retryParkedMs 0, no later write)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stored).toEqual([]);
    q.retryFailed(); // db.ts calls this once a reconnect succeeds
    await vi.advanceTimersByTimeAsync(0);
    expect(stored).toEqual([{ _id: "t1", v: 1 }]);
    expect(q.health()).toMatchObject({ failed: 0, pending: 0, inFlight: 0 });
    expect(q.parked()).toEqual([]);
  });

  it("retryFailed sends the newest parked snapshot once, skips permanent slots and never touches a write still in its backoff", async () => {
    vi.useFakeTimers();
    const sent: { id: string; v: unknown }[] = [];
    let down = true;
    const q = new WriteQueue(async (_c, doc) => {
      if (doc._id === "dup") throw new PermanentWriteError("E11000 joinCode");
      if (down || doc._id === "slow") throw new Error("down");
      sent.push({ id: doc._id, v: doc.v });
      return "ok";
    }, { baseDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 2, retryParkedMs: 0, log: () => undefined });
    q.enqueue("members", { _id: "m1", v: 1 });
    q.enqueue("trips", { _id: "dup", v: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(q.parked().map((p) => `${p.id}:${p.permanent}`).sort()).toEqual(["dup:true", "m1:false"]);
    q.enqueue("trips", { _id: "slow", v: 1 }); // fails once and waits 1 s for its retry
    await vi.advanceTimersByTimeAsync(0);
    expect(q.health().retrying).toBe(1);

    down = false;
    q.retryFailed();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ id: "m1", v: 1 }]); // not "slow" early, not "dup" at all
    expect(q.parked()).toEqual([{ col: "trips", id: "dup", permanent: true }]);
    expect(q.health().retrying).toBe(1);
    q.stop();
  });

  it("the parked-retry timer stops once nothing retriable is left", async () => {
    vi.useFakeTimers();
    let down = true, calls = 0;
    const q = new WriteQueue(async () => { calls++; if (down) throw new Error("down"); return "ok"; },
      { baseDelayMs: 1, maxAttempts: 1, retryParkedMs: 1_000, log: () => undefined });
    q.enqueue("briefs", { _id: "b1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(q.health().failed).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000); // three timer retries, still down
    expect(calls).toBe(4);
    down = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(q.health().failed).toBe(0);
    const after = calls;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(after);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("O2-064: the reconnect sync writes what the helm made while MongoDB was away", () => {
  beforeEach(() => { fake.reset(); resetPasskeysForTests(); });

  it("a voyage booked offline — trip, crew, briefs, charts, turns and booking — is all in the store after the hook", async () => {
    const h = new TripService();
    const sim = (h.payments as unknown as { provider: SimProvider }).provider;
    sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
    await h.restore(); // boot with MongoDB unreachable: nothing loaded, the reconnect hook registered
    const s = await seedExpo(h);
    await h.startTable(s.tripId, { memberId: s.organizer.memberId });
    await until(() => h.trip(s.tripId).status === "DRY_RUN");
    await h.pick(s.tripId, { memberId: s.organizer.memberId }, "LIS-W1-casa-alfama");
    const t = h.trip(s.tripId);
    await h.setSeal(s.tripId, s.organizer.memberId, t.bookingId!);
    await h.setSeal(s.tripId, s.maya.memberId, t.bookingId!);
    await until(() => t.status === "BOOKED");
    await h.payments.whenSettled(t.bookingId!);

    const hook = fake.state.hook!;
    expect(hook).toBeTypeOf("function");
    fake.reset(); // every write made while the database was away was lost
    fake.state.connected = true;
    await hook();

    expect(fake.get<TripRec>("trips", s.tripId)!.status).toBe("BOOKED");
    for (const m of [s.organizer, s.maya, s.dev]) {
      expect(fake.get("members", m.memberId), m.memberId).toBeDefined();
      expect(fake.get("briefs", m.memberId), m.memberId).toBeDefined();
    }
    expect(fake.get<{ plans: unknown[] }>("shortlists", s.tripId)!.plans).toHaveLength(2);
    expect(fake.docs<{ tripId: string }>("turns").filter((d) => d.tripId === s.tripId)).toHaveLength(t.negotiation.turns.length);
    expect(fake.get<{ status: string; reference?: string }>("bookings", t.bookingId!)).toMatchObject({ status: "CAPTURED", reference: h.payments.bookings.get(t.bookingId!)!.reference });
    // TR5-015: the stored booking carries no caps
    expect(JSON.stringify(fake.get("bookings", t.bookingId!))).not.toContain("capCents");
  });
});

// ---------- sockets ----------
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const S = LIMITS.socket as Mutable<typeof LIMITS.socket>;
const saved = { ...LIMITS.socket };
const servers: Server[] = [];
const clients: Socket[] = [];
afterEach(async () => {
  Object.assign(S, saved);
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
});

async function server(limits: Partial<Record<keyof typeof saved, number>> = {}) {
  Object.assign(S, limits); // read when attachRealtime builds its limiters (and per connection for the event budget)
  const helm = new TripService();
  const http = createServer();
  attachRealtime(http, helm);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  servers.push(http);
  return { helm, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
}
/** A socket that either connects or is refused by the middleware (its connect_error message). */
function open(url: string): Promise<{ s: Socket; ok: boolean; error?: string }> {
  const s = connect(url, { transports: ["websocket"], reconnection: false, forceNew: true });
  clients.push(s);
  return new Promise((r) => {
    s.once("connect", () => r({ s, ok: true }));
    s.once("connect_error", (e) => r({ s, ok: false, error: e.message }));
  });
}
type Ack = { ok: boolean; code?: string };
const emit = (s: Socket, ev: string, p: unknown) => new Promise<Ack>((r) => s.emit(ev, p, r));

describe("O2-064: socket budgets and caps (realtime/io.ts)", () => {
  it("each socket gets LIMITS.socket.events actions per window; the next is SLOW_DOWN; another socket has its own budget", async () => {
    const { url } = await server();
    const max = new RateLimiter(LIMITS.socket.events, LIMITS.socket.eventsWindowMs).max; // RATE_LIMIT_SCALE applied
    expect(LIMITS.socket.events).toBe(60);
    expect(LIMITS.socket.eventsWindowMs).toBe(10_000);
    const a = await open(url);
    expect(a.ok).toBe(true);
    // a cheap refused action still spends budget (BAD_INPUT is decided after the budget check)
    const acks = await Promise.all(Array.from({ length: max }, () => emit(a.s, "crew:setOpen", { open: "yes" })));
    expect(new Set(acks.map((x) => x.code))).toEqual(new Set(["BAD_INPUT"]));
    expect((await emit(a.s, "crew:setOpen", { open: "yes" })).code).toBe("SLOW_DOWN");
    expect((await emit(a.s, "trip:join", { joinCode: "NOPE" })).code).toBe("SLOW_DOWN"); // the join shares the budget
    const b = await open(url);
    expect((await emit(b.s, "crew:setOpen", { open: "yes" })).code).toBe("BAD_INPUT");
  });

  it("at most socketsPerAddress sockets at once per address; closing one makes room", async () => {
    const { url } = await server({ socketsPerAddress: 3, connectPerMinute: 1_000 });
    const cap = new Concurrency(3).max;
    const open1 = await Promise.all(Array.from({ length: cap }, () => open(url)));
    expect(open1.every((x) => x.ok)).toBe(true);
    const over = await open(url);
    expect(over).toMatchObject({ ok: false, error: "SLOW_DOWN" });
    open1[0].s.close();
    let again = await open(url);
    for (let i = 0; i < 50 && !again.ok; i++) { await settle(5); again = await open(url); } // the server sees the close
    expect(again.ok).toBe(true);
  });

  it("at most connectPerMinute connects per address, even when each socket closed again", async () => {
    const { url } = await server({ connectPerMinute: 4, socketsPerAddress: 64 });
    const max = new RateLimiter(4, 60_000).max;
    for (let i = 0; i < max; i++) {
      const c = await open(url);
      expect(c.ok, `connect ${i}`).toBe(true);
      c.s.close();
    }
    expect(await open(url)).toMatchObject({ ok: false, error: "SLOW_DOWN" });
  });
});
