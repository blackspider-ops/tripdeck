/**
 * The crew (OPT-031): creating a voyage, joining, absent friends and their invites, sealed terms (briefs), and
 * "sail without them".
 */
import type { Band, BriefInput, CityId, Dataset, Origin, Role } from "@all-ayes/shared";
import {
  BANDS, CAP_MAX_CENTS, CAP_MIN_CENTS, DEALBREAKERS, MAX_CREW, MAX_DEALBREAKERS, MAX_MUST_HAVES, NAME_MAX_CHARS, NOTE_MAX_CHARS, ORIGINS,
  TAGS, TRIP_NAME_MAX_CHARS, formatDollars,
} from "@all-ayes/shared";
import { indexOf } from "../data/loader.js";
import { crewKeyHash, validCrewKey } from "../memory/memory.js";
import { STANDING_TTL_MS, type StandingInstruction } from "../payments/orchestrator.js";
import { persist } from "../store/db.js";
import { onJoinCodeClash } from "../store/hooks.js";
import { HelmError } from "../util/errors.js";
import { hash, newId, newJoinCode, newToken, nowIso, sameHash } from "../util/ids.js";
import { clean } from "../util/text.js";
import { DEFAULT_TRIP_NAME, OPEN_PHASES, briefOut, datasetHash, holdsSeat, type Actor, type BriefRec, type MemberRec, type TripRec } from "./records.js";
import type { Helm } from "./core.js";
import { storedStanding } from "./persistence.js";
import { revokePasskeys } from "../passkeys/passkeys.js";

const BAND_IDS = Object.keys(BANDS).map(Number);
const TERMS_SEALED = "Terms are sealed once the table meets.";
/** Organizers pick at least this many ports (A4). */
const MIN_PORTS = 2;

type Seat = { name: string; band: Band; origin: Origin; crewKey?: unknown };

export class Crew {
  constructor(private helm: Helm) {
    // L5-010: the database refused this voyage's join code (an archived voyage holds it): draw another and save again
    onJoinCodeClash((tripId) => this.redrawJoinCode(tripId));
  }

  /**
   * L5-010: codes are only checked against the voyages in memory, so an archived one can hold the code a new voyage
   * drew (about N/32⁶ per voyage). Its trip write then fails on the unique index; the voyage gets a fresh code, is
   * saved again, and its phones get the new code with the next trip:state.
   */
  redrawJoinCode(tripId: string) {
    const { helm } = this;
    const t = helm.trips.get(tripId);
    if (!t) return;
    const old = t.joinCode;
    let joinCode = newJoinCode();
    while (joinCode === old || helm.findByCode(joinCode)) joinCode = newJoinCode();
    helm.setJoinCode(t, joinCode);
    console.warn(`[helm] voyage ${t._id}: join code ${old} is taken by a stored voyage; now ${joinCode}`);
    helm.save(t);
    helm.broadcastState(t);
  }

  createTrip(p: { name: string; organizerName: string; band: Band; origin: Origin; cityIds?: CityId[]; crewKey?: unknown }) {
    const { helm } = this;
    const name = clean(p.name, TRIP_NAME_MAX_CHARS) || DEFAULT_TRIP_NAME;
    // A4: the organizer picks the ports (2–3 from the dataset); default = all
    const known = helm.ds.cities.map((c) => c._id);
    const picked = (p.cityIds ?? []).filter((c, i, a) => known.includes(c) && a.indexOf(c) === i);
    if (p.cityIds && picked.length < MIN_PORTS) throw new HelmError("BAD_INPUT", "Put at least two ports on the chart.");
    const candidateCityIds = picked.length >= MIN_PORTS ? picked : known;
    let joinCode = newJoinCode();
    while (helm.findByCode(joinCode)) joinCode = newJoinCode();
    const now = nowIso();
    const t: TripRec = {
      _id: newId(), joinCode, name, status: "BRIEFING", version: 0, organizerId: "",
      memberIds: [], removedMemberIds: [], candidateCityIds,
      negotiation: { watch: 0, running: false, seq: 0, round: 0, turns: [] }, votes: {}, attempt: 0, datasetHash: datasetHash(helm.ds), createdAt: now, updatedAt: now,
    };
    helm.addTrip(t);
    let added: ReturnType<Crew["addMember"]>;
    try {
      // O2-007: the room is still empty (and the organizer unset), so the organizer's seat isn't broadcast
      added = this.addMember(t, { name: p.organizerName, band: p.band, origin: p.origin, crewKey: p.crewKey }, "organizer", false);
    } catch (e) {
      helm.removeTrip(t); // no organizer-less orphan voyages
      throw e;
    }
    const { member, token, crewKey } = added;
    t.organizerId = member._id;
    helm.save(t);
    return { trip: t, member, token, crewKey };
  }

