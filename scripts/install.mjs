#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginId = "codex-claude-subagent@codex-claude-subagent";
const marketplaceName = "codex-claude-subagent";
const officialSource = "https://github.com/zetsubo-dev/codex-claude-subagent.git";
const relativePlugin = "plugins/codex-claude-subagent";
const runtimeFiles = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "LICENSE",
  "README.md",
  "server.bundle.mjs",
  "scripts/hook_bridge.mjs",
  "scripts/pty_bridge.py",
  "observer/.claude-plugin/plugin.json",
  "observer/hooks/hooks.json",
  "observer/hooks/register.mjs",
  "skills/codex-claude-subagent/SKILL.md",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sameRuntime(left, right) {
  return runtimeFiles.every((file) => {
    try {
      return fs.readFileSync(path.join(left, file)).equals(fs.readFileSync(path.join(right, file)));
    } catch {
      return false;
    }
  });
}

export function resolveCodex(env = process.env) {
  const candidates = [
    "codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  for (const command of candidates) {
    const result = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 10000 });
    if (result.status !== 0) continue;
    const help = spawnSync(command, ["plugin", "add", "--help"], { env, encoding: "utf8", timeout: 10000 });
    if (help.status === 0 && help.stdout.includes("--json")) return { command, version: result.stdout.trim() };
  }
  throw new Error("Codex CLI with plugin support was not found. Install or update the Codex app/CLI, then retry.");
}

