/**
 * WP-14 part B: the REST/socket follow-ups — archived voyages load before a lookup (WP-10), dev health reports memory
 * (WP-11), the debug view gives each person one reference (WP-08), and passkeys can be re-persisted (WP-10).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, {
  PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "", PUBLIC_BASE_URL: "",
}));
vi.mock("../src/util/ids.js", async (orig) => ({ ...(await orig<typeof import("../src/util/ids.js")>()), sleep: () => Promise.resolve() }));

import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect } from "socket.io-client";
import { apiRouter } from "../src/api/routes.js";
import { attachRealtime } from "../src/realtime/io.js";
import { TripService } from "../src/trips/service.js";
import { seedExpo } from "../src/demo/seed.js";
import { persistAllPasskeys } from "../src/passkeys/passkeys.js";

let helm: TripService;
let http: Server;
let base = "";

beforeAll(async () => {
  helm = new TripService();
  const app = express();
  app.use("/api", apiRouter(helm));
  http = createServer(app);
  attachRealtime(http, helm);
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://localhost:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));

const until = async (ok: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!ok()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

/** Takes a voyage out of memory and makes `hydrate` bring it back, as an archived voyage would come from MongoDB. */
function archive(tripId: string) {
  const t = helm.trip(tripId);
  helm.removeTrip(t);
  const spy = vi.spyOn(helm, "hydrate").mockImplementation(async (q) => {
    if (q.tripId !== tripId && String(q.joinCode ?? "").toUpperCase() !== t.joinCode) return helm.trips.get(q.tripId ?? "");
    helm.addTrip(t);
    return t;
  });
  return { t, spy };
}

