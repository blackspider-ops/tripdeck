/**
 * The flight model (docs/07-dataset-spec.md §2b). Curated listings win: for a (port, home airport, date window) with
 * at least one flight in the dataset (LIS / MEX / YUL × ATL / ORD / JFK × W1 / W2) those are the options, unchanged.
 * Every other combination is modelled, deterministically (a seeded hash, never Math.random), from public geography:
 *
 *   distance  great-circle km between the home airport and the port's airport
 *   duration  km / 800 km/h + 45 min; each stop adds 1.5–3 h and ~8 % routing
 *   stops     nonstop up to ~4,500 km (and from big hubs on most long-haul routes); a 1-stop option otherwise
 *   price     a distance curve (≈ $120 + 8.5¢/km, steeper past 8,000 km) × the window's season factor × ±8 % noise,
 *             cheaper with stops, rounded to $5 (never a round $50, so a price can't be mistaken for a budget cap)
 *   airlines  plausible for the destination (flag carrier + US majors / Air Canada), picked by hash
 *   times     local, from each end's UTC offset: eastbound long-haul leaves in the evening and lands next morning,
 *             transpacific leaves late morning, the rest by day; redEye = 90+ min airborne between 1 and 5 am on
 *             the traveller's home clock (or, eastbound long-haul, the port's clock); the return leaves on the
 *             window's last day
 *
 * A home airport within 150 km of the port is a "home port": one option, no flight, $0 (pricing adds no flight line).
 * Prices are illustrative, not quotes.
 */
import type { City, CityId, Dataset, DateWindow, FlightOption, Origin } from "@all-ayes/shared";
import { AIRPORTS, ORIGINS, type Airport } from "@all-ayes/shared";
import { indexOf, perDataset } from "../data/loader.js";
import { haversineKm } from "../dryrun/walking.js";

/** Within this distance of the port a crew member simply goes from home. */
export const HOME_PORT_KM = 150;
export const HOME_PORT_AIRLINE = "No flight — home port";

/** Demand by window (1 = the March baseline): holidays and summer cost more, fall break less. */
export const SEASON: Readonly<Record<string, number>> = {
  W1: 1.0, W2: 1.08, W3: 1.12, W4: 1.25, W5: 1.18, W6: 1.1, W7: 0.94, W8: 1.22, W9: 1.38, W10: 1.15,
};
/** A window the table doesn't list (a runtime-added one): by month. */
const MONTH_SEASON = [1.3, 0.95, 1.05, 1.0, 1.05, 1.15, 1.25, 1.2, 1.0, 0.95, 1.05, 1.3];
export function seasonFactor(w: DateWindow): number {
  return SEASON[w.id] ?? MONTH_SEASON[Number(w.start.slice(5, 7)) - 1] ?? 1;
}

// ---------- deterministic noise ----------
/** FNV-1a → [0, 1). The only "randomness" in the model. */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % 1_000_003) / 1_000_003;
}

const airportByCode = new Map(AIRPORTS.map((a) => [a.code, a] as const));
export const airportOf = (code: Origin): Airport | undefined => airportByCode.get(code);

/** The port's airport and clock (city files carry both; older entries fall back to the center and longitude). */
function portOf(c: City) {
  return {
    code: c.airport?.code ?? c._id,
    lat: c.airport?.lat ?? c.centerLat, lng: c.airport?.lng ?? c.centerLng,
    utcOffset: c.utcOffset ?? Math.round(c.centerLng / 15),
  };
}

/** Great-circle km from a home airport to a port (its airport), or null for an unknown airport/port. */
export function distanceKm(ds: Dataset, origin: Origin, cityId: CityId): number | null {
  const a = airportOf(origin), c = indexOf(ds).city.get(cityId);
  if (!a || !c) return null;
  return haversineKm(a, portOf(c));
}

/** The member flies from within reach of the port (e.g. JFK → New York): no flight at all. */
export function isHomePort(ds: Dataset, origin: Origin, cityId: CityId): boolean {
  const a = airportOf(origin), c = indexOf(ds).city.get(cityId);
  if (!a || !c) return false;
  return Math.min(haversineKm(a, portOf(c)), haversineKm(a, { lat: c.centerLat, lng: c.centerLng })) < HOME_PORT_KM;
}

