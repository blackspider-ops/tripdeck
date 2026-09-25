// @vitest-environment happy-dom
// O2-067: two phone screens' own logic, rendered: Booked's .ics (escaping, all-day dates with an exclusive end, only
// my itinerary) and the organizer's "Sail without them" clock (TR1-007: kept per voyage across remounts, dropped once
// everyone has sealed).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ack } from "@all-ayes/shared";
import { TripStore, type ClientState } from "../../net/tripStore";
import { KEYS, readJSON, readRaw, removeKey } from "../../net/storage";
import { TripProvider } from "../TripContext";
import { SAIL_WITHOUT_AFTER_MS } from "../timing";
import Booked from "./Booked";
import { SailWithout } from "../components/organizer";

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

describe("Booked: Save to your log (.ics)", () => {
  it("builds an all-day event (end exclusive), escapes , ; \\ and newlines, and lists only my itinerary", async () => {
    const blobs: Blob[] = [];
    Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => { blobs.push(b); return "blob:x"; }), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    mount(<Booked />, {
      trip: trip(),
      shortlist: [{ planId: "LIS-1", cityName: "Lisbon", hotelName: "Casa, Alfama", neighborhood: "Alfama", dateWindowId: "W1" } as never],
      planPrivate: { "LIS-1": { planId: "LIS-1", days: [{ day: 1, label: "Thu", items: [{ activityId: "a", startMin: 600, name: "Tram 28; the hills" }] }] } as never },
      lastResult: { bookingId: "b1", status: "CAPTURED", reference: "AA-LIS-7K2Q" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save to your log/i }));
    expect(click).toHaveBeenCalledOnce();
    const ics = await blobs[0].text();
    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("UID:AA-LIS-7K2Q@allayes");
    expect(lines).toContain("DTSTART;VALUE=DATE:20270312");
    expect(lines).toContain("DTEND;VALUE=DATE:20270317"); // the day after the last night
    expect(lines).toContain("SUMMARY:Spring\\; crew\\, \\\\ go — Lisbon");
    expect(lines).toContain("LOCATION:Casa\\, Alfama\\, Alfama\\, Lisbon");
    expect(lines).toContain("DESCRIPTION:Ref AA-LIS-7K2Q\\nThu 10:00 Tram 28\\; the hills");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(blobs[0].type).toBe("text/calendar");
  });
});

describe("SailWithout: the 2-minute clock (TR1-007)", () => {
  it("appears only after SAIL_WITHOUT_AFTER_MS, survives a remount, and forgets the voyage once all have sealed", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000_000);
    const unsealed = trip({ status: "BRIEFING", crew: [{ memberId: "m1", name: "Rae", briefSealed: true }, { memberId: "m2", name: "Maya", briefSealed: false }] });
    const first = mount(<SailWithout />, { trip: unsealed });
    expect(screen.queryByText(/sail without them/i)).toBeNull();
    expect(readJSON(KEYS.unsealedSince("t1"))).toEqual({ m2: 1_000_000 });
    act(() => { vi.advanceTimersByTime(SAIL_WITHOUT_AFTER_MS / 2); });
    first.view.unmount(); // moving between screens doesn't restart the clock

    const again = mount(<SailWithout />, { trip: unsealed });
    act(() => { vi.advanceTimersByTime(SAIL_WITHOUT_AFTER_MS / 2 + 5_000); });
    expect(screen.getByText(/still waiting on maya/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /sail without them/i }));
    expect(again.sent.map((s) => [s.ev, s.body])).toEqual([["table:sailWithout", { memberIds: ["m2"] }]]);

    again.patch({ trip: trip({ status: "BRIEFING" }) }); // everyone sealed
    expect(screen.queryByText(/sail without them/i)).toBeNull();
    expect(readRaw(KEYS.unsealedSince("t1"))).toBeNull();
  });

  it("a member (not the organizer) never sees it", () => {
    mount(<SailWithout />, { trip: trip({ status: "BRIEFING", crew: [{ memberId: "m1", name: "Rae", briefSealed: true }, { memberId: "m2", name: "Maya", briefSealed: false }] }) }, "m2");
    expect(screen.queryByText(/sail without them/i)).toBeNull();
  });
});
