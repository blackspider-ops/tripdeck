// The side panel (docs/03 §4 "Side panel"): a paper log book floating beside the chart table in the headset, with
// the voyage's text-heavy parts (views.ts) drawn onto a canvas texture. Pinch/ray a control on it, drag its top bar
// to move it, pinch × to put it away (the "Log book" tab on the table brings it back). Quest Browser has no DOM
// overlay in immersive sessions, so text entry is the panel's own keyboard and keypad.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import type { TripStore } from "../../net/tripStore";
import type { Interactable } from "../../scene/Buttons";
import { paintPaper } from "../../scene/materials";
import { FACES, PanelUI, hitAt, uvToCanvas, type Hit } from "./PanelUI";
import { drawPanel, newPanelState, type PanelCtx, type PanelState, type Viewer } from "./views";

/** Canvas size (px) and the panel's size in the room (m): ~2000 px per metre. */
export const PANEL_PX = { W: 880, H: 1200 } as const;
export const PANEL_M = { w: 0.44, h: 0.6 } as const;
/** The grab bar along the top and the scroll footer along the bottom (px). */
export const BAR_PX = 76;
export const FOOT_PX = 96;
/** Where the panel opens, in the chart's frame (m): right of the chart, raised, a little toward the viewer. */
export const PANEL_HOME = new THREE.Vector3(0.52, 0.3, 0.14);

export interface SideOpts {
  viewer: Viewer;
  /** The member's REST credentials (seal PIN / passkey status); none on a shared headset. */
  rest?: { tripId: string; token: string };
  api?: {
    passkeyStatus(tripId: string, token: string): Promise<{ registered: boolean; required?: boolean; pin?: boolean }>;
    setSealPin(tripId: string, token: string, pin: string): Promise<unknown>;
  };
  host: string;
  origin: string;
}

let fontsOnce: Promise<void> | null = null;
/** The chart room's bundled faces, for the canvas (the page may not have loaded them itself). */
function loadFonts(): Promise<void> {
  if (fontsOnce) return fontsOnce;
  const faces: [string, string][] = [["AA Heading", "/textures/type/caslon-text.woff"], ["AA Body", "/textures/type/source-serif.woff"], ["AA Mono", "/textures/type/plex-mono.woff"]];
  fontsOnce = typeof FontFace === "undefined" || typeof document === "undefined" ? Promise.resolve()
    : Promise.all(faces.map(([name, url]) => new FontFace(name, `url(${url})`).load().then((f) => { (document.fonts as unknown as { add(f: FontFace): void }).add(f); }).catch(() => undefined))).then(() => undefined);
  return fontsOnce;
}

export class SidePanel {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly state: PanelState = newPanelState();
  private canvas: HTMLCanvasElement;
  private tex: THREE.CanvasTexture;
  private hits: Hit[] = [];
  private dirty = true;
  private contentH = 0;
  private qr: HTMLImageElement | null = null;
  private qrFor = "";
  private seal: PanelCtx["seal"] = null;
  private sealAsked = false;
  private drag: { dist: number; offset: THREE.Vector3; moved: boolean } | null = null;
  private unsub: () => void;
  private tmp = new THREE.Vector3();
  /** A redraw was asked (tests read it). */
  draws = 0;

