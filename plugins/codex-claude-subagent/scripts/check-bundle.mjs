#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { createBundleOptions, pluginDir } from "./bundle-config.mjs";

export async function isBundleSynchronized(committedBundle = path.join(pluginDir, "server.bundle.mjs")) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-claude-subagent-bundle-check-"));
  const generatedBundle = path.join(tempDir, "server.bundle.mjs");
  try {
    await build(createBundleOptions(generatedBundle, { logLevel: "silent" }));
    const [expected, actual] = await Promise.all([fs.readFile(generatedBundle), fs.readFile(committedBundle)]);
    return expected.equals(actual);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const committedBundle = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  if (!(await isBundleSynchronized(committedBundle))) {
    console.error("server.bundle.mjs is out of date; run pnpm run build before checking.");
    process.exitCode = 1;
  } else {
    console.log("server.bundle.mjs is synchronized with server.mjs.");
  }
}
