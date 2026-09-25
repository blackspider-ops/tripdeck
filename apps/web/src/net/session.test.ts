// WP-06: per-device credentials (TR2-010, SEC-003, SEC-019). Node has no localStorage, so the in-memory fallback is
// what runs here — the same code path as a private-mode browser. Run with: npx vitest run --root apps/web src/net
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSession, forgetVoyage, lastJoinCode, loadCrewKey, loadHeadsetSession, loadSession, readSeatLink, saveCrewKey, saveHeadsetSession, saveSession,
} from "./session";

describe("TR2-010: headset and organizer sessions don't share a key", () => {
  it("pairing a headset in the organizer's browser keeps the organizer's seat, and both load", () => {
    saveSession({ tripId: "t1", joinCode: "abc123", memberId: "rae", memberToken: "member-token" });
    saveHeadsetSession({ tripId: "t1", joinCode: "ABC123", deviceToken: "device-token" });
    expect(loadSession("ABC123")).toEqual({ tripId: "t1", joinCode: "abc123", memberId: "rae", memberToken: "member-token" });
    expect(loadHeadsetSession("abc123")?.deviceToken).toBe("device-token");
    // a device token handed to saveSession is dropped rather than stored with the seat
    saveSession({ tripId: "t1", joinCode: "ABC123", memberId: "rae", memberToken: "member-token", deviceToken: "x" });
    expect(loadSession("ABC123")?.deviceToken).toBeUndefined();
    clearSession("ABC123");
    expect(loadSession("ABC123")).toBeNull();
    expect(loadHeadsetSession("ABC123")?.deviceToken).toBe("device-token");
  });
});

describe("SEC-003: the crew key", () => {
  it("only a well-formed key is kept", () => {
    saveCrewKey("maya|ORD");
    expect(loadCrewKey()).toBeUndefined();
    const k = "A".repeat(43);
    saveCrewKey(k);
    expect(loadCrewKey()).toBe(k);
    saveCrewKey(undefined);
    expect(loadCrewKey()).toBe(k);
  });
});

describe("SEC-004 / SEC-019: seat links", () => {
  it("reads the fragment first, then the query; needs a member and a secret", () => {
    expect(readSeatLink("", "#as=h1&m=maya")).toEqual({ m: "maya", as: "h1" });
    expect(readSeatLink("", "#m=dev&k=key")).toEqual({ m: "dev", k: "key" });
    expect(readSeatLink("?m=dev&k=old", "")).toEqual({ m: "dev", k: "old" });
    expect(readSeatLink("?m=dev&k=old", "#m=dev&k=new")).toEqual({ m: "dev", k: "new" });
    expect(readSeatLink("?m=dev", "")).toBeNull();
    expect(readSeatLink("", "#k=key")).toBeNull();
  });
  it("WP-08/WP-16: the legacy ?as= seat link is not read (a handoff only rides in the fragment)", () => {
    expect(readSeatLink("?as=h1&m=maya", "")).toBeNull();
    expect(readSeatLink("?m=maya", "#as=h1")).toBeNull();
    expect(readSeatLink("?as=old", "#as=h1&m=maya")).toEqual({ m: "maya", as: "h1" });
  });
});

describe("L1-002: a voyage the helm can't find is forgotten", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("forgetVoyage drops the seat and Landing's 'Back to voyage' when it points there", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
    });
    saveSession({ tripId: "t9", joinCode: "zzzzzz", memberId: "m", memberToken: "tok" });
    saveSession({ tripId: "t8", joinCode: "OTHER1", memberId: "m", memberToken: "tok" });
    expect(lastJoinCode()).toBe("OTHER1");
    forgetVoyage("ZZZZZZ");
    expect(loadSession("ZZZZZZ")).toBeNull();
    expect(lastJoinCode()).toBe("OTHER1"); // points elsewhere: kept
    saveSession({ tripId: "t9", joinCode: "ZZZZZZ", memberId: "m", memberToken: "tok" });
    forgetVoyage("zzzzzz");
    expect(loadSession("ZZZZZZ")).toBeNull();
    expect(lastJoinCode()).toBeNull();
    expect(loadSession("OTHER1")?.memberToken).toBe("tok");
  });
});

describe("O2-017: blocked storage keeps the seat and Landing's link for this page", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("aa:last is written through the in-memory fallback when localStorage throws", () => {
    const boom = () => { throw new Error("SecurityError"); };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom });
    saveSession({ tripId: "t7", joinCode: "priv01", memberId: "m", memberToken: "tok" });
    expect(lastJoinCode()).toBe("PRIV01");
    expect(loadSession("PRIV01")?.memberToken).toBe("tok");
    forgetVoyage("PRIV01");
    expect(lastJoinCode()).toBeNull();
    expect(loadSession("PRIV01")).toBeNull();
  });
});
