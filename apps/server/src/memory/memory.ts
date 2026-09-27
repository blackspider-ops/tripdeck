/**
 * Advocate memory across voyages (docs/05-agent-spec.md §9).
 *
 * Backboard (when BACKBOARD_API_KEY is set) — https://docs.backboard.io
 *   base  https://app.backboard.io/api   (override with BACKBOARD_BASE_URL)
 *   auth  X-API-Key: <key>
 *   one assistant per person:  POST /assistants {name, system_prompt} → {assistant_id}
 *   save:   POST /assistants/{assistant_id}/memories {content, metadata}
 *   recall: GET  /assistants/{assistant_id}/memories?page=N&page_size=100 → {memories:[{id, content, created_at}], total_count, total_pages}
 *           (100 is the API's max page size; the docs state no sort order and offer no sort param, so recall reads
 *           page 1 and, for a longer thread, the last two pages, then orders by created_at — see fetchBackboard)
 * A local copy is always kept: in MongoDB when connected, else DATA_DIR/memory.json. Never stores raw caps — only a budget band.
 */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config, features } from "../config.js";
import { spend } from "../util/limits.js";
import { dbConnected, loadAll, persist } from "../store/db.js";
import { JsonStore } from "../util/jsonStore.js";
import { withAbort } from "../util/timeout.js";
import { Lru, MINUTE_MS } from "../util/limits.js";

/**
 * SEC-003 / TR4-007 / TR5-018: a person's memory thread is keyed on a private, unguessable **crew key** (256 random
 * bits minted at their first join and kept on their phone), never on public display data. Only the key's hash is
 * stored (on the member record, here and at Backboard); the name is added so two people sharing one phone keep
 * separate threads. No crew key → no thread → nothing recalled.
 */
export const crewKeyHash = (crewKey: string) => createHash("sha256").update(`all-ayes-crew:${crewKey}`).digest("hex");
export const personKey = (keyHash: string, name: string) => `crew:${keyHash}|${name.trim().toLowerCase()}`;
/** A crew key the client sent is usable only if it looks like one we mint (base64url, ≥ 32 chars). */
export const validCrewKey = (k: unknown): k is string => typeof k === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(k);

// ---------- local store (OPT-039 / TR5-008 / TR5-009 / TR5-019) ----------
/**
 * The local copy of every thread and the personKey → Backboard assistant map. Loaded once per process (async) and
 * then served from memory; every change is written through. With MongoDB connected they live in the `memories` /
 * `backboard_assistants` collections (survive a redeploy); otherwise in DATA_DIR as JSON (atomic writes, serialized).
 * No directory is created at import, and an unwritable disk only degrades to in-memory (one warning, `memoryHealth`).
 */
const KEEP = 20;
/** O2-033: a recall gives the last RECALL_LINES lines; the cached Backboard thread keeps its newest BB_KEEP. */
const RECALL_LINES = 5;
const BB_KEEP = 25;
/** Backboard's largest page (docs: page_size ≤ 100). */
const BB_PAGE_SIZE = 100;
/** A Backboard call that hangs gives up after this; after a failure, joins use the local copy for BB_DOWN_MS. */
const BB_TIMEOUT_MS = 5_000;
const BB_DOWN_MS = MINUTE_MS;
type Threads = Record<string, string[]>;
type Assistants = Record<string, string>;

interface Local<T extends object> {
  read(): Promise<T>;
  /** L5-005: the data and whether it really loaded (a failed load reads as empty, and must not be written back). */
  readOk(): Promise<{ d: T; ok: boolean }>;
  /** O2-041: `keys` names the entries `fn` may change, so a keyed store writes (and compares) only those. */
  update(fn: (d: T) => void, keys?: string[]): Promise<unknown>;
  degraded(): string | null; loads(): number;
}

function fileLocal<T extends object>(name: string): Local<T> {
  const store = new JsonStore<T>(join(config.dataDir, name), () => ({}) as T);
  return { read: () => store.read(), readOk: async () => ({ d: await store.read(), ok: true }), update: (fn) => store.update(fn), degraded: () => store.degraded, loads: () => store.loads };
}

type MemCol = "memories" | "backboard_assistants";

/**
 * Mongo-backed: one doc per key (`{_id: key, v}`), all loaded once; writes are the existing fire-and-forget upsert.
 * L5-005: a failed load is never cached. That call reads as empty, the next one tries again, and an update on a
 * failed load writes nothing (writing `{}`+1 line would replace the person's stored thread).
 */
