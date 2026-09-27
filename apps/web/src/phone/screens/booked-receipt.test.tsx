// @vitest-environment happy-dom
// O2-067: two phone screens' own logic, rendered: Booked's .ics (escaping, all-day dates with an exclusive end, only
// my itinerary) and the organizer's "Sail without them" clock (TR1-007: kept per voyage across remounts, dropped once
// everyone has sealed).
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ack } from "@all-ayes/shared";
import { TripStore, type ClientState } from "../../net/tripStore";
import { KEYS, removeKey } from "../../net/storage";
import { TripProvider } from "../TripContext";
import Booked from "./Booked";

const stores: TripStore[] = [];
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  removeKey(KEYS.unsealedSince("t1")); // (the storage module: Node's own localStorage stub may be what tests see)
  for (const s of stores.splice(0)) { (s.socket as unknown as { connected: boolean }).connected = false; s.close(); }
});

function mount(ui: React.ReactElement, state: Partial<ClientState>, memberId = "m1") {
  const store = new TripStore({ tripId: "t1", surface: "phone", autoConnect: false });
  stores.push(store);
  const sent: { ev: string; body: unknown; ack?: (r: Ack) => void }[] = [];
  vi.spyOn(store, "emit").mockImplementation(((ev: string, body: unknown, ack?: (r: Ack) => void) => { sent.push({ ev, body, ack }); }) as never);
  store.state = { ...store.state, ...state };
  const session = { tripId: "t1", joinCode: "ABC", memberId, memberToken: "tok" };
  const view = render(<TripProvider store={store} session={session}>{ui}</TripProvider>);
  const patch = (p: Partial<ClientState>) => act(() => { (store as unknown as { set(p: Partial<ClientState>): void }).set(p); });
  return { store, sent, view, patch, session };
}

const trip = (over: Record<string, unknown> = {}) => ({
  tripId: "t1", joinCode: "ABC", name: "Spring; crew, \\ go", status: "BOOKED", version: 1, organizerId: "m1",
  crew: [{ memberId: "m1", name: "Rae", briefSealed: true }, { memberId: "m2", name: "Maya", briefSealed: true }],
  candidateCities: [], dateWindows: [{ id: "W1", start: "2027-03-12", end: "2027-03-16" }], negotiation: { watch: 0, running: false },
  chosenPlanId: "LIS-1", ...over,
}) as unknown as ClientState["trip"];

import { humanShareLabel } from "@all-ayes/shared";

describe("Booked: the whole stay and the receipt", () => {
  const win = { id: "W1", start: "2027-02-18", end: "2027-02-21", nights: 3 };
  const mine = {
    planId: "SDF-1", amountCents: 150000, fits: true, reasons: ["ok"], covered: [], missing: [], flags: [],
    lines: [
      { kind: "flight", label: "Flight IAD⇄SDF", amountCents: 40000 },
      { kind: "lodging", label: "Inn at the Park ×2, 1/5 ×3n", amountCents: 60000 },
      { kind: "activity", label: "Slugger Museum", amountCents: 2000 },
      { kind: "activity", label: "Bourbon tasting", amountCents: 5000 },
    ],
    arrival: { landMin: 11 * 60, atStayMin: 11 * 60 + 45 },
    days: [
      { day: 1, label: "Thu, Feb 18", items: [] },
      { day: 2, label: "Fri, Feb 19", items: [{ activityId: "a1", name: "Slugger Museum", startMin: 540, endMin: 630, lat: 0, lng: 0, together: true }] },
      { day: 3, label: "Sat, Feb 20", items: [{ activityId: "a2", name: "Bourbon tasting", startMin: 660, endMin: 780, lat: 0, lng: 0, together: true }] },
      { day: 4, label: "Sun, Feb 21", items: [] },
    ],
  };
  const state = () => ({
    trip: trip({ dateWindows: [win], chosenPlanId: "SDF-1" }),
    shortlist: [{ planId: "SDF-1", cityName: "Louisville", hotelName: "Inn at the Park ×2", neighborhood: "Old Louisville", dateWindowId: "W1" } as never],
    planPrivate: { "SDF-1": mine as never },
    booking: { bookingId: "b1", planId: "SDF-1", attempt: 1, status: "CAPTURED", mode: "visa_sandbox", reference: "TD-SDF-7K2Q", seals: [] } as never,
    sealPrivate: { bookingId: "b1", amountCents: 107000, lines: mine.lines, fits: true, cardLast4: "4242", mode: "visa_sandbox" } as never,
  });

  it("shows every day: arrival (flight, check-in, dinner), full days, departure (check-out, flight home)", () => {
    mount(<Booked />, state());
    for (const d of ["Thu, Feb 18", "Fri, Feb 19", "Sat, Feb 20", "Sun, Feb 21"]) expect(screen.getByRole("region", { name: d })).toBeTruthy();
    expect(screen.getByText("Flight lands · IAD → SDF")).toBeTruthy();
    expect(screen.getByText("Check in · Inn at the Park")).toBeTruthy();
    expect(screen.getByText("Check out · Inn at the Park")).toBeTruthy();
    expect(screen.getByText("Flight home · SDF → IAD")).toBeTruthy();
    expect(screen.getAllByText("Slugger Museum")).toHaveLength(1);
  });

  it("itemises the receipt in plain words, grouped, with simulated confirmations and the card", () => {
    mount(<Booked />, state());
    const r = screen.getByRole("article", { name: "Receipt" });
    expect(r.textContent).toContain("TD-SDF-7K2Q");
    expect(r.textContent).toContain("Round-trip flight · IAD ⇄ SDF · Feb 18 / Feb 21");
    expect(r.textContent).toContain("Inn at the Park · 2 rooms · 3 nights · your share (1 of 5)");
    expect(r.textContent).toContain("Slugger Museum · Fri, Feb 19");
    expect(r.textContent).toContain("Experiences subtotal");
    expect(r.textContent).toContain("Charged to Visa •••• 4242");
    expect(r.textContent).toMatch(/Captured · Visa sandbox: card verified at seal · holds and charges simulated · no real card charged/);
    expect(r.textContent).toMatch(/SIM-[A-Z0-9]{6} \(simulated\)/);
    expect(r.textContent).not.toContain("×");
  });

  it("humanShareLabel rewrites the old terse lines", () => {
    expect(humanShareLabel("Casa Alfama ⅓ ×4n")).toBe("Casa Alfama · 4 nights · your share (1 of 3)");
    expect(humanShareLabel("Casa Alfama ×1n")).toBe("Casa Alfama · 1 night");
    expect(humanShareLabel("Tram 28")).toBe("Tram 28");
  });
});
