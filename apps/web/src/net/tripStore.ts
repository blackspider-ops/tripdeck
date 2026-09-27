/**
 * One socket + one client-side store per page. Phones, the headset and the gallery all read from this.
 * Server is the source of truth (doc 04 §1); this only mirrors events.
 */
import { io, type Socket } from "socket.io-client";
import { useSyncExternalStore } from "react";
import type {
  Ack, AckFn, Brief, BookingPublic, ClientToServer, DeclineReason, DryRunScript, ErrorPayload, JoinRole, PlanPrivate, PlanPublic, S2CPayload,
  ServerToClient, ShareLine, Surface, TripState, TripStateUpdate, Turn,
} from "@all-ayes/shared";

/**
 * R2-WP-14 (O2-040): live `trip:state` broadcasts leave out the voyage's static fields (ports, date windows); the
 * snapshot keeps the ones this client already has for the same voyage (the same arrays, so nothing downstream sees a
 * change). A (re)join's replay always carries them.
 */
export function withStatic(s: TripStateUpdate, prev: TripState | null): TripState {
  const same = prev?.tripId === s.tripId ? prev : null;
  const destination = s.destination ?? same?.destination;
  const dateRange = s.dateRange ?? same?.dateRange;
  return {
    ...s, candidateCities: s.candidateCities ?? same?.candidateCities ?? [], dateWindows: s.dateWindows ?? same?.dateWindows ?? [],
    ...(destination ? { destination } : {}), ...(dateRange ? { dateRange } : {}),
  };
}

interface SealPrivate { bookingId: string; amountCents: number; lines: ShareLine[]; fits: boolean; cardLast4: string; mode: "visa_sandbox" | "sim" }

export interface ClientState {
  connected: boolean;
  /** L3-003: the helm has acknowledged this connection's `trip:join` (actions are queued until then). */
  joined: boolean;
  /** R2-WP-07: who the last join let us in as (`spectator` also when a sent token was refused), null before the ack. */
  role: JoinRole | null;
  trip: TripState | null;
  turns: Turn[];
  audio: Record<string, { audioUrl: string; durationMs?: number }>;
  shortlist: PlanPublic[];
  planPrivate: Record<string, PlanPrivate>;
  brief: Brief | null;
  memory: string[];
  dryrun: (DryRunScript & { startedAt: number; pausedAt: number | null }) | null;
  votes: Record<string, number>;
  /** at: device-clock ms (mapped from the server's clock with serverNow), so a skewed phone counts down right. */
  autoPick: { planId: string; at: number } | null;
  /** The chart I voted for (member room; survives a reload). */
  myVote: string | null;
  booking: BookingPublic | null;
  sealPrivate: SealPrivate | null;
  declined: { bookingId: string; reason: DeclineReason } | null;
  lastResult: { bookingId: string; status: "CAPTURED" | "VOIDED"; reference?: string; publicReason?: string } | null;
  /** The last refusal (caller-only `error`; `event` names the action it answers), or the table failing (`table:failed`). */
  error: ErrorPayload | null;
  /** Quest-first (member room): a headset asking to sit in my seat, until it's answered or expires. */
  headsetRequest: { requestId: string; memberName: string; expiresAt: number } | null;
}

const initial: ClientState = {
  connected: false, joined: false, role: null, trip: null, turns: [], audio: {}, shortlist: [], planPrivate: {}, brief: null, memory: [],
  dryrun: null, votes: {}, autoPick: null, myVote: null, booking: null, sealPrivate: null, declined: null, lastResult: null, error: null,
  headsetRequest: null,
};

type Listener = () => void;
type TripSocket = Socket<ServerToClient, ClientToServer>;

/**
 * TR3-009: actions tapped while offline wait here, at most OUTBOX_MAX of them for OUTBOX_TTL_MS each, one per event
 * name (a newer tap replaces an older one). Older ones are dropped on reconnect (their ack, if any, gets EXPIRED),
 * so a stale `plan:pick` or `seal:set` from minutes ago never fires. `client:log` is never queued.
 */
export const OUTBOX_MAX = 20;
export const OUTBOX_TTL_MS = 30_000;
/** L1-002 / L5-004: a join refused with LOADING (the voyage is being fetched, or the db is reconnecting) is retried. */
export const JOIN_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;
type Queued = { ev: keyof ClientToServer; payload: unknown; ack?: AckFn; at: number };

export class TripStore {
  state: ClientState = initial;
  socket: TripSocket;
  private listeners = new Set<Listener>();
  /** Raw event tap for the 3D SceneDirector (it animates from events, not snapshots). */
  private taps = new Set<(event: string, payload: unknown) => void>();

