import { describe, expect, it } from "vitest";
import { extractAmounts, filterLine, type PrivacyContext } from "../src/privacy/filter.js";

// Expo crew: caps 1100 / 900 / 1400; Lisbon shares 1038 / 868 / 963; public totals 2869 / 1975.
const ctx: PrivacyContext = {
  sensitiveDollars: [1100, 900, 1400, 1038, 868, 963, 62, 32, 437],
  allowedDollars: [2869, 1975, 612, 520, 540, 210, 65, 38, 18, 12, 22, 25],
  names: ["Rae", "Maya", "Dev"],
};
const leaks = (s: string) => filterLine(s, ctx).leak;

describe("privacy filter — secret amounts never get through", () => {
  const bad = [
    "My friend can only do $900.",
    "They can only do $900, nine hundred tops.",
    "Her budget is 900.",
    "nine hundred is the ceiling",
    "My friend's cap is 9-0-0.",
    "Around 890 is all she has.",
    "It's about a grand, max.",
    "Fourteen hundred is plenty for my friend.",
    "My friend can spend 1.1k.",
    "Eleven hundred dollars, no more.",
    "That's 868 for my friend, just under.",
    "eight sixty-eight works",
    "Rae has 1,100 to play with.",
    "We can't go past 1100",
    "My limit is 9 0 0",
    "one thousand four hundred for Dev",
    "My friend can do 9 hundred.",
    "14 hundred works for Dev",
  ];
  for (const s of bad) it(`blocks: ${s}`, () => expect(leaks(s)).toBe(true));
});

describe("privacy filter — public facts pass", () => {
  const good = [
    "Lisbon. Cascais beach is a train ride away.",
    "Mexico City comes to $1,975 for the whole group.",
    "The food tour is $65.",
    "Mar 12 to 16 works for everyone.",
    "It's a 30 minute walk uphill.",
    "Three ports on the chart. Let's hear it.",
    "That's past what my friend can do.",
    "Two charts, then. Let's run them dry.",
  ];
  for (const s of good) it(`allows: ${s}`, () => expect(leaks(s)).toBe(false));
});

describe("price validator + rewrites", () => {
  it("flags invented prices", () => {
    expect(filterLine("The hotel is only $150 a night.", ctx).invalidPrice).toBe(true);
    expect(filterLine("The food tour is $65.", ctx).invalidPrice).toBe(false);
  });
  it("rewrites name + affordability", () => {
    const r = filterLine("Maya can't afford Lisbon.", ctx);
    expect(r.text).toBe("one of us can't afford Lisbon.");
    expect(r.rewrites).toBe(1);
  });
  it("reads colloquial amounts", () => {
    const vals = extractAmounts("seven fifty or so").map((a) => a.value);
    expect(vals).toContain(750);
  });
});

describe("R2-WP-14 (O2-044): compiled name patterns are reused per context", () => {
  it("rewrites every line (a shared global regex never carries lastIndex over), and follows a changed crew", () => {
    const c: PrivacyContext = { sensitiveDollars: [], allowedDollars: [], names: ["Maya"] };
    for (let i = 0; i < 3; i++) {
      const r = filterLine("Honestly Maya can't afford that one.", c);
      expect(r.text).toBe("Honestly one of us can't afford that one.");
      expect(r.rewrites).toBe(1);
    }
    expect(filterLine("Maya can't afford it, and Maya can't pay.", c).text).toBe("one of us can't afford it, and one of us can't pay.");
    c.names = ["Kai"];
    expect(filterLine("Kai can't afford it.", c).rewrites).toBe(1);
    expect(filterLine("Maya can't afford it.", c).rewrites).toBe(0);
    // the amounts come back with the result, as a fresh scan of its text would find them
    const f = filterLine("The hotel is $150 a night and 900 each.", ctx);
    expect(f.amounts).toEqual(extractAmounts(f.text));
  });
});
