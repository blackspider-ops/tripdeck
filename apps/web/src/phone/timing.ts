// Web timings shared by the phone and the chart room (O2-034). The scene, the Gallery and the phone's voice playback
// (voices.ts, R2-WP-16) read these.

/** Browser speech runs at about this pace; a spoken line's expected length is words × this + SPEECH_SLACK_MS. */
export const SPEECH_MS_PER_WORD = 420;
export const SPEECH_SLACK_MS = 1500;
/** A spoken line never waits less than this for the device voice to finish. */
export const SPEECH_MIN_MS = 3000;

/**
 * O2-017: how long to wait for the device voice to finish `text` before giving up (speech can silently never fire
 * `end`: a hidden tab, no voices installed). The phone's playback and the chart room's fallback share it.
 */
export function speechCapMs(text: string): number {
  return Math.max(SPEECH_MIN_MS, text.split(/\s+/).length * SPEECH_MS_PER_WORD + SPEECH_SLACK_MS);
}

/** With no voice, a line stays at the table at least words × READ_MS_PER_WORD, and never less than READ_MIN_MS. */
export const READ_MS_PER_WORD = 260;
export const READ_MIN_MS = 2200;

/** How long the table waits for a line's audio (turn:audioReady) before it reads the line without the voice. */
export const AUDIO_WAIT_MS = 1500;

/** State and history arriving this soon after the first snapshot are a resume: applied at once, not animated. */
export const RESUME_WINDOW_MS = 1500;

/** The Gallery's "Take a seat" waits this long for the browser to unlock audio, then seats you anyway. */
export const AUDIO_UNLOCK_WAIT_MS = 600;

// ---------- R2-WP-16: the phone's own timings (were literals in each component) ----------
/** A held hail records at most this long. */
export const HAIL_MAX_MS = 10_000;
/** A transcribed hail shows this long before it goes to the table (a last chance to see the words). */
export const HAIL_PREVIEW_MS = 1500;
/** The Brief's "Say it instead" note records at most this long. */
export const NOTE_MAX_MS = 20_000;
/** The second tap of a two-tap confirm ("Call it off", "Unpair headset") stays armed this long. */
export const CONFIRM_MS = 4000;
/** "Copied" shows this long after copying an invite link. */
export const COPIED_MS = 1600;
/** The organizer can sail without a friend who has been unsealed this long (doc 03 §6)… */
export const SAIL_WITHOUT_AFTER_MS = 120_000;
/** …checked this often. */
export const SAIL_WITHOUT_TICK_MS = 5000;
/** Countdowns on screen (seal deadline, auto-pick) tick once a second: whole seconds are shown. */
export const COUNTDOWN_TICK_MS = 1000;
/** The Dry Run clock checks the in-trip minute this often (a whole minute is 4 s at 15 min/s). */
export const DRYRUN_TICK_MS = 250;
/** L1-002: waits between voyage lookups the helm answered LOADING (then "Couldn't reach the voyage."). */
export const LOOKUP_RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;
/** The saved .ics file's object URL is released after this. */
export const DOWNLOAD_URL_TTL_MS = 2000;
