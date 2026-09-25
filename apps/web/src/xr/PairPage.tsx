// `/xr` — type the 8-character headset code from the Organizer's phone (doc 03 §4 entry).
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../net/api";
import { saveHeadsetSession } from "../net/session";
import "./xr.css";

export default function PairPage() {
  const nav = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length < 8) return setErr("The headset code has eight characters.");
    setBusy(true);
    setErr("");
    try {
      const r = await api.pairHeadset(c);
      // TR2-010: its own key, so pairing in the organizer's browser never replaces their phone seat
      saveHeadsetSession({ tripId: r.tripId, joinCode: r.joinCode, deviceToken: r.deviceToken });
      nav(`/t/${r.joinCode}/xr`);
    } catch (e2) {
      setErr(e2 instanceof Error && e2.message ? e2.message : "That code didn't match. Ask the Organizer for a fresh one.");
      setBusy(false);
    }
  }

  return (
    <div className="cr-page">
      <div className="cr-overlay">
        <form className="cr-card" onSubmit={submit}>
          <h1>The chart room</h1>
          <p>Type the headset code shown on the Organizer's phone.</p>
          <input
            className="cr-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase())}
            autoFocus
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label="Headset code"
            placeholder="········"
          />
          {err && <p className="cr-error">{err}</p>}
          <button className="cr-btn primary" type="submit" disabled={busy}>{busy ? "Pairing…" : "Pair this headset"}</button>
          <p className="muted">This headset gets the Organizer's controls, but never anyone's sealed terms.</p>
        </form>
      </div>
    </div>
  );
}
