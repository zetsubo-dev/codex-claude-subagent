#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CODEX_CLAUDE_SUBAGENT_RUN_LIVE !== "1") {
  throw new Error("Set CODEX_CLAUDE_SUBAGENT_RUN_LIVE=1 to run the subscription-backed Claude Code smoke test.");
}

const cwd = fs.realpathSync(path.resolve(process.argv[2] || process.cwd()));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-subagent-live-"));
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "codex-claude-subagent-live-smoke", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["server.bundle.mjs"],
  cwd: pluginDir,
  env: {
    ...process.env,
    CODEX_CLAUDE_SUBAGENT_STATE_DIR: stateDir,
  },
  stderr: "pipe",
});

function parsed(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text || "Codex–Claude Subagent tool failed.");
  return JSON.parse(result.content[0].text);
}

function callTool(name, args, timeout = 240000) {
  return client.callTool({ name, arguments: args }, undefined, { timeout });
}

const liveSessions = [];
try {
  await client.connect(transport);
  const started = parsed(
    await callTool("claude_interactive_start", {
      cwd,
      role: "reviewer",
      model: "opus",
      effort: "low",
      mcp_preset: "none",
      name: "codex-claude-subagent live smoke",
    }),
  );
  liveSessions.push(started.interactive_id);

  const reviewed = parsed(
    await callTool("claude_interactive_request", {
      cwd,
      interactive_id: started.interactive_id,
      text: "Run git status --short read-only, then reply with exactly LIVE_OK. Do not modify files.",
      idle_ms: null,
      timeout_ms: 180000,
    }),
  );
  const resultText = reviewed.request.result_text || reviewed.output_tail || "";
  if (!reviewed.request.done || !resultText.includes("LIVE_OK")) {
    throw new Error(`Live review did not complete as expected: ${JSON.stringify(reviewed.request)}`);
  }

  const stopped = parsed(await callTool("claude_interactive_stop", { cwd, interactive_id: started.interactive_id }));
  if (!stopped.stop.exited) throw new Error("Live Claude session did not stop cleanly.");
  liveSessions.splice(liveSessions.indexOf(started.interactive_id), 1);

  const resumed = parsed(
    await callTool("claude_interactive_start", {
      cwd,
      role: "reviewer",
      model: "opus",
      effort: "low",
      mcp_preset: "none",
      name: "codex-claude-subagent live resume smoke",
      resume_claude_session_id: started.claude_session_id,
    }),
  );
  liveSessions.push(resumed.interactive_id);
  const resumedReady = parsed(
    await callTool("claude_interactive_wait", {
      cwd,
      interactive_id: resumed.interactive_id,
      since_seq: 0,
      idle_ms: 1000,
      timeout_ms: 15000,
    }),
  );
  if (resumedReady.status !== "running") throw new Error("Resumed Claude session did not stay running.");
  const resumedStop = parsed(
    await callTool("claude_interactive_stop", { cwd, interactive_id: resumed.interactive_id }),
  );
  if (!resumedStop.stop.exited) throw new Error("Resumed Claude session did not stop cleanly.");
  liveSessions.splice(liveSessions.indexOf(resumed.interactive_id), 1);

  console.log(JSON.stringify({ ok: true, cwd, claude_session_id: started.claude_session_id }, null, 2));
} finally {
  for (const interactiveId of liveSessions) {
    try {
      await callTool("claude_interactive_stop", { cwd, interactive_id: interactiveId, wait_ms: 3000 }, 10000);
    } catch {
      // Closing the MCP transport also terminates any remaining PTY bridge.
    }
  }
  await client.close().catch(() => {});
  fs.rmSync(stateDir, { recursive: true, force: true });
}
