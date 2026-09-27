// User report: every wax seal carried an "A" (the monogram), read as "voted for chart A". The chart room's seals press
// a drawn check instead; chart A / B labels stay on the charts only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wax seal mark", () => {
  it("the 3D seal presses a check (inkCheck), not a letter", () => {
    const src = readFileSync(new URL("./SealChart.ts", import.meta.url), "utf8");
    const seal = src.slice(src.indexOf("class WaxSeal"), src.indexOf("setStanding"));
    expect(seal).toContain("inkCheck(");
    expect(seal).not.toMatch(/makeText\(\{\s*text:\s*"[AB]"/);
  });
});
