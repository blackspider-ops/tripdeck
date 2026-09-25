import { defineConfig } from "vitest/config";

// TR5-017 / TR4-008: tests never touch apps/server/data or apps/server/.cache. The global setup makes one temp dir
// per run; each test file gets its own DATA_DIR / CACHE_DIR inside it (so parallel files can't clobber each other).
export default defineConfig({
  test: {
    globalSetup: ["./test/setup/global.ts"],
    setupFiles: ["./test/setup/isolate.ts"],
  },
});
