// WP-03: the store mirrors live state the same way live and on replay. No socket is opened; server events
// are fed straight into the registered handlers. Run with: npx vitest run --root apps/web src/net
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanPublic, TripState } from "@all-ayes/shared";
import { JOIN_RETRY_MS, TripStore } from "./tripStore";

const stores: TripStore[] = [];
function mk(surface: "gallery" | "phone" = "gallery") {
  const s = new TripStore({ tripId: "t1", surface, autoConnect: false });
  stores.push(s);
  const fire = (ev: string, p: unknown) => {
    const fns = (s.socket as unknown as { listeners(e: string): ((p: unknown) => void)[] }).listeners(ev);
    expect(fns.length).toBeGreaterThan(0);
    for (const f of fns) f(p);
  };
  return { s, fire };
}
// (a simulated connection never opened a transport: mark it closed so close() has nothing to send)
afterEach(() => { for (const s of stores.splice(0)) { (s.socket as unknown as { connected: boolean }).connected = false; s.close(); } });

const state = (over: Partial<TripState> = {}): TripState => ({
  tripId: "t1", joinCode: "ABCDE", name: "x", status: "AT_TABLE", version: 1, organizerId: "o", crew: [], candidateCities: [],
  dateWindows: [], negotiation: { watch: 0, running: true }, votes: {}, autoPick: null, paymentsMode: "sim", serverNow: Date.now(), ...over,
});
const plan = (planId: string) => ({ planId, cityId: "LIS" }) as unknown as PlanPublic;

