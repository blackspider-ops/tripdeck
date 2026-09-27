import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DEFAULT_MAX_NIGHTS, DEFAULT_MIN_NIGHTS, DEFAULT_PORTS, LIVE_PRICE_NOTE, MAX_NIGHTS, MAX_PORTS, MIN_NIGHTS, MIN_PORTS, REGIONS,
  TRIP_NAME_MAX_CHARS, addDays, beyondLiveHorizon, checkDateRange, daysBetween, localToday, monthDayLabel, rangeBounds, stateName, weekday,
  type CityPick, type DateRange, type Destination, type Region,
} from "@all-ayes/shared";
import { ApiError, api, type Catalog, type CatalogCity } from "../../net/api";
import { saveSession } from "../../net/session";
import { questUi } from "../../xr/questMode";
import { useAsyncAction } from "../useAsyncAction";
import { formatWindow } from "../format";
import { CrewMemberFields, type CrewMemberDraft } from "../components/CrewMemberFields";
import { CitySearch } from "../components/CitySearch";
import { RangeCalendar } from "../components/Calendar";
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

/**
 * P1 — Create voyage: the organizer's seat, where the voyage may go, and when (a date range + trip length).
 * `quest` (Quest-first, /xr/new in Quest Browser): the same form, larger; the seat is the headset's and the voyage
 * opens in the chart room (its join QR and code are there for the crew's phones).
 */
export default function Create({ quest = false }: { quest?: boolean }) {
  const navigate = useNavigate();
  const [name, setName] = useState("Spring Break '27");
  // the organizer's default port; JoinCrew and "Add an absent friend" default to the other two, so a quick demo
  // crew flies from three different ports and its arcs spread across the globe
  const [you, setYou] = useState<CrewMemberDraft>({ name: "", band: 1, origin: "ATL" });
  const course = useCourse();
  const dates = useDates();
  const action = useAsyncAction();
  const ready = course.ready && !dates.problem;

  useEffect(() => (quest ? questUi(true) : undefined), [quest]);
  const submit = () => action.run(async () => {
    const r = await api.createTrip({
      name: name.trim(), organizerName: you.name.trim(), band: you.band, origin: you.origin, ...course.payload(), dateRange: dates.range!,
      ...(quest ? { device: "headset" as const } : {}),
    });
    saveSession({ tripId: r.tripId, joinCode: r.joinCode, memberId: r.memberId, memberToken: r.memberToken, ...(quest ? { device: "headset" as const } : {}) });
    // P2 first: the QR to muster the crew (TR1-012); on a Quest that's the chart room's Enter card
    navigate(quest ? `/t/${r.joinCode}/xr` : `/t/${r.joinCode}/muster`);
  }, "Couldn't set sail. Try again.");

  return (
    <Page>
      <Eyebrow icon={<Anchor size={18} />}>{quest ? "New voyage · on this headset" : "New voyage"}</Eyebrow>
      <h1 className="h1">Set a course</h1>
      <form onSubmit={(e) => { e.preventDefault(); if (you.name.trim() && name.trim() && ready) void submit(); }}>
        <label className="field"><span>Voyage name</span>
          <input className="input" value={name} maxLength={TRIP_NAME_MAX_CHARS} onChange={(e) => setName(e.target.value)} required />
        </label>
        <CrewMemberFields value={you} onChange={setYou} />

        <WhereCard course={course} />
        <WhenCard dates={dates} />
        <p className="small">Sample listings; flights are modelled. No real bookings are made.</p>

        {action.err ? <MarginNote>{action.err}</MarginNote> : null}
        {course.problem ? <p className="small">{course.problem}</p> : null}
        {dates.problem ? <p className="small">{dates.problem}</p> : null}
        <StampButton type="submit" disabled={action.busy || !you.name.trim() || !ready}>Set sail</StampButton>
        <div className="center"><LinkButton onClick={() => navigate(quest ? "/xr" : "/")}>Back</LinkButton></div>
      </form>
    </Page>
  );
}