  /**
   * Actions tapped while offline (TR3-009: bounded, expiring, one per event). Sent once the server has acknowledged
   * trip:join on reconnect (socket.io's own buffer would send them before the join, and the server would reject them).
   */
  private outbox: Queued[] = [];
  /** L3-003: this connection's join outcome. Actions go straight out only once `joined`; a refused join lets them through to be refused. */
  private join: "pending" | "joined" | "refused" = "pending";
  private joinRetries = 0;
  private joinTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly surface: Surface;
  private readonly joinOpts: { tripId?: string; joinCode?: string; memberToken?: string; deviceToken?: string; surface: Surface };
  /** Every server → client event this store handles (OPT-067: the contract test checks it covers ServerToClient). */
  readonly handled = new Set<keyof ServerToClient>();

  constructor(opts: { tripId?: string; joinCode?: string; memberToken?: string; deviceToken?: string; surface: Surface; autoConnect?: boolean }) {
    const { autoConnect = true, ...joinOpts } = opts;
    this.joinOpts = joinOpts;
    this.surface = opts.surface;
    // TR3-008: WebSocket first; tryAllTransports falls back to HTTP long-polling when a network or proxy blocks
    // WebSockets (engine.io-client only moves to the next transport with it on). The server accepts both.
    this.socket = io({
      path: "/socket.io", transports: ["websocket", "polling"], tryAllTransports: true, reconnectionDelay: 1000, reconnectionDelayMax: 10_000, autoConnect, // O2-049: the delay grows 1 s → 10 s (with jitter)
    });
    this.socket.on("connect", () => {
      // O2-049: a fresh connection starts without the last one's refusal (join-time notices arrive after this)
      this.joinRetries = 0;
      this.set({ connected: true, joined: false, role: null, error: null });
      this.sendJoin();
    });
    this.socket.on("disconnect", () => {
      this.join = "pending";
      clearTimeout(this.joinTimer);
      this.set({ connected: false, joined: false });
    });

    // O2-021: every server event is folded in by the pure `reducers` map below; the taps see the raw payload
    for (const ev of Object.keys(reducers) as (keyof ServerToClient)[]) this.listen(ev);
  }

  private listen<K extends keyof ServerToClient>(ev: K) {
    const reduce = reducers[ev] as Reducer<K>;
    this.handled.add(ev);
    const listener = (p: S2CPayload<K>) => {
      const patch = reduce(this.state, p, this.surface);
      if (patch) this.set(patch);
      for (const t of this.taps) t(ev, p);
    };
    // socket.io's overloads can't resolve a generic event name; `listener` is checked against ServerToClient[K] above
    (this.socket.on as (e: K, l: (p: S2CPayload<K>) => void) => void)(ev, listener);
  }

  /**
   * Send an action. `ack` (optional) is answered once by the server (TR3-007): `{ok:true}`, or the refusal. While
   * offline the action is queued (see OUTBOX_MAX / OUTBOX_TTL_MS); `client:log` is dropped instead.
   */
  emit<K extends keyof ClientToServer>(ev: K, payload: Parameters<ClientToServer[K]>[0], ack?: AckFn) {
    // L3-003: "connected" isn't enough — an action sent before the join ack could reach the helm before the join has
    // loaded the voyage (NOT_JOINED). After a refused join it goes out and gets the helm's own refusal.
    if (this.socket.connected && this.join !== "pending") return this.send(ev, payload, ack);
    if (ev === "client:log") return;
    const dropped = this.outbox.filter((q) => q.ev === ev);
    this.outbox = this.outbox.filter((q) => q.ev !== ev);
    this.outbox.push({ ev, payload, ack, at: Date.now() });
    while (this.outbox.length > OUTBOX_MAX) dropped.push(this.outbox.shift()!);
    for (const q of dropped) q.ack?.(EXPIRED);
  }

  /** Queued actions still fresh, in order (tests read it). */
  get pending(): readonly { ev: keyof ClientToServer; at: number }[] { return this.outbox; }

  private send<K extends keyof ClientToServer>(ev: K, payload: unknown, ack?: AckFn) {
    // one widening: socket.io's emit overloads can't take a generic event name (callers are checked by emit's signature)
    const emit = this.socket.emit as (e: K, p: unknown, a?: AckFn) => unknown;
    if (ack) emit.call(this.socket, ev, payload, ack); else emit.call(this.socket, ev, payload);
  }

