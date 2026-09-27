// The side panel (docs/03 §4): layout + hit testing on a fake canvas, and what each view shows and sends — a shared
// headset never gets a seat's terms or seal; a seat's headset drafts and seals its whole brief, answers "Let this
// headset in?", and seals its share with the PIN keypad.
import { describe, expect, it, vi } from "vitest";
import type { Ack } from "@all-ayes/shared";
import type { ClientState } from "../../net/tripStore";
import { PanelUI, applyKey, hitAt, uvToCanvas, type Ctx2D } from "./PanelUI";
import { briefPayload, canPin, draftFrom, drawPanel, newPanelState, tabsFor, type PanelCtx, type Viewer } from "./views";

/** A canvas context that measures text as 0.55 em a character and draws nothing. */
function fakeCtx(): Ctx2D & { texts: string[] } {
  const texts: string[] = [];
  let size = 30;
  const g = {
    texts, fillStyle: "", strokeStyle: "", lineWidth: 1, textBaseline: "top", textAlign: "left",
    set font(f: string) { size = Number(/(\d+)px/.exec(f)?.[1] ?? 30); }, get font() { return `${size}px x`; },
    measureText: (t: string) => ({ width: t.length * size * 0.55 }),
    fillText: (t: string) => { texts.push(t); },
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {}, save() {}, restore() {}, rect() {}, clip() {},
  };
  return g as unknown as Ctx2D & { texts: string[] };
}

const W = 880, H = 1200;
const crew = [
  { memberId: "rae", name: "Rae", role: "organizer", band: 1, briefSealed: true },
  { memberId: "maya", name: "Maya", role: "member", band: 2, briefSealed: false, onHeadset: true },
];
function state(over: Partial<ClientState> = {}, trip: Record<string, unknown> = {}): ClientState {
  return {
    connected: true, joined: true, role: "member", turns: [], audio: {}, shortlist: [], planPrivate: {}, brief: null, memory: [], dryrun: null,
    votes: {}, autoPick: null, myVote: null, booking: null, sealPrivate: null, declined: null, lastResult: null, error: null, headsetRequest: null,
    trip: {
      tripId: "t1", joinCode: "K7M2QX", name: "Spring Break", status: "BRIEFING", version: 1, organizerId: "rae", crew,
      candidateCities: [{ cityId: "LIS", name: "Lisbon", lat: 38.7, lng: -9.1 }, { cityId: "MEX", name: "Mexico City", lat: 19.4, lng: -99.1 }],
      dateWindows: [{ id: "W1", start: "2027-03-12", end: "2027-03-16", nights: 4 }], negotiation: { watch: 0, running: false },
      destination: { kind: "cities", cityIds: ["LIS", "MEX"], label: "Lisbon and Mexico City", scope: [], portsChosen: true },
      ...trip,
    } as never,
    ...over,
  };
}

function frame(s: ClientState, viewer: Viewer, p = newPanelState(), seal: PanelCtx["seal"] = null) {
  const g = fakeCtx();
  const sent: { ev: string; body: unknown; ack?: (r: Ack) => void }[] = [];
  const ctx: PanelCtx = {
    state: s, viewer, qr: null, host: "allayes.tech", seal, redraw: vi.fn(),
    emit: ((ev: string, body: unknown, ack?: (r: Ack) => void) => { sent.push({ ev, body, ack }); }) as never,
    setSealPin: vi.fn(async () => null),
  };
  // a tall page: these tests are about what each view offers (scrolling is tested on PanelUI)
  const ui = new PanelUI(g, W, 20_000, 76, 20_000, p.scroll);
  drawPanel(ui, p, ctx);
  const click = (id: string) => {
    const h = ui.hits.find((x) => x.id === id);
    if (!h) throw new Error(`no control ${id}: ${ui.hits.map((x) => x.id).join(", ")}`);
    // through the hit test, like a pinch at the control's centre
    hitAt(ui.hits, h.x + h.w / 2, h.y + h.h / 2)!.onClick();
  };
  return { ui, g, sent, click, ids: ui.hits.map((h) => h.id), p, ctx };
}

