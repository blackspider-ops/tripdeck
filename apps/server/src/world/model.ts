/**
 * The price model for generated packs (no live prices exist for "any city"): nightly = base × country level ×
 * stay type × stars × a small per-place jitter (±8 %, from the OSM id, so the same place always costs the same);
 * activity prices = the category's default × country level. All deterministic.
 */
import type { PackStayType, Tag } from "@all-ayes/shared";

/** FNV-1a (32-bit): a stable hash for jitter, ratings and tie-breaks. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A 3-star hotel's triple room in a level-1.0 country (≈ Spain), per night, USD. */
export const BASE_NIGHTLY_USD = 200;
/** Whole unit for the crew: a hostel's 3 beds < a guesthouse room < a 4-sleeper apartment < a hotel triple. */
export const STAY_FACTOR: Readonly<Record<PackStayType, number>> = { hostel: 0.6, guesthouse: 0.85, apartment: 1.1, hotel: 1.15 };
export const SLEEPS: Readonly<Record<PackStayType, number>> = { hostel: 3, guesthouse: 3, apartment: 4, hotel: 3 };

/** OSM `stars` ("4", "4S", "3.5") → a factor; unknown stars count as 3. */
export function starsFactor(stars: number | undefined): number {
  if (stars === undefined) return 1;
  const s = Math.max(1, Math.min(5, stars));
  return [0.7, 0.85, 1, 1.3, 1.8][Math.round(s) - 1];
}
export function parseStars(raw: string | undefined): number | undefined {
  const m = raw?.match(/^\s*(\d(?:\.\d)?)/);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 5 ? n : undefined;
}

/** ±8 % from the seed (the OSM ref), or none without a seed. */
export const jitter = (seed?: string) => (seed === undefined ? 1 : 0.92 + ((hash32(seed) % 1000) / 1000) * 0.16);

/** Nightly price of the whole unit, cents, rounded to $5 (at least $30). */
export function modelNightlyCents(p: { level: number; stayType: PackStayType; stars?: number; seed?: string }): number {
  const usd = BASE_NIGHTLY_USD * p.level * STAY_FACTOR[p.stayType] * starsFactor(p.stars) * jitter(p.seed);
  return Math.max(30, Math.round(usd / 5) * 5) * 100;
}

/** 4.0–4.5 from the OSM ref; 4- and 5-star places get +0.1 (still ≤ 4.5). */
export function modelRating(seed: string, stars?: number): number {
  const r = 4.0 + (hash32(seed + ":r") % 6) / 10 + (stars !== undefined && stars >= 4 ? 0.1 : 0);
  return Math.round(Math.min(4.5, r) * 10) / 10;
}

// ---------- activity categories ----------
export type ActivityCategory =
  | "museum" | "gallery" | "attraction" | "viewpoint" | "zoo" | "theme_park"
  | "castle" | "monument" | "memorial" | "ruins" | "archaeological_site"
  | "park" | "nature_reserve" | "beach" | "theatre" | "marketplace"
  | "bar" | "nightclub" | "restaurant" | "square";

export interface CategoryDefaults {
  tags: Tag[]; durationMin: number; usd: number; startEarliest: string; startLatest: string;
  /** How much a visitor cares, before OSM's own notability signals (wikidata, translations, …). */
  interest: number;
  /** How the activity is named from the place ("Dinner at {name}"); default: the place's name. */
  label?: string;
}

export const CATEGORY: Readonly<Record<ActivityCategory, CategoryDefaults>> = {
  museum: { tags: ["museums"], durationMin: 120, usd: 15, startEarliest: "10:00", startLatest: "16:00", interest: 3 },
  gallery: { tags: ["museums"], durationMin: 90, usd: 10, startEarliest: "10:00", startLatest: "16:30", interest: 2 },
  attraction: { tags: ["history"], durationMin: 90, usd: 10, startEarliest: "09:30", startLatest: "16:00", interest: 2 },
  viewpoint: { tags: ["nature", "chill"], durationMin: 60, usd: 0, startEarliest: "10:00", startLatest: "18:30", interest: 2 },
  zoo: { tags: ["nature"], durationMin: 180, usd: 25, startEarliest: "09:30", startLatest: "13:00", interest: 2 },
  theme_park: { tags: ["chill"], durationMin: 300, usd: 55, startEarliest: "10:00", startLatest: "12:00", interest: 1 },
  castle: { tags: ["history"], durationMin: 120, usd: 15, startEarliest: "09:30", startLatest: "15:30", interest: 3 },
  monument: { tags: ["history"], durationMin: 45, usd: 0, startEarliest: "09:00", startLatest: "18:00", interest: 1 },
  memorial: { tags: ["history"], durationMin: 45, usd: 0, startEarliest: "09:00", startLatest: "18:00", interest: 0.5 },
  ruins: { tags: ["history", "nature"], durationMin: 90, usd: 8, startEarliest: "09:00", startLatest: "16:00", interest: 2 },
  archaeological_site: { tags: ["history"], durationMin: 120, usd: 12, startEarliest: "09:00", startLatest: "15:00", interest: 2 },
  park: { tags: ["nature", "chill"], durationMin: 90, usd: 0, startEarliest: "09:00", startLatest: "17:00", interest: 1 },
  nature_reserve: { tags: ["nature"], durationMin: 180, usd: 0, startEarliest: "09:00", startLatest: "13:00", interest: 1.5 },
  beach: { tags: ["beach", "chill"], durationMin: 180, usd: 10, startEarliest: "10:00", startLatest: "15:00", interest: 2 },
  theatre: { tags: ["music"], durationMin: 150, usd: 45, startEarliest: "19:00", startLatest: "20:30", interest: 1.5, label: "Show at {name}" },
  marketplace: { tags: ["food"], durationMin: 90, usd: 20, startEarliest: "09:00", startLatest: "12:30", interest: 2, label: "{name} tasting" },
  bar: { tags: ["nightlife"], durationMin: 120, usd: 30, startEarliest: "20:00", startLatest: "22:00", interest: 0.5, label: "Drinks at {name}" },
  nightclub: { tags: ["nightlife", "music"], durationMin: 180, usd: 25, startEarliest: "22:30", startLatest: "23:30", interest: 0.5, label: "Night out at {name}" },
  restaurant: { tags: ["food"], durationMin: 120, usd: 40, startEarliest: "19:00", startLatest: "21:00", interest: 0.5, label: "Dinner at {name}" },
  square: { tags: ["history", "chill"], durationMin: 60, usd: 0, startEarliest: "10:00", startLatest: "19:00", interest: 1 },
};

/** Per person, cents, rounded to the dollar (free stays free). */
export function modelActivityCents(cat: ActivityCategory, level: number): number {
  const usd = CATEGORY[cat].usd * level;
  return usd <= 0 ? 0 : Math.max(1, Math.round(usd)) * 100;
}
