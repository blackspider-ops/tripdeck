/**
 * Visa Developer HTTP client over node:https.
 *
 *   auth "mtls"  Two-Way SSL: the project's client certificate + private key (and the CA bundle Visa gives you) on the
 *                TLS connection, plus HTTP Basic auth with the project's user ID / password. Default for VDP APIs.
 *   auth "xpay"  X-Pay-Token: `?apikey=` on the URL and header x-pay-token = "xv2:" + ts + ":" + HMAC-SHA256(secret,
 *                ts + resourcePath + queryString + body) (hex). No client certificate.
 *   mle: true    Message Level Encryption on top (body → {encData: JWE}, header keyId, response decrypted).
 *
 * Secrets never appear in errors or logs: errors carry the method, path, status and Visa's error code only.
 * `requestImpl` is injectable so tests never open a socket to Visa.
 */
import { createHmac } from "node:crypto";
import https from "node:https";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { VisaCredentials } from "./config.js";
import { mleUnwrap, mleWrap } from "./mle.js";

export type VisaAuth = "mtls" | "xpay";
export type HttpsRequestFn = (url: URL, opts: RequestOptions, cb: (res: IncomingMessage) => void) => import("node:http").ClientRequest;

export interface VisaResponse<T = unknown> { status: number; body: T; latencyMs: number; correlationId?: string }

export class VisaError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = "VisaError"; }
}

/**
 * X-Pay-Token (xv2). `resourcePath` is the URL path without the leading "/vdp/" context (e.g. "helloworld"), and
 * `queryString` is the raw query without "?" (it includes apikey=...).
 */
export function xPayToken(sharedSecret: string, resourcePath: string, queryString: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  const hmac = createHmac("sha256", sharedSecret).update(`${ts}${resourcePath}${queryString}${body}`).digest("hex");
  return `xv2:${ts}:${hmac}`;
}

/** "/vdp/helloworld" → "helloworld"; "/pav/v1/cardvalidation" → "pav/v1/cardvalidation". */
export const xPayResourcePath = (pathname: string) => pathname.replace(/^\/+/, "").replace(/^(vdp|vacp)\//, "");

export interface VisaRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** e.g. "/vdp/helloworld" */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  auth?: VisaAuth;
  mle?: boolean;
  headers?: Record<string, string>;
}

export class VisaClient {
  constructor(private creds: VisaCredentials, private requestImpl: HttpsRequestFn = https.request as unknown as HttpsRequestFn) {}

  get canMtls() { return Boolean(this.creds.tls && this.creds.basic); }
  get canXPay() { return Boolean(this.creds.xpay); }
  get canMle() { return Boolean(this.creds.mle); }

  async request<T = unknown>(r: VisaRequest): Promise<VisaResponse<T>> {
    const auth: VisaAuth = r.auth ?? (this.canMtls ? "mtls" : "xpay");
    const url = new URL(r.path, this.creds.baseUrl + "/");
    for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json", ...r.headers };
    const opts: RequestOptions & { cert?: Buffer; key?: Buffer; ca?: Buffer } = { method: r.method, headers, timeout: this.creds.timeoutMs };

    let payload: unknown = r.body;
    if (r.mle) {
      const mle = this.creds.mle;
      if (!mle) throw new VisaError("Visa MLE is required for this API but VISA_MLE_* is not configured");
      if (payload !== undefined) payload = mleWrap(payload, mle.serverCertPem, mle.keyId);
      headers.keyId = mle.keyId;
    }
    const bodyText = payload === undefined ? "" : JSON.stringify(payload);
    if (bodyText) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(bodyText)); }

    if (auth === "mtls") {
      const { tls, basic } = this.creds;
      if (!tls || !basic) throw new VisaError("Visa two-way SSL is not configured (VISA_CERT_PATH, VISA_KEY_PATH, VISA_USER_ID, VISA_PASSWORD)");
      opts.cert = tls.cert;
      opts.key = tls.key;
      if (tls.ca) opts.ca = tls.ca;
      headers.authorization = `Basic ${Buffer.from(`${basic.userId}:${basic.password}`).toString("base64")}`;
    } else {
      const x = this.creds.xpay;
      if (!x) throw new VisaError("Visa X-Pay-Token is not configured (VISA_API_KEY, VISA_SHARED_SECRET)");
      url.searchParams.set("apikey", x.apiKey);
      headers["x-pay-token"] = xPayToken(x.sharedSecret, xPayResourcePath(url.pathname), url.search.replace(/^\?/, ""), bodyText);
    }

    const t0 = Date.now();
    const raw = await new Promise<{ status: number; text: string; correlationId?: string }>((resolve, reject) => {
      const req = this.requestImpl(url, opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
          correlationId: String(res.headers?.["x-correlation-id"] ?? "") || undefined,
        }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new VisaError(`Visa ${r.method} ${url.pathname} timed out after ${this.creds.timeoutMs} ms`)));
      req.on("error", (e: Error) => reject(e instanceof VisaError ? e : new VisaError(`Visa ${r.method} ${url.pathname} failed: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
      if (bodyText) req.write(bodyText);
      req.end();
    });
    const latencyMs = Date.now() - t0;
    let body: unknown = raw.text;
    try { body = raw.text ? JSON.parse(raw.text) : {}; } catch { /* not JSON: keep the text */ }
    if (r.mle && this.creds.mle && raw.status < 400) body = mleUnwrap(body, this.creds.mle.clientPrivateKeyPem);
    if (raw.status < 200 || raw.status >= 300) {
      const code = errorCode(body);
      throw new VisaError(`Visa ${r.method} ${url.pathname} → ${raw.status}${code ? ` ${code}` : ""}`, raw.status, code);
    }
    return { status: raw.status, body: body as T, latencyMs, ...(raw.correlationId ? { correlationId: raw.correlationId } : {}) };
  }

  /** GET /vdp/helloworld: proves the credentials (cert/key/CA + basic auth, or X-Pay-Token) work end to end. */
  helloWorld(auth?: VisaAuth) { return this.request<{ message?: string; timestamp?: string }>({ method: "GET", path: "/vdp/helloworld", auth }); }
}

/** Visa error bodies vary by API: {responseStatus:{code,...}} or {errorResponse:{...}} or {code}. Returns a short code, never the body. */
function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, any>;
  const c = b.responseStatus?.code ?? b.errorResponse?.status ?? b.errorResponse?.reason ?? b.reason ?? b.code;
  return c === undefined ? undefined : String(c).slice(0, 60);
}