describe("PanelUI", () => {
  it("wraps text to the panel's width and lays inline buttons out in rows that wrap", () => {
    const ui = new PanelUI(fakeCtx(), W, H);
    expect(ui.wrap("word ".repeat(60).trim(), "body", 30).length).toBeGreaterThan(2);
    for (let i = 0; i < 8; i++) ui.button(`Chip number ${i}`, () => undefined, { inline: true, id: `c${i}` });
    ui.gap(0);
    const ys = new Set(ui.hits.map((h) => h.y));
    expect(ys.size).toBeGreaterThan(1); // wrapped onto more than one row
    for (const h of ui.hits) { expect(h.x + h.w).toBeLessThanOrEqual(W - 36 + 0.01); expect(h.h).toBeGreaterThanOrEqual(72); }
  });
  it("a control off the visible band (scrolled away) can't be hit; disabled ones aren't targets", () => {
    const ui = new PanelUI(fakeCtx(), W, H, 76, H - 96, 400);
    ui.button("gone", () => undefined, { id: "gone" });
    ui.gap(600);
    ui.button("here", () => undefined, { id: "here" });
    ui.button("off", () => undefined, { id: "off", disabled: true });
    expect(ui.hits.map((h) => h.id)).toEqual(["here"]);
  });
  it("maps a ray's uv to canvas px (v up) and keys edit a value", () => {
    expect(uvToCanvas({ x: 0.5, y: 1 }, W, H)).toEqual({ x: 440, y: 0 });
    expect(uvToCanvas({ x: 0, y: 0 }, W, H)).toEqual({ x: 0, y: H });
    expect(applyKey("ab", "c", { max: 5 })).toBe("abc");
    expect(applyKey("ab", "c", { max: 5, shift: true })).toBe("abC");
    expect(applyKey("abc", "⌫", { max: 5 })).toBe("ab");
    expect(applyKey("12", "x", { max: 6, digitsOnly: true })).toBe("12");
    expect(applyKey("123456", "7", { max: 6, digitsOnly: true })).toBe("123456");
  });
});