  private addMember(t: TripRec, p: Seat, role: Role, broadcast = true) {
    const { helm } = this;
    if (helm.activeMembers(t).length >= MAX_CREW) throw new HelmError("CREW_FULL", `This crew is full (${MAX_CREW} max).`);
    if (t.status !== "BRIEFING") throw new HelmError("BAD_PHASE", "The table has already met.");
    const name = clean(p.name, NAME_MAX_CHARS);
    if (!name) throw new HelmError("BAD_INPUT", "Add a name.");
    if (!BAND_IDS.includes(p.band)) throw new HelmError("BAD_INPUT", "Pick a color band.");
    if (helm.activeMembers(t).some((m) => m.band === p.band)) throw new HelmError("BAND_TAKEN", "That color is taken.");
    if (!(ORIGINS as readonly string[]).includes(p.origin)) throw new HelmError("BAD_INPUT", "Pick where you fly from.");
    const token = newToken();
    // SEC-003: an absent seat gets its crew key when the friend claims it on their own phone, never the organizer's
    const crewKey = role === "absent" ? undefined : validCrewKey(p.crewKey) ? p.crewKey : newToken();
    // L1-009: an absent seat has its invite before anyone sees it, so the crew never sees it as "opened"
    const inviteKey = role === "absent" ? newToken() : undefined; // 256 bits; shown to the organizer once, stored hashed
    const member: MemberRec = {
      _id: newId(), tripId: t._id, name, role, band: p.band, origin: p.origin, tokenHash: hash(token), briefSealed: false,
      crewKeyHash: crewKey ? crewKeyHash(crewKey) : undefined, inviteKeyHash: inviteKey ? hash(inviteKey) : undefined,
    };
    helm.members.set(member._id, member);
    t.memberIds.push(member._id);
    persist("members", member);
    helm.save(t);
    if (broadcast) helm.broadcastState(t); // carries the new crew member (OPT-003: no separate member:joined)
    return { member, token, crewKey, inviteKey };
  }

  /**
   * Join with the voyage code (SEC-010): refused once the organizer closed the crew, and (addMember) once the table
   * has met. `crewKey` is the phone's private identity from an earlier voyage, if any; a new one is minted otherwise.
   */
  join(tripId: string, p: Seat) {
    const t = this.helm.trip(tripId);
    if (t.crewClosed) throw new HelmError("CREW_CLOSED", "The organizer has closed this crew. Ask them to open it.");
    const { member, token, crewKey } = this.addMember(t, p, "member");
    return { member, token, crewKey: crewKey ?? "" }; // a "member" seat always gets a key (only absent seats don't)
  }

  /** SEC-010: the organizer closes (or reopens) the crew to joins by code. Absent friends can still be added. */
  setCrewOpen(tripId: string, actor: Actor, open: boolean) {
    const t = this.helm.organizerTrip(tripId, actor);
    if (!!t.crewClosed === !open) return;
    t.crewClosed = !open;
    this.helm.save(t);
    this.helm.broadcastState(t);
  }

  addAbsent(tripId: string, actor: Actor, p: { name: string; band: Band; origin: Origin }) {
    const t = this.helm.organizerTrip(tripId, actor);
    const { member, inviteKey } = this.addMember(t, p, "absent");
    return inviteOut(t, member, inviteKey!);
  }

  /**
   * TR1-001: the organizer can fetch a fresh link for an absent friend who hasn't opened theirs yet (the key is only
   * ever stored hashed, so the old one can't be shown again; minting a new one retires it). Organizer phone only.
   */
  reissueInvite(tripId: string, actor: Actor, memberId: string) {
    const t = this.helm.organizerTrip(tripId, actor);
    const m = this.helm.members.get(memberId);
    // S2-009: a seat the organizer reset is re-invited the same way, whatever its role
    if (!m || m.tripId !== tripId || m.role === "organizer" || (m.role !== "absent" && !m.inviteKeyHash) || t.removedMemberIds.includes(memberId)) {
      throw new HelmError("NOT_FOUND", "They aren't on this voyage as an absent friend.");
    }
    if (!m.inviteKeyHash) throw new HelmError("INVITE_CLAIMED", "They've already opened their link.");
    return this.mintInvite(t, m);
  }

  private mintInvite(t: TripRec, member: MemberRec) {
    const inviteKey = newToken(); // 256 bits; shown to the organizer once, only its hash is kept
    member.inviteKeyHash = hash(inviteKey);
    persist("members", member);
    return inviteOut(t, member, inviteKey);
  }

