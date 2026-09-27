// `/xr` — the Quest start screen (docs/03 §4 Q-1): Start a trip or Join a trip in Quest Browser's 2D page, before
// the chart room opens. Big pinch/ray targets (≥ 64 px), text ≥ 20 px. The older headset-code pairing (a shared
// headset with the organizer's controls and nobody's terms) stays behind "Pair with a headset code".
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { JOIN_CODE_LEN, MAX_CREW, type CrewPublic } from "@all-ayes/shared";
import { ApiError, api } from "../net/api";
import { lastJoinCode, loadSession, saveSession, type Session } from "../net/session";
import { CrewMemberFields, type CrewMemberDraft } from "../phone/components/CrewMemberFields";
import { firstFreeBand } from "../phone/components/ui";
import { PinPad } from "../phone/components/PinPad";
import { passkeysUsable, pinOk } from "./questMode";
import "./xr.css";

/** How often the headset asks whether its seat request was answered. */
export const ATTACH_POLL_MS = 1500;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="cr-page cr-quest">
      <div className="cr-scroll">
        <div className="cr-card">{children}</div>
      </div>
    </div>
  );
}

/** Q-1: Start a trip · Join a trip (· back to the voyage this headset is on). */
export default function QuestStart() {
  const last = lastJoinCode();
  const seat = last ? loadSession(last) : null;
  return (
    <Shell>
      <h1>The chart room</h1>
      <p>Plan a trip with your crew around a chart on your real table.</p>
      <div className="cr-choices">
        <Link className="cr-btn primary block" to="/xr/new">Start a trip</Link>
        <Link className="cr-btn block" to="/xr/join">Join a trip</Link>
        {seat ? <Link className="cr-btn block" to={`/t/${seat.joinCode}/xr`}>Back to voyage <span className="mono">{seat.joinCode}</span></Link> : null}
      </div>
      <p className="muted">Starting here makes this headset your own seat. Friends join with their phones or their own headsets.</p>
      <p className="muted"><Link to="/xr/code">Pair with a headset code instead</Link> (a shared headset that shows the table, never anyone's terms).</p>
    </Shell>
  );
}

type Lookup = Awaited<ReturnType<typeof api.tripByCode>>;
type Step =
  | { kind: "code" }
  | { kind: "seats"; trip: Lookup }
  | { kind: "new"; trip: Lookup }
  | { kind: "asking"; trip: Lookup; seat: CrewPublic; requestId: string; secret: string; expiresAt: number }
  | { kind: "pin"; session: Session; next: string };

/** Q-2: join a trip on a Quest: the 6-character code, then a new seat or "Is this your seat?". */
export function QuestJoin() {
  const nav = useNavigate();
  const [step, setStep] = useState<Step>({ kind: "code" });
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [you, setYou] = useState<CrewMemberDraft>({ name: "", band: 1, origin: "ORD" });

  /** Joined: set a seal PIN first if this browser can't hold a passkey, then go on. */
  async function aboard(s: Session, next: string) {
    saveSession(s);
    if (await passkeysUsable()) { nav(next); return; }
    const pin = await api.sealPinStatus(s.tripId, s.memberToken!).catch(() => ({ set: true }));
    if (pin.set) nav(next); else setStep({ kind: "pin", session: s, next });
  }

  async function lookUp(e: FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length !== JOIN_CODE_LEN) { setErr(`The voyage code has ${JOIN_CODE_LEN} characters.`); return; }
    setBusy(true); setErr("");
    try {
      const trip = await api.tripByCode(c);
      setYou((d) => ({ ...d, band: firstFreeBand(trip.takenBands) }));
      setStep({ kind: "seats", trip });
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.status === 404 ? "No voyage with that code. Check it and try again." : e2 instanceof Error ? e2.message : "Couldn't reach the voyage.");
    } finally { setBusy(false); }
  }

  async function takeSeat(trip: Lookup) {
    setBusy(true); setErr("");
    try {
      const r = await api.join(trip.tripId, { name: you.name.trim(), band: you.band, origin: you.origin, device: "headset" });
      await aboard({ tripId: trip.tripId, joinCode: trip.joinCode, memberId: r.memberId, memberToken: r.memberToken, device: "headset" }, `/t/${trip.joinCode}/brief`);
    } catch (e2) {
      setErr(e2 instanceof Error && e2.message ? e2.message : "Couldn't join. Try again.");
    } finally { setBusy(false); }
  }

  async function ask(trip: Lookup, seat: CrewPublic) {
    setBusy(true); setErr("");
    try {
      const r = await api.attachHeadset(trip.joinCode, seat.memberId);
      setStep({ kind: "asking", trip, seat, requestId: r.requestId, secret: r.secret, expiresAt: r.expiresAt });
    } catch (e2) {
      setErr(e2 instanceof Error && e2.message ? e2.message : "Couldn't ask. Try again.");
    } finally { setBusy(false); }
  }

  if (step.kind === "pin") {
    return (
      <Shell>
        <SealPinSetup session={step.session} onDone={() => nav(step.next)} />
      </Shell>
    );
  }

  if (step.kind === "asking") {
    return (
      <Shell>
        <AskingCard step={step} onApproved={(s) => void aboard(s, `/t/${s.joinCode}/xr`)} onBack={() => setStep({ kind: "seats", trip: step.trip })} />
      </Shell>
    );
  }

  if (step.kind === "seats" || step.kind === "new") {
    const { trip } = step;
    const full = trip.crew.length >= MAX_CREW;
    const late = trip.status !== "BRIEFING";
    return (
      <Shell>
        <h1>{trip.name}</h1>
        <p>Voyage <span className="mono">{trip.joinCode}</span> · {trip.crew.length} aboard</p>
        {step.kind === "seats" ? (
          <>
            <h2>Is one of these your seat?</h2>
            <div className="cr-choices">
              {trip.crew.map((c) => {
                const unopened = c.inviteOpen === false;
                return (
                  <button key={c.memberId} type="button" className="cr-btn block" disabled={busy || unopened} onClick={() => void ask(trip, c)}>
                    I'm {c.name}{c.role === "organizer" ? " (organizer)" : ""}{c.onHeadset ? " · on a headset" : ""}
                  </button>
                );
              })}
            </div>
            <p className="muted">Your phone gets a one-tap "Let this headset in?"; say yes there.</p>
            {full || late || trip.crewClosed ? (
              <p className="muted">{full ? `This crew is full (${MAX_CREW} aboard).` : late ? "This voyage has left the harbor: new seats are closed." : "The organizer has closed this crew."}</p>
            ) : (
              <button type="button" className="cr-btn primary block" onClick={() => setStep({ kind: "new", trip })}>I'm new: take a seat</button>
            )}
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (you.name.trim()) void takeSeat(trip); }}>
            <h2>Your seat</h2>
            <div className="cr-form"><CrewMemberFields value={you} onChange={setYou} taken={trip.takenBands} /></div>
            <button className="cr-btn primary block" type="submit" disabled={busy || !you.name.trim()}>{busy ? "Coming aboard…" : "Join the crew"}</button>
            <button className="cr-btn block" type="button" onClick={() => setStep({ kind: "seats", trip })}>Back</button>
            <p className="muted">Next you seal your own terms. Only your mate sees them.</p>
          </form>
        )}
        {err ? <p className="cr-error" role="alert">{err}</p> : null}
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={lookUp}>
        <h1>Join a trip</h1>
        <p>Type the six-character voyage code the organizer shared.</p>
        <input
          className="cr-code" value={code} autoFocus inputMode="text" autoCapitalize="characters" autoComplete="off" spellCheck={false}
          aria-label="Voyage code" placeholder="K7M2QX"
          onChange={(e) => setCode(e.target.value.replace(/[^a-z0-9]/gi, "").slice(0, JOIN_CODE_LEN).toUpperCase())}
        />
        {err ? <p className="cr-error" role="alert">{err}</p> : null}
        <button className="cr-btn primary block" type="submit" disabled={busy || code.length !== JOIN_CODE_LEN}>{busy ? "Looking…" : "Find the voyage"}</button>
        <Link className="cr-btn block" to="/xr">Back</Link>
      </form>
    </Shell>
  );
}

