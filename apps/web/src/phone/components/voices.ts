import { useEffect, useRef } from "react";
import type { Turn } from "@all-ayes/shared";
import type { TripStore } from "../../net/tripStore";
import { AUDIO_WAIT_MS, speechCapMs } from "../timing";

/**
 * Optional phone playback of crew voices (the headset/gallery play them by default).
 * Plays each new voiced turn in order; if no audio arrives within AUDIO_WAIT_MS, reads it with speechSynthesis.
 */
export function useVoicePlayback(enabled: boolean, turns: Turn[], store: TripStore) {
  const played = useRef<Set<string>>(new Set());
  const queue = useRef<Turn[]>([]);
  const busy = useRef(false);
  const playing = useRef<HTMLAudioElement | null>(null);
  const on = useRef(enabled);
  on.current = enabled;

  // Leaving the table (Dry Run starts): stop talking.
  useEffect(() => () => {
    on.current = false;
    queue.current = [];
    playing.current?.pause();
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  }, []);

  // When switched on, only play turns from now on.
  useEffect(() => {
    if (enabled) turns.forEach((t) => played.current.add(t.turnId));
    else {
      queue.current = [];
      playing.current?.pause();
      try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    for (const t of turns) {
      if (played.current.has(t.turnId)) continue;
      played.current.add(t.turnId);
      if (t.voiced) queue.current.push(t);
    }
    void pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, enabled]);

  async function pump() {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length) {
      const t = queue.current.shift()!;
      const url = await waitForAudio(store, t.turnId, AUDIO_WAIT_MS);
      if (!on.current) break;
      try {
        if (url) await playUrl(url, playing);
        else await speak(t.text);
      } catch { /* keep going */ }
    }
    busy.current = false;
  }
}

/** OPT-015: resolves with the turn's audio as soon as the store has it (no polling), or null after `ms`. */
function waitForAudio(store: TripStore, turnId: string, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const now = store.state.audio[turnId];
    if (now) return resolve(now.audioUrl);
    const off = store.subscribe(() => {
      const a = store.state.audio[turnId];
      if (!a) return;
      window.clearTimeout(timer); off(); resolve(a.audioUrl);
    });
    const timer = window.setTimeout(() => { off(); resolve(null); }, ms);
  });
}

function playUrl(url: string, holder: { current: HTMLAudioElement | null }): Promise<void> {
  return new Promise((resolve) => {
    const a = new Audio(url);
    holder.current = a;
    a.onpause = () => resolve();
    a.onended = () => resolve();
    a.onerror = () => resolve();
    a.play().catch(() => resolve());
  });
}

/**
 * Read a line aloud with the device voice. OPT-015: never hangs the queue — if onend never fires (hidden tab,
 * no voices installed), it gives up after roughly the time the line takes to say.
 */
function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    const s = window.speechSynthesis;
    if (!s) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; window.clearTimeout(cap); resolve(); } };
    const cap = window.setTimeout(() => { try { s.cancel(); } catch { /* ignore */ } finish(); }, speechCapMs(text));
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.onend = finish;
    u.onerror = finish;
    try { s.speak(u); } catch { finish(); }
  });
}
