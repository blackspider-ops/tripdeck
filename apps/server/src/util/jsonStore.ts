/**
 * TR5-009 / OPT-024 / TR5-019: a small JSON file store that
 *  - loads once (async) and then serves reads from memory,
 *  - serializes every read-modify-write through one promise chain, so concurrent updates never drop each other,
 *  - writes atomically (tmp file + rename): a crash mid-write leaves the previous file intact,
 *  - keeps a corrupt file as `<file>.corrupt-<ts>` instead of treating it as empty and overwriting it,
 *  - never throws on an unwritable disk (read-only FS, EACCES): it warns once, flags itself degraded and keeps
 *    working in memory.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** Parse a JSON file; `fallback` when missing. A corrupt file is renamed aside (never silently lost). */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    await rename(file, aside).catch(() => undefined);
    console.warn(`[store] ${file} was not valid JSON; kept it as ${aside} and started empty`);
    return fallback;
  }
}

/** Write JSON atomically: a temp file in the same dir, then rename over the target. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data)); // O2-041: compact (the file is rewritten whole on every change)
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

export class JsonStore<T extends object> {
  private data: T | null = null;
  private readFailed = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** Why the disk is not usable (first error), or null while writes succeed. */
  degraded: string | null = null;
  /** How many times the file has been read (tests assert it's once). */
  loads = 0;

  constructor(readonly file: string, private readonly empty: () => T) {}

  /** The current contents (loaded from disk on first use). Treat as read-only; change it with `update`. */
  read(): Promise<T> {
    return this.enqueue(async () => this.load());
  }

  /** Serialized read-modify-write. `fn` mutates the data in place (or returns a replacement); then it's saved. */
  update(fn: (data: T) => T | void): Promise<T> {
    return this.enqueue(async () => {
      const cur = await this.load();
      this.data = fn(cur) ?? cur;
      await this.save();
      return this.data;
    });
  }

  private enqueue<R>(job: () => Promise<R>): Promise<R> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<T> {
    if (this.data) return this.data;
    this.loads++;
    try {
      this.data = await readJson<T>(this.file, this.empty());
    } catch (e) {
      // Unreadable (not missing, not corrupt): never overwrite what we couldn't read.
      this.markDegraded(e);
      this.readFailed = true;
      this.data = this.empty();
    }
    return this.data;
  }

  private async save() {
    if (this.readFailed) return;
    try {
      await writeJsonAtomic(this.file, this.data);
    } catch (e) {
      this.markDegraded(e); // keep serving from memory; the disk just doesn't remember across restarts
    }
  }

  private markDegraded(e: unknown) {
    if (this.degraded) return;
    this.degraded = `${(e as NodeJS.ErrnoException).code ?? "error"}: ${(e as Error).message}`;
    console.warn(`[store] ${this.file} is not writable (${this.degraded}); keeping it in memory only until restart`);
  }
}
