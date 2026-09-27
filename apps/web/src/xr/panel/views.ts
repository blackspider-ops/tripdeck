// What the side panel shows (docs/03 §4 "Side panel"): the text-heavy parts of the voyage, beside the chart table
// instead of on it — the trip (join QR and code, the course, pins, organizer controls), the crew, my sealed terms
// (the whole brief, with an in-headset keyboard and keypad), my seal (share, PIN), and "Let this headset in?".
// Pure over the store's state: the panel (SidePanel.ts) calls drawPanel each time something changes.
import {
  BANDS, CAP_MAX_CENTS, CAP_MIN_CENTS, CAP_STEP_CENTS, DEALBREAKERS, MAX_DEALBREAKERS, MAX_MUST_HAVES, MAX_PLACES, MIN_TABLE_CREW,
  NOTE_MAX_CHARS, PALETTE, REGIONS, TAGS, addDays, daysBetween, formatDollars, monthDayLabel, waitingOnTerms,
  type BriefInput, type Dealbreaker, type Region, type Tag,
} from "@all-ayes/shared";
import type { ClientState, TripStore } from "../../net/tripStore";
import { DIGITS, QWERTY, SIZE, applyKey, type PanelUI } from "./PanelUI";

export type Tab = "trip" | "crew" | "terms" | "seal";

/** The terms being drafted in the headset (like the phone Brief's draft). */
export interface Draft {
  cap: number; dates: string[]; anyDay: boolean; days: string[]; must: Tag[]; wont: Dealbreaker[]; note: string;
  loves: string[]; skips: string[];
}

export interface Focus { field: "note" | "cap" | "pin" | "newPin"; value: string; shift?: boolean }

/** The panel's own state (kept across redraws). */
export interface PanelState {
  tab: Tab;
  draft: Draft | null;
  focus: Focus | null;
  scroll: number;
  /** A line under the tabs for a moment (pins, refusals). */
  note: string;
  /** Terms sent, waiting for the sealed echo. */
  sealingTerms: boolean;
  /** "Lift my seal" was tapped once: the next tap lifts (it voids the booking unless set again). */
  liftArmed?: boolean;
}

export const newPanelState = (): PanelState => ({ tab: "trip", draft: null, focus: null, scroll: 0, note: "", sealingTerms: false });

/** Who wears this headset and what it may do. */
export interface Viewer {
  /** A headset seat: this member's own private terms and seal (never on the shared, code-paired headset). */
  memberId?: string;
  organizer: boolean;
}

export interface PanelCtx {
  state: ClientState;
  viewer: Viewer;
  emit: TripStore["emit"];
  /** The join QR, drawn once (null while it loads). */
  qr: CanvasImageSource | null;
  /** Where phones join: `<host>/join`. */
  host: string;
  /** This member's seal credentials (fetched when the Seal tab opens): a PIN on file, a passkey required. */
  seal: { pin: boolean; passkey: boolean } | null;
  setSealPin: (pin: string) => Promise<string | null>;
  /** A lifted seal was set again: forget this headset's "you lifted it" note. */
  clearDeclined?: (bookingId: string) => void;
  redraw: () => void;
}

const money = (cents: number) => formatDollars(cents);
const clampCap = (c: number) => Math.max(CAP_MIN_CENTS, Math.min(CAP_MAX_CENTS, Math.round(c / CAP_STEP_CENTS) * CAP_STEP_CENTS));
const toggle = <T,>(xs: T[], x: T, max = Infinity) => (xs.includes(x) ? xs.filter((y) => y !== x) : xs.length >= max ? xs : [...xs, x]);

