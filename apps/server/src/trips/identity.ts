/**
 * Devices and one-time codes (OPT-031): the headset's pairing (SEC-018 / TR5-023) and the demo handoff links (SEC-004).
 */
import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { HelmError } from "../util/errors.js";
import { hash, newRef, newToken, sameHex } from "../util/ids.js";
import { MINUTE_MS } from "../util/limits.js";
import { DEVICE_TTL_MS, HANDOFF_TTL_MS, PAIR_CODE_CHARS, PAIR_CODE_TTL_MS, type Actor } from "./records.js";
import type { Helm } from "./core.js";

export class Identity {
  constructor(private helm: Helm) {}

  // ---------- demo handoff (SEC-004) ----------
  /** One-time demo handoff codes → member tokens, in memory only (never persisted), minted by the DEV_KEY-gated seed. */
  private handoffs = new Map<string, { tripId: string; memberId: string; token: string; expiresAt: number }>();
  mintHandoff(tripId: string, memberId: string, memberToken: string) {
    const code = newToken();
    this.pruneHandoffs();
    this.handoffs.set(hash(code), { tripId, memberId, token: memberToken, expiresAt: Date.now() + HANDOFF_TTL_MS });
    return code;
  }
  /** O2-042: expired handoff codes leave the map. */
  private pruneHandoffs(now = Date.now()) { for (const [k, v] of this.handoffs) if (v.expiresAt < now) this.handoffs.delete(k); }
  /** Test hook (R2-WP-11). */
  get handoffCount() { return this.handoffs.size; }
  /** Single use and short-lived; the seat must still be held. Returns that member's token. */
  redeemHandoff(tripId: string, memberId: string, code: string) {
    const k = typeof code === "string" && code ? hash(code) : "";
    const handoff = this.handoffs.get(k);
    this.handoffs.delete(k);
    this.pruneHandoffs(); // O2-042: expired codes go on redeem too, not only when a new one is minted
    if (!handoff || handoff.tripId !== tripId || handoff.memberId !== memberId || handoff.expiresAt < Date.now()
      || this.helm.memberByToken(tripId, handoff.token)?._id !== memberId) {
      throw new HelmError("BAD_HANDOFF", "That demo link was already used or has expired. Seed again from /demo.");
    }
    return { memberToken: handoff.token };
  }

  // ---------- headset pairing (SEC-018) ----------
  /** 8 characters from an unambiguous 32-letter alphabet (40 bits), single use, 10 minutes. */
  headsetCode(tripId: string, actor: Actor) {
    const t = this.helm.organizerTrip(tripId, actor);
    const code = newRef(PAIR_CODE_CHARS);
    const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
    this.helm.setHeadset(t, { ...t.headset, codeHash: pairCodeHash(code), expiresAt });
    this.helm.save(t);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  pairHeadset(code: string) {
    const c = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    // OPT-044: the guess is hashed once and looked up (O(1)), then compared in constant time
    const cand = c ? this.helm.findByPairHash(pairCodeHash(c)) : undefined;
    const t = cand?.headset && samePairCode(c, cand.headset.codeHash) && Date.now() < cand.headset.expiresAt ? cand : undefined;
    if (!t) throw new HelmError("BAD_CODE", `That headset code isn't valid (they last ${PAIR_CODE_TTL_MS / MINUTE_MS} minutes).`);
    const deviceToken = newToken();
    // single use; the old device is revoked; the new one expires in 12 h (SEC-018)
    this.helm.setHeadset(t, { codeHash: "", expiresAt: 0, deviceTokenHash: hash(deviceToken), deviceExpiresAt: Date.now() + DEVICE_TTL_MS });
    this.helm.save(t);
    return { tripId: t._id, joinCode: t.joinCode, deviceToken };
  }

  /** SEC-018: the organizer (phone) revokes the paired headset and any pending code. */
  unpairHeadset(tripId: string, actor: Actor) {
    const t = this.helm.organizerTrip(tripId, actor, { phoneOnly: "Unpair the headset from the organizer's phone." });
    if (!t.headset) return;
    this.helm.setHeadset(t, undefined); // a pending code stops resolving at once
    this.helm.save(t);
  }
}

/**
 * Short pairing codes are stored as an HMAC under a server secret (`PAIRING_SECRET`), so a leaked `trips` document
 * can't be brute-forced offline. Without the env var the secret is per process: a pending code dies with a restart
 * (codes last 10 minutes anyway).
 */
const pairCodeHash = (code: string) => createHmac("sha256", config.helm.pairingSecret()).update(code.toUpperCase()).digest("hex");
const samePairCode = (code: string, hashed?: string) => sameHex(pairCodeHash(code), hashed);
