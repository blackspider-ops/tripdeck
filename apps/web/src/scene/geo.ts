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
