// Who is speaking, as the chart room names them (OPT-017). No three.js import: the phone shares it (O2-060, moved
// from scene/ so the phone never imports a scene module).
import { BANDS, PALETTE, type Act, type Band, type CrewPublic, type Turn } from "@all-ayes/shared";

export interface SpeakerLabel { name: string; color: string; band: Band | "captain" }

/** "The Captain", "Ann's mate" (her Advocate) or "Ann (hail)", in the speaker's band colour. */
export function speakerLabel(t: Turn, crew: CrewPublic[]): SpeakerLabel {
  if (t.speaker.kind === "captain") return { name: "The Captain", color: PALETTE.brassDark, band: "captain" };
  const mid = t.speaker.memberId;
  const m = crew.find((c) => c.memberId === mid);
  const color = m ? BANDS[m.band].hex : PALETTE.ink;
  if (t.speaker.kind === "human") return { name: `${m?.name ?? "Crew"} (hail)`, color, band: m?.band ?? 1 };
  return { name: `${m?.name ?? "A crew member"}'s mate`, color, band: m?.band ?? 1 };
}

/** Acts that pencil an arc from every origin to the city being discussed. */
export function drawsArcs(act: Act) { return act === "PROPOSE" || act === "SUPPORT" || act === "CONCEDE"; }
