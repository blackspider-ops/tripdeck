// The seal chart never clips into the crew pieces (user report, Quest 3S): the pieces step back during the Seal and
// the sheet is scaled to lie inside them.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SEAL_TILT, SEAL_W, sealFit } from "./sealLayout";
import { SEAL_RING_R, spreadSeat } from "./director/CrewSeating";
import { SEAL_CLEAR_R, SEAL_Z0 } from "./director/SealCeremony";
import { SEAT_R } from "./seats";

describe("seal layout", () => {
  it("pieces step back to SEAL_RING_R (still on the 0.35 m chart), same angle", () => {
    const s = spreadSeat(new THREE.Vector3(0, 0.0025, SEAT_R), SEAL_RING_R);
    expect(s.z).toBeCloseTo(SEAL_RING_R, 9);
    expect(s.y).toBe(0.0025);
    expect(SEAL_RING_R).toBeLessThan(0.35);
    const far = new THREE.Vector3(0.34, 0, 0);
    expect(spreadSeat(far, SEAL_RING_R).equals(far)).toBe(true);
  });
  it("for 1–12 aboard every corner of the sheet (and its roll and tag) stays inside the pieces", () => {
    for (let n = 1; n <= 12; n++) {
      const length = 0.062 + (n > 6 ? 0.022 : 0.032) * n + 0.03;
      const k = sealFit(length, SEAL_Z0, SEAL_CLEAR_R);
      expect(k).toBeGreaterThan(0.6);
      expect(k).toBeLessThanOrEqual(1);
      const reach = Math.hypot((SEAL_W / 2 + 0.01) * k, SEAL_Z0 + (length + 0.045) * Math.cos(SEAL_TILT) * k);
      expect(reach, `${n} aboard`).toBeLessThanOrEqual(SEAL_RING_R - 0.04 + 1e-6);
    }
  });
});
