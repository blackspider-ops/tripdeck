// Canonical domain types (docs/04-technical-design.md §4). Money is always integer cents.

export type TripStatus = "BRIEFING" | "AT_TABLE" | "DRY_RUN" | "SEALING" | "BOOKED" | "VOIDED";
export type Role = "organizer" | "member" | "absent";
export type Band = 1 | 2 | 3 | 4;
export type Origin = "ATL" | "ORD" | "JFK";
export type CityId = "LIS" | "MEX" | "YUL";
export type Tag = "beach" | "food" | "nightlife" | "museums" | "nature" | "chill" | "history" | "music";
export type Dealbreaker = "red_eye" | "hostel" | "early_start" | "long_walks" | "layovers_2plus";
export type Surface = "phone" | "xr" | "gallery";

export interface DateWindow { id: string; start: string; end: string; nights: number }

// ---------- dataset ----------
export interface City {
  _id: CityId; name: string; centerLat: number; centerLng: number;
  tileRadiusKm: number; publicFlags: string[];
}
export interface FlightOption {
  _id: string; kind: "flight"; cityId: CityId; origin: Origin; dateWindowId: string;
  airline: string; departLocal: string; arriveLocal: string; returnLocal: string;
  stops: 0 | 1 | 2; redEye: boolean; priceCents: number;
}
export interface HotelOption {
  _id: string; kind: "hotel"; cityId: CityId; name: string; neighborhood: string; lat: number; lng: number;
  stayType: "hotel" | "guesthouse" | "hostel" | "apartment"; nightlyCents: number; sleeps: number; rating: number;
}
export interface ActivityOption {
  _id: string; kind: "activity"; cityId: CityId; name: string; short: string; tags: Tag[]; lat: number; lng: number;
  durationMin: number; priceCents: number; startEarliest: string; startLatest: string;
  role: "group" | "pick"; earlyStart?: boolean;
}
export type Option = FlightOption | HotelOption | ActivityOption;
export interface WalkOverride { fromId: string; toId: string; mode: TravelMode; minutes: number; note?: string }
export type TravelMode = "walk" | "tram" | "taxi" | "train";
export interface Dataset {
  presetId: string; name: string; cities: City[]; dateWindows: DateWindow[];
  flights: FlightOption[]; hotels: HotelOption[]; activities: ActivityOption[]; overrides: WalkOverride[];
}

// ---------- people ----------
/**
 * What anyone in the room sees about a crew member. No home airport (S2-002): it fixes the member's flight price,
 * which with the public plan narrows their share. The origin stays server-side (pricing, the member's own Advocate).
 */
export interface CrewPublic {
  memberId: string; name: string; role: Role; band: Band; briefSealed: boolean;
  /**
   * L1-009 / S2-012: only on a seat that was sent an invite link (an absent friend, or a seat the organizer reset):
   * whether the link has been opened (claimed). Once true the link is spent; everyone sees it.
   */
  inviteOpen?: boolean;
}
export interface BriefInput {
  capCents: number;
  dateWindowIds: string[];
  mustHaves: Tag[];
  dealbreakers: Dealbreaker[];
  note?: string;
  noteSource?: "typed" | "voice";
}
export interface Brief extends BriefInput { memberId: string; tripId: string; sealedAt: string }

// ---------- plans ----------
export interface ShareLine { label: string; amountCents: number; kind: "flight" | "lodging" | "activity" }
export type FitReason =
  | "ok" | "over_cap" | "date_mismatch"
  | "dealbreaker:red_eye" | "dealbreaker:hostel" | "dealbreaker:early_start"
  | "dealbreaker:long_walks" | "dealbreaker:layovers_2plus" | "no_flight";
export type FlagType = "long_walk" | "early_start" | "red_eye" | "over_cap";
export interface PlanFlag { memberId?: string; type: FlagType; detail: string }

