// OPT-017 / OPT-066: speaker names shared by the chart room and the phone log (no three.js import).
import { describe, expect, it } from "vitest";
import { BANDS, PALETTE, type CrewPublic, type Turn } from "@all-ayes/shared";
import { drawsArcs, speakerLabel } from "./labels";

const crew = [{ memberId: "m1", name: "Ann", role: "member", band: 2, briefSealed: true }] as CrewPublic[];
const turn = (speaker: Turn["speaker"]) => ({ speaker }) as Turn;

describe("speakerLabel", () => {
  it("names the Captain, an Advocate and a hail, in band colour", () => {
    expect(speakerLabel(turn({ kind: "captain" } as Turn["speaker"]), crew)).toEqual({ name: "The Captain", color: PALETTE.brassDark, band: "captain" });
    expect(speakerLabel(turn({ kind: "advocate", memberId: "m1" } as Turn["speaker"]), crew)).toEqual({ name: "Ann's mate", color: BANDS[2].hex, band: 2 });
    expect(speakerLabel(turn({ kind: "human", memberId: "m1" } as Turn["speaker"]), crew).name).toBe("Ann (hail)");
  });
  it("falls back for someone who left the crew", () => {
    expect(speakerLabel(turn({ kind: "advocate", memberId: "gone" } as Turn["speaker"]), crew)).toMatchObject({ name: "A crew member's mate", color: PALETTE.ink });
  });
});

describe("drawsArcs", () => {
  it("only propose / support / concede pencil arcs", () => {
    expect(["OPEN", "PROPOSE", "OBJECT", "CONCEDE", "SUPPORT", "HAIL", "DECIDE"].filter((a) => drawsArcs(a as Turn["act"]))).toEqual(["PROPOSE", "CONCEDE", "SUPPORT"]);
  });
});
