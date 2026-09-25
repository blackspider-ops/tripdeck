/**
 * R2-WP-14 (O2-037): the `events` audit rows are batched. Rows appended within `delayMs` (or until `maxRows` are
 * waiting) go to the sink in one call (one `insertMany`), instead of one insert per emit. `flush()` sends what is
 * waiting at once (shutdown). A failed batch is the sink's to log; rows are never retried (the audit is best effort).
 */
export interface EventBufferOptions { delayMs: number; maxRows: number }

export class EventBuffer<T> {
  private rows: T[] = [];
  private timer?: NodeJS.Timeout;
  constructor(private readonly sink: (rows: T[]) => void, private readonly opts: EventBufferOptions) {}

  push(row: T) {
    this.rows.push(row);
    if (this.rows.length >= this.opts.maxRows) return this.flush();
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.opts.delayMs);
      this.timer.unref?.();
    }
  }

  /** Sends every waiting row now (one sink call), if any. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.rows.length) return;
    const rows = this.rows;
    this.rows = [];
    this.sink(rows);
  }

  get waiting() { return this.rows.length; }
}
