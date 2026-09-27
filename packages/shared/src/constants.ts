import type { Band, Dealbreaker, Region, Tag } from "./types.js";
import airportsJson from "./data/airports.json" with { type: "json" };

/** Organizer + up to 11 (absent seats included). One color band each. */
export const MAX_CREW = 12;
export const MAX_WATCHES = 3;
export const MAX_MUST_HAVES = 3;
export const MAX_DEALBREAKERS = 3;
export const NOTE_MAX_CHARS = 200;
export const CAP_MIN_CENTS = 30_000;
export const CAP_MAX_CENTS = 300_000;
export const CAP_STEP_CENTS = 5_000;
export const LONG_WALK_MIN = 25;
export const EARLY_START_BEFORE = "08:00";
export const SEAL_TIMEOUT_MS = 15_000;
/** PRD D5: once a strict majority of the crew votes the same chart (or a tie is broken), it is picked after this. */
export const AUTOPICK_MS = 10_000;
/** In-trip minutes per real second in the Dry Run clock (doc 03 Q3). */
export const DRYRUN_MIN_PER_SEC = 15;
export const DRYRUN_DAY_START_MIN = 8 * 60;
export const DRYRUN_DAY_END_MIN = 23 * 60;
/** The Dry Run clock's day label until a chart names its own first day (R2-WP-16 / O2-031: phone and table agree). */
export const DRYRUN_DAY1_LABEL = "Day 1";

export const TAGS: { id: Tag; label: string }[] = [
  { id: "beach", label: "beach" },
  { id: "food", label: "food" },
  { id: "nightlife", label: "nightlife" },
  { id: "museums", label: "museums" },
  { id: "nature", label: "nature" },
  { id: "chill", label: "chill" },
  { id: "history", label: "history" },
  { id: "music", label: "music" },
];

/** Chip labels on the Brief (doc 03 P4) ↔ codes (doc 04 §4.3). */
export const DEALBREAKERS: { id: Dealbreaker; label: string }[] = [
  { id: "red_eye", label: "overnight flights" },
  { id: "hostel", label: "hostels" },
  { id: "layovers_2plus", label: "2+ layovers" },
  { id: "early_start", label: "starts before 8am" },
  { id: "long_walks", label: "long walks" },
];

/**
 * Crew color bands (doc 02 §3.3): twelve pigment inks, one per seat. Bands 1–4 are the original four (the Expo crew and
 * the snapshots use them); 5–12 were chosen for ≥17 ΔE from each other and from the reserved inks (sounding red,
 * verdigris "fits", wax, wood, brass), and ≥3.9:1 on paper.
 */
export const BANDS: Record<Band, { hex: string; name: string }> = {
  1: { hex: "#2F5D8A", name: "Prussian" },
  2: { hex: "#A0522D", name: "Sienna" },
  3: { hex: "#556B2F", name: "Olive" },
  4: { hex: "#7A4E7A", name: "Madder" },
  5: { hex: "#1F7474", name: "Teal" },
  6: { hex: "#882840", name: "Carmine" },
  7: { hex: "#484890", name: "Indigo" },
  8: { hex: "#8F6B1C", name: "Ochre" },
  9: { hex: "#A85078", name: "Rose" },
  10: { hex: "#1F5064", name: "Slate" },
  11: { hex: "#886868", name: "Rosewood" },
  12: { hex: "#686850", name: "Terre Verte" },
};
/** Every band id, in order (1…MAX_CREW). */
export const BAND_IDS: readonly Band[] = Object.keys(BANDS).map(Number) as Band[];

export const PALETTE = {
  paper: "#EFE6D2",
  paperDeep: "#E2D6BA",
  ink: "#1F2A44",
  inkSoft: "#4A5670",
  soundingRed: "#B23A2E",
  brass: "#B08D57",
  brassDark: "#7E6236",
  seaWash: "#9DB7B5",
  graphite: "#3B3B3B",
  wood: "#6B4A2E",
  okGreen: "#3F6B4E",
  baize: "#2E4A3A",
  // R2-WP-15 / O2-034: colours the chart room used as bare literals
  waxDark: "#7E2A21",
  woodDark: "#4A3120",
  twine: "#9C7A4D",
  /** The dim room behind the table (laptop/Gallery background, xr.css .cr-page). */
  room: "#221C17",
} as const;

/** A home airport a crew member can fly from (data/airports.json: US and Canada). */
export interface Airport { code: string; name: string; city: string; country: string; lat: number; lng: number; utcOffset: number }
/** Every home airport, ATL / ORD / JFK first (the original three, and the Expo crew's). */
export const AIRPORTS: readonly Airport[] = airportsJson as Airport[];
export const ORIGINS: readonly string[] = AIRPORTS.map((a) => a.code);
/** code → { name (the city), lat, lng } for every home airport. */
export const ORIGIN_COORDS: Readonly<Record<string, { name: string; lat: number; lng: number }>> =
  Object.fromEntries(AIRPORTS.map((a) => [a.code, { name: a.city, lat: a.lat, lng: a.lng }]));
