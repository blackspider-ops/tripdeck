// PAYMENTS_MODE=visa_sandbox: the Visa Developer sandbox client (ported from Samewhere), MLE, PAV, the status line and
// the seal-time card check. Every test mocks the network: no real Visa call is ever made here.
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VisaClient, xPayToken, type HttpsRequestFn } from "../src/payments/visa/client.js";
import { jweDecrypt, jweEncrypt, mleUnwrap, mleWrap } from "../src/payments/visa/mle.js";
import { PAV_SANDBOX_TEST_PAN, pavRequestBody, validateAccount } from "../src/payments/visa/pav.js";
import { probeVisa, setVisaClientForTests, verifyCard, visaHealth } from "../src/payments/visa/status.js";
import { VisaSandboxProvider } from "../src/payments/visa/provider.js";
import { REPO_ROOT, visaPath } from "../src/payments/visa/config.js";
import { PaymentsOrchestrator } from "../src/payments/orchestrator.js";
import { SimProvider } from "../src/payments/sim.js";
import type { VisaCredentials } from "../src/payments/visa/config.js";

const creds = (over: Partial<VisaCredentials> = {}): VisaCredentials => ({
  baseUrl: "https://sandbox.api.visa.com", timeoutMs: 1000,
  tls: { cert: Buffer.from("CERT"), key: Buffer.from("KEY") }, basic: { userId: "user-x", password: "pass-y" }, xpay: null, mle: null, ...over,
});

/** A fake https.request: records what was sent and answers with `status` / `body`. */
function fakeHttps(status: number, body: unknown, seen: { url?: URL; opts?: Record<string, unknown>; sent?: string }[] = []): HttpsRequestFn {
  return ((url: URL, opts: Record<string, unknown>, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { write(s: string): void; end(): void; destroy(e: Error): void };
    const rec: { url?: URL; opts?: Record<string, unknown>; sent?: string } = { url, opts };
    seen.push(rec);
    req.write = (s: string) => { rec.sent = (rec.sent ?? "") + s; };
    req.destroy = (e: Error) => req.emit("error", e);
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
      res.statusCode = status; res.headers = { "x-correlation-id": "corr-1" };
      cb(res);
      res.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
      res.emit("end");
    };
    return req;
  }) as unknown as HttpsRequestFn;
}

afterEach(() => { setVisaClientForTests(undefined); vi.restoreAllMocks(); });

