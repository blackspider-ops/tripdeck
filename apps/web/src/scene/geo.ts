import * as THREE from "three";

/**
 * Lat/lng → point on a sphere, matching THREE.SphereGeometry's UV layout so an equirect texture lines up:
 * u = (lng + 180) / 360.
 */
export function latLngToSphere(lat: number, lng: number, r: number, out = new THREE.Vector3()) {
  const phi = ((lng + 180) * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  return out.set(-Math.cos(phi) * Math.cos(la) * r, Math.sin(la) * r, Math.sin(phi) * Math.cos(la) * r);
}

/** Globe spin (about y) that brings a longitude to face +z (the Organizer). */
export function spinFor(lng: number) {
  const phi = ((lng + 180) * Math.PI) / 180;
  return Math.PI / 2 - phi;
}

/** Local meters east/north of a center → scene x/z (north = −z). */
export function metersFrom(center: { lat: number; lng: number }, p: { lat: number; lng: number }) {
  const east = (p.lng - center.lng) * Math.cos((center.lat * Math.PI) / 180) * 111_320;
  const north = (p.lat - center.lat) * 110_540;
  return { x: east, z: -north };
}

/** Points along a lifted great-circle arc between two unit directions. */
export function arcPoints(a: THREE.Vector3, b: THREE.Vector3, r: number, lift = 0.18, n = 48) {
  const ua = a.clone().normalize();
  const ub = b.clone().normalize();
  const angle = ua.angleTo(ub);
  const pts: THREE.Vector3[] = [];
  const q = new THREE.Quaternion();
  const axis = new THREE.Vector3().crossVectors(ua, ub).normalize();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    q.setFromAxisAngle(axis, angle * t);
    const p = ua.clone().applyQuaternion(q);
    pts.push(p.multiplyScalar(r * (1 + lift * Math.sin(Math.PI * t) * Math.min(1, angle / 1.2))));
  }
  return pts;
}

/** The inverse of latLngToSphere: a point on (or off) the globe, in the spinning sphere's frame → lat/lng (deg). */
export function sphereToLatLng(v: { x: number; y: number; z: number }): { lat: number; lng: number } {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  const lat = (Math.asin(Math.max(-1, Math.min(1, v.y / len))) * 180) / Math.PI;
  const phi = Math.atan2(v.z, -v.x); // latLngToSphere: x = −cos φ, z = sin φ
  let lng = (phi * 180) / Math.PI - 180;
  while (lng < -180) lng += 360;
  while (lng >= 180) lng -= 360;
  return { lat, lng };
}

/** Great-circle distance (km). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The charted port nearest a spot on the globe, within `maxKm` (a pin on open sea finds nothing). */
export function nearestPort<T extends { lat?: number; lng?: number }>(at: { lat: number; lng: number }, ports: readonly T[], maxKm = 900): T | null {
  let best: T | null = null, bestKm = maxKm;
  for (const p of ports) {
    if (typeof p.lat !== "number" || typeof p.lng !== "number") continue;
    const km = distanceKm(at, { lat: p.lat, lng: p.lng });
    if (km <= bestKm) { best = p; bestKm = km; }
  }
  return best;
}

/** The shortest signed turn from angle a to b (rad), in (−π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Globe spin inertia: velocity (rad/s) after `dt` seconds of friction; below `stop` it rests. */
export function spinFriction(vel: number, dt: number, friction = 2.6, stop = 0.03): number {
  const v = vel * Math.exp(-friction * dt);
  return Math.abs(v) < stop ? 0 : v;
}
