// Socket.io event names + payloads (docs/04-technical-design.md §7). Keep in sync with the doc.
import type {
  Brief, BriefInput, BookingPublic, DeclineReason, PlanPrivate, PlanPublic, SealStatus,
  Surface, TripStateUpdate, Turn, DryRunScript, ShareLine,
} from "./types.js";

/**
 * TR3-007: every client → server event may carry a socket.io acknowledgement as its last argument. The server always
 * answers it exactly once: `{ok:true}` when the action was taken (or was a harmless no-op), else the refusal. The
 * refusal is also sent as a caller-only `error` event carrying the same `event` name, for listeners without an ack.
 */
export type Ack = { ok: true } | JoinAck | { ok: false; code: string; message: string };
/**
 * R2-WP-07 / L3-001: who `trip:join` let the caller in as. A credential that was sent but not accepted still joins
 * the public room as a spectator; `tokenRejected` says which one failed, and a caller-only `error {code, event:"trip:join"}`
 * with the matching JOIN_REFUSAL code is sent too (before the replay), for clients that don't read the ack.
 */
export type JoinRole = "member" | "device" | "spectator";
export interface JoinAck { ok: true; as: JoinRole; tokenRejected?: "member" | "device" }
/**
 * Caller-only `error` codes (event `trip:join`) for a credential the join didn't accept, and for a device action from a
 * headset whose pairing ended since it joined (instead of NOT_ORGANIZER / NOT_MEMBER):
 *   TOKEN_REJECTED — the member token matches no seat (rotated, mis-restored, or sailed without). The phone offers "Join again".
 *   DEVICE_EXPIRED — the headset's device token was replaced by a newer pairing, unpaired, or is past its 12 h TTL.
 *                    The headset forgets its key and shows the pairing card. Not sent once the voyage is BOOKED (the
 *                    headset just watches the logged voyage).
 */
export const JOIN_REFUSAL = {
  TOKEN_REJECTED: "This phone's key for the voyage no longer works. Join again to take a seat.",
  DEVICE_EXPIRED: "This headset isn't paired any more. Enter a new code from the organizer's phone.",
} as const;
export type JoinRefusalCode = keyof typeof JOIN_REFUSAL;
export type AckFn = (r: Ack) => void;
/**
 * L3-004: an event name outside ClientToServer that carries an ack is answered `{ok:false, code:"UNKNOWN_EVENT"}`
 * (no `error` event: it has no contract name to carry).
 */
export const UNKNOWN_EVENT = "UNKNOWN_EVENT";
/** A refusal, to the caller only. `event`: the client → server event that caused it (absent for join-time notices). */
export interface ErrorPayload { code: string; message: string; event?: keyof ClientToServer }

export interface ClientToServer {
  "trip:join": (p: { tripId?: string; joinCode?: string; memberToken?: string; deviceToken?: string; surface: Surface }, ack?: AckFn) => void;
  "brief:submit": (p: BriefInput, ack?: AckFn) => void;
  "table:start": (p: Record<string, never>, ack?: AckFn) => void;
  "table:sailWithout": (p: { memberIds: string[] }, ack?: AckFn) => void;
  "table:hail": (p: { text: string }, ack?: AckFn) => void;
  "dryrun:control": (p: { action: "pause" | "resume" | "restart" }, ack?: AckFn) => void;
  "plan:vote": (p: { planId: string }, ack?: AckFn) => void;
  "plan:pick": (p: { planId: string }, ack?: AckFn) => void;
  "seal:set": (p: { bookingId: string; assertionToken?: string }, ack?: AckFn) => void;
  "seal:cancel": (p: { bookingId: string }, ack?: AckFn) => void;
  "booking:retry": (p: Record<string, never>, ack?: AckFn) => void;
  /**
   * Organizer only (phone or paired headset): call off a booking that is still gathering seals. Every hold is
   * released, the booking and voyage go VOIDED with publicReason "The organizer called it off…" (SEC-011).
   * Refused with CAPTURING once every seal is set (captures under way). A booking also voids on its own when
   * its seals aren't all set within the seal deadline (default 10 min).
   */
  "booking:callOff": (p: { bookingId: string }, ack?: AckFn) => void;
  /**
   * Organizer only: close (open:false) or reopen the crew to joins by code (SEC-010). Broadcast via trip:state.crewClosed.
   * A non-boolean `open` is refused with BAD_INPUT (L3-004). The headset is unpaired over REST only
   * (`DELETE /api/trips/:id/headset`); the old `headset:unpair` socket event is gone (L3-004).
   */
  "crew:setOpen": (p: { open: boolean }, ack?: AckFn) => void;
  /** Fire and forget: never acknowledged, never queued offline (TR3-009). */
  "client:log": (p: { level: "log" | "warn" | "error"; msg: string; data?: unknown }) => void;
}

