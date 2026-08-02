#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-subagent-smoke-"));
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, ["server.bundle.mjs"], {
  cwd: pluginDir,
  env: { ...process.env, CODEX_CLAUDE_SUBAGENT_STATE_DIR: stateDir },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
let stdoutBuffer = "";
let nextId = 1;
const pending = new Map();

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  while (stdoutBuffer.includes("\n")) {
    const newline = stdoutBuffer.indexOf("\n");
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});

child.on("exit", (code, signal) => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`MCP server exited before replying: code=${code} signal=${signal}`));
  }
  pending.clear();
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}, timeoutMs = 10000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}. stderr=${stderr.trim()}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-claude-subagent-package-smoke", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const tools = await request("tools/list");
  const info = await request("tools/call", { name: "codex_claude_subagent_info", arguments: {} });
  const parsedInfo = JSON.parse(info.content[0].text);
  if (parsedInfo.state_dir !== stateDir) {
    throw new Error(`Expected isolated state dir ${stateDir}, got ${parsedInfo.state_dir}`);
  }
  console.log(
    JSON.stringify(
      {
        toolNames: tools.tools.map((tool) => tool.name),
        version: parsedInfo.version,
        stateDir: parsedInfo.state_dir,
        stderr: stderr.trim(),
      },
      null,
      2,
    ),
  );
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Timer and exit notification can race; `settled` above makes this resolve-once.
      // oxlint-disable-next-line promise/no-multiple-resolved
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish();
    }, 2000);
    if (child.exitCode !== null) return finish();
    child.once("exit", finish);
  });
  fs.rmSync(stateDir, { recursive: true, force: true });
}
