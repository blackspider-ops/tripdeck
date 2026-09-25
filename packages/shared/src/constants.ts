import type { Band, Dealbreaker, Tag } from "./types.js";

export const MAX_CREW = 4;
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
/** PRD D5: once a clear majority votes the same chart, it is picked after this unless the organizer picks first. */
export const AUTOPICK_MS = 20_000;
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

/** Crew color bands (doc 02 §3.3). */
export const BANDS: Record<Band, { hex: string; name: string }> = {
  1: { hex: "#2F5D8A", name: "Prussian" },
  2: { hex: "#A0522D", name: "Sienna" },
  3: { hex: "#556B2F", name: "Olive" },
  4: { hex: "#7A4E7A", name: "Madder" },
};

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

export const ORIGINS = ["ATL", "ORD", "JFK"] as const;
export const ORIGIN_COORDS: Record<(typeof ORIGINS)[number], { name: string; lat: number; lng: number }> = {
  ATL: { name: "Atlanta", lat: 33.6407, lng: -84.4277 },
  ORD: { name: "Chicago", lat: 41.9742, lng: -87.9073 },
  JFK: { name: "New York", lat: 40.6413, lng: -73.7781 },
};

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
