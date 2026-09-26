/**
 * Country table for generated packs: a relative price level for travellers (1.0 ≈ Spain), the standard-time UTC
 * offset where the country keeps one zone (null = several zones → estimated from longitude), and a region label.
 * The levels are rough, hand-set ballparks for hotel/activity prices seen by visitors — a model, not data: every
 * generated pack says "Prices are estimates for this place".
 */
import type { Region } from "@all-ayes/shared";

export interface CountryInfo { level: number; utc: number | null; region: Region }

const E: Region = "Europe", LA = "Latin America", CB = "Caribbean", AS = "Asia", ME = "Middle East", AF = "Africa", OC = "Oceania";

export const COUNTRIES: Readonly<Record<string, CountryInfo>> = {
  // Europe
  ES: { level: 1.0, utc: 1, region: E }, PT: { level: 0.9, utc: 0, region: E }, FR: { level: 1.25, utc: 1, region: E },
  IT: { level: 1.15, utc: 1, region: E }, DE: { level: 1.15, utc: 1, region: E }, NL: { level: 1.3, utc: 1, region: E },
  BE: { level: 1.15, utc: 1, region: E }, GB: { level: 1.35, utc: 0, region: E }, IE: { level: 1.35, utc: 0, region: E },
  CH: { level: 1.75, utc: 1, region: E }, AT: { level: 1.15, utc: 1, region: E }, DK: { level: 1.45, utc: 1, region: E },
  SE: { level: 1.3, utc: 1, region: E }, NO: { level: 1.55, utc: 1, region: E }, FI: { level: 1.3, utc: 2, region: E },
  IS: { level: 1.7, utc: 0, region: E }, GR: { level: 0.9, utc: 2, region: E }, HR: { level: 0.95, utc: 1, region: E },
  SI: { level: 0.9, utc: 1, region: E }, CZ: { level: 0.8, utc: 1, region: E }, PL: { level: 0.7, utc: 1, region: E },
  HU: { level: 0.7, utc: 1, region: E }, SK: { level: 0.7, utc: 1, region: E }, RO: { level: 0.6, utc: 2, region: E },
  BG: { level: 0.55, utc: 2, region: E }, RS: { level: 0.6, utc: 1, region: E }, ME: { level: 0.7, utc: 1, region: E },
  AL: { level: 0.55, utc: 1, region: E }, BA: { level: 0.55, utc: 1, region: E }, EE: { level: 0.85, utc: 2, region: E },
  LV: { level: 0.75, utc: 2, region: E }, LT: { level: 0.75, utc: 2, region: E }, MT: { level: 0.95, utc: 1, region: E },
  CY: { level: 0.95, utc: 2, region: E }, LU: { level: 1.4, utc: 1, region: E }, TR: { level: 0.6, utc: 3, region: E },
  // Americas
  US: { level: 1.35, utc: null, region: "United States" }, CA: { level: 1.2, utc: null, region: "Canada" }, MX: { level: 0.65, utc: null, region: LA },
  BR: { level: 0.6, utc: null, region: LA }, AR: { level: 0.55, utc: -3, region: LA }, CL: { level: 0.7, utc: -3, region: LA },
  PE: { level: 0.55, utc: -5, region: LA }, CO: { level: 0.5, utc: -5, region: LA }, CR: { level: 0.85, utc: -6, region: LA },
  CU: { level: 0.6, utc: -5, region: CB }, DO: { level: 0.7, utc: -4, region: CB }, PA: { level: 0.75, utc: -5, region: LA },
  EC: { level: 0.55, utc: -5, region: LA }, UY: { level: 0.8, utc: -3, region: LA }, GT: { level: 0.5, utc: -6, region: LA },
  PR: { level: 1.1, utc: -4, region: CB }, JM: { level: 0.9, utc: -5, region: CB }, BS: { level: 1.3, utc: -5, region: CB },
  // Asia / Middle East
  JP: { level: 1.05, utc: 9, region: AS }, KR: { level: 0.95, utc: 9, region: AS }, CN: { level: 0.75, utc: 8, region: AS },
  HK: { level: 1.3, utc: 8, region: AS }, TW: { level: 0.85, utc: 8, region: AS }, SG: { level: 1.4, utc: 8, region: AS },
  TH: { level: 0.5, utc: 7, region: AS }, VN: { level: 0.4, utc: 7, region: AS }, KH: { level: 0.4, utc: 7, region: AS },
  LA: { level: 0.4, utc: 7, region: AS }, MY: { level: 0.5, utc: 8, region: AS }, ID: { level: 0.45, utc: null, region: AS },
  PH: { level: 0.5, utc: 8, region: AS }, IN: { level: 0.4, utc: 5.5, region: AS }, LK: { level: 0.45, utc: 5.5, region: AS },
  NP: { level: 0.35, utc: 5.75, region: AS }, AE: { level: 1.3, utc: 4, region: ME }, QA: { level: 1.3, utc: 3, region: ME },
  IL: { level: 1.4, utc: 2, region: ME }, JO: { level: 0.85, utc: 3, region: ME }, OM: { level: 1.0, utc: 4, region: ME },
  // Africa
  MA: { level: 0.55, utc: 1, region: AF }, EG: { level: 0.45, utc: 2, region: AF }, ZA: { level: 0.6, utc: 2, region: AF },
  KE: { level: 0.65, utc: 3, region: AF }, TZ: { level: 0.7, utc: 3, region: AF }, TN: { level: 0.5, utc: 1, region: AF },
  // Oceania
  AU: { level: 1.25, utc: null, region: OC }, NZ: { level: 1.2, utc: 12, region: OC }, FJ: { level: 0.9, utc: 12, region: OC },
};

export const DEFAULT_COUNTRY: Omit<CountryInfo, "region"> = { level: 0.8, utc: null };

export const countryInfo = (iso2: string | undefined): Omit<CountryInfo, "region"> & { region?: Region } => COUNTRIES[(iso2 ?? "").toUpperCase()] ?? DEFAULT_COUNTRY;

/** Standard-time offset (hours): the country's single zone, else longitude / 15 rounded to the hour. */
export function utcOffsetFor(iso2: string | undefined, lng: number): number {
  const c = countryInfo(iso2);
  if (c.utc !== null) return c.utc;
  return Math.max(-12, Math.min(14, Math.round(lng / 15)));
}

/** The region (the pickers' REGIONS) for a country outside the table, from its coordinates (coarse on purpose). */
export function regionFor(iso2: string | undefined, lat: number, lng: number): Region {
  const c = COUNTRIES[(iso2 ?? "").toUpperCase()];
  if (c) return c.region;
  if (lng < -25) {
    if (lat >= 49) return "Canada";
    if (lat >= 10 && lat < 27 && lng > -86) return "Caribbean";
    return lat >= 25 ? "United States" : "Latin America";
  }
  if (lat < -10 && lng > 110) return OC;
  if (lng > 150 || (lat < 0 && lng > 130)) return OC;
  if (lng < 60 && lat < 37 && lat > -40 && !(lng > 34 && lat > 12)) return AF;
  if (lng >= 34 && lng < 60 && lat >= 12 && lat < 42) return ME;
  if (lng < 40 && lat >= 35) return E;
  return AS;
}
