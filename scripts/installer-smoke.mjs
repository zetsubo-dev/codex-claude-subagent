import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installPlugin, pluginId, resolveCodex } from "./install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-installer-smoke-"));
const binaries = [resolveCodex().command];
const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
if (fs.existsSync(bundled) && !binaries.includes(bundled)) binaries.push(bundled);
const results = [];

function command(binary, args, env, cwd = base) {
  const r = spawnSync(binary, args, { cwd, env, encoding: "utf8", timeout: 60000, maxBuffer: 3000000 });
  assert.equal(r.status, 0, `${path.basename(binary)} ${args.slice(0, 3).join(" ")}: ${r.stderr}`);
  return r.stdout;
}

for (const [index, binary] of binaries.entries()) {
  const fixture = path.join(base, `source-${index}`);
  fs.mkdirSync(path.join(fixture, ".agents/plugins"), { recursive: true });
  fs.copyFileSync(
    path.join(root, ".agents/plugins/marketplace.json"),
    path.join(fixture, ".agents/plugins/marketplace.json"),
  );
  fs.cpSync(path.join(root, "plugins/codex-claude-subagent"), path.join(fixture, "plugins/codex-claude-subagent"), {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes("node_modules"),
  });
  const manifestPath = path.join(fixture, "plugins/codex-claude-subagent/.codex-plugin/plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expectedVersion = manifest.version;
  manifest.version = "0.3.0";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  command("git", ["init", "--initial-branch=master"], process.env, fixture);
  const commit = () => {
    command("git", ["add", "."], process.env, fixture);
    command(
      "git",
      [
        "-c",
        "user.name=zetsubo-dev",
        "-c",
        "user.email=35388899+zetsubo-dev@users.noreply.github.com",
        "commit",
        "-m",
        "Installer test fixture",
      ],
      process.env,
      fixture,
    );
  };
  commit();
  const home = path.join(base, `home-${index}`);
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    CODEX_HOME: home,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${fixture}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/zetsubo-dev/codex-claude-subagent.git",
    GIT_TERMINAL_PROMPT: "0",
  };
  const native = (args) => JSON.parse(command(binary, args, env));
  const codex = { command: binary, version: command(binary, ["--version"], env).trim() };
  native(["plugin", "marketplace", "add", "zetsubo-dev/codex-claude-subagent", "--json"]);
  const old = native(["plugin", "add", pluginId, "--json"]);
  fs.appendFileSync(path.join(home, "config.toml"), '\n[plugins."unrelated@fixture"]\nenabled = false\n');
  const history = path.join(home, "codex-claude-subagent/keep.json");
  fs.mkdirSync(path.dirname(history));
  fs.writeFileSync(history, "unchanged");
  const beforeConfig = fs.readFileSync(path.join(home, "config.toml"));
  // A newer ZIP must not replace anything while the published snapshot is old.
  assert.throws(() => installPlugin({ distributionRoot: root, env, codex, log() {} }), /does not match this ZIP/);
  assert.ok(beforeConfig.equals(fs.readFileSync(path.join(home, "config.toml"))));
  assert.ok(fs.existsSync(old.installedPath));
  manifest.version = expectedVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  // Preserve the distribution's exact manifest formatting for byte comparison.
  fs.copyFileSync(path.join(root, "plugins/codex-claude-subagent/.codex-plugin/plugin.json"), manifestPath);
  commit();
  let child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: old.installedPath,
    stdio: "ignore",
  });
  try {
    assert.throws(() => installPlugin({ distributionRoot: root, env, codex, log() {} }), /cache is in use/);
    assert.ok(beforeConfig.equals(fs.readFileSync(path.join(home, "config.toml"))));
  } finally {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
  child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", path.join(old.installedPath, "scripts/pty_bridge.py")],
    { cwd: base, stdio: "ignore" },
  );
  try {
    assert.throws(() => installPlugin({ distributionRoot: root, env, codex, log() {} }), /cache is in use/);
  } finally {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
  const failureWrapper = path.join(base, `failing-codex-${index}`);
  const cacheRoot = path.dirname(old.installedPath);
  fs.writeFileSync(
    failureWrapper,
    `#!/usr/bin/env node\nconst cp=require('node:child_process'),fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='plugin'&&args[1]==='add'){fs.renameSync(${JSON.stringify(cacheRoot)},${JSON.stringify(path.join(base, `simulated-failed-cache-${index}`))});process.exit(1);}const r=cp.spawnSync(${JSON.stringify(binary)},args,{stdio:'inherit',env:process.env});process.exit(r.status??1);\n`,
  );
  fs.chmodSync(failureWrapper, 0o700);
  assert.throws(
    () => installPlugin({ distributionRoot: root, env, codex: { ...codex, command: failureWrapper }, log() {} }),
    /Previous cache restored/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(old.installedPath, ".codex-plugin/plugin.json"), "utf8")).version,
    "0.3.0",
  );
  assert.equal(
    native(["plugin", "list", "--json"]).installed.find((entry) => entry.pluginId === pluginId)?.version,
    "0.3.0",
  );
  const upgraded = installPlugin({ distributionRoot: root, env, codex, log() {} });
  assert.equal(upgraded.version, expectedVersion);
  assert.equal(fs.existsSync(old.installedPath), false);
  assert.equal(fs.readFileSync(history, "utf8"), "unchanged");
  assert.match(fs.readFileSync(path.join(home, "config.toml"), "utf8"), /unrelated@fixture/);
  const beforeStat = fs.statSync(upgraded.installedPath);
  child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: upgraded.installedPath,
    stdio: "ignore",
  });
  try {
    assert.equal(installPlugin({ distributionRoot: root, env, codex, log() {} }).unchanged, true);
    assert.equal(fs.statSync(upgraded.installedPath).ino, beforeStat.ino);
  } finally {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
  for (const reader of binaries) {
    const list = JSON.parse(command(reader, ["plugin", "list", "--json"], env));
    assert.equal(list.installed.find((entry) => entry.pluginId === pluginId)?.version, expectedVersion);
  }
  const freshHome = path.join(base, `fresh-${index}`);
  fs.mkdirSync(freshHome);
  assert.equal(
    installPlugin({ distributionRoot: root, env: { ...env, CODEX_HOME: freshHome }, codex, log() {} }).version,
    expectedVersion,
  );
  const localHome = path.join(base, `local-home-${index}`);
  const localSource = path.join(base, `local-source-${index}`);
  fs.mkdirSync(localHome);
  fs.cpSync(fixture, localSource, { recursive: true });
  const localManifest = path.join(localSource, "plugins/codex-claude-subagent/.codex-plugin/plugin.json");
  fs.writeFileSync(localManifest, JSON.stringify({ ...manifest, version: "0.3.0" }));
  const localEnv = { ...env, CODEX_HOME: localHome };
  command(binary, ["plugin", "marketplace", "add", localSource, "--json"], localEnv);
  const localInstall = JSON.parse(command(binary, ["plugin", "add", pluginId, "--json"], localEnv));
  const localConfig = fs.readFileSync(path.join(localHome, "config.toml"));
  assert.throws(
    () => installPlugin({ distributionRoot: root, env: localEnv, codex, log() {} }),
    /configured from another source/,
  );
  assert.ok(localConfig.equals(fs.readFileSync(path.join(localHome, "config.toml"))));
  assert.ok(fs.existsSync(localInstall.installedPath));
  command(binary, ["plugin", "marketplace", "remove", "codex-claude-subagent", "--json"], localEnv);
  assert.ok(fs.existsSync(localManifest));
  assert.ok(fs.existsSync(localInstall.installedPath));
  assert.match(fs.readFileSync(path.join(localHome, "config.toml"), "utf8"), /enabled = true/);
  assert.equal(installPlugin({ distributionRoot: root, env: localEnv, codex, log() {} }).version, expectedVersion);
  results.push({
    cli: codex.version,
    upgrade: true,
    idempotent: true,
    staleSnapshotRejected: true,
    busyRejected: true,
    unrelatedAndHistoryPreserved: true,
    crossCliRead: true,
    freshInstall: true,
    argumentOnlyBusyRejected: true,
    failedInstallRestoredAndRetryPassed: true,
    localSourceConflictPreservedAndMigrated: true,
  });
}
console.log(JSON.stringify({ ok: true, evidenceDirectory: base, results }, null, 2));
