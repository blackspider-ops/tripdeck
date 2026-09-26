/**
 * Deterministic plan builder (docs/05-agent-spec.md §2, docs/07-dataset-spec.md).
 * LLMs never compute money: every price, share, fit and flag comes from here.
 */
import type {
  ActivityOption, BriefInput, CityId, Dataset, Dealbreaker, DateWindow, FitReason, FlightOption, HotelOption, MemberPlanView, Origin,
  MyDay, MyScheduleItem, Plan, PlanDay, PlanFlag, PlanPrivate, PlanPublic, PublicDay, PublicScheduleItem, Role, ScheduleItem,
  ShareLine, Tag,
} from "@all-ayes/shared";
import { EARLY_START_BEFORE, MAX_MUST_HAVES, ORIGINS, TAGS, clockToMin, dayLabel, formatDollars } from "@all-ayes/shared";
import { travel, type Point } from "../dryrun/walking.js";
import { compareFairness, fairness, satisfaction } from "./fairness.js";
import { flightsFor, publicFlights } from "./flights.js";
import { cityName, datasetRev, indexOf, mustFind } from "../data/loader.js";

export interface PricingMember {
  memberId: string;
  name: string;
  role: Role;
  origin: Origin;
  brief: BriefInput;
}

const BUFFER_MIN = 30;
const DAY2_FREE_FROM = 7 * 60;

// ---------- helpers ----------
const minOf = (local: string) => clockToMin(local.split("T")[1]);
const dateOf = (local: string) => local.split("T")[0];
const roundUp30 = (m: number) => Math.ceil(m / 30) * 30;
const overlaps = (s1: number, e1: number, s2: number, e2: number, buf = BUFFER_MIN) => s1 < e2 + buf && s2 < e1 + buf;
/** OPT-060: "starts before 8am" is the shared EARLY_START_BEFORE, not a literal. */
const EARLY_START_MIN = clockToMin(EARLY_START_BEFORE);
const EVENING_MIN = 18 * 60;
/** Someone with no flight is assumed free from 9am on day 1. */
const NO_FLIGHT_FREE_FROM = 9 * 60;
/**
 * The "evening from the stay" rule (doc 07 §7): after a gap of over an hour before an evening moment, or over three
 * hours at any time, a leg starts from the stay rather than from the previous place.
 */
const legFromStay = (gapMin: number, startMin: number) => (gapMin > 60 && startMin >= EVENING_MIN) || gapMin > 180;

/** Windows everyone can do; if none, the ones the most members can do. */
function usableWindows(ds: Dataset, crew: PricingMember[]): string[] {
  const counts = ds.dateWindows.map((w) => ({ id: w.id, n: crew.filter((m) => m.brief.dateWindowIds.includes(w.id)).length }));
  const best = Math.max(...counts.map((c) => c.n));
  return counts.filter((c) => c.n === best && c.n > 0).map((c) => c.id);
}

type FlightChoice = { flight: FlightOption | null; violates: FitReason[] };

/** Cheapest flight that breaks none of the member's dealbreakers. */
export function chooseFlight(ds: Dataset, m: PricingMember, cityId: CityId, windowId: string): FlightChoice {
  // curated listings where they exist, else the flight model's options (fit/flights.ts); a home port is one $0 option
  const all = [...flightsFor(ds, cityId, m.origin, windowId)].sort((a, b) => a.priceCents - b.priceCents);
  if (!all.length) return { flight: null, violates: ["no_flight"] };
  const bad = (f: FlightOption): FitReason[] => {
    const v: FitReason[] = [];
    if (m.brief.dealbreakers.includes("red_eye") && f.redEye) v.push("dealbreaker:red_eye");
    if (m.brief.dealbreakers.includes("layovers_2plus") && f.stops >= 2) v.push("dealbreaker:layovers_2plus");
    if (m.brief.dealbreakers.includes("early_start") && minOf(f.departLocal) < EARLY_START_MIN) v.push("dealbreaker:early_start");
    return v;
  };
  const ok = all.find((f) => bad(f).length === 0);
  if (ok) return { flight: ok, violates: [] };
  return { flight: all[0], violates: bad(all[0]) };
}

