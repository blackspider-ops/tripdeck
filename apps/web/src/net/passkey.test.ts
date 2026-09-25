// LIVE-001 / L1-001: sealing never registers a passkey, and a cancelled Face ID prompt never seals.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({ startRegistration: vi.fn(), startAuthentication: vi.fn(), browserSupportsWebAuthn: () => true }));
vi.mock("@simplewebauthn/browser", () => wa);

const apiMock = vi.hoisted(() => ({
  passkeyStatus: vi.fn(), passkeyRegisterOptions: vi.fn(), passkeyRegisterVerify: vi.fn(),
  passkeyAuthOptions: vi.fn(), passkeyAuthVerify: vi.fn(),
}));
vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), api: apiMock }));

import { ApiError } from "./api";
import { addPasskey, passkeyAvailability, PASSKEY_COPY, prepareSeal } from "./passkey";

const create = vi.fn(async () => { throw new Error("navigator.credentials.create must not be called while sealing"); });
const get = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // a phone with a platform authenticator (Touch ID / Face ID) and a password manager hooked into create()
  vi.stubGlobal("PublicKeyCredential", Object.assign(function PublicKeyCredential() {}, {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
  }));
  vi.stubGlobal("navigator", { credentials: { create, get } });
  vi.stubGlobal("localStorage", { getItem: () => null });
  apiMock.passkeyRegisterOptions.mockResolvedValue({ challenge: "c" });
  apiMock.passkeyRegisterVerify.mockResolvedValue({ ok: true });
  apiMock.passkeyAuthOptions.mockResolvedValue({ challenge: "c" });
  apiMock.passkeyAuthVerify.mockResolvedValue({ assertionToken: "tok" });
});
afterEach(() => vi.unstubAllGlobals());

describe("prepareSeal (Set your seal)", () => {
  it("no passkey on file: seals with the confirm tap and never starts a registration", async () => {
    apiMock.passkeyStatus.mockResolvedValue({ registered: false, required: false });
    expect(await prepareSeal("T", "tok-m", "B")).toEqual({ kind: "send" });
    expect(wa.startRegistration).not.toHaveBeenCalled();
    expect(wa.startAuthentication).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(apiMock.passkeyRegisterOptions).not.toHaveBeenCalled();
  });

  it("a passkey on file: asserts and sends the token", async () => {
    apiMock.passkeyStatus.mockResolvedValue({ registered: true, required: true });
    wa.startAuthentication.mockResolvedValue({ id: "cred" });
    expect(await prepareSeal("T", "tok-m", "B")).toEqual({ kind: "send", assertionToken: "tok" });
    expect(apiMock.passkeyAuthVerify).toHaveBeenCalledWith("T", "tok-m", "B", { id: "cred" });
    expect(wa.startRegistration).not.toHaveBeenCalled();
  });

  it("a cancelled Face ID prompt is a note, not a seal (L1-001)", async () => {
    apiMock.passkeyStatus.mockResolvedValue({ registered: true, required: true });
    wa.startAuthentication.mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    expect(await prepareSeal("T", "tok-m", "B")).toEqual({ kind: "note", message: PASSKEY_COPY.cancelled });
    expect(apiMock.passkeyAuthVerify).not.toHaveBeenCalled();
  });

  it("a failed verification is a note, not a seal", async () => {
    apiMock.passkeyStatus.mockResolvedValue({ registered: true, required: true });
    wa.startAuthentication.mockResolvedValue({ id: "cred" });
    apiMock.passkeyAuthVerify.mockRejectedValue(new ApiError(400, "no", "PASSKEY_FAILED"));
    expect((await prepareSeal("T", "tok-m", "B")).kind).toBe("note");
  });

  it("a passkey on another address: explains, offers to add one here, never registers by itself", async () => {
    apiMock.passkeyStatus.mockResolvedValue({ registered: false, required: true });
    expect(await prepareSeal("T", "tok-m", "B")).toEqual({ kind: "note", message: PASSKEY_COPY.elsewhere, addHere: true });
    expect(wa.startRegistration).not.toHaveBeenCalled();
  });

  it("a passkey on file but no WebAuthn here: blocked, not sealed", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    apiMock.passkeyStatus.mockResolvedValue({ registered: true, required: true });
    expect(await prepareSeal("T", "tok-m", "B")).toEqual({ kind: "note", message: PASSKEY_COPY.unsupported });
  });

  it("status unreachable: confirm tap (the server gate answers PASSKEY_REQUIRED if one is on file)", async () => {
    apiMock.passkeyStatus.mockRejectedValue(new ApiError(0, "offline", "OFFLINE"));
    expect(await prepareSeal("T", "tok-m", "B")).toEqual({ kind: "send" });
    expect(wa.startRegistration).not.toHaveBeenCalled();
  });
});

