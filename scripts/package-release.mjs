#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.resolve(process.env.CODEX_CLAUDE_SUBAGENT_RELEASE_DIR || path.join(rootDir, "dist"));
const manifestPath = path.join(rootDir, "plugins/codex-claude-subagent/.codex-plugin/plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const version = String(manifest.version).split("+", 1)[0];
const archiveName = `codex-claude-subagent-v${version}`;
const stagingDir = path.join(outputDir, archiveName);
const archivePath = path.join(outputDir, `${archiveName}.zip`);

const releaseFiles = [
  "Install.command",
  "scripts/install.mjs",
  "LICENSE",
  ".agents/plugins/marketplace.json",
  "README.md",
  "plugins/codex-claude-subagent/LICENSE",
  "plugins/codex-claude-subagent/.codex-plugin/plugin.json",
  "plugins/codex-claude-subagent/.mcp.json",
  "plugins/codex-claude-subagent/README.md",
  "plugins/codex-claude-subagent/server.bundle.mjs",
  "plugins/codex-claude-subagent/scripts/hook_bridge.mjs",
  "plugins/codex-claude-subagent/scripts/pty_bridge.py",
  "plugins/codex-claude-subagent/observer/.claude-plugin/plugin.json",
  "plugins/codex-claude-subagent/observer/hooks/hooks.json",
  "plugins/codex-claude-subagent/observer/hooks/register.mjs",
  "plugins/codex-claude-subagent/skills/codex-claude-subagent/SKILL.md",
];

function assertFile(relativePath) {
  const sourcePath = path.join(rootDir, relativePath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Release file is missing: ${relativePath}`);
  }
}

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.rmSync(archivePath, { force: true });

for (const relativePath of releaseFiles) {
  assertFile(relativePath);
  const sourcePath = path.join(rootDir, relativePath);
  const destinationPath = path.join(stagingDir, relativePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

fs.chmodSync(path.join(stagingDir, "Install.command"), 0o755);
execFileSync("zip", ["-qr", archivePath, archiveName], { cwd: outputDir, stdio: "inherit" });

const archiveEntries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" });
for (const requiredEntry of releaseFiles.map((file) => `${archiveName}/${file}`)) {
  if (!archiveEntries.split("\n").includes(requiredEntry)) {
    throw new Error(`Release archive is missing ${requiredEntry}`);
  }
}

fs.rmSync(stagingDir, { recursive: true, force: true });
console.log(JSON.stringify({ archive: archivePath, version, files: releaseFiles.length }, null, 2));
