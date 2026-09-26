// Keeps a renderer the size of its container (not the window). A Gallery tab opened in the background got its canvas
// sized while hidden and only ~60% of the window wide once shown: hidden tabs get no ResizeObserver callbacks (they
// run in the rendering steps), and the old fallback to window.innerWidth could read a size that wasn't the page's.
// So the size is read from the container only, on every ResizeObserver callback, window resize, focus and
// visibilitychange, and cheaply once a frame (`check()`), and applied whenever it changes.

export interface ContainerSizeOptions {
  /** Where resize / focus / visibilitychange come from (a test passes its own). */
  win?: Window;
}

export class ContainerSize {
  private w = 0;
  private h = 0;
  private dpr = 0;
  private ro: ResizeObserver | null = null;
  private readonly win: Window;

  /**
   * `apply(w, h)` gets the container's CSS pixel size whenever it changes (never 0 × 0: a container not laid out yet
   * is skipped until it is). It returns false when it couldn't apply it (e.g. an XR session is presenting); the size
   * is then tried again on the next check.
   */
  constructor(private readonly el: HTMLElement, private readonly apply: (w: number, h: number) => boolean | void, opts: ContainerSizeOptions = {}) {
    this.win = opts.win ?? window;
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.check());
      this.ro.observe(el);
    }
    this.win.addEventListener("resize", this.onEvent);
    this.win.addEventListener("focus", this.onEvent);
    this.win.addEventListener("pageshow", this.onEvent);
    this.win.document.addEventListener("visibilitychange", this.onEvent);
    this.check();
  }

  private onEvent = () => { this.check(); };

  /**
   * Applies the container's size if it (or the device pixel ratio) changed, or `force`. Cheap when nothing changed:
   * two layout reads.
   */
  check(force = false): boolean {
    const w = this.el.clientWidth, h = this.el.clientHeight, dpr = this.win.devicePixelRatio || 1;
    if (!w || !h) return false;
    if (!force && w === this.w && h === this.h && dpr === this.dpr) return false;
    if (this.apply(w, h) === false) return false;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    return true;
  }

  /** The size last applied (0 × 0 until the container has one). */
  get size(): { w: number; h: number } { return { w: this.w, h: this.h }; }

  dispose() {
    this.ro?.disconnect();
    this.win.removeEventListener("resize", this.onEvent);
    this.win.removeEventListener("focus", this.onEvent);
    this.win.removeEventListener("pageshow", this.onEvent);
    this.win.document.removeEventListener("visibilitychange", this.onEvent);
  }
}
