import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ORIGINS, ORIGIN_COORDS, TRIP_NAME_MAX_CHARS } from "@all-ayes/shared";
import { api } from "../../net/api";
import { saveSession } from "../../net/session";
import { useAsyncAction } from "../useAsyncAction";
import { CrewMemberFields, type CrewMemberDraft } from "../components/CrewMemberFields";
import { Anchor } from "../components/icons";
import { Card, Eyebrow, LinkButton, MarginNote, Page, Plotting, StampButton } from "../components/ui";

/** P1 — Create voyage. */
export default function Create() {
  const navigate = useNavigate();
  const [name, setName] = useState("Spring Break '27");
  // the organizer's default port; JoinCrew and "Add an absent friend" default to the other two, so a quick demo
  // crew flies from three different ports and its arcs spread across the globe
  const [you, setYou] = useState<CrewMemberDraft>({ name: "", band: 1, origin: "ATL" });
  // OPT-005: the chart's ports come from the helm's dataset (/api/cities); null = every port (none named)
  const [ports, setPorts] = useState<string[] | null>(null);
  const action = useAsyncAction();

  const submit = () => action.run(async () => {
    const r = await api.createTrip({ name: name.trim(), organizerName: you.name.trim(), band: you.band, origin: you.origin, cityIds: ports ?? undefined });
    saveSession({ tripId: r.tripId, joinCode: r.joinCode, memberId: r.memberId, memberToken: r.memberToken });
    navigate(`/t/${r.joinCode}/muster`); // P2 first: the QR to muster the crew (TR1-012)
  }, "Couldn't set sail. Try again.");

  return (
    <Page>
      <Eyebrow icon={<Anchor size={18} />}>New voyage</Eyebrow>
      <h1 className="h1">Set a course</h1>
      <form onSubmit={(e) => { e.preventDefault(); if (you.name.trim() && name.trim()) void submit(); }}>
        <label className="field"><span>Voyage name</span>
          <input className="input" value={name} maxLength={TRIP_NAME_MAX_CHARS} onChange={(e) => setName(e.target.value)} required />
        </label>
        <CrewMemberFields value={you} onChange={setYou} />

        <Card label="Chart">
          <div className="eyebrow">The chart</div>
          <h2 className="h2">Three Ports</h2>
          <PortPicker ports={ports} onChange={setPorts} />
          <p className="small mono">Mar 12–16, 2027 · from {FROM}</p>
          <p className="small">Sample listings, realistic prices. No real bookings are made.</p>
        </Card>

        {action.err ? <MarginNote>{action.err}</MarginNote> : null}
        <StampButton type="submit" disabled={action.busy || !you.name.trim()}>Set sail</StampButton>
        <div className="center"><LinkButton onClick={() => navigate("/")}>Back</LinkButton></div>
      </form>
    </Page>
  );
}

type City = Awaited<ReturnType<typeof api.cities>>[number];

/**
 * O2-021: which ports go on the chart (every one on by default, at least two). `ports` stays null until the helm's
 * list arrives, and if it never does the helm puts every port on the chart.
 */
function PortPicker({ ports, onChange }: { ports: string[] | null; onChange: (ports: string[]) => void }) {
  const [cities, setCities] = useState<City[] | null>(null);
  const [noCities, setNoCities] = useState(false);
  useEffect(() => {
    // O2-048: the request is aborted on unmount (not just ignored)
    const ctl = new AbortController();
    api.cities({ signal: ctl.signal })
      .then((c) => { setCities(c); onChange(c.map((x) => x.cityId)); })
      .catch(() => { if (!ctl.signal.aborted) setNoCities(true); });
    return () => ctl.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cities || !ports) return noCities ? <p className="small">Every port goes on the chart.</p> : <Plotting label="Reading the chart…" />;
  return (
    <>
      <p className="small">Which ports go on the chart? Pick at least two.</p>
      <div className="chips" role="group" aria-label="Ports on the chart">
        {cities.map((c) => {
          const on = ports.includes(c.cityId);
          return (
            <button
              key={c.cityId} type="button" className="chip" aria-pressed={on} title={c.notes.join(" · ") || undefined}
              disabled={on && ports.length <= 2}
              onClick={() => onChange(on ? ports.filter((x) => x !== c.cityId) : [...ports, c.cityId])}
            >
              {c.name}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** "Atlanta, Chicago, New York" — the origins a crew can fly from. */
const FROM = ORIGINS.map((o) => ORIGIN_COORDS[o].name).join(", ");
