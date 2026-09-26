// @vitest-environment happy-dom
// Live demo fix: Muster's QR box rendered empty (the lazy qrcode import failed and the error was swallowed). The QR
// is drawn from the lazily loaded module; a failure is retried, and one that persists says so instead of a blank box.
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toDataURL = vi.fn(async (value: string, _opts?: unknown) => `data:image/png;base64,${btoa(value)}`);
vi.mock("qrcode", () => ({ default: { toDataURL: (v: string, o: unknown) => toDataURL(v, o as never) } }));

import { QR } from "./crew";
import { TripStore, type ClientState } from "../../net/tripStore";
import { api } from "../../net/api";
import { TripProvider } from "../TripContext";
import Muster from "../screens/Muster";

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const stores: TripStore[] = [];
beforeEach(() => { vi.spyOn(api, "health").mockResolvedValue({ ok: true, eleven: false } as never); });
afterEach(() => {
  cleanup();
  toDataURL.mockReset();
  toDataURL.mockImplementation(async (value: string, _opts?: unknown) => `data:image/png;base64,${btoa(value)}`);
  for (const s of stores.splice(0)) { (s.socket as unknown as { connected: boolean }).connected = false; s.close(); }
});

describe("QR", () => {
  it("draws the code as an image once the lazy module loads", async () => {
    render(<QR value="http://localhost:5173/join/ABC" label="QR to join voyage ABC" />);
    await settle();
    const img = screen.getByRole("img", { name: "QR to join voyage ABC" }) as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.src).toMatch(/^data:image\/png;base64,/);
    expect(toDataURL).toHaveBeenCalledWith("http://localhost:5173/join/ABC", expect.objectContaining({ errorCorrectionLevel: "M" }));
  });

  it("says it didn't load (never a silent blank box) when drawing fails", async () => {
    toDataURL.mockRejectedValue(new Error("boom"));
    render(<QR value="x" label="QR to join voyage ABC" />);
    await settle();
    const box = screen.getByRole("img", { name: "QR to join voyage ABC" });
    expect(box.tagName).toBe("DIV");
    expect(box.textContent).toMatch(/didn't load/i);
  });
});

describe("Muster: the join QR", () => {
  it("renders the join link's QR for the organizer", async () => {
    const store = new TripStore({ tripId: "t1", surface: "phone", autoConnect: false });
    stores.push(store);
    vi.spyOn(store, "emit").mockImplementation((() => undefined) as never);
    const trip = {
      tripId: "t1", joinCode: "ABC", name: "Long weekend", status: "BRIEFING", version: 1, organizerId: "m1",
      crew: [{ memberId: "m1", name: "Rae", role: "organizer", band: 1, briefSealed: false }],
      candidateCities: [], dateWindows: [{ id: "W10", start: "2028-03-10", end: "2028-03-15" }], negotiation: { watch: 0, running: false },
    } as unknown as ClientState["trip"];
    store.state = { ...store.state, connected: true, trip };
    render(<MemoryRouter><TripProvider store={store} session={{ tripId: "t1", joinCode: "ABC", memberId: "m1", memberToken: "tok" }}><Muster /></TripProvider></MemoryRouter>);
    await settle();
    const img = screen.getByRole("img", { name: /QR to join voyage ABC/ }) as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.src).toMatch(/^data:image\/png/);
    expect(toDataURL.mock.calls[0][0]).toMatch(/ABC/);
  });
});
