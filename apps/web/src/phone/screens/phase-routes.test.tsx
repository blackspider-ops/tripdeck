// @vitest-environment happy-dom
// O2-067 (deferred from R2-WP-08): the phase guard with no voyage loaded (L1-002: NO_TRIP is not a dead end, LOADING
// waits with the plotting mark), a seat the helm no longer knows, and JoinCrew's by-code lookup (LOADING retried with
// growing waits, O2-048: aborted on unmount). No network: api.tripByCode / api.health are stubbed.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TripStore, type ClientState } from "../../net/tripStore";
import { api, ApiError } from "../../net/api";
import { KEYS, readRaw, removeKey, writeRaw } from "../../net/storage";
import { loadSession, saveSession } from "../../net/session";
import { TripProvider } from "../TripContext";
import { LOOKUP_RETRY_MS } from "../timing";
import PhaseRoutes from "./PhaseRoutes";
import { JoinCrew } from "../components/JoinCrew";

const stores: TripStore[] = [];
beforeEach(() => { vi.spyOn(api, "health").mockResolvedValue({ ok: true, eleven: false } as never); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  removeKey(KEYS.session("ABC")); removeKey(KEYS.last);
  for (const s of stores.splice(0)) { (s.socket as unknown as { connected: boolean }).connected = false; s.close(); }
});

function mountRoutes(state: Partial<ClientState>, memberId = "m1") {
  const store = new TripStore({ tripId: "t1", surface: "phone", autoConnect: false });
  stores.push(store);
  vi.spyOn(store, "emit").mockImplementation((() => undefined) as never);
  store.state = { ...store.state, ...state };
  const session = { tripId: "t1", joinCode: "ABC", memberId, memberToken: "tok" };
  render(
    <MemoryRouter initialEntries={["/t/ABC/muster"]}>
      <TripProvider store={store} session={session}>
        <Routes>
          <Route path="/t/:code/*" element={<PhaseRoutes />} />
          <Route path="/" element={<p>the start</p>} />
          <Route path="/join" element={<p>join page</p>} />
        </Routes>
      </TripProvider>
    </MemoryRouter>,
  );
  return { store };
}

describe("PhaseRoutes with no voyage loaded (L1-002)", () => {
  it("NO_TRIP: the note and 'Back to the start', which forgets this phone's seat and Landing's link", () => {
    saveSession({ tripId: "t1", joinCode: "ABC", memberId: "m1", memberToken: "tok" });
    writeRaw(KEYS.last, "ABC");
    mountRoutes({ error: { code: "NO_TRIP", message: "No voyage with that code." } });
    expect(screen.queryByRole("status")).toBeNull(); // not the plotting mark
    fireEvent.click(screen.getByRole("button", { name: /back to the start/i }));
    expect(screen.getByText("the start")).toBeTruthy();
    expect(loadSession("ABC")).toBeNull();
    expect(readRaw(KEYS.last)).toBeNull();
  });

  it("LOADING: the plotting mark says the voyage is being fetched; no way out offered (the store retries)", () => {
    mountRoutes({ error: { code: "LOADING", message: "busy" } });
    expect(screen.getByRole("status").textContent).toMatch(/fetching the voyage from the ship's log/i);
    expect(screen.queryByRole("button", { name: /back to the start/i })).toBeNull();
  });

  it("no error yet: 'Reading the log…' once connected, 'Plotting…' before", () => {
    mountRoutes({ connected: true });
    expect(screen.getByRole("status").textContent).toMatch(/reading the log/i);
    cleanup();
    mountRoutes({});
    expect(screen.getByRole("status").textContent).toMatch(/plotting/i);
  });

  it("a seat no longer on the crew can only watch, and 'Join again' clears it", () => {
    saveSession({ tripId: "t1", joinCode: "ABC", memberId: "gone", memberToken: "tok" });
    mountRoutes({ trip: { status: "BRIEFING", name: "Spring", organizerId: "m1", crew: [{ memberId: "m1", name: "Rae", band: 1, briefSealed: false }] } as never }, "gone");
    expect(screen.getByText(/isn't on the crew for this voyage anymore/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /join again/i }));
    expect(screen.getByText("join page")).toBeTruthy();
    expect(loadSession("ABC")).toBeNull();
  });
});

describe("JoinCrew: the by-code lookup (L1-002 / O2-048)", () => {
  const voyage = { tripId: "t1", joinCode: "ABC", name: "Spring voyage", status: "BRIEFING", crew: [{ memberId: "m1", name: "Rae", role: "organizer", band: 1, briefSealed: false }], takenBands: [1] };
  const mountJoin = () => render(
    <MemoryRouter><JoinCrew joinCode="ABC" onJoined={() => undefined} /></MemoryRouter>,
  );

  it("LOADING is retried with growing waits, then the voyage shows", async () => {
    vi.useFakeTimers();
    const loading = new ApiError(503, "busy", "LOADING");
    const look = vi.spyOn(api, "tripByCode")
      .mockRejectedValueOnce(loading).mockRejectedValueOnce(loading).mockResolvedValueOnce(voyage as never);
    mountJoin();
    await act(async () => { await Promise.resolve(); });
    expect(look).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(LOOKUP_RETRY_MS[0] - 1); });
    expect(look).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(look).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(LOOKUP_RETRY_MS[1]); });
    expect(look).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("heading", { name: "Spring voyage" })).toBeTruthy();
  });

  it("a LOADING that never ends gives up after the last wait; a 404 says the code is wrong", async () => {
    vi.useFakeTimers();
    const look = vi.spyOn(api, "tripByCode").mockRejectedValue(new ApiError(503, "busy", "LOADING"));
    mountJoin();
    for (const ms of LOOKUP_RETRY_MS) await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    expect(look).toHaveBeenCalledTimes(LOOKUP_RETRY_MS.length + 1);
    expect(screen.getByText(/couldn't reach the voyage/i)).toBeTruthy();
    cleanup();
    look.mockRejectedValue(new ApiError(404, "no", "NO_TRIP"));
    mountJoin();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/no voyage with that code/i)).toBeTruthy();
  });

  it("unmounting aborts the lookup and cancels a pending retry", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const look = vi.spyOn(api, "tripByCode").mockImplementation((_c, opts) => {
      signals.push(opts!.signal!);
      return Promise.reject(new ApiError(503, "busy", "LOADING"));
    });
    const view = mountJoin();
    await act(async () => { await Promise.resolve(); });
    view.unmount();
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(LOOKUP_RETRY_MS.reduce((a, b) => a + b, 0));
    expect(look).toHaveBeenCalledTimes(1);
  });
});