/** "Ask {name} to let this headset in": polls the request until that seat's own device answers it (or it expires). */
function AskingCard({ step, onApproved, onBack }: {
  step: Extract<Step, { kind: "asking" }>; onApproved: (s: Session) => void; onBack: () => void;
}) {
  const [state, setState] = useState<"pending" | "denied" | "expired" | "error">("pending");
  const done = useRef(false);
  useEffect(() => {
    done.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await api.attachStatus(step.requestId, step.secret);
        if (done.current) return;
        if (r.status === "approved" && r.deviceToken && r.memberId) {
          done.current = true;
          onApproved({ tripId: r.tripId ?? step.trip.tripId, joinCode: r.joinCode || step.trip.joinCode, memberId: r.memberId, memberToken: r.deviceToken, device: "headset" });
          return;
        }
        if (r.status === "denied" || r.status === "expired") { setState(r.status); return; }
      } catch {
        if (!done.current) setState("error");
        return;
      }
      timer = setTimeout(() => void poll(), ATTACH_POLL_MS);
    };
    timer = setTimeout(() => void poll(), ATTACH_POLL_MS);
    return () => { done.current = true; clearTimeout(timer); };
  }, [step.requestId, step.secret]); // eslint-disable-line react-hooks/exhaustive-deps
  const who = step.seat.name;
  return (
    <>
      <h1>Is this your seat?</h1>
      {state === "pending" ? (
        <>
          <p>Ask {who} to let this headset in. {who}'s phone shows <b>Let this headset in?</b>; one tap there and you're aboard.</p>
          <p className="muted">Waiting for {who}… (the request lasts two minutes)</p>
        </>
      ) : (
        <p className="cr-error" role="alert">
          {state === "denied" ? `${who}'s phone said no.` : state === "expired" ? "Nobody answered in time." : "Lost touch with the helm."} Ask again when ready.
        </p>
      )}
      <button type="button" className="cr-btn block" onClick={onBack}>Back</button>
    </>
  );
}