export function findBusyProcesses(cacheRoot) {
  if (!fs.existsSync(cacheRoot)) return [];
  const canonicalRoot = fs.realpathSync(cacheRoot);
  const inside = (value) => value === canonicalRoot || value.startsWith(`${canonicalRoot}${path.sep}`);
  const cwd = spawnSync("/usr/sbin/lsof", ["-w", "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (cwd.error || ![0, 1].includes(cwd.status) || cwd.stderr || ps.error || ps.status !== 0) {
    throw new Error("Could not check running plugin processes. No plugin files were replaced.");
  }
  const busy = new Set();
  let pid = null;
  for (const line of cwd.stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    if (line.startsWith("n") && inside(line.slice(1))) busy.add(pid);
  }
  for (const line of ps.stdout.split("\n")) {
    if (line.includes(`${canonicalRoot}${path.sep}`) || line.includes(`${cacheRoot}${path.sep}`)) {
      const match = line.match(/^\s*(\d+)\s/);
      if (match) busy.add(match[1]);
    }
  }
  return [...busy].filter(Boolean);
}

export function installPlugin({
  distributionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  env = process.env,
  codex = resolveCodex(env),
  log = console.log,
} = {}) {
  const codexHome = path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const sourcePlugin = path.join(distributionRoot, relativePlugin);
  const expected = readJson(path.join(sourcePlugin, ".codex-plugin/plugin.json"));
  if (expected.name !== marketplaceName || !/^[0-9]+\.[0-9]+\.[0-9]+(?:\+[a-zA-Z0-9.]+)?$/.test(expected.version)) {
    throw new Error("Invalid distribution manifest.");
  }
  const run = (args, childEnv = env) => {
    const result = spawnSync(codex.command, args, {
      cwd: os.tmpdir(),
      env: childEnv,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Codex command failed: ${args.slice(0, 3).join(" ")} (exit ${result.status ?? "unknown"}). Check Git installation, GitHub access, and Codex plugin support.`,
      );
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error("Codex did not return the expected JSON response. Update Codex and retry.");
    }
  };
  log(`Using ${codex.version} (${codex.command}).`);
  const stageHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-subagent-install-"));
  fs.chmodSync(stageHome, 0o700);
  try {
    const staged = run(["plugin", "marketplace", "add", officialSource, "--json"], { ...env, CODEX_HOME: stageHome });
    const stagedPlugin = path.join(staged.installedRoot, relativePlugin);
    const fetched = readJson(path.join(stagedPlugin, ".codex-plugin/plugin.json"));
    if (fetched.version !== expected.version || !sameRuntime(sourcePlugin, stagedPlugin)) {
      throw new Error(
        "The published Git version does not match this ZIP. Download the latest release ZIP and retry. No installed plugin was replaced.",
      );
    }
    const cacheRoot = path.join(codexHome, "plugins/cache", marketplaceName, marketplaceName);
    const target = path.join(cacheRoot, expected.version);
    const current = run(["plugin", "marketplace", "list", "--json"]).marketplaces.find(
      (entry) => entry.name === marketplaceName,
    );
    if (
      current &&
      (current.marketplaceSource.sourceType !== "git" || current.marketplaceSource.source !== officialSource)
    ) {
      throw new Error(
        `The marketplace name is configured from another source. Close Codex/CLI chats, run ${JSON.stringify(codex.command)} plugin marketplace remove ${marketplaceName}, then run Install.command again. This removes the source registration, not its original folder or plugin cache. No source was removed by this installer.`,
      );
    }
    const enabled =
      run(["plugin", "list", "--json"]).installed.find((entry) => entry.pluginId === pluginId)?.enabled === true;
    if (current && enabled && sameRuntime(stagedPlugin, target)) {
      log(`Already installed and verified: ${expected.version}. No cache files were replaced.`);
      return { version: expected.version, installedPath: target, unchanged: true };
    }
    const busy = findBusyProcesses(cacheRoot);
    if (busy.length) {
      throw new Error(
        `Plugin cache is in use (PIDs: ${busy.join(", ")}). Close the Codex app and running Codex CLI chats, then retry. No plugin files were replaced.`,
      );
    }
    fs.mkdirSync(codexHome, { recursive: true });
    const backup = fs.mkdtempSync(path.join(codexHome, "codex-claude-subagent-install-backup-"));
    fs.chmodSync(backup, 0o700);
    const savedCache = path.join(backup, "cache");
    if (fs.existsSync(cacheRoot)) fs.cpSync(cacheRoot, savedCache, { recursive: true });
    const savedMarketplace = path.join(backup, "marketplace");
    if (current) fs.cpSync(current.root, savedMarketplace, { recursive: true });
    const configFile = path.join(codexHome, "config.toml");
    if (fs.existsSync(configFile)) {
      fs.copyFileSync(configFile, path.join(backup, "config.toml"));
      fs.chmodSync(path.join(backup, "config.toml"), 0o600);
    }
    try {
      if (current) run(["plugin", "marketplace", "upgrade", marketplaceName, "--json"]);
      else run(["plugin", "marketplace", "add", officialSource, "--json"]);
      const actualMarketplace = run(["plugin", "marketplace", "list", "--json"]).marketplaces.find(
        (entry) => entry.name === marketplaceName,
      );
      if (!actualMarketplace || !sameRuntime(stagedPlugin, path.join(actualMarketplace.root, relativePlugin))) {
        throw new Error("The Git snapshot changed during installation. Retry with the matching release ZIP.");
      }
      const result = run(["plugin", "add", pluginId, "--json"]);
      const after = run(["plugin", "list", "--json"]).installed.find((entry) => entry.pluginId === pluginId);
      if (result.version !== expected.version || !after?.enabled || !sameRuntime(stagedPlugin, target)) {
        throw new Error("Installed version or content verification failed.");
      }
    } catch (error) {
      if (fs.existsSync(savedCache)) {
        if (fs.existsSync(cacheRoot)) fs.renameSync(cacheRoot, path.join(backup, "failed-cache"));
        fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });
        fs.cpSync(savedCache, cacheRoot, { recursive: true });
      }
      if (current && fs.existsSync(savedMarketplace)) {
        if (fs.existsSync(current.root)) fs.renameSync(current.root, path.join(backup, "failed-marketplace"));
        fs.cpSync(savedMarketplace, current.root, { recursive: true });
      }
      throw new Error(`${error.message} Previous cache restored when available. Recovery backup: ${backup}`, {
        cause: error,
      });
    }
    log(`Installed and verified: ${expected.version}. Recovery backup: ${backup}`);
    return { version: expected.version, installedPath: target, unchanged: false, backup };
  } finally {
    fs.rmSync(stageHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    installPlugin();
    console.log(
      "Start a new Codex chat (restart the app if needed) to load this version. Existing chats are not switched or terminated.",
    );
  } catch (error) {
    console.error(`Installation did not complete: ${error.message}`);
    process.exitCode = 1;
  }
}
