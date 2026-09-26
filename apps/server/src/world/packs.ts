/**
 * Generated packs: built once per OSM place, then served from memory and DATA_DIR/world/<id>.json (a pack never
 * changes unless the builder's PACK_VERSION does), so Overpass is asked at most once per place per server — and a
 * restart, or a voyage restored from storage, gets the same pack back without the network.
 * Concurrent requests for one place share one build.
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CityPack, OsmRef } from "@all-ayes/shared";
import { config } from "../config.js";
import { Lru } from "../util/limits.js";
import { buildCityPack, packIdFor, PACK_VERSION, type BuildDeps } from "./pack.js";
import { lookupPlace, type WorldPlace } from "./nominatim.js";

const dir = () => join(config.dataDir, "world", "packs");
const fileOf = (id: string) => join(dir(), `${id.replace(/[^A-Za-z0-9-]/g, "")}.json`);

const memory = new Lru<string, CityPack>(500);
const building = new Map<string, Promise<CityPack>>();

/** A usable stored pack (right shape, current builder). */
export function isPack(x: unknown): x is CityPack {
  const p = x as CityPack;
  return Boolean(p?.city?._id && Array.isArray(p.hotels) && Array.isArray(p.activities) && p.meta?.version === PACK_VERSION);
}

export async function readStoredPack(id: string): Promise<CityPack | undefined> {
  const hit = memory.get(id);
  if (hit) return hit;
  try {
    const p = JSON.parse(await readFile(fileOf(id), "utf8")) as unknown;
    if (isPack(p)) { memory.set(id, p); return p; }
  } catch { /* missing or unreadable: rebuild */ }
  return undefined;
}

async function store(p: CityPack) {
  memory.set(p.city._id, p);
  try {
    await mkdir(dir(), { recursive: true });
    const tmp = `${fileOf(p.city._id)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(p));
    await rename(tmp, fileOf(p.city._id));
  } catch (e) {
    console.warn(`[world] pack ${p.city._id} kept in memory only: ${(e as Error).message}`);
  }
}

// ---------- the loader hook (data/loader.ts `addCityPack`, when it exists) ----------
type AddCityPack = (pack: CityPack) => unknown;
let adder: AddCityPack | null | undefined; // undefined = not looked up yet, null = the loader has none
const registered = new Set<string>();

/** Tests: install (or clear) the loader hook instead of looking it up. */
export function setAddCityPack(fn: AddCityPack | null | undefined) { adder = fn; registered.clear(); registering.clear(); }

async function loaderHook(): Promise<AddCityPack | null> {
  if (adder !== undefined) return adder;
  try {
    const mod = (await import("../data/loader.js")) as Record<string, unknown>;
    adder = typeof mod.addCityPack === "function" ? (mod.addCityPack as AddCityPack) : null;
  } catch {
    adder = null;
  }
  return adder;
}

const registering = new Map<string, Promise<boolean>>();
/** Hands a pack to the loader once per process (a no-op until the loader exports addCityPack). true = registered. */
export function registerPack(p: CityPack): Promise<boolean> {
  const id = p.city._id;
  if (registered.has(id)) return Promise.resolve(true);
  let job = registering.get(id);
  if (!job) {
    job = (async () => {
      const add = await loaderHook();
      if (!add) return false;
      try {
        await add(p);
        registered.add(id);
        return true;
      } catch (e) {
        // the port is already in the dataset (registered earlier, or restored with its voyage): that's the goal
        if (/already exists/.test((e as Error).message) && /port /.test((e as Error).message)) { registered.add(id); return true; }
        console.warn(`[world] addCityPack(${id}) failed: ${(e as Error).message}`);
        return false;
      }
    })().finally(() => registering.delete(id));
    registering.set(id, job);
  }
  return job;
}

export interface PackResult { pack: CityPack; cached: boolean; registered: boolean }

/**
 * The pack for an OSM place: stored → built (Nominatim lookup for the place unless given, then Overpass).
 * Throws NOT_FOUND-style HelmErrors from the caller's side (unknown place), UpstreamBusy, or PackTooSparse.
 */
export async function packFor(osmId: OsmRef, opts: { place?: WorldPlace; deps?: BuildDeps } = {}): Promise<PackResult | null> {
  const id = packIdFor(osmId);
  const stored = await readStoredPack(id);
  if (stored) return { pack: stored, cached: true, registered: await registerPack(stored) };
  let job = building.get(id);
  if (!job) {
    job = (async () => {
      const place = opts.place ?? (await lookupPlace(osmId));
      if (!place) throw Object.assign(new Error("no such place"), { notFound: true });
      const p = await buildCityPack(place, opts.deps);
      await store(p);
      return p;
    })().finally(() => building.delete(id));
    building.set(id, job);
  }
  try {
    const pack = await job;
    return { pack, cached: false, registered: await registerPack(pack) };
  } catch (e) {
    if ((e as { notFound?: boolean }).notFound) return null;
    throw e;
  }
}

/**
 * Boot / restore: registers every stored pack with the loader, so voyages planned in a generated city can be
 * restored after a restart without the network. Returns how many were registered.
 */
export async function restoreWorldPacks(): Promise<number> {
  let names: string[] = [];
  try { names = (await readdir(dir())).filter((n) => /^W-[A-Z0-9-]+\.json$/i.test(n)); } catch { return 0; }
  let n = 0;
  for (const name of names.sort()) {
    const p = await readStoredPack(name.slice(0, -5));
    if (p && (await registerPack(p))) n++;
  }
  return n;
}

/** A pack a voyage carried with it (trip persistence): stored locally and registered, no network. */
export async function adoptPack(p: unknown): Promise<CityPack | null> {
  if (!isPack(p) || !p.generated || !/^W-[NWR][0-9A-Z]+$/.test(p.city._id)) return null;
  if (!(await readStoredPack(p.city._id))) await store(p);
  await registerPack(p);
  return p;
}

/** Tests: forget the memory cache. */
export function resetPackCache() { memory.clear(); building.clear(); registered.clear(); registering.clear(); }