// ---------- carriers ----------
const US_MAJORS = ["Delta", "United", "American"];
const HUBS: Record<string, string[]> = {
  Delta: ["ATL", "DTW", "MSP", "JFK", "SLC", "SEA"], United: ["EWR", "ORD", "IAD", "DEN", "SFO", "IAH"],
  American: ["DFW", "CLT", "MIA", "PHL", "ORD"], Southwest: ["MDW", "DEN", "BWI", "LAS"], JetBlue: ["JFK", "BOS", "FLL"],
  Alaska: ["SEA", "PDX"], Hawaiian: ["HNL"], "Air Canada": ["YYZ", "YUL", "YVR"], WestJet: ["YYC", "YYZ"],
  TAP: ["LIS"], Iberia: ["MAD"], "Air France": ["CDG"], KLM: ["AMS"], Lufthansa: ["FRA", "MUC"], "British Airways": ["LHR"],
  "Aer Lingus": ["DUB"], Icelandair: ["KEF"], "ITA Airways": ["FCO"], Swiss: ["ZRH"], Austrian: ["VIE"], SAS: ["CPH"],
  Aegean: ["ATH"], "Turkish Airlines": ["IST"], Emirates: ["DXB"], "Qatar Airways": ["DOH"], "Royal Jordanian": ["AMM"],
  "El Al": ["TLV"], "Royal Air Maroc": ["CMN"], EgyptAir: ["CAI"], "Kenya Airways": ["NBO"], "Ethiopian": ["ADD"],
  ANA: ["NRT"], JAL: ["HND"], Thai: ["BKK"], "Singapore Airlines": ["SIN"], "Cathay Pacific": ["HKG"], "Korean Air": ["ICN"],
  Qantas: ["SYD"], "Air New Zealand": ["AKL"], "Aeroméxico": ["MEX"], Avianca: ["BOG"], LATAM: ["LIM", "SCL", "GRU"],
  Copa: ["PTY"], "Aerolíneas Argentinas": ["EZE"],
};
/** Flag (or home) carriers by the port's country. */
const FLAG: Record<string, string[]> = {
  Portugal: ["TAP"], Spain: ["Iberia"], France: ["Air France"], Netherlands: ["KLM"], Germany: ["Lufthansa"],
  "United Kingdom": ["British Airways"], UK: ["British Airways"], England: ["British Airways"], Scotland: ["British Airways"],
  Ireland: ["Aer Lingus"], Iceland: ["Icelandair"], Italy: ["ITA Airways"], Switzerland: ["Swiss"], Austria: ["Austrian"],
  Denmark: ["SAS"], Sweden: ["SAS"], Norway: ["SAS"], Czechia: ["Lufthansa", "KLM"], "Czech Republic": ["Lufthansa", "KLM"],
  Hungary: ["Lufthansa"], Croatia: ["Lufthansa"], Greece: ["Aegean"], Turkey: ["Turkish Airlines"], "Türkiye": ["Turkish Airlines"],
  "United Arab Emirates": ["Emirates"], UAE: ["Emirates"], Qatar: ["Qatar Airways"], Jordan: ["Royal Jordanian"], Israel: ["El Al"],
  Morocco: ["Royal Air Maroc"], Egypt: ["EgyptAir"], Kenya: ["Kenya Airways"], Tanzania: ["Qatar Airways", "Ethiopian"],
  Ghana: ["Delta"], "South Africa": ["Delta"], Japan: ["ANA", "JAL"], Thailand: ["Thai"], Singapore: ["Singapore Airlines"],
  "Hong Kong": ["Cathay Pacific"], "South Korea": ["Korean Air"], Australia: ["Qantas"], "New Zealand": ["Air New Zealand"],
  Mexico: ["Aeroméxico"], Colombia: ["Avianca"], Peru: ["LATAM"], Chile: ["LATAM"], Brazil: ["LATAM"],
  Argentina: ["Aerolíneas Argentinas", "LATAM"], Uruguay: ["LATAM"], "Costa Rica": ["Avianca"], Panama: ["Copa"],
  Cuba: ["American"], Canada: ["Air Canada", "WestJet"],
};

