/** One temp dir per `vitest run`, removed afterwards. Workers inherit AA_TEST_ROOT. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const root = mkdtempSync(join(tmpdir(), "all-ayes-test-"));
  process.env.AA_TEST_ROOT = root;
  return () => rmSync(root, { recursive: true, force: true });
}