describe("WP-10: archived voyages load before the lookup (b-)", () => {
  it("REST by-code and /trips/:id routes hydrate instead of answering 503 LOADING", async () => {
    const seed = await seedExpo(helm);
    const { t, spy } = archive(seed.tripId);
    const byCode = await fetch(`${base}/api/trips/by-code/${t.joinCode.toLowerCase()}`);
    expect(byCode.status).toBe(200);
    expect((await byCode.json()).tripId).toBe(t._id);

    helm.trips.delete(t._id);
    const passkey = await fetch(`${base}/api/trips/${t._id}/passkey`, { headers: { Authorization: `Bearer ${seed.organizer.memberToken}` } });
    expect(passkey.status).toBe(200);
    expect(spy).toHaveBeenCalledWith({ tripId: t._id });
    spy.mockRestore();
  });

  it("an unknown voyage is still a 404 NO_TRIP", async () => {
    const res = await fetch(`${base}/api/trips/nope/passkey`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NO_TRIP");
  });

  it("socket trip:join hydrates too", async () => {
    const seed = await seedExpo(helm);
    const { t, spy } = archive(seed.tripId);
    const s = connect(base, { transports: ["websocket"], forceNew: true });
    try {
      const ack = await new Promise<{ ok: boolean; code?: string }>((r) => s.emit("trip:join", { joinCode: t.joinCode, surface: "gallery" }, r));
      expect(ack).toEqual({ ok: true, as: "spectator" }); // R2-WP-07: the join ack names the role
      expect(spy).toHaveBeenCalled();
    } finally {
      s.close();
      spy.mockRestore();
    }
  });
});

describe("dev views (b-)", () => {
  it("WP-11: /api/health's detail view reports where memory lives", async () => {
    const full = await (await fetch(`${base}/api/health`)).json(); // tests run in dev mode: details are open
    expect(full.memory).toMatchObject({ store: expect.any(String) });
  });

  it("WP-08: one person has one crew-xxxxxx reference in the seals list and in the event log", async () => {
    const seed = await seedExpo(helm);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    await until(() => helm.trip(seed.tripId).status === "DRY_RUN");
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    const html = await (await fetch(`${base}/api/debug/${seed.tripId}`)).text();
    const sealRefs = [...html.matchAll(/<li>(crew-[0-9a-f]{6}):/g)].map((m) => m[1]);
    const eventRefs = new Set([...html.matchAll(/member:(crew-[0-9a-f]{6})/g)].map((m) => m[1]));
    expect(sealRefs.length).toBeGreaterThan(1);
    for (const r of sealRefs) expect(eventRefs.has(r)).toBe(true);
    expect(html).not.toMatch(/member:(Rae|Maya|Dev)\b/);
  });

  it("WP-04/WP-14: the debug page shows the helm's summary: table runs, seal deadline and needs-attention", async () => {
    const seed = await seedExpo(helm);
    await helm.startTable(seed.tripId, { memberId: seed.organizer.memberId });
    await until(() => helm.trip(seed.tripId).status === "DRY_RUN");
    await helm.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
    let html = await (await fetch(`${base}/api/debug/${seed.tripId}`)).text();
    expect(html).toMatch(/table runs 1/);
    expect(html).toMatch(/seal deadline: .* \(in \d+m \d+s\)/);
    expect(html).not.toMatch(/needs attention/);
    const b = helm.payments.bookings.get(helm.trip(seed.tripId).bookingId!)!;
    b.needsAttention = true;
    html = await (await fetch(`${base}/api/debug/${seed.tripId}`)).text();
    expect(html).toMatch(/needs attention/);
    b.needsAttention = undefined;
  });
});

describe("WP-10: passkeys can be re-persisted (b-)", () => {
  it("persistAllPasskeys queues every credential held in memory (none here) without throwing", () => {
    expect(persistAllPasskeys()).toBe(0);
  });
});

describe("R2-WP-08 / L3-005: REST codes (b-)", () => {
  it("a wrong method on /trips/by-code is NOT_FOUND, not NO_TRIP", async () => {
    const r = await fetch(`${base}/api/trips/by-code/W4N9BR`, { method: "POST" });
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe("NOT_FOUND");
  });

  it("an unknown audio turn is a JSON 404", async () => {
    const r = await fetch(`${base}/api/audio/unknown-turn`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toMatch(/json/);
    expect(await r.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("BAD_BOOKING is thrown and delivered as 409", async () => {
    const seed = await seedExpo(helm);
    const r = await fetch(`${base}/api/trips/${seed.tripId}/passkey/auth/verify`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${seed.maya.memberToken}` }, body: JSON.stringify({ bookingId: "nope" }),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("BAD_BOOKING");
  });
});

describe("R2-WP-08 / L3-002: the replay is built after its waits (b-)", () => {
  it("a new booking made while the replay waits is replayed as it is now, with no stale seal:private", async () => {
    const seed = await seedExpo(helm);
    const org = { memberId: seed.organizer.memberId };
    await helm.startTable(seed.tripId, org);
    await until(() => helm.trip(seed.tripId).status === "DRY_RUN", 20_000);
    const plans = helm.trip(seed.tripId).shortlistIds!;
    await helm.pick(seed.tripId, org, plans[0]);
    const b1 = helm.trip(seed.tripId).bookingId!;
    // hold the replay in its wait (the card digits), and meanwhile: call it off, back to the charts, pick again
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const card = vi.spyOn(helm.payments, "cardLast4").mockImplementationOnce(async () => { await gate; return "4242"; });
    const out: { ev: string; p: any }[] = [];
    const replay = helm.replayer.replay(helm.trip(seed.tripId), (ev, p) => out.push({ ev, p }), seed.maya.memberId);
    await helm.callOff(seed.tripId, org, b1);
    await until(() => helm.trip(seed.tripId).status === "VOIDED");
    helm.retry(seed.tripId, org);
    await helm.pick(seed.tripId, org, plans[1]);
    const b2 = helm.trip(seed.tripId).bookingId!;
    expect(b2).not.toBe(b1);
    expect(out).toEqual([]); // nothing was sent before the wait ended
    release();
    await replay;
    card.mockRestore();
    expect(out.find((e) => e.ev === "trip:state")!.p.booking.bookingId).toBe(b2);
    expect(out.filter((e) => e.ev === "booking:created").map((e) => e.p.bookingId)).toEqual([b2]);
    expect(out.filter((e) => e.ev === "seal:private" && e.p.bookingId === b1)).toEqual([]);
    expect(out.find((e) => e.ev === "plan:private")).toBeTruthy();
  }, 30_000);
});
