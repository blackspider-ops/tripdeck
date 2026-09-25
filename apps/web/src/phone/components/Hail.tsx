import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HAIL_MAX_CHARS } from "@all-ayes/shared";
import { useCrew, useInlineError, useTripSelector } from "../TripContext";
import { HAIL_CODES, HAIL_DROPPED, HAIL_EVENTS, errorCopy } from "../errors";
import { HAIL_MAX_MS, HAIL_PREVIEW_MS } from "../timing";
import { SpeakingTrumpet } from "./icons";
import { Button, InlineError } from "./ui";
import { transcribe, transcribeError, useRecorder, useVoiceAvailable } from "./useRecorder";

type Phase = "idle" | "sending" | "preview";
/** R2-WP-16 (L4-005 / R2-WP-04): the dock's words while the Captain opens the table (Watch 0), same as the refusal. */
const OPENING = errorCopy({ code: "TABLE_OPENING", message: "" });

/**
 * O2-021: sending a hail — the words go out as `table:hail`, and (TR1-010) the last ones sent are kept until the
 * table echoes them back or the helm refuses them, when they go back in the box unless a new one was started.
 */
function useHailSender(restore: (words: string) => void) {
  const { store, session } = useCrew();
  const pending = useRef<string | null>(null);
  const myLastHail = useTripSelector((s) => {
    for (let i = s.turns.length - 1; i >= 0; i--) {
      const t = s.turns[i];
      if (t.speaker.kind === "human" && t.speaker.memberId === session.memberId) return t.turnId;
    }
    return null;
  });
  useEffect(() => { pending.current = null; }, [myLastHail]);
  // L1-008: only refusals of a hail; a SLOW_DOWN / BAD_INPUT from another action goes to the banner
  const refused = useInlineError(HAIL_CODES, true, HAIL_EVENTS);
  useLayoutEffect(() => {
    if (!refused.err || pending.current === null) return;
    const words = pending.current;
    pending.current = null;
    restore(words);
  }, [refused.err]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = (text: string) => {
    pending.current = text;
    store.emit("table:hail", { text });
  };
  return { send, refused };
}

/**
 * Hold-to-talk hail (doc 03 P6). Falls back to text when voice isn't available. `closed`: the Captain is calling it
 * (a take in progress or in preview is dropped); `opening`: Watch 0, when the helm refuses hails (TABLE_OPENING).
 * Memo'd, with the token and the sender from context, so a new turn at the table doesn't redraw it (O2-046).
 */
export const HailDock = memo(function HailDock({ closed, opening }: { closed: boolean; opening: boolean }) {
  const { session } = useCrew();
  const token = session.memberToken;
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const previewTimer = useRef<number | null>(null);
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const dropTake = useRef(false);
  const voiceOn = useVoiceAvailable();
  const { send: sendHail, refused } = useHailSender((words) => setText((cur) => cur || words)); // unless they've started a new one
  const off = closed || opening;

  const recorder = useRecorder({
    maxMs: HAIL_MAX_MS,
    onBlob: (blob) => {
      if (dropTake.current || closedRef.current) { dropTake.current = false; return; }
      void send(blob);
    },
  });

  // TR1-004: leaving the table, or the preview outliving it, must not send anything
  useEffect(() => () => { if (previewTimer.current) window.clearTimeout(previewTimer.current); }, []);

  // The Captain is calling it: drop any take in progress or in preview. The helm doesn't queue hails.
  useEffect(() => {
    if (!closed) return;
    if (recorder.recording) { dropTake.current = true; recorder.release(); }
    if (previewTimer.current) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
      setPhase("idle"); setPreview("");
      setNote(HAIL_DROPPED);
    }
  }, [closed]); // eslint-disable-line react-hooks/exhaustive-deps

  const voice = voiceOn && recorder.supported && !!token;

  async function start() {
    if (off || phase !== "idle" || !voice) return;
    setNote(null); refused.clear();
    const r = await recorder.start({ hold: true });
    if (r === "released") setNote("Hold the button while you talk.");
    else if (r === "no-mic") setNote("No microphone here. Type your hail instead.");
  }

  async function send(blob: Blob) {
    setPhase("sending");
    try {
      const t = (await transcribe(session.tripId, token!, blob)).slice(0, HAIL_MAX_CHARS);
      if (closedRef.current) { setPhase("idle"); setNote(HAIL_DROPPED); return; }
      setPreview(t);
      setPhase("preview");
      previewTimer.current = window.setTimeout(() => {
        previewTimer.current = null;
        setPreview(""); setPhase("idle");
        if (closedRef.current) return;
        sendHail(t);
      }, HAIL_PREVIEW_MS);
    } catch (e) {
      setPhase("idle");
      setNote(transcribeError(e, "Couldn't hear that one. Type your hail instead."));
    }
  }

  const submitText = () => {
    const t = text.trim().slice(0, HAIL_MAX_CHARS);
    if (!t || off) return;
    setNote(null); refused.clear();
    sendHail(t);
    setText("");
  };

  const shown = note ?? refused.note;
  const why = closed ? "Captain's calling it." : opening ? OPENING : null;
  return (
    <div className="hail-dock">
      {voice ? (
        <>
          <button
            type="button" className="hail-btn" data-rec={recorder.recording} disabled={off || phase !== "idle"}
            aria-label={recorder.recording ? "Release to send your hail" : "Hold to hail"}
            onPointerDown={(e) => { e.preventDefault(); void start(); }}
            onPointerUp={recorder.release} onPointerLeave={() => recorder.isHolding() && recorder.release()} onPointerCancel={recorder.release}
            onContextMenu={(e) => e.preventDefault()}
          >
            <SpeakingTrumpet size={34} />
          </button>
          <div className="small center">
            {why ?? (recorder.recording ? "Listening… release to send"
              : phase === "sending" ? "Writing it down…"
              : phase === "preview" ? <span>“{preview}”</span>
              : "Hold to hail")}
          </div>
        </>
      ) : why ? <div className="small center">{why}</div> : null}
      {shown ? <InlineError>{shown}</InlineError> : null}
      <div className="row">
        <input
          className="input" placeholder="or type a hail" value={text} maxLength={HAIL_MAX_CHARS} disabled={off}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitText()}
          aria-label="Type a hail"
        />
        <Button small onClick={submitText} disabled={off || !text.trim()}>Hail</Button>
      </div>
    </div>
  );
});