/** Picks per member: for each must-have not yet covered by this member's picks, the first matching pick. */
export function choosePicks(ds: Dataset, cityId: CityId, m: PricingMember): ActivityOption[] {
  const picks: ActivityOption[] = [];
  const candidates = indexOf(ds).activitiesOf(cityId).filter((a) => a.role === "pick");
  for (const tag of m.brief.mustHaves) {
    if (picks.some((p) => p.tags.includes(tag))) continue;
    const a = candidates.find(
      (c) => c.tags.includes(tag) && !(c.earlyStart && m.brief.dealbreakers.includes("early_start")) && !picks.includes(c),
    );
    if (a) picks.push(a);
    if (picks.length >= 2) break;
  }
  return picks;
}

// ---------- the builder, step by step (OPT-032) ----------
type Placed = { a: ActivityOption; day: number; start: number; end: number; attendees: string[] };
type Arrivals = NonNullable<PlanDay["arrivals"]>;

/** Step 1: each member's flight. */
function chooseFlights(ds: Dataset, crew: PricingMember[], cityId: CityId, windowId: string): Map<string, FlightChoice> {
  return new Map(crew.map((m) => [m.memberId, chooseFlight(ds, m, cityId, windowId)] as const));
}

/** Whole days from one ISO date to another ("2028-03-10" → "2028-03-15" is 5). */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/**
 * How many days the schedule shows from day 1 (`startDate`) through the window's last day (the flight home), at
 * least 2; and the last day anything may be placed on (the day before the flight home, at least day 2).
 */
function dayCounts(startDate: string, win: DateWindow): { shown: number; placeable: number } {
  const shown = Math.max(2, daysBetween(startDate, win.end) + 1);
  return { shown, placeable: Math.max(2, shown - 1) };
}

/**
 * Step 2: day 1 is the latest arrival date among members (the window's start if nobody flies). Each member is free
 * from landing + 60 min, rounded up to :00/:30 (never before 7am); someone landing a day early counts as landing at 7.
 */
function arrivalsFor(crew: PricingMember[], flights: Map<string, FlightChoice>, win: DateWindow):
  { day1Date: string; freeFrom: Map<string, number>; arrivals: Arrivals } {
  // a home port (no flight) is free from 9am like someone without a flight, and never sets day 1
  const flightOf = (id: string) => { const f = flights.get(id)?.flight ?? null; return f && !f.homePort ? f : null; };
  const arrivalDates = crew.map((m) => flightOf(m.memberId)?.arriveLocal).filter((x): x is string => Boolean(x));
  const day1Date = arrivalDates.map(dateOf).sort().at(-1) ?? win.start;
  const freeFrom = new Map<string, number>();
  const arrivals: Arrivals = [];
  for (const m of crew) {
    const f = flightOf(m.memberId);
    if (!f) { freeFrom.set(m.memberId, NO_FLIGHT_FREE_FROM); continue; }
    const land = dateOf(f.arriveLocal) < day1Date ? DAY2_FREE_FROM : minOf(f.arriveLocal);
    freeFrom.set(m.memberId, Math.max(roundUp30(land + 60), DAY2_FREE_FROM));
    arrivals.push({ memberId: m.memberId, landMin: land, atStayMin: land + 45 });
  }
  return { day1Date, freeFrom, arrivals };
}

/**
 * Step 3: the city's (first two) group moments on day 1 — daytime at startLatest (leaves the morning for picks),
 * evening at startEarliest. A group moment is for the whole crew, so on day 1 it never starts before the last of
 * them is free (`crewFrom`: the latest landing + 60 min): one the default time would start too early moves later
 * within its listed hours, else to day 2 at its usual time. Without `crewFrom` (the public, crew-independent
 * layout) they keep the listed times.
 */
function placeGroupMoments(ds: Dataset, cityId: CityId, crew: PricingMember[], crewFrom = 0): Placed[] {
  const everyone = crew.map((c) => c.memberId);
  const placed: Placed[] = [];
  for (const a of indexOf(ds).activitiesOf(cityId).filter((x) => x.role === "group").slice(0, 2)) {
    const early = clockToMin(a.startEarliest);
    const usual = early >= EVENING_MIN ? early : clockToMin(a.startLatest);
    const free = (day: number, t: number) => !placed.some((p) => p.day === day && overlaps(t, t + a.durationMin, p.start, p.end));
    let day = 1;
    let start: number | null = usual >= crewFrom && free(1, usual) ? usual : null;
    for (let t = roundUp30(Math.max(early, crewFrom, usual)); start === null && t <= clockToMin(a.startLatest); t += 30) if (free(1, t)) start = t;
    if (start === null) { day = 2; start = usual; }
    placed.push({ a, day, start, end: start + a.durationMin, attendees: [...everyone] });
  }
  return placed;
}

