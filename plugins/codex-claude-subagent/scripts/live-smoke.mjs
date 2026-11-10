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

const cwd = fs.realpathSync(path.resolve(process.argv.slice(2).find((arg) => arg !== "--") || process.cwd()));
const checkBackground = process.argv.includes("--background");
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
  if (reviewed.request.completion_transport !== "claude_code_mod") {
    throw new Error("Live request did not complete through the native lifecycle observer.");
  }

  let backgroundProof = null;
  if (checkBackground) {
    const background = parsed(
      await callTool("claude_interactive_request", {
        cwd,
        interactive_id: started.interactive_id,
        idle_ms: null,
        timeout_ms: 120000,
        text: "Run Bash with command sleep 12 using run_in_background:true. Immediately reply BACKGROUND_STARTED without waiting or using another tool. Do not modify files.",
      }),
    );
    if (
      !background.request.done ||
      !background.request.work_pending ||
      background.request.completion_scope !== "main_turn"
    ) {
      throw new Error("Background job did not yield native main-turn completion with work_pending.");
    }
    const firstTurn = background.latest_native_outcome?.turn_id;
    let sawWake = false;
    let wakeCompleted = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const view = parsed(
        await callTool("claude_interactive_read", { cwd, interactive_id: started.interactive_id, max_chars: 100 }),
      );
      if (view.native_active_turn_id && !sawWake) {
        sawWake = true;
        const rejected = await callTool("claude_interactive_send", {
          cwd,
          interactive_id: started.interactive_id,
          text: "MUST_NOT_SEND",
          submit: false,
        });
        if (!rejected.isError) throw new Error("Input was not rejected during the native background wake turn.");
      }
      if (
        !view.native_active_turn_id &&
        view.latest_native_outcome?.turn_id !== firstTurn &&
        view.latest_native_outcome?.background_tasks_pending === 0
      ) {
        wakeCompleted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!sawWake || !wakeCompleted) throw new Error("Background wake turn was not observed through completion.");
    const followup = parsed(
      await callTool("claude_interactive_request", {
        cwd,
        interactive_id: started.interactive_id,
        text: "Reply FOLLOWUP_OK. Do not use tools.",
        idle_ms: null,
        timeout_ms: 60000,
      }),
    );
    if (!followup.request.done || !followup.request.result_text?.includes("FOLLOWUP_OK"))
      throw new Error("Input did not unlock after background wake completion.");
    backgroundProof = {
      main_turn_completed_with_work_pending: true,
      wake_input_rejected: true,
      wake_completed: true,
      followup_completed: true,
    };
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
  const continued = parsed(
    await callTool("claude_interactive_request", {
      cwd,
      interactive_id: resumed.interactive_id,
      text: "Reply with exactly RESUME_OK. Do not use tools or modify files.",
      idle_ms: null,
      timeout_ms: 180000,
    }),
  );
  if (
    !continued.request.done ||
    !continued.request.result_text?.includes("RESUME_OK") ||
    continued.request.completion_transport !== "claude_code_mod"
  ) {
    throw new Error("Resumed session failed its native completion round trip.");
  }
  const resumedStop = parsed(
    await callTool("claude_interactive_stop", { cwd, interactive_id: resumed.interactive_id }),
  );
  if (!resumedStop.stop.exited) throw new Error("Resumed Claude session did not stop cleanly.");
  liveSessions.splice(liveSessions.indexOf(resumed.interactive_id), 1);

  console.log(
    JSON.stringify(
      {
        ok: true,
        cwd,
        claude_session_id: started.claude_session_id,
        completion_transport: reviewed.request.completion_transport,
        observed: reviewed.request.observed,
        resumed_round_trip: true,
        background: backgroundProof,
      },
      null,
      2,
    ),
  );
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
