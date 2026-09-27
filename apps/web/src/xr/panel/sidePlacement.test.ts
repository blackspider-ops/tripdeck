// Where the log book opens (user report, Quest 3S: "it should show up somewhere else") and where its tag sits.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { PANEL_M, PANEL_PLACE, panelHome } from "./SidePanel";
import { logTagPose } from "../XRApp";

describe("panelHome", () => {
  const center = new THREE.Vector3(0.4, 0.74, -0.8);
  for (const [name, eye] of [["standing", new THREE.Vector3(0.4, 1.62, 0)], ["seated", new THREE.Vector3(0.4, 1.2, -0.1)], ["off to one side", new THREE.Vector3(1.2, 1.6, -0.3)]] as const) {
    it(`${name}: upright on the viewer's left, clear of the table, turned toward them`, () => {
      const { at, yaw } = panelHome(center, eye);
      const toward = eye.clone().sub(center).setY(0).normalize();
      const left = new THREE.Vector3(0, 1, 0).cross(toward.clone().negate());
      const rel = at.clone().sub(center);
      expect(rel.dot(left)).toBeCloseTo(PANEL_PLACE.side, 6);
      // its nearest edge (half its width, turned 30°) stays past the chart (0.35) and the cloches (~0.46)
      expect(rel.dot(left) - (PANEL_M.w / 2) * Math.cos(PANEL_PLACE.turn)).toBeGreaterThan(0.47);
      expect(at.y - center.y).toBeGreaterThanOrEqual(PANEL_PLACE.minUp - 1e-9);
      expect(at.y - center.y).toBeLessThanOrEqual(PANEL_PLACE.maxUp + 1e-9);
      expect(at.y - PANEL_M.h / 2).toBeGreaterThan(center.y); // never through the table
      // its face (+z) points back toward the viewer's side, turned 30° toward them
      const n = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      expect(n.dot(toward)).toBeCloseTo(Math.cos(PANEL_PLACE.turn), 6);
      expect(n.dot(left)).toBeLessThan(0);
    });
  }
});

describe("logTagPose", () => {
  it("the Organizer (seat 90°, +z): the near-left corner", () => {
    const p = logTagPose(90);
    expect(p.x).toBeCloseTo(-0.25, 9);
    expect(p.z).toBeCloseTo(0.27, 9);
    expect(p.yaw).toBeCloseTo(0, 9);
  });
  it("any seat: toward that seat and to its left", () => {
    for (const deg of [0, 30, 200, 300]) {
      const p = logTagPose(deg), r = (deg * Math.PI) / 180;
      const s = new THREE.Vector2(Math.cos(r), Math.sin(r)), l = new THREE.Vector2(-Math.sin(r), Math.cos(r));
      const v = new THREE.Vector2(p.x, p.z);
      expect(v.dot(s)).toBeCloseTo(0.27, 9);
      expect(v.dot(l)).toBeCloseTo(0.25, 9);
    }
  });
});