/**
 * Step 4: each member's picks (shared when several members pick the same activity), placed in order at the first
 * half hour on day 1 that clashes with nothing its attendees already have, else on day 2 (else at its earliest).
 * Returns every placed moment: the group moments first, then the picks.
 */
function placePicks(ds: Dataset, cityId: CityId, crew: PricingMember[], freeFrom: Map<string, number>, groups: Placed[], lastDay: number): Placed[] {
  const pickAttendees = new Map<string, { a: ActivityOption; attendees: string[] }>();
  for (const m of crew) {
    for (const p of choosePicks(ds, cityId, m)) {
      const e = pickAttendees.get(p._id) ?? { a: p, attendees: [] };
      e.attendees.push(m.memberId);
      pickAttendees.set(p._id, e);
    }
  }
  return placeInOrder([...pickAttendees.values()], (attendees) => Math.max(...attendees.map((id) => freeFrom.get(id) ?? DAY2_FREE_FROM)), groups, lastDay);
}

/**
 * Step 4's placement rule, shared with the public layout: the first free half hour on day 1 from `day1From`, else
 * on day 2, … up to `lastDay` (else day 2 at its earliest).
 */
function placeInOrder(entries: { a: ActivityOption; attendees: string[] }[], day1From: (attendees: string[]) => number, groups: Placed[], lastDay = 2): Placed[] {
  const placed = [...groups];
  for (const { a, attendees } of entries) {
    const tryDay = (day: number): number | null => {
      const from = day === 1 ? day1From(attendees) : DAY2_FREE_FROM;
      const latest = clockToMin(a.startLatest);
      for (let t = roundUp30(Math.max(clockToMin(a.startEarliest), from)); t <= latest; t += 30) {
        const end = t + a.durationMin;
        const clash = placed.some((p) => p.day === day && p.attendees.some((x) => attendees.includes(x)) && overlaps(t, end, p.start, p.end));
        if (!clash) return t;
      }
      return null;
    };
    let day = 1;
    let start = tryDay(1);
    while (start === null && day < lastDay) start = tryDay(++day);
    if (start === null) { day = 2; start = clockToMin(a.startEarliest); }
    placed.push({ a, day, start, end: start + a.durationMin, attendees });
  }
  return placed;
}

/** Step 5: the days' schedules with every attendee's travel leg (doc 07 §7), and each member's long-walk / early-start flags. */
function legsAndFlags(ds: Dataset, crew: PricingMember[], placed: Placed[], hotelPt: Point, day1Date: string, arrivals: Arrivals, shownDays: number):
  { days: PlanDay[]; memberFlags: Map<string, PlanFlag[]> } {
  const days: PlanDay[] = [];
  const memberFlags = new Map<string, PlanFlag[]>(crew.map((m) => [m.memberId, []]));
  // every day of the stay, free days included (day 1 → the flight home)
  const maxDay = Math.max(shownDays, ...placed.map((p) => p.day));
  for (let d = 1; d <= maxDay; d++) {
    const items: ScheduleItem[] = placed.filter((p) => p.day === d).sort((x, y) => x.start - y.start).map((p) => ({
      activityId: p.a._id, name: p.a.short, startMin: p.start, endMin: p.end, attendees: p.attendees,
      lat: p.a.lat, lng: p.a.lng, travel: {},
    }));
    for (const m of crew) {
      const flags = memberFlags.get(m.memberId) ?? [];
      let prev: ScheduleItem | null = null;
      for (const it of items) {
        if (!it.attendees.includes(m.memberId)) continue;
        const from: Point = !prev || legFromStay(it.startMin - prev.endMin, it.startMin) ? hotelPt : { id: prev.activityId, lat: prev.lat, lng: prev.lng };
        const leg = travel(ds, from, { id: it.activityId, lat: it.lat, lng: it.lng });
        it.travel[m.memberId] = leg;
        if (leg.flagged) flags.push({ memberId: m.memberId, type: "long_walk", detail: `${leg.minutes} min walk to ${it.name}, day ${d}` });
        if (it.startMin < EARLY_START_MIN) flags.push({ memberId: m.memberId, type: "early_start", detail: `${it.name} starts before 8am` });
        prev = it;
      }
    }
    days.push({ day: d, label: labelFor(day1Date, d - 1), items, ...(d === 1 ? { arrivals } : {}) });
  }
  return { days, memberFlags };
}

