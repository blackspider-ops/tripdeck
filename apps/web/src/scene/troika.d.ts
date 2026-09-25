declare module "troika-three-text" {
  import { Mesh, Color, BufferGeometry, Material, Object3DEventMap } from "three";
  export interface TextEventMap extends Object3DEventMap {
    syncstart: object;
    synccomplete: object;
  }
  export class Text extends Mesh<BufferGeometry, Material, TextEventMap> {
    text: string;
    font: string | null;
    fontSize: number;
    color: string | number | Color;
    anchorX: number | "left" | "center" | "right" | string;
    anchorY: number | "top" | "top-baseline" | "middle" | "bottom-baseline" | "bottom" | string;
    maxWidth: number;
    textAlign: "left" | "right" | "center" | "justify";
    lineHeight: number | "normal";
    letterSpacing: number;
    clipRect: [number, number, number, number] | null;
    depthOffset: number;
    overflowWrap: "normal" | "break-word";
    textRenderInfo: { blockBounds: [number, number, number, number] } | null;
    sync(callback?: () => void): void;
    dispose(): void;
  }
  /** Renders its Text children in one draw call; they're packed, not scene children (their matrix is local to it). */
  export class BatchedText extends Text {}
  export function preloadFont(options: { font?: string; characters?: string | string[] }, callback: () => void): void;
}
