/**
 * Live prices for a voyage (docs/12-routestack.md "Wiring"): a background prefetch of RouteStack stays and fares for
 * the voyage's ports and windows, kept in a per-voyage overlay (never in the shared Dataset), which the chart book
 * prefers over curated / modelled options. The table never waits on it: what hasn't landed when the chart book is
 * built is priced as estimated, and results that land while the table is still arguing re-price its plans (table.ts
 * `repriceLive`) — never once the Captain is deciding, in the Dry Run or after the pick.
 *
 *   hotels   one search per port × window, for the whole crew (the provider's rooming rule: rooms of two from 4 up)
 *   flights  one search per port × window × distinct home airport (adults = members flying from it), home ports and
 *            windows past the airlines' sales horizon (FLIGHT_HORIZON_DAYS) skipped
 *   retries  a search that fell back isn't repeated for the voyage for RETRY_AFTER_MS (it may have been billed)
 *   budget   at most PREFETCH_CONCURRENCY searches at once; the voyage's RouteStack cap (ROUTESTACK_TRIP_CAP) is
 *            respected: when the full set would exceed what's left, only the top 2 ranked ports × the crew's common
 *            window are fetched (and at most what's left)
 *   off      ROUTESTACK_MODE=off / no keys, and the scripted Expo voyage (curated only, its numbers are fixed)
 */
import type { City, CityId } from "@all-ayes/shared";
import { config } from "../config.js";
import { indexOf } from "../data/loader.js";
import { isHomePort } from "../fit/flights.js";
import { emptyInventory, liveFlightKey, liveHotelKey, type LiveFlight, type LiveInventory, type LiveStay } from "../fit/live.js";
import { usableWindows, type PricingMember } from "../fit/pricing.js";
import { rankPorts } from "../fit/prerank.js";
import { liveFlights, liveHotels, type LiveFlightOption, type LiveFlightsQuery, type LiveHotelOption, type LiveHotelsQuery } from "../providers/routestack/index.js";
import { tripSpent, withTrip } from "../util/limits.js";
import type { TripRec } from "./records.js";
import type { Helm } from "./core.js";

export const PREFETCH_CONCURRENCY = 4;
/** When the full set doesn't fit the voyage's budget: this many top-ranked ports, the common window only. */
export const PREFETCH_TOP_PORTS = 2;
/**
 * Fares aren't on sale this far ahead: the sandbox refused every search departing 377 days out (TOOL_ERROR) and
 * answered 167 days out (2026-09-26); airlines open sales ~330 days ahead. Such searches are skipped, not billed.
 */
export const FLIGHT_HORIZON_DAYS = 330;
/** A search that fell back (null) isn't sent again for this voyage for this long (a refused search may be billed). */
export const RETRY_AFTER_MS = 10 * 60_000;

/** What the prefetch calls (the RouteStack provider; tests swap in a fake — never the network in tests). */
export interface LiveProvider {
  /** "off" (no keys / ROUTESTACK_MODE=off), else the gateway. */
  mode(): "off" | "sandbox" | "live";
  hotels(q: LiveHotelsQuery): Promise<LiveHotelOption[] | null>;
  flights(q: LiveFlightsQuery): Promise<LiveFlightOption[] | null>;
}
export const routestackProvider: LiveProvider = { mode: () => config.routestack.mode(), hotels: liveHotels, flights: liveFlights };

type Job = { key: string; kind: "hotels" | "flights"; run: () => Promise<boolean> };

/** A prefetch's outcome: searches planned, answered (options or none), and billed (cache misses counted on the voyage). */
export interface PrefetchReport { planned: number; landed: number; billed: number; trimmed: boolean; ms: number }

export class LivePrices {
  provider: LiveProvider = routestackProvider;
  /** Per voyage: jobs that landed (never fetched again for this voyage) and jobs in flight. */
  private done = new Map<string, Set<string>>();
  private inflight = new Map<string, Map<string, Promise<boolean>>>();
  /** Per voyage: searches planned by a running prefetch and not finished yet (a second prefetch leaves them to it). */
  private queued = new Map<string, Set<string>>();
  /** Per voyage: searches that fell back, and when. */
  private failed = new Map<string, Map<string, number>>();
  /** Per voyage: the prefetches still running (a second one skips searches the first has in flight). */
  private batches = new Map<string, Set<Promise<PrefetchReport>>>();

  constructor(private helm: Helm) {}

  /** Live prices apply to this voyage: RouteStack is on and the voyage isn't the curated-only Expo scenario. */
  enabledFor(t: TripRec): boolean {
    return this.provider.mode() !== "off" && !t.curatedOnly;
  }