/** Plausible carriers for this route, in a fixed order (the hash picks among them). */
function carriers(origin: Airport, city: City): string[] {
  const out: string[] = [];
  const add = (xs: string[]) => { for (const x of xs) if (!out.includes(x)) out.push(x); };
  const port = portOf(city);
  if (city.region === "United States") {
    if (city.state === "HI" || port.code === "HNL") add(["Hawaiian", "Alaska"]);
    add(["Delta", "United", "American", "Southwest"]);
    if (origin.lng > -90 || port.lng > -90) add(["JetBlue"]);
    if (origin.lng < -110 || port.lng < -110) add(["Alaska"]);
  } else if (city.region === "Caribbean") {
    add(FLAG[city.country ?? ""] ?? []);
    add(["JetBlue", "American", "Delta", "United"]);
  } else {
    if (origin.country === "CA") add(["Air Canada"]);
    add(FLAG[city.country ?? ""] ?? []);
    add(US_MAJORS);
  }
  if (origin.country === "CA" && city.region !== "United States") add(["Air Canada"]);
  return out;
}

/** Where the connecting hubs are (for a plausible "via": roughly on the way). */
const HUB_AT: Record<string, [number, number]> = {
  ATL: [33.64, -84.43], DTW: [42.21, -83.35], MSP: [44.88, -93.22], JFK: [40.64, -73.78], SLC: [40.79, -111.98], SEA: [47.45, -122.31],
  EWR: [40.69, -74.17], ORD: [41.97, -87.91], IAD: [38.95, -77.46], DEN: [39.86, -104.67], SFO: [37.62, -122.38], IAH: [29.99, -95.34],
  DFW: [32.9, -97.04], CLT: [35.21, -80.95], MIA: [25.8, -80.29], PHL: [39.87, -75.24], MDW: [41.79, -87.75], BWI: [39.18, -76.67],
  LAS: [36.08, -115.15], BOS: [42.37, -71.01], FLL: [26.07, -80.15], PDX: [45.59, -122.6], HNL: [21.32, -157.92], YYZ: [43.68, -79.62],
  YUL: [45.47, -73.74], YVR: [49.2, -123.18], YYC: [51.13, -114.01], LIS: [38.78, -9.14], MAD: [40.49, -3.57], CDG: [49.01, 2.55],
  AMS: [52.31, 4.76], FRA: [50.04, 8.56], MUC: [48.35, 11.79], LHR: [51.47, -0.45], DUB: [53.42, -6.27], KEF: [63.99, -22.62],
  FCO: [41.8, 12.25], ZRH: [47.46, 8.55], VIE: [48.11, 16.57], CPH: [55.62, 12.65], ATH: [37.94, 23.94], IST: [41.26, 28.74],
  DXB: [25.25, 55.36], DOH: [25.27, 51.61], AMM: [31.72, 35.99], TLV: [32.01, 34.89], CMN: [33.37, -7.59], CAI: [30.12, 31.41],
  NBO: [-1.32, 36.93], ADD: [8.98, 38.8], NRT: [35.77, 140.39], HND: [35.55, 139.78], BKK: [13.69, 100.75], SIN: [1.36, 103.99],
  HKG: [22.31, 113.91], ICN: [37.46, 126.44], SYD: [-33.94, 151.18], AKL: [-37.01, 174.79], MEX: [19.44, -99.07], BOG: [4.7, -74.15],
  LIM: [-12.02, -77.11], SCL: [-33.39, -70.79], GRU: [-23.43, -46.47], PTY: [9.07, -79.38], EZE: [-34.82, -58.54],
};

/**
 * A connecting airport of this carrier that is roughly on the way (at most +30 % distance, +50 % on short routes) and
 * isn't either end of the trip, the least detour first (the hash picks between the best two), or none.
 */
function hubFor(airline: string, from: { code: string; lat: number; lng: number }, to: { code: string; lat: number; lng: number }, pick: number): string | undefined {
  const direct = haversineKm(from, to);
  const maxRatio = direct < 1500 ? 1.5 : 1.3;
  const ok = (HUBS[airline] ?? [])
    .filter((h) => h !== from.code && h !== to.code && HUB_AT[h])
    .map((h) => {
      const at = { lat: HUB_AT[h][0], lng: HUB_AT[h][1] };
      return { h, ratio: (haversineKm(from, at) + haversineKm(at, to)) / Math.max(1, direct) };
    })
    .filter((x) => x.ratio <= maxRatio)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, 2);
  return ok.length ? ok[Math.floor(pick * ok.length) % ok.length].h : undefined;
}