/** The draft from the sealed brief on file, or the phone's defaults. */
export function draftFrom(state: ClientState): Draft {
  const b = state.brief;
  const first = state.trip?.dateWindows[0]?.id;
  return {
    cap: b?.capCents ?? 90_000, dates: b?.dateWindowIds?.length ? [...b.dateWindowIds] : first ? [first] : [],
    anyDay: Boolean(b?.availability?.any), days: [...(b?.availability?.days ?? [])],
    must: [...(b?.mustHaves ?? [])], wont: [...(b?.dealbreakers ?? [])], note: b?.note ?? "",
    loves: [...(b?.loves ?? [])], skips: [...(b?.skips ?? [])],
  };
}

/** The brief:submit payload for a draft, or the reason it can't be sealed yet. */
export function briefPayload(d: Draft, dateRange: boolean): BriefInput | string {
  const availability = dateRange ? (d.anyDay ? { any: true as const } : d.days.length ? { days: d.days } : null) : null;
  if (dateRange && !availability) return "Mark the days you can go, or pick \"Any of these dates\".";
  if (!dateRange && !d.dates.length) return "Pick at least one set of dates you can travel.";
  const note = d.note.trim();
  return {
    capCents: d.cap, dateWindowIds: dateRange ? [] : d.dates, ...(availability ? { availability } : {}), mustHaves: d.must, dealbreakers: d.wont,
    note: note || undefined, noteSource: "typed", ...(d.loves.length ? { loves: d.loves } : {}), ...(d.skips.length ? { skips: d.skips } : {}),
  };
}

/** Which tabs this headset has: the terms and the seal are a seat's own (never on a shared headset). */
export function tabsFor(state: ClientState, viewer: Viewer): Tab[] {
  const tabs: Tab[] = ["trip", "crew"];
  if (viewer.memberId) {
    tabs.push("terms");
    const st = state.trip?.status;
    if (st === "SEALING" || st === "BOOKED" || st === "VOIDED") tabs.push("seal");
  }
  return tabs;
}

const TAB_LABEL: Record<Tab, string> = { trip: "Trip", crew: "Crew", terms: "My terms", seal: "My seal" };

/** May this headset pin ports on the globe? The organizer, or anyone while crewPins is on; BRIEFING only. */
export function canPin(state: ClientState, viewer: Viewer): boolean {
  const t = state.trip;
  if (!t || t.status !== "BRIEFING") return false;
  return viewer.organizer || (Boolean(viewer.memberId) && Boolean(t.crewPins));
}

/** The whole panel, top to bottom. */
export function drawPanel(ui: PanelUI, p: PanelState, c: PanelCtx) {
  const s = c.state;
  const trip = s.trip;
  const tabs = tabsFor(s, c.viewer);
  if (!tabs.includes(p.tab)) p.tab = "trip";
  // the one-tap approval comes first, whatever tab is open
  if (s.headsetRequest && c.viewer.memberId) {
    ui.heading("Let this headset in?");
    ui.text(`A headset is asking to sit in your seat (${s.headsetRequest.memberName}). It would see your terms and could set your seal.`);
    ui.button("Let it in", () => c.emit("headset:approve", { requestId: s.headsetRequest!.requestId, allow: true }), { primary: true, inline: true });
    ui.button("Not me", () => c.emit("headset:approve", { requestId: s.headsetRequest!.requestId, allow: false }), { inline: true });
    ui.rule();
  }
  for (const t of tabs) ui.button(TAB_LABEL[t], () => { p.tab = t; p.scroll = 0; p.focus = null; if (t === "terms" && !p.draft) p.draft = draftFrom(s); }, { inline: true, pressed: p.tab === t, id: `tab:${t}` });
  ui.gap(4);
  if (p.note) ui.text(p.note, { size: SIZE.small, color: PALETTE.soundingRed });
  if (!trip) { ui.text(s.connected ? "Finding the voyage…" : "Raising the signal…"); return; }
  if (p.tab === "trip") tripView(ui, p, c);
  else if (p.tab === "crew") crewView(ui, c);
  else if (p.tab === "terms") termsView(ui, p, c);
  else sealView(ui, p, c);
}

