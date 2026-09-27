// Chart-room pins (docs/03 §4): a pinch on the globe → the nearest charted port → the voyage's course
// (`course:set`, the same effect as the phone's Create screen). A held pinch pins that port's whole region
// ("Anywhere in Europe"); a pinch on a pin takes it off. Pure: XRApp sends what this decides.
import { MAX_PORTS, MIN_PORTS, REGIONS, type Destination, type Region, type TripState } from "@all-ayes/shared";
import { distanceKm, nearestPort } from "../scene/geo";

export interface PinPort { cityId: string; name: string; lat?: number; lng?: number; region?: Region; state?: string }

export type PinResult =
  | { kind: "set"; destination: Destination; say: string }
  | { kind: "pending"; cityId: string; say: string }
  | { kind: "note"; say: string };

/** A pinch this close to a pin (km) takes that pin off. */
export const UNPIN_KM = 450;
/** A pinch finds a port within this distance (km). */
export const PIN_KM = 900;

/** The region a port stands for (a US state's port: "United States"). */
export function regionOf(p: PinPort): Region | null {
  if (p.region && (REGIONS as readonly string[]).includes(p.region)) return p.region;
  return p.state ? "United States" : null;
}

/**
 * What a pinch at `at` does. `pending`: a first pin on a regions / anywhere voyage, waiting for its partner (a named
 * course needs MIN_PORTS). `long`: a held pinch (the region).
 */
export function pinAt(at: { lat: number; lng: number }, long: boolean, trip: TripState, ports: readonly PinPort[], pending: string | null): PinResult {
  const d = trip.destination;
  const named = !d || d.kind === "cities";
  const pins = trip.candidateCities;
  if (!long && named) {
    const hit = pins.find((c) => distanceKm(at, c) <= UNPIN_KM);
    if (hit) {
      const rest = pins.filter((c) => c.cityId !== hit.cityId).map((c) => c.cityId);
      if (rest.length < MIN_PORTS) return { kind: "note", say: `Keep at least ${MIN_PORTS} ports on the chart, or hold a pinch for a region.` };
      return { kind: "set", destination: { kind: "cities", cityIds: rest }, say: `${hit.name} is off the chart.` };
    }
  }
  const port = nearestPort(at, ports, PIN_KM);
  if (!port) return { kind: "note", say: "No charted port near there. Try closer to a city." };
  if (long) {
    const region = regionOf(port);
    if (!region) return { kind: "note", say: `${port.name} isn't in a region on the chart.` };
    const now = d?.kind === "regions" ? d.regions ?? [] : [];
    if (now.includes(region)) return { kind: "note", say: `${region} is already on the chart.` };
    return { kind: "set", destination: { kind: "regions", regions: [...now, region], ...(d?.kind === "regions" && d.states ? { states: d.states } : {}) }, say: `Anywhere in ${region}.` };
  }
  if (named) {
    const ids = pins.map((c) => c.cityId);
    if (ids.includes(port.cityId)) return { kind: "note", say: `${port.name} is already pinned.` };
    if (ids.length >= MAX_PORTS) return { kind: "note", say: `At most ${MAX_PORTS} ports on one chart. Take one off first.` };
    return { kind: "set", destination: { kind: "cities", cityIds: [...ids, port.cityId] }, say: `Pinned ${port.name}.` };
  }
  // a regions / anywhere voyage: named ports need two, so the first waits for the second
  if (pending && pending !== port.cityId) {
    return { kind: "set", destination: { kind: "cities", cityIds: [pending, port.cityId] }, say: `Pinned ${port.name}: the chart now has named ports.` };
  }
  return { kind: "pending", cityId: port.cityId, say: `Pinned ${port.name}. Pin one more port to chart named ports.` };
}
