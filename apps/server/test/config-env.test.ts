import { describe, expect, it, vi } from "vitest";

describe("config: blank .env lines", () => {
  it("a blank ELEVEN_VOICE_* line keeps the default voice (a blank id made every TTS call 404)", async () => {
    vi.resetModules();
    Object.assign(process.env, { ELEVEN_VOICE_CAPTAIN: "", ELEVEN_VOICE_BAND1: "  ", ELEVEN_MODEL: "", GEMINI_MODEL: "" });
    const { config } = await import("../src/config.js");
    expect(config.eleven.voices.captain).toBe("JBFqnCBsd6RMkjVDRZzb");
    expect(config.eleven.voices[1]).toBe("TX3LPaxmHKxFdv7VOQHJ");
    expect(config.eleven.model).toBe("eleven_flash_v2_5");
    expect(config.gemini.model).toBe("gemini-2.5-flash");
  });
});
