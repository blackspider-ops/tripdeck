// @vitest-environment happy-dom
// O2-067 (deferred from R2-WP-09 / R2-WP-16 / R2-WP-01): phone screens, rendered.
//   L1-003  DryRun: plan:vote goes with an ack; the answer hands the highlight back to the helm's plan:myVote.
//   L1-006  "Headset code or unpair" on Table, Dry Run and Seal, for the organizer only.
//   L1-007  a locked Brief is read-only, and its voice note is gone.
//   LIVE-001 / O2-026  Seal: PASSKEY_REQUIRED shows once, inline; "Every seal is set · settling…" hides the call-off.
//   R2-WP-16  the hail dock is off in Watch 0 (the Captain is opening), on from Watch 1.
// No network: api.health says voice is available (so the voice controls render), net/passkey is stubbed.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ack } from "@all-ayes/shared";
import { TripStore, type ClientState } from "../../net/tripStore";
import { api } from "../../net/api";
import { PASSKEY_COPY, prepareSeal } from "../../net/passkey";
import { TripProvider } from "../TripContext";
import { errorCopy } from "../errors";
import DryRun from "./DryRun";
import Seal from "./Seal";
import Brief from "./Brief";
import Table from "./Table";

vi.mock("../../net/passkey", async (orig) => ({
  ...(await orig<typeof import("../../net/passkey")>()),
  prepareSeal: vi.fn(async () => ({ kind: "send" })),
  passkeyAvailability: vi.fn(async () => ({ canAdd: false, registered: false })),
}));

beforeAll(() => {
  // voice controls render only where a recorder could run (they are never started here)
  Object.assign(window, { MediaRecorder: class {} });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
});
beforeEach(() => {
  vi.spyOn(api, "health").mockResolvedValue({ ok: true, eleven: true } as never);
  vi.mocked(prepareSeal).mockResolvedValue({ kind: "send" });
});
const stores: TripStore[] = [];
afterEach(() => {
  cleanup();
  for (const s of stores.splice(0)) { (s.socket as unknown as { connected: boolean }).connected = false; s.close(); }
});

type Sent = { ev: string; body: unknown; ack?: (r: Ack) => void };
async function mount(ui: ReactElement, state: Partial<ClientState>, memberId = "m1") {
  const store = new TripStore({ tripId: "t1", surface: "phone", autoConnect: false });
  stores.push(store);
  const sent: Sent[] = [];
  vi.spyOn(store, "emit").mockImplementation(((ev: string, body: unknown, ack?: (r: Ack) => void) => { sent.push({ ev, body, ack }); }) as never);
  store.state = { ...store.state, connected: true, ...state };
  (store.socket as unknown as { connected: boolean }).connected = true;
  const session = { tripId: "t1", joinCode: "ABC", memberId, memberToken: "tok" };
  const view = render(<MemoryRouter><TripProvider store={store} session={session}>{ui}</TripProvider></MemoryRouter>);
  await act(async () => { await Promise.resolve(); }); // api.health / passkey availability settle
  const patch = (p: Partial<ClientState>) => act(() => { (store as unknown as { set(p: Partial<ClientState>): void }).set(p); });
  return { store, sent, view, patch };
}