  /** The voyage's live overlay, or undefined (none yet, off, or Expo). */
  inventory(t: TripRec): LiveInventory | undefined {
    return this.enabledFor(t) ? this.helm.liveInventory.get(t._id) : undefined;
  }

  /** Resolves once every prefetch of this voyage running now has finished, with the first one's report (tests, the live check). */
  async settled(tripId: string): Promise<PrefetchReport | undefined> {
    const running = [...(this.batches.get(tripId) ?? [])];
    return running.length ? (await Promise.all(running))[0] : undefined;
  }

  forget(tripId: string) {
    this.done.delete(tripId);
    this.inflight.delete(tripId);
    this.queued.delete(tripId);
    this.failed.delete(tripId);
    this.batches.delete(tripId);
  }

  /**
   * Starts (never awaits for the caller) the prefetch for the voyage's current ports and the crew's windows. Returns
   * the batch's promise, which never rejects. When anything new lands, the table re-prices (if it still may).
   */
  prefetch(t: TripRec, crew: PricingMember[]): Promise<PrefetchReport> {
    const empty: PrefetchReport = { planned: 0, landed: 0, billed: 0, trimmed: false, ms: 0 };
    if (!this.enabledFor(t) || !crew.length || !t.candidateCityIds.length) return Promise.resolve(empty);
    const started = Date.now();
    const batch = withTrip(t._id, async (): Promise<PrefetchReport> => {
      try {
        const { jobs, trimmed } = this.plan(t, crew);
        const spentBefore = tripSpent("routestack", t._id);
        let landed = 0;
        await pool(jobs, PREFETCH_CONCURRENCY, async (j) => { if (await this.runJob(t._id, j)) landed++; });
        // (another prefetch of this voyage running at the same time would be counted here too; they skip each other's searches)
        const report: PrefetchReport = { planned: jobs.length, landed, billed: tripSpent("routestack", t._id) - spentBefore, trimmed, ms: Date.now() - started };
        if (jobs.length && !process.env.VITEST) console.log(`[live] voyage ${t._id}: ${landed}/${jobs.length} live searches answered in ${report.ms} ms, ${report.billed} billed${trimmed ? " (trimmed to the voyage budget)" : ""}`);
        if (landed) {
          try { this.helm.table.repriceLive(t); } catch (e) { console.warn(`[live] voyage ${t._id}: re-pricing failed`, (e as Error).message); }
        }
        return report;
      } catch (e) {
        console.warn(`[live] voyage ${t._id}: prefetch failed`, (e as Error).message);
        return empty;
      }
    });
    let set = this.batches.get(t._id);
    if (!set) this.batches.set(t._id, (set = new Set()));
    set.add(batch);
    void batch.finally(() => { set.delete(batch); if (!set.size && this.batches.get(t._id) === set) this.batches.delete(t._id); });
    return batch;
  }

