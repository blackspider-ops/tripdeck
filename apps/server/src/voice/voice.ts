/**
 * ElevenLabs voices (docs/05-agent-spec.md §8): one voice per crew band + the Captain.
 * TTS results are cached once, content-addressed, as .cache/tts/<sha1(voice|speed|text)>.mp3; a turn maps to its
 * file in memory and is served at /api/audio/:turnId (OPT-040 / TR5-020: no per-turn copy, async fs, bounded dir).
 * Without ELEVENLABS_API_KEY everything still works: clients show captions and fall back to browser speech.
 */
import { mkdir, open, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config, features } from "../config.js";
import { Lru, spend } from "../util/limits.js";
import { withAbort } from "../util/timeout.js";

const textCacheDir = join(config.cacheDir, "tts");
/** Older builds wrote a per-turn copy here; pruneAudioCache() empties it. */
const legacyAudioDir = join(config.cacheDir, "audio");

/**
 * WP-11/WP-07 follow-up: nothing touches the disk at import. The cache dir is created on the first write; if that
 * fails (read-only FS), voices degrade to captions with one warning and the helm keeps running.
 */
let cacheDirReady: Promise<boolean> | null = null;
function ensureCacheDir(): Promise<boolean> {
  return (cacheDirReady ??= mkdir(textCacheDir, { recursive: true }).then(() => true, (e: Error) => {
    console.warn(`[voice] cache dir ${textCacheDir} is not writable (${e.message}); voices fall back to captions`);
    return false;
  }));
}

/** OPT-060: timeouts and pacing. A TTS call that hangs falls back to captions; a hung STT call can't pin a request. */
const TTS_TIMEOUT_MS = 8000;
const STT_TIMEOUT_MS = 15_000;
/** Turns whose audio we can serve (turnId → cache key), most recent first. */
const TURN_AUDIO_ENTRIES = 20_000;
/** Expo mode speaks a little faster; without a readable mp3 header, length is estimated at 2.7 words a second. */
/** ElevenLabs speaking speed (0.7–1.2). Human pace by default; VOICE_SPEED overrides. */
const VOICE_SPEED = Math.min(1.2, Math.max(0.7, Number(process.env.VOICE_SPEED?.trim() || 0.9)));
const WORDS_PER_SEC = 2.7;

const SETTINGS: Record<string, { stability: number; similarity_boost: number; style: number }> = {
  captain: { stability: 0.6, similarity_boost: 0.8, style: 0.2 },
  "1": { stability: 0.45, similarity_boost: 0.8, style: 0.3 },
  "2": { stability: 0.5, similarity_boost: 0.8, style: 0.3 },
  "3": { stability: 0.55, similarity_boost: 0.8, style: 0.2 },
  "4": { stability: 0.45, similarity_boost: 0.8, style: 0.3 },
};

/** turnId → tts cache key. Bounded; a turn from before a restart has no audio (captions + browser voice take over). */
const turnAudio = new Lru<string, string>(TURN_AUDIO_ENTRIES);
const ttsPath = (key: string) => join(textCacheDir, `${key}.mp3`);

/** The mp3 file for a turn, or null. */
export function audioFile(turnId: string): string | null {
  const key = turnAudio.get(String(turnId));
  return key ? ttsPath(key) : null;
}

/** The cache key a turn's audio was served from (persisted on the turn document so a restart can serve it again). */
export function audioKeyOf(turnId: string): string | undefined {
  return turnAudio.get(String(turnId));
}

/**
 * Restore (WP-07 follow-up): re-attaches a stored turn to its cached mp3. False when the file is gone (the cache is
 * regenerable and may have been pruned or wiped): the caller then drops the turn's audioUrl, so captions take over.
 * L5-012: a re-attached file counts as used now (its mtime is refreshed), so the pruner, which keeps the most
 * recently used files, doesn't delete an mp3 a restored turn still points at.
 */
export async function restoreTurnAudio(turnId: string, key: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(key)) return false;
  const file = ttsPath(key);
  const ok = await stat(file).then((s) => s.isFile(), () => false);
  if (ok) {
    turnAudio.set(turnId, key);
    const now = new Date();
    await utimes(file, now, now).catch(() => undefined);
  }
  return ok;
}

/** Synthesize a line; returns duration estimate in ms, or null if voice is unavailable. */
export async function synthesize(turnId: string, text: string, voiceKey: string): Promise<number | null> {
  if (!features.eleven() && !features.cached()) return null;
  const voiceId = config.eleven.voices[voiceKey] ?? config.eleven.voices["1"];
  const speed = VOICE_SPEED;
  // Same text + voice → reuse (makes rehearsals and the Expo demo instant)
  const key = createHash("sha1").update(`${voiceId}|${speed}|${text}`).digest("hex");
  const cached = ttsPath(key);
  try {
    // O2-045: a cache hit reads only the mp3's header (or nothing, once its length is known), never the whole file
    const hit = await cachedDurationMs(key, cached);
    let mp3: Buffer | null = null;
    if (hit !== undefined) {
      const now = new Date();
      void utimes(cached, now, now).catch(() => undefined); // LRU: a hit keeps the line warm
      turnAudio.set(turnId, key);
      return hit ?? estimateMs(text, speed);
    } else if (features.cached()) {
      return null; // cached mode never calls the network; captions + browser voice take over
    } else if (!spend("tts")) {
      return null; // SEC-005: TTS budget spent → captions + browser voice
    } else {
      // the timeout covers the request (the headers), as before; the body then arrives without one
      const res = await withAbort(TTS_TIMEOUT_MS, (signal) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": config.eleven.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: config.eleven.model, voice_settings: { ...(SETTINGS[voiceKey] ?? SETTINGS["1"]), speed } }),
        signal,
      }));
      if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
      mp3 = Buffer.from(await res.arrayBuffer());
      if (!(await ensureCacheDir())) return null;
      await writeFile(cached, mp3); // written once, content-addressed
    }
    turnAudio.set(turnId, key);
    const ms = mp3DurationMs(mp3);
    durations.set(key, ms);
    return ms ?? estimateMs(text, speed);
  } catch (e) {
    console.warn("[voice] TTS failed, captions only:", (e as Error).message);
    return null;
  }
}

