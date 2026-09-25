// @vitest-environment happy-dom
// O2-067: the phone's hooks under a real React renderer (happy-dom + @testing-library/react): the send-guard latch and
// stale acks, selector caching, inline-error ownership (the O2-026 double banner), the two-tap confirm, the shared
// async-action shape and the "now" ticker. No socket is opened (autoConnect: false); store.emit is recorded.
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ack } from "@all-ayes/shared";
import { TripStore, type ClientState } from "../net/tripStore";
import { ApiError } from "../net/api";
import { TripProvider, useCrew, useInlineError, useSendGuard, useTripSelector } from "./TripContext";
import { useAsyncAction } from "./useAsyncAction";
import { useTwoTap } from "./components/useTwoTap";
import { useNow } from "./useNow";
import { CONFIRM_MS } from "./timing";
import { errorCopy } from "./errors";

const stores: TripStore[] = [];
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // (a simulated connection never opened a transport: mark it closed so close() has nothing to send)
  for (const s of stores.splice(0)) { (s.socket as unknown as { connected: boolean }).connected = false; s.close(); }
});

/** A store that never touches the network: `emit` records the ack so the test can answer it. */
function harness(memberId = "m1") {
  const store = new TripStore({ tripId: "t1", surface: "phone", autoConnect: false });
  stores.push(store);
  const acks: { ev: string; body: unknown; ack?: (r: Ack) => void }[] = [];
  vi.spyOn(store, "emit").mockImplementation(((ev: string, body: unknown, ack?: (r: Ack) => void) => { acks.push({ ev, body, ack }); }) as never);
  const sock = store.socket as unknown as { connected: boolean };
  sock.connected = true;
  const patch = (p: Partial<ClientState>) => act(() => { (store as unknown as { set(p: Partial<ClientState>): void }).set(p); });
  const session = { tripId: "t1", joinCode: "ABC", memberId, memberToken: "tok" };
  const wrapper = ({ children }: { children: ReactNode }) => <TripProvider store={store} session={session}>{children}</TripProvider>;
  return { store, acks, sock, patch, wrapper };
}

describe("useSendGuard (one tap, one emit)", () => {
  it("latches until the ack: a second tap before the answer sends nothing; a refusal re-opens it", () => {
    const h = harness();
    const { result } = renderHook(() => useSendGuard("plan:vote"), { wrapper: h.wrapper });
    let first = false, second = true;
    act(() => { first = result.current[1]({ planId: "A" }); second = result.current[1]({ planId: "B" }); });
    expect([first, second]).toEqual([true, false]);
    expect(h.acks).toHaveLength(1);
    expect(result.current[0]).toBe(true);
    act(() => h.acks[0].ack!({ ok: false, code: "BAD_PHASE", message: "no" }));
    expect(result.current[0]).toBe(false);
  });

  it("a success keeps it closed unless reopenOnOk", () => {
    const h = harness();
    const closed = renderHook(() => useSendGuard("plan:vote"), { wrapper: h.wrapper });
    act(() => { closed.result.current[1]({ planId: "A" }); });
    act(() => h.acks[0].ack!({ ok: true }));
    expect(closed.result.current[0]).toBe(true);
    const reopening = renderHook(() => useSendGuard("table:sailWithout", { reopenOnOk: true }), { wrapper: h.wrapper });
    act(() => { reopening.result.current[1]({ memberIds: ["x"] }); });
    act(() => h.acks[1].ack!({ ok: true }));
    expect(reopening.result.current[0]).toBe(false);
  });

  it("a stale ack (an earlier send's answer after reset and a new send) is ignored", () => {
    const h = harness();
    const { result } = renderHook(() => useSendGuard("plan:vote"), { wrapper: h.wrapper });
    act(() => { result.current[1]({ planId: "A" }); });
    act(() => result.current[2].reset());
    act(() => { result.current[1]({ planId: "B" }); });
    expect(h.acks).toHaveLength(2);
    act(() => h.acks[0].ack!({ ok: false, code: "BAD_PHASE", message: "old" })); // the first send's late refusal
    expect(result.current[0]).toBe(true); // still waiting on the second
    act(() => h.acks[1].ack!({ ok: false, code: "BAD_PHASE", message: "now" }));
    expect(result.current[0]).toBe(false);
  });

  it("the socket dropping before the answer re-opens it; a tap queued offline does not", () => {
    const h = harness();
    h.patch({ connected: true });
    const { result } = renderHook(() => useSendGuard<"plan:vote", string>("plan:vote"), { wrapper: h.wrapper });
    act(() => { result.current[1]({ planId: "A" }, "A"); });
    expect(result.current[2].payload).toBe("A");
    h.patch({ connected: false });
    expect(result.current[0]).toBe(false); // the answer was lost with the socket
    // offline: the store's outbox owns the answer, so a later reconnect/drop doesn't re-open it
    h.sock.connected = false;
    act(() => { result.current[1]({ planId: "B" }); });
    h.patch({ connected: true });
    h.patch({ connected: false });
    expect(result.current[0]).toBe(true);
  });
});