export interface TravelLeg { fromId: string; toId: string; mode: TravelMode; minutes: number; flagged: boolean }
/** SERVER-INTERNAL schedule item: carries per-member attendance and legs. Never emitted as-is (SEC-001). */
export interface ScheduleItem {
  activityId: string; name: string; startMin: number; endMin: number; attendees: string[];
  lat: number; lng: number; travel: Record<string, TravelLeg>; // per member
}
/** SERVER-INTERNAL day (see ScheduleItem). */
export interface PlanDay {
  day: number; label: string; items: ScheduleItem[];
  /** Day 1 only: when each member lands and reaches the stay. */
  arrivals?: { memberId: string; landMin: number; atStayMin: number }[];
}

/**
 * Public schedule item (doc 04 §7.2): group-level only. No member ids, no per-member legs, no arrivals —
 * together with public prices those let anyone rebuild every member's share (SEC-001). A pick's time and day
 * here are a crew-independent layout (dataset order, from a fixed hour), not when its attendees actually go:
 * the real times follow landing times and would narrow every share (S2-002). The real ones are in plan:private.
 */
export interface PublicScheduleItem {
  activityId: string; name: string; startMin: number; endMin: number; lat: number; lng: number;
  /** "group" = a moment for the whole crew; "pick" = some of the crew go (who is never said). */
  kind: "group" | "pick";
  /** Crew-independent route leg from public geography: the stay (or the previous group moment) → here. */
  leg?: TravelLeg;
}
export interface PublicDay { day: number; label: string; items: PublicScheduleItem[] }

/** One member's own schedule item — only ever inside that member's PlanPrivate. */
export interface MyScheduleItem {
  activityId: string; name: string; startMin: number; endMin: number; lat: number; lng: number;
  /** A whole-crew moment (never says which other members share a pick). */
  together: boolean;
  /** This member's own leg to get here. */
  travel?: TravelLeg;
}
export interface MyDay { day: number; label: string; items: MyScheduleItem[] }

export interface MemberPlanView {
  memberId: string;
  flightId: string;
  amountCents: number;
  lines: ShareLine[];
  fits: boolean;
  reasons: FitReason[];
  covered: Tag[];
  missing: Tag[];
  flags: PlanFlag[];
  satisfaction: number;
}
export interface Plan {
  _id: string; tripId?: string; cityId: CityId; dateWindowId: string; hotelId: string;
  days: PlanDay[];
  groupCents: number;
  members: MemberPlanView[]; // PRIVATE per member when emitted
  fairness: { maximin: number; sum: number };
  fitsEveryone: boolean;
  publicFlags: PlanFlag[];
}
/** What anyone may see about a plan (doc 04 §7.2 table:decided). */
export interface PlanPublic {
  planId: string; label?: "A" | "B"; cityId: CityId; cityName: string; hotelName: string; neighborhood: string;
  hotelId: string; hotelLat: number; hotelLng: number; dateWindowId: string;
  /**
   * The group total as a range computed from public facts only (S2-002): the lowest and highest total any crew of
   * this size could have for this public plan. The exact total is the sum of the private shares — even rounded it
   * pins them — so it never leaves the helm; each member sees their own exact share in plan:private.
   */
  groupRange: { lowCents: number; highCents: number };
  fitsEveryone: boolean; publicFlags: PlanFlag[]; cityNotes: string[];
  cityCenter: { lat: number; lng: number }; tileRadiusKm: number;
  /** Group-level schedule only (see PublicScheduleItem); labels are "Day 1", "Day 2". */
  days: PublicDay[];
}
/** What only the member themselves sees (plan:private → member:{id}). */
export interface PlanPrivate {
  planId: string; amountCents: number; lines: ShareLine[]; fits: boolean; reasons: FitReason[];
  covered: Tag[]; missing: Tag[]; flags: PlanFlag[];
  /** My own itinerary: only the items I attend, with my legs. */
  days: MyDay[];
  /** Day 1: when I land and reach the stay. */
  arrival?: { landMin: number; atStayMin: number };
}