/**
 * Rooms (or units) of one stay a crew needs: ceil(crew / sleeps). A crew that fits in one (every crew of ≤3, and ≤4 in
 * an apartment) books one, exactly as before; a crew of 9 in a 3-bed hotel books three of the same stay. The count is
 * public (crew size and the listing are), never who sleeps where.
 */
export function roomsFor(hotel: Pick<HotelOption, "sleeps">, crewSize: number): number {
  return Math.max(1, Math.ceil(Math.max(1, crewSize) / Math.max(1, hotel.sleeps)));
}

/** The whole crew's lodging bill for a stay: rooms × nightly × nights. */
export function lodgingTotalCents(hotel: Pick<HotelOption, "sleeps" | "nightlyCents">, crewSize: number, nights: number): number {
  return hotel.nightlyCents * nights * roomsFor(hotel, crewSize);
}

/**
 * The fair lodging split: everyone pays floor(total / crew), the organizer also carries the few-cent remainder, so the
 * shares sum to the bill exactly. Same rule for one room or several (rooms only change the total).
 */
export function lodgingShares(totalCents: number, memberIds: string[], organizerId: string): Map<string, number> {
  const n = Math.max(1, memberIds.length);
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  return new Map(memberIds.map((id) => [id, base + (id === organizerId ? remainder : 0)]));
}

/** "Casa Alfama" for one room, "Casa Alfama ×3" for three. */
export const stayName = (hotel: Pick<HotelOption, "name">, rooms: number) => (rooms > 1 ? `${hotel.name} ×${rooms}` : hotel.name);

/** Step 6: one member's share lines, fit, coverage, flags and satisfaction. The organizer carries the lodging remainder. */
function memberView(
  m: PricingMember,
  ctx: { cityId: CityId; airport: string; windowId: string; hotel: HotelOption; nights: number; crewSize: number; rooms: number; lodgingShare: number; flight: FlightChoice; placed: Placed[]; flags: PlanFlag[] },
): MemberPlanView {
  const { airport, windowId, hotel, nights, crewSize, rooms } = ctx;
  const { flight, violates } = ctx.flight;
  const fraction = crewSize === 1 ? "" : ` ${["", "", "½", "⅓", "¼"][crewSize] ?? `1/${crewSize}`}`;

  const lines: ShareLine[] = [];
  // a home port has no flight line (nothing to pay); the label names the port's airport (NYC → JFK)
  if (flight && !flight.homePort) lines.push({ kind: "flight", label: `Flight ${m.origin}⇄${airport}`, amountCents: flight.priceCents });
  lines.push({ kind: "lodging", label: `${stayName(hotel, rooms)}${rooms > 1 ? "," : ""}${fraction} ×${nights}n`, amountCents: ctx.lodgingShare });
  const attended = ctx.placed.filter((p) => p.attendees.includes(m.memberId)).sort((x, y) => x.day - y.day || x.start - y.start);
  for (const p of attended) lines.push({ kind: "activity", label: p.a.short, amountCents: p.a.priceCents });
  const amountCents = lines.reduce((s, l) => s + l.amountCents, 0);

  const tags = new Set<Tag>(attended.flatMap((p) => p.a.tags));
  const covered = m.brief.mustHaves.filter((t) => tags.has(t));
  const missing = m.brief.mustHaves.filter((t) => !tags.has(t));
  const flags = [...ctx.flags];
  if (flight?.redEye) flags.push({ memberId: m.memberId, type: "red_eye", detail: "overnight flight" });
  const flagTypes = new Set(flags.map((f) => f.type));

  const reasons: FitReason[] = [...violates];
  if (!m.brief.dateWindowIds.includes(windowId)) reasons.push("date_mismatch");
  if (amountCents > m.brief.capCents) reasons.push("over_cap");
  if (hotel.stayType === "hostel" && m.brief.dealbreakers.includes("hostel")) reasons.push("dealbreaker:hostel");
  if (m.brief.dealbreakers.includes("long_walks") && flagTypes.has("long_walk")) reasons.push("dealbreaker:long_walks");
  if (m.brief.dealbreakers.includes("early_start") && flagTypes.has("early_start")) reasons.push("dealbreaker:early_start");
  const fits = reasons.length === 0;
  const coverage = m.brief.mustHaves.length ? covered.length / m.brief.mustHaves.length : 1;
  return {
    memberId: m.memberId, flightId: flight?._id ?? "", amountCents, lines, fits, reasons: fits ? ["ok"] : reasons,
    covered, missing, flags,
    satisfaction: satisfaction({ fits, coverage, capCents: m.brief.capCents, shareCents: amountCents, flagCount: flagTypes.size, hotelRating: hotel.rating }),
  };
}

