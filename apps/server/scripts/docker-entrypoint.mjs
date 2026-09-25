// Container entrypoint. A host-mounted persistent disk (Render mounts `/var/data` owned by root) isn't writable by
// the unprivileged `node` user, so memory would silently fall back to RAM ("degraded"). When started as root, this
// makes DATA_DIR / CACHE_DIR exist and belong to node (uid/gid 1000), then drops to node for good before the server
// loads — the server itself never runs as root. Started as non-root already (`docker run --user`, a platform that
// forbids root), it skips straight to the server. Same process, so SIGTERM still reaches the server directly.
//
// S2-016: as root it only ever chowns a dir under an allow-list (the persistent disk at /var/data, or the image's
// default data/cache dirs). Anything else (DATA_DIR=/app, /, /app/apps/server/dist, a symlink out) exits non-zero
// before anything is chowned.
import { chownSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UID = 1000, GID = 1000;
export const CHOWN_ROOTS = ["/var/data", "/app/apps/server/data", "/app/apps/server/.cache"];

/** Is `dir` (absolute, normalised) one of the allowed roots or inside one? */
export function chownAllowed(dir, roots = CHOWN_ROOTS) {
  const d = resolve(dir);
  return roots.some((r) => d === r || d.startsWith(r + sep));
}

/** The dirs to prepare, or the problems that must stop the container (checked before anything is touched). */
export function planDirs(env, cwd = process.cwd(), roots = CHOWN_ROOTS) {
  const dirs = [], problems = [];
  for (const key of ["DATA_DIR", "CACHE_DIR"]) {
    const raw = env[key]?.trim();
    if (!raw) continue; // the defaults inside /app are created and chowned at image build time
    const dir = resolve(cwd, raw);
    if (chownAllowed(dir, roots)) dirs.push({ key, dir });
    else problems.push(`${key}=${raw} is not under ${roots.join(", ")}; refusing to chown it as root`);
  }
  return { dirs, problems };
}

function chownTree(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.uid !== UID || st.gid !== GID) chownSync(p, UID, GID);
  if (st.isDirectory()) for (const name of readdirSync(p)) chownTree(join(p, name));
}

// run as the container's command, not when a test imports the checks above
const isMain = (() => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

if (isMain && process.getuid?.() === 0) {
  const { dirs, problems } = planDirs(process.env);
  if (problems.length) {
    for (const p of problems) console.error(`[entrypoint] ${p}`);
    process.exit(1);
  }
  for (const { key, dir } of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      // a symlinked parent could still point outside the allow-list
      const real = realpathSync(dir);
      if (!chownAllowed(real)) {
        console.error(`[entrypoint] ${key} resolves to ${real}, outside ${CHOWN_ROOTS.join(", ")}; refusing to chown it as root`);
        process.exit(1);
      }
      chownTree(real);
    } catch (e) {
      console.warn(`[entrypoint] ${key}=${dir} could not be prepared for the node user: ${e.message}`);
    }
  }
  try {
    process.setgroups([GID]);
    process.setgid(GID);
    process.setuid(UID);
  } catch (e) {
    console.error(`[entrypoint] could not drop root privileges (${e.message}); refusing to run the server as root`);
    process.exit(1);
  }
  process.env.HOME = "/home/node";
  process.env.USER = "node";
}

if (isMain) await import("../dist/index.js");