/** The big hubs whose long-haul routes are mostly nonstop. */
const NONSTOP_HUBS = new Set(["ATL", "ORD", "JFK", "EWR", "IAD", "BOS", "MIA", "DFW", "IAH", "LAX", "SFO", "SEA", "YYZ", "YUL", "YVR", "PHL", "CLT", "DTW", "MSP", "DEN"]);

// ---------- local clocks ----------
const pad = (n: number) => String(n).padStart(2, "0");
/** "2027-05-28", minutes since that midnight (may be ≥ 1440 or < 0) → "2027-05-29T07:55". */
function localAt(date: string, minutes: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + Math.round(minutes));
  return `${d.toISOString().slice(0, 10)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** Minutes of [start, end) (on some clock) that fall between 01:00 and 05:00 of any day. */
function nightMinutes(start: number, end: number): number {
  let n = 0;
  for (let day = Math.floor(start / 1440) - 1; day <= Math.floor(end / 1440) + 1; day++) {
    const a = day * 1440 + 60, b = day * 1440 + 300;
    n += Math.max(0, Math.min(end, b) - Math.max(start, a));
  }
  return n;
}
/** A red-eye spends at least this long airborne in the small hours. */
const RED_EYE_MIN = 90;

/** A time on a 5-minute grid between `from` and `to` (minutes), chosen by `u` ∈ [0,1). */
const slot = (u: number, from: number, to: number) => from + Math.floor(u * ((to - from) / 5 + 1)) * 5;

/** Round-trip fare for a distance before season and noise, in dollars. */
export function baseFareUsd(km: number): number {
  return 120 + 0.085 * km + Math.max(0, km - 8000) * 0.03;
}
/** Dollars → cents on a $5 grid, nudged off round $50s (a budget cap is always a multiple of $50). */
export function fareCents(usd: number, nudgeUp: boolean): number {
  let d = Math.max(89, Math.round(usd / 5) * 5);
  if (d % 50 === 0) d += nudgeUp ? 5 : -5;
  return d * 100;
}

/** The modelled options for one route and window (1–3), cheapest not necessarily first. */
export function modelFlights(ds: Dataset, cityId: CityId, origin: Origin, windowId: string): FlightOption[] {
  const ix = indexOf(ds);
  const city = ix.city.get(cityId), win = ix.window.get(windowId), from = airportOf(origin);
  if (!city || !win || !from) return [];
  const port = portOf(city);
  const idBase = `${cityId}-m-${origin.toLowerCase()}-${windowId.toLowerCase()}`;
  if (isHomePort(ds, origin, cityId)) {
    return [{
      _id: `${idBase}-home`, kind: "flight", cityId, origin, dateWindowId: windowId, airline: HOME_PORT_AIRLINE,
      departLocal: `${win.start}T09:00`, arriveLocal: `${win.start}T09:00`, returnLocal: `${win.end}T17:00`,
      stops: 0, redEye: false, priceCents: 0, modelled: true, homePort: true,
    }];
  }
  const h = (k: string) => hash01(`${idBase}|${k}`);
  const km = haversineKm(from, port);
  const shift = port.utcOffset - from.utcOffset; // hours the clock jumps, flying there
  const transpacific = ((city.region === "Asia" || city.region === "Oceania") && port.lng > 100) || (port.lng < -140 && km > 6000);
  const longHaulEast = !transpacific && km >= 4000 && shift >= 3;
  const nonstopOk = km <= 4500 || (NONSTOP_HUBS.has(origin) && km <= 12_500 && h("ns") < 0.7);
  const names = carriers(from, city);
  const season = seasonFactor(win);
  const base = baseFareUsd(km);

  // up to three shapes: the main option, a cheaper 1-stop, and (longer routes) a 2-stop budget fare or a rival nonstop
  const count = 1 + Math.floor(h("count") * 3);
  type Shape = { stops: 0 | 1 | 2; factor: number; alt: number };
  const shapes: Shape[] = [
    { stops: nonstopOk ? 0 : 1, factor: nonstopOk ? 1 : 0.94, alt: 0 },
    { stops: 1, factor: 0.86, alt: 1 },
    km > 1500 && h("budget") < 0.5 ? { stops: 2, factor: 0.72, alt: 2 } : { stops: nonstopOk ? 0 : 1, factor: 1.06, alt: 2 },
  ];
  const out: FlightOption[] = [];
  for (const s of shapes.slice(0, count)) {
    const i = s.alt;
    const u = (k: string) => h(`${k}${i}`);
    let airline = names[Math.floor(u("air") * names.length) % names.length] ?? "Delta";
    let label = airline;
    if (s.stops === 1) {
      // a carrier with a connecting hub that isn't either end (else a US major that has one)
      const withHub = [airline, ...names, ...US_MAJORS].find((a) => hubFor(a, from, port, u("hub")));
      airline = withHub ?? airline;
      const hub = hubFor(airline, from, port, u("hub"));
      label = hub ? `${airline} (via ${hub})` : airline;
    } else if (s.stops === 2) {
      label = "Budget (2 stops)";
    }
    const hours = (km / 800) * (s.stops ? 1.08 : 1) + 0.75 + s.stops * (1.5 + u("lay") * 1.5);
    const durMin = Math.round((hours * 60) / 5) * 5;
    // departure on the home clock (minutes after midnight of the window's first day)
    let dep: number;
    if (longHaulEast) dep = slot(u("dep"), 15 * 60 + 30, 22 * 60 + 30);
    else if (transpacific) dep = slot(u("dep"), 10 * 60 + 30, 14 * 60);
    else if (shift >= 2 && km >= 3000 && u("redeye") < 0.35) dep = slot(u("dep"), 21 * 60 + 30, 23 * 60 + 30); // transcon red-eye
    else dep = slot(u("dep"), 6 * 60, 19 * 60);
    const arrHome = dep + durMin; // on the home clock
    const ret = slot(u("ret"), 8 * 60, 17 * 60);
    out.push({
      _id: `${idBase}-${i}`, kind: "flight", cityId, origin, dateWindowId: windowId, airline: label,
      departLocal: localAt(win.start, dep), arriveLocal: localAt(win.start, arrHome + shift * 60), returnLocal: localAt(win.end, ret),
      // overnight: 90+ minutes airborne in the small hours of the traveller's home night, or (eastbound long-haul,
      // evening out, morning in) of the night at the far end
      stops: s.stops,
      redEye: nightMinutes(dep, arrHome) >= RED_EYE_MIN || (longHaulEast && nightMinutes(dep + shift * 60, arrHome + shift * 60) >= RED_EYE_MIN),
      priceCents: fareCents(base * season * s.factor * (0.92 + 0.16 * u("price")), u("nudge") < 0.5),
      modelled: true,
    });
  }
  return out;
}

// ---------- lookups ----------
const key = (cityId: string, origin: string, windowId: string) => `${cityId}|${origin}|${windowId}`;
/** Curated flights by (port, home airport, window). */
const curatedIndex = perDataset((ds) => {
  const m = new Map<string, FlightOption[]>();
  for (const f of ds.flights) {
    const k = key(f.cityId, f.origin, f.dateWindowId);
    const l = m.get(k);
    if (l) l.push(f); else m.set(k, [f]);
  }
  return m;
});
const modelledCache = perDataset(() => new Map<string, FlightOption[]>());

/** The options for one member's route in one window: the curated listings if any, else the model's. */
export function flightsFor(ds: Dataset, cityId: CityId, origin: Origin, windowId: string): readonly FlightOption[] {
  const k = key(cityId, origin, windowId);
  const curated = curatedIndex(ds).get(k);
  if (curated) return curated;
  const cache = modelledCache(ds);
  let m = cache.get(k);
  if (!m) cache.set(k, (m = modelFlights(ds, cityId, origin, windowId)));
  return m;
}

/** Every option any home airport has to this port in this window (public facts: the listings, all origins). */
export function publicFlights(ds: Dataset, cityId: CityId, windowId: string): FlightOption[] {
  return ORIGINS.flatMap((o) => flightsFor(ds, cityId, o, windowId));
}