describe("tripStore", () => {
  it("TR2-002: table:watch moves trip.negotiation.watch", () => {
    const { s, fire } = mk();
    fire("trip:state", state());
    fire("table:watch", { watch: 1 });
    expect(s.state.trip!.negotiation.watch).toBe(1);
    fire("table:watch", { watch: 2 });
    expect(s.state.trip!.negotiation.watch).toBe(2);
  });

  it("R2-WP-14 (O2-040): a broadcast without the static fields keeps the ports and dates of the replay", () => {
    const { s, fire } = mk();
    const ports = [{ cityId: "LIS" as const, name: "Lisbon", lat: 38.7, lng: -9.1 }];
    const windows = [{ id: "W1", label: "Jun", start: "2026-06-01", end: "2026-06-05" }] as unknown as TripState["dateWindows"];
    fire("trip:state", state({ candidateCities: ports, dateWindows: windows })); // the (re)join replay
    const { candidateCities: _c, dateWindows: _d, ...live } = state({ version: 2 });
    fire("trip:state", live); // a live broadcast
    expect(s.state.trip!.version).toBe(2);
    expect(s.state.trip!.candidateCities).toBe(ports); // the same array: the globe's pins don't reset
    expect(s.state.trip!.dateWindows).toBe(windows);
    // another voyage's broadcast never inherits them
    fire("trip:state", { ...live, tripId: "t2" });
    expect(s.state.trip!.candidateCities).toEqual([]);
  });

  it("OPT-042: the shortlist comes from table:decided and survives the ids-only snapshot", () => {
    const { s, fire } = mk();
    fire("table:decided", { shortlist: [plan("A1"), plan("B1")] }); // replay: bodies before the snapshot
    fire("trip:state", state({ status: "DRY_RUN", shortlistIds: ["A1", "B1"] }));
    expect(s.state.shortlist.map((p) => p.planId)).toEqual(["A1", "B1"]);
    fire("trip:state", state({ status: "DRY_RUN", shortlistIds: ["A1", "B1"], version: 2 }));
    expect(s.state.shortlist).toHaveLength(2);
    fire("trip:state", state({ status: "BRIEFING" }));
    expect(s.state.shortlist).toEqual([]);
  });

  it("TR2-006: dryrun:control applies the server clock; TR1-008: autoPick is mapped onto the device clock", () => {
    const { s, fire } = mk();
    const skew = 10_000; // the server runs 10 s behind this device
    const serverNow = Date.now() - skew;
    fire("dryrun:script", { planIds: [], dayStartMin: 480, dayEndMin: 1320, minPerSec: 15, startedAt: serverNow - 4000, pausedAt: null, serverNow });
    fire("dryrun:control", { action: "pause", at: serverNow, startedAt: serverNow - 4000, pausedAt: serverNow, serverNow });
    const m = s.dryrunMinute()!;
    expect(Math.abs(m - (480 + 4 * 15))).toBeLessThan(1);
    // a stale duplicate (should the server ever send one) can't move a paused clock off the server's minute
    fire("dryrun:control", { action: "pause", at: serverNow, startedAt: serverNow - 4000, pausedAt: serverNow, serverNow });
    expect(Math.abs(s.dryrunMinute()! - m)).toBeLessThan(1);

    fire("plan:votes", { tallies: { A1: 2 }, autoPick: { planId: "A1", at: serverNow + 20_000 }, serverNow });
    expect(Math.abs(s.state.autoPick!.at - (Date.now() + 20_000))).toBeLessThan(200);
  });

  it("TR1-009: my vote is set privately and cleared when the phase changes", () => {
    const { s, fire } = mk();
    fire("trip:state", state({ status: "DRY_RUN" }));
    fire("plan:myVote", { planId: "A1" });
    expect(s.state.myVote).toBe("A1");
    fire("trip:state", state({ status: "DRY_RUN", version: 3 }));
    expect(s.state.myVote).toBe("A1");
    fire("trip:state", state({ status: "SEALING" }));
    expect(s.state.myVote).toBeNull();
  });

  it("TR3-003: a replayed booking:created keeps that booking's result", () => {
    const { s, fire } = mk();
    const b = { bookingId: "b1", planId: "A1", attempt: 1, status: "VOIDED", mode: "sim", seals: [] };
    fire("booking:created", b);
    fire("booking:result", { bookingId: "b1", status: "VOIDED", publicReason: "One share didn't clear." });
    fire("booking:created", b);
    expect(s.state.lastResult?.publicReason).toBe("One share didn't clear.");
    fire("booking:created", { ...b, bookingId: "b2", attempt: 2 });
    expect(s.state.lastResult).toBeNull();
  });

  it("OPT-066: a new round (AT_TABLE → BRIEFING) starts from a clean log; a same-status snapshot keeps it", () => {
    const { s, fire } = mk();
    fire("trip:state", state({ status: "AT_TABLE" }));
    fire("turn:new", turn("t1", 1));
    fire("turn:audioReady", { turnId: "t1", audioUrl: "/a.mp3" });
    fire("trip:state", state({ status: "AT_TABLE", version: 2 }));
    expect(s.state.turns).toHaveLength(1);
    fire("trip:state", state({ status: "BRIEFING", version: 3 }));
    expect(s.state.turns).toEqual([]);
    expect(s.state.audio).toEqual({});
    expect(s.state.dryrun).toBeNull();
  });

  it("OPT-066: a duplicate turn:new is ignored and out-of-order turns are sorted by seq", () => {
    const { s, fire } = mk();
    fire("turn:new", turn("b", 2));
    fire("turn:new", turn("a", 1));
    fire("turn:new", turn("b", 2));
    fire("turn:new", turn("c", 3));
    expect(s.state.turns.map((t) => t.turnId)).toEqual(["a", "b", "c"]);
  });

  it("OPT-066: dryrun:script with server skew yields the same minute; pause then resume keeps it", () => {
    const first = mk(), b = mk();
    const now = Date.now();
    const script = { planIds: [], dayStartMin: 480, dayEndMin: 1380, minPerSec: 15, startedAt: now - 8000, pausedAt: null };
    expect(first.s.dryrunMinute()).toBeNull();
    first.fire("dryrun:script", { ...script, serverNow: now });
    b.fire("dryrun:script", { ...script, startedAt: now - 60_000 - 8000, serverNow: now - 60_000 }); // server clock a minute behind
    expect(Math.abs(first.s.dryrunMinute(now)! - b.s.dryrunMinute(now)!)).toBeLessThan(0.5);
    // pause at the server's now: the minute holds; resume shifts startedAt by the paused time
    b.fire("dryrun:control", { action: "pause", at: now - 60_000, startedAt: now - 60_000 - 8000, pausedAt: now - 60_000, serverNow: now - 60_000 });
    const held = b.s.dryrunMinute(now + 30_000)!;
    expect(Math.abs(held - (480 + 8 * 15))).toBeLessThan(0.5);
    b.fire("dryrun:control", { action: "resume", at: now - 50_000, startedAt: now - 50_000 - 8000, pausedAt: null, serverNow: now - 60_000 });
    expect(Math.abs(b.s.dryrunMinute(now + 10_000)! - held)).toBeLessThan(0.5);
    // the clock never runs past the end of the day
    expect(b.s.dryrunMinute(now + 3_600_000)).toBe(1380);
  });

  it("booking:created serverNow maps the seal deadline onto this device's clock (skew-free countdown)", () => {
    const { s, fire } = mk();
    const serverNow = Date.now() - 60_000; // the server's clock reads a minute behind this phone
    const deadline = serverNow + 600_000;
    fire("booking:created", { bookingId: "b1", planId: "A1", attempt: 1, status: "PENDING", mode: "sim", seals: [], sealDeadlineAt: new Date(deadline).toISOString(), serverNow });
    expect(Math.abs(Date.parse(s.state.booking!.sealDeadlineAt!) - (Date.now() + 600_000))).toBeLessThan(200);
    expect(s.state.booking).not.toHaveProperty("serverNow");
  });

  it("OPT-066: seal:status patches only that booking's seal", () => {
    const { s, fire } = mk();
    const seals = [{ memberId: "m1", status: "PENDING" }, { memberId: "m2", status: "PENDING" }];
    fire("booking:created", { bookingId: "b1", planId: "A1", attempt: 1, status: "PENDING", mode: "sim", seals });
    fire("seal:status", { bookingId: "b1", memberId: "m2", status: "AUTHORIZED" });
    fire("seal:status", { bookingId: "old", memberId: "m1", status: "AUTHORIZED" });
    expect(s.state.booking!.seals.map((x) => x.status)).toEqual(["PENDING", "AUTHORIZED"]);
  });
  // O2-069: table:failed routing and the offline outbox are tested once, in contract.test.ts
});

