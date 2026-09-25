import { useRef, useState } from "react";
import { CAP_MAX_CENTS, CAP_MIN_CENTS, CAP_STEP_CENTS } from "@all-ayes/shared";
import { Button } from "./ui";

// Brass dial for the all-in cap (doc 02 §8): 300° sweep, engraved tick every $50.
const SWEEP = 300;
const START = -150; // degrees from 12 o'clock
const STEPS = (CAP_MAX_CENTS - CAP_MIN_CENTS) / CAP_STEP_CENTS;

const clamp = (v: number) => Math.min(CAP_MAX_CENTS, Math.max(CAP_MIN_CENTS, v));
const snap = (v: number) => clamp(Math.round(v / CAP_STEP_CENTS) * CAP_STEP_CENTS);
const angleFor = (cents: number) => START + ((cents - CAP_MIN_CENTS) / (CAP_MAX_CENTS - CAP_MIN_CENTS)) * SWEEP;

function polar(r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: 110 + r * Math.cos(rad), y: 110 + r * Math.sin(rad) };
}

/** `disabled` (L1-007): read-only, e.g. a locked Brief — the needle shows the cap but nothing moves it. */
export function BrassDial({ value, onChange, disabled }: { value: number; onChange: (cents: number) => void; disabled?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  const set = (cents: number) => {
    if (disabled) return;
    const next = snap(cents);
    if (next !== value) {
      try { navigator.vibrate?.(5); } catch { /* not supported */ }
      onChange(next);
    }
  };

  const fromPointer = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90; // 0 at 12 o'clock
    if (deg > 180) deg -= 360;
    deg = Math.max(START, Math.min(START + SWEEP, deg));
    set(CAP_MIN_CENTS + ((deg - START) / SWEEP) * (CAP_MAX_CENTS - CAP_MIN_CENTS));
  };

  const ang = angleFor(value);
  const tip = polar(74, ang);
  const tail = polar(-16, ang);

  const ticks = Array.from({ length: STEPS + 1 }, (_, i) => {
    const cents = CAP_MIN_CENTS + i * CAP_STEP_CENTS;
    const major = cents % 50_000 === 0;
    const a = angleFor(cents);
    const p1 = polar(major ? 84 : 89, a);
    const p2 = polar(95, a);
    return { i, major, cents, p1, p2, a };
  });

  const dollars = Math.round(value / 100);

  return (
    <div>
      <div className="dial">
        <svg
          ref={svgRef} viewBox="0 0 220 220" role="slider" aria-label="All-in budget cap"
          aria-valuemin={CAP_MIN_CENTS / 100} aria-valuemax={CAP_MAX_CENTS / 100} aria-valuenow={dollars}
          aria-valuetext={`$${dollars}`} tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined}
          onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); fromPointer(e); }}
          onPointerMove={(e) => { if (e.buttons) fromPointer(e); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); set(value + CAP_STEP_CENTS); }
            if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); set(value - CAP_STEP_CENTS); }
          }}
        >
          <circle cx="110" cy="110" r="104" fill="var(--brass)" />
          <circle cx="110" cy="110" r="99" fill="none" stroke="var(--brass-dark)" strokeWidth="1" />
          <circle cx="110" cy="110" r="78" fill="var(--paper)" stroke="var(--brass-dark)" strokeWidth="2" />
          {ticks.map((t) => (
            <line key={t.i} x1={t.p1.x} y1={t.p1.y} x2={t.p2.x} y2={t.p2.y} stroke="var(--ink)" strokeWidth={t.major ? 1.6 : 0.8} />
          ))}
          {ticks.filter((t) => t.major).map((t) => {
            const p = polar(68, t.a);
            return (
              <text key={`l${t.i}`} x={p.x} y={p.y + 3} textAnchor="middle" fontSize="9" fontFamily="var(--f-mono)" fill="var(--ink-soft)">
                {t.cents / 100}
              </text>
            );
          })}
          <line x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y} stroke="var(--sounding-red)" strokeWidth="3" strokeLinecap="square" />
          <circle cx="110" cy="110" r="7" fill="var(--brass-dark)" />
          <circle cx="110" cy="110" r="2.5" fill="var(--brass)" />
        </svg>
      </div>
      <div className="dial-readout">
        {typing && !disabled ? (
          <input
            className="input num-lg" inputMode="numeric" autoFocus aria-label="Type your cap in dollars"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={() => { if (draft) set(Number(draft) * 100); setTyping(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        ) : (
          <button type="button" className="num-lg" disabled={disabled} onClick={() => { setDraft(String(dollars)); setTyping(true); }} aria-label={`Type an amount, now $${dollars}`}>
            $ {dollars.toLocaleString("en-US")}
          </button>
        )}
      </div>
      <div className="dial-steps">
        <Button small disabled={disabled} onClick={() => set(value - CAP_STEP_CENTS)} aria-label="Minus fifty dollars">−50</Button>
        <Button small disabled={disabled} onClick={() => set(value + CAP_STEP_CENTS)} aria-label="Plus fifty dollars">+50</Button>
      </div>
    </div>
  );
}
