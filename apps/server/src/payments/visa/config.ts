/**
 * Visa Developer (VDP) sandbox settings (ported from Samewhere's payments/visa/config.ts), read at call time from env.
 * Never logs values or file contents.
 *
 *   PAYMENTS_MODE=visa_sandbox            switches the Visa sandbox on (default "sim": no Visa call at all)
 *   VISA_BASE_URL                         default https://sandbox.api.visa.com
 *   Two-Way SSL (mutual TLS) + HTTP basic auth, the default VDP auth:
 *     VISA_CERT_PATH  VISA_KEY_PATH  VISA_CA_PATH   PEM files (relative paths resolve from the repo root; blank →
 *                                                   .visa/cert.pem, .visa/key.pem, .visa/ca.pem if they exist)
 *     VISA_USER_ID  VISA_PASSWORD                   the project's credentials (Credentials → Two-Way SSL)
 *   X-Pay-Token (API key + shared secret):          VISA_API_KEY  VISA_SHARED_SECRET
 *   Message Level Encryption (JWE):                 VISA_MLE_KEY_ID  VISA_MLE_SERVER_CERT_PATH  VISA_MLE_PRIVATE_KEY_PATH
 *   VISA_TIMEOUT_MS                       per call (default 6000)
 *   VISA_PAV_TEST_PAN / VISA_PAV_TEST_EXPIRY / VISA_PAV_TEST_CVV2   override the sandbox test card PAV validates
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const env = (k: string, d = "") => process.env[k]?.trim() || d;
const num = (k: string, d: number) => { const v = Number(env(k)); return env(k) !== "" && Number.isFinite(v) && v > 0 ? v : d; };

/** The Tripdeck repo root: the nearest folder up from here whose package.json is the monorepo's (src and dist alike). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "all-ayes") return dir;
    } catch { /* keep walking */ }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}
export const REPO_ROOT = findRepoRoot();

export type VisaPaymentsMode = "sim" | "visa_sandbox";
export const paymentsModeSetting = (): VisaPaymentsMode => (env("PAYMENTS_MODE").toLowerCase() === "visa_sandbox" ? "visa_sandbox" : "sim");

export const VISA_SANDBOX_BASE = "https://sandbox.api.visa.com";
export const visaDir = () => join(REPO_ROOT, ".visa");

export interface VisaTls { cert: Buffer; key: Buffer; ca?: Buffer }
export interface VisaBasic { userId: string; password: string }
export interface VisaXPay { apiKey: string; sharedSecret: string }
export interface VisaMle { keyId: string; serverCertPem: string; clientPrivateKeyPem: string }

export interface VisaCredentials {
  baseUrl: string;
  timeoutMs: number;
  tls: VisaTls | null;
  basic: VisaBasic | null;
  xpay: VisaXPay | null;
  mle: VisaMle | null;
}

/** An env path (absolute, or relative to the repo root), else the conventional file in .visa/ when it exists. */
export function visaPath(k: string, fallbackName?: string): string | null {
  const v = env(k);
  if (v) return isAbsolute(v) ? v : resolve(REPO_ROOT, v);
  if (fallbackName) { const p = join(visaDir(), fallbackName); if (existsSync(p)) return p; }
  return null;
}

const readIf = (p: string | null): Buffer | null => {
  if (!p) return null;
  try { return readFileSync(p); } catch { return null; }
};

/** What is configured, without exposing any value (for /api/health). */
export function visaConfigSummary() {
  const has = (p: string | null) => Boolean(p && existsSync(p));
  return {
    mode: paymentsModeSetting(),
    mtls: { cert: has(visaPath("VISA_CERT_PATH", "cert.pem")), key: has(visaPath("VISA_KEY_PATH", "key.pem")), userId: Boolean(env("VISA_USER_ID")), password: Boolean(env("VISA_PASSWORD")) },
    mle: { keyId: Boolean(env("VISA_MLE_KEY_ID")), serverCert: has(visaPath("VISA_MLE_SERVER_CERT_PATH")), privateKey: has(visaPath("VISA_MLE_PRIVATE_KEY_PATH")) },
  };
}

/** Loads the credentials (reads the PEM files). null when neither two-way SSL (cert + key + user + password) nor X-Pay is configured. */
export function visaCredentials(): VisaCredentials | null {
  const cert = readIf(visaPath("VISA_CERT_PATH", "cert.pem"));
  const key = readIf(visaPath("VISA_KEY_PATH", "key.pem"));
  const ca = readIf(visaPath("VISA_CA_PATH", "ca.pem"));
  const userId = env("VISA_USER_ID"), password = env("VISA_PASSWORD");
  const tls = cert && key ? { cert, key, ...(ca ? { ca } : {}) } : null;
  const basic = userId && password ? { userId, password } : null;
  const apiKey = env("VISA_API_KEY"), sharedSecret = env("VISA_SHARED_SECRET");
  const xpay = apiKey && sharedSecret ? { apiKey, sharedSecret } : null;
  const mleKeyId = env("VISA_MLE_KEY_ID");
  const mleServer = readIf(visaPath("VISA_MLE_SERVER_CERT_PATH")), mleClient = readIf(visaPath("VISA_MLE_PRIVATE_KEY_PATH"));
  const mle = mleKeyId && mleServer && mleClient ? { keyId: mleKeyId, serverCertPem: mleServer.toString("utf8"), clientPrivateKeyPem: mleClient.toString("utf8") } : null;
  if (!(tls && basic) && !xpay) return null;
  return { baseUrl: env("VISA_BASE_URL", VISA_SANDBOX_BASE).replace(/\/+$/, ""), timeoutMs: num("VISA_TIMEOUT_MS", 6000), tls, basic, xpay, mle };
}
