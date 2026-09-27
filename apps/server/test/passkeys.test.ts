/**
 * WP-05 — passkeys that actually hold (TR3-001/TR1-003, TR5-003, SEC-008, TR4-014).
 * Real HTTP routes + a software authenticator (ES256, "none" attestation). Mongo is faked: persisted
 * documents are JSON round-tripped like the driver would, so a "restart" reloads them from here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, {
  PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "",
  WEBAUTHN_ORIGIN: "", PUBLIC_BASE_URL: "", WEBAUTHN_RP_ID: "",
}));

const docs = vi.hoisted(() => ({} as Record<string, Map<string, unknown>>));
vi.mock("../src/store/db.js", async () => ({
  persist: (col: string, doc: { _id: string }) => { (docs[col] ??= new Map()).set(doc._id, JSON.parse(JSON.stringify(doc))); },
  append: () => undefined,
  loadAll: async (col: string) => JSON.parse(JSON.stringify([...(docs[col]?.values() ?? [])])),
  // WP-10: filtered restore loads, reconnect hook, health. R2-WP-11: the filter applies (passkeys load per member,
  // and a new credential id is checked against the store)
  loadWhere: async (col: string, filter: Record<string, unknown> = {}) => {
    const { matches } = await import("./support/fakeDb.js");
    return JSON.parse(JSON.stringify([...(docs[col]?.values() ?? [])].filter((d) => matches(d as Record<string, unknown>, filter))));
  },
  deleteOldTurns: () => undefined,
  onDbConnected: () => undefined,
  dbHealth: () => ({ mode: "memory", degraded: false }),
  dbConnected: () => false,
  writesOn: () => true,
}));

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import express from "express";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { TripService } from "../src/trips/service.js";
import { apiRouter } from "../src/api/routes.js";
import { SimProvider } from "../src/payments/sim.js";
import { seedExpo } from "../src/demo/seed.js";
import {
  CHALLENGE_TTL_MS, consumeAssertion, hasPasskey, mintAssertion, mintPasskeyClaim, relyingParty, resetPasskeysForTests,
} from "../src/passkeys/passkeys.js";

const TUNNEL = "https://abc.trycloudflare.com";
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean) => { for (let i = 0; i < 400 && !pred(); i++) await settle(); };
const b64u = (b: Uint8Array | Buffer | string) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** A minimal platform authenticator: one ES256 key, bound to one rpID/origin. */
function authenticator(origin: string) {
  const rpID = new URL(origin).hostname;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }) as { publicKey: KeyObject; privateKey: KeyObject };
  const credId = randomBytes(16);
  let counter = 0;
  return {
    id: b64u(credId),
    register(challenge: string) {
      const jwk = publicKey.export({ format: "jwk" });
      const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
      const authData = Buffer.concat([sha256(rpID), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
        Buffer.from([0, credId.length]), credId, Buffer.from(isoCBOR.encode(cose as never))]);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]) as never);
      const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false });
      return {
        id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
      };
    },
    assert(challenge: string) {
      counter++;
      const ctr = Buffer.alloc(4); ctr.writeUInt32BE(counter);
      const authData = Buffer.concat([sha256(rpID), Buffer.from([0x05]), ctr]);
      const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false });
      const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      return {
        id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
      };
    },
    get counter() { return counter; },
  };
}

let http: Server;
let base = "";
let helm: TripService;
const server = async (h: TripService) => {
  helm = h;
  const app = express();
  app.use("/api", (req, res, next) => apiRouter(helm)(req, res, next));
  http = createServer(app);
  await new Promise<void>((r) => http.listen(0, r));
  base = `http://localhost:${(http.address() as AddressInfo).port}`;
};
function newHelm() {
  const h = new TripService();
  const sim = (h.payments as unknown as { provider: SimProvider }).provider;
  sim.latency = [1, 2]; sim.declineMember = ""; sim.timeoutMember = "";
  return h;
}
async function sealing(h: TripService) {
  const seed = await seedExpo(h);
  await h.startTable(seed.tripId, { memberId: seed.organizer.memberId });
  await until(() => h.trip(seed.tripId).status === "DRY_RUN");
  await h.pick(seed.tripId, { memberId: seed.organizer.memberId }, "LIS-W1-casa-alfama");
  return { ...seed, bookingId: h.trip(seed.tripId).bookingId! };
}

