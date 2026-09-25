import type { ButtonHTMLAttributes, ReactNode } from "react";
import { BANDS, ORIGIN_COORDS, ORIGINS, SIGNAL_LOST, type Band, type Origin } from "@all-ayes/shared";
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

/** The four crew colour bands, in order. */
const BAND_IDS = [1, 2, 3, 4] as const satisfies readonly Band[];

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

export function OriginSelect({ value, onChange }: { value: Origin; onChange: (o: Origin) => void }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value as Origin)} aria-label="Flying from">
      {ORIGINS.map((o) => (
        <option key={o} value={o}>{ORIGIN_COORDS[o].name} ({o})</option>
      ))}
    </select>
  );
}

export function firstFreeBand(taken: Band[]): Band {
  return BAND_IDS.find((b) => !taken.includes(b)) ?? 1;
}
