import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DEALBREAKERS, MAX_DEALBREAKERS, MAX_MUST_HAVES, MAX_PLACES, NOTE_MAX_CHARS, TAGS, dayNumber, stateName,
  type Availability, type Brief as SealedBrief, type DateRange, type Dealbreaker, type DestinationPublic, type Tag,
} from "@all-ayes/shared";
import { useCrew, useSendGuard, useTripSelector } from "../TripContext";
import { formatWindow } from "../format";
import { latestMemory, prefillFromMemory } from "../memory";
import { BrassDial } from "../components/BrassDial";
import { Pencil, SealedLetter } from "../components/icons";
import { Eyebrow, MarginNote, Page, StampButton } from "../components/ui";
import { VoiceNote } from "../components/VoiceNote";
import { AddPasskey } from "../components/AddPasskey";
import { DaysCalendar } from "../components/Calendar";

/** Where the dial starts for a member with no terms on file and nothing remembered. */
const DEFAULT_CAP_CENTS = 90_000;
/** Every date window the voyage offers can be ticked. */
const ANY_NUMBER = Number.POSITIVE_INFINITY;

/**
 * O2-021: the terms being drafted on this phone — seeded from the sealed brief (also when its replay arrives after
 * mount, once) or pencilled in from memory (once, TR1-013), until the member changes them.
 */
function useBriefDraft(existing: SealedBrief | null, memory: string[], firstWindow: string | undefined) {
  const [cap, setCap] = useState(existing?.capCents ?? DEFAULT_CAP_CENTS);
  const [dates, setDates] = useState<string[]>(existing?.dateWindowIds ?? (firstWindow ? [firstWindow] : []));
  // a date-range voyage: the days I can go, or any of them (private, like the rest)
  const [anyDay, setAnyDay] = useState(Boolean(existing?.availability?.any));
  const [days, setDays] = useState<string[]>(existing?.availability?.days ?? []);
  const [must, setMust] = useState<Tag[]>(existing?.mustHaves ?? []);
  const [wont, setWont] = useState<Dealbreaker[]>(existing?.dealbreakers ?? []);
  const [note, setNote] = useState(existing?.note ?? "");
  const [loves, setLoves] = useState<string[]>(existing?.loves ?? []);
  const [skips, setSkips] = useState<string[]>(existing?.skips ?? []);
  const [noteSource, setNoteSource] = useState<"typed" | "voice">(existing?.noteSource ?? "typed");
  const lastTranscript = useRef<string | null>(existing?.noteSource === "voice" ? existing.note ?? null : null);
  // TR1-013: values pencilled in from memory, until the member changes them
  const [pencilled, setPencilled] = useState<Set<string>>(new Set());
  const unpencil = (k: string) => setPencilled((p) => (p.has(k) ? new Set([...p].filter((x) => x !== k)) : p));

  // Replay of a previously sealed brief arrives after mount: adopt it once.
  const [adopted, setAdopted] = useState(!!existing);
  useEffect(() => {
    if (adopted || !existing) return;
    setCap(existing.capCents); setDates(existing.dateWindowIds); setMust(existing.mustHaves);
    setAnyDay(Boolean(existing.availability?.any)); setDays(existing.availability?.days ?? []);
    setWont(existing.dealbreakers); setNote(existing.note ?? ""); setNoteSource(existing.noteSource ?? "typed");
    setLoves(existing.loves ?? []); setSkips(existing.skips ?? []);
    lastTranscript.current = existing.noteSource === "voice" ? existing.note ?? null : null;
    setPencilled(new Set()); setAdopted(true);
  }, [existing, adopted]);

  // No terms on file yet, but a remembered voyage: pencil in its budget band and what they liked, once,
  // unless they've already started choosing.
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || adopted || existing || !memory.length) return;
    setPrefilled(true);
    const p = prefillFromMemory(memory);
    if (!p) return;
    const marks = new Set<string>();
    if (p.capCents !== undefined && cap === DEFAULT_CAP_CENTS) { setCap(p.capCents); marks.add("cap"); }
    if (p.mustHaves.length && !must.length) { setMust(p.mustHaves); p.mustHaves.forEach((t) => marks.add(t)); }
    setPencilled(marks);
  }, [memory, existing, prefilled, adopted]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    cap, dates, must, wont, note, noteSource, pencilled, loves, skips, anyDay, days, setAnyDay, setDays,
    /** What goes in the sealed terms on a date-range voyage (null: nothing marked yet). */
    availability: (): Availability | null => (anyDay ? { any: true } : days.length ? { days } : null),
    /** A place is loved or skipped, never both. */
    setLoves: (v: string[], touched: string) => { setLoves(v); setSkips((s) => s.filter((x) => x !== touched)); },
    setSkips: (v: string[], touched: string) => { setSkips(v); setLoves((l) => l.filter((x) => x !== touched)); },
    setCap: (v: number) => { setCap(v); unpencil("cap"); },
    setDates,
    setMust: (v: Tag[], touched: Tag) => { setMust(v); unpencil(touched); },
    setWont,
    /** TR1-016: once the words differ from what was dictated (or are cleared), the note is typed. */
    typeNote: (v: string) => { setNote(v); setNoteSource(v && v === lastTranscript.current ? "voice" : "typed"); },
    dictate: (t: string) => { const v = t.slice(0, NOTE_MAX_CHARS); lastTranscript.current = v; setNote(v); setNoteSource("voice"); },
  };
}

