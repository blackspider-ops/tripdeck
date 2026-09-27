import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MAX_CREW } from "@all-ayes/shared";
import { api, ApiError } from "../../net/api";
import { saveSession, type Session } from "../../net/session";
import { LOOKUP_RETRY_MS } from "../timing";
import { useAsyncAction } from "../useAsyncAction";
import { CrewMemberFields, type CrewMemberDraft } from "./CrewMemberFields";
import { Anchor } from "./icons";
import { Card, Eyebrow, MarginNote, Page, Plotting, StampButton, firstFreeBand } from "./ui";
import { CrewList } from "./crew";


type VoyageLookup = Awaited<ReturnType<typeof api.tripByCode>>;

/** P3 — Join, for someone who opened /t/CODE without a session (TripShell shows it; not a route of its own). */
export function JoinCrew({ joinCode, onJoined }: { joinCode: string; onJoined: (s: Session) => void }) {
  const navigate = useNavigate();
  const [trip, setTrip] = useState<VoyageLookup | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // (Create defaults the organizer to ATL; a friend to ORD, an absent friend to JFK: see Create)
  const [you, setYou] = useState<CrewMemberDraft>({ name: "", band: 1, origin: "ORD" });
  const join = useAsyncAction();
  // R2-WP-08 follow-up: the crew refresh after a refused join is aborted on unmount / a new code too
  const refresh = useRef<AbortController | null>(null);
  useEffect(() => () => refresh.current?.abort(), [joinCode]);

  useEffect(() => {
    // O2-048: aborted on unmount / a new code, so a late answer never lands on the wrong voyage.
    // L1-002 / L5-004: LOADING (503: the voyage is being fetched, or the ship's log is reconnecting) is retried.
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = (attempt: number) => {
      api.tripByCode(joinCode, { signal: ctl.signal })
        .then((t) => { setTrip(t); setYou((d) => ({ ...d, band: firstFreeBand(t.takenBands) })); })
        .catch((e) => {
          if (ctl.signal.aborted) return;
          if (e instanceof ApiError && e.code === "LOADING" && attempt < LOOKUP_RETRY_MS.length) {
            timer = setTimeout(() => look(attempt + 1), LOOKUP_RETRY_MS[attempt]);
            return;
          }
          setErr(e instanceof ApiError && e.status === 404 ? "No voyage with that code. Check it and try again." : "Couldn't reach the voyage.");
        });
    };
    setErr(null);
    look(0);
    return () => { ctl.abort(); clearTimeout(timer); };
  }, [joinCode]);

  if (err) {
    return (
      <Page>
        <Eyebrow icon={<Anchor size={18} />}>Tripdeck</Eyebrow>
        <MarginNote>{err}</MarginNote>
        <button type="button" className="link" onClick={() => navigate("/join")}>Enter a different code</button>
      </Page>
    );
  }
  if (!trip) return <Page><Plotting /></Page>;

  async function submit(t: VoyageLookup) {
    const ok = await join.run(async () => {
      const r = await api.join(t.tripId, { name: you.name.trim(), band: you.band, origin: you.origin });
      const s: Session = { tripId: t.tripId, joinCode, memberId: r.memberId, memberToken: r.memberToken };
      saveSession(s);
      onJoined(s);
      navigate(`/t/${joinCode}/brief`, { replace: true });
    }, "Couldn't join. Try again.");
    if (ok) return;
    // the crew may have changed under us (band taken, crew full): refresh it
    refresh.current?.abort();
    const ctl = (refresh.current = new AbortController());
    api.tripByCode(joinCode, { signal: ctl.signal })
      .then((fresh) => {
        setTrip(fresh);
        setYou((d) => (fresh.takenBands.includes(d.band) ? { ...d, band: firstFreeBand(fresh.takenBands) } : d));
      })
      .catch(() => undefined);
  }

  const full = trip.crew.length >= MAX_CREW;
  const late = trip.status !== "BRIEFING";
  const closed = !!trip.crewClosed; // SEC-010
  return (
    <Page>
      <Eyebrow icon={<Anchor size={18} />}>Voyage <span className="mono">{joinCode}</span></Eyebrow>
      <h1 className="h1">{trip.name}</h1>
      <p className="body">Join the crew. You'll seal your own terms next — only your mate sees them.</p>
      <Card label="Crew aboard">
        <CrewList crew={trip.crew} mode="plain" />
      </Card>
      {full || late || closed ? (
        <MarginNote>
          {full ? `This crew is full (${MAX_CREW} aboard).` : late ? "This voyage has already left the harbor." : "The organizer has closed this crew. Ask them to open it."}
        </MarginNote>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (you.name.trim()) void submit(trip); }}>
          <CrewMemberFields value={you} onChange={setYou} taken={trip.takenBands} />
          {join.err ? <MarginNote onClear={join.clear}>{join.err}</MarginNote> : null}
          <StampButton type="submit" disabled={join.busy || !you.name.trim()}>Join the crew</StampButton>
        </form>
      )}
    </Page>
  );
}