  private sendJoin() {
    this.join = "pending";
    this.socket.emit("trip:join", this.joinOpts, (r) => this.onJoin(r));
  }

  /**
   * The join ack: the queued actions go once the join has landed; a refused join fails them too. LOADING (the helm is
   * fetching the voyage from the ship's log, or the log is out of reach) is retried with backoff, keeping the queue.
   */
  private onJoin(r: Ack) {
    if (!this.socket.connected) return; // a late ack for a connection that has gone
    if (!r.ok && r.code === "LOADING") {
      const wait = JOIN_RETRY_MS[Math.min(this.joinRetries++, JOIN_RETRY_MS.length - 1)];
      clearTimeout(this.joinTimer);
      this.joinTimer = setTimeout(() => { if (this.socket.connected) this.sendJoin(); }, wait);
      return;
    }
    this.join = r.ok ? "joined" : "refused";
    this.joinRetries = 0;
    const patch: Partial<ClientState> = { joined: r.ok, role: r.ok && "as" in r ? r.as : null };
    // the "Fetching that voyage…" notice has done its job
    if (r.ok && this.state.error?.code === "LOADING" && this.state.error.event === "trip:join") patch.error = null;
    this.set(patch);
    this.flush(r);
  }

  private flush(join: Ack) {
    const now = Date.now();
    const queued = this.outbox.splice(0);
    for (const q of queued) {
      if (!join.ok) q.ack?.(join);
      else if (now - q.at > OUTBOX_TTL_MS) q.ack?.(EXPIRED);
      else this.send(q.ev, q.payload, q.ack);
    }
  }

