import type { Dataset, TravelLeg, TravelMode } from "@all-ayes/shared";
import { LONG_WALK_MIN } from "@all-ayes/shared";
import { indexOf } from "../data/loader.js";

export interface Point { id: string; lat: number; lng: number }

/**
 * Places in Lisbon on the hills (doc 07 §7 hillFactor). O2-033: this belongs in dataset.json with each place; moving
 * it changes the dataset's hash (TR5-022 drift warnings for every stored voyage), so it waits for the next dataset change.
 */
const HILLY = new Set(["LIS-h-casa-alfama", "LIS-a-tram-castle", "LIS-a-fado", "LIS-a-bairro-night", "LIS-h-bairro-hostel"]);

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Travel time between two places: dataset override first, then the doc 07 §7 model. */
export function travel(ds: Dataset, from: Point, to: Point): TravelLeg {
  const ov = indexOf(ds).override(from.id, to.id); // either direction, first listed wins (O(1))
  let mode: TravelMode;
  let minutes: number;
  if (ov) {
    mode = ov.mode;
    minutes = ov.minutes;
  } else {
    const km = haversineKm(from, to);
    if (km <= 2.0) {
      mode = "walk";
      const hill = HILLY.has(from.id) || HILLY.has(to.id) ? 1.4 : 1.0;
      minutes = Math.max(1, Math.round(((km * 1.3) / 4.8) * 60 * hill));
    } else if (km <= 8) {
      mode = "taxi";
      minutes = Math.round(8 + km * 2.5);
    } else {
      mode = "taxi";
      minutes = Math.round(10 + km * 2);
    }
  }
  return { fromId: from.id, toId: to.id, mode, minutes, flagged: mode === "walk" && minutes > LONG_WALK_MIN };
}