/**
 * Quest-first: this browser can't hold a passkey, so the member sets a 4–6 digit seal PIN (hashed at the helm, bound
 * to their seat, limited tries). They approve their share with it in the headset; Face ID on their phone still works.
 */
export function SealPinSetup({ session, onDone }: { session: Session; onDone: () => void }) {
  const [first, setFirst] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(pin: string) {
    setBusy(true); setErr("");
    try { await api.setSealPin(session.tripId, session.memberToken!, pin); onDone(); }
    catch (e) { setErr(e instanceof Error && e.message ? e.message : "Couldn't save the PIN."); setFirst(null); }
    finally { setBusy(false); }
  }
  return (
    <>
      <h1>Set a seal PIN</h1>
      <p>This headset can't hold a passkey, so pick 4 to 6 digits. You'll enter them to approve your share here.</p>
      {first === null
        ? <PinPad label="Choose your seal PIN" busy={busy} onDone={(p) => (pinOk(p) ? setFirst(p) : setErr("4 to 6 digits."))} />
        : <PinPad label="Once more, to be sure" busy={busy} onDone={(p) => (p === first ? void save(p) : (setErr("Those didn't match. Start again."), setFirst(null)))} />}
      {err ? <p className="cr-error" role="alert">{err}</p> : null}
      <button type="button" className="cr-btn block" onClick={onDone}>Later</button>
    </>
  );
}
