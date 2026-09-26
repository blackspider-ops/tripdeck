// @vitest-environment happy-dom
// The full-product pickers, rendered: the searchable home airport, Create's course (where + when), the /demo page's
// two seeds, and the Brief's "Places I'd love / skip". No network: the api is mocked.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ack } from "@all-ayes/shared";
import { TripStore, type ClientState } from "../../net/tripStore";
import { api, type Catalog, type DemoSeed } from "../../net/api";
import { TripProvider } from "../TripContext";
import { OriginSelect } from "../components/ui";
import Create from "./Create";
import Demo from "./Demo";
import Brief from "./Brief";

vi.mock("../../net/passkey", async (orig) => ({
  ...(await orig<typeof import("../../net/passkey")>()),
  passkeyAvailability: vi.fn(async () => ({ canAdd: false, registered: false })),
}));

beforeAll(() => { Object.assign(window, { MediaRecorder: class {} }); });
beforeEach(() => { vi.spyOn(api, "health").mockResolvedValue({ ok: true, eleven: false } as never); });
const stores: TripStore[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) { (s.socket as unknown as { connected: boolean }).connected = false; s.close(); }
});
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("OriginSelect: a searchable home airport", () => {
  function Harness({ onPick }: { onPick: (o: string) => void }) {
    const [v, setV] = useState("ATL");
    return <OriginSelect value={v} onChange={(o) => { setV(o); onPick(o); }} />;
  }
  it("finds an airport by code or by city, and picks it with a click or Enter", () => {
    const picked: string[] = [];
    render(<Harness onPick={(o) => picked.push(o)} />);
    const box = screen.getByRole("combobox", { name: "Flying from" });
    expect((box as HTMLInputElement).value).toBe("Atlanta (ATL)");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "seattle" } });
    const opts = screen.getAllByRole("option");
    expect(opts[0].textContent).toContain("SEA");
    fireEvent.click(within(opts[0]).getByRole("button"));
    expect(picked).toEqual(["SEA"]);

    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "yyz" } });
    expect(screen.getAllByRole("option")[0].textContent).toContain("Toronto");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(picked).toEqual(["SEA", "YYZ"]);
  });
});

const catalog: Catalog = {
  cities: [
    { cityId: "LIS", name: "Lisbon", notes: [], region: "Europe", country: "Portugal" },
    { cityId: "BCN", name: "Barcelona", notes: [], region: "Europe", country: "Spain" },
    { cityId: "MEX", name: "Mexico City", notes: [], region: "Latin America", country: "Mexico" },
    { cityId: "AUS", name: "Austin", notes: [], region: "United States", country: "United States", state: "TX" },
  ],
  regions: ["Europe", "Latin America", "United States"],
  windows: [
    { id: "W1", start: "2027-03-12", end: "2027-03-16", nights: 4 },
    { id: "W2", start: "2027-03-13", end: "2027-03-16", nights: 3 },
    { id: "W3", start: "2027-05-28", end: "2027-05-31", nights: 3, label: "Memorial Day weekend" },
  ],
  defaultWindowIds: ["W1", "W2"],
  airports: [],
};

describe("Create: where and when", () => {
  it("sends regions and the default windows; named ports are 2–4", async () => {
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    const create = vi.spyOn(api, "createTrip").mockResolvedValue({ tripId: "t", joinCode: "J", memberId: "m", memberToken: "k" });
    render(<MemoryRouter><Create /></MemoryRouter>);
    await settle();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Rae" } });
    // "Surprise me" drew three ports; the chart shows them
    expect(within(screen.getByRole("group", { name: "Ports on the chart" })).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: "Regions" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Regions" })).getByRole("button", { name: "Europe" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Dates on offer" })).getByRole("button", { name: /Memorial Day/ }));
    fireEvent.click(screen.getByRole("button", { name: "Set sail" }));
    await settle();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({ organizerName: "Rae", destination: { kind: "regions", regions: ["Europe"] }, windowIds: ["W1", "W2", "W3"] });
  });

  it("anywhere; and without a catalog the helm chooses", async () => {
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    const create = vi.spyOn(api, "createTrip").mockResolvedValue({ tripId: "t", joinCode: "J", memberId: "m", memberToken: "k" });
    render(<MemoryRouter><Create /></MemoryRouter>);
    await settle();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Rae" } });
    fireEvent.click(screen.getByRole("radio", { name: "Anywhere" }));
    fireEvent.click(screen.getByRole("button", { name: "Set sail" }));
    await settle();
    expect(create.mock.calls[0][0]).toMatchObject({ destination: { kind: "anywhere" }, windowIds: ["W1", "W2"] });
    cleanup();

    vi.spyOn(api, "catalog").mockRejectedValue(new Error("offline"));
    render(<MemoryRouter><Create /></MemoryRouter>);
    await settle();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Rae" } });
    fireEvent.click(screen.getByRole("button", { name: "Set sail" }));
    await settle();
    expect(create.mock.calls[1][0]).not.toHaveProperty("destination");
  });
});