/** Step 7: flags every member shares are public (e.g. everyone's flight is overnight), without the day. */
function sharedPublicFlags(members: MemberPlanView[]): PlanFlag[] {
  const out: PlanFlag[] = [];
  if (!members.length) return out;
  for (const type of ["red_eye", "long_walk", "early_start"] as const) {
    const first = members[0].flags.find((f) => f.type === type);
    if (first && members.every((mm) => mm.flags.some((f) => f.type === type))) out.push({ type, detail: first.detail.replace(/, day \d+$/, "") });
  }
  return out;
}

export function buildPlan(ds: Dataset, crew: PricingMember[], cityId: CityId, windowId: string, hotel: HotelOption): Plan {
  const win = mustFind(indexOf(ds).window.get(windowId), "date window", windowId);
  const organizerId = crew.find((c) => c.role === "organizer")?.memberId ?? crew[0].memberId;
  const hotelPt: Point = { id: hotel._id, lat: hotel.lat, lng: hotel.lng };

  const flights = chooseFlights(ds, crew, cityId, windowId);
  const { day1Date, freeFrom, arrivals } = arrivalsFor(crew, flights, win);
  const { shown, placeable } = dayCounts(day1Date, win);
  // the crew is together from the last one's landing (+ an hour): group moments on day 1 never start before
  const crewFrom = Math.max(0, ...freeFrom.values());
  const placed = placePicks(ds, cityId, crew, freeFrom, placeGroupMoments(ds, cityId, crew, crewFrom), placeable);
  const { days, memberFlags } = legsAndFlags(ds, crew, placed, hotelPt, day1Date, arrivals, shown);
  const airport = indexOf(ds).city.get(cityId)?.airport?.code ?? cityId;
  const rooms = roomsFor(hotel, crew.length);
  const shares = lodgingShares(lodgingTotalCents(hotel, crew.length, win.nights), crew.map((m) => m.memberId), organizerId);
  const members = crew.map((m) => memberView(m, {
    cityId, airport, windowId, hotel, nights: win.nights, crewSize: crew.length, rooms, lodgingShare: shares.get(m.memberId) ?? 0,
    flight: flights.get(m.memberId) ?? { flight: null, violates: ["no_flight"] }, placed, flags: memberFlags.get(m.memberId) ?? [],
  }));

  return {
    _id: `${cityId}-${windowId}-${hotelSlug(hotel._id)}`,
    cityId, dateWindowId: windowId, hotelId: hotel._id, days,
    groupCents: members.reduce((s, mm) => s + mm.amountCents, 0),
    members,
    fairness: fairness(members.map((mm) => mm.satisfaction)),
    fitsEveryone: members.every((mm) => mm.fits),
    publicFlags: sharedPublicFlags(members),
  };
}

/** O2-033: dataset hotel ids are `<city>-h-<slug>`; a plan id keeps the slug (`LIS-W1-casa-alfama`). */
const hotelSlug = (hotelId: string) => hotelId.split("-h-")[1];

/** O2-043: one cached formatter (shared format.ts), not a new one per day label. */
const labelFor = (startDate: string, offset: number): string => dayLabel(startDate, offset);

/**
 * All candidate plans, best first (the "chart book"). Every stay is a candidate: a crew larger than a stay sleeps books
 * several rooms/units of it (roomsFor), and the dearer bill simply scores lower.
 */
export function buildChartBook(ds: Dataset, crew: PricingMember[], cityIds: CityId[], limit = 12): Plan[] {
  const noHostel = crew.some((m) => m.brief.dealbreakers.includes("hostel"));
  const plans: Plan[] = [];
  for (const windowId of usableWindows(ds, crew)) {
    for (const cityId of cityIds) {
      for (const h of indexOf(ds).hotelsOf(cityId)) {
        if (noHostel && h.stayType === "hostel") continue;
        plans.push(buildPlan(ds, crew, cityId, windowId, h));
      }
    }
  }
  return plans.sort((a, b) => compareFairness(a.fairness, b.fairness)).slice(0, limit);
}

// ---------- views (privacy boundary) ----------
/**
 * The public total's range is widened to the next point of a $50 grid offset by $25 ($1,375, $1,425, …): budget caps
 * sit on the $50 grid (CAP_STEP_CENTS), so a public bound can never read as anyone's cap.
 */