  /** The searches still to run for this voyage, trimmed to its budget. */
  plan(t: TripRec, crew: PricingMember[]): { jobs: Job[]; trimmed: boolean } {
    const ds = this.helm.ds;
    const ix = indexOf(ds);
    // a date-range voyage: its generated windows' exact dates (fit/windows.ts); else the dataset windows the crew named
    const windows = usableWindows(ds, crew, this.helm.table.offered(t)).map((id) => ix.window.get(id)).filter((w): w is NonNullable<typeof w> => Boolean(w));
    if (!windows.length) return { jobs: [], trimmed: false };
    const ranked = rankPorts(ds, crew, t.candidateCityIds, windows.map((w) => w.id), t._id).map((p) => p.cityId);
    // ports the pre-rank can't score (no stay for this crew) still get flights priced if they're on the chart
    const ports = [...ranked, ...t.candidateCityIds.filter((c) => !ranked.includes(c))];
    const origins = new Map<string, number>();
    for (const m of crew) origins.set(m.origin, (origins.get(m.origin) ?? 0) + 1);
    const byCount = [...origins.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!this.helm.liveInventory.has(t._id)) this.done.delete(t._id); // the overlay was dropped (eviction): fetch again
    const done = this.done.get(t._id) ?? new Set<string>();
    const flying = this.inflight.get(t._id) ?? new Map<string, Promise<boolean>>();
    const failed = this.failed.get(t._id);
    const now = Date.now();
    const horizon = new Date(now + FLIGHT_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
    let queued = this.queued.get(t._id);
    if (!queued) this.queued.set(t._id, (queued = new Set()));

    const jobsFor = (cityIds: CityId[], wins: typeof windows): Job[] => {
      const out: Job[] = [];
      for (const cityId of cityIds) {
        const city = ix.city.get(cityId);
        if (!city) continue;
        for (const w of wins) {
          out.push(this.hotelJob(t, city, w.id, w.start, w.end, crew.length));
          const iata = city.airport?.code;
          if (!iata || !/^[A-Z]{3}$/.test(iata) || w.start > horizon) continue;
          for (const [origin, adults] of byCount) {
            if (origin === iata || isHomePort(ds, origin, cityId)) continue;
            out.push(this.flightJob(t, city, iata, origin, adults, w.id, w.start, w.end));
          }
        }
      }
      const recentlyFailed = (k: string) => now - (failed?.get(k) ?? -Infinity) < RETRY_AFTER_MS;
      return out.filter((j) => !done.has(j.key) && !flying.has(j.key) && !queued.has(j.key) && !recentlyFailed(j.key));
    };

    const left = Math.max(0, config.limits.spend.trip.routestack - tripSpent("routestack", t._id));
    let jobs = jobsFor(ports, windows);
    let trimmed = false;
    if (jobs.length > left) {
      trimmed = true;
      jobs = jobsFor(ports.slice(0, PREFETCH_TOP_PORTS), windows.slice(0, 1)).slice(0, left);
    }
    for (const j of jobs) queued.add(j.key);
    return { jobs, trimmed };
  }

  private hotelJob(t: TripRec, city: City, windowId: string, checkIn: string, checkOut: string, guests: number): Job {
    const key = `h|${liveHotelKey(city._id, windowId, guests)}`;
    return {
      key, kind: "hotels",
      run: async () => {
        const got = await this.provider.hotels({ cityName: city.name, cityId: city._id, lat: city.centerLat, lng: city.centerLng, checkIn, checkOut, guests, tripId: t._id });
        if (!got) return false;
        this.store(t._id).hotels.set(liveHotelKey(city._id, windowId, guests), got.map((h) => toStay(h, city)));
        return true;
      },
    };
  }

  private flightJob(t: TripRec, city: City, iata: string, origin: string, adults: number, windowId: string, depart: string, ret: string): Job {
    const key = `f|${liveFlightKey(city._id, windowId, origin)}`;
    return {
      key, kind: "flights",
      run: async () => {
        const got = await this.provider.flights({ origin, destinationIata: iata, depart, return: ret, adults, cityId: city._id, dateWindowId: windowId, tripId: t._id });
        if (!got) return false;
        this.store(t._id).flights.set(liveFlightKey(city._id, windowId, origin), got.map((f): LiveFlight => ({ ...f, cityId: city._id, origin, dateWindowId: windowId })));
        return true;
      },
    };
  }

  private store(tripId: string): LiveInventory {
    let inv = this.helm.liveInventory.get(tripId);
    const mode = this.provider.mode();
    if (!inv) this.helm.liveInventory.set(tripId, (inv = emptyInventory(mode === "live" ? "live" : "sandbox")));
    inv.updatedAt = Date.now();
    return inv;
  }

  /** One search, shared with a concurrent identical one; true when it returned options (even none). */
  private async runJob(tripId: string, j: Job): Promise<boolean> {
    let flying = this.inflight.get(tripId);
    if (!flying) this.inflight.set(tripId, (flying = new Map()));
    const running = flying.get(j.key);
    if (running) return running;
    const t0 = Date.now();
    const p = j.run().catch(() => false);
    if (!process.env.VITEST) void p.then((ok) => console.log(`[live] voyage ${tripId}: ${j.kind} ${j.key.slice(2)} ${ok ? "answered" : "fell back"} in ${Date.now() - t0} ms`));
    flying.set(j.key, p);
    try {
      const ok = await p;
      if (ok) {
        let done = this.done.get(tripId);
        if (!done) this.done.set(tripId, (done = new Set()));
        done.add(j.key);
      } else {
        let failed = this.failed.get(tripId);
        if (!failed) this.failed.set(tripId, (failed = new Map()));
        failed.set(j.key, Date.now());
      }
      return ok;
    } finally {
      flying.delete(j.key);
      this.queued.get(tripId)?.delete(j.key);
    }
  }
}

/**
 * A provider stay → a stay the plans can use. RouteStack's list has no coordinates (the provider places it roughly by
 * distance, `approxLocation`), so walking legs and the public map use the port's centre; the distance is kept and
 * named in place of the missing neighbourhood.
 */
export function toStay(h: LiveHotelOption, city: City): LiveStay {
  const km = h.distanceKm;
  const neighborhood = h.neighborhood || (km !== undefined ? (km < 1 ? "Near the centre" : `${km.toFixed(1)} km from the centre`) : "City centre");
  return {
    ...h, cityId: city._id, neighborhood,
    ...(h.approxLocation ? { lat: city.centerLat, lng: city.centerLng } : {}),
  };
}

/** Runs `fn` over `items`, at most `n` at a time. */
export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
