import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBusyProcesses, installPlugin } from "./install.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-installer-test-"));
try {
  assert.deepEqual(findBusyProcesses(path.join(temporary, "missing")), []);
  assert.throws(
    () => installPlugin({ distributionRoot: temporary, codex: { command: "not-used", version: "fixture" }, log() {} }),
    /ENOENT/,
  );
  const plugin = path.join(temporary, "plugins/codex-claude-subagent/.codex-plugin");
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, "plugin.json"), JSON.stringify({ name: "wrong", version: "0.4.0" }));
  assert.throws(
    () => installPlugin({ distributionRoot: temporary, codex: { command: "not-used", version: "fixture" }, log() {} }),
    /Invalid distribution/,
  );
  fs.writeFileSync(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "codex-claude-subagent", version: "0.4.0" }),
  );
  const home = path.join(temporary, "isolated-home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.toml"), "# Preserve this fixture\n");
  const wrapper = path.join(temporary, "bad-cli");
  fs.writeFileSync(wrapper, "#!/bin/sh\nprintf 'not-json'\n");
  fs.chmodSync(wrapper, 0o700);
  assert.throws(
    () =>
      installPlugin({
        distributionRoot: temporary,
        env: { ...process.env, CODEX_HOME: home },
        codex: { command: wrapper, version: "fixture" },
        log() {},
      }),
    /expected JSON response/,
  );
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), "# Preserve this fixture\n");
  if (process.platform === "darwin") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: temporary, stdio: "ignore" });
    try {
      assert.ok(findBusyProcesses(temporary).includes(String(child.pid)));
    } finally {
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
  }
  console.log("installer regression tests passed");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
