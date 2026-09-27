// O2-068: 3D text never asks troika for a CDN fallback font (venue Wi-Fi), and setText skips unchanged strings.
import { describe, expect, it, vi } from "vitest";

vi.mock("troika-three-text", async () => {
  const THREE = await import("three");
  class Text extends THREE.Object3D {
    text = ""; font: string | null = null; fontSize = 0; color: unknown; anchorX: unknown; anchorY: unknown;
    maxWidth = Infinity; textAlign = "left"; lineHeight: unknown; letterSpacing = 0; overflowWrap = ""; depthOffset = 0;
    sync = vi.fn();
  }
  return { Text, preloadFont: vi.fn() };
});

import { coverText, makeText, setText } from "./text";

describe("coverText", () => {
  it("returns covered text unchanged (ASCII, Latin-1, curly quotes, dashes, €)", () => {
    for (const s of ["Lisbon · 4 nights", "Café São Paulo — €1,038", "“Aye” ‘aye’ – ok…", "line one\nline two", ""]) {
      expect(coverText(s)).toBe(s);
    }
  });

  it("maps arrows, checks, fractions and primes to covered stand-ins", () => {
    expect(coverText("ORD → LIS")).toBe("ORD -> LIS");
    expect(coverText("LIS ← ORD ⇄ MEX")).toBe("LIS <- ORD <-> MEX");
    expect(coverText("✓ Booked")).toBe("Booked");
    expect(coverText("✗ no")).toBe("x no");
    expect(coverText("⅓ each, ≈ $300")).toBe("1/3 each, ~ $300");
    expect(coverText("5′ 10″")).toBe("5' 10\"");
    // U+00AD (soft hyphen) is dropped, not drawn mid-word; the Latin-1 neighbours either side stay
    expect(coverText("soft\u00adhyphen")).toBe("softhyphen");
    expect(coverText("Caf\u00e9\u00ad \u00ac\u00ae")).toBe("Caf\u00e9 \u00ac\u00ae");
  });

  it("drops anything else (emoji, CJK) and collapses the gap it leaves", () => {
    expect(coverText("Hi \u{1F389} there")).toBe("Hi there");
    expect(coverText("東京 Tokyo")).toBe("Tokyo");
    expect(coverText("\u{1F389}")).toBe("");
  });

  it("turns other whitespace (tab, narrow no-break space) into a plain space", () => {
    expect(coverText("a\tb")).toBe("a b");
    expect(coverText("9 am")).toBe("9 am");
  });
});

describe("makeText / setText", () => {
  it("covers the text it's given, and setText syncs only when the covered text changes", () => {
    const t = makeText({ text: "ORD → LIS", size: 0.01 });
    expect(t.text).toBe("ORD -> LIS");
    expect(t.font).toBe("/textures/type/source-serif.woff");
    const sync = t.sync as unknown as ReturnType<typeof vi.fn>;
    sync.mockClear();
    setText(t, "ORD → LIS"); // same once covered
    setText(t, "ORD -> LIS");
    expect(sync).not.toHaveBeenCalled();
    setText(t, "MEX");
    expect(t.text).toBe("MEX");
    expect(sync).toHaveBeenCalledOnce();
  });
});