describe("Demo: two seeds", () => {
  it("a random voyage by default, the scripted Expo one on request; the crew is listed from the seed", async () => {
    const seat = (name: string, role: "organizer" | "member" | "absent", id: string) => ({ name, role, band: 1 as const, memberId: id, memberToken: "t", handoff: "h" });
    const seed: DemoSeed = {
      kind: "random", seed: 7, tripId: "t", joinCode: "ABCDEF", tripName: "Crew escape", ports: ["Lisbon", "Austin", "Tokyo"], headsetCode: "X",
      organizer: seat("Ava", "organizer", "a"), crew: [seat("Ava", "organizer", "a"), seat("Ben", "member", "b"), seat("Cleo", "absent", "c")],
    };
    const call = vi.spyOn(api, "seedDemo").mockResolvedValue(seed);
    render(<MemoryRouter><Demo /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Seed a random voyage" }));
    await settle();
    expect(call).toHaveBeenLastCalledWith("random");
    expect(screen.getByText("Crew escape")).toBeTruthy();
    expect(screen.getByText("Lisbon · Austin · Tokyo")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open as Ava" })).toBeTruthy();
    expect(screen.getByText("Cleo · away")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Seed the scripted Expo voyage" }));
    await settle();
    expect(call).toHaveBeenLastCalledWith("expo");
  });
});

describe("Brief: places I'd love / skip", () => {
  async function mount(ui: ReactElement, state: Partial<ClientState>) {
    const store = new TripStore({ tripId: "t1", surface: "phone", autoConnect: false });
    stores.push(store);
    const sent: { ev: string; body: unknown; ack?: (r: Ack) => void }[] = [];
    vi.spyOn(store, "emit").mockImplementation(((ev: string, body: unknown, ack?: (r: Ack) => void) => { sent.push({ ev, body, ack }); }) as never);
    store.state = { ...store.state, connected: true, ...state };
    (store.socket as unknown as { connected: boolean }).connected = true;
    render(<MemoryRouter><TripProvider store={store} session={{ tripId: "t1", joinCode: "ABC", memberId: "m1", memberToken: "tok" }}>{ui}</TripProvider></MemoryRouter>);
    await settle();
    return sent;
  }
  it("a place goes on one list at most, and both lists go with the sealed terms", async () => {
    const trip = {
      tripId: "t1", joinCode: "ABC", name: "Spring", status: "BRIEFING", version: 1, organizerId: "m1",
      crew: [{ memberId: "m1", name: "Rae", role: "organizer", band: 1, briefSealed: false }],
      candidateCities: [], negotiation: { watch: 0, running: false },
      dateWindows: [{ id: "W3", start: "2027-05-28", end: "2027-05-31", nights: 3, label: "Memorial Day weekend" }],
      destination: {
        kind: "regions", regions: ["Europe"], label: "Europe", portsChosen: false,
        scope: [{ cityId: "LIS", name: "Lisbon", region: "Europe" }, { cityId: "BCN", name: "Barcelona", region: "Europe" }],
      },
    } as unknown as ClientState["trip"];
    const sent = await mount(<Brief />, { trip });
    expect(screen.getByRole("button", { name: /Memorial Day weekend · May 28–31/ })).toBeTruthy();
    const places = screen.getByRole("region", { name: "Places" });
    const [loveBcn, skipBcn] = within(places).getAllByRole("button", { name: "Barcelona" });
    const [, skipEurope] = within(places).getAllByRole("button", { name: "Europe" });
    fireEvent.click(skipBcn);
    fireEvent.click(loveBcn); // moves Barcelona from "skip" to "love"
    fireEvent.click(skipEurope);
    expect(loveBcn.getAttribute("aria-pressed")).toBe("true");
    expect(skipBcn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /seal my terms/i }));
    const submit = sent.find((s) => s.ev === "brief:submit");
    expect(submit?.body).toMatchObject({ dateWindowIds: ["W3"], loves: ["BCN"], skips: ["Europe"] });
  });
});
