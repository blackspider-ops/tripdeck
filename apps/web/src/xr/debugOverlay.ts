// In-headset debug card (the desk Quest likely has no USB devtools — doc 04 §10).
// Also relays console errors to the server so they show up at /api/debug/:tripId.
import * as THREE from "three";
import { PALETTE } from "@all-ayes/shared";
import type { TripStore } from "../net/tripStore";
import { disposeObject, paperCard } from "../scene/materials";
import { makeText, setText } from "../scene/text";
import type { Text } from "troika-three-text";

let relayInstalled = false;
let relayStore: TripStore | null = null;

export function installConsoleRelay(store: TripStore) {
  relayStore = store; // the page may remount with a fresh store; always relay through the live one
  if (relayInstalled) return;
  relayInstalled = true;
  const send = (level: "warn" | "error", args: unknown[]) => {
    try {
      relayStore?.emit("client:log", { level, msg: args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 500) });
    } catch { /* never throw from logging */ }
  };
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...a: unknown[]) => { origErr(...a); send("error", a); };
  console.warn = (...a: unknown[]) => { origWarn(...a); send("warn", a); };
  window.addEventListener("error", (e) => send("error", [e.message]));
  window.addEventListener("unhandledrejection", (e) => send("error", [String(e.reason)]));
}

export class DebugOverlay {
  readonly group = new THREE.Group();
  private text: Text;
  private lastEvent = "—";
  private acc = 0;
  private untap: () => void;

  constructor(private store: TripStore) {
    const card = paperCard(0.2, 0.09);
    this.text = makeText({ text: "", font: "mono", size: 0.0078, color: PALETTE.ink, anchorX: "left", anchorY: "top", lineHeight: 1.35 });
    this.text.position.set(-0.092, 0.04, 0.001);
    this.group.add(card, this.text);
    this.group.visible = false;
    this.untap = store.tap((ev) => { this.lastEvent = ev; });
  }

  update(dt: number, fps: number, drawCalls: number) {
    if (!this.group.visible) return;
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    const s = this.store.state;
    setText(this.text, [
      `fps ${fps}   draws ${drawCalls}`,
      `socket ${s.connected ? "connected" : "LOST"}`,
      `status ${s.trip?.status ?? "—"}  watch ${s.trip?.negotiation.watch ?? 0}`,
      `turns ${s.turns.length}   last ${this.lastEvent}`,
      s.error ? `error ${s.error.code}` : "",
    ].join("\n"));
  }

  /** Stop listening to the store and free the card (L2-007 / O2-053). */
  dispose() {
    this.untap();
    this.group.removeFromParent();
    disposeObject(this.group);
  }
}
