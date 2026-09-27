import { useState } from "react";
import "../../styles/phone.css";

/** A 4–6 digit PIN keypad (big keys: it also runs in Quest Browser). */
export function PinPad({ label, busy, onDone }: { label: string; busy?: boolean; onDone: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  const key = (k: string) => setPin((p) => (k === "⌫" ? p.slice(0, -1) : p.length >= 6 ? p : p + k));
  return (
    <div className="stack" aria-label={label}>
      <p className="body center">{label}</p>
      <div className="pin-dots" aria-live="polite">{"•".repeat(pin.length) || " "}</div>
      <div className="pin-pad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0"].map((k) => (
          <button key={k} type="button" className="btn" aria-label={k === "⌫" ? "Delete" : k} onClick={() => key(k)}>{k}</button>
        ))}
        <button type="button" className="btn stamp" disabled={busy || pin.length < 4} onClick={() => { onDone(pin); setPin(""); }}>OK</button>
      </div>
    </div>
  );
}

