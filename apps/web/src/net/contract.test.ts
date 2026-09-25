// WP-09: the client side of the socket contract (OPT-067), the table:failed routing (TR3-007) and the bounded
// offline outbox (TR3-009). No socket is opened: the store is built with autoConnect:false.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_TO_CLIENT_EVENTS, type Ack } from "@all-ayes/shared";
import { OUTBOX_MAX, OUTBOX_TTL_MS, TripStore } from "./tripStore";
import type { Surface } from "@all-ayes/shared";

type Emitted = { ev: string; p: unknown; ack?: (r: Ack) => void };
const stores: TripStore[] = [];
function mk(surface: Surface = "phone") {
  const s = new TripStore({ tripId: "t1", surface, autoConnect: false });
  stores.push(s);
  const sock = s.socket as unknown as {
    listeners(e: string): ((...a: unknown[]) => void)[];
    emit: (ev: string, p: unknown, ack?: (r: Ack) => void) => unknown;
  };
  const sent: Emitted[] = [];
  sock.emit = (ev, p, ack) => { sent.push({ ev, p, ack }); return true; };
  const fire = (ev: string, p?: unknown) => { for (const f of sock.listeners(ev)) f(p); };
  /** Simulate a (re)connect: the store sends trip:join; `joinAck` answers it. */
  const connect = (joinAck: Ack = { ok: true }) => {
    (s.socket as unknown as { connected: boolean }).connected = true;
    fire("connect");
    const join = sent.find((e) => e.ev === "trip:join");
    expect(join?.ack).toBeTypeOf("function");
    join!.ack!(joinAck);
  };
  return { s, sock, sent, fire, connect };
}
// (a simulated connection never opened a transport: mark it closed so close() has nothing to send)
afterEach(() => { vi.useRealTimers(); for (const s of stores.splice(0)) { (s.socket as unknown as { connected: boolean }).connected = false; s.close(); } });

describe("OPT-067: every server → client event has a handler", () => {
  it("TripStore listens to each ServerToClient event", () => {
    const { s, sock } = mk();
    const missing = SERVER_TO_CLIENT_EVENTS.filter((ev) => !s.handled.has(ev) || sock.listeners(ev).length === 0);
    expect(missing).toEqual([]);
  });
});

describe("TR3-007: errors and table failures", () => {
  it("a refusal keeps the event that caused it", () => {
    const { s, fire } = mk();
    fire("error", { code: "BAD_PHASE", message: "nope", event: "plan:pick" });
    expect(s.state.error).toEqual({ code: "BAD_PHASE", message: "nope", event: "plan:pick" });
    s.clearError(); // kept until cleared
    expect(s.state.error).toBeNull();
  });

  it("table:failed shows on phones and the headset, never on the Gallery", () => {
    for (const surface of ["phone", "xr"] as const) {
      const { s, fire } = mk(surface);
      fire("table:failed", { code: "TABLE_FAILED", message: "The table lost its bearings." });
      expect(s.state.error?.code).toBe("TABLE_FAILED");
    }
    const g = mk("gallery");
    g.fire("table:failed", { code: "TABLE_FAILED", message: "The table lost its bearings." });
    expect(g.s.state.error).toBeNull();
  });
});

describe("TR3-009: the offline outbox", () => {
  it("never queues client:log, keeps one action per event, and sends after the join is acknowledged", () => {
    const { s, sent, connect } = mk();
    s.emit("client:log", { level: "log", msg: "x" });
    const acks: Ack[] = [];
    s.emit("plan:vote", { planId: "A" }, (r) => acks.push(r));
    s.emit("plan:vote", { planId: "B" });
    s.emit("table:hail", { text: "hi" });
    expect(s.pending.map((q) => q.ev)).toEqual(["plan:vote", "table:hail"]);
    expect(acks).toEqual([expect.objectContaining({ ok: false, code: "EXPIRED" })]); // the replaced tap is answered
    expect(sent).toEqual([]);
    connect();
    expect(sent.map((e) => [e.ev, e.p])).toEqual([["trip:join", expect.anything()], ["plan:vote", { planId: "B" }], ["table:hail", { text: "hi" }]]);
    expect(s.pending).toEqual([]);
  });

  it("caps the queue however many kinds of action are tapped offline", () => {
    const { s } = mk();
    const events = ["table:start", "table:hail", "plan:pick", "plan:vote", "seal:set", "seal:cancel", "booking:retry", "booking:callOff", "crew:setOpen", "dryrun:control", "brief:submit", "table:sailWithout"] as const;
    for (const ev of events) s.emit(ev, {} as never);
    expect(s.pending.length).toBeLessThanOrEqual(OUTBOX_MAX);
  });

  it("drops actions older than the TTL on reconnect and answers their ack", () => {
    vi.useFakeTimers();
    const { s, sent, connect } = mk();
    const acks: Ack[] = [];
    s.emit("plan:pick", { planId: "A" }, (r) => acks.push(r));
    vi.advanceTimersByTime(OUTBOX_TTL_MS + 1);
    s.emit("plan:vote", { planId: "B" });
    connect();
    expect(sent.map((e) => e.ev)).toEqual(["trip:join", "plan:vote"]);
    expect(acks).toEqual([expect.objectContaining({ ok: false, code: "EXPIRED" })]);
  });

  it("a failed join fails the queued actions instead of sending them", () => {
    const { s, sent, connect } = mk();
    const acks: Ack[] = [];
    s.emit("seal:set", { bookingId: "b1" }, (r) => acks.push(r));
    connect({ ok: false, code: "NO_TRIP", message: "gone" });
    expect(sent.map((e) => e.ev)).toEqual(["trip:join"]);
    expect(acks).toEqual([{ ok: false, code: "NO_TRIP", message: "gone" }]);
  });
});
