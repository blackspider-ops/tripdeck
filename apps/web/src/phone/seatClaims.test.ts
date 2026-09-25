// L1-009 / S2-012 (R2-WP-10): Muster stops offering a spent invite link once the friend has opened it.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrewPublic } from "@all-ayes/shared";
import { inviteView, resetSeat, seatLists } from "./seatClaims";

const seat = (memberId: string, role: CrewPublic["role"], extra: Partial<CrewPublic> = {}): CrewPublic =>
  ({ memberId, name: memberId, role, band: 1, briefSealed: false, ...extra });

describe("Muster invite rows", () => {
  it("an opened invite shows 'opened' and no link, even when this phone kept the old URL", () => {
    expect(inviteView(seat("dev", "absent", { inviteOpen: false }), "https://x/t/ABC/brief#m=dev&k=k")).toBe("link");
    expect(inviteView(seat("dev", "absent", { inviteOpen: false }), undefined)).toBe("remake");
    expect(inviteView(seat("dev", "absent", { inviteOpen: true }), "https://x/t/ABC/brief#m=dev&k=k")).toBe("opened");
    expect(inviteView(seat("dev", "absent", { inviteOpen: true }), undefined)).toBe("opened");
  });

  it("invite rows: absent friends and reset seats; resettable: members (not me, not a pending reset)", () => {
    const crew = [
      seat("rae", "organizer"), seat("maya", "member"), seat("dev", "absent", { inviteOpen: true }),
      seat("sam", "member", { inviteOpen: false }), seat("kim", "member", { inviteOpen: true }),
    ];
    const { invited, others } = seatLists(crew, "rae");
    expect(invited.map((c) => c.memberId)).toEqual(["dev", "sam"]);
    expect(others.map((c) => c.memberId)).toEqual(["maya", "kim"]);
  });
});

describe("R2-WP-16: resetSeat goes through api.ts", () => {
  afterEach(() => vi.restoreAllMocks());
  it("POSTs the reset with the organizer's token and returns the new link; a refusal is an ApiError", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ memberId: "dev", invitePath: "/t/ABC#m=dev&k=n" }), { status: 200 }));
    await expect(resetSeat("T1", "org", "dev")).resolves.toEqual({ memberId: "dev", invitePath: "/t/ABC#m=dev&k=n" });
    expect(String(f.mock.calls[0][0])).toBe("/api/trips/T1/members/dev/reset");
    expect(new Headers((f.mock.calls[0][1] as RequestInit).headers).get("Authorization")).toBe("Bearer org");
    f.mockResolvedValueOnce(new Response(JSON.stringify({ code: "BAD_PHASE", message: "Not now." }), { status: 409 }));
    await expect(resetSeat("T1", "org", "dev")).rejects.toMatchObject({ status: 409, code: "BAD_PHASE" });
  });
});
