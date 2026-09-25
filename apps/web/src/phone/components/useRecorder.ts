import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../net/api";
import { actionError } from "../errors";

/**
 * OPT-014: the one microphone lifecycle for the hail dock and the Brief's voice note.
 * Handles the permission race (released before the mic opened), the max length, and always releases the mic
 * on stop and on unmount (a take cut short by leaving the screen is dropped, never sent).
 */
export function useRecorder({ maxMs, onBlob }: { maxMs: number; onBlob: (blob: Blob) => void }) {
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const holding = useRef(false);   // hold-to-talk: the finger is still down
  const starting = useRef(false);  // waiting on the mic permission / getUserMedia
  const unmounted = useRef(false);
  const onBlobRef = useRef(onBlob);
  onBlobRef.current = onBlob;

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      holding.current = false;
      if (timer.current) window.clearTimeout(timer.current);
      if (rec.current && rec.current.state !== "inactive") rec.current.stop();
      rec.current = null;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, []);

  const supported = typeof window !== "undefined" && "MediaRecorder" in window && !!navigator.mediaDevices?.getUserMedia;

  function stop() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
    rec.current = null;
    setRecording(false);
  }

  /**
   * Opens the mic and starts a take. With `hold`, the take only starts if the finger is still down when the mic
   * opens (`release()` lifts it). Resolves to what happened so the UI can say so.
   */
  async function start(opts: { hold?: boolean } = {}): Promise<"started" | "released" | "no-mic" | "busy"> {
    if (!supported || starting.current || rec.current) return "busy";
    holding.current = !!opts.hold;
    starting.current = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      starting.current = false;
      if (unmounted.current || (opts.hold && !holding.current)) {
        s.getTracks().forEach((t) => t.stop());
        return "released";
      }
      stream.current = s;
      const mr = new MediaRecorder(s);
      chunks.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      mr.onstop = () => {
        s.getTracks().forEach((t) => t.stop());
        if (stream.current === s) stream.current = null;
        if (unmounted.current || !chunks.current.length) return;
        onBlobRef.current(new Blob(chunks.current, { type: chunks.current[0]?.type || "audio/webm" }));
      };
      mr.start();
      rec.current = mr;
      setRecording(true);
      timer.current = window.setTimeout(stop, maxMs);
      return "started";
    } catch {
      starting.current = false;
      return "no-mic";
    }
  }

  /** Hold-to-talk: the finger came up. */
  function release() {
    holding.current = false;
    stop();
  }

  return { supported, recording, start, stop, release, isHolding: () => holding.current };
}

/**
 * Speech-to-text for a recorded take; errors carry the server's own reason (e.g. NO_STT). L1-005: `kind` sets how
 * much of the transcript the server keeps (a note 200 characters, a hail 160).
 */
export async function transcribe(tripId: string, token: string, blob: Blob, kind: "hail" | "note" = "hail"): Promise<string> {
  const { transcript } = await api.hailAudio(tripId, token, blob, kind);
  const t = transcript.trim();
  if (!t) throw new Error("empty");
  return t;
}

/** The reason to show when a take couldn't be turned into words (O2-009: phone copy, so NO_STT reads as ours). */
export function transcribeError(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.code === "NO_STT") markVoiceOff();
  return actionError(e, fallback);
}

// ---------- TR1-005: is speech-to-text on at all? (asked once per page) ----------
let voiceOn: boolean | null = null;
let asking: Promise<boolean> | null = null;
const voiceListeners = new Set<(on: boolean) => void>();

function markVoiceOff() {
  voiceOn = false;
  for (const l of voiceListeners) l(false);
}

/** False until /api/health says the server can turn speech into text (ElevenLabs), so voice controls stay hidden. */
export function useVoiceAvailable(): boolean {
  const [on, setOn] = useState<boolean>(voiceOn ?? false);
  useEffect(() => {
    voiceListeners.add(setOn);
    if (voiceOn === null) {
      asking ??= api.health().then((h) => h.eleven === true).catch(() => false);
      void asking.then((v) => { if (voiceOn === null) voiceOn = v; for (const l of voiceListeners) l(voiceOn); });
    } else setOn(voiceOn);
    return () => { voiceListeners.delete(setOn); };
  }, []);
  return on;
}