// ---------- negotiation ----------
export type Act = "OPEN" | "PROPOSE" | "OBJECT" | "CONCEDE" | "SUPPORT" | "HAIL" | "DECIDE";
export type Speaker =
  | { kind: "advocate"; memberId: string }
  | { kind: "captain" }
  | { kind: "human"; memberId: string };
export interface Turn {
  turnId: string; tripId: string; seq: number; watch: number; speaker: Speaker; act: Act;
  planId?: string; cityId?: CityId; text: string; ribbon: string; voiced: boolean;
  audioUrl?: string; redactions: number; createdAt: string;
  /** Voice length, set with audioUrl, so a replayed turn:audioReady carries it too (TR3-011). */
  durationMs?: number;
}

// ---------- payments ----------
export type BookingStatus = "PENDING" | "AUTHORIZING" | "ALL_AUTHORIZED" | "CAPTURED" | "ANY_DECLINED" | "VOIDED";
export type SealStatus = "PENDING" | "AUTHORIZING" | "AUTHORIZED" | "DECLINED" | "CAPTURED" | "VOIDED";
export type DeclineReason = "over_limit" | "timeout" | "provider_error" | "user_cancelled";
export interface SealPublic { memberId: string; status: SealStatus; standing?: boolean }
export interface BookingPublic {
  /** No group total here: the exact total of the chosen chart would undo PlanPublic.groupRange (S2-002). */
  bookingId: string; planId: string; attempt: number; status: BookingStatus;
  mode: "visa_sandbox" | "sim"; reference?: string; seals: SealPublic[];
  /** While seals can still be set: when the attempt is voided if they aren't all set (SEC-011), for a countdown. */
  sealDeadlineAt?: string;
}

// ---------- shared state snapshot ----------
export interface TripState {
  tripId: string; joinCode: string; name: string; status: TripStatus; version: number;
  organizerId: string;
  crew: CrewPublic[];
  /** SEC-010: the organizer closed the crew; the join code no longer adds anyone (absent invites still work). */
  crewClosed?: boolean;
  candidateCities: { cityId: CityId; name: string; lat: number; lng: number }[];
  dateWindows: DateWindow[];
  negotiation: { watch: number; running: boolean };
  /**
   * The Two Charts by id (DRY_RUN and later). The plan bodies come once, in table:decided (live and on replay,
   * where it precedes this snapshot); clients keep them from there (OPT-042).
   */
  shortlistIds?: [string, string];
  votes?: Record<string, number>;
  autoPick?: { planId: string; at: number } | null;
  /** Only while a booking is live or final (SEALING, BOOKED, VOIDED): after "back to the charts" it's history (TR4-013). */
  chosenPlanId?: string;
  booking?: BookingPublic;
  paymentsMode: "visa_sandbox" | "sim";
  /** Server clock (ms) when this snapshot was made, to map autoPick.at onto the device clock (TR1-008). */
  serverNow: number;
}

/** R2-WP-14 (O2-040): the parts of a voyage's snapshot that never change once it exists. */
export const TRIP_STATIC_FIELDS = ["candidateCities", "dateWindows"] as const;
export type TripStaticField = (typeof TRIP_STATIC_FIELDS)[number];
/**
 * R2-WP-14 (O2-040): `trip:state` as sent. The static fields (the ports and date windows) come with a (re)joining
 * client's replay; the live broadcasts leave them out and the client keeps the ones it has for this voyage.
 */
export type TripStateUpdate = Omit<TripState, TripStaticField> & Partial<Pick<TripState, TripStaticField>>;

export interface DryRunScript {
  planIds: string[]; dayStartMin: number; dayEndMin: number; minPerSec: number;
  /** Server clock (ms) when the day started / was paused, and the server's "now" — so every device and reload shows the same minute. */
  startedAt?: number; pausedAt?: number | null; serverNow?: number;
}
