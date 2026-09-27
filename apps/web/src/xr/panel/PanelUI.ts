// The side panel's drawing kit (docs/03 §4 "Side panel"): a small immediate-mode layout that paints paper-card
// controls onto a 2D canvas and remembers where each control landed, so a ray's uv on the panel resolves to it.
// No three.js here: the view code and the hit testing run (and are tested) without WebGL.
import { PALETTE } from "@all-ayes/shared";

/** The part of CanvasRenderingContext2D the panel uses (a fake one in tests). */
export type Ctx2D = Pick<CanvasRenderingContext2D,
  "fillStyle" | "strokeStyle" | "lineWidth" | "font" | "textBaseline" | "textAlign" | "fillRect" | "strokeRect" | "fillText"
  | "measureText" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "drawImage" | "save" | "restore" | "rect" | "clip">;

export const FACES = {
  heading: "'AA Heading', 'Libre Caslon Text', Georgia, serif",
  body: "'AA Body', 'Source Serif 4', Georgia, serif",
  mono: "'AA Mono', 'IBM Plex Mono', ui-monospace, monospace",
} as const;

/** Sizes in canvas px. The panel is ~2000 px per metre, so 30 px ≈ 15 mm text at arm's length (doc 02 §4.2). */
export const SIZE = { title: 46, heading: 36, body: 30, small: 25, button: 30, chip: 27, big: 64 } as const;
export const PAD = 36;
/** Every control is at least this tall (a pinch target ~3 cm on the panel). */
export const TARGET_H = 72;

export interface Hit { x: number; y: number; w: number; h: number; id: string; onClick: () => void }

export interface ButtonOpts { primary?: boolean; disabled?: boolean; pressed?: boolean; id?: string; w?: number; red?: boolean }

/**
 * One frame of the panel: call the layout methods top to bottom; `hits` then lists every live control. `scroll`
 * shifts the content up (the panel draws what fits between `top` and `bottom`).
 */
export class PanelUI {
  y: number;
  readonly hits: Hit[] = [];
  private x = PAD;
  private rowH = 0;
  private inRow = false;

  constructor(readonly g: Ctx2D, readonly W: number, readonly H: number, readonly top = 0, readonly bottom = H, readonly scroll = 0) {
    this.y = top + PAD - scroll;
  }

  /** How far the content ran (for the scroll buttons). */
  get contentBottom() { return this.y + this.scroll; }
  private get inner() { return this.W - PAD * 2; }
  private visible(y: number, h: number) { return y + h > this.top && y < this.bottom; }

  private font(face: keyof typeof FACES, size: number) { this.g.font = `${size}px ${FACES[face]}`; }
  measure(text: string, face: keyof typeof FACES, size: number) { this.font(face, size); return this.g.measureText(text).width; }