export interface ServerToClient {
  /** O2-040: the live broadcasts leave out the static fields (TripStateUpdate); a (re)join's replay carries them. */
  "trip:state": (s: TripStateUpdate) => void;
  "brief:private": (p: { brief: Brief | null; memory?: string[] }) => void;
  "table:watch": (p: { watch: number }) => void;
  "turn:new": (t: Turn) => void;
  "turn:audioReady": (p: { turnId: string; audioUrl: string; durationMs?: number }) => void;
  "table:decided": (p: { shortlist: PlanPublic[] }) => void;
  "plan:private": (p: PlanPrivate) => void;
  "dryrun:script": (p: DryRunScript) => void;
  /**
   * The shared clock after a control (server ms). Clients apply startedAt/pausedAt mapped with serverNow (like
   * dryrun:script), never their own receive time, so every device and a late joiner agree (TR2-006).
   * Sent only when the clock actually changed: a duplicate pause is not broadcast.
   */
  "dryrun:control": (p: { action: "pause" | "resume" | "restart"; at: number; startedAt: number; pausedAt: number | null; serverNow: number }) => void;
  /**
   * autoPick: a clear majority agrees → that chart is picked at `at` (server ms) unless the organizer picks first
   * (PRD D5). serverNow lets a phone with a skewed clock count down correctly (TR1-008).
   */
  "plan:votes": (p: { tallies: Record<string, number>; autoPick?: { planId: string; at: number } | null; serverNow: number }) => void;
  /** Member room only: the chart this member voted for (live and on replay), so their highlight survives a reload (TR1-009). */
  "plan:myVote": (p: { planId: string | null }) => void;
  /** serverNow (server ms) lets a phone with a skewed clock count down to sealDeadlineAt correctly (like plan:votes). */
  "booking:created": (p: BookingPublic & { serverNow: number }) => void;
  "seal:private": (p: { bookingId: string; amountCents: number; lines: ShareLine[]; fits: boolean; cardLast4: string; mode: "visa_sandbox" | "sim" }) => void;
  "seal:status": (p: { bookingId: string; memberId: string; status: SealStatus }) => void;
  "seal:declinedPrivate": (p: { bookingId: string; reason: DeclineReason }) => void;
  "booking:result": (p: { bookingId: string; status: "CAPTURED" | "VOIDED"; reference?: string; publicReason?: string }) => void;
  /**
   * TR3-007: the table failed and the voyage went back to BRIEFING. A neutral public notice to the trip room; phones and
   * the headset show it, the Gallery ignores it. (Before, this was a room-wide `error` that re-opened every phone's buttons.)
   */
  "table:failed": (p: { code: "TABLE_FAILED"; message: string }) => void;
  /** Caller only (never the trip room). */
  "error": (p: ErrorPayload) => void;
}

/** Events that must NEVER be sent to the shared trip room (privacy test, doc 04 §14). */
export const PRIVATE_EVENTS = ["brief:private", "plan:private", "plan:myVote", "seal:private", "seal:declinedPrivate"] as const;
export type PrivateEvent = (typeof PRIVATE_EVENTS)[number];
/** Events the server may broadcast to `trip:{id}` (OPT-062: the privacy guard is a compile-time check too). */
export type TripRoomEvent = Exclude<keyof ServerToClient, PrivateEvent | "error">;
export type S2CPayload<K extends keyof ServerToClient> = Parameters<ServerToClient[K]>[0];
export type C2SPayload<K extends keyof ClientToServer> = Parameters<ClientToServer[K]>[0];

/**
 * Runtime lists of every event name (OPT-067 contract test). `satisfies Record<keyof …, true>` makes a missing or
 * unknown name a compile error, so these can't drift from the interfaces above.
 */
const S2C = {
  "trip:state": true, "brief:private": true, "table:watch": true, "turn:new": true, "turn:audioReady": true, "table:decided": true,
  "plan:private": true, "dryrun:script": true, "dryrun:control": true, "plan:votes": true, "plan:myVote": true, "booking:created": true,
  "seal:private": true, "seal:status": true, "seal:declinedPrivate": true, "booking:result": true, "table:failed": true, "error": true,
} as const satisfies Record<keyof ServerToClient, true>;
const C2S = {
  "trip:join": true, "brief:submit": true, "table:start": true, "table:sailWithout": true, "table:hail": true, "dryrun:control": true,
  "plan:vote": true, "plan:pick": true, "seal:set": true, "seal:cancel": true, "booking:retry": true, "booking:callOff": true,
  "crew:setOpen": true, "client:log": true,
} as const satisfies Record<keyof ClientToServer, true>;
export const SERVER_TO_CLIENT_EVENTS = Object.keys(S2C) as (keyof ServerToClient)[];
export const CLIENT_TO_SERVER_EVENTS = Object.keys(C2S) as (keyof ClientToServer)[];
