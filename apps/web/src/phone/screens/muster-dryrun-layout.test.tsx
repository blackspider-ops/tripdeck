// @vitest-environment happy-dom
// Live demo fixes, rendered:
//   Muster: "Someone else on a seat?" and "+ Add an absent friend" sit on their own lines (they ran together).
//   Dry Run: "Your day" lists every day of the window, free days included, the last one the trip home.
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TripStore, type ClientState } from "../../net/tripStore";
import { api } from "../../net/api";
import { TripProvider } from "../TripContext";
import Muster from "./Muster";
import DryRun from "./DryRun";

beforeEach(() => { vi.spyOn(api, "health").mockResolvedValue({ ok: true, eleven: false } as never); });
const stores: TripStore[] = [];
afterEach(() => {
  cleanup();
  for (const s of stores.splice(0)) { (s.socket as unknown as { connected: boolean }).connected = false; s.close(); }
});

async function mount(ui: ReactElement, state: Partial<ClientState>, memberId = "m1") {
  const store = new TripStore({ tripId: "t1", surface: "phone", autoConnect: false });
  stores.push(store);
  vi.spyOn(store, "emit").mockImplementation((() => undefined) as never);
  store.state = { ...store.state, connected: true, ...state };
  const session = { tripId: "t1", joinCode: "ABC", memberId, memberToken: "tok" };
  const view = render(<MemoryRouter><TripProvider store={store} session={session}>{ui}</TripProvider></MemoryRouter>);
  await act(async () => { await Promise.resolve(); });
  return view;
}

const crew = [
  { memberId: "m1", name: "Rae", role: "organizer", band: 1, briefSealed: false },
  { memberId: "m2", name: "Milo", role: "member", band: 2, briefSealed: true },
];
const trip = (over: Record<string, unknown> = {}) => ({
  tripId: "t1", joinCode: "ABC", name: "Long weekend", status: "BRIEFING", version: 1, organizerId: "m1", crew,
  candidateCities: [], dateWindows: [{ id: "W10", start: "2028-03-10", end: "2028-03-15" }], negotiation: { watch: 0, running: false }, ...over,
}) as unknown as ClientState["trip"];

describe("Muster: the organizer's crew actions", () => {
  it("'Someone else on a seat?' and '+ Add an absent friend' are separate blocks, one per line", async () => {
    await mount(<Muster />, { trip: trip() });
    const reset = screen.getByRole("button", { name: /someone else on a seat/i });
    const add = screen.getByRole("button", { name: /add an absent friend/i });
    // each inline button in its own block wrapper (a new line), inside a spaced stack
    expect(reset.parentElement).not.toBe(add.parentElement);
    expect(reset.parentElement!.tagName).toBe("DIV");
    expect(add.parentElement!.tagName).toBe("DIV");
    const stack = reset.parentElement!.parentElement!;
    expect(stack).toBe(add.parentElement!.parentElement);
    expect(stack.classList.contains("stack")).toBe(true);
    expect(stack.children.length).toBe(2);
  });
});

describe("Dry Run: your day covers the whole window", () => {
  it("lists every day, landing first, free days marked, the last one the trip home", async () => {
    const chart = {
      planId: "AVL-1", label: "A", cityId: "AVL", cityName: "Asheville", hotelName: "Inn", neighborhood: "Downtown", dateWindowId: "W10",
      groupRange: { lowCents: 250_000, highCents: 300_000 }, fitsEveryone: true, publicFlags: [], cityNotes: [], days: [],
    };
    const item = (name: string, startMin: number, together = true) => ({ activityId: name, name, startMin, endMin: startMin + 120, lat: 0, lng: 0, together });
    const labels = ["Fri, Mar 10", "Sat, Mar 11", "Sun, Mar 12", "Mon, Mar 13", "Tue, Mar 14", "Wed, Mar 15"];
    const priv = {
      planId: "AVL-1", amountCents: 100_000, lines: [], fits: true, reasons: ["ok"], covered: [], missing: [], flags: [],
      arrival: { landMin: 13 * 60, atStayMin: 13 * 60 + 45 },
      days: labels.map((label, i) => ({ day: i + 1, label, items: i === 0 ? [item("Brewery crawl", 20 * 60)] : i === 1 ? [item("Biltmore", 12 * 60)] : [] })),
    };
    await mount(<DryRun />, { trip: trip({ status: "DRY_RUN" }), shortlist: [chart as never], planPrivate: { "AVL-1": priv as never } }, "m2");
    for (const l of labels) expect(screen.getByText(l)).toBeTruthy();
    expect(screen.getAllByText("Free day").length).toBe(3);
    expect(screen.getByText("Free day · then home")).toBeTruthy();
    expect(screen.getByText(/Land, then to Downtown/)).toBeTruthy();
  });
});

describe("date-range voyages on the phone", () => {
  const range = { start: "2027-03-01", end: "2027-03-31", minNights: 3, maxNights: 5 };
  const gen = [
    { id: "D20270304N3", start: "2027-03-04", end: "2027-03-07", nights: 3, label: "Mar 4–7" },
    { id: "D20270330N3", start: "2027-03-30", end: "2027-04-02", nights: 3, label: "Mar 30–Apr 2" },
  ];
  it("Muster's chart: the range and trip length while briefing; the generated trips once the table met", async () => {
    await mount(<Muster />, { trip: trip({ dateRange: range, dateWindows: [] }) });
    const card = screen.getByRole("region", { name: "The chart" });
    expect(card.textContent).toContain("Mar 1–31, 2027 · 3–5 nights");
    expect(card.textContent).toContain("Everyone marks the days they can go");
    cleanup();
    await mount(<Muster />, { trip: trip({ dateRange: range, dateWindows: gen, status: "AT_TABLE" }) });
    const after = screen.getByRole("region", { name: "The chart" });
    expect(after.textContent).toContain("Trips: Mar 4–7 · Mar 30–Apr 2"); // generated labels aren't repeated
  });

  it("Dry Run: each chart names its dates; my own date mismatch shows only as mine", async () => {
    const chart = (planId: string, label: "A" | "B", dateWindowId: string) => ({
      planId, label, cityId: "LIS", cityName: "Lisbon", hotelName: "Inn", neighborhood: "Alfama", dateWindowId,
      groupRange: { lowCents: 250_000, highCents: 300_000 }, fitsEveryone: false, publicFlags: [], cityNotes: [], days: [],
    });
    const priv = (planId: string, reasons: string[]) => ({ planId, amountCents: 1, lines: [], fits: false, reasons, covered: [], missing: [], flags: [], days: [] });
    await mount(<DryRun />, {
      trip: trip({ status: "DRY_RUN", dateRange: range, dateWindows: gen }),
      shortlist: [chart("A1", "A", gen[0].id), chart("B1", "B", gen[1].id)] as never,
      planPrivate: { A1: priv("A1", ["date_mismatch"]), B1: priv("B1", ["over_cap"]) } as never,
    }, "m2");
    const cards = screen.getByRole("group", { name: "The two charts" }).querySelectorAll(".chart-card");
    expect(cards[0].textContent).toContain("Mar 4–7");
    expect(cards[0].textContent).toContain("not your dates");
    expect(cards[1].textContent).toContain("Mar 30–Apr 2");
    expect(cards[1].textContent).not.toContain("not your dates");
  });
});