/** Home airports matching what someone typed: the code, the city or the airport's name (case- and accent-blind). */
export function searchAirports(q: string): Airport[] {
  const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const n = fold(q.trim());
  if (!n) return [...AIRPORTS];
  const code = AIRPORTS.filter((a) => fold(a.code) === n);
  const rest = AIRPORTS.filter((a) => !code.includes(a) && (fold(a.code).startsWith(n) || fold(a.city).includes(n) || fold(a.name).includes(n)));
  return [...code, ...rest];
}

/** The regions ports belong to, in the order the Create screen lists them. */
export const REGIONS: readonly Region[] = [
  "Europe", "Latin America", "Caribbean", "United States", "Canada", "Asia", "Oceania", "Africa", "Middle East",
];
/** US state codes → names (city files carry `state` for US ports; organizers can pick a state). */
export const US_STATES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "Washington, D.C.", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
/** "CA" → "California" (an unknown code as given). */
export const stateName = (code: string) => US_STATES[code] ?? code;

/** An organizer names 2–4 ports (A4); "Surprise me" and the helm's default put 3 on the chart. */
export const MIN_PORTS = 2;
export const MAX_PORTS = 4;
export const DEFAULT_PORTS = 3;
/** A voyage offers 1–3 date windows (the Brief's date chips); the default is the next 2. */
export const MIN_WINDOWS = 1;
export const MAX_WINDOWS = 3;
export const DEFAULT_WINDOWS = 2;
/** "Places I'd love" / "Places I'd skip" on the Brief: up to this many each. */
export const MAX_PLACES = 3;

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatDollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export function minToClock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function clockToMin(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + (m || 0);
}

// ---------- user-facing copy shared by the helm, the phones and the chart room (OPT-025) ----------
// One string each, so the three surfaces can't drift. Phone Voided.tsx compares `publicReason` against
// the void headline, so keep it byte-for-byte equal to the server's `declined` reason.

/** The public reason for a declined share (server `declined`), and the chart room's VOIDED caption. */
export const VOID_HEADLINE = "One share didn't clear, so nobody was charged.";
/** BOOKED, on the phone and in the chart room. */
export const BOOKED_HEADLINE = "Logged. Nobody fronted a cent.";
/** The promise printed under every seal. */
export const SEALING_FOOTER = "If any share doesn't clear, nobody is charged.";
/** Every money surface says which parts are real (docs/06 §2). */
export const PAYMENT_SIM_LABEL = "Simulated — Visa Intelligent Commerce model · no real card is charged";
export const PAYMENT_VISA_LABEL = "Visa sandbox: card verified at seal · holds and charges simulated · no real card is charged";
export const paymentLabelFor = (mode: "visa_sandbox" | "sim") => (mode === "visa_sandbox" ? PAYMENT_VISA_LABEL : PAYMENT_SIM_LABEL);
/** After a member's seal is set (their own phone or seat headset only). */
export const sealSetLine = (amountCents: number, last4: string) =>
  `Your seal is set — ${formatCents(amountCents)} held on •••• ${last4}, not charged until everyone seals.`;
/** The void confirmation, whatever the reason. */
export const VOID_RELEASED = "Nobody was charged — every hold released.";
/** The button that goes back to the Two Charts after a void. */
export const BACK_TO_CHARTS = "Back to the charts";

/** "Ann's", "Ann's and Bo's", "Ann's, Bo's and Cy's". */
export function possessiveList(names: string[]): string {
  const p = names.map((n) => `${n}'s`);
  return p.length <= 1 ? p.join("") : `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
}

/** "Waiting on Ann's and Bo's terms…" while briefs are unsealed. */
export function waitingOnTerms(names: string[]): string {
  return `Waiting on ${possessiveList(names)} terms…`;
}

// ---------- R2-WP-13 (O2-031 / O2-032): limits the helm enforces and the phones mirror ----------
/** A crew member's name. */
export const NAME_MAX_CHARS = 24;
/** The voyage's name. */
export const TRIP_NAME_MAX_CHARS = 40;
/** A hail as it reaches the table (the transcript of a spoken hail is cut to the same length). */
export const HAIL_MAX_CHARS = 160;
/** The Captain needs at least this many crew at the table. */
export const MIN_TABLE_CREW = 2;
/** Characters in a voyage's join code. */
export const JOIN_CODE_LEN = 6;
/** R2-WP-16 (O2-017): what the phone and the Gallery say while the socket is down. */
export const SIGNAL_LOST = "Lost the signal. Holding your place.";

/**
 * The Quest-first flow (docs/03 §4, docs/04 §6): a headset asking to sit in an existing seat waits this long for the
 * seat's own device to let it in; a seal PIN (a headset whose browser can't hold a passkey) is 4–6 digits, and this
 * many wrong tries lock it for SEAL_PIN_LOCK_MS.
 */
export const HEADSET_REQUEST_TTL_MS = 2 * 60_000;
export const SEAL_PIN_MIN = 4;
export const SEAL_PIN_MAX = 6;
export const SEAL_PIN_TRIES = 5;
export const SEAL_PIN_LOCK_MS = 15 * 60_000;
/** A valid seal PIN: 4–6 digits. */
export const validSealPin = (pin: unknown): pin is string => typeof pin === "string" && /^\d{4,6}$/.test(pin);
