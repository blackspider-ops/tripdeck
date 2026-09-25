// Sound for the chart room (doc 02 §10). All effects are synthesized with WebAudio — no files.
// Voices: per-piece positional audio for ElevenLabs mp3s; browser speech as a last resort.
import * as THREE from "three";
import { speechCapMs } from "../phone/timing";

type Sfx = "click" | "pencil" | "tick" | "bell" | "clink" | "thud" | "snap" | "paper";

const LEVEL_DB: Record<Sfx, number> = {
  click: -18, pencil: -24, tick: -24, bell: -12, clink: -20, thud: -16, snap: -14, paper: -22,
};
const db = (d: number) => Math.pow(10, d / 20);

class SoundBank {
  listener: THREE.AudioListener | null = null;
  sfxMuted = false;
  voiceMuted = false;
  private noiseBuf: AudioBuffer | null = null;

  get ctx(): AudioContext {
    return THREE.AudioContext.getContext() as AudioContext;
  }

  attach(camera: THREE.Camera) {
    if (!this.listener) this.listener = new THREE.AudioListener();
    if (this.listener.parent !== camera) camera.add(this.listener);
    return this.listener;
  }

  /** Must be called from a user gesture (Enter button / click overlay). */
  async unlock() {
    // resume() stays pending forever when the browser doesn't count this as a gesture — never let
    // that block entering the room (callers await this before showing the scene)
    try {
      if (this.ctx.state !== "running") await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
    } catch { /* ignore */ }
    // warm up speechSynthesis voices list
    try { window.speechSynthesis?.getVoices(); } catch { /* ignore */ }
  }

  get unlocked() { return this.ctx.state === "running"; }

  private noise(): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf;
    const len = this.ctx.sampleRate * 1;
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = b;
    return b;
  }

  private out(level: number) {
    const g = this.ctx.createGain();
    g.gain.value = level;
    g.connect(this.listener ? this.listener.getInput() : this.ctx.destination);
    return g;
  }

  play(kind: Sfx, opts: { strikes?: number } = {}) {
    if (this.sfxMuted || !this.unlocked) return;
    const c = this.ctx, t0 = c.currentTime;
    const kit: Kit = {
      c, t0,
      out: this.out(db(LEVEL_DB[kind])),
      env: (node, attack, decay, peak = 1, at = t0) => {
        const g = c.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(peak, at + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
        node.connect(g);
        return g;
      },
      noise: (at, dur) => {
        const src = c.createBufferSource();
        src.buffer = this.noise();
        src.start(at, Math.random() * 0.5, dur);
        return src;
      },
      tone: (freq, at, dur, type = "sine") => {
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        o.start(at);
        o.stop(at + dur);
        return o;
      },
      filter: (type, freq, q) => {
        const f = c.createBiquadFilter();
        f.type = type; f.frequency.value = freq;
        if (q !== undefined) f.Q.value = q;
        return f;
      },
    };
    RECIPES[kind](kit, opts);
  }
}

/** What a sound recipe gets: the context, "now", the output gain, and small node builders. */
interface Kit {
  c: AudioContext;
  t0: number;
  out: GainNode;
  env(node: AudioNode, attack: number, decay: number, peak?: number, at?: number): GainNode;
  noise(at: number, dur: number): AudioBufferSourceNode;
  tone(freq: number, at: number, dur: number, type?: OscillatorType): OscillatorNode;
  filter(type: BiquadFilterType, freq: number, q?: number): BiquadFilterNode;
}