/** O2-021: one group of paper-tag chips (dates, must-haves, won't-dos): up to `max` picked, the rest disabled. */
function ChipGroup<T extends string>({ options, value, max, disabled, onChange, marks }: {
  options: { id: T; label: string }[]; value: T[]; max: number; disabled: boolean;
  onChange: (next: T[], touched: T) => void; marks?: Set<string>;
}) {
  const toggle = (v: T) => onChange(value.includes(v) ? value.filter((x) => x !== v) : value.length >= max ? value : [...value, v], v);
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          key={o.id} type="button" className="chip" aria-pressed={value.includes(o.id)}
          disabled={disabled || (!value.includes(o.id) && value.length >= max)} onClick={() => toggle(o.id)}
        >
          {o.label}
          {marks?.has(o.id) ? <span className="pencil" aria-label="pencilled in from your last voyage"><Pencil size={12} /></span> : null}
        </button>
      ))}
    </div>
  );
}

/** The longest run of consecutive marked days. */
function longestRun(days: string[]): number {
  const ns = days.map((d) => dayNumber(d)).filter((n): n is number => n !== null).sort((a, b) => a - b);
  let best = 0, run = 0;
  ns.forEach((n, i) => { run = i && n === ns[i - 1] + 1 ? run + 1 : 1; best = Math.max(best, run); });
  return best;
}

/**
 * "When can you go?" (a date-range voyage): a calendar limited to the organizer's range; tap or drag to mark days,
 * or "Any of these dates". Only the member's own mate sees it; the crew only ever hears which trips suit everyone
 * (or most of the crew).
 */