const PUBLIC_RANGE_STEP_CENTS = 5_000;
const PUBLIC_RANGE_OFFSET_CENTS = 2_500;
/** The dealbreakers that change which flight or picks the builder chooses (the others only change fit). */
const CHOICE_DEALBREAKERS: Dealbreaker[] = ["red_eye", "layovers_2plus", "early_start"];

/**
 * Every (flight + picks) a member of this crew could have in this city and window, from public facts only: any
 * origin, any flight-relevant dealbreakers, any ordered must-haves. The flight depends only on (origin, dealbreakers)
 * and the picks only on (dealbreakers, must-haves), so the set is built per dealbreaker mask as flights × picks
 * (the same set as trying every origin × must-have order, at a fraction of the work with ~40 home airports).
 * Cached per dataset (revision).
 */
const optionCache = new WeakMap<Dataset, { rev: number; byKey: Map<string, { cents: number; picks: string[] }[]> }>();
let mustHaveOrders: Tag[][] | null = null;
function allMustHaveOrders(): Tag[][] {
  if (mustHaveOrders) return mustHaveOrders;
  const tags = TAGS.map((t) => t.id);
  const orders: Tag[][] = [[]];
  for (let len = 1; len <= MAX_MUST_HAVES; len++) {
    for (const prefix of orders.filter((o) => o.length === len - 1)) for (const t of tags) if (!prefix.includes(t)) orders.push([...prefix, t]);
  }
  return (mustHaveOrders = orders);
}
function publicMemberOptions(ds: Dataset, cityId: CityId, windowId: string): { cents: number; picks: string[] }[] {
  let c = optionCache.get(ds);
  if (!c || c.rev !== datasetRev(ds)) optionCache.set(ds, (c = { rev: datasetRev(ds), byKey: new Map() }));
  const key = `${cityId}|${windowId}`;
  const hit = c.byKey.get(key);
  if (hit) return hit;
  const seen = new Map<string, { cents: number; picks: string[] }>();
  const member = (origin: string, dealbreakers: Dealbreaker[], mustHaves: Tag[]): PricingMember =>
    ({ memberId: "", name: "", role: "member", origin, brief: { capCents: 0, dateWindowIds: [windowId], mustHaves, dealbreakers } });
  for (let mask = 0; mask < 1 << CHOICE_DEALBREAKERS.length; mask++) {
    const dealbreakers = CHOICE_DEALBREAKERS.filter((_, i) => mask & (1 << i));
    const flightCents = new Set<number>();
    for (const origin of ORIGINS) flightCents.add(chooseFlight(ds, member(origin, dealbreakers, []), cityId, windowId).flight?.priceCents ?? 0);
    const pickSets = new Map<string, ActivityOption[]>();
    for (const mustHaves of allMustHaveOrders()) {
      const picks = choosePicks(ds, cityId, member("", dealbreakers, mustHaves));
      pickSets.set(picks.map((x) => x._id).join(","), picks);
    }
    for (const fc of flightCents) for (const picks of pickSets.values()) {
      const o = { cents: fc + picks.reduce((s, x) => s + x.priceCents, 0), picks: picks.map((x) => x._id) };
      seen.set(`${o.cents}|${[...o.picks].sort().join(",")}`, o);
    }
  }
  const out = [...seen.values()];
  c.byKey.set(key, out);
  return out;
}

/**
 * S2-002: the group total anyone may see is a range computed from public facts only — the city, window, stay,
 * crew size and the set of picks on the public schedule — never from the crew's actual choices: the lowest and
 * highest total any crew of this size could have for this public plan. The exact total is the sum of the private
 * shares, and even rounded it pins them together (a two-person crew rounded to $100 was still exact), so it never
 * leaves the helm; each member sees their own exact share in plan:private.
 */