describe("Visa client (two-way SSL + basic auth; X-Pay; MLE)", () => {
  it("sends the client certificate and basic auth, and never puts a secret in an error", async () => {
    const seen: { url?: URL; opts?: Record<string, unknown> }[] = [];
    const ok = new VisaClient(creds(), fakeHttps(200, { message: "helloworld" }, seen));
    const r = await ok.helloWorld();
    expect(r.status).toBe(200);
    expect(seen[0].url!.pathname).toBe("/vdp/helloworld");
    expect(seen[0].opts!.cert).toEqual(Buffer.from("CERT"));
    expect((seen[0].opts!.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("user-x:pass-y").toString("base64")}`);
    const bad = new VisaClient(creds(), fakeHttps(401, { responseStatus: { code: "9124" } }));
    const err = await bad.helloWorld().catch((e: Error) => e);
    expect(String(err)).toMatch(/401 9124/);
    expect(String(err)).not.toMatch(/user-x|pass-y|CERT|KEY/);
  });

  it("X-Pay-Token is xv2:<ts>:<hmac hex>", () => {
    expect(xPayToken("secret", "helloworld", "apikey=k", "", 1_700_000_000)).toMatch(/^xv2:1700000000:[0-9a-f]{64}$/);
  });

  it("MLE: a JWE round-trips, and a tampered one is refused", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwe = jweEncrypt(JSON.stringify({ a: 1 }), pub, "kid-1");
    expect(JSON.parse(jweDecrypt(jwe, priv).plaintext)).toEqual({ a: 1 });
    expect(jweDecrypt(jwe, priv).header.kid).toBe("kid-1");
    const parts = jwe.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => jweDecrypt(parts.join("."), priv)).toThrow();
    expect(mleUnwrap(mleWrap({ b: 2 }, pub, "kid-1"), priv)).toEqual({ b: 2 });
    expect(mleUnwrap({ plain: true }, priv)).toEqual({ plain: true });
  });
});

describe("Payment Account Validation (sandbox test card)", () => {
  it("builds the documented request and reads actionCode 00 / 85 as valid", async () => {
    const body = pavRequestBody();
    expect(body.primaryAccountNumber).toBe(PAV_SANDBOX_TEST_PAN);
    expect(body.retrievalReferenceNumber).toMatch(/^\d{12}$/);
    const seen: { url?: URL; sent?: string }[] = [];
    const ok = await validateAccount(new VisaClient(creds(), fakeHttps(200, { actionCode: "00", responseCode: "5" }, seen)), { mle: false });
    expect(ok).toMatchObject({ valid: true, actionCode: "00" });
    expect(seen[0].url!.pathname).toBe("/pav/v1/cardvalidation");
    const no = await validateAccount(new VisaClient(creds(), fakeHttps(200, { actionCode: "05" })), { mle: false });
    expect(no.valid).toBe(false);
  });
});

describe("status line and card check (never throws, never leaks)", () => {
  it("health reports booleans and the last outcome; PAV maps to the labels", async () => {
    setVisaClientForTests(new VisaClient(creds(), fakeHttps(200, { actionCode: "85" })));
    expect(await verifyCard()).toMatchObject({ result: "verified", label: "Visa sandbox: card verified", actionCode: "85" });
    expect(visaHealth().live).toBe(true);
    setVisaClientForTests(new VisaClient(creds(), fakeHttps(500, { reason: "down" })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await verifyCard()).toMatchObject({ result: "unavailable" });
    expect((await probeVisa()).ok).toBe(false);
    const h = visaHealth();
    expect(h.live).toBe(false);
    expect(JSON.stringify(h)).not.toMatch(/user-x|pass-y|CERT|KEY/);
    setVisaClientForTests(null);
    expect(await verifyCard()).toBeNull();
  });

  it("the .visa/ PEM paths resolve from the repo root, like Samewhere's", () => {
    const prev = process.env.VISA_MLE_SERVER_CERT_PATH;
    process.env.VISA_MLE_SERVER_CERT_PATH = ".visa/mle-server-cert.pem";
    try { expect(visaPath("VISA_MLE_SERVER_CERT_PATH")).toBe(`${REPO_ROOT}/.visa/mle-server-cert.pem`); } finally { process.env.VISA_MLE_SERVER_CERT_PATH = prev ?? ""; }
    expect(REPO_ROOT.endsWith("apps/server")).toBe(false);
  });
});

describe("seal-time card check (visa_sandbox): all-or-nothing still holds", () => {
  function setup(verdict: (memberId: string) => "verified" | "not_verified" | "unavailable") {
    const sim = new SimProvider();
    sim.latency = [0, 1]; sim.declineMember = ""; sim.timeoutMember = "";
    const provider = new VisaSandboxProvider(sim, async () => null);
    provider.verifyAccount = async (m: string) => ({ result: verdict(m), label: `Visa sandbox: ${verdict(m)}` });
    const results: string[] = [];
    const declined: string[] = [];
    const orch = new PaymentsOrchestrator(provider, {
      sealStatus: () => undefined, declinedPrivate: (_b, m, r) => declined.push(`${m}:${r}`), result: (_b, s) => results.push(s), persist: () => undefined,
    });
    orch.settleMs = 0;
    const b = orch.create({ tripId: "t", planId: "p", cityId: "LIS", attempt: 1, shares: [
      { memberId: "rae", amountCents: 50_000, capCents: 90_000 }, { memberId: "maya", amountCents: 60_000, capCents: 90_000 },
    ] });
    return { sim, orch, b, results, declined, provider };
  }

  it("every card verified → CAPTURED, labelled visa_sandbox", async () => {
    const { orch, b, results, sim } = setup(() => "verified");
    await orch.setSeal(b._id, "rae"); await orch.setSeal(b._id, "maya");
    await orch.whenSettled(b._id);
    expect(b.mode).toBe("visa_sandbox");
    expect(results).toEqual(["CAPTURED"]);
    expect(sim.capturedCount()).toBe(2);
    expect(b.seals.every((s) => s.cardCheck === "Visa sandbox: verified")).toBe(true);
  });

  it("one card not verified (or the sandbox down) → that seal declines privately, the booking voids, nobody charged", async () => {
    for (const bad of ["not_verified", "unavailable"] as const) {
      const { orch, b, results, declined, sim } = setup((m) => (m === "maya" ? bad : "verified"));
      await orch.setSeal(b._id, "rae"); await orch.setSeal(b._id, "maya");
      await orch.whenSettled(b._id);
      expect(results).toEqual(["VOIDED"]);
      expect(declined).toEqual(["maya:card_not_verified"]);
      expect(sim.capturedCount()).toBe(0);
      expect(sim.heldCount()).toBe(0);
      expect(orch.toPublic(b).seals.map((s) => s.status)).toEqual(["VOIDED", "VOIDED"]); // nobody publicly blamed
    }
  });
});