/** Speech-to-text for hails (ElevenLabs Scribe). The caller has already checked the STT budget (SEC-005). */
export async function transcribe(audio: Buffer, mime: string): Promise<string | null> {
  if (!features.eleven()) return null;
  const form = new FormData();
  form.append("model_id", config.eleven.sttModel);
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), "hail.webm");
  try {
    // SEC-005: the timeout covers the request and its answer
    return await withAbort(STT_TIMEOUT_MS, async (signal) => {
      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST", headers: { "xi-api-key": config.eleven.apiKey }, body: form, signal,
      });
      if (!res.ok) { console.warn("[voice] STT failed", res.status); return null; }
      const data = (await res.json()) as { text?: string };
      return data.text?.trim() || null;
    });
  } catch (e) {
    console.warn("[voice] STT failed", (e as Error).message);
    return null;
  }
}

/** Duration of a CBR MP3 from its first frame header (good enough for pacing). Scans at most 4 kB (OPT-046). */
export function mp3DurationMs(buf: Buffer): number | null {
  return frameDurationMs(buf, 0, id3End(buf), buf.length);
}

/** SCAN_BYTES after the ID3 tag are searched for the first frame header. */
const SCAN_BYTES = 4096;
const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
/** Where the audio starts: after the ID3v2 tag, if there is one (its 10-byte header says how long it is). */
const id3End = (head: Buffer) => (head.subarray(0, 3).toString() === "ID3" && head.length >= 10
  ? 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f)) : 0);

/**
 * The first frame header in `buf` (which holds the file's bytes from offset `bufAt`), searched from file offset
 * `from` for SCAN_BYTES; the duration follows from its bitrate and the file's `total` length.
 */
function frameDurationMs(buf: Buffer, bufAt: number, from: number, total: number): number | null {
  const end = Math.min(total - 4, from + SCAN_BYTES) - bufAt;
  for (let i = from - bufAt; i < end && i + 2 < buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const kbps = KBPS[(buf[i + 2] >> 4) & 0x0f];
      if (!kbps) return null;
      return Math.round(((total - (bufAt + i)) * 8) / kbps);
    }
  }
  return null;
}

/** Without a readable mp3 header, a line's length is estimated from its words. */
const estimateMs = (text: string, speed: number) => Math.round((text.split(/\s+/).length / WORDS_PER_SEC) * 1000 / speed);

/** O2-045: cache key → the mp3's duration (null: no readable header), so a repeated line isn't read again. */
const durations = new Lru<string, number | null>(TURN_AUDIO_ENTRIES);

/**
 * O2-045: a cached line's duration (null when its header can't be read), or undefined when it isn't cached. Reads at
 * most the ID3 header and SCAN_BYTES after it (plus the file's size), not the 47–121 kB file.
 */
async function cachedDurationMs(key: string, file: string): Promise<number | null | undefined> {
  const fh = await open(file, "r").catch(() => null);
  if (!fh) { durations.delete(key); return undefined; }
  try {
    const known = durations.get(key);
    if (known !== undefined) return known;
    const { size } = await fh.stat();
    const head = Buffer.alloc(Math.min(size, 10));
    await fh.read(head, 0, head.length, 0);
    const from = id3End(head);
    const win = Buffer.alloc(Math.max(0, Math.min(size - from, SCAN_BYTES + 4)));
    const { bytesRead } = await fh.read(win, 0, win.length, from);
    const ms = frameDurationMs(win.subarray(0, bytesRead), from, from, size);
    durations.set(key, ms);
    return ms;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Bounds the voice cache (OPT-040 / SEC-015): removes the legacy per-turn copies, then keeps at most
 * `maxFiles` TTS mp3s no older than `maxAgeMs` (by last use: a cache hit refreshes the mtime).
 * Returns the number of files removed.
 */
export async function pruneAudioCache(opts: { maxFiles?: number; maxAgeMs?: number; now?: number } = {}): Promise<number> {
  const maxFiles = opts.maxFiles ?? config.limits.ttsCacheMaxFiles;
  const maxAgeMs = opts.maxAgeMs ?? config.limits.ttsCacheMaxAgeMs;
  const now = opts.now ?? Date.now();
  let removed = 0;
  await rm(legacyAudioDir, { recursive: true, force: true }).catch(() => undefined);
  const names = (await readdir(textCacheDir).catch(() => [] as string[])).filter((n) => n.endsWith(".mp3"));
  const files = (await Promise.all(names.map(async (n) => {
    const s = await stat(join(textCacheDir, n)).catch(() => null);
    return s ? { n, at: s.mtimeMs } : null;
  }))).filter((f): f is { n: string; at: number } => f !== null).sort((a, b) => b.at - a.at);
  for (const [i, f] of files.entries()) {
    if (i < maxFiles && now - f.at <= maxAgeMs) continue;
    await rm(join(textCacheDir, f.n), { force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}
