// Crew pieces around the chart: arrive, re-seat when the roster changes, carve when terms are sealed.
import * as THREE from "three";
import { BANDS, type CrewPublic, type Turn } from "@all-ayes/shared";
import { CrewPiece } from "../CrewPiece";
import { sound } from "../audio";
import { seatAngle } from "../../shared-ui/seating";
import { CAPTAIN_POS, seatMap, seatPoint } from "../seats";
import type { DirectorContext } from "./context";

/** Where the Gallery's "follow the speaker" camera looks: head height above the seat. */
const CAPTAIN_HEAD_Y = 0.08;
const CREW_HEAD_Y = 0.06;

export class CrewSeating {
  private pieces = new Map<string, CrewPiece>();
  private rosterKey = "";
  private seats = new Map<string, THREE.Vector3>();
  private lastCrew: CrewPublic[] | null = null;

  constructor(private ctx: DirectorContext) {}

  sync(crew: CrewPublic[], organizerId: string, instant: boolean) {
    if (crew === this.lastCrew) return; // same snapshot: nothing moved
    this.lastCrew = crew;
    // seats are recomputed only when who is aboard changes, not per store event (OPT-051)
    const key = `${organizerId}|${crew.map((c) => c.memberId).join(",")}`;
    if (key !== this.rosterKey) { this.rosterKey = key; this.seats = seatMap(crew, organizerId); }

    for (const [id, piece] of this.pieces) {
      if (!this.seats.has(id)) { piece.dispose(); this.pieces.delete(id); } // O2-050: free it, not just unlink it
    }
    for (const c of crew) {
      const seat = this.seats.get(c.memberId)!;
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
      if (c.briefSealed && !piece.isSealed) {
        piece.setSealed(true);
        if (!instant) { void piece.placeAt(piece.seat.clone(), true); sound.play("click"); }
      } else if (!c.briefSealed) piece.setSealed(false);
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
    if (seat) return out.copy(seat).setY(CREW_HEAD_Y);
    if (!trip) return null;
    return seatPoint(seatAngle(trip.crew, trip.organizerId, id), out).setY(CREW_HEAD_Y);
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