describe("useTripSelector / useCrew (OPT-047)", () => {
  it("re-renders only when the selected slice changes; an equal slice keeps its reference", () => {
    const h = harness();
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useTripSelector((s) => s.votes, (a, b) => JSON.stringify(a) === JSON.stringify(b)); }, { wrapper: h.wrapper });
    const first = result.current;
    const n = renders;
    h.patch({ memory: ["unrelated"] });
    expect(renders).toBe(n);
    h.patch({ votes: {} }); // a new but equal object
    expect(result.current).toBe(first);
    expect(renders).toBe(n);
    h.patch({ votes: { A: 1 } });
    expect(result.current).toEqual({ A: 1 });
    expect(renders).toBe(n + 1);
  });

  it("useCrew is stable across unrelated updates and knows who I am and who organizes", () => {
    const h = harness("m2");
    const crew = [{ memberId: "m1", name: "Rae" }, { memberId: "m2", name: "Maya" }];
    h.patch({ trip: { crew, organizerId: "m1" } as unknown as ClientState["trip"] });
    const { result } = renderHook(() => useCrew(), { wrapper: h.wrapper });
    const view = result.current;
    expect(view.me?.name).toBe("Maya");
    expect(view.isOrganizer).toBe(false);
    expect(view.crewName("m1")).toBe("Rae");
    expect(view.crewName("gone")).toBe("A friend");
    h.patch({ votes: { A: 2 } });
    h.patch({ trip: { crew: crew.map((c) => ({ ...c })), organizerId: "m1" } as unknown as ClientState["trip"] }); // equal crew, new objects
    expect(result.current).toBe(view);
  });

  it("outside a TripProvider it throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useCrew())).toThrow(/outside TripProvider/);
  });
});

describe("useInlineError (O2-026: one note, not two)", () => {
  it("takes an owned refusal inline in phone copy and clears the shell's banner; others stay in the banner", () => {
    const h = harness();
    const { result } = renderHook(() => useInlineError(["PASSKEY_REQUIRED"]), { wrapper: h.wrapper });
    const refusal = { code: "PASSKEY_REQUIRED", message: "server words", event: "seal:set" as const };
    h.patch({ error: refusal });
    expect(result.current.code).toBe("PASSKEY_REQUIRED");
    expect(result.current.note).toBe(errorCopy(refusal));
    expect(h.store.state.error).toBeNull(); // consumed: the banner won't show it too
    act(() => result.current.clear());
    expect(result.current.note).toBeNull();
    h.patch({ error: { code: "BAD_PHASE", message: "not mine" } });
    expect(result.current.note).toBeNull();
    expect(h.store.state.error?.code).toBe("BAD_PHASE");
  });

  it("with `events`, only refusals of those actions; inactive, nothing", () => {
    const h = harness();
    const scoped = renderHook(() => useInlineError(["SLOW_DOWN"], true, ["table:hail"]), { wrapper: h.wrapper });
    h.patch({ error: { code: "SLOW_DOWN", message: "x", event: "plan:vote" } });
    expect(scoped.result.current.note).toBeNull();
    expect(h.store.state.error).not.toBeNull();
    h.patch({ error: { code: "SLOW_DOWN", message: "x", event: "table:hail" } });
    expect(scoped.result.current.code).toBe("SLOW_DOWN");
    scoped.unmount();
    const off = renderHook(() => useInlineError(["SLOW_DOWN"], false), { wrapper: h.wrapper });
    h.patch({ error: { code: "SLOW_DOWN", message: "x" } });
    expect(off.result.current.note).toBeNull();
    expect(h.store.state.error).not.toBeNull();
  });
});

describe("useTwoTap", () => {
  it("the first tap arms, a second within CONFIRM_MS runs; otherwise it disarms by itself", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const { result } = renderHook(() => useTwoTap(run));
    act(() => result.current[1]("x"));
    expect(result.current[0]).toBe(true);
    expect(run).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(CONFIRM_MS); });
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]("y"));
    act(() => result.current[1]("z"));
    expect(run).toHaveBeenCalledExactlyOnceWith("z");
    expect(result.current[0]).toBe(false);
  });
});

describe("useAsyncAction (O2-016)", () => {
  it("busy while running, a second run is ignored, success clears the error", async () => {
    const { result } = renderHook(() => useAsyncAction());
    let finish!: () => void;
    const fn = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    let first!: Promise<boolean>, second!: Promise<boolean>;
    act(() => { first = result.current.run(fn, "fallback"); second = result.current.run(fn, "fallback"); });
    expect(result.current.busy).toBe(true);
    expect(await second).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); expect(await first).toBe(true); });
    expect(result.current.busy).toBe(false);
    expect(result.current.err).toBeNull();
  });

  it("a failure is phone copy: an ApiError by its code, anything else the fallback, never the raw text", async () => {
    const { result } = renderHook(() => useAsyncAction());
    await act(async () => { await result.current.run(() => Promise.reject(new Error("TypeError: secret stack")), "Couldn't save."); });
    expect(result.current.err).toBe("Couldn't save.");
    const api = new ApiError(409, "server words", "SEAT_TAKEN");
    await act(async () => { await result.current.run(() => Promise.reject(api), "Couldn't save."); });
    expect(result.current.err).toBe(errorCopy(api));
    act(() => result.current.clear());
    expect(result.current.err).toBeNull();
  });

  it("an answer after unmount touches no state", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useAsyncAction());
    let fail!: (e: Error) => void;
    let p!: Promise<boolean>;
    act(() => { p = result.current.run(() => new Promise((_, rej) => { fail = rej; }), "x"); });
    unmount();
    fail(new Error("late"));
    expect(await p).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("useNow (O2-017)", () => {
  it("ticks while active and stops when inactive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result, rerender } = renderHook(({ active }) => useNow(1000, active), { initialProps: { active: true } });
    expect(result.current).toBe(1_000_000);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(result.current).toBe(1_003_000);
    rerender({ active: false });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current).toBe(1_003_000);
    rerender({ active: true }); // jumps to now when it restarts
    expect(result.current).toBe(1_008_000);
  });
});
