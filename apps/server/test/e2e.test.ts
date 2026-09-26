/**
 * End-to-end: real HTTP + Socket.io server, three phones (Rae, Maya), the headset and a gallery.
 * Runs the Expo demo and checks the privacy boundary: headset/gallery never receive private events.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  // must run before config.ts is imported
  Object.assign(process.env, { PACE_SCALE: "0", ELEVENLABS_API_KEY: "", GEMINI_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" });
});
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { io as connect, type Socket } from "socket.io-client";
import { PRIVATE_EVENTS } from "@all-ayes/shared";
import { TripService } from "../src/trips/service.js";
import { apiRouter } from "../src/api/routes.js";
import { attachRealtime } from "../src/realtime/io.js";
import { SimProvider } from "../src/payments/sim.js";
import { createHash, generateKeyPairSync } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { mintPasskeyClaim } from "../src/passkeys/passkeys.js";
import { holdForHail } from "./support/holdForHail.js";

let http: Server;
let base = "";
let helm: TripService;

beforeAll(async () => {
  helm = new TripService();
  // fast, deterministic payments
  const sim = (helm.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [5, 10];
  sim.declineMember = "";
  sim.timeoutMember = "";
  const app = express();
  app.use("/api", apiRouter(helm));
  http = createServer(app);
  attachRealtime(http, helm);
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://localhost:${(http.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));

async function post<T>(path: string, body: unknown = {}, token?: string): Promise<T> {
  const res = await fetch(base + "/api" + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json as T;
}

type Seed = { tripId: string; joinCode: string; organizer: { memberId: string; memberToken: string }; maya: { memberId: string; memberToken: string }; dev: { memberId: string; memberToken: string }; headsetCode: string };

function client(join: Record<string, unknown>) {
  const s: Socket = connect(base, { path: "/socket.io", transports: ["websocket"], forceNew: true });
  const events: { ev: string; p: any }[] = [];
  s.onAny((ev, p) => events.push({ ev, p }));
  s.on("connect", () => s.emit("trip:join", join));
  const waitFor = (pred: (e: { ev: string; p: any }) => boolean, ms = 8000) => new Promise<any>((resolve, reject) => {
    const hit = events.find(pred);
    if (hit) return resolve(hit.p);
    const t = setTimeout(() => reject(new Error("timeout waiting; saw: " + events.map((e) => e.ev).join(","))), ms);
    s.onAny((ev, p) => { if (pred({ ev, p })) { clearTimeout(t); resolve(p); } });
  });
  return { s, events, waitFor };
}

describe("Expo run over the wire", () => {
  it("seed → table → dry run → pick Lisbon → seals → booked, with privacy intact", async () => {
    const seed = await post<Seed>("/demo/seed?kind=expo");
    const pair = await post<{ deviceToken: string }>("/xr/pair", { code: seed.headsetCode });

    const rae = client({ tripId: seed.tripId, memberToken: seed.organizer.memberToken, surface: "phone" });
    const maya = client({ tripId: seed.tripId, memberToken: seed.maya.memberToken, surface: "phone" });
    const xr = client({ tripId: seed.tripId, deviceToken: pair.deviceToken, surface: "xr" });
    const gallery = client({ joinCode: seed.joinCode, surface: "gallery" });

    const st = await rae.waitFor((e) => e.ev === "trip:state");
    expect(st.status).toBe("BRIEFING");
    expect(st.crew.map((c: any) => c.briefSealed)).toEqual([true, true, true]);
    await maya.waitFor((e) => e.ev === "brief:private" && e.p.brief?.capCents === 90_000);
    // WP-11: memory lines may follow the brief in a second brief:private when recall is slow
    expect((await maya.waitFor((e) => e.ev === "brief:private" && Array.isArray(e.p.memory))).memory.join(" ")).toMatch(/conceded/i);
    await xr.waitFor((e) => e.ev === "trip:state");
    await gallery.waitFor((e) => e.ev === "trip:state");

    // the headset (not a member) starts the table; Rae hails after Watch 1. O2-062: no pacing (PACE_SCALE=0); Rae's
    // Watch-1 line waits for her hail instead, so the hail lands in Watch 2 exactly as on the real clock
    const release = holdForHail(helm, { memberId: seed.organizer.memberId });
    xr.s.emit("table:start", {});
    await rae.waitFor((e) => e.ev === "turn:new" && e.p.speaker.kind === "advocate" && e.p.speaker.memberId === seed.organizer.memberId && e.p.act === "PROPOSE");
    rae.s.emit("table:hail", { text: "I'd pay more for the beach." });

    const decided = await gallery.waitFor((e) => e.ev === "table:decided", 15000);
    release();
    expect(decided.shortlist.map((p: any) => p.planId)).toEqual(["MEX-W1-roma-flat", "LIS-W1-casa-alfama"]);
    const turns = gallery.events.filter((e) => e.ev === "turn:new").map((e) => e.p);
    expect(turns.map((t: any) => t.act)).toEqual(["OPEN", "PROPOSE", "PROPOSE", "PROPOSE", "HAIL", "OBJECT", "SUPPORT", "CONCEDE", "DECIDE"]);
    expect(turns.find((t: any) => t.act === "CONCEDE").text).toMatch(/^Heard you, Rae/); // the first concede of the meeting keeps the classic wording

    const mayaLis = await maya.waitFor((e) => e.ev === "plan:private" && e.p.planId === "LIS-W1-casa-alfama");
    expect(mayaLis.amountCents).toBe(86_800);
    const mayaMex = await maya.waitFor((e) => e.ev === "plan:private" && e.p.planId === "MEX-W1-roma-flat");
    expect(mayaMex.missing).toEqual(["beach"]);
    await rae.waitFor((e) => e.ev === "dryrun:script");

    // votes, then the headset picks Lisbon
    maya.s.emit("plan:vote", { planId: "LIS-W1-casa-alfama" });
    await gallery.waitFor((e) => e.ev === "plan:votes" && e.p.tallies["LIS-W1-casa-alfama"] === 1);
    expect(await maya.waitFor((e) => e.ev === "plan:myVote")).toEqual({ planId: "LIS-W1-casa-alfama" }); // private echo (TR1-009)
    xr.s.emit("plan:pick", { planId: "LIS-W1-casa-alfama" });
    const booking = await rae.waitFor((e) => e.ev === "booking:created");
    expect(booking.seals.find((s: any) => s.memberId === seed.dev.memberId).standing).toBe(true);
    const raeSeal = await rae.waitFor((e) => e.ev === "seal:private");
    expect(raeSeal.amountCents).toBe(103_800);

    // Dev auto-authorizes (standing instruction); Rae and Maya set their seals
    await gallery.waitFor((e) => e.ev === "seal:status" && e.p.memberId === seed.dev.memberId && e.p.status === "AUTHORIZED");
    // TR1-015: every surface hears of the booking before any seal on it moves
    for (const c of [rae, xr, gallery]) {
      await c.waitFor((e) => e.ev === "seal:status");
      const names = c.events.map((e) => e.ev);
      expect(names.indexOf("booking:created")).toBeLessThan(names.indexOf("seal:status"));
    }
    rae.s.emit("seal:set", { bookingId: booking.bookingId });
    maya.s.emit("seal:set", { bookingId: booking.bookingId });
    const result = await gallery.waitFor((e) => e.ev === "booking:result");
    expect(result.status).toBe("CAPTURED");
    expect(result.reference).toMatch(/^AA-LIS-/);
    await gallery.waitFor((e) => e.ev === "trip:state" && e.p.status === "BOOKED");

    // PRIVACY: headset + gallery never received a private event or any secret number
    for (const c of [xr, gallery]) {
      expect(c.events.filter((e) => (PRIVATE_EVENTS as readonly string[]).includes(e.ev))).toEqual([]);
      const dump = JSON.stringify(c.events);
      for (const secret of ["capCents", "amountCents\":103800", "86800", "96300", "90000", "110000", "140000", "286900", "197500"]) expect(dump).not.toContain(secret);
      // SEC-001: no per-member schedule in the public plan (attendance, own legs, arrivals)
      for (const key of ["\"attendees\"", "\"arrivals\"", "\"travel\"", "\"landMin\""]) expect(dump).not.toContain(key);
    }
    // Maya never got Rae's share
    expect(JSON.stringify(maya.events)).not.toContain("103800");

    for (const c of [rae, maya, xr, gallery]) c.s.close();
  }, 30000);

  it("a lifted seal voids everyone; retry books on the second attempt", async () => {
    const seed = await post<Seed>("/demo/seed?kind=expo");
    const rae = client({ tripId: seed.tripId, memberToken: seed.organizer.memberToken, surface: "phone" });
    const maya = client({ tripId: seed.tripId, memberToken: seed.maya.memberToken, surface: "phone" });
    await rae.waitFor((e) => e.ev === "trip:state");
    await maya.waitFor((e) => e.ev === "trip:state");
    rae.s.emit("table:start", {});
    await rae.waitFor((e) => e.ev === "table:decided", 15000);
    rae.s.emit("plan:pick", { planId: "LIS-W1-casa-alfama" });
    const b1 = await rae.waitFor((e) => e.ev === "booking:created");
    rae.s.emit("seal:set", { bookingId: b1.bookingId });
    await rae.waitFor((e) => e.ev === "seal:status" && e.p.memberId === seed.organizer.memberId && e.p.status === "AUTHORIZED");
    maya.s.emit("seal:cancel", { bookingId: b1.bookingId });
    const voided = await rae.waitFor((e) => e.ev === "booking:result");
    expect(voided.status).toBe("VOIDED");
    expect((await maya.waitFor((e) => e.ev === "seal:declinedPrivate")).reason).toBe("user_cancelled");
    expect(rae.events.some((e) => e.ev === "seal:declinedPrivate")).toBe(false);
    // nobody else can tell whose seal failed
    expect(rae.events.some((e) => e.ev === "seal:status" && e.p.status === "DECLINED")).toBe(false);
    expect(JSON.stringify(rae.events.filter((e) => e.ev === "trip:state"))).not.toContain("DECLINED");

    rae.s.emit("booking:retry", {});
    await rae.waitFor((e) => e.ev === "trip:state" && e.p.status === "DRY_RUN");
    rae.s.emit("plan:pick", { planId: "LIS-W1-casa-alfama" });
    const b2 = await rae.waitFor((e) => e.ev === "booking:created" && e.p.attempt === 2);
    rae.s.emit("seal:set", { bookingId: b2.bookingId });
    maya.s.emit("seal:set", { bookingId: b2.bookingId });
    const ok = await rae.waitFor((e) => e.ev === "booking:result" && e.p.bookingId === b2.bookingId);
    expect(ok.status).toBe("CAPTURED");
    for (const c of [rae, maya]) c.s.close();
  }, 30000);

  it("rejects non-organizers and bad phases", async () => {
    const seed = await post<Seed>("/demo/seed?kind=expo");
    const maya = client({ tripId: seed.tripId, memberToken: seed.maya.memberToken, surface: "phone" });
    await maya.waitFor((e) => e.ev === "trip:state");
    maya.s.emit("table:start", {});
    expect((await maya.waitFor((e) => e.ev === "error")).code).toBe("NOT_ORGANIZER");
    maya.s.emit("plan:pick", { planId: "x" });
    await maya.waitFor((e) => e.ev === "error" && e.p.code === "NOT_ORGANIZER");
    maya.s.close();
  });
});

describe("REST guards", () => {
  it("headset pairing codes can't be brute-forced: guesses are rate limited per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await fetch(base + "/api/xr/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "ZZZZZ" + (i % 10) }) });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(403);
    expect(statuses.at(-1)).toBe(429);
  });

  it("a token holder can't add a second passkey to get around the owner's (PRD E2)", async () => {
    const seed = await post<Seed>("/demo/seed?kind=expo");
    const origin = "http://localhost";
    // S2-009: Maya's own phone holds her seat's passkey claim (a demo phone gets it when it redeems its handoff)
    const cookie = `aa_pk_${seed.maya.memberId}=${mintPasskeyClaim(seed.maya.memberId)}`;
    const req = (path: string, body: unknown) => fetch(base + `/api/trips/${seed.tripId}/passkey/${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${seed.maya.memberToken}`, Cookie: cookie },
    });
    // a minimal software authenticator ("none" attestation, ES256)
    const register = async () => {
      const opts = await (await req("register/options", {})).json();
      if (!opts.challenge) return opts;
      const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const jwk = publicKey.export({ format: "jwk" });
      const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
      const credId = Buffer.from(createHash("sha256").update(String(Math.random())).digest().subarray(0, 16));
      const authData = Buffer.concat([
        createHash("sha256").update("localhost").digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
        Buffer.from([0, credId.length]), credId, Buffer.from(isoCBOR.encode(cose as never)),
      ]);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]) as never);
      const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin, crossOrigin: false });
      const response = {
        id: credId.toString("base64url"), rawId: credId.toString("base64url"), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: Buffer.from(clientDataJSON).toString("base64url"), attestationObject: Buffer.from(attestationObject).toString("base64url"), transports: ["internal"] },
      };
      return (await req("register/verify", { response })).json();
    };
    expect(await register()).toEqual({ ok: true });
    const again = await req("register/options", {});
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("PASSKEY_EXISTS");
  });
});