  /**
   * S2-009 / S2-012: the organizer's recovery for a seat someone else took (a leaked token that registered its own
   * passkey, or an invite opened by the wrong person). The seat's member token stops working at once (its sockets
   * drop), its passkeys and passkey claim are revoked, and a fresh invite link is minted for the rightful member to
   * re-claim on their own phone. Sealed terms stay (they can re-seal). Only while no money moves (BRIEFING, VOIDED),
   * never the organizer's own seat, and every crew member sees the seat go back to "invite not opened".
   */
  resetSeat(tripId: string, actor: Actor, memberId: string) {
    const { helm } = this;
    const t = helm.organizerTrip(tripId, actor, { phoneOnly: "Reset a seat from the organizer's phone." });
    const m = helm.members.get(memberId);
    if (!m || m.tripId !== tripId || !holdsSeat(t, memberId) || memberId === t.organizerId) {
      throw new HelmError("NOT_FOUND", "They aren't on this crew.");
    }
    if (!OPEN_PHASES.includes(t.status)) throw new HelmError("BAD_PHASE", "A seat can be reset before the table meets, or after a void.");
    m.tokenHash = hash(newToken()); // nobody holds this one: the old token is dead until the seat is claimed again
    revokePasskeys(memberId);
    const invite = this.mintInvite(t, m); // persists the member
    helm.evictSockets(memberId);
    helm.save(t);
    helm.broadcastState(t);
    return invite;
  }

  /**
   * The absent friend opens their invite (SEC-004). The claim mints a fresh member token that only this caller holds
   * (the seat's creation token was never handed out) and burns the invite. The organizer's own phone can't claim it:
   * a claim carrying the organizer's crew key is refused and the invite stays valid for the friend.
   */
  claimAbsent(tripId: string, memberId: string, inviteKey: string, crewKey?: unknown) {
    const m = this.helm.members.get(memberId);
    const t = this.helm.trips.get(tripId);
    // an absent friend's invite, or (S2-009) a reset seat's new link
    if (!t || !m || m.tripId !== tripId || m.role === "organizer" || !sameHash(inviteKey, m.inviteKeyHash)) throw new HelmError("BAD_INVITE", "That link isn't valid.");
    if (t.removedMemberIds.includes(memberId)) throw new HelmError("BAD_INVITE", "That seat was released.");
    const key = validCrewKey(crewKey) ? crewKey : newToken();
    const organizer = this.helm.members.get(t.organizerId);
    if (organizer?.crewKeyHash && organizer.crewKeyHash === crewKeyHash(key)) {
      throw new HelmError("OWN_INVITE", "This invite is for your friend. Send it to them; it opens their seat on their phone.");
    }
    const token = newToken();
    m.tokenHash = hash(token);
    m.crewKeyHash = crewKeyHash(key);
    // Single use: once the absent friend opens their link, nobody else (including the organizer) can take their seat
    m.inviteKeyHash = undefined;
    persist("members", m);
    // L1-009 / S2-012: every crew member sees that the invite was opened (a claim that wasn't the friend's shows)
    this.helm.broadcastState(t);
    return { memberToken: token, crewKey: key };
  }

  // ---------- briefs ----------
  async submitBrief(tripId: string, memberId: string, input: BriefInput) {
    const { helm } = this;
    // OPT-064: a removed seat can't (re)seal
    const { t, m } = helm.memberTrip(tripId, memberId, OPEN_PHASES, TERMS_SEALED);
    if (t.status === "VOIDED") this.assertCanReopen(t, memberId);
    const b = validateBrief(input, helm.ds);
    const sealedAt = nowIso();
    // TR4-017: the provider call comes first, so a failure can't leave a half-committed brief. If it fails the brief
    // still seals, without a standing instruction: that member then seals live (doc 06 §6 P1).
    if (m.role === "absent") {
      const prev = helm.payments.standing.get(memberId);
      let ins: StandingInstruction | null = null;
      try {
        ins = await helm.payments.createStanding(memberId, b.capCents, Date.parse(sealedAt) + STANDING_TTL_MS);
      } catch (e) {
        console.warn(`[helm] standing instruction for ${memberId} failed; they will seal live`, (e as Error).message);
        helm.payments.standing.delete(memberId); // an old instruction must not outlive the terms it was made for
      }
      // L4-003: "sail without them" may have released the seat while the provider answered. Nothing issued for a
      // removed seat outlives it (TR4-020): the new instruction goes, and nothing is stored.
      if (!holdsSeat(t, memberId)) {
        helm.payments.standing.delete(memberId);
        throw new HelmError("NOT_MEMBER", "You're not on this crew anymore.");
      }
      const restorePrev = () => { if (prev) helm.payments.standing.set(memberId, prev); else helm.payments.standing.delete(memberId); };
      if (!OPEN_PHASES.includes(t.status)) {
        restorePrev();
        throw new HelmError("BAD_PHASE", TERMS_SEALED);
      }
      if (t.status === "VOIDED") {
        try { this.assertCanReopen(t, memberId); } catch (e) {
          restorePrev();
          throw e;
        }
      }
      m.standing = ins ? storedStanding(ins) : undefined; // L5-007: the cap stays in the brief only
    }
    const rec: BriefRec = { ...b, _id: memberId, memberId, tripId, sealedAt };
    helm.briefs.set(memberId, rec);
    persist("briefs", rec);
    m.briefSealed = true;
    persist("members", m);
    if (t.status === "VOIDED") {
      helm.transition(t, "BRIEFING", { from: ["VOIDED"] });
      helm.table.clearCharts(t);
      // L3-006: new terms = a new round; the voided attempt's meeting is history, so a rejoin doesn't replay its turns
      helm.table.newRound(t);
    }
    helm.save(t);
    // WP-11 follow-up: the sealed terms go back at once; slow memory lines follow in a second brief:private
    const { later } = await helm.replayer.briefPrivate(m, briefOut(rec), (p) => helm.toMember(tripId, memberId, "brief:private", p));
    helm.broadcastState(t); // carries briefSealed (OPT-003: no separate brief:received)
    await later;
  }

