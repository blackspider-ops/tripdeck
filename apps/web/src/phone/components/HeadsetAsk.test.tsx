// @vitest-environment happy-dom
// Quest-first: the seat's own phone gets "Let this headset in?" (member room) and answers it with one tap.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TripStore, reducers, type ClientState } from "../../net/tripStore";
import { TripProvider } from "../TripContext";
import { HeadsetAsk } from "./HeadsetAsk";
import { isQuestBrowser, passkeysUsable } from "../../xr/questMode";

afterEach(() => cleanup());

describe("headset:request", () => {
  it("the reducer opens the prompt, and an answer (here or elsewhere) closes only that one", () => {
    const s0 = { headsetRequest: null } as ClientState;
    const open = reducers["headset:request"](s0, { requestId: "r1", memberName: "Rae", expiresAt: 1 }, "phone")!;
    expect(open.headsetRequest).toEqual({ requestId: "r1", memberName: "Rae", expiresAt: 1 });
    const s1 = { ...s0, ...open } as ClientState;
    expect(reducers["headset:request"](s1, { requestId: "r0", memberName: "Rae", expiresAt: 1, answered: true }, "phone")).toBeUndefined();
    expect(reducers["headset:request"](s1, { requestId: "r1", memberName: "Rae", expiresAt: 1, answered: true }, "phone")).toEqual({ headsetRequest: null });
  });

  it("the phone's one-tap answer goes over the socket", () => {
    const store = new TripStore({ tripId: "t1", surface: "phone", autoConnect: false });
    const sent: { ev: string; body: unknown }[] = [];
    vi.spyOn(store, "emit").mockImplementation(((ev: string, body: unknown) => { sent.push({ ev, body }); }) as never);
    store.state = { ...store.state, trip: { crew: [{ memberId: "m1", name: "Rae" }], organizerId: "m1" } as never };
    render(<TripProvider store={store} session={{ tripId: "t1", joinCode: "ABC", memberId: "m1", memberToken: "tok" }}><HeadsetAsk /></TripProvider>);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    act(() => { (store as unknown as { set(p: Partial<ClientState>): void }).set({ headsetRequest: { requestId: "r1", memberName: "Rae", expiresAt: Date.now() + 60_000 } }); });
    expect(screen.getByRole("alertdialog", { name: "Let this headset in?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Let it in" }));
    expect(sent).toEqual([{ ev: "headset:approve", body: { requestId: "r1", allow: true } }]);
    store.close();
  });
});

describe("questMode", () => {
  it("knows Quest Browser, and that a browser without a platform authenticator can't hold a passkey", async () => {
    expect(isQuestBrowser("Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 OculusBrowser/35.0 Chrome/126 VR Safari/537.36")).toBe(true);
    expect(isQuestBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(false);
    expect(await passkeysUsable({})).toBe(false);
    const PKC = Object.assign(function () { /* */ }, { isUserVerifyingPlatformAuthenticatorAvailable: async () => false });
    expect(await passkeysUsable({ PublicKeyCredential: PKC })).toBe(false);
    PKC.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
    expect(await passkeysUsable({ PublicKeyCredential: PKC })).toBe(true);
  });
});
