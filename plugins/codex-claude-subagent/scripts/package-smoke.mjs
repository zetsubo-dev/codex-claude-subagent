#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-subagent-package-"));
const installedDir = path.join(tempRoot, "codex-claude-subagent");

try {
  fs.cpSync(pluginDir, installedDir, {
    recursive: true,
    filter(source) {
      const relative = path.relative(pluginDir, source);
      return relative !== "node_modules" && !relative.startsWith(`node_modules${path.sep}`);
    },
  });
  if (fs.existsSync(path.join(installedDir, "node_modules"))) {
    throw new Error("Package smoke copy unexpectedly contains node_modules.");
  }

  const mcpConfig = JSON.parse(fs.readFileSync(path.join(installedDir, ".mcp.json"), "utf8"));
  const codexClaudeSubagentConfig = mcpConfig?.mcpServers?.codex_claude_subagent;
  if (
    !codexClaudeSubagentConfig ||
    typeof codexClaudeSubagentConfig !== "object" ||
    Array.isArray(codexClaudeSubagentConfig)
  ) {
    throw new Error("Packaged Codex–Claude Subagent MCP server configuration is missing.");
  }
  if ("required" in codexClaudeSubagentConfig) {
    throw new Error("Packaged Codex–Claude Subagent MCP server must preserve optional startup behavior.");
  }

  const result = spawnSync(process.execPath, ["scripts/smoke.mjs"], {
    cwd: installedDir,
    env: process.env,
    encoding: "utf8",
    timeout: 20000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Dependency-free package smoke failed with status ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  process.stdout.write(result.stdout);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