  /**
   * L4-002 (decision b, doc 04 §5): after a void only the organizer's new terms reopen the briefing (VOIDED →
   * BRIEFING, which drops the Two Charts). Anyone else's re-seal would throw away "back to the charts" for the whole
   * crew, so it is refused and the voyage stays VOIDED until the organizer chooses. (L4-001: new terms stay allowed
   * while a refund is owed; `transition()` refuses the next table and `pick` the next booking until it clears.)
   */
  private assertCanReopen(t: TripRec, memberId: string) {
    if (memberId !== t.organizerId) {
      throw new HelmError("BAD_PHASE", "The organizer chooses what's next: back to the charts, or new terms for everyone.");
    }
  }

  sailWithout(tripId: string, actor: Actor, memberIds: string[]) {
    const { helm } = this;
    const t = helm.organizerTrip(tripId, actor, {
      phoneOnly: "Sail without them from the organizer's phone.", phases: ["BRIEFING"], phaseMessage: "Only before the table meets.",
    });
    const removed: string[] = [];
    for (const id of Array.isArray(memberIds) ? memberIds : []) {
      const m = helm.members.get(id);
      // TR4-020: idempotent (no duplicate entries), and nothing issued for a removed seat outlives it
      if (!m || id === t.organizerId || !holdsSeat(t, id) || m.briefSealed) continue;
      t.removedMemberIds.push(id);
      delete t.votes[id];
      helm.payments.standing.delete(id);
      if (m.standing || m.inviteKeyHash) { m.standing = undefined; m.inviteKeyHash = undefined; persist("members", m); }
      helm.pendingHails.set(tripId, (helm.pendingHails.get(tripId) ?? []).filter((x) => x.memberId !== id));
      removed.push(id);
    }
    if (!removed.length) return;
    helm.save(t);
    for (const id of removed) helm.evictSockets(id); // TR4-001: their sockets drop out of the member room
    helm.broadcastState(t);
  }
}

/** SEC-019: the key rides in the fragment, so it never reaches a server log; the phone strips it on open. */
const inviteOut = (t: TripRec, member: MemberRec, inviteKey: string) =>
  ({ memberId: member._id, inviteKey, invitePath: `/t/${t.joinCode}/brief#m=${member._id}&k=${inviteKey}` });

/** Sealed terms as the helm keeps them: caps in range, known ids only, deduped and capped lists, a cleaned note. */
export function validateBrief(input: BriefInput, ds: Dataset): BriefInput {
  const cap = Math.round(Number(input.capCents));
  if (!Number.isFinite(cap) || cap < CAP_MIN_CENTS || cap > CAP_MAX_CENTS) {
    throw new HelmError("BAD_INPUT", `Set what you can do, between ${formatDollars(CAP_MIN_CENTS)} and ${formatDollars(CAP_MAX_CENTS)}.`);
  }
  const known = indexOf(ds).window;
  const windows = (input.dateWindowIds ?? []).filter((id) => known.has(id));
  if (!windows.length) throw new HelmError("BAD_INPUT", "Pick at least one set of dates.");
  const tagIds = new Set(TAGS.map((x) => x.id));
  const dbIds = new Set(DEALBREAKERS.map((x) => x.id));
  const mustHaves = [...new Set(input.mustHaves ?? [])].filter((x) => tagIds.has(x)).slice(0, MAX_MUST_HAVES);
  const dealbreakers = [...new Set(input.dealbreakers ?? [])].filter((x) => dbIds.has(x)).slice(0, MAX_DEALBREAKERS);
  const note = clean(input.note, NOTE_MAX_CHARS) || undefined;
  // TR4-006: the note reaches the member's own Advocate (filtered); its source only means something with a note
  return { capCents: cap, dateWindowIds: windows, mustHaves, dealbreakers, note, noteSource: note ? (input.noteSource === "voice" ? "voice" : "typed") : undefined };
}
