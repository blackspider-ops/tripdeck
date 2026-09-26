import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DEFAULT_PORTS, MAX_PORTS, MAX_WINDOWS, MIN_PORTS, REGIONS, TRIP_NAME_MAX_CHARS, stateName,
  type CityPick, type Destination, type Region,
} from "@all-ayes/shared";
import { ApiError, api, type Catalog, type CatalogCity } from "../../net/api";
import { saveSession } from "../../net/session";
import { useAsyncAction } from "../useAsyncAction";
import { formatWindow } from "../format";
import { CrewMemberFields, type CrewMemberDraft } from "../components/CrewMemberFields";
import { CitySearch } from "../components/CitySearch";
import { Anchor } from "../components/icons";
import { Button, Card, Eyebrow, InlineError, LinkButton, MarginNote, Page, Plotting, StampButton } from "../components/ui";

type Mode = Destination["kind"];
const MODES: { id: Mode; label: string }[] = [
  { id: "cities", label: "Pick ports" }, { id: "regions", label: "Regions" }, { id: "anywhere", label: "Anywhere" },
];

/** `n` distinct items of `xs` at random. */
function surprise<T>(xs: readonly T[], n: number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

/** P1 — Create voyage: the organizer's seat, where the voyage may go, and the dates on offer. */
export default function Create() {
  const navigate = useNavigate();
  const [name, setName] = useState("Spring Break '27");
  // the organizer's default port; JoinCrew and "Add an absent friend" default to the other two, so a quick demo
  // crew flies from three different ports and its arcs spread across the globe
  const [you, setYou] = useState<CrewMemberDraft>({ name: "", band: 1, origin: "ATL" });
  const course = useCourse();
  const action = useAsyncAction();

  const submit = () => action.run(async () => {
    const r = await api.createTrip({ name: name.trim(), organizerName: you.name.trim(), band: you.band, origin: you.origin, ...course.payload() });
    saveSession({ tripId: r.tripId, joinCode: r.joinCode, memberId: r.memberId, memberToken: r.memberToken });
    navigate(`/t/${r.joinCode}/muster`); // P2 first: the QR to muster the crew (TR1-012)
  }, "Couldn't set sail. Try again.");

  return (
    <Page>
      <Eyebrow icon={<Anchor size={18} />}>New voyage</Eyebrow>
      <h1 className="h1">Set a course</h1>
      <form onSubmit={(e) => { e.preventDefault(); if (you.name.trim() && name.trim() && course.ready) void submit(); }}>
        <label className="field"><span>Voyage name</span>
          <input className="input" value={name} maxLength={TRIP_NAME_MAX_CHARS} onChange={(e) => setName(e.target.value)} required />
        </label>
        <CrewMemberFields value={you} onChange={setYou} />

        <WhereCard course={course} />
        <WhenCard course={course} />
        <p className="small">Sample listings; flights are modelled. No real bookings are made.</p>

        {action.err ? <MarginNote>{action.err}</MarginNote> : null}
        {course.problem ? <p className="small">{course.problem}</p> : null}
        <StampButton type="submit" disabled={action.busy || !you.name.trim() || !course.ready}>Set sail</StampButton>
        <div className="center"><LinkButton onClick={() => navigate("/")}>Back</LinkButton></div>
      </form>
    </Page>
  );
}

/** The course being drafted: where (ports, regions or anywhere) and when (1–3 windows), from the helm's catalog. */
function useCourse() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<Mode>("cities");
  const [ports, setPorts] = useState<string[]>([]);
  /** Names of ports added from the map (not in the catalog). */
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [regions, setRegions] = useState<Region[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [windows, setWindows] = useState<string[]>([]);
  useEffect(() => {
    // O2-048: the request is aborted on unmount (not just ignored)
    const ctl = new AbortController();
    api.catalog({ signal: ctl.signal })
      .then((c) => {
        setCatalog(c);
        setPorts(surprise(c.cities.map((x) => x.cityId), Math.min(DEFAULT_PORTS, c.cities.length)));
        setWindows(c.defaultWindowIds.slice(0, MAX_WINDOWS));
      })
      .catch(() => { if (!ctl.signal.aborted) setFailed(true); });
    return () => ctl.abort();
  }, []);

  const nameOf = (id: string) => catalog?.cities.find((c) => c.cityId === id)?.name ?? extra[id] ?? id;
  let problem: string | null = null;
  if (catalog) {
    if (mode === "cities" && (ports.length < MIN_PORTS || ports.length > MAX_PORTS)) problem = `Pick ${MIN_PORTS} to ${MAX_PORTS} ports.`;
    else if (mode === "regions" && !regions.length && !states.length) problem = "Pick at least one region.";
    else if (!windows.length) problem = "Offer at least one set of dates.";
  }
  const payload = (): { destination?: Destination; windowIds?: string[] } => {
    if (!catalog) return {}; // the helm chooses (3 ports at random, the next two windows)
    const destination: Destination = mode === "cities" ? { kind: "cities", cityIds: ports }
      : mode === "regions" ? { kind: "regions", ...(regions.length ? { regions } : {}), ...(states.length ? { states } : {}) }
      : { kind: "anywhere" };
    return { destination, windowIds: windows };
  };
  return {
    catalog, failed, mode, setMode, ports, setPorts, extra, setExtra, regions, setRegions, states, setStates, windows, setWindows,
    nameOf, problem, ready: failed || (Boolean(catalog) && !problem), payload,
  };
}
type Course = ReturnType<typeof useCourse>;

const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

function WhereCard({ course: c }: { course: Course }) {
  if (c.failed) return <Card label="Where"><div className="eyebrow">Where</div><p className="small">Couldn't read the chart. The helm will pick three ports and the next dates.</p></Card>;
  if (!c.catalog) return <Card label="Where"><Plotting label="Reading the chart…" /></Card>;
  return (
    <Card label="Where">
      <div className="eyebrow">Where</div>
      <div className="segmented" role="radiogroup" aria-label="How to choose where">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" className="chip" aria-checked={c.mode === m.id} aria-pressed={c.mode === m.id} onClick={() => c.setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {c.mode === "cities" ? <PortPicker course={c} /> : c.mode === "regions" ? <RegionPicker course={c} /> : (
        <p className="small">Anywhere on the chart. When the table meets, the helm ranks every port for this crew and puts the best four on the chart.</p>
      )}
    </Card>
  );
}