function tripView(ui: PanelUI, p: PanelState, c: PanelCtx) {
  const s = c.state, t = s.trip!;
  ui.heading(t.name, SIZE.title);
  ui.small(statusLine(s));
  if (t.status === "BRIEFING" && !t.crewClosed) {
    ui.text("Friends join with their phones: scan, or type the code.");
    ui.image(c.qr, 300);
    ui.big(t.joinCode);
    ui.small(`${c.host}/join · or on a headset: ${c.host}/xr → Join a trip`);
  }
  ui.rule();
  ui.heading("The chart");
  const d = t.destination;
  if (d && d.kind === "regions") ui.text(`Anywhere in ${d.label}`);
  else if (d && d.kind === "anywhere") ui.text("Anywhere on the chart");
  const pins = canPin(s, c.viewer);
  for (const city of t.candidateCities) {
    if (pins && d?.kind !== "regions" && d?.kind !== "anywhere") {
      ui.button(`${city.name}  ×`, () => removePort(c, city.cityId, p), { inline: true, id: `port:${city.cityId}` });
    } else ui.text(city.name);
  }
  ui.gap(0);
  if (pins) {
    ui.small("Pinch the globe to pin a port (pinch a pin to take it off). Drag the globe to spin it. Hold a pinch for the whole region.");
    if (d && d.kind === "regions") {
      for (const r of d.regions ?? []) ui.button(`${r}  ×`, () => setRegions(c, (d.regions ?? []).filter((x) => x !== r), p), { inline: true, id: `region:${r}` });
      ui.gap(0);
    }
    ui.button("Anywhere", () => c.emit("course:set", { destination: { kind: "anywhere" } }), { inline: true, pressed: d?.kind === "anywhere" });
  }
  if (c.viewer.organizer && t.status === "BRIEFING") {
    ui.rule();
    ui.heading("Organizer");
    ui.button(t.crewPins ? "Crew can pin: on" : "Crew can pin: off", () => c.emit("course:set", { crewPins: !t.crewPins }), { pressed: Boolean(t.crewPins) });
    ui.button(t.crewClosed ? "Reopen the crew" : "Close the crew", () => c.emit("crew:setOpen", { open: Boolean(t.crewClosed) }));
    const all = t.crew.every((m) => m.briefSealed), enough = t.crew.length >= MIN_TABLE_CREW;
    ui.button("Weigh anchor", () => c.emit("table:start", {}), { primary: true, disabled: !all || !enough });
    if (!all) ui.small(waitingOnTerms(t.crew.filter((m) => !m.briefSealed).map((m) => m.name)));
    else if (!enough) ui.small("The table needs at least two aboard.");
  }
}

function statusLine(s: ClientState): string {
  const t = s.trip!;
  const n = t.crew.length;
  switch (t.status) {
    case "BRIEFING": return `${n} aboard · ${t.crew.filter((m) => m.briefSealed).length} sealed their terms`;
    case "AT_TABLE": return "The mates are at the table";
    case "DRY_RUN": return "Two charts: the Dry Run";
    case "SEALING": return "Setting seals";
    case "BOOKED": return "Logged in the ship's book";
    case "VOIDED": return "Nobody was charged";
    default: return "";
  }
}

function removePort(c: PanelCtx, cityId: string, p: PanelState) {
  const ids = c.state.trip!.candidateCities.map((x) => x.cityId).filter((x) => x !== cityId);
  if (ids.length < 2) { p.note = "Keep at least two ports on the chart (or pin a region)."; c.redraw(); return; }
  c.emit("course:set", { destination: { kind: "cities", cityIds: ids } });
}
function setRegions(c: PanelCtx, regions: Region[], p: PanelState) {
  if (!regions.length) { p.note = "Keep one region, or choose Anywhere."; c.redraw(); return; }
  c.emit("course:set", { destination: { kind: "regions", regions } });
}

