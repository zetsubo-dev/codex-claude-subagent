import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

export const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function openMcp({ stateDir, env = {}, cwd = pluginDir } = {}) {
  const entry = process.env.CODEX_CLAUDE_SUBAGENT_TEST_SOURCE === "1" ? "server.mjs" : "server.bundle.mjs";
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, CODEX_CLAUDE_SUBAGENT_STATE_DIR: stateDir, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffer = "";
  let nextId = 0;
  const pending = new Map();
  const decoder = new StringDecoder("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
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
      waiter.reject(new Error(`MCP exited ${code}/${signal}. ${stderr}`));
    }
    pending.clear();
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method, params = {}, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout ${method}. ${stderr}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  const raw = (name, args = {}) => request("tools/call", { name, arguments: args });
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    const value = JSON.parse(result.content[0].text);
    if (result.isError) throw Object.assign(new Error(JSON.stringify(value)), { result: value });
    return value;
  };
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
    child.stdin.end();
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "answer-delivery-fixture", version: "0.0.0" },
    });
    send({ method: "notifications/initialized", params: {} });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    child,
    call,
    raw,
    request,
    close,
    get stderr() {
      return stderr;
    },
  };
}
