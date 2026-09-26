/**
 * Runs before each test file (its modules, incl. config.ts, load after this): a private DATA_DIR / CACHE_DIR under
 * the run's temp root, so no test ever reads or writes apps/server/data (memory.json) or apps/server/.cache.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.AA_TEST_ROOT || tmpdir();
const dir = mkdtempSync(join(root, "file-"));
process.env.DATA_DIR = join(dir, "data");
process.env.CACHE_DIR = join(dir, "cache");
// WP-07: the per-voyage table-run cap is relaxed here (tests re-run tables); limits tests lower it per case
process.env.TABLE_RUNS_MAX ??= "1000";
// Tests never reach paid services or a real database, even when a developer's .env holds real keys: set (blank)
// here, these win over .env (the loader only fills unset vars). Tests that exercise a provider mock it.
for (const k of ["GEMINI_API_KEY", "ELEVENLABS_API_KEY", "BACKBOARD_API_KEY", "MONGODB_URI", "VISA_VIC_API_KEY", "VISA_VIC_API_BASE", "ROUTESTACK_API_KEY", "ROUTESTACK_API_SECRET"]) process.env[k] = "";
