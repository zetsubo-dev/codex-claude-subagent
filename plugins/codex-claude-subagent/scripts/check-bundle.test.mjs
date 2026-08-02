#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { pluginDir } from "./bundle-config.mjs";

const checkScript = fileURLToPath(new URL("./check-bundle.mjs", import.meta.url));
const sourceBundle = await fs.readFile(path.join(pluginDir, "server.bundle.mjs"));
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-claude-subagent-bundle-test-"));
const candidateBundle = path.join(tempDir, "server.bundle.mjs");

try {
  await fs.writeFile(candidateBundle, sourceBundle);
  const synchronized = spawnSync(process.execPath, [checkScript, candidateBundle], {
    cwd: pluginDir,
    encoding: "utf8",
  });
  assert.equal(synchronized.status, 0, synchronized.stderr);

  await fs.appendFile(candidateBundle, "\n// intentionally stale\n");
  const staleBundle = await fs.readFile(candidateBundle);
  const stale = spawnSync(process.execPath, [checkScript, candidateBundle], {
    cwd: pluginDir,
    encoding: "utf8",
  });
  assert.notEqual(stale.status, 0, "stale bundle check unexpectedly passed");
  assert.deepEqual(await fs.readFile(candidateBundle), staleBundle, "stale bundle was modified");
  console.log("bundle check regression tests passed");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
