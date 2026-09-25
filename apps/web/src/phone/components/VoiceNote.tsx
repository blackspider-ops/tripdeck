import { useEffect, useRef, useState } from "react";
import { useCrew } from "../TripContext";
import { NOTE_MAX_MS } from "../timing";
import { SpeakingTrumpet } from "./icons";
import { transcribe, transcribeError, useRecorder, useVoiceAvailable } from "./useRecorder";

/**
 * B4 — say your note instead of typing it (≤ 20 s). The transcript lands in the note field so the
 * member can read and fix it before sealing. Hidden when the device can't record or the server can't transcribe.
 */
export function VoiceNote({ onTranscript, disabled }: {
  onTranscript: (t: string) => void;
  /** L1-007: a locked Brief — no voice control, and a take in progress is dropped, never sent to speech-to-text. */
  disabled?: boolean;
}) {
  const { session } = useCrew();
  const { tripId, memberToken: token } = session;
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const voiceOn = useVoiceAvailable();
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const recorder = useRecorder({
    maxMs: NOTE_MAX_MS,
    onBlob: async (blob) => {
      if (disabledRef.current) return; // locked mid-take: don't spend the voyage's STT budget
      setSending(true);
      try {
        onTranscript(await transcribe(tripId, token!, blob, "note")); // L1-005: up to NOTE_MAX_CHARS, not the hail's 160
        setNote("Check the words above before you seal.");
      } catch (e) {
        setNote(transcribeError(e, "Couldn't hear that — type it instead."));
      } finally {
        setSending(false);
      }
    },
  });

  useEffect(() => {
    if (disabled && recorder.recording) recorder.stop();
  }, [disabled, recorder.recording]); // eslint-disable-line react-hooks/exhaustive-deps

  if (disabled || !voiceOn || !recorder.supported || !token) return null;

  async function toggle() {
    if (recorder.recording) return recorder.stop();
    if (sending) return;
    setNote(null);
    if ((await recorder.start()) === "no-mic") setNote("No microphone here — type it instead.");
  }

  return (
    <div className="row mt-xs">
      <button type="button" className="link" onClick={() => void toggle()} aria-pressed={recorder.recording} disabled={sending}>
        <SpeakingTrumpet size={18} />{" "}
        {recorder.recording ? "Stop — I'm done" : sending ? "Listening back…" : "Say it instead"}
      </button>
      {note ? <span className="small">{note}</span> : null}
    </div>
  );
}