export function publicTotalRange(ds: Dataset, p: Plan): { lowCents: number; highCents: number } {
  const ix = indexOf(ds);
  const win = mustFind(ix.window.get(p.dateWindowId), "date window", p.dateWindowId);
  const hotel = mustFind(ix.hotel.get(p.hotelId), "hotel", p.hotelId);
  const n = p.members.length;
  const groupEach = placeGroupMoments(ds, p.cityId, []).reduce((s, g) => s + g.a.priceCents, 0);
  const pickIds = [...new Set(p.days.flatMap((d) => d.items).map((it) => it.activityId).filter((id) => ix.activity.get(id)?.role === "pick"))];
  const bit = (id: string) => 1 << pickIds.indexOf(id);
  // per set of picks, only the cheapest and dearest option matter to the range (min/max of sums)
  const byMask = new Map<number, [number, number]>();
  for (const o of publicMemberOptions(ds, p.cityId, p.dateWindowId)) {
    if (!o.picks.every((x) => pickIds.includes(x))) continue;
    const m = o.picks.reduce((s, x) => s | bit(x), 0);
    const c = byMask.get(m);
    byMask.set(m, c ? [Math.min(c[0], o.cents), Math.max(c[1], o.cents)] : [o.cents, o.cents]);
  }
  // over the members: for each set of picks covered so far, the lowest and highest running total
  let reach = new Map<number, [number, number]>([[0, [0, 0]]]);
  for (let i = 0; i < n; i++) {
    const next = new Map<number, [number, number]>();
    for (const [mask, [lo, hi]] of reach) for (const [om, [olo, ohi]] of byMask) {
      const k = mask | om;
      const c = next.get(k);
      next.set(k, c ? [Math.min(c[0], lo + olo), Math.max(c[1], hi + ohi)] : [lo + olo, hi + ohi]);
    }
    reach = next;
  }
  const [lo, hi] = reach.get((1 << pickIds.length) - 1) ?? [0, 0];
  const fixed = lodgingTotalCents(hotel, n, win.nights) + n * groupEach;
  const step = PUBLIC_RANGE_STEP_CENTS, off = PUBLIC_RANGE_OFFSET_CENTS;
  return {
    lowCents: Math.floor((fixed + lo - off) / step) * step + off,
    highCents: Math.ceil((fixed + hi - off) / step) * step + off,
  };
}

/** "$2,650 to $3,100" — the public group total as it may be said aloud or shown. */
export function publicTotalLabel(r: { lowCents: number; highCents: number }): string {
  return r.lowCents === r.highCents ? formatDollars(r.lowCents) : `${formatDollars(r.lowCents)} to ${formatDollars(r.highCents)}`;
}

/** The public layout lays picks out from this hour on day 1 — a fixed hour, never anyone's landing time. */
const PUBLIC_PICKS_FROM = NO_FLIGHT_FREE_FROM;
const PUBLIC_SLOT = "crew";

/**
 * Public schedule (SEC-001 / TR2-015 / S2-002): the plan's moments and places, never who attends, nobody's legs,
 * nobody's arrival — and no time that depends on anyone. The real pick times follow the attendees' landing times
 * (and a pick's day follows who shares it), so re-running the open-source builder against them narrowed every
 * share. Here the group moments keep their listed times (the crew's real ones wait for its latest landing, which is
 * crew-dependent, so only plan:private carries them) and the picks are laid out afresh from public facts only:
 * in dataset order, one after another from a fixed hour, as if one party did them all. Labels are "Day 1", "Day 2"
 * (the real day 1 is the latest landing date). Legs are crew-independent (stay / group moment → here), so the
 * Gallery and headset can draw group routes. Each member's real times are in plan:private.
 */
function publicDays(ds: Dataset, p: Plan): PublicDay[] {
  const ix = indexOf(ds);
  const h = mustFind(ix.hotel.get(p.hotelId), "hotel", p.hotelId);
  const stay: Point = { id: h._id, lat: h.lat, lng: h.lng };
  const pickIds = new Set(p.days.flatMap((d) => d.items).map((it) => it.activityId).filter((id) => ix.activity.get(id)?.role === "pick"));
  const groups = placeGroupMoments(ds, p.cityId, []).map((g) => ({ ...g, attendees: [PUBLIC_SLOT] }));
  const picks = ix.activitiesOf(p.cityId).filter((a) => pickIds.has(a._id)).map((a) => ({ a, attendees: [PUBLIC_SLOT] }));
  const placed = placeInOrder(picks, () => PUBLIC_PICKS_FROM, groups);
  const maxDay = Math.max(1, ...placed.map((x) => x.day));
  const days: PublicDay[] = [];
  for (let d = 1; d <= maxDay; d++) {
    let prevGroup: PublicScheduleItem | null = null;
    const items = placed.filter((x) => x.day === d).sort((x, y) => x.start - y.start).map(({ a, start, end }): PublicScheduleItem => {
      const kind = a.role === "group" ? "group" : "pick";
      const to: Point = { id: a._id, lat: a.lat, lng: a.lng };
      let from = stay;
      if (prevGroup) { // picks right after a group moment start from there (same "evening from the stay" rule)
        if (!legFromStay(start - prevGroup.endMin, start)) from = { id: prevGroup.activityId, lat: prevGroup.lat, lng: prevGroup.lng };
      }
      const out: PublicScheduleItem = { activityId: a._id, name: a.short, startMin: start, endMin: end, lat: a.lat, lng: a.lng, kind, leg: travel(ds, from, to) };
      if (kind === "group") prevGroup = out;
      return out;
    });
    days.push({ day: d, label: `Day ${d}`, items });
  }
  return days;
}

