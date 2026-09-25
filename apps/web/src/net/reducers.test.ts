// R2-WP-16 (O2-021): the store's event handlers are a pure map, testable without a socket (O2-067 adds more).
import { describe, expect, it } from "vitest";
import { SERVER_TO_CLIENT_EVENTS, type BookingPublic, type TripState, type Turn } from "@all-ayes/shared";
import { TripStore, reducers, type ClientState } from "./tripStore";

const base = (): ClientState => new TripStore({ tripId: "t1", surface: "phone", autoConnect: false }).state;
const trip = (over: Partial<TripState> = {}): TripState => ({
  tripId: "t1", joinCode: "ABCDEF", name: "x", status: "AT_TABLE", version: 1, organizerId: "o", crew: [], candidateCities: [],
  dateWindows: [], negotiation: { watch: 0, running: true }, votes: {}, autoPick: null, paymentsMode: "sim", serverNow: Date.now(), ...over,
});
const turn = (turnId: string, seq: number) => ({ turnId, seq }) as Turn;

describe("O2-021: reducers", () => {
  it("covers every server → client event", () => {
    expect(SERVER_TO_CLIENT_EVENTS.filter((ev) => !(ev in reducers))).toEqual([]);
  });

  it("turn:new keeps the log in seq order and ignores a replayed turn", () => {
    let s = { ...base(), ...reducers["turn:new"](base(), turn("b", 2), "phone") };
    s = { ...s, ...reducers["turn:new"](s, turn("a", 1), "phone") };
    expect(s.turns.map((t) => t.turnId)).toEqual(["a", "b"]);
    expect(reducers["turn:new"](s, turn("a", 1), "phone")).toBeUndefined();
  });

  it("trip:state without the static fields keeps this voyage's ports and dates (R2-WP-14)", () => {
    const windows = [{ id: "W1", start: "2027-03-12", end: "2027-03-16" }] as unknown as TripState["dateWindows"];
    const s = { ...base(), ...reducers["trip:state"](base(), trip({ dateWindows: windows }), "phone") };
    const { dateWindows: _w, candidateCities: _c, ...live } = trip({ version: 2 });
    const next = reducers["trip:state"](s, live, "phone")!;
    expect(next.trip!.dateWindows).toBe(windows);
  });

  it("seal:status for another booking changes nothing; table:failed never reaches the Gallery", () => {
    const booking = { bookingId: "B1", seals: [{ memberId: "m", status: "PENDING" }] } as unknown as BookingPublic;
    const s = { ...base(), booking };
    expect(reducers["seal:status"](s, { bookingId: "B0", memberId: "m", status: "AUTHORIZED" }, "phone")).toBeUndefined();
    expect(reducers["seal:status"](s, { bookingId: "B1", memberId: "m", status: "AUTHORIZED" }, "phone")!.booking!.seals[0].status).toBe("AUTHORIZED");
    expect(reducers["table:failed"](s, { code: "TABLE_FAILED", message: "m" }, "gallery")).toBeUndefined();
    expect(reducers["table:failed"](s, { code: "TABLE_FAILED", message: "m" }, "phone")).toEqual({ error: { code: "TABLE_FAILED", message: "m" } });
  });
});
