/**
 * The Chart Room calendar (docs/02 §8, docs/03 P1/P4): a small month grid, no date library. Two uses:
 *
 *   RangeCalendar  the organizer's earliest departure → latest return (tap a start, then an end)
 *   DaysCalendar   a member's "When can you go?": tap or drag across days to mark them (drag paints on or off,
 *                  following the first day touched); limited to the organizer's range
 *
 * Days are ISO strings (`YYYY-MM-DD`), read as UTC days (packages/shared/src/dates.ts), so no time zone moves one.
 * Every day is a real button (keyboard: Tab + Enter/Space toggles), labelled "Fri, Mar 12".
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { dayLabel, dayNumber, fromDayNumber } from "@all-ayes/shared";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** "2027-03" for a day. */
const monthOf = (iso: string) => iso.slice(0, 7);
const shiftMonth = (ym: string, n: number) => {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
/** The month's days as a Sunday-first grid (null = a blank before the 1st). */
function monthCells(ym: string): (string | null)[] {
  const first = dayNumber(`${ym}-01`)!;
  const lead = ((first + 4) % 7 + 7) % 7; // 1970-01-01 was a Thursday
  const len = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
  return [...Array.from({ length: lead }, () => null), ...Array.from({ length: len }, (_, i) => fromDayNumber(first + i))];
}
export const monthTitle = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

type Mark = "none" | "on" | "start" | "end" | "single" | "between";

interface GridProps {
  /** Selectable days (inclusive). */
  min: string; max: string;
  /** The month shown first. */
  initial: string;
  mark: (day: string) => Mark;
  label: string;
  /** Tap / Enter / Space on a day. */
  onPick?: (day: string) => void;
  /** Drag painting (DaysCalendar): a pointer went down on a day / moved onto one. */
  onPaintStart?: (day: string) => void;
  onPaintMove?: (day: string) => void;
  paintable?: boolean;
  /** Read-only (a sealed Brief after the table met): months still page, days don't toggle. */
  locked?: boolean;
}

/** One month at a time, with ‹ › to the months that hold selectable days. */
function MonthGrid({ min, max, initial, mark, label, onPick, onPaintStart, onPaintMove, paintable, locked }: GridProps) {
  const [ym, setYm] = useState(() => monthOf(initial < min ? min : initial > max ? max : initial));
  const painting = useRef(false);
  useEffect(() => {
    // the range moved (the organizer's range isn't known on first paint of the Brief): keep the month in bounds
    if (ym < monthOf(min)) setYm(monthOf(min));
    else if (ym > monthOf(max)) setYm(monthOf(max));
  }, [min, max]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!paintable) return;
    const stop = () => { painting.current = false; };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => { window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
  }, [paintable]);

  const inRange = (d: string) => d >= min && d <= max;
  const dayAt = (e: ReactPointerEvent) => {
    const el = typeof document.elementFromPoint === "function" ? document.elementFromPoint(e.clientX, e.clientY) : null;
    const d = (el as HTMLElement | null)?.closest?.("[data-day]")?.getAttribute("data-day");
    return d && inRange(d) ? d : null;
  };
  const title = monthTitle(ym);
  return (
    <div className="cal" role="group" aria-label={label}>
      <div className="cal-head">
        <button type="button" className="cal-nav" aria-label="Previous month" disabled={ym <= monthOf(min)} onClick={() => setYm(shiftMonth(ym, -1))}>‹</button>
        <div className="cal-title" aria-live="polite">{title}</div>
        <button type="button" className="cal-nav" aria-label="Next month" disabled={ym >= monthOf(max)} onClick={() => setYm(shiftMonth(ym, 1))}>›</button>
      </div>
      <div className="cal-week" aria-hidden="true">{WEEKDAYS.map((w, i) => <span key={i}>{w}</span>)}</div>
      <div
        className={`cal-grid${paintable ? " paint" : ""}`}
        onPointerMove={paintable ? (e) => { if (!painting.current) return; const d = dayAt(e); if (d) onPaintMove?.(d); } : undefined}
      >
        {monthCells(ym).map((d, i) => {
          if (!d) return <span key={`b${i}`} className="cal-blank" />;
          const m = mark(d);
          const ok = inRange(d);
          return (
            <button
              key={d} type="button" data-day={d} className={`cal-day m-${m}`} disabled={!ok || locked}
              aria-pressed={m !== "none"} aria-label={dayLabel(d)}
              onPointerDown={paintable && ok ? (e) => {
                if (e.button !== 0) return;
                painting.current = true;
                onPaintStart?.(d);
              } : undefined}
              onPointerEnter={paintable && ok ? () => { if (painting.current) onPaintMove?.(d); } : undefined}
              // a pointer's tap was handled on pointerdown (paintable); a keyboard press has detail 0
              onClick={(e) => { if (!ok) return; if (paintable && e.detail !== 0) return; onPick?.(d); }}
            >
              {Number(d.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The organizer's range: tap the earliest departure, then the latest return (a tap before the start moves it). */
export function RangeCalendar({ min, max, start, end, onChange }: {
  min: string; max: string; start: string | null; end: string | null; onChange: (start: string | null, end: string | null) => void;
}) {
  const pick = (d: string) => {
    if (!start || end) return onChange(d, null);
    if (d < start) return onChange(d, null);
    onChange(start, d);
  };
  const mark = (d: string): Mark => {
    if (!start) return "none";
    if (!end) return d === start ? "single" : "none";
    if (d === start && d === end) return "single";
    if (d === start) return "start";
    if (d === end) return "end";
    return d > start && d < end ? "between" : "none";
  };
  return <MonthGrid min={min} max={max} initial={start ?? min} mark={mark} onPick={pick} label="Trip dates" />;
}

/**
 * A member's free days inside `min`..`max`: tap a day to mark it, or drag across days — the drag marks (or clears,
 * if the first day was marked) every day it passes.
 */
export function DaysCalendar({ min, max, days, onChange, disabled }: {
  min: string; max: string; days: string[]; onChange: (days: string[]) => void; disabled?: boolean;
}) {
  const set = new Set(days);
  const paint = useRef<{ on: boolean; days: Set<string> } | null>(null);
  const apply = (d: string, on: boolean, base: Set<string>) => {
    const next = new Set(base);
    if (on) next.add(d); else next.delete(d);
    return next;
  };
  const emit = (s: Set<string>) => onChange([...s].sort());
  const mark = (d: string): Mark => (set.has(d) ? "on" : "none");
  if (disabled) return <MonthGrid min={min} max={max} initial={days[0] ?? min} mark={mark} label="Days I can go" locked />;
  return (
    <MonthGrid
      min={min} max={max} initial={days[0] ?? min} mark={mark} label="Days I can go" paintable
      onPick={(d) => emit(apply(d, !set.has(d), set))}
      onPaintStart={(d) => {
        const on = !set.has(d);
        const next = apply(d, on, set);
        paint.current = { on, days: next };
        emit(next);
      }}
      onPaintMove={(d) => {
        const p = paint.current;
        if (!p || p.days.has(d) === p.on) return;
        p.days = apply(d, p.on, p.days);
        emit(p.days);
      }}
    />
  );
}
