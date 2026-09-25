/**
 * R2-WP-12 — stored paid-call budgets and the unknown-voyage limiter, against the fake MongoDB (never Atlas; every
 * paid key is blank, and nothing here calls a provider):
 *   - L5-011: spend counters survive a restart (today's and each voyage's); counts made before the stored doc was
 *     read are added to it, never lost;
 *   - S2-014: a voyage's counters leaving the in-memory LRU come back from the store instead of starting at zero;
 *   - S2-007: unknown voyage ids under /api/trips/:tripId stop reaching the database after the per-address miss
 *     limit (then 429 SLOW_DOWN); the hydrate miss cache is an LRU (cycling ids forgets the oldest, not all).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => Object.assign(process.env, { PACE_SCALE: "0", GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "", MONGODB_URI: "", BACKBOARD_API_KEY: "" }));
const calls = vi.hoisted(() => ({ trips: 0 }));
vi.mock("../src/store/db.js", async () => {
  const { fakeDb } = await import("./support/fakeDb.js");
  return {
    ...fakeDb,
    loadWhere: async (c: string, f: Record<string, unknown>, o?: Record<string, unknown>) => {
      if (c === "trips") calls.trips++;
      return fakeDb.loadWhere(c, f, o as never);
    },
  };
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { fake } from "./support/fakeDb.js";
import { config } from "../src/config.js";
import { TripService } from "../src/trips/service.js";
import { apiRouter } from "../src/api/routes.js";
import { loadSpend, resetSpend, spend } from "../src/util/limits.js";

const caps = config.limits.spend;
const saved = JSON.parse(JSON.stringify(caps)) as typeof caps;
const today = () => `day:${new Date().toISOString().slice(0, 10)}`;
beforeEach(() => { fake.reset(); fake.state.connected = true; calls.trips = 0; resetSpend(); });
afterEach(() => {
  Object.assign(caps.daily, saved.daily);
  Object.assign(caps.trip, saved.trip);
  config.limits.trustProxyHops = 0;
  resetSpend();
});

describe("L5-011: spend caps survive a restart", () => {
  it("a daily budget spent to its cap still refuses after a restart", async () => {
    caps.daily.stt = 3;
    await loadSpend();
    expect([spend("stt"), spend("stt"), spend("stt"), spend("stt")]).toEqual([true, true, true, false]);
    expect(fake.get<{ stt: number }>("spend", today())?.stt).toBe(3);
    resetSpend(); // the restart: memory is gone, the store isn't
    await loadSpend();
    expect(spend("stt")).toBe(false);
  });

  it("a voyage's budget survives a restart (and its counters leaving the LRU)", async () => {
    caps.trip.gemini = 2;
    await loadSpend("T1");
    expect([spend("gemini", "T1"), spend("gemini", "T1"), spend("gemini", "T1")]).toEqual([true, true, false]);
    expect(fake.get<{ gemini: number; tripId: string }>("spend", "trip:T1")).toMatchObject({ gemini: 2, tripId: "T1" });
    resetSpend();
    await loadSpend("T1");
    expect(spend("gemini", "T1")).toBe(false);
    expect(spend("gemini", "T2")).toBe(true); // another voyage has its own
  });

  it("calls counted before the stored doc was read are added to it, not lost", async () => {
    caps.daily.tts = 10;
    await loadSpend();
    for (let i = 0; i < 4; i++) spend("tts");
    resetSpend();
    expect(spend("tts")).toBe(true); // the read is still on its way: counted in memory
    await loadSpend();
    expect(fake.get<{ tts: number }>("spend", today())?.tts).toBe(5);
  });

  it("without MongoDB nothing is stored and spending still works", async () => {
    fake.state.connected = false;
    caps.daily.stt = 1;
    await loadSpend();
    expect([spend("stt"), spend("stt")]).toEqual([true, false]);
    expect(fake.docs("spend")).toHaveLength(0);
  });
});

describe("S2-007: unknown voyage ids stop reaching MongoDB", () => {
  it("200 requests to random voyage ids from one address make at most TRIP_MISS_RATE lookups, then SLOW_DOWN", async () => {
    const h = new TripService();
    const app = express();
    app.use("/api", apiRouter(h));
    const srv = createServer(app);
    await new Promise<void>((r) => srv.listen(0, r));
    const base = `http://localhost:${(srv.address() as AddressInfo).port}/api`;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 200; i++) statuses.push((await fetch(`${base}/trips/nope-${i}/passkey`)).status);
      const limit = config.limits.tripMissPerMinute;
      expect(calls.trips).toBeLessThanOrEqual(limit);
      expect(statuses.slice(0, limit).every((s) => s === 404)).toBe(true);
      expect(statuses.slice(limit).every((s) => s === 429)).toBe(true);
      const slow = await fetch(`${base}/trips/nope-x/headset-code`, { method: "POST" });
      expect((await slow.json()).code).toBe("SLOW_DOWN");
      // a voyage in memory still answers from this address (no lookup, no miss)
      const { trip, token } = h.createTrip({ name: "Real", organizerName: "O", band: 2, origin: "ATL" as never });
      const ok = await fetch(`${base}/trips/${trip._id}/headset-code`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      expect(ok.status).toBe(200);
    } finally {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("the hydrate miss cache is an LRU: cycling 1,500 ids keeps the last 1,000 cached", async () => {
    const h = new TripService();
    for (let i = 0; i < 1500; i++) await h.hydrate({ tripId: `gone-${i}` });
    expect(calls.trips).toBe(1500);
    for (let i = 600; i < 1500; i++) await h.hydrate({ tripId: `gone-${i}` });
    expect(calls.trips).toBe(1500); // the old clear-on-overflow looked 600…1001 up again
    await h.hydrate({ tripId: "gone-0" });
    expect(calls.trips).toBe(1501); // the oldest went
  });
});