const crew = [
  { memberId: "m1", name: "Rae", role: "organizer", band: 1, briefSealed: true },
  { memberId: "m2", name: "Maya", role: "member", band: 2, briefSealed: true },
];
const trip = (over: Record<string, unknown> = {}) => ({
  tripId: "t1", joinCode: "ABC", name: "Spring", status: "DRY_RUN", version: 1, organizerId: "m1", crew,
  candidateCities: [], dateWindows: [{ id: "W1", start: "2027-03-12", end: "2027-03-16" }], negotiation: { watch: 1, running: true }, ...over,
}) as unknown as ClientState["trip"];
const chart = (planId: string, label: "A" | "B", cityName: string) => ({
  planId, label, cityId: planId.slice(0, 3), cityName, hotelName: "Casa", neighborhood: "Alfama", dateWindowId: "W1",
  groupRange: { lowCents: 250_000, highCents: 300_000 }, fitsEveryone: true, publicFlags: [], cityNotes: [], days: [],
}) as never;
const shortlist = [chart("MEX-1", "A", "Mexico City"), chart("LIS-1", "B", "Lisbon")];
const pressed = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("DryRun vote (L1-003)", () => {
  it("the tap holds until the helm answers; a refusal springs back to plan:myVote, an ok shows the echo", async () => {
    const { sent, patch } = await mount(<DryRun />, { trip: trip(), shortlist, myVote: "MEX-1" });
    expect(pressed(/vote a/i)).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /vote b/i }));
    expect(sent.map((s) => [s.ev, s.body])).toEqual([["plan:vote", { planId: "LIS-1" }]]);
    expect(sent[0].ack).toBeTypeOf("function");
    expect(pressed(/vote b/i)).toBe("true"); // optimistic
    act(() => sent[0].ack!({ ok: false, code: "BAD_PHASE", message: "no" }));
    expect(pressed(/vote a/i)).toBe("true"); // sprang back to the helm's record
    expect(pressed(/vote b/i)).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /vote b/i }));
    fireEvent.click(screen.getByRole("button", { name: /vote a/i })); // a newer tap: only its answer counts
    act(() => sent[1].ack!({ ok: true }));
    expect(pressed(/vote a/i)).toBe("true");
    patch({ myVote: "LIS-1" }); // e.g. cast from this member's other phone
    act(() => sent[2].ack!({ ok: true }));
    expect(pressed(/vote b/i)).toBe("true");
  });
});

describe("DryRun chart cards: where the prices come from (docs/12)", () => {
  it("a live chart says \"Live prices\"; an estimated or older one says \"Estimated\"", async () => {
    const live = { ...(chart("MEX-1", "A", "Mexico City") as object), priceSource: "live", priceFeed: "sandbox" } as never;
    const est = { ...(chart("LIS-1", "B", "Lisbon") as object), priceSource: "estimated" } as never;
    await mount(<DryRun />, { trip: trip(), shortlist: [live, est] });
    expect(screen.getAllByText("Live prices")).toHaveLength(1);
    expect(screen.getAllByText("Estimated")).toHaveLength(1);
    cleanup();
    await mount(<DryRun />, { trip: trip(), shortlist }); // no priceSource (an older helm): estimated
    expect(screen.getAllByText("Estimated")).toHaveLength(2);
    expect(screen.queryByText("Live prices")).toBeNull();
  });
});

describe("HeadsetControls (L1-006)", () => {
  const booking = { bookingId: "b1", planId: "LIS-1", attempt: 1, status: "PENDING", mode: "sim", seals: [{ memberId: "m1", status: "PENDING" }, { memberId: "m2", status: "PENDING" }] };
  const sealPrivate = { bookingId: "b1", lines: [{ label: "Stay", amountCents: 10_000, kind: "lodging" }], fits: true, cardLast4: "4242", mode: "sim" };
  const screens: [string, () => ReactElement, Partial<ClientState>][] = [
    ["Table", () => <Table />, { trip: trip({ status: "AT_TABLE" }) }],
    ["Dry Run", () => <DryRun />, { trip: trip(), shortlist }],
    ["Seal", () => <Seal />, { trip: trip({ status: "SEALING" }), shortlist, booking: booking as never, sealPrivate: sealPrivate as never }],
  ];
  for (const [name, ui, state] of screens) {
    it(`${name}: the organizer can reach the headset code; a member can't`, async () => {
      await mount(ui(), state, "m1");
      expect(screen.getByRole("button", { name: /headset code or unpair/i })).toBeTruthy();
      cleanup();
      await mount(ui(), state, "m2");
      expect(screen.queryByRole("button", { name: /headset code or unpair/i })).toBeNull();
    });
  }
});

