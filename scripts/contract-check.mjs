#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function assertContract(condition, message) {
  if (!condition) throw new Error(`Contract check failed: ${message}`);
}

const rootPackage = readJson("package.json");
const installer = path.join(rootDir, "Install.command");
const marketplace = readJson(".agents/plugins/marketplace.json");
const pluginPackage = readJson("plugins/codex-claude-subagent/package.json");
const manifest = readJson("plugins/codex-claude-subagent/.codex-plugin/plugin.json");
const mcpConfig = readJson("plugins/codex-claude-subagent/.mcp.json");
const skill = readText("plugins/codex-claude-subagent/skills/codex-claude-subagent/SKILL.md");
const pluginReadme = readText("plugins/codex-claude-subagent/README.md");
const server = readText("plugins/codex-claude-subagent/server.mjs");
const bundle = readText("plugins/codex-claude-subagent/server.bundle.mjs");
const license = readText("LICENSE");
const pluginLicense = readText("plugins/codex-claude-subagent/LICENSE");
const marketplacePlugin = marketplace.plugins.find((plugin) => plugin.name === "codex-claude-subagent");
const manifestBaseVersion = manifest.version.split("+", 1)[0];
const normalizedDocs = `${skill}\n${pluginReadme}`.replace(/\s+/g, " ");

assertContract(rootPackage.name === "codex-claude-subagent-workspace", "root package name");
assertContract(rootPackage.private === true, "root package must be private");
assertContract(rootPackage.license === "MIT", "root package license");
assertContract(rootPackage.packageManager === "pnpm@12.18.0", "root package manager");
assertContract(rootPackage.version === pluginPackage.version, "root/plugin versions must match");
assertContract(rootPackage.scripts["check:contract"] === "node scripts/contract-check.mjs", "root contract script");
assertContract(
  rootPackage.scripts["audit:security"] === "pnpm audit --audit-level=low",
  "release dependency security audit",
);
assertContract(
  rootPackage.scripts["release:package"] ===
    "pnpm run deps:install && pnpm run audit:security && pnpm run build && pnpm run verify && node scripts/package-release.mjs",
  "release package script",
);
assertContract(
  rootPackage.scripts.verify === "pnpm run check && pnpm test && pnpm run test:installer && pnpm run smoke:package",
  "root verify script",
);

assertContract(marketplacePlugin?.source?.path === "./plugins/codex-claude-subagent", "marketplace plugin path");
assertContract(marketplace.name === "codex-claude-subagent", "marketplace name");
assertContract(marketplacePlugin?.policy?.installation === "AVAILABLE", "marketplace installation policy");
assertContract(marketplacePlugin?.policy?.authentication === "ON_INSTALL", "marketplace authentication policy");
assertContract(marketplace.interface.displayName === "Codex–Claude Subagent", "marketplace display name");
assertContract(pluginPackage.name === "codex-claude-subagent", "plugin package name");
assertContract(pluginPackage.license === "MIT", "plugin package license");
assertContract(manifest.name === pluginPackage.name, "manifest/package name");
assertContract(manifest.license === "MIT", "plugin manifest license");
assertContract(manifestBaseVersion === pluginPackage.version, "manifest/package version");
assertContract(manifest.interface.displayName === "Codex–Claude Subagent", "manifest display name");
assertContract(manifest.interface.capabilities.includes("Implement"), "manifest implementation capability");
assertContract(/^MIT License\s/.test(license), "MIT license file");
assertContract(pluginLicense === license, "standalone plugin license");
assertContract(mcpConfig.mcpServers?.codex_claude_subagent, "MCP server key");
assertContract(/^name:\s+codex-claude-subagent\s*$/m.test(skill), "skill name");
assertContract(!normalizedDocs.includes("Claude Worker"), "old display name removed from docs");
assertContract(server.includes('name: "codex-claude-subagent"'), "server name");
assertContract(server.includes("CODEX_CLAUDE_SUBAGENT_STATE_DIR"), "state environment prefix");
assertContract(server.includes('const IMPLEMENTATION_ROLES = new Set(["implementer"])'), "implementer role contract");
assertContract(!server.includes("claude_worktree is required"), "implementer worktree guard removed");
assertContract(server.includes('nested_subagents: "explicit_only"'), "explicit nested subagent policy");
assertContract(server.includes('default_subagent_mode: "disabled"'), "single-agent default");
assertContract(
  fs.existsSync(path.join(rootDir, "plugins/codex-claude-subagent/observer/hooks/register.mjs")),
  "native lifecycle observer",
);
assertContract(server.includes("forwards_allowlisted_interactive_claude_args: true"), "interactive Claude args policy");
assertContract(fs.existsSync(installer), "release installer missing");
assertContract((fs.statSync(installer).mode & 0o111) !== 0, "release installer must be executable");
assertContract(fs.existsSync(path.join(rootDir, "scripts/install.mjs")), "verified installer entrypoint");
assertContract(
  readText("Install.command").includes("scripts/install.mjs"),
  "installer delegates to verified entrypoint",
);
assertContract(!readText("Install.command").includes("installation completed"), "no unverified installer success");
assertContract(normalizedDocs.includes("claude_args"), "interactive Claude args documentation");
assertContract(normalizedDocs.includes("role contract"), "machine-readable role contract documentation");
assertContract(
  normalizedDocs.includes("implementer_requires_claude_worktree"),
  "implementer worktree status documentation",
);
assertContract(normalizedDocs.includes("directly in the target project"), "direct project editing documentation");
assertContract(!server.includes("CLAUDE_WORKER"), "old environment prefix removed from source");
assertContract(!bundle.includes("CLAUDE_WORKER"), "old environment prefix removed from bundle");
assertContract(!bundle.includes("claude_worker"), "old MCP identifier removed from bundle");

console.log("plugin contract: ok");
