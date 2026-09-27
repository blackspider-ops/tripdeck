import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../../net/api";
import { loadSession, readSeatLink, saveSession, type SeatLink, type Session } from "../../net/session";
import { TripStore } from "../../net/tripStore";
import { TripProvider } from "../TripContext";
import { claimOnce, redeemOnce } from "../seatClaims";
import { actionError } from "../errors";
import { Anchor } from "../components/icons";
import { Eyebrow, MarginNote, Page, Plotting, StampButton } from "../components/ui";
import { JoinCrew } from "../components/JoinCrew";
import { HeadsetAsk } from "../components/HeadsetAsk";
import { questUi } from "../../xr/questMode";
import PhaseRoutes from "./PhaseRoutes";

/** Owns /t/:code/* — session bootstrapping, one TripStore, and the phase guard. */
export default function TripShell() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const joinCode = code.toUpperCase();
  const [session, setSession] = useState<Session | null>(() => loadSession(joinCode));
  const [bootErr, setBootErr] = useState<string | null>(null);
  // Same route, different voyage code (e.g. /t/AAA → /t/BBB): pick up that voyage's session.
  const [sessionCode, setSessionCode] = useState(joinCode);
  if (sessionCode !== joinCode) {
    setSessionCode(joinCode);
    setSession(loadSession(joinCode));
    setBootErr(null);
  }

  // Demo handoff (#as=<one-time code>&m=<memberId>, SEC-004) and absent-friend invites (#m=<id>&k=<key>).
  // SEC-019: the secret is taken into state and stripped from the address bar (history, screenshots, logs) at once.
  const [link, setLink] = useState<SeatLink | null>(() => readSeatLink(location.search, location.hash));
  useEffect(() => {
    const fresh = readSeatLink(location.search, location.hash);
    if (!fresh) return;
    setLink(fresh);
    setBootErr(null);
    navigate(location.pathname, { replace: true });
  }, [location.search, location.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  // TR1-002: this phone already holds that seat (e.g. the friend re-opens their invite) → just open the voyage.
  const mine = !!link && !!session?.memberToken && session.memberId === link.m;
  // A link for another seat, opened on a phone that's already aboard (e.g. the organizer checking the invite),
  // would replace this phone's seat for good. Ask first (SEC-004: demo handoffs too).
  const [swapOk, setSwapOk] = useState(false);
  const askSwap = !!link && !mine && !swapOk && !!session?.memberToken;
  useEffect(() => {
    if (!link) return;
    if (mine) { setLink(null); return; }
    if (askSwap) return;
    let alive = true;
    (async () => {
      try {
        const trip = await api.tripByCode(joinCode);
        const memberToken = link.as ? await redeemOnce(trip.tripId, link.m, link.as) : await claimOnce(trip.tripId, link.m, link.k!);
        if (!alive) return;
        const s: Session = { tripId: trip.tripId, joinCode: trip.joinCode, memberId: link.m, memberToken };
        saveSession(s);
        setSession(s);
        setLink(null);
        setSwapOk(false);
      } catch (e) {
        // a bad or spent link never touches the seat this phone already holds
        if (alive) { setBootErr(actionError(e, "That link didn't work. Ask for a fresh one.")); setLink(null); setSwapOk(false); }
      }
    })();
    return () => { alive = false; };
  }, [link, joinCode, askSwap, mine]);

  if (askSwap) {
    return (
      <Page>
        <Eyebrow icon={<Anchor size={18} />}>Voyage <span className="mono">{joinCode}</span></Eyebrow>
        <h1 className="h1">This phone is already aboard</h1>
        <p className="body">This link is for another crew member's seat. Opening it here swaps this phone over to them.</p>
        <StampButton onClick={() => setLink(null)}>Keep my place</StampButton>
        <div className="center"><button type="button" className="link" onClick={() => setSwapOk(true)}>Open the link on this phone</button></div>
      </Page>
    );
  }
  if (link && !mine && !bootErr) return <Page><Plotting label="Coming aboard…" /></Page>;
  if (bootErr) {
    return (
      <Page>
        <MarginNote>{bootErr}</MarginNote>
        {session?.memberToken
          ? <StampButton onClick={() => setBootErr(null)}>Open my voyage</StampButton>
          : <button type="button" className="link" onClick={() => navigate("/")}>Back to the start</button>}
      </Page>
    );
  }
  if (!session?.memberToken) return <JoinCrew joinCode={joinCode} onJoined={setSession} />;
  return <Aboard key={session.memberToken} session={session} />;
}

function Aboard({ session }: { session: Session }) {
  // autoConnect off: StrictMode may build this twice; only the store the effect opens gets a socket.
  const store = useMemo(
    () => new TripStore({ tripId: session.tripId, memberToken: session.memberToken, surface: "phone", autoConnect: false }),
    [session.tripId, session.memberToken],
  );
  useEffect(() => {
    store.open();
    return () => store.close();
  }, [store]);
  // Quest-first: a headset seat reads the phone screens larger (arm's length, ray pointing)
  useEffect(() => questUi(session.device === "headset"), [session.device]);
  return (
    <TripProvider store={store} session={session}>
      <PhaseRoutes />
      <HeadsetAsk />
      {session.device === "headset" ? (
        <a className="btn quest-back" href={`/t/${session.joinCode}/xr`}>Chart room</a>
      ) : null}
    </TripProvider>
  );
}