  tap(fn: (event: string, payload: unknown) => void) {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.state;

  private set(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  clearError() { this.set({ error: null }); }
  /** A lifted seal was set again (the helm sends no "un-declined" notice: the seal read "set" publicly all along). */
  clearDeclined(bookingId: string) { if (this.state.declined?.bookingId === bookingId) this.set({ declined: null }); }

  /** Dry Run clock: in-trip minutes since day start, derived from wall time. */
  dryrunMinute(now = Date.now()): number | null {
    const d = this.state.dryrun;
    if (!d) return null;
    const t = (d.pausedAt ?? now) - d.startedAt;
    return Math.min(d.dayEndMin, d.dayStartMin + (t / 1000) * d.minPerSec);
  }

  /** Reconnect after close() — React StrictMode runs effect cleanups once in dev. Idempotent. */
  open() { if (!this.socket.connected && !this.socket.active) this.socket.connect(); }

  close() { this.outbox = []; clearTimeout(this.joinTimer); this.socket.disconnect(); }
}

/** A server event folded into the state: `(state, payload, surface) => patch` (nothing: no change). Pure but for the clock. */
type Reducer<K extends keyof ServerToClient> = (s: ClientState, p: S2CPayload<K>, surface: Surface) => Partial<ClientState> | undefined;

/**
 * O2-021: how each server → client event changes the client state, one pure function per event (unit-testable
 * without a socket; OPT-067's contract test checks the store listens to every one).
 */
export const reducers: { [K in keyof ServerToClient]: Reducer<K> } = {
  "trip:state": (st, s) => {
    // A new round of briefing / a new table (after "Adjust my terms") starts from a clean log: the server
    // reset its turns and charts, so drop ours too (else the old DECIDE turn keeps the hail disabled).
    const prev = st.trip?.status;
    const fresh = prev !== undefined && prev !== s.status && (s.status === "BRIEFING" || s.status === "AT_TABLE");
    // The snapshot names the Two Charts by id; their bodies came in table:decided (sent before it, live and on
    // replay). Keep ours only while they are the same two charts.
    const ids = s.shortlistIds;
    const same = !!ids && st.shortlist.length === 2 && st.shortlist.every((p, i) => p.planId === ids[i]);
    // L3-009: no current booking (e.g. "back to the charts") → the old attempt's private leftovers go too
    const gone = s.booking ? {} : { lastResult: null, declined: null, sealPrivate: null };
    return {
      trip: withStatic(s, st.trip),
      booking: s.booking ? localBooking(s.booking, s.serverNow) : null,
      ...gone,
      shortlist: same ? st.shortlist : [],
      votes: s.votes ?? st.votes,
      autoPick: s.autoPick ? { ...s.autoPick, at: toLocal(s.autoPick.at, s.serverNow) } : null,
      // votes only exist during one Dry Run: any phase change (incl. back to the charts) clears mine
      myVote: prev === s.status ? st.myVote : null,
      ...(fresh ? { turns: [], audio: {}, planPrivate: {}, dryrun: null } : {}),
    };
  },
  "brief:private": (_st, p) => ({ brief: p.brief, memory: p.memory ?? [] }),
  // the server doesn't re-broadcast trip:state per Watch: patch it in so the compass and Gallery corner move
  "table:watch": (st, p) => (st.trip ? { trip: { ...st.trip, negotiation: { ...st.trip.negotiation, watch: p.watch } } } : undefined),
  "turn:new": (st, t) => (st.turns.some((x) => x.turnId === t.turnId) ? undefined
    : { turns: [...st.turns, t].sort((a, b) => a.seq - b.seq) }),
  "turn:audioReady": (st, p) => ({ audio: { ...st.audio, [p.turnId]: { audioUrl: p.audioUrl, durationMs: p.durationMs } } }),
  "table:decided": (_st, p) => ({ shortlist: p.shortlist }),
  "plan:private": (st, p) => ({ planPrivate: { ...st.planPrivate, [p.planId]: p } }),
  "dryrun:script": (_st, p) => {
    // map the server's clock onto ours so every device shows the same in-trip minute
    const skew = p.serverNow ? Date.now() - p.serverNow : 0;
    const startedAt = p.startedAt ? p.startedAt + skew : Date.now();
    const pausedAt = p.pausedAt ? p.pausedAt + skew : null;
    return { dryrun: { ...p, startedAt, pausedAt } };
  },
  // the server's resulting clock, mapped like dryrun:script, never our receive time (TR2-006)
  "dryrun:control": (st, p) => (st.dryrun
    ? { dryrun: { ...st.dryrun, startedAt: toLocal(p.startedAt, p.serverNow), pausedAt: p.pausedAt ? toLocal(p.pausedAt, p.serverNow) : null } }
    : undefined),
  "plan:votes": (_st, p) => ({ votes: p.tallies, autoPick: p.autoPick ? { ...p.autoPick, at: toLocal(p.autoPick.at, p.serverNow) } : null }),
  "plan:myVote": (_st, p) => ({ myVote: p.planId }),
  "booking:created": (st, { serverNow, ...pub }) => {
    const b = localBooking(pub, serverNow);
    // a replay re-announces the same booking: keep its outcome (booking:result follows on replay anyway)
    const same = st.booking?.bookingId === b.bookingId;
    return {
      booking: b, declined: same ? st.declined : null, sealPrivate: same ? st.sealPrivate : null,
      lastResult: st.lastResult?.bookingId === b.bookingId ? st.lastResult : null,
    };
  },
  "seal:private": (_st, p) => ({ sealPrivate: p }),
  "seal:status": (st, p) => {
    const b = st.booking;
    if (!b || b.bookingId !== p.bookingId) return undefined;
    return { booking: { ...b, seals: b.seals.map((s) => (s.memberId === p.memberId ? { ...s, status: p.status } : s)) } };
  },
  "seal:declinedPrivate": (_st, p) => ({ declined: p }),
  "booking:result": (_st, p) => ({ lastResult: p }),
  // TR3-007: the table failing is news for the crew's phones and the headset, not an error banner on the Gallery
  "table:failed": (_st, p, surface) => (surface === "gallery" ? undefined : { error: { code: p.code, message: p.message } }),
  error: (_st, e) => ({ error: e }),
  // an answered (or replaced) request takes its prompt away; the expiry is on the server's clock (close enough here)
  "headset:request": (st, p) => (p.answered
    ? (st.headsetRequest?.requestId === p.requestId ? { headsetRequest: null } : undefined)
    : { headsetRequest: { requestId: p.requestId, memberName: p.memberName, expiresAt: p.expiresAt } }),
};

const EXPIRED: Ack = { ok: false, code: "EXPIRED", message: "That was a while ago, so it wasn't sent. Try again." };

/** The seal deadline on this device's clock (mapped with serverNow), so the Seal countdown is skew-free. */
function localBooking(b: BookingPublic, serverNow?: number): BookingPublic {
  if (!b.sealDeadlineAt || !serverNow) return b;
  const at = Date.parse(b.sealDeadlineAt);
  return Number.isNaN(at) ? b : { ...b, sealDeadlineAt: new Date(toLocal(at, serverNow)).toISOString() };
}

/** Server-clock ms → this device's clock, given the server's "now" at send time (network latency ignored). */
function toLocal(serverMs: number, serverNow?: number): number {
  return serverNow ? serverMs + (Date.now() - serverNow) : serverMs;
}

export function useTripStore(store: TripStore): ClientState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
