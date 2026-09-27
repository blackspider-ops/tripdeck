/**
 * Visa Message Level Encryption (MLE): the request body travels as {"encData": "<compact JWE>"} encrypted to Visa's MLE
 * server certificate, with a `keyId` header naming the project's MLE key; the response comes back the same way,
 * encrypted to our MLE client key. JWE: alg RSA-OAEP-256, enc A128GCM, header {kid, iat (ms)}.
 * Implemented with node:crypto only (no JOSE dependency). Only used by APIs that require MLE (VISA_MLE_* set).
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, constants, privateDecrypt, publicEncrypt, randomBytes, type KeyLike } from "node:crypto";

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export interface JweHeader { alg: "RSA-OAEP-256"; enc: "A128GCM"; kid: string; iat: number; [k: string]: unknown }

/** Compact JWE of `plaintext` for the holder of `publicKeyOrCertPem` (a PEM certificate or public key). */
export function jweEncrypt(plaintext: string, publicKeyOrCertPem: string | KeyLike, kid: string, now = Date.now()): string {
  const header: JweHeader = { alg: "RSA-OAEP-256", enc: "A128GCM", kid, iat: now };
  const protectedB64 = b64u(JSON.stringify(header));
  const cek = randomBytes(16);
  const iv = randomBytes(12);
  const pub = typeof publicKeyOrCertPem === "string" ? createPublicKey(publicKeyOrCertPem) : publicKeyOrCertPem;
  const encryptedKey = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, cek);
  const cipher = createCipheriv("aes-128-gcm", cek, iv);
  cipher.setAAD(Buffer.from(protectedB64, "ascii"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [protectedB64, b64u(encryptedKey), b64u(iv), b64u(ct), b64u(tag)].join(".");
}

/** Decrypts a compact JWE (RSA-OAEP-256 / A128GCM) with our private key. Throws on anything malformed or tampered. */
export function jweDecrypt(jwe: string, privateKeyPem: string | KeyLike): { header: JweHeader; plaintext: string } {
  const parts = jwe.split(".");
  if (parts.length !== 5) throw new Error("MLE: not a compact JWE");
  const [protectedB64, ek, iv, ct, tag] = parts;
  const header = JSON.parse(unb64u(protectedB64).toString("utf8")) as JweHeader;
  if (header.alg !== "RSA-OAEP-256" || header.enc !== "A128GCM") throw new Error(`MLE: unsupported ${header.alg}/${header.enc}`);
  const key = typeof privateKeyPem === "string" ? createPrivateKey(privateKeyPem) : privateKeyPem;
  const cek = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, unb64u(ek));
  const decipher = createDecipheriv("aes-128-gcm", cek, unb64u(iv));
  decipher.setAAD(Buffer.from(protectedB64, "ascii"));
  decipher.setAuthTag(unb64u(tag));
  const plaintext = Buffer.concat([decipher.update(unb64u(ct)), decipher.final()]).toString("utf8");
  return { header, plaintext };
}

/** Wraps a JSON body for an MLE API. */
export const mleWrap = (body: unknown, serverCertPem: string, keyId: string) => ({ encData: jweEncrypt(JSON.stringify(body), serverCertPem, keyId) });

/** Unwraps an MLE response ({encData}) — or returns the body unchanged if Visa answered in clear (e.g. an error). */
export function mleUnwrap(body: unknown, clientPrivateKeyPem: string): unknown {
  const enc = body && typeof body === "object" ? (body as { encData?: unknown }).encData : undefined;
  if (typeof enc !== "string") return body;
  return JSON.parse(jweDecrypt(enc, clientPrivateKeyPem).plaintext);
}