/** HTTP helper; `headers` models what a browser behind the Vite proxy sends (Host is always localhost:port). */
/** S2-009: the cookie the phone that joined or claimed a seat holds (minted here as the join/claim routes would). */
const claimFor = (memberId: string) => `aa_pk_${memberId}=${mintPasskeyClaim(memberId)}`;

/** `cookie`: the phone's passkey claim for this seat (S2-009); without one, registering is refused. */
function phone(tripId: string, token: string, cookie?: string) {
  const call = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await fetch(base + `/api/trips/${tripId}/passkey${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }), Authorization: `Bearer ${token}`,
        ...(cookie ? { Cookie: cookie } : {}), ...headers,
      },
    });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };
  return {
    status: (headers: Record<string, string>) => call("GET", "", headers),
    async register(a: ReturnType<typeof authenticator>, origin: string) {
      const opts = await call("POST", "/register/options", { Origin: origin }, {});
      if (opts.status !== 200) return opts;
      return call("POST", "/register/verify", { Origin: origin }, { response: a.register(opts.json.challenge) });
    },
    async approve(a: ReturnType<typeof authenticator>, origin: string, bookingId: string) {
      const opts = await call("POST", "/auth/options", { Origin: origin }, {});
      if (opts.status !== 200) return opts;
      return call("POST", "/auth/verify", { Origin: origin }, { response: a.assert(opts.json.challenge), bookingId });
    },
    authOptions: (origin: string) => call("POST", "/auth/options", { Origin: origin }, {}),
    authVerify: (origin: string, body: unknown) => call("POST", "/auth/verify", { Origin: origin }, body),
  };
}

beforeAll(() => server(newHelm()));
afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(process.env, { WEBAUTHN_ORIGIN: "", PUBLIC_BASE_URL: "", WEBAUTHN_RP_ID: "", NODE_ENV: "test" });
});

describe("relying party resolution (TR3-001 / TR1-003)", () => {
  it("prefers Origin, then Referer, then the configured origin, then X-Forwarded-Host; Host (proxy-rewritten) is last", () => {
    const host = "localhost:8787";
    expect(relyingParty({ origin: TUNNEL, host })).toEqual({ origin: TUNNEL, rpID: "abc.trycloudflare.com" });
    expect(relyingParty({ referer: `${TUNNEL}/t/ABC123/seal`, host }).rpID).toBe("abc.trycloudflare.com");
    expect(relyingParty({ origin: "null", referer: `${TUNNEL}/x`, host }).rpID).toBe("abc.trycloudflare.com");
    expect(relyingParty({ forwardedHost: "abc.trycloudflare.com", forwardedProto: "https", host }).origin).toBe(TUNNEL);
    expect(relyingParty({ host }).rpID).toBe("localhost");
    process.env.WEBAUTHN_ORIGIN = TUNNEL;
    expect(relyingParty({ host }).rpID).toBe("abc.trycloudflare.com");
    // production pins the relying party whatever the request says
    process.env.NODE_ENV = "production"; process.env.WEBAUTHN_ORIGIN = "https://tripdeck.tech/";
    expect(relyingParty({ origin: TUNNEL, host })).toEqual({ origin: "https://tripdeck.tech", rpID: "tripdeck.tech" });
  });

  it("status, register and auth agree on the tunnel rpID behind the proxy; a second attempt prompts again instead of PASSKEY_REQUIRED", async () => {
    const s = await sealing(helm);
    const maya = phone(s.tripId, s.maya.memberToken, claimFor(s.maya.memberId));
    const key = authenticator(TUNNEL);
    expect((await maya.status({ Referer: `${TUNNEL}/t/x` })).json).toMatchObject({ registered: false, required: false });
    expect((await maya.register(key, TUNNEL)).json).toEqual({ ok: true });

    // same-origin GET: no Origin header, Host rewritten to localhost:port by the proxy; Referer still names the tunnel
    expect((await maya.status({ Referer: `${TUNNEL}/t/x` })).json).toMatchObject({ registered: true, required: true });
    // no Origin and no Referer: falls back to the configured origin, not the Host header
    process.env.WEBAUTHN_ORIGIN = TUNNEL;
    expect((await maya.status({})).json).toMatchObject({ registered: true, required: true });
    process.env.WEBAUTHN_ORIGIN = "";

    // attempt 1: Face ID → token → seal
    const t1 = await maya.approve(key, TUNNEL, s.bookingId);
    expect(t1.status).toBe(200);
    await expect(helm.setSeal(s.tripId, s.maya.memberId, s.bookingId)).rejects.toMatchObject({ code: "PASSKEY_REQUIRED" });
    await helm.setSeal(s.tripId, s.maya.memberId, s.bookingId, t1.json.assertionToken);
    await helm.setSeal(s.tripId, s.organizer.memberId, s.bookingId);
    await until(() => helm.trip(s.tripId).status !== "SEALING");

    // attempt 2 on a fresh booking (as after "Back to the charts"): the phone is told "registered", so it goes to auth
    const second = await sealing(helm);
    const maya2 = phone(second.tripId, second.maya.memberToken, claimFor(second.maya.memberId));
    const key2 = authenticator(TUNNEL);
    expect((await maya2.register(key2, TUNNEL)).json).toEqual({ ok: true });
    expect((await maya2.register(authenticator(TUNNEL), TUNNEL)).json.code).toBe("PASSKEY_EXISTS");
    expect((await maya2.status({ Referer: `${TUNNEL}/` })).json.registered).toBe(true);
    const t2 = await maya2.approve(key2, TUNNEL, second.bookingId);
    expect(t2.status).toBe(200);
    await helm.setSeal(second.tripId, second.maya.memberId, second.bookingId, t2.json.assertionToken);
    expect(helm.payments.bookings.get(second.bookingId)!.seals.find((x) => x.memberId === second.maya.memberId)!.status).not.toBe("PENDING");
  });

  it("a passkey on another address: dev may add one there; production explains the constraint instead of looping", async () => {
    const s = await sealing(helm);
    const maya = phone(s.tripId, s.maya.memberToken, claimFor(s.maya.memberId));
    expect((await maya.register(authenticator("http://localhost"), "http://localhost")).json).toEqual({ ok: true });
    expect((await maya.status({ Origin: TUNNEL })).json).toMatchObject({ registered: false, required: true });
    expect((await maya.authOptions(TUNNEL)).json.code).toBe("PASSKEY_MISSING");

    process.env.NODE_ENV = "production"; // unpinned production: one passkey per member, full stop
    expect((await maya.register(authenticator(TUNNEL), TUNNEL)).json.code).toBe("PASSKEY_ELSEWHERE");
    process.env.NODE_ENV = "test";

    const key = authenticator(TUNNEL);
    expect((await maya.register(key, TUNNEL)).json).toEqual({ ok: true });
    const t = await maya.approve(key, TUNNEL, s.bookingId);
    await helm.setSeal(s.tripId, s.maya.memberId, s.bookingId, t.json.assertionToken);
  });
});

describe("sealing without surprise passkey prompts (LIVE-001 / L3-007)", () => {
  it("a member with no passkey seals with the confirm tap; once one is added, the gate asks for it", async () => {
    const s = await sealing(helm);
    const maya = phone(s.tripId, s.maya.memberToken, claimFor(s.maya.memberId));
    expect((await maya.status({ Referer: `${TUNNEL}/t/x/seal` })).json).toMatchObject({ registered: false, required: false });
    await helm.setSeal(s.tripId, s.maya.memberId, s.bookingId); // no assertion, no registration
    expect(helm.payments.bookings.get(s.bookingId)!.seals.find((x) => x.memberId === s.maya.memberId)!.status).not.toBe("PENDING");

    // "Add a passkey" is a separate action; it never sets a seal by itself
    const second = await sealing(helm);
    const maya2 = phone(second.tripId, second.maya.memberToken, claimFor(second.maya.memberId));
    expect((await maya2.register(authenticator(TUNNEL), TUNNEL)).json).toEqual({ ok: true });
    expect(helm.payments.bookings.get(second.bookingId)!.seals.find((x) => x.memberId === second.maya.memberId)!.status).toBe("PENDING");
    await expect(helm.setSeal(second.tripId, second.maya.memberId, second.bookingId)).rejects.toMatchObject({ code: "PASSKEY_REQUIRED" });
  });

  it("the app's Referrer-Policy keeps the same-origin Referer, so status finds the page's own passkey", async () => {
    const { securityHeaders } = await import("../src/web.js");
    const headers: Record<string, string> = {};
    securityHeaders()({ headers: { host: "localhost" } } as never, { setHeader: (k: string, v: string) => { headers[k] = v; } } as never, () => undefined);
    expect(headers["Referrer-Policy"]).toBe("same-origin");

    const s = await sealing(helm);
    const maya = phone(s.tripId, s.maya.memberToken, claimFor(s.maya.memberId));
    expect((await maya.register(authenticator(TUNNEL), TUNNEL)).json).toEqual({ ok: true });
    // what the page sends behind a Host-rewriting proxy: no Origin on a same-origin GET, Referer = the page
    expect((await maya.status({ Referer: `${TUNNEL}/t/ABC123/seal` })).json).toMatchObject({ registered: true, required: true });
  });
});

describe("assertion tokens (SEC-008 / TR4-014)", () => {
  it("are bound to the booking: a token for booking X is refused for booking Y, and auth/verify refuses foreign bookings", async () => {
    const s = await sealing(helm);
    const maya = phone(s.tripId, s.maya.memberToken, claimFor(s.maya.memberId));
    const key = authenticator(TUNNEL);
    await maya.register(key, TUNNEL);

    const other = await sealing(helm);
    const opts = await maya.authOptions(TUNNEL);
    const foreign = await maya.authVerify(TUNNEL, { response: key.assert(opts.json.challenge), bookingId: other.bookingId });
    expect(foreign.json.code).toBe("BAD_BOOKING");
    expect((await maya.authVerify(TUNNEL, { response: key.assert("x") })).json.code).toBe("BAD_BOOKING");

    const forX = mintAssertion({ memberId: s.maya.memberId, bookingId: "bk_other", rpID: "abc.trycloudflare.com", credentialId: key.id });
    await expect(helm.setSeal(s.tripId, s.maya.memberId, s.bookingId, forX)).rejects.toMatchObject({ code: "PASSKEY_REQUIRED" });
    // another member's token doesn't work either
    const t = await maya.approve(key, TUNNEL, s.bookingId);
    expect(consumeAssertion(s.organizer.memberId, s.bookingId, t.json.assertionToken)).toBeNull();
    expect(consumeAssertion(s.maya.memberId, s.bookingId, t.json.assertionToken)).toBeNull(); // …and the attempt burned it
  });

  it("are single use and short lived; challenges expire after 5 minutes; the token isn't forwarded to the provider", async () => {
    const s = await sealing(helm);
    const maya = phone(s.tripId, s.maya.memberToken, claimFor(s.maya.memberId));
    const key = authenticator(TUNNEL);
    await maya.register(key, TUNNEL);

    const t = mintAssertion({ memberId: s.maya.memberId, bookingId: s.bookingId, rpID: "abc.trycloudflare.com", credentialId: key.id });
    expect(consumeAssertion(s.maya.memberId, s.bookingId, t)).not.toBeNull();
    expect(consumeAssertion(s.maya.memberId, s.bookingId, t)).toBeNull();

    const late = mintAssertion({ memberId: s.maya.memberId, bookingId: s.bookingId, rpID: "abc.trycloudflare.com", credentialId: key.id });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
    expect(consumeAssertion(s.maya.memberId, s.bookingId, late)).toBeNull();
    vi.restoreAllMocks();

    const opts = await maya.authOptions(TUNNEL);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + CHALLENGE_TTL_MS + 1000);
    expect((await maya.authVerify(TUNNEL, { response: key.assert(opts.json.challenge), bookingId: s.bookingId })).json.code).toBe("PASSKEY_FAILED");
    vi.restoreAllMocks();

    const provider = (helm.payments as unknown as { provider: SimProvider }).provider;
    const spy = vi.spyOn(provider, "createInstruction");
    const ok = await maya.approve(key, TUNNEL, s.bookingId);
    await helm.setSeal(s.tripId, s.maya.memberId, s.bookingId, ok.json.assertionToken);
    expect(spy).toHaveBeenCalledTimes(1);
    // TR4-014 / WP-14: only the fact that a passkey was verified reaches the provider, never the spent token
    const args = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.approvedWithPasskey).toBe(true);
    expect(JSON.stringify(args)).not.toContain(ok.json.assertionToken);
  });
});

describe("persistence (TR5-003)", () => {
  it("a restart keeps credentials and counters: the gate still holds, register is refused, Face ID still works", async () => {
    const s = await sealing(helm);
    const maya = phone(s.tripId, s.maya.memberToken, claimFor(s.maya.memberId));
    const key = authenticator(TUNNEL);
    await maya.register(key, TUNNEL);
    await maya.approve(key, TUNNEL, s.bookingId); // counter → 1
    const doc = docs.passkeys!.get(key.id) as { publicKey: unknown; counter: number; rpID: string; memberId: string };
    expect(typeof doc.publicKey).toBe("string");
    expect(doc).toMatchObject({ counter: 1, rpID: "abc.trycloudflare.com", memberId: s.maya.memberId });

    // restart: memory gone, everything reloaded from the (fake) database
    docs.trips = new Map([...helm.trips.values()].map((t) => [t._id, JSON.parse(JSON.stringify(t))]));
    docs.members = new Map([...helm.members.values()].map((m) => [m._id, JSON.parse(JSON.stringify(m))]));
    docs.briefs = new Map([...helm.briefs.values()].map((b) => [b.memberId, JSON.parse(JSON.stringify(b))]));
    docs.bookings = new Map([...helm.payments.bookings.values()].map((b) => [b._id, JSON.parse(JSON.stringify(b))]));
    resetPasskeysForTests();
    expect(hasPasskey(s.maya.memberId)).toBe(false);
    http.closeAllConnections?.(); await new Promise<void>((r) => http.close(() => r()));
    const next = newHelm();
    await next.restore();
    await server(next);
    expect(hasPasskey(s.maya.memberId, "abc.trycloudflare.com")).toBe(true);

    // the SEALING voyage was abandoned on restore; go again
    next.retry(s.tripId, { memberId: s.organizer.memberId });
    await next.pick(s.tripId, { memberId: s.organizer.memberId }, "LIS-W1-casa-alfama");
    const bookingId = next.trip(s.tripId).bookingId!;
    await expect(next.setSeal(s.tripId, s.maya.memberId, bookingId)).rejects.toMatchObject({ code: "PASSKEY_REQUIRED" });
    const again = phone(s.tripId, s.maya.memberToken, claimFor(s.maya.memberId));
    expect((await again.register(authenticator(TUNNEL), TUNNEL)).json.code).toBe("PASSKEY_EXISTS");
    const t = await again.approve(key, TUNNEL, bookingId);
    expect(t.status).toBe(200);
    expect((docs.passkeys!.get(key.id) as { counter: number }).counter).toBe(2);
    await next.setSeal(s.tripId, s.maya.memberId, bookingId, t.json.assertionToken);
  });
});

describe("S2-009: registering a passkey needs the claiming phone, not just the member token", () => {
  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(base + `/api${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    return { status: res.status, json: await res.json() as Record<string, any>, setCookie, cookie: setCookie.split(";")[0] };
  };
  const brief = { dateWindowIds: ["W1"], mustHaves: ["food"], dealbreakers: [] } as const;

  it("create/join/claim hand the phone an HttpOnly claim; a token alone is refused; an organizer reset lets the rightful member register and seal", async () => {
    const made = await post("/trips", { name: "x", organizerName: "Rae", band: 1, origin: "ATL" });
    const { tripId } = made.json;
    expect(made.setCookie).toMatch(new RegExp(`^aa_pk_${made.json.memberId}=`));
    expect(made.setCookie).toMatch(/HttpOnly/i);
    expect(made.setCookie).toMatch(/SameSite=Strict/i);
    expect(made.setCookie).toContain(`Path=/api/trips/${tripId}/passkey`);
    const joined = await post(`/trips/${tripId}/members`, { name: "Maya", band: 2, origin: "ORD" });
    const mayaId = joined.json.memberId as string;
    expect(joined.cookie).toMatch(new RegExp(`^aa_pk_${mayaId}=`));

    // a leaked token (no claim, or another seat's claim) can't bind an authenticator
    const leaked = phone(tripId, joined.json.memberToken);
    expect((await leaked.register(authenticator(TUNNEL), TUNNEL)).json.code).toBe("PASSKEY_UNBOUND");
    expect((await leaked.status({ Origin: TUNNEL })).json).toEqual({ registered: false, required: false, canRegister: false });
    const wrongSeat = phone(tripId, joined.json.memberToken, made.cookie.replace(made.json.memberId, mayaId).replace(/=.*/, "=nope"));
    expect((await wrongSeat.register(authenticator(TUNNEL), TUNNEL)).json.code).toBe("PASSKEY_UNBOUND");
    expect((await phone(tripId, joined.json.memberToken, made.cookie).register(authenticator(TUNNEL), TUNNEL)).json.code).toBe("PASSKEY_UNBOUND");

    // the shared-phone case: someone else, on Maya's claimed phone, adds *their* passkey first
    const onMayasPhone = phone(tripId, joined.json.memberToken, joined.cookie);
    expect((await onMayasPhone.status({ Origin: TUNNEL })).json.canRegister).toBe(true);
    const thief = authenticator(TUNNEL);
    expect((await onMayasPhone.register(thief, TUNNEL)).json).toEqual({ ok: true });
    expect(hasPasskey(mayaId)).toBe(true);

    // recovery: the organizer resets Maya's seat (never another member)
    expect((await post(`/trips/${tripId}/members/${mayaId}/reset`, {}, joined.json.memberToken)).json.code).toBe("NOT_ORGANIZER");
    const reset = await post(`/trips/${tripId}/members/${mayaId}/reset`, {}, made.json.memberToken);
    expect(reset.status).toBe(200);
    expect(reset.json.invitePath).toMatch(new RegExp(`^/t/[A-Z0-9]+/brief#m=${mayaId}&k=`));
    expect(hasPasskey(mayaId)).toBe(false);
    expect((docs.passkeys!.get(thief.id) as Record<string, unknown>).publicKey).toBeUndefined(); // tombstoned: a restart won't bring it back
    expect((await onMayasPhone.status({ Origin: TUNNEL })).status).toBe(403); // the old token is dead

    // Maya re-claims on her own phone: a new token and a new claim; the old claim no longer registers
    const claimed = await post(`/trips/${tripId}/absent/${mayaId}/claim`, { inviteKey: reset.json.inviteKey });
    expect(claimed.status).toBe(200);
    expect(claimed.cookie).toMatch(new RegExp(`^aa_pk_${mayaId}=`));
    expect((await phone(tripId, claimed.json.memberToken, joined.cookie).register(authenticator(TUNNEL), TUNNEL)).json.code).toBe("PASSKEY_UNBOUND");
    const maya = phone(tripId, claimed.json.memberToken, claimed.cookie);
    const key = authenticator(TUNNEL);
    expect((await maya.register(key, TUNNEL)).json).toEqual({ ok: true });

    // …and seals with it; the revoked passkey can't approve
    const rae = { memberId: made.json.memberId as string };
    await helm.submitBrief(tripId, rae.memberId, { ...brief, capCents: 110_000 } as never);
    await helm.submitBrief(tripId, mayaId, { ...brief, capCents: 110_000 } as never);
    await helm.startTable(tripId, rae);
    await until(() => helm.trip(tripId).status === "DRY_RUN");
    await helm.pick(tripId, rae, helm.trip(tripId).shortlistIds![0]);
    const bookingId = helm.trip(tripId).bookingId!;
    await expect(helm.setSeal(tripId, mayaId, bookingId)).rejects.toMatchObject({ code: "PASSKEY_REQUIRED" });
    expect((await maya.approve(thief, TUNNEL, bookingId)).json.code).toBe("PASSKEY_FAILED");
    const ok = await maya.approve(key, TUNNEL, bookingId);
    expect(ok.status).toBe(200);
    await helm.setSeal(tripId, mayaId, bookingId, ok.json.assertionToken);
    expect(helm.payments.bookings.get(bookingId)!.seals.find((s) => s.memberId === mayaId)!.instructionRef).toBeTruthy(); // set: on file
  }, 15_000);
});
