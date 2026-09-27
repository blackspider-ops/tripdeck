// Crew pieces around the chart: arrive, re-seat when the roster changes, carve when terms are sealed.
import * as THREE from "three";
import { BANDS, type CrewPublic, type Turn } from "@all-ayes/shared";
import { CrewPiece } from "../CrewPiece";
import { sound } from "../audio";
import { flagTier, pieceScale, seatPlace } from "../../shared-ui/seating";
import { CAPTAIN_POS, seatMap, seatPoint } from "../seats";
import type { DirectorContext } from "./context";

/** Where the Gallery's "follow the speaker" camera looks: head height above the seat. */
const CAPTAIN_HEAD_Y = 0.08;
const CREW_HEAD_Y = 0.06;
/** During the Seal (SEALING, BOOKED, VOIDED) the pieces step back to this ring so the seal chart lies clear of them
 *  (user report, Quest 3S: the seal paper clipped into the pieces). Still on the chart (radius 0.35). */
export const SEAL_RING_R = 0.325;

/** A seat pushed out to at least `r` from the chart's centre (same angle). */
export function spreadSeat(seat: THREE.Vector3, r: number, out = new THREE.Vector3()): THREE.Vector3 {
  const d = Math.hypot(seat.x, seat.z);
  if (d >= r || d < 1e-6) return out.copy(seat);
  return out.set((seat.x / d) * r, seat.y, (seat.z / d) * r);
}

export class CrewSeating {
  private pieces = new Map<string, CrewPiece>();
  private rosterKey = "";
  private seats = new Map<string, THREE.Vector3>();
  private lastCrew: CrewPublic[] | null = null;
  /** The pieces stand back on SEAL_RING_R (the Seal ceremony). */
  private spread = false;

  constructor(private ctx: DirectorContext) {}

  sync(crew: CrewPublic[], organizerId: string, instant: boolean) {
    if (crew === this.lastCrew) return; // same snapshot: nothing moved
    this.lastCrew = crew;
    // seats are recomputed only when who is aboard changes, not per store event (OPT-051)
    const key = `${organizerId}|${crew.map((c) => c.memberId).join(",")}`;
    if (key !== this.rosterKey) { this.rosterKey = key; this.seats = seatMap(crew, organizerId); }
    // a big crew (7–12) stands a little smaller so every piece and flag fits round the ring
    const scale = pieceScale(crew.length);

    for (const [id, piece] of this.pieces) {
      if (!this.seats.has(id)) { piece.dispose(); this.pieces.delete(id); } // O2-050: free it, not just unlink it
    }
    for (const c of crew) {
      const seat = this.seatOf(c.memberId)!;
      let piece = this.pieces.get(c.memberId);
      if (!piece) {
        piece = new CrewPiece(this.ctx.tweens, c.memberId, c.name, BANDS[c.band].hex, c.role === "absent");
        this.pieces.set(c.memberId, piece);
        this.ctx.root.add(piece.group);
        void piece.placeAt(seat, !instant);
        if (!instant) sound.play("click");
      } else if (!piece.seat.equals(seat)) {
        void piece.placeAt(seat);
      }
      piece.group.scale.setScalar(scale);
      piece.setFlagTier(flagTier(crew, organizerId, c.memberId)); // neighbours' flags at alternating heights
      if (c.briefSealed && !piece.isSealed) {
        piece.setSealed(true);
        if (!instant) { void piece.placeAt(piece.seat.clone(), true); sound.play("click"); }
      } else if (!c.briefSealed) piece.setSealed(false);
    }
  }

  private seatOf(id: string): THREE.Vector3 | undefined {
    const s = this.seats.get(id);
    return s && this.spread ? spreadSeat(s, SEAL_RING_R) : s;
  }

  /** Step the pieces back for the Seal ceremony (or home again): a short slide, or at once. */
  setSpread(on: boolean, instant: boolean) {
    if (on === this.spread) return;
    this.spread = on;
    for (const [id, piece] of this.pieces) {
      const to = this.seatOf(id);
      if (!to) continue;
      const from = piece.group.position.clone();
      if (instant) { void piece.placeAt(to); continue; }
      piece.seat.copy(to);
      void this.ctx.tweens.to(500, (t) => { piece.group.position.lerpVectors(from, to, t); }, undefined, `spread-${id}`).then(() => piece.placeAt(to));
    }
  }

  /** The object a line comes from (for spatial voice) and the crew piece, if a member is speaking. */
  pieceFor(t: Turn): { obj: THREE.Object3D; piece?: CrewPiece } {
    if (t.speaker.kind === "captain") return { obj: this.ctx.captain.group };
    const p = this.pieces.get(t.speaker.memberId);
    return { obj: p?.group ?? this.ctx.root, piece: p };
  }

  /** Head height above whoever speaks `t`, in the director root's space (OPT-016). */
  speakerPosition(t: Pick<Turn, "speaker">, out = new THREE.Vector3()): THREE.Vector3 | null {
    if (t.speaker.kind === "captain") return out.copy(CAPTAIN_POS).setY(CAPTAIN_HEAD_Y);
    const trip = this.ctx.store.state.trip;
    const id = t.speaker.memberId;
    const seat = this.pieces.get(id)?.seat ?? this.seats.get(id);
    if (seat) return out.copy(seat).setY(CREW_HEAD_Y * pieceScale(trip?.crew.length ?? 0));
    if (!trip) return null;
    const { deg, r } = seatPlace(trip.crew, trip.organizerId, id);
    return seatPoint(deg, out, r).setY(CREW_HEAD_Y);
  }

  /** Per frame: name flags face the viewer (`camPos`: the camera, world space). */
  update(camPos: THREE.Vector3) {
    for (const p of this.pieces.values()) p.update(camPos);
  }

  dispose() {
    for (const p of this.pieces.values()) p.dispose();
    this.pieces.clear();
  }
}