function crewView(ui: PanelUI, c: PanelCtx) {
  const t = c.state.trip!;
  ui.heading(`Crew · ${t.crew.length}`);
  for (const m of t.crew) {
    const note = [m.role === "organizer" ? "organizer" : m.role === "absent" ? "away" : "", m.briefSealed ? "sealed" : "writing terms", m.onHeadset ? "headset" : ""].filter(Boolean).join(" · ");
    ui.swatchRow(BANDS[m.band].hex, m.memberId === c.viewer.memberId ? `${m.name} (you)` : m.name, note);
  }
}

// ---------- my terms ----------
function termsView(ui: PanelUI, p: PanelState, c: PanelCtx) {
  const s = c.state, t = s.trip!;
  const d = (p.draft ??= draftFrom(s));
  const me = t.crew.find((m) => m.memberId === c.viewer.memberId);
  const locked = t.status === "VOIDED" ? !c.viewer.organizer : t.status !== "BRIEFING";
  ui.heading("Your sealed terms");
  ui.small("Only your mate sees this. Not your friends. Not the Captain.");
  if (p.focus && (p.focus.field === "note" || p.focus.field === "cap")) return keyboard(ui, p, c);

  ui.text("All-in, I can do");
  ui.big(money(d.cap));
  if (!locked) {
    for (const [label, delta] of [["−250", -25_000], ["−50", -5_000], ["+50", 5_000], ["+250", 25_000]] as const) {
      ui.button(label, () => { d.cap = clampCap(d.cap + delta); c.redraw(); }, { inline: true, id: `cap:${label}` });
    }
    ui.button("Type it", () => { p.focus = { field: "cap", value: "" }; c.redraw(); }, { inline: true });
  }
  ui.gap(4);

  if (t.dateRange) {
    ui.heading("When can you go?");
    ui.button("Any of these dates", () => { d.anyDay = !d.anyDay; c.redraw(); }, { pressed: d.anyDay, disabled: locked });
    if (!d.anyDay) dayGrid(ui, t.dateRange.start, t.dateRange.end, d.days, (day) => { d.days = toggle(d.days, day).sort(); c.redraw(); }, locked);
  } else {
    ui.heading("I can travel");
    ui.chips(t.dateWindows.map((w) => ({ id: w.id, label: w.label ?? `${monthDayLabel(w.start)}–${monthDayLabel(w.end)}` })), d.dates,
      (id) => { if (!locked) { d.dates = toggle(d.dates, id); c.redraw(); } });
  }
  ui.heading(`Must have (up to ${MAX_MUST_HAVES})`);
  ui.chips(TAGS, d.must, (id) => { if (!locked) { d.must = toggle(d.must, id, MAX_MUST_HAVES); c.redraw(); } }, MAX_MUST_HAVES);
  ui.heading(`Won't do (up to ${MAX_DEALBREAKERS})`);
  ui.chips(DEALBREAKERS, d.wont, (id) => { if (!locked) { d.wont = toggle(d.wont, id, MAX_DEALBREAKERS); c.redraw(); } }, MAX_DEALBREAKERS);
  const scope = t.destination?.scope ?? [];
  if (scope.length) {
    const opts = (t.destination?.kind === "cities" ? scope : scope.slice(0, 12)).map((x) => ({ id: x.cityId, label: x.name }));
    ui.heading(`I'd love (up to ${MAX_PLACES})`);
    ui.chips(opts, d.loves, (id) => { if (!locked) { d.loves = toggle(d.loves, id, MAX_PLACES); d.skips = d.skips.filter((x) => x !== id); c.redraw(); } }, MAX_PLACES);
    ui.heading(`I'd skip (up to ${MAX_PLACES})`);
    ui.chips(opts, d.skips, (id) => { if (!locked) { d.skips = toggle(d.skips, id, MAX_PLACES); d.loves = d.loves.filter((x) => x !== id); c.redraw(); } }, MAX_PLACES);
  }
  ui.heading("Anything else?");
  ui.text(d.note ? `“${d.note}”` : "Nothing yet.", { color: d.note ? PALETTE.ink : PALETTE.inkSoft });
  if (!locked) ui.button(d.note ? "Change the note" : "Write a note", () => { p.focus = { field: "note", value: d.note }; c.redraw(); });
  ui.rule();
  if (locked) {
    ui.small(t.status === "VOIDED" ? "Your terms stay as sealed. The organizer chooses what's next." : "The table has already met; your terms are sealed for this voyage.");
    return;
  }
  ui.button(p.sealingTerms ? "Sealing…" : me?.briefSealed ? "Reseal my terms" : "Seal my terms", () => {
    const body = briefPayload(d, Boolean(t.dateRange));
    if (typeof body === "string") { p.note = body; c.redraw(); return; }
    p.sealingTerms = true; p.note = "";
    c.emit("brief:submit", body, (r) => { p.sealingTerms = false; p.note = r.ok ? "Sealed. Your mate knows what you can do." : r.message; c.redraw(); });
    c.redraw();
  }, { primary: true, disabled: p.sealingTerms });
}