function WhenCanYouGo({ range, anyDay, days, disabled, onAny, onDays }: {
  range: DateRange; anyDay: boolean; days: string[]; disabled: boolean; onAny: (v: boolean) => void; onDays: (d: string[]) => void;
}) {
  const shortest = range.minNights + 1;
  const run = longestRun(days);
  return (
    <section aria-label="Dates">
      <h2 className="h2 mt-l">When can you go?</h2>
      <p className="small">
        {formatWindow(range.start, range.end, { year: true })} · trips of {range.minNights === range.maxNights ? range.minNights : `${range.minNights}–${range.maxNights}`} nights.
        {" "}Tap or drag across the days you're free.
      </p>
      <div className="chips">
        <button type="button" className="chip" aria-pressed={anyDay} disabled={disabled} onClick={() => onAny(!anyDay)}>Any of these dates</button>
      </div>
      {anyDay ? <p className="small mt-s">Every day in the range works for you.</p> : (
        <>
          <DaysCalendar min={range.start} max={range.end} days={days} onChange={onDays} disabled={disabled} />
          <p className="cal-summary" aria-live="polite">
            {days.length ? `${days.length} day${days.length === 1 ? "" : "s"} marked` : "No days marked yet"}
          </p>
          {days.length && run < shortest ? (
            <p className="small">The shortest trip is {range.minNights} night{range.minNights === 1 ? "" : "s"}: mark {shortest} days in a row if you can.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** How many ports the places lists offer at once (a region / anywhere scope can hold dozens: search narrows them). */
const PLACE_PORTS_SHOWN = 12;

/**
 * "Places I'd love" / "Places I'd skip" (optional, private like the rest): the voyage's ports, and for a region /
 * anywhere voyage its regions and states too. Up to MAX_PLACES each; a place is on one list at most.
 */
function Places({ destination, loves, skips, disabled, onLoves, onSkips }: {
  destination: DestinationPublic; loves: string[]; skips: string[]; disabled: boolean;
  onLoves: (v: string[], touched: string) => void; onSkips: (v: string[], touched: string) => void;
}) {
  const [q, setQ] = useState("");
  const scope = destination.scope;
  const named = destination.kind === "cities";
  const areas = named ? [] : [
    ...new Set(scope.flatMap((c) => (c.region ? [c.region] : []))),
    ...(destination.states ?? []),
  ].map((id) => ({ id, label: id.length === 2 ? stateName(id) : id }));
  const f = q.trim().toLowerCase();
  const chosen = new Set([...loves, ...skips]);
  // named ports: all of them; a wide scope: the ones already chosen, then the first matches of the search
  const shown = named ? scope : [
    ...scope.filter((c) => chosen.has(c.cityId)),
    ...scope.filter((c) => !chosen.has(c.cityId) && (!f || c.name.toLowerCase().includes(f))).slice(0, PLACE_PORTS_SHOWN),
  ];
  const ports = shown.map((c) => ({ id: c.cityId, label: c.name }));
  const options = [...areas, ...ports];
  return (
    <section aria-label="Places">
      <h2 className="h2 mt-l">Places <span className="small">(optional, up to {MAX_PLACES} each)</span></h2>
      {!named ? (
        <label className="field"><span>Find a port</span>
          <input className="input" type="search" value={q} disabled={disabled} placeholder="Name a port" onChange={(e) => setQ(e.target.value)} />
        </label>
      ) : null}
      <p className="small">I'd love</p>
      <ChipGroup options={options} value={loves} max={MAX_PLACES} disabled={disabled} onChange={onLoves} />
      <p className="small">I'd skip</p>
      <ChipGroup options={options} value={skips} max={MAX_PLACES} disabled={disabled} onChange={onSkips} />
    </section>
  );
}

/** P4 — Sealed Terms. Private: only the member's own mate ever sees this. */
export default function Brief() {
  // O2-046: my terms, my memory and the phase; the table, the votes and the crew's seals don't redraw this screen
  const { isOrganizer, session, me } = useCrew();
  const navigate = useNavigate();
  const status = useTripSelector((s) => s.trip!.status);
  const joinCode = useTripSelector((s) => s.trip!.joinCode);
  // R2-WP-14: dateWindows is a static field (the store keeps it from the join's full snapshot)
  const dateWindows = useTripSelector((s) => s.trip!.dateWindows);
  const dateRange = useTripSelector((s) => s.trip!.dateRange);
  const existing = useTripSelector((s) => s.brief);
  const memory = useTripSelector((s) => s.memory);
  const d = useBriefDraft(existing, memory, dateWindows[0]?.id);

  // One seal per tap; the payload is the sealedAt on file when we pressed Seal — we move on once the server
  // echoes a newer one. A refusal of this seal re-opens the button (OPT-027: the shared guard, not a copy of it).
  const [submitted, markSubmitted, { payload: sentPrev }] = useSendGuard<"brief:submit", string | null>("brief:submit");
  const [problem, setProblem] = useState<string | null>(null);

  // After sealing, move on once the server confirms.
  const sealedAt = existing?.sealedAt ?? null;
  useEffect(() => {
    // Resealing (or adjusting after a void) starts already-sealed, so wait for the server's echo, not the flag.
    if (submitted && me?.briefSealed && sealedAt && sealedAt !== sentPrev) {
      navigate(`/t/${joinCode}/${isOrganizer ? "muster" : "wait"}`, { replace: true });
    }
  }, [submitted, me?.briefSealed, sealedAt, sentPrev, isOrganizer, navigate, joinCode]);

  const seal = () => {
    const availability = dateRange ? d.availability() : null;
    if (dateRange && !availability) { setProblem("Mark the days you can go, or pick \"Any of these dates\"."); return; }
    if (!dateRange && !d.dates.length) { setProblem("Pick at least one set of dates you can travel."); return; }
    setProblem(null);
    const text = d.note.trim();
    markSubmitted({
      capCents: d.cap, dateWindowIds: dateRange ? [] : d.dates, ...(availability ? { availability } : {}), mustHaves: d.must, dealbreakers: d.wont,
      note: text || undefined, noteSource: text ? d.noteSource : "typed",
      ...(d.loves.length ? { loves: d.loves } : {}), ...(d.skips.length ? { skips: d.skips } : {}),
    }, sealedAt);
  };

  // L4-002 (R2-WP-10): after a void only the organizer's new terms reopen the briefing; everyone else reads.
  const locked = status === "VOIDED" ? !isOrganizer : status !== "BRIEFING";
  const windows = dateWindows.map((w) => ({ id: w.id, label: `${w.label ? `${w.label} · ` : ""}${formatWindow(w.start, w.end)}` }));
  const destination = useTripSelector((s) => s.trip!.destination);

  return (
    <Page>
      <Eyebrow icon={<SealedLetter size={18} />}>Your sealed terms</Eyebrow>
      <h1 className="h1">Only your mate sees this.</h1>
      <p className="small">Not your friends. Not the Captain.</p>

      {memory.length ? (
        <div className="banner" role="note">
          <SealedLetter size={18} /> Remembered from your last voyage: {latestMemory(memory)}
          {d.pencilled.size ? <span className="small"> Pencilled in below; change anything.</span> : null}
        </div>
      ) : null}

      <section aria-label="Budget">
        <h2 className="h2 mt-m">All‑in, I can do</h2>
        <BrassDial value={d.cap} disabled={locked} onChange={d.setCap} />
        {d.pencilled.has("cap") ? <p className="small"><span className="pencil"><Pencil size={14} /></span> Pencilled in from your last voyage's budget.</p> : null}
      </section>

      {dateRange ? (
        <WhenCanYouGo range={dateRange} anyDay={d.anyDay} days={d.days} disabled={locked} onAny={d.setAnyDay} onDays={d.setDays} />
      ) : (
        <section aria-label="Dates">
          <h2 className="h2 mt-l">I can travel</h2>
          <ChipGroup options={windows} value={d.dates} max={ANY_NUMBER} disabled={locked} onChange={d.setDates} />
        </section>
      )}

      <section aria-label="Must have">
        <h2 className="h2 mt-l">Must have <span className="small">(up to {MAX_MUST_HAVES})</span></h2>
        <ChipGroup options={TAGS} value={d.must} max={MAX_MUST_HAVES} disabled={locked} onChange={d.setMust} marks={d.pencilled} />
      </section>

      <section aria-label="Won't do">
        <h2 className="h2 mt-l">Won't do <span className="small">(up to {MAX_DEALBREAKERS})</span></h2>
        <ChipGroup options={DEALBREAKERS} value={d.wont} max={MAX_DEALBREAKERS} disabled={locked} onChange={d.setWont} />
      </section>

      {destination && destination.scope.length ? (
        <Places destination={destination} loves={d.loves} skips={d.skips} disabled={locked} onLoves={d.setLoves} onSkips={d.setSkips} />
      ) : null}

      <label className="field mt-l">
        <span>Anything else?</span>
        <textarea
          className="input" maxLength={NOTE_MAX_CHARS} value={d.note} placeholder="e.g. I get tired walking hills" readOnly={locked}
          onChange={(e) => d.typeNote(e.target.value)}
        />
        <div className="hint mono">{d.note.length}/{NOTE_MAX_CHARS}</div>
      </label>
      {/* L1-007: a locked Brief is read-only — no edits that can't be sealed, and no speech-to-text spent on them */}
      <VoiceNote disabled={locked} onTranscript={d.dictate} />

      {problem ? <MarginNote>{problem}</MarginNote> : null}
      {locked ? (
        <p className="small">{status === "VOIDED" ? "Your terms stay as sealed. The organizer chooses what's next: back to the charts, or new terms." : "The table has already met; your terms are sealed for this voyage."}</p>
      ) : null}
      <StampButton onClick={seal} disabled={!!submitted || locked}>
        <SealedLetter size={20} /> {submitted ? "Sealing…" : me?.briefSealed ? "Reseal my terms" : "Seal my terms"}
      </StampButton>
      {/* R2-WP-01: optional, and never part of sealing; shown only on phones that can hold a passkey */}
      <AddPasskey tripId={session.tripId} memberToken={session.memberToken} />
    </Page>
  );
}