/** A connected socket that never touches the network: `emit` is recorded, the join ack is answered by the test. */
function connected(surface: "gallery" | "phone" = "phone") {
  const { s, fire } = mk(surface);
  const sent: { ev: string; p: unknown; ack?: (r: unknown) => void }[] = [];
  vi.spyOn(s.socket, "emit").mockImplementation(((ev: string, p: unknown, ack?: (r: unknown) => void) => { sent.push({ ev, p, ack }); return s.socket; }) as never);
  const sock = s.socket as unknown as { connected: boolean };
  const connect = () => { sock.connected = true; fire("connect", undefined); };
  const drop = () => { sock.connected = false; fire("disconnect", "transport close"); };
  const joins = () => sent.filter((x) => x.ev === "trip:join");
  const actions = () => sent.filter((x) => x.ev !== "trip:join").map((x) => x.ev);
  return { s, fire, sent, connect, drop, joins, actions };
}

describe("R2-WP-08: join handshake, retries and reconnects", () => {
  it("L3-003: an action tapped between connect and the join ack waits for the ack; the role is kept", () => {
    const c = connected();
    c.connect();
    expect(c.joins()).toHaveLength(1);
    const acks: string[] = [];
    c.s.emit("crew:setOpen", { open: false }, (r) => acks.push(r.ok ? "ok" : r.code));
    expect(c.actions()).toEqual([]);
    expect(c.s.state.joined).toBe(false);
    c.joins()[0].ack!({ ok: true, as: "member" });
    expect(c.actions()).toEqual(["crew:setOpen"]);
    expect(c.s.state).toMatchObject({ joined: true, role: "member" });
    c.s.emit("plan:vote", { planId: "A1" });
    expect(c.actions()).toEqual(["crew:setOpen", "plan:vote"]); // once joined, straight out
    c.drop();
    expect(c.s.state.joined).toBe(false);
    c.s.emit("plan:pick", { planId: "A1" });
    expect(c.actions()).toHaveLength(2); // offline: queued again
  });

  it("L3-003: after a refused join an action goes out (and gets the helm's own refusal); queued ones fail with the join", () => {
    const c = connected();
    c.connect();
    const acks: string[] = [];
    c.s.emit("table:start", {}, (r) => acks.push(r.ok ? "ok" : r.code));
    c.joins()[0].ack!({ ok: false, code: "NO_TRIP", message: "That voyage doesn't exist." });
    expect(acks).toEqual(["NO_TRIP"]);
    expect(c.s.state.joined).toBe(false);
    c.s.emit("table:start", {});
    expect(c.actions()).toEqual(["table:start"]);
  });

  it("L1-002 / L5-004: a LOADING join is retried with growing waits, keeping the queue; success clears the notice", () => {
    vi.useFakeTimers();
    try {
      const c = connected();
      c.connect();
      c.s.emit("plan:vote", { planId: "A1" });
      const loading = { ok: false as const, code: "LOADING", message: "Fetching that voyage from the ship's log." };
      c.fire("error", { code: "LOADING", message: loading.message, event: "trip:join" });
      c.joins()[0].ack!(loading);
      expect(c.joins()).toHaveLength(1);
      vi.advanceTimersByTime(JOIN_RETRY_MS[0]);
      expect(c.joins()).toHaveLength(2);
      c.joins()[1].ack!(loading);
      vi.advanceTimersByTime(JOIN_RETRY_MS[0]);
      expect(c.joins()).toHaveLength(2); // the second wait is longer
      vi.advanceTimersByTime(JOIN_RETRY_MS[1] - JOIN_RETRY_MS[0]);
      expect(c.joins()).toHaveLength(3);
      expect(c.actions()).toEqual([]);
      expect(c.s.state.error?.code).toBe("LOADING");
      c.joins()[2].ack!({ ok: true, as: "member" });
      expect(c.actions()).toEqual(["plan:vote"]);
      expect(c.s.state.error).toBeNull();
      // a retry pending when the connection drops doesn't fire later
      c.drop(); c.connect();
      c.joins()[3].ack!(loading);
      c.drop();
      vi.advanceTimersByTime(20_000);
      expect(c.joins()).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("O2-049: a reconnect starts without the old refusal; join-time notices after it still show", () => {
    const c = connected();
    c.connect();
    c.joins()[0].ack!({ ok: true, as: "member" });
    c.fire("error", { code: "BAD_PHASE", message: "Not now.", event: "plan:pick" });
    c.drop();
    expect(c.s.state.error?.code).toBe("BAD_PHASE");
    c.connect();
    expect(c.s.state.error).toBeNull();
    c.fire("error", { code: "TOKEN_REJECTED", message: "no", event: "trip:join" });
    c.joins()[1].ack!({ ok: true, as: "spectator", tokenRejected: "member" });
    expect(c.s.state).toMatchObject({ role: "spectator", error: { code: "TOKEN_REJECTED" } });
  });

  it("O2-049: the reconnect delay grows to 10 s", () => {
    const { s } = mk();
    const mgr = s.socket.io as unknown as { reconnectionDelayMax(): number; reconnectionDelay(): number };
    expect(mgr.reconnectionDelay()).toBe(1000);
    expect(mgr.reconnectionDelayMax()).toBe(10_000);
  });

  it("L3-009: back to the charts clears the voided attempt's private leftovers", () => {
    const { s, fire } = mk("phone");
    const b = { bookingId: "b1", planId: "A1", attempt: 1, status: "VOIDED", mode: "sim", seals: [] };
    fire("trip:state", state({ status: "VOIDED", booking: b as never }));
    fire("booking:created", b);
    fire("seal:private", { bookingId: "b1", amountCents: 100, lines: [], fits: true, cardLast4: "4242", mode: "sim" });
    fire("seal:declinedPrivate", { bookingId: "b1", reason: "OVER_CAP" });
    fire("booking:result", { bookingId: "b1", status: "VOIDED", publicReason: "x" });
    fire("trip:state", state({ status: "VOIDED", booking: b as never, version: 2 }));
    expect(s.state.lastResult).not.toBeNull(); // still the current attempt
    fire("trip:state", state({ status: "DRY_RUN", version: 3 }));
    expect(s.state).toMatchObject({ booking: null, lastResult: null, declined: null, sealPrivate: null });
  });
});

function turn(turnId: string, seq: number) {
  return { turnId, tripId: "t1", seq, watch: 0, speaker: { kind: "captain" }, act: "OPEN", text: "", ribbon: "", voiced: false, redactions: 0, createdAt: new Date().toISOString() };
}
