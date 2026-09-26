import { useId, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { BANDS, BAND_IDS, ORIGIN_COORDS, SIGNAL_LOST, searchAirports, type Band, type Origin } from "@all-ayes/shared";
import { Dividers } from "./icons";
import "../../styles/phone.css";

export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="log-page">
      <main className="log-column">{children}</main>
    </div>
  );
}

export function Eyebrow({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return <div className="eyebrow">{icon}{children}</div>;
}

export function Card({ children, className = "", label }: { children: ReactNode; className?: string; label?: string }) {
  return <section className={`card ${className}`} aria-label={label}>{children}</section>;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { block?: boolean; small?: boolean };

/** The single primary action per screen: a red wax stamp. */
export function StampButton({ block = true, small, className = "", ...rest }: BtnProps) {
  return <button type="button" className={`btn stamp ${block ? "block" : ""} ${small ? "small" : ""} ${className}`} {...rest} />;
}

export function Button({ block, small, className = "", ...rest }: BtnProps) {
  return <button type="button" className={`btn ${block ? "block" : ""} ${small ? "small" : ""} ${className}`} {...rest} />;
}

export function LinkButton({ className = "", red, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { red?: boolean }) {
  return <button type="button" className={`link ${red ? "red" : ""} ${className}`} {...rest} />;
}

export function MarginNote({ children, onClear }: { children: ReactNode; onClear?: () => void }) {
  return (
    <div className="margin-note" role="alert">
      <span>{children}</span>
      {onClear ? <button type="button" className="link red" onClick={onClear}>Dismiss</button> : null}
    </div>
  );
}

/** O2-016: a failed action's copy, under the control that caused it (one look for every inline error). */
export function InlineError({ children }: { children: ReactNode }) {
  return <p className="small red" role="alert">{children}</p>;
}

export function Plotting({ label = "Plotting…" }: { label?: string }) {
  return (
    <div className="plotting" role="status">
      <span className="walker"><Dividers /></span>
      <span>{label}</span>
    </div>
  );
}

export function SignalStrip() {
  return <div className="signal-strip" role="status">{SIGNAL_LOST}</div>;
}

export function BandSwatches({ value, onChange, taken = [], label = "Your color band" }: { value: Band; onChange: (b: Band) => void; taken?: Band[]; label?: string }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {BAND_IDS.map((b) => (
        <button
          key={b} type="button" role="radio" aria-checked={value === b} aria-label={`${BANDS[b].name} band`}
          className="swatch" style={{ background: BANDS[b].hex }} disabled={taken.includes(b) && value !== b}
          onClick={() => onChange(b)}
        >
          <span className="swatch-name">{BANDS[b].name}</span>
        </button>
      ))}
    </div>
  );
}

/** How many matches the home-airport picker lists at once. */
const ORIGIN_MATCHES = 8;
const originLabel = (o: Origin) => (ORIGIN_COORDS[o] ? `${ORIGIN_COORDS[o].name} (${o})` : o);

/**
 * The home airport, searchable (type a code or a city: "sea", "Seattle", "YYZ"). A combobox: arrow keys move through
 * the matches, Enter picks, Escape puts the current airport back.
 */
export function OriginSelect({ value, onChange }: { value: Origin; onChange: (o: Origin) => void }) {
  const [q, setQ] = useState<string | null>(null); // null = not searching: show the chosen airport
  const [active, setActive] = useState(0);
  const listId = useId();
  const matches = q === null ? [] : searchAirports(q).slice(0, ORIGIN_MATCHES);
  const choose = (code: string) => { onChange(code); setQ(null); setActive(0); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setQ(null); return; }
    if (!matches.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % matches.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i <= 0 ? matches.length - 1 : i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(matches[Math.min(active, matches.length - 1)].code); }
  };
  return (
    <div className="origin-picker">
      <input
        className="input" type="text" aria-label="Flying from" role="combobox" aria-autocomplete="list"
        aria-expanded={matches.length > 0} aria-controls={listId} autoComplete="off" spellCheck={false}
        aria-activedescendant={matches.length ? `${listId}-${active}` : undefined}
        placeholder="Type a city or airport code"
        value={q ?? originLabel(value)}
        onFocus={(e) => { setQ(""); e.currentTarget.select(); }}
        onChange={(e) => { setQ(e.target.value); setActive(0); }}
        onBlur={() => setTimeout(() => setQ(null), 150)}
        onKeyDown={onKey}
      />
      {matches.length ? (
        <ul className="origin-results" id={listId} role="listbox" aria-label="Home airports">
          {matches.map((a, i) => (
            <li key={a.code} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
              <button type="button" className={`city-row${i === active ? " active" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(a.code)}>
                <span className="city-name">{a.city}</span> <span className="mono small">{a.code}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function firstFreeBand(taken: Band[]): Band {
  return BAND_IDS.find((b) => !taken.includes(b)) ?? 1;
}
