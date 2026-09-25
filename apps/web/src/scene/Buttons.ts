// Paper buttons for in-scene cards (wrist menu, hail card, "Back to the charts").
// Pressing moves the card 1 mm down — physical, never a glow.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import { paperCard } from "./materials";
import { makeText, setText } from "./text";
import type { Text } from "troika-three-text";
import { ease, type Tweens } from "./tween";

export interface Interactable {
  object: THREE.Object3D;
  onSelect: () => void;
  enabled?: () => boolean;
}

export class PaperButton {
  readonly group = new THREE.Group();
  readonly hit: THREE.Mesh;
  private label: Text;

  constructor(private tw: Tweens, text: string, w = 0.16, h = 0.028, primary = false) {
    this.hit = paperCard(w, h, (g, W, H) => {
      if (primary) { g.fillStyle = PALETTE.soundingRed; g.fillRect(0, 0, W, H - 8); }
      g.strokeStyle = PALETTE.ink; g.lineWidth = 5; g.strokeRect(4, 4, W - 8, H - 14);
    }, 512, primary ? "button-primary" : "button"); // same-size buttons share one texture
    this.label = makeText({ text, font: "heading", size: h * 0.42, color: primary ? PALETTE.paper : PALETTE.ink, maxWidth: w * 0.92, align: "center" });
    this.label.position.z = 0.0008;
    this.group.add(this.hit, this.label);
  }

  setLabel(t: string) { setText(this.label, t); }

  press() {
    return this.tw.to(160, (t) => (this.group.position.z = -0.001 * Math.sin(Math.PI * t)), ease.linear);
  }
}

/** A stack of paper buttons on a card with a heading. */
export class PaperMenu {
  readonly group = new THREE.Group();
  readonly buttons: { btn: PaperButton; onSelect: () => void }[] = [];

  constructor(tw: Tweens, title: string, items: { label: string; onSelect: () => void; primary?: boolean }[], w = 0.2) {
    const rowH = 0.034;
    const h = 0.04 + items.length * rowH;
    const back = paperCard(w + 0.02, h);
    back.position.z = -0.002;
    const heading = makeText({ text: title, font: "heading", size: 0.011, color: PALETTE.inkSoft, letterSpacing: 0.08 });
    heading.position.set(0, h / 2 - 0.015, 0.001);
    this.group.add(back, heading);
    items.forEach((it, i) => {
      const btn = new PaperButton(tw, it.label, w, 0.027, it.primary);
      btn.group.position.set(0, h / 2 - 0.038 - i * rowH, 0.002);
      this.group.add(btn.group);
      this.buttons.push({ btn, onSelect: () => { void btn.press(); it.onSelect(); } });
    });
  }

  interactables(enabled: () => boolean): Interactable[] {
    return this.buttons.map((b) => ({ object: b.btn.hit, onSelect: b.onSelect, enabled }));
  }
}
