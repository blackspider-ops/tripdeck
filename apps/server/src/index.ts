import { createServer } from "node:http";
import express from "express";
import { config, features, productionProblems } from "./config.js";
import { apiRouter } from "./api/routes.js";
import { attachRealtime } from "./realtime/io.js";
import { TripService } from "./trips/service.js";
import { acquireHelmLease, closeDb, connectDb } from "./store/db.js";
import { restoreOrRetry } from "./store/restoreRetry.js";
import { pruneAudioCache } from "./voice/voice.js";
import { mountWeb, securityHeaders } from "./web.js";
import { LIMITS } from "./util/limits.js";
import { restoreWorldPacks } from "./world/packs.js";

// SEC-013: production fails closed on a guessable DEV_KEY or a missing PUBLIC_BASE_URL
const problems = productionProblems();
if (problems.length) {
  for (const p of problems) console.error(`[helm] refusing to start in production: ${p}`);
  process.exit(1);
}

const helm = new TripService();
// docs/11: generated ports stored on this disk come back before any voyage is restored (no network)
await restoreWorldPacks().then((n) => { if (n) console.log(`[helm] ${n} generated port(s) restored`); }, (e) => console.warn("[helm] generated ports not restored", e));
await connectDb();
// L5-002: one writer. A new instance waits for the previous helm's lease (released on its shutdown, or expired)
// before its restore voids "abandoned" seals and resets "interrupted" tables that another process may still own.
await acquireHelmLease();
// L5-009: a failed restore (a network blip on a load, a malformed doc) never crash-loops the boot: the helm starts,
// answers 503 LOADING for voyages it doesn't hold yet, and merges what is stored in the background.
await restoreOrRetry(helm);

const app = express();
// SEC-007 / TR3-015: trust exactly the proxies in front (0 on a bare host, 1 on Render/Fly; see config.limits), so a
// spoofed X-Forwarded-For can't choose req.ip. util/limits.ts clientIp applies the same rule to sockets.
app.set("trust proxy", config.limits.trustProxyHops);
app.disable("x-powered-by");
app.use(securityHeaders()); // SEC-012
app.use("/api", apiRouter(helm)); // its last handler answers an unknown /api/* with a JSON 404, never index.html

// Production (or SERVE_WEB=1): the built web app (phones, headset, gallery) from the same origin (OPT-059 / TR3-017)
mountWeb(app);

const http = createServer(app);
// SEC-006: slow or huge requests can't hold the process: headers within 10 s, a whole request within 60 s
http.headersTimeout = 10_000;
http.requestTimeout = 60_000;
attachRealtime(http, helm);

http.listen(config.port, () => {
  console.log(`\nTripdeck helm on http://localhost:${config.port}`);
  console.log(`   gemini: ${features.gemini() ? config.gemini.model : "off (rule-based lines)"} · voices: ${features.eleven() ? "ElevenLabs" : "off (captions + browser speech)"}`);
  console.log(`   mongo: ${features.mongo() ? "on" : "off (memory)"} · payments: ${helm.payments.mode} · memory: ${features.backboard() ? "Backboard" : "local file"}`);
  console.log(`   mode: ${config.production ? "production" : config.devMode ? "development (dev routes open)" : "local (dev routes need DEV_KEY)"}\n`);
});

// SEC-015 / OPT-040: idle voyages leave memory (every 15 minutes, R2-WP-13: so "lone after VOYAGE_LONE_HOURS" is
// at most 15 minutes late) and the voice cache stays bounded (hourly; at boot too)
void pruneAudioCache().catch(() => undefined);
const sweeper = setInterval(() => {
  const gone = helm.sweep();
  if (gone.length) console.log(`[helm] swept ${gone.length} idle voyages from memory`);
}, LIMITS.sweepIntervalMs);
sweeper.unref();
const pruner = setInterval(() => void pruneAudioCache().catch(() => undefined), LIMITS.audioPruneIntervalMs);
pruner.unref();

// A stray rejection (provider, memory, TTS) must never take the helm down mid-voyage.
process.on("unhandledRejection", (e) => console.error("[helm] unhandled rejection", e));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { await closeDb(); process.exit(0); });
}