/** One recipe per effect (O2-023: was an 86-line switch). */
const RECIPES: Record<Sfx, (k: Kit, opts: { strikes?: number }) => void> = {
  click: ({ t0, out, env, noise, tone, filter }) => { // wood on wood
    const f = filter("bandpass", 1400, 6);
    noise(t0, 0.05).connect(f);
    env(f, 0.001, 0.05, 1.4).connect(out);
    env(tone(820, t0, 0.08, "triangle"), 0.001, 0.06, 0.5).connect(out);
  },
  pencil: ({ c, t0, out, noise, filter }) => {
    const f = filter("bandpass", 3200, 1.2);
    noise(t0, 0.35).connect(f);
    const g = c.createGain(); f.connect(g); g.connect(out);
    g.gain.setValueAtTime(0, t0);
    for (let i = 0; i < 7; i++) g.gain.linearRampToValueAtTime(0.25 + Math.random() * 0.5, t0 + i * 0.045 + 0.02);
    g.gain.linearRampToValueAtTime(0, t0 + 0.34);
  },
  tick: ({ t0, out, env, noise, filter }) => {
    const f = filter("highpass", 2500);
    noise(t0, 0.02).connect(f);
    env(f, 0.0005, 0.018, 1.2).connect(out);
  },
  bell: ({ t0, out, env, tone }, { strikes = 1 }) => { // ship's bell: inharmonic partials, long decay
    for (let s = 0; s < strikes; s++) {
      const at = t0 + s * 0.55;
      for (const [ratio, amp, dec] of [[1, 1, 2.6], [2.76, 0.45, 1.6], [5.4, 0.22, 0.9], [8.93, 0.1, 0.5]] as const) {
        env(tone(520 * ratio, at, dec + 0.1), 0.002, dec, amp * 0.5, at).connect(out);
      }
    }
  },
  clink: ({ t0, out, env, tone }) => {
    for (const [f0, a] of [[2900, 0.5], [4400, 0.3], [6100, 0.15]] as const) env(tone(f0, t0, 0.5), 0.001, 0.4, a).connect(out);
  },
  thud: ({ t0, out, env, noise, tone, filter }) => {
    const o = tone(110, t0, 0.2);
    o.frequency.exponentialRampToValueAtTime(55, t0 + 0.15);
    env(o, 0.002, 0.16, 1).connect(out);
    const f = filter("lowpass", 600);
    noise(t0, 0.06).connect(f);
    env(f, 0.001, 0.05, 0.6).connect(out);
  },
  snap: ({ t0, out, env, noise, filter }) => {
    const f = filter("highpass", 1800);
    noise(t0, 0.04).connect(f);
    env(f, 0.0005, 0.03, 1.5).connect(out);
  },
  paper: ({ t0, out, env, noise, filter }) => {
    const f = filter("bandpass", 1800, 0.7);
    noise(t0, 0.7).connect(f);
    env(f, 0.05, 0.55, 0.7).connect(out);
  },
};

export const sound = new SoundBank();

// ---------------- voices ----------------

const loader = new THREE.AudioLoader();

export interface VoiceHandle { done: Promise<void>; stop(): void }

/** Play an mp3 from a piece's position. Resolves when finished (or on error). */
export function playVoiceAt(obj: THREE.Object3D, url: string): VoiceHandle {
  if (!sound.listener || sound.voiceMuted || !sound.unlocked) return { done: Promise.resolve(), stop() {} };
  const audio = new THREE.PositionalAudio(sound.listener);
  audio.setRefDistance(0.6);
  audio.setRolloffFactor(0.6);
  obj.add(audio);
  let stopped = false;
  let finish = () => undefined as void;
  const done = new Promise<void>((resolve) => {
    let finished = false;
    finish = () => {
      if (finished) return;
      finished = true;
      obj.remove(audio);
      try { audio.disconnect(); } catch { /* never connected */ }
      resolve();
    };
    loader.load(url, (buf) => {
      if (stopped) return finish();
      audio.setBuffer(buf);
      audio.onEnded = () => { audio.isPlaying = false; finish(); };
      audio.play();
    }, undefined, () => finish());
  });
  // three's Audio.stop() drops the `ended` callback, so finish (detach + resolve) here too (O2-052)
  return { done, stop() { stopped = true; try { if (audio.isPlaying) audio.stop(); } catch { /* not started */ } finish(); } };
}

/** Browser speech fallback: one voice/pitch per band so the crew still sounds like different people. */
export function speakFallback(text: string, band: number | "captain"): VoiceHandle {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || sound.voiceMuted) return { done: Promise.resolve(), stop() {} };
  const u = new SpeechSynthesisUtterance(text);
  const voices = synth.getVoices().filter((v) => v.lang.startsWith("en"));
  const idx = band === "captain" ? 0 : band;
  if (voices.length) u.voice = voices[idx % voices.length];
  u.pitch = band === "captain" ? 0.75 : [1, 1.1, 0.9, 1.2, 0.95][idx] ?? 1;
  u.rate = band === "captain" ? 0.92 : 1.05;
  const done = new Promise<void>((resolve) => {
    u.onend = () => resolve();
    u.onerror = () => resolve();
    // speech can silently never fire `end` (hidden tab, no voices): cap at the line's expected length
    setTimeout(resolve, speechCapMs(text));
  });
  synth.speak(u);
  return { done, stop() { synth.cancel(); } };
}
