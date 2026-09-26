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
 *   budget   at most PREFETCH_CONCURRENCY searches at once, and at most ROUTESTACK_PREFETCH_MAX (≤ the voyage's
 *            ROUTESTACK_TRIP_CAP) searches per voyage (billed or cached). Searches go in whole port × window sets (the stay and
 *            every home airport's fare: a plan is "live" only when all of them are), in the order the chart book
 *            ranks them (then the pre-rank's other ports and windows); a set that doesn't fit what's left is skipped.
 *            Stays go first (they fix a plan's identity at Watch 1; fares can still re-price it later)
 *   landing  each result re-prices the table as it lands (table.ts `repriceLive`), not only when the batch ends
 *   logging  one summary line per prefetch (planned / answered / refused / billed / cached, and what was skipped),
 *            and `explain` says why the chart book's plans stayed estimated
 *   off      ROUTESTACK_MODE=off / no keys, and the scripted Expo voyage (curated only, its numbers are fixed)
 */
import type { City, CityId, Plan } from "@all-ayes/shared";
import { config } from "../config.js";
import { indexOf } from "../data/loader.js";
import { isHomePort } from "../fit/flights.js";
import { emptyInventory, liveFlightKey, liveHotelKey, type LiveFlight, type LiveInventory, type LiveStay } from "../fit/live.js";
import { buildChartBook, usableWindows, type PricingMember } from "../fit/pricing.js";
import { rankPorts } from "../fit/prerank.js";
import { liveFlights, liveHotels, type LiveFlightOption, type LiveFlightsQuery, type LiveHotelOption, type LiveHotelsQuery } from "../providers/routestack/index.js";
import { tripSpent, withTrip } from "../util/limits.js";
import type { TripRec } from "./records.js";
import type { Helm } from "./core.js";

export const PREFETCH_CONCURRENCY = 4;
/** The chart book size the prefetch ranks port × window sets by (table.ts CHART_BOOK_LIMIT). */
const RANK_BOOK_LIMIT = 12;
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
/** Why a search wasn't sent: over the voyage's prefetch budget, or fares not on sale yet. */
type Skip = "budget" | "horizon";

/**
 * A prefetch's outcome: searches planned, answered (options or none), refused (fell back to curated / modelled),
 * billed (counted on the voyage) and skipped (over budget / past the fares' horizon).
 */
export interface PrefetchReport { planned: number; landed: number; refused: number; billed: number; trimmed: boolean; skipped: number; ms: number }

/** The voyage's prefetch budget: ROUTESTACK_PREFETCH_MAX, never above the voyage cap. */
export const prefetchBudget = () => Math.min(config.routestack.prefetchMax(), config.limits.spend.trip.routestack);

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
  /** Per voyage: searches the latest plan left out, and why (for `explain`). */
  private skipped = new Map<string, Map<string, Skip>>();
  /** Per voyage: searches the prefetch planned (billed or answered from the cache): the prefetch budget counts these. */
  private sent = new Map<string, number>();

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
    this.skipped.delete(tripId);
    this.sent.delete(tripId);
  }

  /**
   * Starts (never awaits for the caller) the prefetch for the voyage's current ports and the crew's windows. Returns
   * the batch's promise, which never rejects. When anything new lands, the table re-prices (if it still may).
   */
  prefetch(t: TripRec, crew: PricingMember[]): Promise<PrefetchReport> {
    const empty: PrefetchReport = { planned: 0, landed: 0, refused: 0, billed: 0, trimmed: false, skipped: 0, ms: 0 };
    if (!this.enabledFor(t) || !crew.length || !t.candidateCityIds.length) return Promise.resolve(empty);
    const started = Date.now();
    const batch = withTrip(t._id, async (): Promise<PrefetchReport> => {
      try {
        const { jobs, trimmed, skipped } = this.plan(t, crew);
        const spentBefore = tripSpent("routestack", t._id);
        let landed = 0, refused = 0;
        await pool(jobs, PREFETCH_CONCURRENCY, async (j) => {
          if (!(await this.runJob(t._id, j))) { refused++; return; }
          landed++;
          // each result re-prices the table as it lands: a stay landing while the Captain opens joins the chart book
          // (from Watch 1 a plan's stay is fixed), a fare can still turn a plan live until the Captain decides
          try { this.helm.table.repriceLive(this.helm.trips.get(t._id) ?? t); } catch (e) { console.warn(`[live] voyage ${t._id}: re-pricing failed`, (e as Error).message); }
        });
        // (another prefetch of this voyage running at the same time would be counted here too; they skip each other's searches)
        const billed = tripSpent("routestack", t._id) - spentBefore;
        const report: PrefetchReport = { planned: jobs.length, landed, refused, billed, trimmed, skipped, ms: Date.now() - started };
        if ((jobs.length || skipped) && !process.env.VITEST) console.info(prefetchLine(t._id, report));
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

  /**
   * The searches still to run for this voyage, within its prefetch budget: whole port × window sets (the stay and
   * every home airport's fare) in the order the chart book ranks them, then the pre-rank's other ports and windows;
   * stays first. `skipped` counts what didn't fit (or isn't on sale yet).
   */
  plan(t: TripRec, crew: PricingMember[]): { jobs: Job[]; trimmed: boolean; skipped: number } {
    const ds = this.helm.ds;
    const ix = indexOf(ds);
    // a date-range voyage: its generated windows' exact dates (fit/windows.ts); else the dataset windows the crew named
    const offered = this.helm.table.offered(t);
    const windows = usableWindows(ds, crew, offered).map((id) => ix.window.get(id)).filter((w): w is NonNullable<typeof w> => Boolean(w));
    if (!windows.length) return { jobs: [], trimmed: false, skipped: 0 };
    const ranked = rankPorts(ds, crew, t.candidateCityIds, windows.map((w) => w.id), t._id).map((p) => p.cityId);
    // ports the pre-rank can't score (no stay for this crew) still get flights priced if they're on the chart
    const ports = [...ranked, ...t.candidateCityIds.filter((c) => !ranked.includes(c))];
    // the order the table will see them: the chart book as it would be built now (its plans' ports and windows)
    const units: { cityId: CityId; windowId: string }[] = [];
    const seen = new Set<string>();
    const addUnit = (cityId: CityId, windowId: string) => {
      const k = `${cityId}|${windowId}`;
      if (seen.has(k) || !ports.includes(cityId) || !windows.some((w) => w.id === windowId)) return;
      seen.add(k);
      units.push({ cityId, windowId });
    };
    try {
      for (const p of buildChartBook(ds, crew, t.candidateCityIds, RANK_BOOK_LIMIT, this.inventory(t), offered)) addUnit(p.cityId, p.dateWindowId);
    } catch { /* a port the pricing can't build: the pre-rank order below still covers it */ }
    for (const w of windows) for (const c of ports) addUnit(c, w.id);

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
    const recentlyFailed = (k: string) => now - (failed?.get(k) ?? -Infinity) < RETRY_AFTER_MS;
    const pending = (j: Job) => !done.has(j.key) && !flying.has(j.key) && !queued.has(j.key) && !recentlyFailed(j.key);

    const skips = new Map<string, Skip>();
    let left = Math.max(0, prefetchBudget() - Math.max(tripSpent("routestack", t._id), this.sent.get(t._id) ?? 0));
    const hotels: Job[] = [], fares: Job[] = [];
    for (const u of units) {
      const city = ix.city.get(u.cityId);
      const w = windows.find((x) => x.id === u.windowId);
      if (!city || !w) continue;
      const set: Job[] = [this.hotelJob(t, city, w.id, w.start, w.end, crew.length)];
      const iata = city.airport?.code;
      if (iata && /^[A-Z]{3}$/.test(iata)) {
        for (const [origin, adults] of byCount) {
          if (origin === iata || isHomePort(ds, origin, u.cityId)) continue;
          const f = this.flightJob(t, city, iata, origin, adults, w.id, w.start, w.end);
          if (w.start > horizon) skips.set(f.key, "horizon");
          else set.push(f);
        }
      }
      const todo = set.filter(pending);
      if (!todo.length) continue;
      if (todo.length > left) { for (const j of todo) skips.set(j.key, "budget"); continue; }
      left -= todo.length;
      for (const j of todo) (j.kind === "hotels" ? hotels : fares).push(j);
    }
    const jobs = [...hotels, ...fares];
    for (const j of jobs) queued.add(j.key);
    this.sent.set(t._id, (this.sent.get(t._id) ?? 0) + jobs.length);
    this.skipped.set(t._id, skips);
    const overBudget = [...skips.values()].filter((v) => v === "budget").length;
    return { jobs, trimmed: overBudget > 0, skipped: skips.size };
  }

  /**
   * One line saying why the chart book's estimated plans aren't live (the first few distinct port × window pairs):
   * the stay or a home airport's fare not searched (budget / horizon), still pending, refused, answered with nothing
   * usable (outside the band, a broken rule), or a live stay that landed after the plans were fixed. Home airports
   * are named by code only (server log; never a payload).
   */
  explain(t: TripRec, plans: Plan[], crew: PricingMember[]): string {
    const live = this.inventory(t);
    const est = plans.filter((p) => p.priceSource !== "live");
    if (!est.length) return "every plan is live";
    const ds = this.helm.ds, ix = indexOf(ds);
    const stateOf = (key: string): string => {
      if (this.done.get(t._id)?.has(key)) return "answered";
      if (this.inflight.get(t._id)?.has(key) || this.queued.get(t._id)?.has(key)) return "pending";
      if (this.failed.get(t._id)?.has(key)) return "refused";
      const skip = this.skipped.get(t._id)?.get(key);
      return skip ? `not searched (${skip})` : "not searched";
    };
    const origins = [...new Set(crew.map((m) => m.origin))].sort();
    const seen = new Set<string>(), parts: string[] = [];
    for (const p of est) {
      const k = `${p.cityId}|${p.dateWindowId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > 4) break;
      const why: string[] = [];
      if (!p.stay) { // a curated stay (a live one is carried on the plan)
        const hk = `h|${liveHotelKey(p.cityId, p.dateWindowId, crew.length)}`;
        const st = stateOf(hk);
        const landed = live?.hotels.get(liveHotelKey(p.cityId, p.dateWindowId, crew.length));
        why.push(st === "answered" ? (landed?.length ? "curated stay (live stays landed after the plans were fixed)" : "stay search found nothing") : `stay ${st}`);
      }
      const iata = ix.city.get(p.cityId)?.airport?.code;
      for (const o of origins) {
        if (o === iata || isHomePort(ds, o, p.cityId)) continue;
        const fk = `f|${liveFlightKey(p.cityId, p.dateWindowId, o)}`;
        const st = stateOf(fk);
        if (st !== "answered") why.push(`${o} fare ${st}`);
        else if (!live?.flights.get(liveFlightKey(p.cityId, p.dateWindowId, o))?.length) why.push(`${o} fare search found nothing`);
      }
      if (!why.length) why.push("live fares outside the band or breaking a rule");
      parts.push(`${p.cityId} ${p.dateWindowId}: ${why.join(", ")}`);
    }
    return `${est.length}/${plans.length} estimated — ${parts.join("; ")}`;
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

/** The per-prefetch summary line (info level). */
export function prefetchLine(tripId: string, r: PrefetchReport): string {
  const cached = Math.max(0, r.landed + r.refused - r.billed);
  return `[live] voyage ${tripId}: prefetch ${r.planned} searches: ${r.landed} answered, ${r.refused} refused, ${r.billed} billed, ${cached} cached/free`
    + `${r.skipped ? `, ${r.skipped} skipped${r.trimmed ? ` (prefetch budget ${prefetchBudget()})` : " (fares not on sale yet)"}` : ""} in ${r.ms} ms`;
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
