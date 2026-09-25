import { describe, expect, it } from "vitest";
import { latestMemory, prefillFromMemory } from "./memory";

describe("prefillFromMemory (TR1-013)", () => {
  it("pencils in the newest booked voyage's budget band and liked tags", () => {
    const mem = [
      "voyage: Lisbon, Mar 12–16 · booked · tight budget · liked: Beach day",
      "voyage: Nashville, Mar 12–16 · not booked (nobody was charged)",
      "voyage: Mexico City, Mar 12–16 · booked · mid budget · liked: Street food tour, Museum of Anthropology, Live music night",
    ];
    expect(prefillFromMemory(mem)).toEqual({ capCents: 100_000, mustHaves: ["food", "museums", "music"] });
    expect(latestMemory(mem)).toBe(mem[2].slice("voyage: ".length));
    expect(latestMemory(["voyage: Nashville · booked · mid budget · conceded the city choice (wanted Chicago)"]))
      .toBe("Nashville · booked · mid budget · conceded the city choice (wanted Chicago)");
  });
  it("ignores voided-only memory", () => {
    expect(prefillFromMemory(["voyage: Lisbon, Mar 12–16 · not booked (nobody was charged)"])).toBeNull();
    expect(prefillFromMemory([])).toBeNull();
  });
});
