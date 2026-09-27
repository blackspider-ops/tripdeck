// `/t/:code/xr` — the Organizer's headset. Enters immersive-ar on Quest 3; immersive-vr on a phone in a lens shell
// (a Gear VR used as a plain Cardboard viewer — typically an iPhone in Safari, via webxr-polyfill loaded lazily;
// `?vr=cardboard` forces it; `?ipd=62` sets the lens spacing in mm); anywhere else it opens the same chart room as a
// laptop view so the scene can be built and tested without a headset.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { JOIN_REFUSAL } from "@all-ayes/shared";
import { clearHeadsetSession, loadHeadsetSession, loadSession, type Session } from "../net/session";
import { api } from "../net/api";
import { QR } from "../phone/components/crew";
import { SealPinSetup } from "./QuestStart";
import { passkeysUsable } from "./questMode";
import { TripStore, useTripStore } from "../net/tripStore";
import { preloadFonts } from "../scene/text";
import { sound } from "../scene/audio";
import { XRApp, hailOpen } from "./XRApp";
import { MOTION_DENIED, cardboardRequested, detectXRMode, ipdFromSearch, isPhoneUA, requestMotionPermission, vrBufferScale, type XRKind } from "./vrMode";
import "./xr.css";

type Mode = "checking" | "ready-ar" | "ready-vr" | "ready-desk" | "in-ar" | "in-vr" | "in-desk";
const READY: Record<XRKind, Mode> = { ar: "ready-ar", vr: "ready-vr", desk: "ready-desk" };

/** The Cardboard polyfill, in its own chunk: only a phone without native WebXR VR (or `?vr=cardboard`) loads it. */
const loadPolyfill = (force: boolean) =>
  import("./cardboard").then((m) => m.installCardboard(force, { bufferScale: vrBufferScale(window.devicePixelRatio || 1), ipdMm: ipdFromSearch(window.location.search) }));

/** Portrait on a phone (the lens shell needs landscape; an iPhone can't be locked to it). */
function usePortrait(): boolean {
  const q = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(orientation: portrait)") : null;
  const [portrait, setPortrait] = useState(() => !!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => setPortrait(q.matches);
    q.addEventListener?.("change", on);
    window.addEventListener("resize", on);
    return () => { q.removeEventListener?.("change", on); window.removeEventListener("resize", on); };
  }, [q]);
  return portrait;
}

/**
 * Who this chart room is: a headset seat (Quest-first: a member's own seat, started, joined or let in on this headset;
 * also a member's laptop view) — or the shared headset paired with a code (the organizer's controls, nobody's terms).
 */
type Cred = { kind: "member"; seat: Session } | { kind: "device"; tripId: string; joinCode: string; deviceToken: string };
function loadCred(code: string): Cred | null {
  const seat = loadSession(code);
  if (seat?.memberToken) return { kind: "member", seat };
  const dev = loadHeadsetSession(code);
  return dev ? { kind: "device", ...dev } : null;
}

