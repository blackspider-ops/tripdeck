import { useEffect, useRef } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import type { TripStatus } from "@all-ayes/shared";
import { clearSession, forgetVoyage } from "../../net/session";
import { useCrew, useTripSelector } from "../TripContext";
import { errorCopy } from "../errors";
import { allowedScreens, screenOf, type Screen } from "../phase";
import { Anchor } from "../components/icons";
import { CrewDoor } from "../components/organizer";
import { Eyebrow, MarginNote, Page, Plotting, SignalStrip } from "../components/ui";
import Muster from "./Muster";
import Brief from "./Brief";
import Wait from "./Wait";
import Table from "./Table";
import DryRun from "./DryRun";
import Seal from "./Seal";
import Booked from "./Booked";
import Voided from "./Voided";

/** The phase guard for /t/:code/<screen>: keeps each crew member on a screen their phase allows (policy in phase.ts). */
export default function PhaseRoutes() {
  // O2-046: only the slices the guard needs, so a turn, a vote or a voice arriving doesn't re-render it (or re-match
  // <Routes>): the phase, the connection, the banner, and who I am
  const { store, me, isOrganizer } = useCrew();
  const status = useTripSelector((s) => s.trip?.status ?? null);
  const tripName = useTripSelector((s) => s.trip?.name ?? "");
  const connected = useTripSelector((s) => s.connected);
  const error = useTripSelector((s) => s.error);
  const location = useLocation();
  const navigate = useNavigate();
  const { code = "" } = useParams();
  const sealed = !!me?.briefSealed;

  // When the voyage moves to a new phase, take everyone to that phase's main screen once.
  // (They can still go back to allowed screens afterwards, e.g. the table log during the Dry Run.)
  const lastStatus = useRef<TripStatus | null>(null);
  useEffect(() => {
    if (!status) return;
    const prev = lastStatus.current;
    lastStatus.current = status;
    if (prev && prev !== status) {
      const target = allowedScreens(status, sealed, isOrganizer)[0];
      navigate(`/t/${code}/${target}`, { replace: true });
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // R2-WP-07 / L3-001: the helm didn't take this phone's seat key (rotated, mis-restored, sailed without) and let it in
  // as a spectator. Latched for this voyage, so clearing the error banner can't bring back a member UI whose every
  // tap would be refused.
  const rejectedFor = useRef<string | null>(null);
  if (error?.code === "TOKEN_REJECTED" && error.event === "trip:join") rejectedFor.current = code;
  const tokenRejected = rejectedFor.current === code;

  if (!status) {
    // L1-002: a voyage the helm can't find is not a dead end: forget this phone's seat for it and go back to the start.
    // (LOADING is retried by the store, so its note just waits with the plotting mark.)
    const gone = error?.code === "NO_TRIP";
    return (
      <Page>
        {error && error.code !== "LOADING" ? <MarginNote>{errorCopy(error)}</MarginNote> : <Plotting label={error?.code === "LOADING" ? "Fetching the voyage from the ship's log…" : connected ? "Reading the log…" : "Plotting…"} />}
        {gone ? (
          <button type="button" className="link" onClick={() => { forgetVoyage(code); navigate("/", { replace: true }); }}>
            Back to the start
          </button>
        ) : null}
      </Page>
    );
  }
  if (!me || tokenRejected) {
    // Token no longer matches a crew member (sailed without, or the invite was opened on another phone), or the
    // helm refused the token at the join (TOKEN_REJECTED) while the seat still shows in the crew.
    return (
      <Page>
        <Eyebrow icon={<Anchor size={18} />}>{tripName}</Eyebrow>
        <MarginNote>{me ? "This phone's key for the voyage no longer works, so it can only watch." : "This phone isn't on the crew for this voyage anymore."}</MarginNote>
        <button type="button" className="link" onClick={() => { clearSession(code); navigate(`/join?code=${code.toUpperCase()}`); }}>
          Join again
        </button>
      </Page>
    );
  }
  const current = screenOf(location.pathname);
  const allowed = allowedScreens(status, sealed, isOrganizer);
  const target = allowed[0];
  if (!current || !allowed.includes(current as Screen)) {
    return <Navigate to={`/t/${code}/${target}`} replace />;
  }

  return (
    <>
      {!connected ? <SignalStrip /> : null}
      {error ? (
        <div className="log-column pb-0">
          <MarginNote onClear={() => store.clearError()}>{errorCopy(error)}</MarginNote>
        </div>
      ) : null}
      <Routes>
        <Route path="muster" element={<Muster />} />
        <Route path="brief" element={<Brief />} />
        <Route path="wait" element={<Wait />} />
        <Route path="table" element={<Table />} />
        <Route path="dryrun" element={<DryRun />} />
        <Route path="seal" element={<Seal />} />
        <Route path="booked" element={<Booked />} />
        <Route path="voided" element={<Voided />} />
        <Route path="*" element={<Navigate to={`/t/${code}/${target}`} replace />} />
      </Routes>
      {isOrganizer && current === "muster" && status === "BRIEFING" ? <CrewDoor /> : null}
    </>
  );
}