function mongoLocal<T extends Record<string, unknown>>(col: MemCol): Local<T> {
  let data: Promise<T> | null = null;
  let loads = 0;
  let failed: string | null = null;
  const load = () => (data ??= (async () => {
    loads++;
    const docs = await loadAll<{ _id: string; v: unknown }>(col);
    failed = null;
    return Object.fromEntries(docs.map((d) => [d._id, d.v])) as T;
  })());
  const readOk = async (): Promise<{ d: T; ok: boolean }> => {
    const p = load();
    try {
      return { d: await p, ok: true };
    } catch (e) {
      if (data === p) data = null; // not cached: the next call loads again
      failed = (e as Error).message;
      console.warn(`[memory] could not load ${col} from MongoDB (reading as empty for now):`, failed);
      return { d: {} as T, ok: false };
    }
  };
  return {
    read: async () => (await readOk()).d,
    readOk,
    update: async (fn, keys) => {
      const { d, ok } = await readOk();
      if (!ok) { console.warn(`[memory] ${col} not loaded; this change is not stored locally`); return; }
      // O2-041: with `keys`, only those entries are compared and written (not a re-serialize of every thread)
      const watched = keys ?? Object.keys(d);
      const before = new Map(watched.map((k) => [k, JSON.stringify(d[k])]));
      fn(d);
      for (const k of keys ?? Object.keys(d)) {
        const v = d[k];
        if (v !== undefined && before.get(k) !== JSON.stringify(v)) persist(col, { _id: k, v });
      }
    },
    degraded: () => failed,
    loads: () => loads,
  };
}

let locals: { threads: Local<Threads>; assistants: Local<Assistants>; kind: "mongo" | "file" } | null = null;
/** Chosen on first use (after connectDb at boot); switched to MongoDB once it connects later (useMongoMemory). */
const mongoLocals = () => ({ threads: mongoLocal<Threads>("memories"), assistants: mongoLocal<Assistants>("backboard_assistants"), kind: "mongo" as const });
const local = () => (locals ??= dbConnected()
  ? mongoLocals()
  : { threads: fileLocal<Threads>("memory.json"), assistants: fileLocal<Assistants>("backboard-assistants.json"), kind: "file" });

/**
 * L5-003: MongoDB connected after the process started on the local files (a failed boot connect). What was written
 * to the files meanwhile is merged into MongoDB (thread lines appended, deduplicated, last KEEP kept; an assistant
 * id already in MongoDB wins), and from now on memory lives there, so the next boot (which reads MongoDB) sees it
 * and no second Backboard assistant is made for the same person. No-op unless the files were in use.
 */
export async function useMongoMemory(): Promise<void> {
  if (!dbConnected() || locals?.kind !== "file") return;
  const file = locals;
  const mongo = mongoLocals();
  const [threads, assistants] = await Promise.all([file.threads.read(), file.assistants.read()]);
  const [t, a] = await Promise.all([mongo.threads.readOk(), mongo.assistants.readOk()]);
  if (!t.ok || !a.ok) throw new Error("MongoDB memory collections could not be loaded; staying on local files");
  await mongo.threads.update((all) => {
    for (const [k, lines] of Object.entries(threads)) {
      const stored = all[k] ?? [];
      const extra = (lines ?? []).filter((l) => !stored.includes(l));
      if (extra.length) all[k] = [...stored, ...extra].slice(-KEEP);
    }
  });
  await mongo.assistants.update((all) => { for (const [k, id] of Object.entries(assistants)) all[k] ??= id; });
  if (locals === file) locals = mongo;
}

/** Backboard recall results, per person, for this process (we're the only writer, so `remember` keeps it fresh). */
const BACKBOARD_TTL_MS = 30 * MINUTE_MS;
/** O2-041: an LRU (entries past the TTL are only skipped on read), so it can't grow with every person ever recalled. */
const BB_CACHE_MAX = 2_000;
const bbCache = new Lru<string, { at: number; items: string[] }>(BB_CACHE_MAX);
const inflight = new Map<string, Promise<string[] | null>>();
/** After a Backboard failure, joins use the local copy for a minute instead of each waiting out the 5 s timeout. */
let bbDownUntil = 0;
const creating = new Map<string, Promise<string>>();

/** For /api/health: where memory lives and whether it's degraded (TR5-019). */
export function memoryHealth() {
  const l = locals;
  const degraded = l ? l.threads.degraded() ?? l.assistants.degraded() : null;
  return { store: features.backboard() ? "backboard" : (l?.kind ?? (dbConnected() ? "mongo" : "file")), local: l?.kind ?? null, degraded };
}

/** Test hook: how many times the local threads were loaded, and drop every cache (simulates a restart). */
export const __memoryTest = {
  loads: () => locals?.threads.loads() ?? 0,
  reset: () => { locals = null; bbDownUntil = 0; bbCache.clear(); inflight.clear(); creating.clear(); },
};

// ---------- Backboard ----------
const base = () => (config.backboard.baseUrl || "https://app.backboard.io/api").replace(/\/$/, "");
const headers = () => ({ "X-API-Key": config.backboard.apiKey, "Content-Type": "application/json" });

async function bb<T>(method: string, path: string, body?: unknown): Promise<T> {
  // SEC-005: Backboard budget spent → callers fall back to the local memory
  if (!spend("backboard")) throw new Error("Backboard budget spent");
  return withAbort(BB_TIMEOUT_MS, async (signal) => {
    const res = await fetch(base() + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined, signal });
    if (!res.ok) throw new Error(`Backboard ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 160)}`);
    return (await res.json()) as T;
  });
}