describe("Add a passkey (explicit, optional)", () => {
  it("registers only — no assertion, nothing sealed", async () => {
    wa.startRegistration.mockResolvedValue({ id: "new" });
    expect(await addPasskey("T", "tok-m")).toEqual({ kind: "added" });
    expect(apiMock.passkeyRegisterVerify).toHaveBeenCalledWith("T", "tok-m", { id: "new" });
    expect(wa.startAuthentication).not.toHaveBeenCalled();
    expect(apiMock.passkeyAuthVerify).not.toHaveBeenCalled();
  });

  it("cancelled → a note; PASSKEY_EXISTS counts as added; PASSKEY_ELSEWHERE keeps the server's words", async () => {
    wa.startRegistration.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    expect(await addPasskey("T", "tok-m")).toEqual({ kind: "cancelled", message: PASSKEY_COPY.addCancelled });
    apiMock.passkeyRegisterOptions.mockRejectedValueOnce(new ApiError(409, "exists", "PASSKEY_EXISTS"));
    expect(await addPasskey("T", "tok-m")).toEqual({ kind: "added" });
    apiMock.passkeyRegisterOptions.mockRejectedValueOnce(new ApiError(409, "Open it there.", "PASSKEY_ELSEWHERE"));
    expect(await addPasskey("T", "tok-m")).toEqual({ kind: "blocked", message: "Open it there." });
  });

  it("is offered only on phones that can hold a passkey, and not once one is on file", async () => {
    apiMock.passkeyStatus.mockResolvedValue({ registered: false, required: false });
    expect(await passkeyAvailability("T", "tok-m")).toEqual({ canAdd: true, registered: false });
    apiMock.passkeyStatus.mockResolvedValue({ registered: true, required: true });
    expect(await passkeyAvailability("T", "tok-m")).toEqual({ canAdd: false, registered: true });
    vi.stubGlobal("PublicKeyCredential", Object.assign(function P() {}, { isUserVerifyingPlatformAuthenticatorAvailable: async () => false }));
    apiMock.passkeyStatus.mockClear();
    expect(await passkeyAvailability("T", "tok-m")).toEqual({ canAdd: false, registered: false });
    expect(apiMock.passkeyStatus).not.toHaveBeenCalled();
  });
});

describe("S2-009: only the phone that claimed the seat is offered 'Add a passkey'", () => {
  it("canRegister:false → not offered, and a refused add reads PASSKEY_UNBOUND, never a seal", async () => {
    apiMock.passkeyStatus.mockResolvedValue({ registered: false, required: false, canRegister: false });
    expect(await passkeyAvailability("T", "tok-m")).toEqual({ canAdd: false, registered: false });
    apiMock.passkeyRegisterOptions.mockRejectedValue(new ApiError(409, "no", "PASSKEY_UNBOUND"));
    expect(await addPasskey("T", "tok-m")).toEqual({ kind: "blocked", message: PASSKEY_COPY.addUnbound });
    expect(wa.startRegistration).not.toHaveBeenCalled();
  });

  it("a passkey elsewhere on a phone without the claim: the note doesn't offer adding one here", async () => {
    apiMock.passkeyStatus.mockResolvedValue({ registered: false, required: true, canRegister: false });
    expect(await prepareSeal("T", "tok-m", "B")).toEqual({ kind: "note", message: PASSKEY_COPY.elsewhere });
    apiMock.passkeyStatus.mockResolvedValue({ registered: false, required: false, canRegister: true });
    expect(await passkeyAvailability("T", "tok-m")).toEqual({ canAdd: true, registered: false });
  });
});
