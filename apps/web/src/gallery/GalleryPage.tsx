// `/t/:code/gallery` — read-only view of the table for judges and video capture.
// Keys: Space pause orbit · 1 overhead · 2 Organizer's view · 3 follow the speaker · C captions.
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { MAX_WATCHES, PALETTE, SIGNAL_LOST, type TripStatus } from "@all-ayes/shared";
import { TripStore, useTripStore } from "../net/tripStore";
import { preloadFonts } from "../scene/text";
import { sound } from "../scene/audio";
import { GalleryApp } from "./GalleryApp";
import { AUDIO_UNLOCK_WAIT_MS } from "../phone/timing";
import "../xr/xr.css";

const STATUS_LABEL: Record<TripStatus, string> = {
  BRIEFING: "Mustering", AT_TABLE: "At the table", DRY_RUN: "Dry run",
  SEALING: "Setting seals", BOOKED: "Logged", VOIDED: "Voided",
};

export default function GalleryPage() {
  const { code = "" } = useParams();
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<GalleryApp | null>(null);
  const [store, setStore] = useState<TripStore | null>(null);
  const [started, setStarted] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [line, setLine] = useState<{ who: string; text: string; color: string }>({ who: "", text: "", color: PALETTE.ink });

  useEffect(() => {
    if (!hostRef.current) return;
    const s = new TripStore({ joinCode: code.toUpperCase(), surface: "gallery" });
    const app = new GalleryApp(hostRef.current, s);
    app.stage.director.onCaption = (who, text, color) => setLine({ who, text, color });
    appRef.current = app;
    if (import.meta.env.DEV) (window as unknown as { __aa: unknown }).__aa = { store: s, app };
    setStore(s);
    return () => { app.dispose(); s.close(); appRef.current = null; };
  }, [code]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const app = appRef.current;
      if (!app) return;
      // L2-004: Cmd/Ctrl+C copies a caption and Cmd/Ctrl+1–3 switch tabs; they (and key repeat) never drive the Gallery
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.code === "Space") { e.preventDefault(); app.toggleOrbit(); }
      if (e.key === "1") app.setPreset("overhead");
      if (e.key === "2") app.setPreset("organizer");
      if (e.key === "3") app.setPreset("speaker");
      if (e.key === "0") app.setPreset(null);
      if (e.key.toLowerCase() === "c") setCaptions((c) => !c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fonts load while the card is up; the seat never waits on them (or on a stubborn AudioContext).
  useEffect(() => { void preloadFonts().catch(() => undefined); }, []);

  async function start() {
    try {
      await Promise.race([sound.unlock(), new Promise((r) => setTimeout(r, AUDIO_UNLOCK_WAIT_MS))]);
    } catch { /* captions still work without sound */ } finally {
      setStarted(true);
    }
  }

  return (
    <div className="cr-page">
      <div className="cr-canvas" ref={hostRef} />
      {store && <Corner store={store} />}
      {captions && line.text && (
        <div className="cr-strip" aria-live="polite">
          <div className="who" style={{ color: line.color }}>{line.who}</div>
          <div className="line">{line.text}</div>
        </div>
      )}
      {!started && (
        <div className="cr-overlay" style={{ background: "rgba(20,16,12,0.35)" }}>
          <div className="cr-card">
            <h1>The Gallery</h1>
            <p>A seat by the chart table for everyone without the headset.</p>
            <p className="muted">Space pauses the orbit · 1 overhead · 2 Organizer's view · 3 follow the speaker · C captions</p>
            <button className="cr-btn primary" onClick={start}>Take a seat (with sound)</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Corner({ store }: { store: TripStore }) {
  const s = useTripStore(store);
  // L2-003: a refused join (a mistyped link, a voyage that's gone) says so instead of "Finding the voyage…" forever
  if (!s.trip && s.error?.event === "trip:join") {
    return <div className="cr-corner">{s.error.message} <span style={{ opacity: 0.7 }}>Check the voyage code in the link.</span></div>;
  }
  if (!s.trip) return <div className="cr-corner">{s.connected ? "Finding the voyage…" : SIGNAL_LOST}</div>;
  const watch = s.trip.negotiation.watch;
  return (
    <div className="cr-corner">
      {s.trip.name} · {STATUS_LABEL[s.trip.status]}
      {s.trip.status === "AT_TABLE" && watch > 0 && <> · Watch <span className="mono">{Math.min(MAX_WATCHES, watch)}/{MAX_WATCHES}</span></>}
      {!s.connected && <> · <span style={{ color: PALETTE.soundingRed }}>reconnecting</span></>}
    </div>
  );
}
