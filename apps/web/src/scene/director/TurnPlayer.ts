// Turn playback: each line at the table either animates (pose, globe, arcs, ink ribbon, caption, voice)
// or, on resume / catch-up, is applied silently.
import type * as THREE from "three";
import { PALETTE, type TripState, type Turn } from "@all-ayes/shared";
import { InkRibbon } from "../Ribbon";
import { HOME_PORT } from "../Globe";
import { sound, playVoiceAt, speakFallback, type VoiceHandle } from "../audio";
import { speakerLabel, drawsArcs } from "../../shared-ui/labels";
import { AUDIO_WAIT_MS, READ_MIN_MS, READ_MS_PER_WORD } from "../../phone/timing";
import type { CrewSeating } from "./CrewSeating";
import type { DirectorContext } from "./context";

/** More than this many lines waiting (e.g. the tab was hidden): catch up instead of replaying late. */
const MAX_BACKLOG = 2;

export class TurnPlayer {
  private seen = new Set<string>();
  private backlog = 0;
  private ribbon: InkRibbon | null = null;
  /** The line being spoken, so leaving the room stops it (O2-052). */
  private voiceNow: VoiceHandle | null = null;
  private disposed = false;

  constructor(private ctx: DirectorContext, private crew: CrewSeating) {}

  /** Play every turn not seen yet. Anything present in the first burst after joining is history. */
  sync(turns: readonly Turn[], trip: TripState, instant: boolean) {
    for (const t of turns) {
      if (this.seen.has(t.turnId)) continue;
      this.seen.add(t.turnId);
      if (instant) this.applyInstant(t, trip);
      else {
        this.backlog++;
        this.ctx.enqueue(async () => {
          if (this.backlog > MAX_BACKLOG) this.applyInstant(t, this.ctx.store.state.trip ?? trip);
          else await this.animate(t);
          this.backlog--;
        });
      }
    }
  }

  private applyInstant(t: Turn, trip: TripState) {
    const { globe, compass } = this.ctx;
    const who = speakerLabel(t, trip.crew);
    // history replayed on resume arrives after trip:state; past the table, the phase caption wins
    if (trip.status === "AT_TABLE") this.ctx.caption(who.name, t.text, who.color);
    this.ctx.speaking(t); // applied in order, so the last one wins (the Gallery follows it)
    if (t.cityId) {
      void globe.turnToPin(t.cityId, true);
      if (drawsArcs(t.act)) globe.drawArc(HOME_PORT.id, t.cityId, "pencil", true);
    }
    if (t.act === "DECIDE") {
      compass.snapNorth(true);
      this.markShortlist();
    }
  }

  private async animate(t: Turn) {
    const { store, globe, compass, captain, root } = this.ctx;
    const trip = store.state.trip;
    if (!trip) return;
    const who = speakerLabel(t, trip.crew);
    const { obj, piece } = this.crew.pieceFor(t);
    this.ctx.speaking(t); // L2-008: now, as this line plays, not when it arrived

    const old = this.ribbon;
    this.ribbon = null;
    if (old) void old.rollUp();

    // pose
    if (t.speaker.kind === "captain") void captain.speak();
    else if (piece) {
      if (t.act === "OBJECT") void piece.object();
      else if (t.act === "CONCEDE") void piece.concede();
      else if (t.act !== "HAIL") void piece.speak();
    }
    sound.play(t.act === "HAIL" ? "pencil" : "click");

    // globe + arcs
    if (t.cityId) {
      void globe.turnToPin(t.cityId);
      if (drawsArcs(t.act)) globe.drawArc(HOME_PORT.id, t.cityId, "pencil"); // S2-002: from the home port
    }

    // ribbon + caption; the handwriting is written on for as long as the voice speaks, when known
    if (t.ribbon && t.act !== "HAIL") {
      const r = new InkRibbon(this.ctx.tweens, t.ribbon, t.speaker.kind === "captain" ? PALETTE.ink : who.color);
      const from = piece ? piece.frontPoint() : captain.group.position.clone().multiplyScalar(0.8);
      r.placeNear(from);
      root.add(r.group);
      this.ribbon = r;
      const durationMs = this.ctx.opts.voices && t.voiced ? store.state.audio[t.turnId]?.durationMs ?? t.durationMs : undefined;
      void r.unroll(durationMs);
      sound.play("pencil");
    }
    this.ctx.caption(who.name, t.text, who.color);

    if (t.act === "DECIDE") {
      sound.play("bell");
      compass.snapNorth();
      // the shortlist (table:decided) lands only after this line is spoken: DRY_RUN rings the two charts
      this.markShortlist();
    }

    // voice (or a reading pause); the server already paces turns
    const minMs = Math.max(READ_MIN_MS, t.text.split(/\s+/).length * READ_MS_PER_WORD);
    const started = performance.now();
    if (t.voiced && this.ctx.opts.voices) await this.voice(t, obj, who.band);
    const left = minMs - (performance.now() - started);
    if (left > 0) await this.ctx.tweens.wait(left);
    if (this.disposed) return;

    if (t.speaker.kind === "captain") void captain.settle();
    else if (piece && t.act !== "CONCEDE") void piece.settle();
  }

  private async voice(t: Turn, obj: THREE.Object3D, band: number | "captain") {
    const { store, opts } = this.ctx;
    let url = store.state.audio[t.turnId]?.audioUrl ?? t.audioUrl;
    const deadline = performance.now() + AUDIO_WAIT_MS;
    while (!url && performance.now() < deadline && !this.disposed) {
      await new Promise((r) => setTimeout(r, 100));
      url = store.state.audio[t.turnId]?.audioUrl;
    }
    if (this.disposed) return;
    const h = url ? playVoiceAt(obj, url) : opts.speechFallback ? speakFallback(t.text, band) : null;
    if (!h) return;
    this.voiceNow = h;
    await h.done;
    if (this.voiceNow === h) this.voiceNow = null;
  }

  /** Ink circles on the Two Charts' cities and only their arcs kept. No-op until the shortlist is known. */
  markShortlist() {
    const cities = (this.ctx.store.state.shortlist ?? []).map((p) => p.cityId);
    if (!cities.length) return;
    this.ctx.globe.circle(cities);
    this.ctx.globe.eraseArcs((key) => !cities.some((c) => key.endsWith(`>${c}`)));
  }

  dispose() {
    this.disposed = true;
    this.voiceNow?.stop(); // a positional mp3 plays on through the shared listener otherwise (O2-052)
    this.voiceNow = null;
    this.ribbon?.dispose();
    this.ribbon = null;
  }
}
