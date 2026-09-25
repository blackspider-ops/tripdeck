// OPT-066: the phone's copy for helm refusals (errors.ts); anything unlisted keeps the server's own message.
import { describe, expect, it } from "vitest";
import { ApiError } from "../net/api";
import { actionError, errorCopy, HAIL_CODES, HAIL_EVENTS, ownsError } from "./errors";
import { transcribeError } from "./components/useRecorder";
import { speechCapMs } from "./timing";

describe("errorCopy", () => {
  it("rewrites known codes in phone copy", () => {
    expect(errorCopy({ code: "SLOW_DOWN", message: "429", event: "table:hail" })).toMatch(/Your words are still in the box/);
    expect(errorCopy({ code: "CAPTURING", message: "x" })).toMatch(/Too late to call it off/);
    expect(errorCopy({ code: "TOO_FEW", message: "x" })).toBe("Invite at least one friend first. A table needs two.");
  });
  it("keeps the server's message for other codes, or none", () => {
    expect(errorCopy({ code: "BAD_PHASE", message: "Not now." })).toBe("Not now.");
    expect(errorCopy({ message: "Couldn't reach the helm." })).toBe("Couldn't reach the helm.");
  });
  it("every hail code but BAD_INPUT has its own copy for a refused hail", () => {
    for (const c of HAIL_CODES.filter((x) => x !== "BAD_INPUT")) expect(errorCopy({ code: c, message: "raw", event: "table:hail" })).not.toBe("raw");
  });
  it("SEAL_LOCKED reads by the action it answers; TOO_MANY_RUNS has its own copy", () => {
    expect(errorCopy({ code: "SEAL_LOCKED", message: "raw", event: "seal:set" })).toBe("Your seal is already set.");
    expect(errorCopy({ code: "SEAL_LOCKED", message: "raw" })).toBe("Your seal is already set.");
    expect(errorCopy({ code: "SEAL_LOCKED", message: "raw", event: "seal:cancel" })).toBe("Too late to lift — every seal is set.");
    expect(errorCopy({ code: "TOO_MANY_RUNS", message: "raw", event: "table:start" })).toBe("The table has met enough times for this voyage.");
  });
});

// R2-WP-09
describe("L3-008: the hail copy is only for a refused hail", () => {
  it("a SLOW_DOWN from any other action keeps the server's message", () => {
    expect(errorCopy({ code: "SLOW_DOWN", event: "seal:set", message: "Easy there — too many actions at once." })).toBe("Easy there — too many actions at once.");
    expect(errorCopy({ code: "SLOW_DOWN", event: "trip:join", message: "Too many joins — wait a minute." })).toBe("Too many joins — wait a minute.");
    expect(errorCopy({ code: "SLOW_DOWN", message: "Too many tries." })).toBe("Too many tries.");
    expect(errorCopy({ code: "SLOW_DOWN", event: "table:hail", message: "raw" })).toBe("One hail every few seconds. Your words are still in the box.");
  });
});

describe("R2-WP-04 / R2-WP-02 follow-ups", () => {
  it("TABLE_OPENING is a hail code with its own copy", () => {
    expect(HAIL_CODES).toContain("TABLE_OPENING");
    expect(errorCopy({ code: "TABLE_OPENING", event: "table:hail", message: "raw" }))
      .toBe("The Captain is opening the table. Hail once the mates start speaking.");
  });
  it("CAPTURING says the booking is settling, not being logged", () => {
    const t = errorCopy({ code: "CAPTURING", event: "booking:callOff", message: "raw" });
    expect(t).toMatch(/settling/);
    expect(t).not.toMatch(/logged/);
  });
});

describe("L1-008: ownsError matches by code and, when given, by the action", () => {
  it("the hail dock claims a hail refusal only", () => {
    expect(ownsError({ code: "SLOW_DOWN", event: "table:hail" }, HAIL_CODES, HAIL_EVENTS)).toBe(true);
    expect(ownsError({ code: "TABLE_OPENING", event: "table:hail" }, HAIL_CODES, HAIL_EVENTS)).toBe(true);
    expect(ownsError({ code: "SLOW_DOWN", event: "trip:join" }, HAIL_CODES, HAIL_EVENTS)).toBe(false);
    expect(ownsError({ code: "BAD_INPUT", event: "brief:submit" }, HAIL_CODES, HAIL_EVENTS)).toBe(false);
    expect(ownsError({ code: "SLOW_DOWN" }, HAIL_CODES, HAIL_EVENTS)).toBe(false); // no event: not provably a hail
    expect(ownsError({ code: "BAD_PHASE", event: "table:hail" }, HAIL_CODES, HAIL_EVENTS)).toBe(false);
  });
  it("without an events filter, the code alone decides", () => {
    expect(ownsError({ code: "PASSKEY_REQUIRED", event: "seal:set" }, ["PASSKEY_REQUIRED"])).toBe(true);
    expect(ownsError({ code: "PASSKEY_REQUIRED" }, ["PASSKEY_REQUIRED"])).toBe(true);
    expect(ownsError(null, ["PASSKEY_REQUIRED"])).toBe(false);
  });
  it("Seal and Voided claim only their own action's refusal", () => {
    expect(ownsError({ code: "CAPTURING", event: "booking:callOff" }, ["CAPTURING"], ["booking:callOff"])).toBe(true);
    expect(ownsError({ code: "NEEDS_ATTENTION", event: "booking:retry" }, ["NEEDS_ATTENTION"], ["booking:retry"])).toBe(true);
    expect(ownsError({ code: "NEEDS_ATTENTION", event: "plan:pick" }, ["NEEDS_ATTENTION"], ["booking:retry"])).toBe(false);
  });
});

describe("O2-016 / O2-009: action errors", () => {
  it("a helm refusal reads as phone copy, anything else as the fallback", () => {
    expect(actionError(new ApiError(409, "raw", "TOO_FEW"), "fb")).toBe("Invite at least one friend first. A table needs two.");
    expect(actionError(new ApiError(400, "Server words."), "fb")).toBe("Server words.");
    expect(actionError(new TypeError("boom"), "fb")).toBe("fb");
  });
  it("NO_STT from speech-to-text shows the phone's copy (it never did: transcribeError returned the raw message)", () => {
    expect(transcribeError(new ApiError(503, "ELEVENLABS_API_KEY missing", "NO_STT"), "fb")).toBe("Voice isn't on here. Type it instead.");
    expect(transcribeError(new Error("empty"), "fb")).toBe("fb");
  });
  it("speechCapMs: at least 3 s, else words × pace + slack", () => {
    expect(speechCapMs("hi")).toBe(3000);
    expect(speechCapMs(Array(10).fill("w").join(" "))).toBe(10 * 420 + 1500);
  });
});
