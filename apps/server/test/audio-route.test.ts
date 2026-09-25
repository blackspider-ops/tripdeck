/**
 * /api/audio/:turnId serves the cached mp3 even when the cache lives under a dot directory — the default is
 * apps/server/.cache, and express's sendFile 404s any path with a dot segment unless told otherwise.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  // a cache dir with a dot segment, like the default apps/server/.cache (set before config.ts loads)
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.CACHE_DIR = join(mkdtempSync(join(process.env.AA_TEST_ROOT || tmpdir(), "audio-")), ".cache");
});
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import express from "express";
import { config } from "../src/config.js";
import { apiRouter } from "../src/api/routes.js";
import { TripService } from "../src/trips/service.js";
import { restoreTurnAudio } from "../src/voice/voice.js";

describe("audio route", () => {
  let http: Server;
  let base = "";
  beforeAll(async () => {
    const app = express();
    app.use("/api", apiRouter(new TripService()));
    http = createServer(app);
    await new Promise<void>((r) => http.listen(0, r));
    base = `http://localhost:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()); }));

  it("serves a turn's mp3 from a cache dir under a dot directory", async () => {
    expect(config.cacheDir).toContain(".cache");
    const key = "a".repeat(40);
    mkdirSync(join(config.cacheDir, "tts"), { recursive: true });
    writeFileSync(join(config.cacheDir, "tts", `${key}.mp3`), Buffer.from("ID3fake-mp3"));
    expect(await restoreTurnAudio("turn-1", key)).toBe(true);
    const res = await fetch(`${base}/api/audio/turn-1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/mpeg");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("ID3fake-mp3");
    expect((await fetch(`${base}/api/audio/unknown-turn`)).status).toBe(404);
  });
});
