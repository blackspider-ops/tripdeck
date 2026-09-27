/**
 * Devices and one-time codes (OPT-031): the headset's pairing (SEC-018 / TR5-023) and the demo handoff links (SEC-004).
 */
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { HEADSET_REQUEST_TTL_MS, SEAL_PIN_LOCK_MS, SEAL_PIN_TRIES, validSealPin, type S2CPayload } from "@all-ayes/shared";
import { config } from "../config.js";
import { persist } from "../store/db.js";
import { HelmError } from "../util/errors.js";
import { hash, newRef, newToken, sameHash, sameHex } from "../util/ids.js";
import { MINUTE_MS } from "../util/limits.js";
import { DEVICE_TTL_MS, HANDOFF_TTL_MS, PAIR_CODE_CHARS, PAIR_CODE_TTL_MS, holdsSeat, type Actor, type MemberRec } from "./records.js";
import type { Helm } from "./core.js";

export class Identity {
  /** Quest-first: headsets as crew devices (attach requests, seal PINs). */
  readonly headsets: Headsets;
  constructor(private helm: Helm) { this.headsets = new Headsets(helm); }

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

/** Quest-first: a headset asking to sit in an existing seat (docs/04 §6). In memory only: a restart drops it. */
interface AttachRequest {
  id: string; secretHash: string; tripId: string; memberId: string; expiresAt: number;
  answer: "pending" | "approved" | "denied"; deviceToken?: string;
}
/** At most this many headset requests are held at once (the oldest go first). */
const ATTACH_MAX = 2000;
/** How long an answered request waits for its headset to collect the answer. */
const ATTACH_COLLECT_MS = 60_000;

/**
 * Quest-first (docs/03 §4, docs/04 §6): headsets as crew devices. A headset that starts or joins a voyage takes its
 * own seat like a phone (crew.ts, `device: "headset"`). One that belongs to an existing seat (the organizer who started
 * on a phone, a friend who joined on theirs) asks that seat's own device to let it in: one tap there mints a device
 * key bound to that member (core.ts memberByToken), 12 h, one headset per member. The seal PIN is for a headset
 * whose browser can't hold a passkey.
 */
export class Headsets {
  private requests = new Map<string, AttachRequest>();
  /** Wrong seal PINs per member, and until when the PIN is locked. In memory (a restart forgives them). */
  private pinFails = new Map<string, { fails: number; lockedUntil: number }>();
  constructor(private helm: Helm) {}

  private prune(now = Date.now()) {
    for (const [k, r] of this.requests) {
      const done = r.answer !== "pending" ? r.expiresAt + ATTACH_COLLECT_MS : r.expiresAt;
      if (done < now) this.requests.delete(k);
    }
    while (this.requests.size > ATTACH_MAX) { const k = this.requests.keys().next().value; if (k === undefined) break; this.requests.delete(k); }
  }

  /** A headset asks to sit in `memberId`'s seat on the voyage with this join code. Returns the poll secret. */
  requestAttach(joinCode: string, memberId: string) {
    const { helm } = this;
    const t = helm.tripByCode(joinCode);
    if (t.status === "BOOKED") throw new HelmError("BAD_PHASE", "This voyage is already logged.");
    const m = helm.members.get(String(memberId ?? ""));
    if (!m || m.tripId !== t._id || !holdsSeat(t, m._id)) throw new HelmError("NOT_FOUND", "That seat isn't on this crew.");
    // an unopened invite has no device to say yes: the friend opens their link first
    if (m.inviteKeyHash) throw new HelmError("NOT_FOUND", `${m.name}'s seat hasn't been opened on a phone yet.`);
    this.prune();
    // one pending request per seat: a new one replaces the last (its prompt goes away)
    for (const [k, r] of this.requests) {
      if (r.memberId === m._id && r.answer === "pending") { this.requests.delete(k); this.announce(r, m.name, true); }
    }
    const secret = newToken();
    const r: AttachRequest = { id: newToken(), secretHash: hash(secret), tripId: t._id, memberId: m._id, expiresAt: Date.now() + HEADSET_REQUEST_TTL_MS, answer: "pending" };
    this.requests.set(r.id, r);
    this.announce(r, m.name, false);
    return { requestId: r.id, secret, expiresAt: r.expiresAt, askName: m.name, tripId: t._id, joinCode: t.joinCode };
  }

  private announce(r: AttachRequest, memberName: string, answered: boolean) {
    this.helm.toMember(r.tripId, r.memberId, "headset:request", { requestId: r.id, memberName, expiresAt: r.expiresAt, ...(answered ? { answered: true } : {}) });
  }

  /** The pending request for this seat (a (re)joining phone's replay), or null. */
  pendingAttach(tripId: string, memberId: string): S2CPayload<"headset:request"> | null {
    const now = Date.now();
    for (const r of this.requests.values()) {
      if (r.tripId === tripId && r.memberId === memberId && r.answer === "pending" && r.expiresAt > now) {
        return { requestId: r.id, memberName: this.helm.members.get(memberId)?.name ?? "", expiresAt: r.expiresAt };
      }
    }
    return null;
  }

