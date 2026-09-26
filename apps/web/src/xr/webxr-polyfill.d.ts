// webxr-polyfill ships no types; only the constructor is used (xr/cardboard.ts).
declare module "webxr-polyfill" {
  export interface WebXRPolyfillConfig {
    global?: unknown;
    webvr?: boolean;
    cardboard?: boolean;
    allowCardboardOnDesktop?: boolean;
    cardboardConfig?: Record<string, unknown> | null;
  }
  export default class WebXRPolyfill {
    constructor(config?: WebXRPolyfillConfig);
    readonly nativeWebXR: boolean;
    readonly injected: boolean;
  }
}