describe("side panel views", () => {
  it("a shared (code-paired) headset: trip and crew only, never a seat's terms or seal", () => {
    const s = state({}, { status: "SEALING" });
    expect(tabsFor(s, { organizer: true })).toEqual(["trip", "crew"]);
    const f = frame(state({ brief: { capCents: 123_400 } as never }), { organizer: true });
    expect(f.ids).not.toContain("tab:terms");
    expect(f.g.texts.join(" ")).not.toContain("1,234");
  });

  it("the trip tab shows the join code big; the organizer pins, removes ports, lets the crew pin and weighs anchor", () => {
    const f = frame(state(), { memberId: "rae", organizer: true });
    expect(f.g.texts).toContain("K7M2QX");
    f.click("Crew can pin: off");
    expect(f.sent.at(-1)).toEqual({ ev: "course:set", body: { crewPins: true }, ack: undefined });
    // two ports: taking one off would leave one, so it's refused on the panel
    f.click("port:LIS");
    expect(f.sent.some((x) => (x.body as { destination?: unknown }).destination)).toBe(false);
    expect(f.p.note).toMatch(/at least two/);
    // Maya hasn't sealed: Weigh anchor is not a target
    expect(f.ids).not.toContain("Weigh anchor");
    const ready = frame(state({}, { crew: crew.map((c) => ({ ...c, briefSealed: true })) }), { memberId: "rae", organizer: true });
    ready.click("Weigh anchor");
    expect(ready.sent.at(-1)?.ev).toBe("table:start");
    const three = frame(state({}, { candidateCities: [...(state().trip!.candidateCities), { cityId: "YUL", name: "Montréal", lat: 45.5, lng: -73.6 }] }), { memberId: "rae", organizer: true });
    three.click("port:YUL");
    expect(three.sent.at(-1)?.body).toEqual({ destination: { kind: "cities", cityIds: ["LIS", "MEX"] } });
  });

  it("canPin: the organizer, or a member while crewPins is on; briefing only", () => {
    expect(canPin(state(), { memberId: "maya", organizer: false })).toBe(false);
    expect(canPin(state({}, { crewPins: true }), { memberId: "maya", organizer: false })).toBe(true);
    expect(canPin(state({}, { status: "AT_TABLE" }), { memberId: "rae", organizer: true })).toBe(false);
    // a member doesn't get organizer controls
    const f = frame(state(), { memberId: "maya", organizer: false });
    expect(f.ids).not.toContain("Crew can pin: off");
    expect(f.ids).not.toContain("port:LIS");
  });

  it("'Let this headset in?' comes first and answers over the socket", () => {
    const f = frame(state({ headsetRequest: { requestId: "r1", memberName: "Maya", expiresAt: Date.now() + 60_000 } }), { memberId: "maya", organizer: false });
    f.click("Let it in");
    expect(f.sent.at(-1)).toMatchObject({ ev: "headset:approve", body: { requestId: "r1", allow: true } });
    f.click("Not me");
    expect(f.sent.at(-1)).toMatchObject({ ev: "headset:approve", body: { requestId: "r1", allow: false } });
  });

  it("my terms: budget ± and typed, dates, must-haves (capped), a typed note, then Seal my terms sends the brief", () => {
    const p = newPanelState();
    p.tab = "terms";
    const s = state();
    const viewer = { memberId: "maya", organizer: false };
    let f = frame(s, viewer, p);
    expect(f.g.texts).toContain("$900");
    f.click("cap:+250"); f.click("cap:+50");
    expect(p.draft!.cap).toBe(120_000);
    f.click("chip:food"); f.click("chip:beach"); f.click("chip:chill"); f.click("chip:nightlife");
    expect(p.draft!.must.length).toBe(3); // MAX_MUST_HAVES
    // the budget keypad
    f.click("Type it");
    f = frame(s, viewer, p);
    for (const k of ["1", "4", "5", "0"]) f.click(`key:${k}`);
    f.click("key:done");
    expect(p.draft!.cap).toBe(145_000);
    // the note keyboard
    f = frame(s, viewer, p);
    f.click("Write a note");
    f = frame(s, viewer, p);
    f.click("key:shift"); for (const k of ["n", "o", " ", "h", "i", "l", "l", "s"]) f.click(`key:${k}`);
    f.click("key:done");
    expect(p.draft!.note).toBe("No hills");
    f = frame(s, viewer, p);
    f.click("Seal my terms");
    const sent = f.sent.at(-1)!;
    expect(sent.ev).toBe("brief:submit");
    expect(sent.body).toMatchObject({ capCents: 145_000, dateWindowIds: ["W1"], note: "No hills", dealbreakers: [] });
    expect((sent.body as { mustHaves: string[] }).mustHaves).toHaveLength(3);
    sent.ack!({ ok: true });
    expect(p.note).toMatch(/Sealed/);
  });

  it("a date-range voyage: mark days or 'Any of these dates' (briefPayload refuses neither)", () => {
    const s = state({}, { dateWindows: [], dateRange: { start: "2027-03-10", end: "2027-03-14", minNights: 2, maxNights: 3 } });
    const d = draftFrom(s);
    expect(briefPayload(d, true)).toMatch(/Mark the days/);
    const p = newPanelState(); p.tab = "terms";
    const f = frame(s, { memberId: "maya", organizer: false }, p);
    f.click("day:2027-03-11"); f.click("day:2027-03-12");
    expect(briefPayload(p.draft!, true)).toMatchObject({ availability: { days: ["2027-03-11", "2027-03-12"] }, dateWindowIds: [] });
    p.draft!.anyDay = true;
    expect(briefPayload(p.draft!, true)).toMatchObject({ availability: { any: true } });
  });

  it("my seal: the share, then the PIN keypad sends seal:set { pin }; without a PIN or passkey a tap seals", () => {
    const booking = { bookingId: "b1", status: "PENDING", seals: [{ memberId: "maya", status: "PENDING" }, { memberId: "rae", status: "PENDING" }] };
    const sealPrivate = { bookingId: "b1", amountCents: 98_000, lines: [{ label: "Flight", amountCents: 40_000, kind: "flight" }], fits: true, cardLast4: "4242", mode: "sim" };
    const s = state({ booking: booking as never, sealPrivate: sealPrivate as never }, { status: "SEALING" });
    const viewer = { memberId: "maya", organizer: false };
    expect(tabsFor(s, viewer)).toContain("seal");
    const p = newPanelState(); p.tab = "seal";
    let f = frame(s, viewer, p, { pin: true, passkey: false });
    expect(f.g.texts).toContain("$980");
    for (const k of ["4", "8", "2", "1"]) f.click(`key:${k}`);
    f = frame(s, viewer, p, { pin: true, passkey: false });
    f.click("key:done");
    expect(f.sent.at(-1)).toMatchObject({ ev: "seal:set", body: { bookingId: "b1", pin: "4821" } });
    f.sent.at(-1)!.ack!({ ok: false, code: "BAD_PIN", message: "That PIN didn't match. 4 tries left." });
    expect(p.note).toMatch(/4 tries left/);
    const tap = frame(s, viewer, newPanelState(), { pin: false, passkey: false });
    tap.p.tab = "seal";
    const f2 = frame(s, viewer, tap.p, { pin: false, passkey: false });
    f2.click("Set your seal");
    expect(f2.sent.at(-1)).toMatchObject({ ev: "seal:set", body: { bookingId: "b1" } });
  });
});
