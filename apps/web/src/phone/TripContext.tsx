import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Ack, ClientToServer, CrewPublic } from "@all-ayes/shared";
import type { ClientState, TripStore } from "../net/tripStore";
import type { Session } from "../net/session";
import { errorCopy, ownsError } from "./errors";

type HelmErr = NonNullable<ClientState["error"]>;

interface Ctx {
  store: TripStore;
  session: Session;
}

const TripCtx = createContext<Ctx | null>(null);

export function TripProvider({ store, session, children }: Ctx & { children: ReactNode }) {
  // O2-047: one value per store/session, so a re-render of the shell doesn't re-render every consumer
  const value = useMemo(() => ({ store, session }), [store, session]);
  return <TripCtx.Provider value={value}>{children}</TripCtx.Provider>;
}

function useCtx(): Ctx {
  const ctx = useContext(TripCtx);
  if (!ctx) throw new Error("useCrew outside TripProvider");
  return ctx;
}

/**
 * OPT-047: subscribe to one slice of the store. The component re-renders only when the slice changes
 * (by `isEqual`, Object.is by default), not on every socket event.
 */
export function useTripSelector<T>(sel: (s: ClientState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const { store } = useCtx();
  const cache = useRef<{ state: ClientState; sel: (s: ClientState) => T; value: T } | null>(null);
  const getSnapshot = () => {
    const state = store.getSnapshot();
    const c = cache.current;
    if (c && c.state === state && c.sel === sel) return c.value;
    const next = sel(state);
    const value = c && isEqual(c.value, next) ? c.value : next;
    cache.current = { state, sel, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

/** Shallow equality for arrays / plain objects of primitives or stable references. */
function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const crewEqual = (a: CrewPublic[], b: CrewPublic[]) => a.length === b.length && a.every((c, i) => shallowEqual(c, b[i]));
const NO_CREW: CrewPublic[] = [];

interface CrewView {
  store: TripStore;
  session: Session;
  crew: CrewPublic[];
  me: CrewPublic | null;
  isOrganizer: boolean;
  crewName: (memberId: string) => string;
  crewOf: (memberId: string) => CrewPublic | undefined;
}

/**
 * Who's aboard and who I am, without subscribing to the rest of the state (OPT-047). Stable between crew changes.
 * O2-046: the only way a phone screen reads the crew; everything else comes from `useTripSelector` slices.
 */
export function useCrew(): CrewView {
  const { store, session } = useCtx();
  const crew = useTripSelector((s) => s.trip?.crew ?? NO_CREW, crewEqual);
  const organizerId = useTripSelector((s) => s.trip?.organizerId ?? null);
  const crewOf = useCallback((id: string) => crew.find((c) => c.memberId === id), [crew]);
  return useMemo(() => ({
    store, session, crew, crewOf,
    me: crew.find((c) => c.memberId === session.memberId) ?? null,
    isOrganizer: !!organizerId && organizerId === session.memberId,
    crewName: (id: string) => crewOf(id)?.name ?? "A friend",
  }), [store, session, crew, crewOf, organizerId]);
}

/**
 * One tap, one emit (TR3-007 / WP-09 follow-up). `send(payload, p?)` emits `event` with an ack; `sent` stays true
 * until that ack refuses it (or `reopenOnOk` and it succeeds), so a refusal of some *other* action never re-opens this
 * button. The success path usually moves the screen on. If the socket drops before the answer, the ack is lost for
 * good, so the button re-opens then too. Returns false from `send` if this action already went out.
 */
export function useSendGuard<K extends keyof ClientToServer, P = undefined>(event: K, opts: { reopenOnOk?: boolean } = {}) {
  const { store } = useCtx();
  const connected = useTripSelector((s) => s.connected);
  const [sent, setSent] = useState(false);
  const latch = useRef(false); // taps faster than a re-render still see it
  const inflight = useRef(0); // id of the send awaiting its ack (0: none); a stale ack is ignored
  const [payload, setPayload] = useState<P | undefined>(undefined);
  const reopen = useCallback(() => { inflight.current = 0; latch.current = false; setSent(false); }, []);
  const [wasConnected, setWasConnected] = useState(connected);
  if (connected !== wasConnected) {
    setWasConnected(connected);
    if (!connected && inflight.current > 0) reopen(); // answer lost with the socket
  }
  const { reopenOnOk = false } = opts;
  const send = (body: Parameters<ClientToServer[K]>[0], p?: P) => {
    if (latch.current) return false;
    latch.current = true;
    setSent(true);
    setPayload(p);
    // queued while offline: the store's outbox answers the ack (sent after the rejoin, or EXPIRED), so don't
    // treat that disconnect as a lost answer
    const id = store.socket.connected ? ++seq : -(++seq);
    inflight.current = id;
    store.emit(event, body, (r: Ack) => {
      if (inflight.current !== id) return;
      inflight.current = 0;
      if (!r.ok || reopenOnOk) reopen();
    });
    return true;
  };
  /** Re-open the button without an answer (e.g. the screen moved on and came back). */
  return [sent, send, { payload, reset: reopen }] as const;
}
let seq = 0;

/**
 * Take ownership of certain server errors while this component is on screen: they show inline, next to the
 * control that caused them, in phone copy, and the shell's generic banner is cleared (before paint) so the
 * same refusal isn't shown twice. `events` (L1-008) limits it to refusals of those actions (`error.event`).
 * Returns the note and a way to dismiss it.
 */
export function useInlineError(codes: readonly string[], active = true, events?: readonly string[]) {
  const { store } = useCtx();
  const error = useTripSelector((s) => s.error);
  const [note, setNote] = useState<{ err: HelmErr; text: string } | null>(null);
  const mine = active && ownsError(error, codes, events);
  useLayoutEffect(() => {
    if (!mine || !error) return;
    setNote({ err: error, text: errorCopy(error) });
    store.clearError();
  }, [mine, error, store]);
  return { note: note?.text ?? null, code: note?.err.code ?? null, err: note?.err ?? null, clear: () => setNote(null) };
}