  /** The seat's own device answers (a member socket: only the member the request names may). */
  approveAttach(tripId: string, memberId: string, requestId: string, allow: boolean) {
    const { helm } = this;
    const { t, m } = helm.memberTrip(tripId, memberId);
    const r = this.requests.get(requestId);
    if (!r || r.tripId !== tripId || r.memberId !== memberId || r.answer !== "pending" || r.expiresAt <= Date.now()) {
      throw new HelmError("BAD_CODE", "That headset request has expired. Ask again from the headset.");
    }
    if (allow) {
      const token = newToken();
      // one headset per member: a new one replaces the last (whose key stops working at once)
      m.headset = { tokenHash: hash(token), expiresAt: Date.now() + DEVICE_TTL_MS };
      persist("members", m);
      r.answer = "approved";
      r.deviceToken = token;
      helm.save(t);
      helm.broadcastState(t); // the crew sees the seat on a headset
    } else {
      r.answer = "denied";
    }
    this.announce(r, m.name, true);
  }

  /** The headset polls its request with its secret. An approval hands the device key over once. */
  attachStatus(requestId: string, secret: string) {
    const r = this.requests.get(String(requestId ?? ""));
    if (!r || !secret || !sameHash(String(secret), r.secretHash)) throw new HelmError("BAD_CODE", "That headset request isn't known here. Ask again.");
    if (r.answer === "pending" && r.expiresAt <= Date.now()) { this.requests.delete(r.id); return { status: "expired" as const }; }
    if (r.answer === "denied") { this.requests.delete(r.id); return { status: "denied" as const }; }
    if (r.answer === "approved") {
      this.requests.delete(r.id);
      const t = this.helm.trips.get(r.tripId);
      return { status: "approved" as const, tripId: r.tripId, joinCode: t?.joinCode ?? "", memberId: r.memberId, deviceToken: r.deviceToken! };
    }
    return { status: "pending" as const, expiresAt: r.expiresAt };
  }

  /** The member's own device ends a headset it let in (and the headset itself may leave). */
  detach(tripId: string, memberId: string) {
    const { t, m } = this.helm.memberTrip(tripId, memberId);
    if (!m.headset) return;
    m.headset = undefined;
    persist("members", m);
    this.helm.save(t);
    this.helm.broadcastState(t);
  }

  // ---------- the seal PIN ----------
  /** Sets the member's seal PIN. Replacing one needs the current PIN (counted like a seal try). */
  setSealPin(tripId: string, memberId: string, pin: unknown, current?: unknown) {
    const { t, m } = this.helm.memberTrip(tripId, memberId);
    if (t.status === "BOOKED") throw new HelmError("BAD_PHASE", "This voyage is already logged.");
    if (!validSealPin(pin)) throw new HelmError("BAD_INPUT", "A seal PIN is 4 to 6 digits.");
    if (m.sealPin) this.checkSealPin(m, current);
    const salt = randomBytes(16).toString("hex");
    m.sealPin = { salt, hash: pinHash(salt, pin) };
    persist("members", m);
    return { ok: true as const };
  }

  /** Throws BAD_PIN (a wrong PIN, counted) or PIN_LOCKED (too many wrong ones); resets the count on a right one. */
  checkSealPin(m: MemberRec, pin: unknown) {
    const now = Date.now();
    const f = this.pinFails.get(m._id);
    if (f && f.lockedUntil > now) {
      throw new HelmError("PIN_LOCKED", `Too many wrong PINs. Try again in ${Math.ceil((f.lockedUntil - now) / MINUTE_MS)} minutes, or seal on your phone.`);
    }
    const ok = !!m.sealPin && validSealPin(pin) && sameHex(pinHash(m.sealPin.salt, pin), m.sealPin.hash);
    if (ok) { this.pinFails.delete(m._id); return; }
    const fails = (f && f.lockedUntil <= now && f.lockedUntil > 0 ? 0 : f?.fails ?? 0) + 1;
    const locked = fails >= SEAL_PIN_TRIES;
    this.pinFails.set(m._id, { fails: locked ? 0 : fails, lockedUntil: locked ? now + SEAL_PIN_LOCK_MS : 0 });
    if (locked) throw new HelmError("PIN_LOCKED", `Too many wrong PINs. Try again in ${SEAL_PIN_LOCK_MS / MINUTE_MS} minutes, or seal on your phone.`);
    throw new HelmError("BAD_PIN", `That PIN didn't match. ${SEAL_PIN_TRIES - fails} ${SEAL_PIN_TRIES - fails === 1 ? "try" : "tries"} left.`);
  }

  /** A reset seat loses its headset and PIN (crew.ts resetSeat). */
  forget(m: MemberRec) {
    m.headset = undefined;
    m.sealPin = undefined;
    m.onHeadset = undefined;
    this.pinFails.delete(m._id);
    for (const [k, r] of this.requests) if (r.memberId === m._id) this.requests.delete(k);
  }
}

/** scrypt of the PIN under a per-member salt (a 4–6 digit PIN is weak on its own: the try limit does the rest). */
const pinHash = (salt: string, pin: string) => scryptSync(pin, salt, 32).toString("hex");

/**
 * Short pairing codes are stored as an HMAC under a server secret (`PAIRING_SECRET`), so a leaked `trips` document
 * can't be brute-forced offline. Without the env var the secret is per process: a pending code dies with a restart
 * (codes last 10 minutes anyway).
 */
const pairCodeHash = (code: string) => createHmac("sha256", config.helm.pairingSecret()).update(code.toUpperCase()).digest("hex");
const samePairCode = (code: string, hashed?: string) => sameHex(pairCodeHash(code), hashed);