describe("Brief once the table has met (L1-007)", () => {
  const brief = { capCents: 90_000, dateWindowIds: ["W1"], mustHaves: [], dealbreakers: [], note: "hills", sealedAt: "x" } as never;
  it("open in BRIEFING: editable, with the voice note", async () => {
    await mount(<Brief />, { trip: trip({ status: "BRIEFING" }), brief });
    expect(screen.getByRole("button", { name: /say it instead/i })).toBeTruthy();
    expect(screen.getByRole("slider").getAttribute("aria-disabled")).toBeNull();
    expect((screen.getByRole("button", { name: /reseal my terms/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("locked at the table: dial, chips and note read-only, no voice note, no seal", async () => {
    await mount(<Brief />, { trip: trip({ status: "AT_TABLE" }), brief });
    expect(screen.queryByRole("button", { name: /say it instead/i })).toBeNull();
    expect(screen.getByRole("slider").getAttribute("aria-disabled")).toBe("true");
    const chips = screen.getAllByRole("button").filter((b) => b.classList.contains("chip"));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((c) => (c as HTMLButtonElement).disabled)).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByRole("button", { name: /seal my terms/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/your terms are sealed for this voyage/i)).toBeTruthy();
  });
});

describe("Seal", () => {
  const sealPrivate = { bookingId: "b1", lines: [{ label: "Stay", amountCents: 10_000, kind: "lodging" }], fits: true, cardLast4: "4242", mode: "sim" } as never;
  const booking = (status: string, seals: [string, string][]) =>
    ({ bookingId: "b1", planId: "LIS-1", attempt: 1, status, mode: "sim", seals: seals.map(([memberId, s]) => ({ memberId, status: s })) }) as never;

  it("PASSKEY_REQUIRED shows once, inline, and the banner's copy is cleared; the next tap clears the note", async () => {
    const { store, sent, patch } = await mount(<Seal />, { trip: trip({ status: "SEALING" }), shortlist, booking: booking("PENDING", [["m1", "PENDING"], ["m2", "PENDING"]]), sealPrivate }, "m2");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /set your seal/i })); });
    expect(sent.map((s) => [s.ev, s.body])).toEqual([["seal:set", { bookingId: "b1", assertionToken: undefined }]]);
    const refusal = { code: "PASSKEY_REQUIRED", message: "server words", event: "seal:set" as const };
    patch({ error: refusal });
    act(() => sent[0].ack!({ ok: false, code: "PASSKEY_REQUIRED", message: "server words" }));
    expect(screen.getAllByText(PASSKEY_COPY.required)).toHaveLength(1);
    expect(store.state.error).toBeNull(); // taken from the shell's banner
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /set your seal/i })); });
    expect(screen.queryByText(PASSKEY_COPY.required)).toBeNull();
    expect(sent).toHaveLength(2);
  });

  it("every seal set, no result yet: 'settling' for everyone, and the organizer's call-off is gone", async () => {
    const gathering = { trip: trip({ status: "SEALING" }), shortlist, sealPrivate };
    await mount(<Seal />, { ...gathering, booking: booking("AUTHORIZING", [["m1", "AUTHORIZED"], ["m2", "PENDING"]]) }, "m1");
    expect(screen.getByRole("button", { name: /call it off/i })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/waiting on 1 seal/i);
    cleanup();
    const { patch } = await mount(<Seal />, { ...gathering, booking: booking("AUTHORIZING", [["m1", "AUTHORIZED"], ["m2", "AUTHORIZED"]]) }, "m1");
    expect(screen.getByRole("status").textContent).toMatch(/every seal is set · settling…/i);
    expect(screen.queryByRole("button", { name: /call it off/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /lift my seal/i })).toBeNull(); // nobody else is pending
    patch({ lastResult: { bookingId: "b1", status: "CAPTURED" } });
    expect(screen.getByRole("status").textContent).not.toMatch(/every seal is set/i);
  });
});

describe("Hail dock in Watch 0 (R2-WP-16)", () => {
  it("off while the Captain opens (says why), on from Watch 1, off once the Captain decides", async () => {
    const { patch } = await mount(<Table />, { trip: trip({ status: "AT_TABLE", negotiation: { watch: 0, running: true } }) });
    const input = () => screen.getByRole("textbox", { name: /type a hail/i }) as HTMLInputElement;
    const hold = () => screen.getByRole("button", { name: /hold to hail/i }) as HTMLButtonElement;
    expect(input().disabled).toBe(true);
    expect(hold().disabled).toBe(true);
    expect(screen.getByText(errorCopy({ code: "TABLE_OPENING", message: "" }))).toBeTruthy();
    patch({ trip: trip({ status: "AT_TABLE", negotiation: { watch: 1, running: true } }) });
    expect(input().disabled).toBe(false);
    expect(hold().disabled).toBe(false);
    patch({ turns: [{ turnId: "d", seq: 9, watch: 2, act: "DECIDE", speaker: { kind: "captain" }, text: "Lisbon.", ribbon: "Lisbon" }] as never });
    expect(input().disabled).toBe(true);
    expect(screen.getByText(/captain's calling it/i)).toBeTruthy();
  });
});
