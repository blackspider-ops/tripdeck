/**
 * S2-016: the Docker entrypoint chowns (as root) only DATA_DIR/CACHE_DIR under an allow-list, and refuses to start
 * otherwise, before anything is touched. Importing the script only loads its checks (the server loads only when it is
 * the process's main module).
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { chownAllowed, planDirs } from "../scripts/docker-entrypoint.mjs";

describe("S2-016: docker entrypoint allow-list", () => {
  it("DATA_DIR=/app (or /, the server's dist, a path that climbs out) is refused", () => {
    for (const bad of ["/app", "/", "/app/apps/server/dist", "/app/apps/server", "/var/data/../../app", "/var/database", "/tmp"]) {
      const { dirs, problems } = planDirs({ DATA_DIR: bad }, "/app");
      expect(dirs, bad).toEqual([]);
      expect(problems, bad).toHaveLength(1);
      expect(problems[0]).toMatch(/refusing to chown/);
    }
    expect(planDirs({ CACHE_DIR: "apps/server/dist" }, "/app").problems).toHaveLength(1);
    // one bad dir refuses both (nothing is chowned when any is refused)
    const mixed = planDirs({ DATA_DIR: "/var/data/data", CACHE_DIR: "/app" }, "/app");
    expect(mixed.problems).toHaveLength(1);
  });

  it("the persistent disk and the image's defaults are allowed; unset means nothing to do", () => {
    expect(planDirs({ DATA_DIR: "/var/data/data", CACHE_DIR: "/var/data/cache" }, "/app")).toEqual({
      dirs: [{ key: "DATA_DIR", dir: "/var/data/data" }, { key: "CACHE_DIR", dir: "/var/data/cache" }], problems: [],
    });
    expect(planDirs({ DATA_DIR: "apps/server/data", CACHE_DIR: "apps/server/.cache/tts" }, "/app").problems).toEqual([]);
    expect(planDirs({ DATA_DIR: " ", CACHE_DIR: "" }, "/app")).toEqual({ dirs: [], problems: [] });
    expect(chownAllowed("/var/data")).toBe(true);
    expect(chownAllowed("/var/data2")).toBe(false);
  });
});