/** The organizer's range as day toggles, a week to a row. */
function dayGrid(ui: PanelUI, start: string, end: string, days: string[], onDay: (d: string) => void, locked: boolean) {
  const n = Math.min(daysBetween(start, end) + 1, 400);
  let month = "";
  for (let i = 0; i < n; i++) {
    const day = addDays(start, i);
    const m = monthDayLabel(day).split(" ")[0];
    if (m !== month) { month = m; ui.small(m); }
    ui.button(String(Number(day.slice(8))), () => onDay(day), { inline: true, pressed: days.includes(day), disabled: locked, w: 84, id: `day:${day}` });
  }
  ui.gap(0);
}

/** The in-headset keyboard: letters for the note, digits for the budget. */
function keyboard(ui: PanelUI, p: PanelState, c: PanelCtx) {
  const f = p.focus!;
  const d = p.draft!;
  const digits = f.field === "cap";
  ui.text(digits ? "Your all-in budget, in dollars" : `Your note (${f.value.length}/${NOTE_MAX_CHARS})`);
  ui.big(digits ? `$${f.value || "…"}` : `${f.value}▏`, digits ? SIZE.big : SIZE.body + 4);
  ui.keys(digits ? DIGITS : QWERTY, (k) => {
    if (k === "done") {
      if (digits) { const v = Number(f.value); if (v) d.cap = clampCap(v * 100); } else d.note = f.value.trim().slice(0, NOTE_MAX_CHARS);
      p.focus = null;
    } else if (k === "shift") f.shift = !f.shift;
    else { f.value = applyKey(f.value, k, { max: digits ? 4 : NOTE_MAX_CHARS, shift: f.shift, digitsOnly: digits }); f.shift = false; }
    c.redraw();
  }, { shift: f.shift ? "SHIFT" : "shift", "⌫": "⌫", done: "Done" });
  ui.button("Cancel", () => { p.focus = null; c.redraw(); });
}