/** One assistant per person: concurrent callers for the same key share one creation, and the map never loses keys. */
async function assistantFor(key: string): Promise<string> {
  const { d, ok } = await local().assistants.readOk();
  if (d[key]) return d[key];
  // L5-005: the map didn't load, so "no assistant yet" is unknown; making one now would orphan the person's memories
  if (!ok) throw new Error("the assistant map is not loaded");
  let p = creating.get(key);
  if (!p) {
    p = (async () => {
      const created = await bb<{ assistant_id: string }>("POST", "/assistants", {
        name: `Tripdeck mate · ${key.split("|").pop()}`.slice(0, 255),
        system_prompt: "You remember one traveller's preferences across group trips: what they liked, what they conceded, and their budget band (never exact amounts).",
      });
      await local().assistants.update((m) => { m[key] = created.assistant_id; });
      return created.assistant_id;
    })().finally(() => creating.delete(key));
    creating.set(key, p);
  }
  return p;
}

// ---------- public API ----------
/**
 * OPT-039: the last RECALL_LINES lines of a person's thread. Served from memory after the first load: the local store is read
 * once per process, and a Backboard thread is fetched once per person (then kept fresh by `remember`), so member
 * joins and replays never hit the network or the disk again. Concurrent recalls for one person share one fetch.
 */
export async function recall(key: string): Promise<string[]> {
  if (features.backboard() && Date.now() >= bbDownUntil) {
    const hit = bbCache.get(key);
    if (hit && Date.now() - hit.at < BACKBOARD_TTL_MS) return hit.items.slice(-RECALL_LINES);
    let p = inflight.get(key);
    if (!p) {
      p = fetchBackboard(key).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const items = await p;
    if (items) return items.slice(-RECALL_LINES);
  }
  return ((await local().threads.read())[key] ?? []).slice(-RECALL_LINES);
}

type BbMemory = { id?: string; content: string; created_at?: string | null };
type BbPage = { memories?: BbMemory[]; total_count?: number | null; total_pages?: number | null };

/**
 * A person's thread, oldest → newest, newest BB_KEEP kept. Backboard's list documents no order and no sort param, so
 * a thread longer than one page (BB_PAGE_SIZE) is read on page 1 plus the last two pages: whether the API lists
 * newest-first (page 1) or oldest-first (the last page, topped up by the one before it if it is short), the newest
 * lines are among them. At most 3 calls, whatever the thread's length. Overlaps (a write between calls) are deduped.
 */
async function fetchBackboard(key: string): Promise<string[] | null> {
  try {
    const id = await assistantFor(key);
    const page = (n: number) => bb<BbPage>("GET", `/assistants/${id}/memories?page=${n}&page_size=${BB_PAGE_SIZE}`);
    const first = await page(1);
    const got = first.memories ?? [];
    const pages = first.total_pages ?? (first.total_count ? Math.ceil(first.total_count / BB_PAGE_SIZE) : 1);
    const more = [...new Set([pages - 1, pages])].filter((n) => n > 1);
    for (const r of await Promise.all(more.map(page))) got.push(...(r.memories ?? []));
    const seen = new Set<string>();
    const items = got
      .filter((m) => { const k = m.id ?? `${m.created_at ?? ""}|${m.content}`; return seen.has(k) ? false : (seen.add(k), true); })
      .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
      .map((m) => m.content)
      .slice(-BB_KEEP);
    bbCache.set(key, { at: Date.now(), items });
    return items;
  } catch (e) {
    bbDownUntil = Date.now() + BB_DOWN_MS;
    console.warn("[memory] Backboard recall failed, using local:", (e as Error).message);
    return null;
  }
}

export async function remember(key: string, text: string): Promise<void> {
  return rememberAll([{ key, text }]);
}

/**
 * O2-041: a voyage's notes, one per member, in one local write (one file rewrite, or one upsert per changed thread),
 * then the Backboard writes in parallel. Keep a local copy either way (works offline at Expo). An unwritable disk
 * never stops the Backboard write (TR5-019).
 */
export async function rememberAll(notes: { key: string; text: string }[]): Promise<void> {
  if (!notes.length) return;
  try {
    await local().threads.update((all) => {
      for (const { key, text } of notes) all[key] = [...(all[key] ?? []), text].slice(-KEEP);
    }, [...new Set(notes.map((n) => n.key))]);
  } catch (e) {
    console.warn("[memory] local write failed:", (e as Error).message);
  }
  for (const { key, text } of notes) {
    const hit = bbCache.peek(key);
    if (hit) hit.items = [...hit.items, text].slice(-BB_KEEP);
  }
  if (!features.backboard()) return;
  await Promise.all(notes.map(async ({ key, text }) => {
    try {
      const id = await assistantFor(key);
      await bb("POST", `/assistants/${id}/memories`, { content: text, metadata: { source: "all-ayes", person: key } });
    } catch (e) {
      console.warn("[memory] Backboard write failed (kept locally):", (e as Error).message);
    }
  }));
}