/** O2-021: which ports go on the chart: 2–4, found by name, grouped by region; "Surprise me" draws three. */
function PortPicker({ course: c }: { course: Course }) {
  const catalog = c.catalog!;
  const [filter, setFilter] = useState("");
  const [charting, setCharting] = useState<string | null>(null);
  const [mapErr, setMapErr] = useState<string | null>(null);
  const [attribution, setAttribution] = useState<string | null>(null);
  const full = c.ports.length >= MAX_PORTS;
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const hit = (x: CatalogCity) => !f || [x.name, x.cityId, x.country ?? "", x.state ? stateName(x.state) : ""].some((s) => s.toLowerCase().includes(f));
    const order = [...REGIONS, undefined];
    return order.map((r) => ({ region: r, cities: catalog.cities.filter((x) => x.region === r && hit(x)) })).filter((g) => g.cities.length);
  }, [catalog, filter]);

  const add = (id: string, name?: string) => {
    if (name) c.setExtra({ ...c.extra, [id]: name });
    if (!c.ports.includes(id) && c.ports.length < MAX_PORTS) c.setPorts([...c.ports, id]);
  };
  const onPick = async (p: CityPick) => {
    setMapErr(null);
    if (p.kind === "curated") return add(p.cityId);
    if (full) { setMapErr(`At most ${MAX_PORTS} ports on one chart.`); return; }
    setCharting(p.name);
    try {
      const r = await api.worldPack(p.osmId);
      add(r.pack.city._id, r.pack.city.name);
      setAttribution(r.pack.meta?.attribution ?? "© OpenStreetMap contributors");
    } catch (e) {
      const err = e as ApiError;
      setMapErr(err.status === 503 ? "The map is busy — try again in a minute." : err.message || "Couldn't chart that place.");
    } finally {
      setCharting(null);
    }
  };

  return (
    <>
      <p className="small">Pick {MIN_PORTS} to {MAX_PORTS} ports.</p>
      <div className="chips" role="group" aria-label="Ports on the chart">
        {c.ports.map((id) => (
          <button key={id} type="button" className="chip" aria-pressed="true" onClick={() => c.setPorts(c.ports.filter((x) => x !== id))} aria-label={`Remove ${c.nameOf(id)}`}>
            {c.nameOf(id)} ×
          </button>
        ))}
      </div>
      <Button small onClick={() => c.setPorts(surprise(catalog.cities.map((x) => x.cityId), Math.min(DEFAULT_PORTS, catalog.cities.length)))}>Surprise me</Button>
      <label className="field mt-s"><span>Find a charted port</span>
        <input className="input" type="search" value={filter} placeholder="Lisbon, Japan, Texas…" onChange={(e) => setFilter(e.target.value)} />
      </label>
      <div className="port-scroll">
        {groups.map((g) => (
          <div key={g.region ?? "other"} className="port-group" role="group" aria-label={g.region ?? "Other ports"}>
            <div className="eyebrow">{g.region ?? "Other"}</div>
            <div className="chips">
              {g.cities.map((x) => {
                const on = c.ports.includes(x.cityId);
                return (
                  <button
                    key={x.cityId} type="button" className="chip" aria-pressed={on} title={x.notes.join(" · ") || undefined}
                    disabled={!on && full} onClick={() => c.setPorts(toggle(c.ports, x.cityId))}
                  >
                    {x.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {!groups.length ? <p className="small">No charted port by that name. Try "Add any city" below.</p> : null}
      </div>
      <CitySearch label="Add any city" onPick={(p) => void onPick(p)} />
      {charting ? <Plotting label={`Charting ${charting}…`} /> : null}
      {mapErr ? <InlineError>{mapErr}</InlineError> : null}
      {attribution ? <p className="hint">{attribution}</p> : null}
    </>
  );
}

/** Regions (at least one), or some US states. */
function RegionPicker({ course: c }: { course: Course }) {
  const catalog = c.catalog!;
  const states = [...new Set(catalog.cities.flatMap((x) => (x.state ? [x.state] : [])))].sort((a, b) => stateName(a).localeCompare(stateName(b)));
  return (
    <>
      <p className="small">Somewhere in… (the helm ranks the ports there for this crew when the table meets, and charts the best four)</p>
      <div className="chips" role="group" aria-label="Regions">
        {catalog.regions.map((r) => (
          <button key={r} type="button" className="chip" aria-pressed={c.regions.includes(r)} onClick={() => c.setRegions(toggle(c.regions, r))}>{r}</button>
        ))}
      </div>
      {states.length ? (
        <>
          <p className="small mt-s">Or just some states</p>
          <div className="chips" role="group" aria-label="US states">
            {states.map((s) => (
              <button key={s} type="button" className="chip" aria-pressed={c.states.includes(s)} onClick={() => c.setStates(toggle(c.states, s))}>{stateName(s)}</button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

/** The dates on offer: 1–3 windows (the crew picks among these on their Brief). */
function WhenCard({ course: c }: { course: Course }) {
  if (!c.catalog) return null;
  return (
    <Card label="When">
      <div className="eyebrow">When</div>
      <p className="small">Offer 1 to {MAX_WINDOWS} sets of dates.</p>
      <div className="chips" role="group" aria-label="Dates on offer">
        {c.catalog.windows.map((w) => {
          const on = c.windows.includes(w.id);
          return (
            <button
              key={w.id} type="button" className="chip" aria-pressed={on} disabled={!on && c.windows.length >= MAX_WINDOWS}
              onClick={() => c.setWindows(toggle(c.windows, w.id))}
            >
              {w.label ? `${w.label} · ` : ""}{formatWindow(w.start, w.end, { year: true })}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