// ---------- my seal ----------
function sealView(ui: PanelUI, p: PanelState, c: PanelCtx) {
  const s = c.state;
  const b = s.booking, mine = s.sealPrivate;
  ui.heading("Your share");
  if (!b || !mine || mine.bookingId !== b.bookingId) { ui.text(s.trip!.status === "BOOKED" ? "Logged. Nobody fronted a cent." : "Unrolling your share…"); return; }
  for (const l of mine.lines) ui.ledger(l.label, money(l.amountCents));
  ui.rule();
  ui.ledger("Your share", money(mine.amountCents), true);
  ui.text(mine.fits ? "Fits your terms ✓" : "Over your terms", { color: mine.fits ? PALETTE.okGreen : PALETTE.soundingRed });
  ui.small(`Visa •••• ${mine.cardLast4} (agent card, capped at your terms)`);
  const seal = b.seals.find((x) => x.memberId === c.viewer.memberId);
  // my own lift is private (publicly it still reads "set", S2-001): say it plainly here, and offer to set it again
  const lifted = s.declined?.bookingId === b.bookingId && s.declined.reason === "user_cancelled";
  const status = lifted ? "PENDING" : seal?.status ?? "PENDING";
  const gathering = b.status === "PENDING" || b.status === "AUTHORIZING";
  if (!gathering) { ui.text(b.status === "CAPTURED" ? "Logged." : "Nobody was charged."); return; }
  const waiting = b.seals.filter((x) => x.status === "PENDING").length;
  if (status !== "PENDING") {
    ui.text(waiting ? `Seal set — waiting on ${waiting} seal${waiting === 1 ? "" : "s"}` : "Every seal is set · settling…");
    if (waiting) {
      ui.gap(40); // secondary, away from the status line
      if (p.liftArmed) {
        ui.small("Lift your seal? If you don't set it again before the timer, nobody is booked.");
        ui.button("Yes, lift my seal", () => { p.liftArmed = false; c.emit("seal:cancel", { bookingId: b.bookingId }); c.redraw(); }, { red: true, inline: true });
        ui.button("Keep it", () => { p.liftArmed = false; c.redraw(); }, { inline: true });
      } else ui.button("Lift my seal", () => { p.liftArmed = true; c.redraw(); }, { red: true, inline: true });
    }
    return;
  }
  if (lifted) {
    if (!waiting) { ui.text("You lifted your seal. Every other seal is in, so the booking is settling: nobody is charged."); return; }
    ui.text("You lifted your seal. If you don't set it again before the timer, nobody is booked.", { color: PALETTE.soundingRed });
  }
  const sealed = (r: { ok: boolean; message?: string }) => { if (r.ok) c.clearDeclined?.(b.bookingId); else p.note = r.message ?? ""; c.redraw(); };
  if (!c.seal) { ui.text("Checking how you seal…"); return; }
  if (c.seal.pin) {
    if (p.focus?.field !== "pin") p.focus = { field: "pin", value: "" };
    ui.text("Enter your seal PIN to set your seal.");
    ui.big("•".repeat(p.focus.value.length) || "····");
    ui.keys(DIGITS, (k) => {
      const f = p.focus!;
      if (k === "done") {
        if (f.value.length < 4) return;
        const pin = f.value; f.value = ""; p.note = "";
        c.emit("seal:set", { bookingId: b.bookingId, pin }, (r) => sealed(r as { ok: boolean; message?: string }));
      } else f.value = applyKey(f.value, k, { max: 6, digitsOnly: true });
      c.redraw();
    }, { done: "Set seal", "⌫": "⌫" });
  } else if (c.seal.passkey) {
    ui.text("Your seal needs the passkey on your phone. Open the voyage there and approve with Face ID.");
  } else {
    ui.button(lifted ? "Set my seal again" : "Set your seal", () => c.emit("seal:set", { bookingId: b.bookingId }, (r) => sealed(r as { ok: boolean; message?: string })), { primary: true });
    ui.small("This headset can't hold a passkey. Set a seal PIN to approve here with digits:");
    ui.button("Set a seal PIN", () => { p.focus = { field: "newPin", value: "" }; c.redraw(); });
  }
  if (p.focus?.field === "newPin") {
    ui.text("Choose 4 to 6 digits");
    ui.big("•".repeat(p.focus.value.length) || "····");
    ui.keys(DIGITS, (k) => {
      const f = p.focus!;
      if (k === "done") {
        if (f.value.length < 4) return;
        void c.setSealPin(f.value).then((err) => { p.note = err ?? "Seal PIN set."; p.focus = null; c.redraw(); });
      } else f.value = applyKey(f.value, k, { max: 6, digitsOnly: true });
      c.redraw();
    }, { done: "Save PIN" });
  }
}

/** Regions a lat/lng pin can stand for (the region model: REGIONS). */
export const PIN_REGIONS: readonly Region[] = REGIONS;