/** The course being drafted: where (ports, regions or anywhere), from the helm's catalog. */
function useCourse() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<Mode>("cities");
  const [ports, setPorts] = useState<string[]>([]);
  /** Names of ports added from the map (not in the catalog). */
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [regions, setRegions] = useState<Region[]>([]);
  const [states, setStates] = useState<string[]>([]);
  useEffect(() => {
    // O2-048: the request is aborted on unmount (not just ignored)
    const ctl = new AbortController();
    api.catalog({ signal: ctl.signal })
      .then((c) => {
        setCatalog(c);
        setPorts(surprise(c.cities.map((x) => x.cityId), Math.min(DEFAULT_PORTS, c.cities.length)));
      })
      .catch(() => { if (!ctl.signal.aborted) setFailed(true); });
    return () => ctl.abort();
  }, []);

  const nameOf = (id: string) => catalog?.cities.find((c) => c.cityId === id)?.name ?? extra[id] ?? id;
  let problem: string | null = null;
  if (catalog) {
    if (mode === "cities" && (ports.length < MIN_PORTS || ports.length > MAX_PORTS)) problem = `Pick ${MIN_PORTS} to ${MAX_PORTS} ports.`;
    else if (mode === "regions" && !regions.length && !states.length) problem = "Pick at least one region.";
  }
  const payload = (): { destination?: Destination } => {
    if (!catalog) return {}; // the helm chooses (3 ports at random)
    const destination: Destination = mode === "cities" ? { kind: "cities", cityIds: ports }
      : mode === "regions" ? { kind: "regions", ...(regions.length ? { regions } : {}), ...(states.length ? { states } : {}) }
      : { kind: "anywhere" };
    return { destination };
  };
  return {
    catalog, failed, mode, setMode, ports, setPorts, extra, setExtra, regions, setRegions, states, setStates,
    nameOf, problem, ready: failed || (Boolean(catalog) && !problem), payload,
  };
}
type Course = ReturnType<typeof useCourse>;

const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

function WhereCard({ course: c }: { course: Course }) {
  if (c.failed) return <Card label="Where"><div className="eyebrow">Where</div><p className="small">Couldn't read the chart. The helm will pick three ports.</p></Card>;
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

/** The first Friday four or more weeks out: a default range that suits a quick demo. */
function defaultRange(today: string): { start: string; end: string } {
  let start = addDays(today, 28);
  while (weekday(start) !== 5) start = addDays(start, 1);
  return { start, end: addDays(start, 16) };
}

/**
 * When (docs/03 P1): the earliest departure → the latest return, and how many nights (MIN_NIGHTS..MAX_NIGHTS). The
 * crew then mark the days they can go on their Brief, and the helm picks up to three trips from that.
 */
function useDates() {
  const today = useMemo(() => localToday(), []);
  const bounds = useMemo(() => rangeBounds(today), [today]);
  const [start, setStart] = useState<string | null>(() => defaultRange(today).start);
  const [end, setEnd] = useState<string | null>(() => defaultRange(today).end);
  const [minNights, setMinNights] = useState(DEFAULT_MIN_NIGHTS);
  const [maxNights, setMaxNights] = useState(DEFAULT_MAX_NIGHTS);
  const range: DateRange | null = start && end ? { start, end, minNights, maxNights } : null;
  const problem = !start ? "Pick the earliest departure." : !end ? "Now pick the latest return." : checkDateRange(range!, bounds);
  const far = Boolean(end && beyondLiveHorizon(end, today));
  return {
    today, bounds, start, end, minNights, maxNights, range, problem, far,
    setRange: (s: string | null, e: string | null) => { setStart(s); setEnd(e); },
    setMinNights: (n: number) => { const v = Math.max(MIN_NIGHTS, Math.min(MAX_NIGHTS, n)); setMinNights(v); if (v > maxNights) setMaxNights(v); },
    setMaxNights: (n: number) => { const v = Math.max(MIN_NIGHTS, Math.min(MAX_NIGHTS, n)); setMaxNights(v); if (v < minNights) setMinNights(v); },
  };
}
type Dates = ReturnType<typeof useDates>;

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="nights" role="group" aria-label={label}>
      <Button small aria-label={`Fewer nights (${label.toLowerCase()})`} disabled={value <= MIN_NIGHTS} onClick={() => onChange(value - 1)}>−</Button>
      <span className="num-lg" aria-live="polite">{value}</span>
      <Button small aria-label={`More nights (${label.toLowerCase()})`} disabled={value >= MAX_NIGHTS} onClick={() => onChange(value + 1)}>+</Button>
    </div>
  );
}

/** When: a date range on the calendar, and the trip length. */
function WhenCard({ dates: d }: { dates: Dates }) {
  const span = d.start && d.end ? daysBetween(d.start, d.end) + 1 : 0;
  return (
    <Card label="When">
      <div className="eyebrow">When</div>
      <p className="small">Tap the earliest you could leave, then the latest you'd be back. Everyone marks the days they can go; the helm finds the best trips inside.</p>
      <RangeCalendar min={d.bounds.tomorrow} max={d.bounds.lastDay} start={d.start} end={d.end} onChange={d.setRange} />
      <p className="cal-summary" aria-live="polite">
        {d.start && d.end ? `${formatWindow(d.start, d.end, { year: true })} · ${span} days` : d.start ? `From ${monthDayLabel(d.start)} — now tap the latest return` : "No dates yet"}
      </p>
      <div className="eyebrow mt-s">Trip length (nights)</div>
      <div className="row spread">
        <Stepper label="Shortest" value={d.minNights} onChange={d.setMinNights} />
        <span className="small">to</span>
        <Stepper label="Longest" value={d.maxNights} onChange={d.setMaxNights} />
      </div>
      {d.far ? <p className="small" role="note">{LIVE_PRICE_NOTE}</p> : null}
    </Card>
  );
}
