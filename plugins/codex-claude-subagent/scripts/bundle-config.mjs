#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createBundleOptions(outfile, { logLevel } = {}) {
  return {
    entryPoints: [path.join(pluginDir, "server.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    ...(logLevel ? { logLevel } : {}),
  };
}