  /** Word-wrapped lines of `text` within `width`. */
  wrap(text: string, face: keyof typeof FACES, size: number, width = this.inner): string[] {
    const out: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && this.measure(next, face, size) > width) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  }

  private endRow() {
    if (!this.inRow) return;
    this.inRow = false;
    this.y += this.rowH + 12;
    this.x = PAD;
    this.rowH = 0;
  }

  gap(h = 16) { this.endRow(); this.y += h; }

  text(text: string, o: { size?: number; face?: keyof typeof FACES; color?: string } = {}) {
    this.endRow();
    const size = o.size ?? SIZE.body, face = o.face ?? "body";
    const lh = Math.round(size * 1.35);
    this.g.textBaseline = "top"; this.g.textAlign = "left";
    for (const line of this.wrap(text, face, size)) {
      if (this.visible(this.y, lh)) { this.font(face, size); this.g.fillStyle = o.color ?? PALETTE.ink; this.g.fillText(line, PAD, this.y); }
      this.y += lh;
    }
    this.y += 6;
  }

  heading(text: string, size: number = SIZE.heading) { this.endRow(); this.y += 10; this.text(text, { size, face: "heading" }); }
  small(text: string) { this.text(text, { size: SIZE.small, color: PALETTE.inkSoft }); }

  /** A ruled line across the panel. */
  rule() {
    this.endRow();
    if (this.visible(this.y, 2)) { this.g.strokeStyle = PALETTE.paperDeep; this.g.lineWidth = 2; this.g.beginPath(); this.g.moveTo(PAD, this.y + 8); this.g.lineTo(this.W - PAD, this.y + 8); this.g.stroke(); }
    this.y += 20;
  }

  /** A paper button; full width unless `inline` (then it flows in a row with its neighbours). */
  button(label: string, onClick: () => void, o: ButtonOpts & { inline?: boolean } = {}) {
    const size = SIZE.button;
    const w = o.w ?? (o.inline ? Math.min(this.inner, this.measure(label, "heading", size) + 56) : this.inner);
    const h = TARGET_H;
    if (!o.inline) this.endRow();
    else if (this.inRow && this.x + w > this.W - PAD) this.endRow();
    const x = o.inline ? this.x : PAD, y = this.y;
    this.drawButton(label, x, y, w, h, o);
    if (!o.disabled && this.visible(y, h)) this.hits.push({ x, y, w, h, id: o.id ?? label, onClick });
    if (o.inline) { this.inRow = true; this.x += w + 12; this.rowH = Math.max(this.rowH, h); }
    else this.y += h + 12;
  }

  private drawButton(label: string, x: number, y: number, w: number, h: number, o: ButtonOpts) {
    if (!this.visible(y, h)) return;
    const g = this.g;
    const fill = o.primary ? PALETTE.soundingRed : o.pressed ? PALETTE.ink : PALETTE.paper;
    const ink = o.primary || o.pressed ? PALETTE.paper : o.red ? PALETTE.soundingRed : PALETTE.ink;
    g.fillStyle = PALETTE.paperDeep; g.fillRect(x + 3, y + 4, w, h); // the 2 px paper "stack", no blur
    g.fillStyle = fill; g.fillRect(x, y, w, h);
    g.strokeStyle = o.primary ? PALETTE.soundingRed : PALETTE.ink; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    this.font("heading", SIZE.button);
    g.fillStyle = o.disabled ? PALETTE.graphite : ink;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(label, x + w / 2, y + h / 2 + 1, w - 16);
    g.textAlign = "left"; g.textBaseline = "top";
    if (o.disabled) { g.fillStyle = "rgba(239,230,210,0.55)"; g.fillRect(x, y, w, h); }
  }

  /** Paper-tag chips that toggle (must-haves, dates…); `max` disables the rest once reached. */
  chips<T extends string>(options: readonly { id: T; label: string }[], value: readonly T[], onToggle: (id: T) => void, max = Infinity) {
    this.endRow();
    for (const o of options) {
      const on = value.includes(o.id);
      this.button(o.label, () => onToggle(o.id), { inline: true, pressed: on, disabled: !on && value.length >= max, id: `chip:${o.id}` });
    }
    this.endRow();
  }

  /** A big mono readout (a join code, an amount). */
  big(text: string, size: number = SIZE.big) {
    this.endRow();
    const h = Math.round(size * 1.25);
    if (this.visible(this.y, h)) { this.font("mono", size); this.g.fillStyle = PALETTE.ink; this.g.textBaseline = "top"; this.g.textAlign = "left"; this.g.fillText(text, PAD, this.y); }
    this.y += h + 6;
  }

  /** Two columns: a label and a right-aligned mono amount (the share ledger). */
  ledger(label: string, amount: string, bold = false) {
    this.endRow();
    const lh = 44;
    if (this.visible(this.y, lh)) {
      const g = this.g;
      g.textBaseline = "top"; g.textAlign = "left"; this.font(bold ? "heading" : "body", SIZE.body); g.fillStyle = PALETTE.ink;
      g.fillText(label, PAD, this.y, this.inner - 200);
      this.font("mono", SIZE.body); g.textAlign = "right"; g.fillText(amount, this.W - PAD, this.y); g.textAlign = "left";
    }
    this.y += lh;
  }

  /** An image (the join QR), `size` px square. */
  image(img: CanvasImageSource | null, size: number) {
    this.endRow();
    if (img && this.visible(this.y, size)) this.g.drawImage(img, PAD, this.y, size, size);
    this.y += size + 12;
  }

  /** A solid band swatch with a label (the crew list). */
  swatchRow(color: string, label: string, note: string) {
    this.endRow();
    const lh = 50;
    if (this.visible(this.y, lh)) {
      const g = this.g;
      g.fillStyle = color; g.fillRect(PAD, this.y + 6, 30, 30);
      this.font("body", SIZE.body); g.fillStyle = PALETTE.ink; g.textBaseline = "top"; g.textAlign = "left"; g.fillText(label, PAD + 46, this.y + 4);
      this.font("body", SIZE.small); g.fillStyle = PALETTE.inkSoft; g.textAlign = "right"; g.fillText(note, this.W - PAD, this.y + 8); g.textAlign = "left";
    }
    this.y += lh;
  }

  /** A keyboard: rows of keys filling the panel's width. */
  keys(rows: readonly (readonly string[])[], onKey: (k: string) => void, labels: Record<string, string> = {}) {
    this.endRow();
    const gap = 8;
    for (const row of rows) {
      const units = row.reduce((n, k) => n + (k === " " ? 4 : k.length > 1 ? 2 : 1), 0);
      const unit = (this.inner - gap * (row.length - 1)) / Math.max(units, 10);
      let x = PAD + (this.inner - (unit * units + gap * (row.length - 1))) / 2;
      for (const k of row) {
        const w = unit * (k === " " ? 4 : k.length > 1 ? 2 : 1);
        this.drawButton(labels[k] ?? (k === " " ? "space" : k), x, this.y, w, TARGET_H, {});
        if (this.visible(this.y, TARGET_H)) this.hits.push({ x, y: this.y, w, h: TARGET_H, id: `key:${k}`, onClick: () => onKey(k) });
        x += w + gap;
      }
      this.y += TARGET_H + gap;
    }
    this.y += 6;
  }

  /** The control under canvas point (x, y), or undefined. */
  hitAt(x: number, y: number): Hit | undefined {
    return hitAt(this.hits, x, y);
  }
}

/** The last-drawn control containing (x, y) (later ones are on top). */
export function hitAt(hits: readonly Hit[], x: number, y: number): Hit | undefined {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
  }
  return undefined;
}

/** A panel hit's uv (three.js PlaneGeometry: v = 0 at the bottom) → canvas px. */
export function uvToCanvas(uv: { x: number; y: number }, W: number, H: number) {
  return { x: uv.x * W, y: (1 - uv.y) * H };
}

export const QWERTY: readonly (readonly string[])[] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "'"],
  ["shift", "z", "x", "c", "v", "b", "n", "m", ",", "."],
  ["⌫", " ", "done"],
];
export const DIGITS: readonly (readonly string[])[] = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["⌫", "0", "done"]];

/** A key pressed on a text field's value (`shift` makes the next letter a capital). */
export function applyKey(value: string, key: string, o: { max: number; shift?: boolean; digitsOnly?: boolean }): string {
  if (key === "⌫") return value.slice(0, -1);
  if (key === "done" || key === "shift") return value;
  if (o.digitsOnly && !/^\d$/.test(key)) return value;
  if (value.length >= o.max) return value;
  return value + (o.shift ? key.toUpperCase() : key);
}
