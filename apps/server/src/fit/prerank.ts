/**
 * Pre-rank (docs/05-agent-spec.md §2.0): for a voyage set to regions or "anywhere", every port in scope is scored for
 * this crew when the table meets, and the top 4 go on the chart (the chart book then holds at most 12 plans).
 * A cheap heuristic, deterministic for a voyage (the only noise is a hash of the voyage id and the port):
 *
 *   wishes     each member's must-have coverage among the port's activities (40 points at full coverage)
 *   cost       a rough all-in share (cheapest route option, cheapest stay that sleeps the crew split evenly, the group
 *              moments and two picks) against the member's cap: up to +25 well under it, down to −70 far over it
 *   dealbreakers  −25 for each one the port's best flight breaks; −30 when every stay is a hostel for a no-hostel
 *              member; −8 for hills when long walks are out
 *   places     +18 for a place the member would love (the port, its region or state), −35 for one they'd skip
 *   season     −6 for beach / outdoors wishes in a port's cold months
 *
 * A port's score is the crew's mean plus half its lowest member (a port one member can't do sinks). Ports whose
 * stays can't sleep the crew are left out. Caps never leave this function: only the ranking does.
 */
import type { City, CityId, Dataset } from "@all-ayes/shared";
import { indexOf } from "../data/loader.js";
import { chooseFlight, type PricingMember } from "./pricing.js";
import { hash01 } from "./flights.js";

/** How many ports the table puts on the chart from a region / anywhere scope. */
export const PRERANK_PORTS = 4;

export interface PortScore { cityId: CityId; score: number }

const namesPort = (entry: string, c: City) => entry === c._id || entry === c.region || entry === c.state;

/** Is this month cold at the port? (Northern winter above 35°N, southern winter below 35°S.) */
function coldMonth(c: City, month: number): boolean {
  if (c.centerLat > 35) return month === 12 || month <= 3;
  if (c.centerLat < -35) return month >= 6 && month <= 8;
  return false;
}

/** Windows the most members can do (all of them when nobody's brief names one of these). */
function commonWindows(crew: PricingMember[], windowIds: string[]): string[] {
  const counts = windowIds.map((id) => ({ id, n: crew.filter((m) => m.brief.dateWindowIds.includes(id)).length }));
  const best = Math.max(0, ...counts.map((c) => c.n));
  return best ? counts.filter((c) => c.n === best).map((c) => c.id) : windowIds;
}

/** One member's score for a port in one window. */
function memberScore(ds: Dataset, c: City, m: PricingMember, windowId: string, crewSize: number, noHostel: boolean): number {
  const ix = indexOf(ds);
  const win = ix.window.get(windowId);
  const acts = ix.activitiesOf(c._id);
  const tags = new Set(acts.flatMap((a) => a.tags));
  const wants = m.brief.mustHaves;
  let score = 40 * (wants.length ? wants.filter((t) => tags.has(t)).length / wants.length : 1);

  const { flight, violates } = chooseFlight(ds, m, c._id, windowId);
  if (!flight) score -= 60;
  score -= 25 * violates.length;

  const stays = ix.hotelsOf(c._id).filter((h) => h.sleeps >= crewSize);
  const usable = noHostel ? stays.filter((h) => h.stayType !== "hostel") : stays;
  if (noHostel && m.brief.dealbreakers.includes("hostel") && stays.length && !usable.length) score -= 30;
  const nightly = Math.min(...(usable.length ? usable : stays).map((h) => h.nightlyCents));
  const groups = acts.filter((a) => a.role === "group").slice(0, 2).reduce((s, a) => s + a.priceCents, 0);
  const picks = acts.filter((a) => a.role === "pick").map((a) => a.priceCents).sort((a, b) => a - b).slice(0, 2).reduce((s, x) => s + x, 0);
  const est = (flight?.priceCents ?? 0) + (nightly * (win?.nights ?? 4)) / crewSize + groups + picks;
  const ratio = est / Math.max(1, m.brief.capCents);
  score += ratio <= 1 ? 10 + 15 * (1 - ratio) : -10 - 40 * Math.min(1.5, ratio - 1);

  if (m.brief.dealbreakers.includes("long_walks") && (c.hilly?.length ?? 0) > 0) score -= 8;
  for (const l of m.brief.loves ?? []) if (namesPort(l, c)) score += 18;
  for (const s of m.brief.skips ?? []) if (namesPort(s, c)) score -= 35;
  if (win && coldMonth(c, Number(win.start.slice(5, 7))) && wants.some((t) => t === "beach" || t === "nature")) score -= 6;
  return score;
}

/** Every port in `cityIds` scored for this crew, best first. `salt` (the voyage id) breaks near-ties. */
export function rankPorts(ds: Dataset, crew: PricingMember[], cityIds: CityId[], windowIds: string[], salt: string): PortScore[] {
  const ix = indexOf(ds);
  const noHostel = crew.some((m) => m.brief.dealbreakers.includes("hostel"));
  const windows = commonWindows(crew, windowIds);
  const out: PortScore[] = [];
  for (const id of cityIds) {
    const c = ix.city.get(id);
    if (!c || !crew.length) continue;
    if (!ix.hotelsOf(id).some((h) => h.sleeps >= crew.length && !(noHostel && h.stayType === "hostel"))) continue; // no plan possible
    let best = -Infinity;
    for (const w of windows) {
      const s = crew.map((m) => memberScore(ds, c, m, w, crew.length, noHostel));
      best = Math.max(best, s.reduce((a, b) => a + b, 0) / s.length + 0.5 * Math.min(...s));
    }
    out.push({ cityId: id, score: best + 6 * hash01(`${salt}|${id}`) });
  }
  return out.sort((a, b) => b.score - a.score || a.cityId.localeCompare(b.cityId));
}

/** The ports for the chart: the top PRERANK_PORTS of the scope. */
export function pickPorts(ds: Dataset, crew: PricingMember[], cityIds: CityId[], windowIds: string[], salt: string, n = PRERANK_PORTS): CityId[] {
  return rankPorts(ds, crew, cityIds, windowIds, salt).slice(0, n).map((p) => p.cityId);
}