/**
 * S2-002: the flags anyone may see, from public facts only. "Everyone has a long walk" read off the members' own
 * legs said who walks from the stay and who from a pick; these say what the group route and the listings say:
 * a long walk on a group leg, a group moment before 8am, a city whose every flight this window is overnight.
 */
function publicPlanFlags(ds: Dataset, p: Plan, days: PublicDay[]): PlanFlag[] {
  const out: PlanFlag[] = [];
  // every flight any home airport has to this port this window (a home port isn't a flight)
  const flights = publicFlights(ds, p.cityId, p.dateWindowId).filter((f) => !f.homePort);
  if (flights.length && flights.every((f) => f.redEye)) out.push({ type: "red_eye", detail: "overnight flight" });
  const groups = days.flatMap((d) => d.items).filter((it) => it.kind === "group");
  const walk = groups.find((it) => it.leg?.flagged);
  if (walk?.leg) out.push({ type: "long_walk", detail: `${walk.leg.minutes} min walk to ${walk.name}` });
  const early = groups.find((it) => it.startMin < EARLY_START_MIN);
  if (early) out.push({ type: "early_start", detail: `${early.name} starts before 8am` });
  return out;
}

export function toPublic(ds: Dataset, p: Plan, label?: "A" | "B"): PlanPublic {
  const ix = indexOf(ds);
  const h = mustFind(ix.hotel.get(p.hotelId), "hotel", p.hotelId);
  const city = mustFind(ix.city.get(p.cityId), "city", p.cityId);
  const days = publicDays(ds, p);
  const rooms = roomsFor(h, p.members.length);
  return {
    planId: p._id, label, cityId: p.cityId, cityName: cityName(ds, p.cityId), hotelName: stayName(h, rooms), ...(rooms > 1 ? { rooms } : {}),
    neighborhood: h.neighborhood,
    hotelId: h._id, hotelLat: h.lat, hotelLng: h.lng, dateWindowId: p.dateWindowId, groupRange: publicTotalRange(ds, p),
    fitsEveryone: p.fitsEveryone, publicFlags: publicPlanFlags(ds, p, days), cityNotes: city.publicFlags,
    cityCenter: { lat: city.centerLat, lng: city.centerLng }, tileRadiusKm: city.tileRadiusKm, days,
  };
}

/** One member's own itinerary: only items they attend, their own legs, their own arrival. */
function myDays(p: Plan, memberId: string): Pick<PlanPrivate, "days" | "arrival"> {
  const crewSize = p.members.length;
  const days: MyDay[] = p.days.map((d) => ({
    day: d.day, label: d.label,
    items: d.items.filter((it) => it.attendees.includes(memberId)).map((it): MyScheduleItem => ({
      activityId: it.activityId, name: it.name, startMin: it.startMin, endMin: it.endMin, lat: it.lat, lng: it.lng,
      together: it.attendees.length === crewSize && crewSize > 1,
      ...(it.travel[memberId] ? { travel: it.travel[memberId] } : {}),
    })),
  }));
  const a = p.days[0]?.arrivals?.find((x) => x.memberId === memberId);
  return { days, ...(a ? { arrival: { landMin: a.landMin, atStayMin: a.atStayMin } } : {}) };
}

export function toPrivate(p: Plan, memberId: string): PlanPrivate | null {
  const m = p.members.find((x) => x.memberId === memberId);
  if (!m) return null;
  return {
    planId: p._id, amountCents: m.amountCents, lines: m.lines, fits: m.fits, reasons: m.reasons, covered: m.covered, missing: m.missing, flags: m.flags,
    ...myDays(p, memberId),
  };
}

/**
 * How much an Advocate wants a plan for its member: must-haves first, then the member's satisfaction,
 * then how agreeable the plan is for the whole table (half its maximin) — a good mate argues for
 * something the group can actually say aye to.
 */
export function advocatePreference(p: Plan, memberId: string): number {
  const m = p.members.find((x) => x.memberId === memberId);
  if (!m || !m.fits) return -1;
  const coverage = m.covered.length / Math.max(1, m.covered.length + m.missing.length);
  return coverage * 100 + m.satisfaction + 0.5 * p.fairness.maximin;
}