export default function XRPage() {
  const { code = "" } = useParams();
  // TR2-010: the headset key, never the phone seat. State, so a refused pairing (below) drops it and re-renders.
  const [cred, setCred] = useState(() => loadCred(code));
  const session = cred?.kind === "device" ? cred : null;
  const seat = cred?.kind === "member" ? cred.seat : null;
  const [unpaired, setUnpaired] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<XRApp | null>(null);
  const [store, setStore] = useState<TripStore | null>(null);
  const [mode, setMode] = useState<Mode>("checking");
  const [err, setErr] = useState("");
  const ready = useRef<Mode>("ready-desk");
  const polyfilled = useRef(false);
  const portrait = usePortrait();

  useEffect(() => { setCred(loadCred(code)); setUnpaired(false); }, [code]);
  const key = seat?.memberToken ?? session?.deviceToken;

  useEffect(() => {
    if (!cred || !key || !hostRef.current) return;
    const s = cred.kind === "member"
      ? new TripStore({ tripId: cred.seat.tripId, memberToken: cred.seat.memberToken, surface: "xr" })
      : new TripStore({ tripId: cred.tripId, deviceToken: cred.deviceToken, surface: "xr" });
    // R2-WP-07 / L3-001 / L2-002: the helm no longer takes this headset's key (another headset paired, the organizer
    // unpaired it, or 12 h passed) — at the join or on the next action. Forget the key and show the pairing card
    // (the cleanup below ends the chart room and closes the socket).
    const offUnpaired = s.subscribe(() => {
      const c = s.state.error?.code;
      if (c === "TOKEN_REJECTED" && cred.kind === "member") { setUnpaired(true); setCred(null); return; }
      if (c !== "DEVICE_EXPIRED" || cred.kind !== "device") return;
      clearHeadsetSession(code);
      setUnpaired(true);
      setCred(null);
    });
    // phones (Gear VR / Cardboard): no MSAA, the GPU is busy enough drawing two eyes on a 1440p panel
    const phone = isPhoneUA(navigator.userAgent);
    // Quest-first: a seat's headset sees its own member's terms and seal in the side panel; the shared headset never does
    const seatOpts = cred.kind === "member" && cred.seat.memberToken ? {
      viewer: { memberId: cred.seat.memberId, organizer: false },
      rest: { tripId: cred.seat.tripId, token: cred.seat.memberToken },
      api: { passkeyStatus: api.passkeyStatus, setSealPin: api.setSealPin },
      ports: () => api.cities().then((cs) => cs.map((c) => ({ cityId: c.cityId, name: c.name, lat: c.lat, lng: c.lng, region: c.region, state: c.state }))),
    } : {
      viewer: { organizer: true },
      ports: () => api.cities().then((cs) => cs.map((c) => ({ cityId: c.cityId, name: c.name, lat: c.lat, lng: c.lng, region: c.region, state: c.state }))),
    };
    const app = new XRApp(hostRef.current, s, { antialias: !phone, vrMenu: phone || cardboardRequested(window.location.search) }, seatOpts);
    // Exit (menu, Back / Escape, or the end of an XR session) returns to the Enter card, in the laptop view too;
    // the pairing is kept
    app.onExit = () => setMode((m) => (m === "in-ar" || m === "in-vr" || m === "in-desk" ? ready.current : m));
    appRef.current = app;
    if (import.meta.env.DEV) (window as unknown as { __aa: unknown }).__aa = { store: s, app };
    setStore(s);
    void preloadFonts(); // start now: awaiting it in the Enter tap could outlive the user activation
    let live = true;
    void detectXRMode({
      getXR: () => navigator.xr as unknown as { isSessionSupported(m: string): Promise<boolean> } | undefined,
      search: window.location.search,
      phone: isPhoneUA(navigator.userAgent),
      loadPolyfill,
    }).then((d) => {
      polyfilled.current = d.polyfilled;
      ready.current = READY[d.kind];
      if (live) setMode(READY[d.kind]);
    });
    return () => { live = false; offUnpaired(); app.dispose(); s.close(); appRef.current = null; setStore(null); setMode("checking"); };
    // one chart room per headset key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, key]);

  async function enter(kind: "ar" | "vr" | "desk") {
    const app = appRef.current;
    if (!app) return;
    setErr("");
    // requestSession needs transient user activation: call it before any slow await (fonts can take
    // seconds on venue Wi-Fi and are already preloading since mount). ctx.resume() is quick.
    const unlocked = sound.unlock();
    // iOS: motion access (head tracking) must be asked in this same tap, before anything else is awaited
    const motion = kind === "vr" ? requestMotionPermission() : null;
    try {
      if (kind === "ar") { await app.enterAR(); setMode("in-ar"); }
      else if (kind === "vr") {
        if ((await motion) === "denied") { setErr(MOTION_DENIED); return; }
        await app.enterVR(polyfilled.current);
        setMode("in-vr");
      }
      else { await unlocked; await preloadFonts(); app.startDesk(); setMode("in-desk"); }
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : kind === "vr" ? "Couldn't open VR." : "Couldn't open mixed reality.");
      // a refused VR session (no gesture, fullscreen denied) can be tried again; AR falls back to the laptop view
      setMode(kind === "vr" ? "ready-vr" : "ready-desk");
    }
  }

  if (!cred) {
    return (
      <div className="cr-page cr-quest">
        <div className="cr-overlay">
          <div className="cr-card">
            <h1>{unpaired ? "Come aboard again" : "Not aboard yet"}</h1>
            {unpaired
              ? <p>{JOIN_REFUSAL.DEVICE_EXPIRED.replace("Enter a new code from the organizer's phone.", "Join the voyage again from this headset.")}</p>
              : <p>This headset isn't on voyage <span className="mono">{code.toUpperCase()}</span> yet.</p>}
            <Link className="cr-btn primary block" to="/xr/join">Join a trip</Link>
            <Link className="cr-btn block" to="/xr/code">Enter a headset code</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`cr-page${seat ? " cr-quest" : ""}`}>
      <div className="cr-canvas" ref={hostRef} />
      {store && (mode === "checking" || mode === "ready-ar" || mode === "ready-vr" || mode === "ready-desk") && (
        <EnterCard store={store} mode={mode} err={err} onEnter={enter} seat={seat} />
      )}
      {mode === "in-desk" && appRef.current && store && <DeskToolbar store={store} app={appRef.current} />}
      {mode === "in-vr" && portrait && (
        <div className="cr-overlay cr-rotate" role="status">
          <div className="cr-card">
            <h1>Turn your phone sideways</h1>
            <p>Landscape, with the screen facing the lenses, then slip it into the headset.</p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Laptop view controls. Hailing only opens while the mates are talking, so the button says so the rest of the time. */
function DeskToolbar({ store, app }: { store: TripStore; app: XRApp }) {
  const s = useTripStore(store);
  const canHail = hailOpen(s.trip); // L2-005: not in the Captain's opening, nor once the last Watch has begun
  return (
    <>
      <div className="cr-toolbar">
        <button disabled={!canHail} title={canHail ? undefined : "Hails open while the mates are at the table"} onClick={() => app.openHail()}>
          Hail the table
        </button>
        <button onClick={() => app.toggleMenu()}>Menu</button>
      </div>
      <p className="cr-hint">Laptop view of the chart room. Drag to look around, click the Captain's tag, a cloche or the clock; press and hold to hail.</p>
    </>
  );
}

function EnterCard({ store, mode, err, onEnter, seat }: { store: TripStore; mode: Mode; err: string; onEnter: (k: "ar" | "vr" | "desk") => void; seat: Session | null }) {
  const s = useTripStore(store);
  const trip = s.trip;
  const [pinStep, setPinStep] = useState<"unknown" | "needed" | "setting" | "done">("unknown");
  // Quest-first: a seat on a browser without passkeys sets a seal PIN (once)
  useEffect(() => {
    if (!seat?.memberToken || seat.device !== "headset") return;
    let live = true;
    void passkeysUsable().then(async (ok) => {
      if (ok) { if (live) setPinStep("done"); return; }
      const st = await api.sealPinStatus(seat.tripId, seat.memberToken!).catch(() => ({ set: true }));
      if (live) setPinStep(st.set ? "done" : "needed");
    });
    return () => { live = false; };
  }, [seat?.tripId, seat?.memberToken, seat?.device]);
  if (seat && pinStep === "setting") {
    return <div className="cr-scroll"><div className="cr-card"><SealPinSetup session={seat} onDone={() => setPinStep("done")} /></div></div>;
  }
  const me = seat ? trip?.crew.find((c) => c.memberId === seat.memberId) : undefined;
  const ask = seat ? s.headsetRequest : null;
  const joinUrl = trip ? `${location.origin}/t/${trip.joinCode}` : "";
  // L2-003: a refused join (no such voyage, too many tries) says so instead of "Finding the voyage…" forever
  const joinErr = !trip && s.error?.event === "trip:join" ? s.error : null;
  return (
    <div className="cr-overlay">
      <div className="cr-card">
        <h1>The chart room</h1>
        <p>{trip ? <>Voyage <b>{trip.name}</b> · {trip.crew.length} aboard</>
          : joinErr ? <span className="cr-error">{joinErr.message}</span>
          : s.connected ? "Finding the voyage…" : "Raising the signal…"}</p>
        {!trip && joinErr && <p className="muted">Check the code with the organizer, or <Link to="/xr">pair again</Link>.</p>}
        {trip && <p className="muted">{trip.crew.map((c) => `${c.name}${c.briefSealed ? " (sealed)" : ""}`).join(" · ")}</p>}
        {ask ? (
          <div className="cr-ask" role="alertdialog" aria-label="Let this headset in?">
            <p><b>Let this headset in?</b> Another headset is asking to sit in your seat. It would see your terms.</p>
            <button className="cr-btn primary" onClick={() => store.emit("headset:approve", { requestId: ask.requestId, allow: true })}>Let it in</button>
            <button className="cr-btn" onClick={() => store.emit("headset:approve", { requestId: ask.requestId, allow: false })}>Not me</button>
          </div>
        ) : null}
        {seat && trip && trip.status === "BRIEFING" && !trip.crewClosed ? (
          <div className="cr-join">
            <QR value={joinUrl} size={150} label={`QR to join voyage ${trip.joinCode}`} />
            <div>
              <p className="muted">Friends scan with their phones, or type the code at {location.host}/join (a Quest: {location.host}/xr → Join a trip).</p>
              <div className="cr-joincode" aria-label={`Code ${trip.joinCode.split("").join(" ")}`}>{trip.joinCode}</div>
            </div>
          </div>
        ) : null}
        {seat && trip ? (
          <p>
            <Link className="cr-btn" to={`/t/${trip.joinCode}/brief`}>{me?.briefSealed ? "Re-read my terms" : "Seal my terms"}</Link>
            {trip.status === "SEALING" ? <Link className="cr-btn" to={`/t/${trip.joinCode}/seal`}>My seal</Link> : null}
            {pinStep === "needed" ? <button className="cr-btn" onClick={() => setPinStep("setting")}>Set a seal PIN</button> : null}
          </p>
        ) : null}
        {seat ? <p className="muted">In the chart room, the <b>Log book</b> tag on the table opens your terms, the crew and the trip beside the chart.</p> : null}
        {mode === "ready-ar" && (
          <>
            <p>Find a table, then pinch to lay down the chart.</p>
            <button className="cr-btn primary" onClick={() => onEnter("ar")}>Enter the chart room</button>
            <button className="cr-btn" onClick={() => onEnter("desk")}>Laptop view</button>
          </>
        )}
        {mode === "ready-vr" && (
          <>
            <p>Sit down, tap Enter VR, turn the phone sideways and slip it into the headset.</p>
            <p className="muted">Look at a thing and hold your gaze until the red ring fills to choose it (a screen tap works too). Look at the brass wheel for the menu; look down at the Exit VR plaque to leave.</p>
            <button className="cr-btn primary" onClick={() => onEnter("vr")}>Enter VR</button>
            <button className="cr-btn" onClick={() => onEnter("desk")}>Laptop view</button>
          </>
        )}
        {mode === "ready-desk" && (
          <>
            <p className="muted">This browser can't open mixed reality, so the chart room opens as a laptop view.</p>
            <button className="cr-btn primary" onClick={() => onEnter("desk")}>Open the chart room</button>
          </>
        )}
        {mode === "checking" && <p className="muted">Checking for mixed reality and VR…</p>}
        {err && <p className="cr-error">{err}</p>}
      </div>
    </div>
  );
}
