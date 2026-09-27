// @vitest-environment happy-dom
// Quest-first (docs/03 §4): the /xr start screen, Join a trip (a new headset seat, or "Is this your seat?" with the
// one-tap approval on the seat's own phone), and the seal PIN a headset without passkeys sets.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api } from "../net/api";
import { KEYS, readJSON, removeKey } from "../net/storage";
import QuestStart, { ATTACH_POLL_MS, QuestJoin, SealPinSetup } from "./QuestStart";

afterEach(() => { cleanup(); vi.useRealTimers(); removeKey(KEYS.session("K7M2QX")); removeKey(KEYS.last); });

const LOOKUP = {
  tripId: "t1", joinCode: "K7M2QX", name: "Spring Break", status: "BRIEFING" as const, takenBands: [1, 2] as never,
  crew: [
    { memberId: "rae", name: "Rae", role: "organizer" as const, band: 1 as const, briefSealed: false },
    { memberId: "dev", name: "Dev", role: "absent" as const, band: 2 as const, briefSealed: false, inviteOpen: false },
  ],
};

function mount(path = "/xr/join") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/xr" element={<QuestStart />} />
        <Route path="/xr/join" element={<QuestJoin />} />
        <Route path="/t/:code/xr" element={<p>chart room</p>} />
        <Route path="/t/:code/brief" element={<p>my terms</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function findTrip() {
  vi.spyOn(api, "tripByCode").mockResolvedValue(LOOKUP);
  mount();
  fireEvent.change(screen.getByLabelText("Voyage code"), { target: { value: "k7m2-qx" } });
  expect((screen.getByLabelText("Voyage code") as HTMLInputElement).value).toBe("K7M2QX");
  fireEvent.click(screen.getByRole("button", { name: "Find the voyage" }));
  await screen.findByText("Is one of these your seat?");
}

describe("/xr start screen", () => {
  it("offers Start a trip and Join a trip as big links, and keeps the headset-code pairing as a fallback", () => {
    mount("/xr");
    expect(screen.getByRole("link", { name: "Start a trip" }).getAttribute("href")).toBe("/xr/new");
    expect(screen.getByRole("link", { name: "Join a trip" }).getAttribute("href")).toBe("/xr/join");
    expect(screen.getByRole("link", { name: /headset code/i }).getAttribute("href")).toBe("/xr/code");
  });
});

describe("Join a trip on a Quest", () => {
  it("a new seat: joins as a headset seat, then (no passkeys here) sets a seal PIN before its terms", async () => {
    await findTrip();
    // an absent friend's unopened seat can't be asked for (nobody's phone holds it yet)
    expect((screen.getByRole("button", { name: /I'm Dev/ }) as HTMLButtonElement).disabled).toBe(true);
    const join = vi.spyOn(api, "join").mockResolvedValue({ memberId: "maya", memberToken: "tok-maya" });
    vi.spyOn(api, "sealPinStatus").mockResolvedValue({ set: false });
    fireEvent.click(screen.getByRole("button", { name: "I'm new: take a seat" }));
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Maya" } });
    fireEvent.click(screen.getByRole("button", { name: "Join the crew" }));
    await screen.findByText("Set a seal PIN");
    expect(join).toHaveBeenCalledWith("t1", expect.objectContaining({ name: "Maya", device: "headset" }));
    expect(readJSON(KEYS.session("K7M2QX"))).toMatchObject({ memberId: "maya", memberToken: "tok-maya", device: "headset" });
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await screen.findByText("my terms");
  });

  it("an existing seat: asks that seat's phone, polls, and comes aboard with the device key it was given", async () => {
    await findTrip();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ask = vi.spyOn(api, "attachHeadset").mockResolvedValue({ requestId: "r1", secret: "s1", expiresAt: Date.now() + 120_000, askName: "Rae", tripId: "t1", joinCode: "K7M2QX" });
    const status = vi.spyOn(api, "attachStatus")
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "approved", tripId: "t1", joinCode: "K7M2QX", memberId: "rae", deviceToken: "dev-key" });
    vi.spyOn(api, "sealPinStatus").mockResolvedValue({ set: true });
    fireEvent.click(screen.getByRole("button", { name: /I'm Rae \(organizer\)/ }));
    await screen.findByText(/Ask Rae to let this headset in/);
    expect(ask).toHaveBeenCalledWith("K7M2QX", "rae");
    await act(async () => { await vi.advanceTimersByTimeAsync(ATTACH_POLL_MS * 2 + 50); });
    await waitFor(() => expect(screen.getByText("chart room")).toBeTruthy());
    expect(status).toHaveBeenCalledWith("r1", "s1");
    expect(readJSON(KEYS.session("K7M2QX"))).toMatchObject({ memberId: "rae", memberToken: "dev-key", device: "headset" });
  });

  it("a refused request says so and can be asked again", async () => {
    await findTrip();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, "attachHeadset").mockResolvedValue({ requestId: "r1", secret: "s1", expiresAt: Date.now() + 120_000, askName: "Rae", tripId: "t1", joinCode: "K7M2QX" });
    vi.spyOn(api, "attachStatus").mockResolvedValue({ status: "denied" });
    fireEvent.click(screen.getByRole("button", { name: /I'm Rae/ }));
    await screen.findByText(/Ask Rae to let this headset in/);
    await act(async () => { await vi.advanceTimersByTimeAsync(ATTACH_POLL_MS + 50); });
    await screen.findByText(/Rae's phone said no/);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("Is one of these your seat?");
  });

  it("a wrong code says so", async () => {
    const { ApiError } = await import("../net/api");
    vi.spyOn(api, "tripByCode").mockRejectedValue(new ApiError(404, "nope", "NO_TRIP"));
    mount();
    fireEvent.change(screen.getByLabelText("Voyage code"), { target: { value: "ZZZZZZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Find the voyage" }));
    await screen.findByText(/No voyage with that code/);
  });
});

describe("the seal PIN", () => {
  it("is entered twice (big keys), must match, and is saved for the seat", async () => {
    const save = vi.spyOn(api, "setSealPin").mockResolvedValue({ ok: true });
    const done = vi.fn();
    render(<SealPinSetup session={{ tripId: "t1", joinCode: "K7M2QX", memberId: "m", memberToken: "tok" }} onDone={done} />);
    const tap = (k: string) => fireEvent.click(screen.getByRole("button", { name: k }));
    for (const k of "4821") tap(k);
    tap("OK");
    await screen.findByText("Once more, to be sure");
    for (const k of "4820") tap(k);
    tap("OK");
    await screen.findByText(/didn't match/);
    for (const k of "4821") tap(k);
    tap("OK");
    for (const k of "4821") tap(k);
    tap("OK");
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith("t1", "tok", "4821");
  });
});