  constructor(private store: TripStore, private o: SideOpts) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = PANEL_PX.W; this.canvas.height = PANEL_PX.H;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_M.w, PANEL_M.h), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }));
    // a walnut board behind the paper (no glow, no glass)
    const back = new THREE.Mesh(new THREE.BoxGeometry(PANEL_M.w + 0.016, PANEL_M.h + 0.016, 0.008), new THREE.MeshStandardMaterial({ color: PALETTE.woodDark, roughness: 0.65 }));
    back.position.z = -0.0045;
    this.group.add(back, this.mesh);
    this.group.visible = false;
    this.unsub = store.subscribe(() => { this.dirty = true; });
    void loadFonts().then(() => { this.dirty = true; });
  }

  get open() { return this.group.visible; }

  /** Open beside the chart (`anchor` = the chart's frame), turned to face the viewer at `eye`. */
  openBeside(anchor: THREE.Object3D, eye: THREE.Vector3) {
    anchor.updateMatrixWorld();
    this.group.position.copy(anchor.localToWorld(this.tmp.copy(PANEL_HOME)));
    this.face(eye);
    this.group.visible = true;
    this.dirty = true;
  }
  close() { this.group.visible = false; this.state.focus = null; }
  toggle(anchor: THREE.Object3D, eye: THREE.Vector3) { if (this.open) this.close(); else this.openBeside(anchor, eye); }
  /** Open on a tab (e.g. the approval prompt pops it open). */
  show(tab: PanelState["tab"], anchor: THREE.Object3D, eye: THREE.Vector3) { this.state.tab = tab; if (!this.open) this.openBeside(anchor, eye); this.dirty = true; }

  /** Turn to the viewer about the vertical only (doc 02 §4.2: text faces the user, no roll). */
  private face(eye: THREE.Vector3) {
    const p = this.group.position;
    this.group.rotation.set(0, Math.atan2(eye.x - p.x, eye.z - p.z), 0);
  }

  private ctx(): PanelCtx {
    const t = this.store.state.trip;
    const want = t ? `${this.o.origin}/t/${t.joinCode}` : "";
    if (want && want !== this.qrFor) { this.qrFor = want; void this.makeQr(want); }
    const tab = this.state.tab;
    if (tab === "seal" && !this.sealAsked && this.o.rest && this.o.api) { this.sealAsked = true; void this.fetchSeal(); }
    return {
      state: this.store.state, viewer: this.o.viewer, emit: this.store.emit.bind(this.store), qr: this.qr, host: this.o.host, seal: this.seal,
      redraw: () => { this.dirty = true; },
      clearDeclined: (id) => this.store.clearDeclined(id),
      setSealPin: async (pin) => {
        if (!this.o.rest || !this.o.api) return "Set a seal PIN from the Enter card.";
        try { await this.o.api.setSealPin(this.o.rest.tripId, this.o.rest.token, pin); await this.fetchSeal(); return null; }
        catch (e) { return e instanceof Error && e.message ? e.message : "Couldn't save the PIN."; }
      },
    };
  }

  private async fetchSeal() {
    try {
      const s = await this.o.api!.passkeyStatus(this.o.rest!.tripId, this.o.rest!.token);
      this.seal = { pin: Boolean(s.pin), passkey: Boolean(s.required) };
    } catch { this.seal = { pin: false, passkey: false }; }
    this.dirty = true;
  }

  private async makeQr(value: string) {
    try {
      const mod = await import("qrcode");
      const QR = (mod as unknown as { default?: typeof mod }).default ?? mod;
      const url = await QR.toDataURL(value, { margin: 1, width: 600, color: { dark: PALETTE.ink, light: PALETTE.paper }, errorCorrectionLevel: "M" });
      const img = new Image();
      img.onload = () => { if (this.qrFor === value) { this.qr = img; this.dirty = true; } };
      img.src = url;
    } catch { /* the code is printed under it */ }
  }

  /** Paint now (normally from `update`, at most once a frame). */
  redraw() {
    const g = this.canvas.getContext("2d");
    if (!g) return;
    this.draws++;
    const { W, H } = PANEL_PX;
    paintPaper(g, W, H, PALETTE.paper, 7);
    // the grab bar: brass rule, a title, and × to put the panel away
    g.fillStyle = PALETTE.paperDeep; g.fillRect(0, 0, W, BAR_PX);
    g.strokeStyle = PALETTE.brassDark; g.lineWidth = 3; g.beginPath(); g.moveTo(0, BAR_PX); g.lineTo(W, BAR_PX); g.stroke();
    g.fillStyle = PALETTE.ink; g.font = `30px ${FACES.heading}`; g.textBaseline = "middle"; g.textAlign = "left";
    g.fillText("≡  Log book · drag here to move", 28, BAR_PX / 2);
    g.textAlign = "center"; g.font = `40px ${FACES.heading}`; g.fillText("×", W - 44, BAR_PX / 2 + 2); g.textAlign = "left";
    // the content, clipped between the bar and the footer
    g.save(); g.beginPath(); g.rect(0, BAR_PX, W, H - BAR_PX - FOOT_PX); g.clip();
    const ui = new PanelUI(g, W, H, BAR_PX, H - FOOT_PX, this.state.scroll);
    drawPanel(ui, this.state, this.ctx());
    g.restore();
    this.contentH = ui.contentBottom - BAR_PX;
    const hits = [...ui.hits];
    hits.push({ x: W - 88, y: 0, w: 88, h: BAR_PX, id: "close", onClick: () => this.close() });
    // the footer: scroll buttons when the content runs past the panel
    const room = H - BAR_PX - FOOT_PX;
    const foot = new PanelUI(g, W, H, H - FOOT_PX, H);
    foot.y = H - FOOT_PX + 12;
    if (this.contentH > room) {
      const step = room * 0.8;
      foot.button("▲ Up", () => { this.state.scroll = Math.max(0, this.state.scroll - step); this.dirty = true; }, { inline: true, disabled: this.state.scroll <= 0, w: 250 });
      foot.button("▼ Down", () => { this.state.scroll = Math.min(this.contentH - room + 40, this.state.scroll + step); this.dirty = true; }, { inline: true, disabled: this.state.scroll >= this.contentH - room + 40, w: 250 });
      hits.push(...foot.hits);
    }
    this.hits = hits;
    this.tex.needsUpdate = true;
  }

  /** Per frame: repaint if anything changed. */
  update() { if (this.dirty && this.open) { this.dirty = false; this.redraw(); } }

  /** Pinch/click at a canvas point: the control there, if any. Returns its id (tests). */
  clickAt(x: number, y: number): string | undefined {
    const h = hitAt(this.hits, x, y);
    if (!h) return undefined;
    h.onClick();
    this.dirty = true;
    return h.id;
  }

  /** The panel's targets for the inputs: the paper (controls, by uv) with its grab bar (drag to move). */
  interactables(eye: () => THREE.Vector3): Interactable[] {
    return [{
      object: this.mesh,
      enabled: () => this.open,
      onSelect: (hit) => { if (hit?.uv) { const p = uvToCanvas(hit.uv, PANEL_PX.W, PANEL_PX.H); this.clickAt(p.x, p.y); } },
      onPress: (_ray, hit) => {
        const p = hit.uv ? uvToCanvas(hit.uv, PANEL_PX.W, PANEL_PX.H) : null;
        this.drag = p && p.y <= BAR_PX && p.x < PANEL_PX.W - 88 ? { dist: hit.distance, offset: hit.point.clone().sub(this.group.position), moved: false } : null;
      },
      onDrag: (ray) => {
        const d = this.drag;
        if (!d) return;
        ray.at(d.dist, this.tmp).sub(d.offset);
        if (this.tmp.distanceTo(this.group.position) > 0.002) d.moved = true;
        this.group.position.copy(this.tmp);
        this.face(eye());
      },
      onRelease: () => { const moved = Boolean(this.drag?.moved); this.drag = null; return moved; },
    }];
  }

  dispose() {
    this.unsub();
    this.tex.dispose();
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.group.removeFromParent();
  }
}
