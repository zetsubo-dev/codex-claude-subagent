#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-subagent-test-"));
const stateDir = path.join(tmpRoot, "state");
const binDir = path.join(tmpRoot, "bin");
const projectDir = path.join(tmpRoot, "project");
const plainProjectDir = path.join(tmpRoot, "plain-project");
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(plainProjectDir, { recursive: true });
fs.mkdirSync(path.join(plainProjectDir, ".claude", "rules"), { recursive: true });
fs.writeFileSync(path.join(plainProjectDir, "CLAUDE.md"), "# Test project instructions\nUse exact evidence.\n");
fs.writeFileSync(path.join(plainProjectDir, ".claude", "rules", "review.md"), "# Review rules\nStay read-only.\n");
fs.writeFileSync(
  path.join(projectDir, ".mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        serena: {
          type: "stdio",
          command: "serena",
          args: ["start-mcp-server", "--project-from-cwd", "--context=claude-code"],
          env: {},
        },
        context7: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp@3.2.2"],
          env: {},
        },
        unsafe_docs: { command: "unsafe-docs-mcp-server" },
      },
    },
    null,
    2,
  ),
);
const fakeClaude = path.join(binDir, "claude");
fs.writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const supportsSettings = process.env.FAKE_CLAUDE_DISABLE_SETTINGS !== "1";
const supportsMcpConfig = process.env.FAKE_CLAUDE_DISABLE_MCP_CONFIG !== "1";
const supportsWorktree = process.env.FAKE_CLAUDE_DISABLE_WORKTREE !== "1";
if (args.includes("--version")) {
  if (
    process.env.FAKE_CLAUDE_VERSION_TIMEOUT === "1" &&
    (!process.env.FAKE_CLAUDE_DETECT_STARTED_FILE || !fs.existsSync(process.env.FAKE_CLAUDE_DETECT_STARTED_FILE))
  ) {
    if (process.env.FAKE_CLAUDE_DETECT_STARTED_FILE) fs.writeFileSync(process.env.FAKE_CLAUDE_DETECT_STARTED_FILE, "started");
    setInterval(() => {}, 1000);
    return;
  }
  console.log("fake-claude 0.0.0");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log("  --plugin-dir <path>");
  console.log("Usage: claude [options] [prompt]\\n  --allowedTools\\n" + (supportsMcpConfig ? "  --mcp-config\\n  --strict-mcp-config\\n" : "") + (supportsSettings ? "  --settings <file-or-json>\\n" : "") + "  --setting-sources <sources>\\n  --append-system-prompt-file <path>\\n" + (supportsWorktree ? "  --worktree\\n" : "") + "  --session-id <uuid>\\n  --resume [value]\\n  --continue\\n  --model <model> e.g. 'fable', 'opus', 'sonnet', 'claude-fable-5', or 'claude-opus-4-8'");
  process.exit(0);
}
if (args.includes("-p") || args.includes("--bg")) {
  console.error("print/background mode should not be used");
  process.exit(2);
}
const sensitiveEnvNames = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
]);
if (Object.keys(process.env).some((name) => sensitiveEnvNames.has(name.toUpperCase()))) {
  console.error("API or gateway credentials leaked into interactive Claude");
  process.exit(3);
}
const authIndex = args.indexOf("auth");
if (authIndex >= 0 && args[authIndex + 1] === "status") {
  if (process.env.FAKE_CLAUDE_AUTH_ARGS_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_AUTH_ARGS_LOG, JSON.stringify(args) + "\\n");
  if (process.env.FAKE_CLAUDE_AUTH_CWD_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_AUTH_CWD_LOG, process.cwd() + "\\n");
  const sourceIndex = args.indexOf("--setting-sources");
  const helperActive = process.env.FAKE_CLAUDE_API_KEY_HELPER === "1" && args[sourceIndex + 1] !== "";
  const mode = helperActive ? "api" : process.env.FAKE_CLAUDE_AUTH_MODE || "max";
  if (mode === "max") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
  } else if (mode === "team") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "team" }));
  } else if (mode === "unknown_plan") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
  } else if (mode === "malformed") {
    console.log("not-json");
  } else if (mode === "timeout") {
    if (process.env.FAKE_CLAUDE_AUTH_STARTED_FILE) fs.writeFileSync(process.env.FAKE_CLAUDE_AUTH_STARTED_FILE, "started");
    setInterval(() => {}, 1000);
    return;
  } else if (mode === "secret_metadata") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "secret:do-not-return", subscriptionType: "max" }));
  } else if (mode === "status_nonzero") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
    console.error("secret-proxy-password-should-not-be-returned");
    process.exit(1);
  } else if (mode === "unsupported") {
    console.error("unknown command: auth");
    process.exit(1);
  } else if (mode === "api") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }));
  } else {
    console.log(JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }));
    process.exit(1);
  }
  process.exit(0);
}
if (args.includes("doctor")) {
  if (process.env.FAKE_CLAUDE_DOCTOR_CALLED_FILE) fs.writeFileSync(process.env.FAKE_CLAUDE_DOCTOR_CALLED_FILE, "called");
  if (process.env.FAKE_CLAUDE_DOCTOR_MODE === "keychain_unwritable") {
    console.log("- Not signed in to claude.ai");
    console.log("- Sign-in is missing the user:profile scope");
    console.log("- macOS Keychain is not writable. Fix: Run: security unlock-keychain ~/Library/Keychains/login.keychain-db");
  } else {
    console.log("Claude Code doctor: no keychain issue detected");
  }
  process.exit(0);
}
const settingsIndex = args.indexOf("--settings");
const hookSettings = settingsIndex >= 0 ? JSON.parse(fs.readFileSync(args[settingsIndex + 1], "utf8")) : { hooks: {} };
const settingSourcesIndex = args.indexOf("--setting-sources");
if (settingSourcesIndex < 0 || !["", "project", "user", "user,project,local"].includes(args[settingSourcesIndex + 1])) {
  console.error("supported setting source was not enabled");
  process.exit(5);
}
const instructionIndex = args.indexOf("--append-system-prompt-file");
if (instructionIndex < 0 || !fs.existsSync(args[instructionIndex + 1])) {
  console.error("review-only instruction was not supplied");
  process.exit(6);
}
const sessionIdIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
const resumeEquals = args.find((arg) => arg.startsWith("--resume="));
const fakeSessionId = sessionIdIndex >= 0
  ? args[sessionIdIndex + 1]
  : resumeEquals
    ? resumeEquals.slice("--resume=".length)
  : resumeIndex >= 0 && args[resumeIndex + 1]
    ? args[resumeIndex + 1]
    : "00000000-0000-4000-8000-000000000001";
function runHook(eventName, extra) {
  if (process.env.FAKE_CLAUDE_SKIP_HOOKS === "1") return;
  const groups = hookSettings.hooks?.[eventName] || [];
  const results = [];
  for (const group of groups) {
    for (const hook of group.hooks || []) {
      if (hook.type !== "command") continue;
      const payload = {
        session_id: fakeSessionId,
        cwd: process.cwd(),
        permission_mode: "bypassPermissions",
        hook_event_name: eventName,
        ...(extra || {}),
      };
      const result = spawnSync(hook.command, {
        shell: true,
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
      results.push({ hook, result });
      if (result.status !== 0) {
        console.error("fake hook failed: " + (result.stderr || result.error?.message || result.status));
      }
    }
  }
  return results;
}
let nativeSeq = 0;
let nativeToken = null;
let nativeTurnId = null;
if (process.env.FAKE_CLAUDE_OBSERVER_META) fs.writeFileSync(process.env.FAKE_CLAUDE_OBSERVER_META, JSON.stringify({
  directory: process.env.CODEX_CLAUDE_SUBAGENT_OBSERVER_DIR, generation: process.env.CODEX_CLAUDE_SUBAGENT_OBSERVER_GENERATION, session_id: fakeSessionId,
}));
function nativeEvent(kind, extra = {}) {
  const dir = process.env.CODEX_CLAUDE_SUBAGENT_OBSERVER_DIR;
  if (!dir || process.env.FAKE_CLAUDE_SKIP_OBSERVER === "1") return;
  const seq = ++nativeSeq;
  const event = { schema: 1, seq, generation: process.env.CODEX_CLAUDE_SUBAGENT_OBSERVER_GENERATION,
    session_id: fakeSessionId, request_token: nativeToken, turn_id: nativeTurnId,
    kind, at: new Date().toISOString(), ...extra };
  fs.writeFileSync(dir + "/event-" + String(seq).padStart(8,"0") + ".json", JSON.stringify(event));
}
function nativeComplete(extra) {
  const raw = process.env.FAKE_CLAUDE_NATIVE_EMPTY === "1" ? "" : String(extra.last_assistant_message || "");
  let answer = raw.slice(0, 64000);
  const code = answer.charCodeAt(answer.length - 1);
  if (code >= 0xd800 && code <= 0xdbff) answer = answer.slice(0,-1);
  if (answer.length < raw.length) answer += "\\n[codex-claude-subagent: native answer truncated to at most 64,000 UTF-16 code units; the rest is not in this field and may or may not be in the terminal log]";
  const reason = process.env.FAKE_CLAUDE_NATIVE_REASON || "answer";
  nativeEvent("turn.complete", { reason, is_aborted: reason === "aborted", agent_id: null,
    answer,
    answer_truncated: raw.length > 64000,
    stop: { blocked: process.env.FAKE_CLAUDE_STOP_BLOCKED === "1", prevent_continuation: process.env.FAKE_CLAUDE_PREVENT === "1",
      background_tasks_pending: process.env.FAKE_CLAUDE_BACKGROUND_PENDING === "unknown" ? null : process.env.FAKE_CLAUDE_BACKGROUND_PENDING === "1" ? 1 : extra.background_tasks?.length || 0,
      session_crons_pending: process.env.FAKE_CLAUDE_CRON_PENDING === "1" ? 1 : extra.session_crons?.length || 0 },
    last_api_model: "fake-model", observed: { model: "fake-model", effort: "medium" } });
}
function emitHook(eventName, extra) {
  runHook(eventName, extra);
  if (eventName === "SessionStart") nativeEvent("ready", { version: { version: "2.1.322" } });
  if (eventName === "UserPromptSubmit") {
    nativeToken = [...String(extra.prompt || "").matchAll(/Codex–Claude Subagent correlation token:\\s*(CODEX_CLAUDE_SUBAGENT_REQUEST_[a-z0-9_]+)/g)].at(-1)?.[1] || null;
    nativeTurnId = crypto.randomUUID();
    nativeEvent("turn.start");
  }
  if (eventName === "Stop") {
    setTimeout(() => nativeComplete(extra), Number(process.env.FAKE_CLAUDE_NATIVE_DELAY_MS || 40));
    if (process.env.FAKE_CLAUDE_TOKENLESS_WAKE === "1") setTimeout(() => {
      nativeToken = null;
      nativeTurnId = crypto.randomUUID();
      nativeEvent("turn.start");
      setTimeout(() => nativeComplete({ last_assistant_message: "BACKGROUND_FINISHED" }), 1500);
    }, 300);
  }
}
if (process.env.FAKE_CLAUDE_STARTUP_DIALOG) {
  console.log(process.env.FAKE_CLAUDE_STARTUP_DIALOG === "trust" ? "Quick safety check: Is this a project you trust? Yes, I trust this folder" : "Bypass Permissions mode: Yes, I accept");
  process.stdin.on("data", () => { if (process.env.FAKE_CLAUDE_UNEXPECTED_INPUT) fs.writeFileSync(process.env.FAKE_CLAUDE_UNEXPECTED_INPUT, "received"); });
  process.stdin.resume();
  return;
}
if (process.env.FAKE_CLAUDE_STARTUP_SELECTOR === "1") {
  console.log("New MCP servers found. Select any you wish to enable");
  process.stdin.once("data", () => console.log("\\x1b[2Jfake interactive ready"));
}
if (process.env.FAKE_CLAUDE_CAP_OUTPUT === "1") {
  process.stdout.write("123456789012345678🙂TAIL\\n");
} else {
  console.log("fake interactive ready");
}
setTimeout(() => emitHook("SessionStart", {}), 10);
if (process.env.FAKE_CLAUDE_EXACT_BODY === "1" && process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let inputBuffer = "";
let helloHandled = false;
let reviewHandled = false;
let exactBodyHandled = false;
let neverHandled = false;
let silentHandled = false;
let retrySubmitHandled = false;
let hardTimeoutHandled = false;
let spamHandled = false;
let longPasteHandled = false;
let longOutputHandled = false;
let slowHandled = false;
let utf8Handled = false;
let hookFailureHandled = false;
let delayedHookFailureHandled = false;
let longHookResultHandled = false;
let permissionHandled = false;
let scheduleExhaustionHandled = false;
function latestMarkerSuffix() {
  const matches = [...inputBuffer.matchAll(/2\\.\\s*([a-z0-9_]+)/ig)];
  return matches.length ? matches[matches.length - 1][1] : null;
}
function hasSubmittedText(text) {
  const index = inputBuffer.indexOf(text);
  return index >= 0 && /[\\r\\n]/.test(inputBuffer.slice(index + text.length));
}
function submittedPrompt() {
  return { prompt: inputBuffer };
}
process.stdin.on("data", (data) => {
  if (process.env.FAKE_CLAUDE_INPUT_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_INPUT_LOG, data);
  inputBuffer += data;
  if (process.env.FAKE_CLAUDE_EXACT_BODY === "1" && !exactBodyHandled && inputBuffer.includes("\\x1b[201~\\r")) {
    exactBodyHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    emitHook("Stop", { last_assistant_message: "ORDINARY_CONTEXT_INTEGRITY_SENTINEL_🙂" });
  }
  if (!helloHandled && hasSubmittedText("hello interactive")) {
    helloHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    console.log("assistant: interactive reply");
    emitHook("Stop", { last_assistant_message: "interactive reply" });
  }
  if (!reviewHandled && hasSubmittedText("review this")) {
    reviewHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    setTimeout(() => {
      console.log("assistant: review complete");
      const suffix = latestMarkerSuffix();
      if (inputBuffer.includes("1. CODEX_CLAUDE_SUBAGENT_DONE_") && suffix) {
        console.log("CODEX_CLAUDE_SUBAGENT_DONE_" + suffix);
      }
      emitHook("Stop", { last_assistant_message: "review complete" });
    }, 100);
  }
  if (!neverHandled && hasSubmittedText("never marker")) {
    neverHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    console.log("assistant: intentionally not printing completion marker");
    setTimeout(() => {
      console.log("assistant: marker omitted but turn ended");
      emitHook("Stop", { last_assistant_message: "marker omitted but turn ended" });
    }, 800);
  }
  if (!silentHandled && hasSubmittedText("silent marker")) {
    silentHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
  }
  if (!retrySubmitHandled && inputBuffer.includes("retry submit request")) {
    const retryText = inputBuffer.slice(inputBuffer.indexOf("retry submit request"));
    const pasteEnd = retryText.indexOf("\\x1b[201~");
    const submittedEnters = pasteEnd === -1 ? "" : retryText.slice(pasteEnd + "\\x1b[201~".length);
    if ((submittedEnters.match(/[\\r\\n]/g) || []).length >= 2) {
      retrySubmitHandled = true;
      emitHook("UserPromptSubmit", submittedPrompt());
      console.log("assistant: retry submit complete");
      emitHook("Stop", { last_assistant_message: "retry submit complete" });
    }
  }
  if (!hardTimeoutHandled && hasSubmittedText("hard timeout marker")) {
    hardTimeoutHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    console.log("assistant: marker still omitted");
    setTimeout(() => {
      emitHook("Stop", { last_assistant_message: "hard timeout eventually ended" });
    }, 1200);
  }
  if (!spamHandled && hasSubmittedText("spam marker")) {
    spamHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    setTimeout(() => {
      for (let index = 0; index < 260; index += 1) {
        console.log("spam chunk " + index);
      }
      const suffix = latestMarkerSuffix();
      if (inputBuffer.includes("1. CODEX_CLAUDE_SUBAGENT_DONE_") && suffix) {
        console.log("CODEX_CLAUDE_SUBAGENT_DONE_" + suffix);
      }
      emitHook("Stop", { last_assistant_message: "spam complete" });
    }, 100);
  }
  if (!longPasteHandled && inputBuffer.includes("LONG_PAYLOAD_BEGIN") && hasSubmittedText("LONG_PAYLOAD_END")) {
    longPasteHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    setTimeout(() => {
      console.log("assistant: long paste received");
      const suffix = latestMarkerSuffix();
      if (inputBuffer.includes("1. CODEX_CLAUDE_SUBAGENT_DONE_") && suffix) {
        console.log("CODEX_CLAUDE_SUBAGENT_DONE_" + suffix);
      }
      emitHook("Stop", { last_assistant_message: "long paste received" });
    }, 100);
  }
  if (!longOutputHandled && hasSubmittedText("long output marker")) {
    longOutputHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    setTimeout(() => {
      for (let index = 0; index < 5000; index += 1) {
        console.log("LONG_OUTPUT_LINE_" + index.toString().padStart(5, "0") + "_abcdefghijklmnopqrstuvwxyz");
      }
      console.log("LONG_OUTPUT_END");
      const suffix = latestMarkerSuffix();
      if (inputBuffer.includes("1. CODEX_CLAUDE_SUBAGENT_DONE_") && suffix) {
        console.log("CODEX_CLAUDE_SUBAGENT_DONE_" + suffix);
      }
      emitHook("Stop", { last_assistant_message: "long output complete" });
    }, 100);
  }
  if (!slowHandled && hasSubmittedText("slow hook request")) {
    slowHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    console.log("assistant: slow request started");
    setTimeout(() => {
      console.log("assistant: slow request complete");
      emitHook("Stop", { last_assistant_message: "slow request complete" });
    }, 400);
  }
  if (!utf8Handled && hasSubmittedText("utf8 split request")) {
    utf8Handled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    const utf8 = Buffer.from("日本語🙂完了", "utf8");
    setTimeout(() => {
      process.stdout.write(utf8.subarray(0, 2));
      setTimeout(() => {
        process.stdout.write(utf8.subarray(2));
        process.stdout.write("\\n", () => emitHook("Stop", { last_assistant_message: "日本語🙂完了" }));
      }, 20);
    }, 100);
  }
  if (!hookFailureHandled && hasSubmittedText("hook failure request")) {
    hookFailureHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    console.log("assistant: simulated rate limit");
    emitHook("StopFailure", {
      error: "rate_limit",
      error_details: { message: "simulated" },
      last_assistant_message: "rate limited",
    });
  }
  if (!delayedHookFailureHandled && hasSubmittedText("delayed hook failure request")) {
    delayedHookFailureHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    setTimeout(() => {
      const suffix = latestMarkerSuffix();
      if (inputBuffer.includes("1. CODEX_CLAUDE_SUBAGENT_DONE_") && suffix) {
        console.log("CODEX_CLAUDE_SUBAGENT_DONE_" + suffix);
      }
    }, 50);
    setTimeout(() => {
      emitHook("StopFailure", {
        error: "delayed_rate_limit",
        last_assistant_message: "delayed rate limit",
      });
    }, 500);
  }
  if (!longHookResultHandled && hasSubmittedText("long hook result request")) {
    longHookResultHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    emitHook("Stop", { last_assistant_message: "RESULT_BEGIN_" + "🙂".repeat(40000) + "_RESULT_END" });
  }
  if (!permissionHandled && hasSubmittedText("permission attention request")) {
    permissionHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    emitHook("Notification", {
      notification_type: "permission_prompt",
      message: "review command permission attention",
    });
    emitHook("Notification", {
      notification_type: "permission_prompt",
      message: "review command permission attention",
    });
    console.log("assistant: permission prompt attention");
    setTimeout(() => {
      emitHook("Stop", { last_assistant_message: "permission attention complete" });
    }, 1800);
  }
  if (!scheduleExhaustionHandled && hasSubmittedText("schedule exhaustion request")) {
    scheduleExhaustionHandled = true;
    emitHook("UserPromptSubmit", submittedPrompt());
    console.log("assistant: schedule exhaustion request remains active");
  }
  if (data.includes("/exit")) {
    console.log("fake interactive exiting");
    process.exit(0);
  }
});
setInterval(() => {}, 1000);
`,
  { mode: 0o755 },
);

const duplexChild = path.join(tmpRoot, "duplex-child.mjs");
fs.writeFileSync(
  duplexChild,
  `#!/usr/bin/env node
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.resume();
let inputBytes = 0;
let inputDone = false;
let outputDone = false;
function finish() {
  if (!inputDone || !outputDone) return;
  process.stdout.write("\\nDUPLEX_INPUT_DONE_" + inputBytes + "\\n", () => process.exit(0));
}
process.stdin.on("data", (chunk) => {
  inputBytes += chunk.length;
  if (inputBytes >= 1024 * 1024) inputDone = true;
  finish();
});
process.stdout.write(Buffer.alloc(1024 * 1024, 79), () => {
  outputDone = true;
  finish();
});
`,
  { mode: 0o755 },
);

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Run the production pure projection against frozen, aliased canonical data.
// Integration tests below cover the actual MCP serialization and registry.
{
  const source = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const project = vm.runInNewContext(
    source.slice(source.indexOf("function projectPublicResponse("), source.indexOf("function textResult(")) +
      "\nprojectPublicResponse",
  );
  const event = Object.freeze({
    answer: "projection sentinel",
    last_assistant_message: "projection sentinel",
    answer_truncated: true,
    last_assistant_message_truncated: true,
    notification_type: "permission_prompt",
  });
  const wait = Object.freeze({ reason: "hook", matched_hook: event });
  const request = Object.freeze({ result_text: "projection sentinel", completion_event: event, last_wait: wait, wait });
  const canonical = Object.freeze({
    request,
    last_request: request,
    active_request: null,
    wait,
    last_hook_event: event,
    latest_native_outcome: Object.freeze({ answer: "projection sentinel" }),
  });
  const before = JSON.stringify(canonical);
  const view = project(canonical);
  assert(canonical.wait === canonical.request.last_wait, "canonical wait alias was lost");
  assert(JSON.stringify(canonical) === before, "public projection mutated canonical state");
  assert(view.request !== request && view.request.last_wait !== wait, "projection reused canonical request/wait");
  for (const projectedEvent of [
    view.request.completion_event,
    view.request.last_wait.matched_hook,
    view.request.wait.matched_hook,
    view.wait.matched_hook,
  ]) {
    assert(
      !Object.hasOwn(projectedEvent, "answer") && !Object.hasOwn(projectedEvent, "last_assistant_message"),
      "duplicate event text remained",
    );
    assert(
      projectedEvent.answer_truncated &&
        projectedEvent.last_assistant_message_truncated &&
        projectedEvent.notification_type === "permission_prompt",
      "projection removed event metadata",
    );
  }
  assert(!Object.hasOwn(view.last_hook_event, "last_assistant_message"), "session duplicate remained");
  assert(!Object.hasOwn(view.latest_native_outcome, "answer_truncated"), "legacy truncation became false");
  for (const result_text of [null, "different text"]) {
    const unique = project({ request: { ...request, result_text }, last_hook_event: event });
    assert(unique.request.completion_event.answer === event.answer, "unique answer was deleted");
    assert(
      unique.request.last_wait.matched_hook.last_assistant_message === event.last_assistant_message,
      "unique wait diagnostic was deleted",
    );
    assert(
      unique.last_hook_event.last_assistant_message === event.last_assistant_message,
      "unmatched session diagnostic was deleted",
    );
  }
}

async function waitForFile(filePath, timeoutMs = 2000) {
  const started = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCondition(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const activeClients = new Set();
function createTestClient(testStateDir, extraEnv = {}) {
  const testClient = new Client({ name: "codex-claude-subagent-test", version: "0.0.0" });
  const testTransport = new StdioClientTransport({
    command: "node",
    args: ["server.bundle.mjs"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: path.join(tmpRoot, "claude-config"),
      ANTHROPIC_API_KEY: "must-not-reach-interactive-child",
      ANTHROPIC_AUTH_TOKEN: "must-not-reach-interactive-child",
      ANTHROPIC_BASE_URL: "https://must-not-reach.invalid",
      CODEX_CLAUDE_SUBAGENT_STATE_DIR: testStateDir,
      CODEX_CLAUDE_SUBAGENT_MAX_LOG_BYTES: "2000000",
      CODEX_CLAUDE_SUBAGENT_MAX_HOOK_FILE_BYTES: "1800",
      CODEX_CLAUDE_SUBAGENT_HOOK_COMPLETION_GRACE_MS: "1000",
      CODEX_CLAUDE_SUBAGENT_STARTUP_READY_IDLE_MS: "25",
      CODEX_CLAUDE_SUBAGENT_STARTUP_READY_TIMEOUT_MS: "1000",
      CODEX_CLAUDE_SUBAGENT_SUBMIT_AFTER_PASTE_MS: "1",
      CODEX_CLAUDE_SUBAGENT_SUBMIT_AFTER_PASTE_LINE_MS: "1",
      CODEX_CLAUDE_SUBAGENT_SUBMIT_AFTER_PASTE_MAX_MS: "50",
      CODEX_CLAUDE_SUBAGENT_SUBMIT_ENTER_COUNT: "1",
      CODEX_CLAUDE_SUBAGENT_SUBMIT_ENTER_GAP_MS: "1",
      CODEX_CLAUDE_SUBAGENT_SUBMIT_CONFIRM_TIMEOUT_MS: "500",
      CODEX_CLAUDE_SUBAGENT_SUBMIT_CONFIRM_ATTEMPTS: "2",
      CODEX_CLAUDE_SUBAGENT_AUTH_STATUS_TIMEOUT_MS: "300",
      CODEX_CLAUDE_SUBAGENT_AUTH_DOCTOR_TIMEOUT_MS: "300",
      CODEX_CLAUDE_SUBAGENT_REQUEST_WAIT_SCHEDULE_MS: "100,200,300,400,500,600,900,1200,1800",
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      ...extraEnv,
    },
    stderr: "pipe",
  });
  activeClients.add(testClient);
  return { client: testClient, transport: testTransport };
}

const primary = createTestClient(stateDir);
const client = primary.client;
const transport = primary.transport;

let handlingFatalError = false;
async function handleFatalError(error) {
  if (handlingFatalError) return;
  handlingFatalError = true;
  try {
    for (const activeClient of activeClients) {
      try {
        await activeClient.close();
      } catch {
        // Preserve the original test failure.
      }
    }
  } catch {
    // Preserve the original test failure.
  }
  console.error(error?.stack || error);
  process.exitCode = 1;
}

process.on("uncaughtException", handleFatalError);
process.on("unhandledRejection", handleFatalError);

await client.connect(transport);

const info = parseToolResult(await client.callTool({ name: "codex_claude_subagent_info", arguments: {} }));
const manifestVersion = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), ".codex-plugin", "plugin.json"), "utf8"),
).version;
assert(info.version === manifestVersion, "server did not report the installed plugin cachebuster version");
assert(info.state_dir === stateDir, "server did not use isolated state dir");
assert(info.max_log_bytes === 2000000, "server did not use validated log cap");
assert(info.default_wait_timeout_ms === 1800000, "server did not report default low-level wait timeout");
assert(info.max_wait_timeout_ms === 3600000, "server did not report max low-level wait timeout");
assert(info.default_request_timeout_ms === 300000, "server did not report default request timeout");
assert(info.default_request_idle_ms === 30000, "server did not report default request idle timeout");
assert(info.max_request_idle_ms === 300000, "server did not report max request idle timeout");
assert(info.hook_completion_grace_ms === 1000, "server did not use hook completion grace override");
assert(info.default_log_read_bytes === 200000, "server did not report default log read bytes");
assert(info.max_log_read_bytes === 1048576, "server did not report max log read bytes");
assert(info.startup_ready_idle_ms === 25, "server did not use startup readiness idle override");
assert(info.startup_ready_timeout_ms === 1000, "server did not use startup readiness timeout override");
assert(info.submit_after_paste_ms === 1, "server did not use submit-after-paste override");
assert(info.submit_after_paste_line_ms === 1, "server did not use submit-after-paste line override");
assert(info.submit_after_paste_max_ms === 50, "server did not use submit-after-paste max override");
assert(info.submit_enter_count === 1, "server did not use submit enter count override");
assert(info.submit_enter_gap_ms === 1, "server did not use submit enter gap override");
assert(info.submit_confirm_timeout_ms === 500, "server did not use submit confirm timeout override");
assert(info.submit_confirm_attempts === 2, "server did not use submit confirm attempts override");
assert(info.claude.available === true, "fake claude was not detected");
assert(info.claude.auth.ready === true, "fake Claude Max authentication was not ready");
assert(info.claude.auth.auth_method === "claude.ai", "fake Claude auth method was not reported");
assert(info.claude.auth.subscription_type === "max", "fake Claude subscription type was not reported");
assert(info.claude.auth.billing_mode === "claude_subscription", "fake Claude billing mode was not subscription-only");
assert(info.claude.capabilities.allowed_tools === true, "allowedTools capability was not detected");
assert(info.claude.capabilities.mcp_config === true, "mcp-config capability was not detected");
assert(info.claude.capabilities.settings === true, "settings capability was not detected");
assert(info.claude.capabilities.setting_sources === true, "setting-sources capability was not detected");
assert(
  info.claude.capabilities.append_system_prompt_file === true,
  "append-system-prompt-file capability was not detected",
);
assert(info.claude.capabilities.session_id === true, "session-id capability was not detected");
assert(info.claude.capabilities.resume === true, "resume capability was not detected");
assert(info.claude.capabilities.continue === true, "continue capability was not detected");
assert(info.claude.capabilities.fable_alias === true, "Fable alias capability was not detected");
assert(info.claude.capabilities.fable_5 === true, "Fable 5 capability was not detected");
assert(info.claude.capabilities.model_passthrough === true, "model pass-through capability was not reported");
assert(info.claude.capabilities.effort_passthrough === true, "effort pass-through capability was not reported");
assert(Array.isArray(info.claude.capabilities.supported_efforts), "supported effort values were not reported");
assert(info.mcp_presets.default_read_only === "auto", "read-only MCP preset default was not reported");
assert(Object.hasOwn(info.roles, "implementer"), "implementer role was not exposed");
assert(
  Object.values(info.roles).every((role) => role.permissionMode === "bypassPermissions"),
  "all roles must bypass Claude Code permission prompts",
);
assert(info.roles.implementer.mode === "implementation", "implementer mode was not reported");
assert(info.roles.implementer.mutates_files === true, "implementer mutability was not reported");
assert(info.roles.implementer.requires_worktree === false, "implementer worktree requirement was not disabled");
assert(info.roles.implementer.filesystem_isolation === "none", "implementer direct project contract was not reported");
assert(info.policy.caller === "ai_agent", "machine caller policy was not reported");
assert(info.policy.implementer_requires_claude_worktree === false, "implementer worktree policy was not disabled");
assert(info.policy.implementer_filesystem_isolation === "none", "implementer direct project policy was not reported");
assert(info.policy.nested_subagents === "explicit_only", "explicit subagent policy was not reported");
assert(info.policy.default_subagent_mode === "disabled", "single-agent default was not reported");
assert(info.policy.effort_passthrough === true, "effort pass-through policy was not reported");
assert(Array.isArray(info.policy.forwarded_claude_arg_flags), "forwarded Claude argument policy was not reported");
assert(!Object.hasOwn(info.roles, "test_runner"), "Bash-capable test_runner role should not be exposed");
for (const role of ["reviewer", "security_reviewer", "critic"]) {
  assert(info.roles[role].model === "opus", `${role} did not expose the Opus review default`);
  assert(info.roles[role].effort === null, `${role} unexpectedly selected effort`);
  assert(info.roles[role].model_default_source === "plugin_role", `${role} did not report its model default source`);
  assert(info.roles[role].effort_default_source === "claude_code", `${role} did not preserve effort ownership`);
}
for (const role of ["explorer", "architect", "implementer"]) {
  assert(info.roles[role].model === null, `${role} did not defer model selection to Claude Code`);
  assert(info.roles[role].effort === null, `${role} did not defer effort selection to Claude Code`);
  assert(
    info.roles[role].model_effort_default_source === "claude_code",
    `${role} did not report Claude Code default ownership`,
  );
}
assert(
  info.policy.model_effort_default_source === "plugin_role_and_claude_code",
  "role model and Claude Code effort default ownership was not reported",
);

const tools = await client.listTools();
const toolNames = tools.tools.map((tool) => tool.name);
const startSchema = tools.tools.find((tool) => tool.name === "claude_interactive_start").inputSchema;
assert(
  JSON.stringify(startSchema.properties.permission_mode.enum) === JSON.stringify(["bypassPermissions"]),
  "start schema must expose only bypassPermissions",
);
for (const expected of [
  "claude_interactive_start",
  "claude_interactive_send",
  "claude_interactive_request",
  "claude_interactive_wait_request",
  "claude_interactive_wait",
  "claude_interactive_read",
  "claude_interactive_read_log",
  "claude_interactive_list",
  "claude_interactive_saved_sessions",
  "claude_interactive_stop",
  "codex_claude_subagent_info",
]) {
  assert(toolNames.includes(expected), `${expected} was not registered`);
}
for (const removed of [
  "claude_start_task",
  "claude_send",
  "claude_fork",
  "claude_resume_subagent",
  "claude_start_background",
  "claude_collect",
  "claude_status",
  "claude_list_background_agents",
]) {
  assert(!toolNames.includes(removed), `${removed} should not be registered`);
}

const teamAuthenticated = createTestClient(path.join(tmpRoot, "state-team-auth"), {
  FAKE_CLAUDE_AUTH_MODE: "team",
});
await teamAuthenticated.client.connect(teamAuthenticated.transport);
const teamInfo = parseToolResult(
  await teamAuthenticated.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(teamInfo.claude.auth.ready === true, "Claude.ai authentication was incorrectly restricted by plan name");
assert(teamInfo.claude.auth.subscription_type === "team", "Claude.ai plan metadata was not preserved");
assert(
  teamInfo.claude.auth.billing_mode === "claude_subscription",
  "Claude.ai auth did not retain subscription billing mode",
);
await teamAuthenticated.client.close();
activeClients.delete(teamAuthenticated.client);

const unknownPlanAuthenticated = createTestClient(path.join(tmpRoot, "state-unknown-plan-auth"), {
  FAKE_CLAUDE_AUTH_MODE: "unknown_plan",
});
await unknownPlanAuthenticated.client.connect(unknownPlanAuthenticated.transport);
const unknownPlanInfo = parseToolResult(
  await unknownPlanAuthenticated.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(unknownPlanInfo.claude.auth.ready === true, "Claude.ai authentication without a plan name was rejected");
assert(unknownPlanInfo.claude.auth.subscription_type === null, "missing plan metadata was not preserved as null");
await unknownPlanAuthenticated.client.close();
activeClients.delete(unknownPlanAuthenticated.client);

const mixedCaseCredential = createTestClient(path.join(tmpRoot, "state-mixed-case-env"), {
  anthropic_api_key: "must-also-be-scrubbed",
  claude_code_use_bedrock: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  Claude_Code_Use_Foundry: "1",
  CLAUDE_CODE_USE_MANTLE: "1",
});
await mixedCaseCredential.client.connect(mixedCaseCredential.transport);
const mixedCaseInfo = parseToolResult(
  await mixedCaseCredential.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(mixedCaseInfo.claude.auth.ready === true, "mixed-case API credential leaked into auth preflight");
await mixedCaseCredential.client.close();
activeClients.delete(mixedCaseCredential.client);

const secretMetadata = createTestClient(path.join(tmpRoot, "state-secret-auth-metadata"), {
  FAKE_CLAUDE_AUTH_MODE: "secret_metadata",
});
await secretMetadata.client.connect(secretMetadata.transport);
const secretMetadataInfo = parseToolResult(
  await secretMetadata.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(
  secretMetadataInfo.claude.auth.ready === true,
  "safe Claude.ai authentication was rejected with invalid optional metadata",
);
assert(secretMetadataInfo.claude.auth.api_provider === null, "untrusted auth metadata was returned to Codex");
assert(
  !JSON.stringify(secretMetadataInfo).includes("secret:do-not-return"),
  "secret-shaped auth metadata was returned to Codex",
);
await secretMetadata.client.close();
activeClients.delete(secretMetadata.client);

const failedStatus = createTestClient(path.join(tmpRoot, "state-failed-auth-status"), {
  FAKE_CLAUDE_AUTH_MODE: "status_nonzero",
});
await failedStatus.client.connect(failedStatus.transport);
const failedStatusInfo = parseToolResult(
  await failedStatus.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(failedStatusInfo.claude.auth.ready === false, "nonzero auth status was accepted from valid-looking JSON");
assert(failedStatusInfo.claude.auth.status_error === "exit_nonzero", "nonzero auth status was not classified safely");
assert(failedStatusInfo.claude.auth.auth_method === null, "failed auth status metadata was not discarded");
assert(
  !failedStatusInfo.claude.auth.remediation.commands.includes("claude auth login --claudeai"),
  "generic auth status failure incorrectly requested a new login",
);
assert(
  !JSON.stringify(failedStatusInfo).includes("secret-proxy-password-should-not-be-returned"),
  "raw auth stderr was returned to Codex",
);
let failedStatusStart;
try {
  failedStatusStart = await failedStatus.client.callTool({
    name: "claude_interactive_start",
    arguments: { cwd: plainProjectDir, role: "reviewer", mcp_preset: "none" },
  });
} catch (error) {
  failedStatusStart = { isError: true, content: [{ text: error.message }] };
}
assert(failedStatusStart?.isError === true, "nonzero auth status started an interactive session");
await failedStatus.client.close();
activeClients.delete(failedStatus.client);

const malformedDoctorCalledFile = path.join(tmpRoot, "malformed-doctor-called");
const malformedAuthStatus = createTestClient(path.join(tmpRoot, "state-malformed-auth-status"), {
  FAKE_CLAUDE_AUTH_MODE: "malformed",
  FAKE_CLAUDE_DOCTOR_CALLED_FILE: malformedDoctorCalledFile,
});
await malformedAuthStatus.client.connect(malformedAuthStatus.transport);
const malformedAuthInfo = parseToolResult(
  await malformedAuthStatus.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(malformedAuthInfo.claude.auth.ready === false, "malformed auth status was accepted");
assert(malformedAuthInfo.claude.auth.status_error === "invalid_json", "malformed auth status was misclassified");
assert(
  !malformedAuthInfo.claude.auth.remediation.commands.includes("claude auth login --claudeai"),
  "malformed auth status incorrectly requested a new login",
);
assert(!fs.existsSync(malformedDoctorCalledFile), "malformed auth status unnecessarily ran Claude doctor");
await malformedAuthStatus.client.close();
activeClients.delete(malformedAuthStatus.client);

const detectStartedFile = path.join(tmpRoot, "detect-started");
const timedOutDetection = createTestClient(path.join(tmpRoot, "state-timeout-detection"), {
  FAKE_CLAUDE_VERSION_TIMEOUT: "1",
  FAKE_CLAUDE_DETECT_STARTED_FILE: detectStartedFile,
  CODEX_CLAUDE_SUBAGENT_DETECT_TIMEOUT_MS: "1200",
});
await timedOutDetection.client.connect(timedOutDetection.transport);
const timedOutDetectionInfoPromise = timedOutDetection.client.callTool({
  name: "codex_claude_subagent_info",
  arguments: {},
});
await waitForFile(detectStartedFile);
const toolsDuringDetection = await Promise.race([
  timedOutDetection.client.listTools(),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Claude detection blocked concurrent MCP requests")), 750),
  ),
]);
assert(toolsDuringDetection.tools.length > 0, "concurrent tools/list returned no tools during Claude detection");
const timedOutDetectionInfo = parseToolResult(await timedOutDetectionInfoPromise);
assert(timedOutDetectionInfo.claude.available === false, "timed-out Claude detection was accepted");
assert(timedOutDetectionInfo.claude.error === "timeout", "timed-out Claude detection was misclassified");
const retriedDetectionInfo = parseToolResult(
  await timedOutDetection.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(retriedDetectionInfo.claude.available === true, "failed Claude detection remained cached");
assert(retriedDetectionInfo.claude.auth.ready === true, "retried Claude detection did not continue to auth preflight");
await timedOutDetection.client.close();
activeClients.delete(timedOutDetection.client);

const authStartedFile = path.join(tmpRoot, "auth-started");
const timeoutDoctorCalledFile = path.join(tmpRoot, "timeout-doctor-called");
const timedOutAuthStatus = createTestClient(path.join(tmpRoot, "state-timeout-auth-status"), {
  FAKE_CLAUDE_AUTH_MODE: "timeout",
  FAKE_CLAUDE_AUTH_STARTED_FILE: authStartedFile,
  FAKE_CLAUDE_DOCTOR_CALLED_FILE: timeoutDoctorCalledFile,
  CODEX_CLAUDE_SUBAGENT_AUTH_STATUS_TIMEOUT_MS: "1200",
});
await timedOutAuthStatus.client.connect(timedOutAuthStatus.transport);
const timedOutInfoPromise = timedOutAuthStatus.client.callTool({ name: "codex_claude_subagent_info", arguments: {} });
await waitForFile(authStartedFile);
const concurrentTools = await Promise.race([
  timedOutAuthStatus.client.listTools(),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("auth preflight blocked concurrent MCP requests")), 750),
  ),
]);
assert(concurrentTools.tools.length > 0, "concurrent tools/list returned no tools");
const timedOutAuthInfo = parseToolResult(await timedOutInfoPromise);
assert(timedOutAuthInfo.claude.auth.ready === false, "timed-out auth status was accepted");
assert(timedOutAuthInfo.claude.auth.status_error === "timeout", "timed-out auth status was misclassified");
assert(
  !timedOutAuthInfo.claude.auth.remediation.commands.includes("claude auth login --claudeai"),
  "timed-out auth status incorrectly requested a new login",
);
assert(!fs.existsSync(timeoutDoctorCalledFile), "timed-out auth status unnecessarily ran Claude doctor");
await timedOutAuthStatus.client.close();
activeClients.delete(timedOutAuthStatus.client);

const spawnFailureBin = path.join(tmpRoot, "spawn-failure-bin");
fs.mkdirSync(spawnFailureBin, { recursive: true });
const disappearingClaude = path.join(spawnFailureBin, "claude");
fs.copyFileSync(fakeClaude, disappearingClaude);
fs.chmodSync(disappearingClaude, 0o755);
const spawnFailedAuthStatus = createTestClient(path.join(tmpRoot, "state-spawn-failed-auth-status"), {
  PATH: `${spawnFailureBin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
});
await spawnFailedAuthStatus.client.connect(spawnFailedAuthStatus.transport);
const healthyAuthInfo = parseToolResult(
  await spawnFailedAuthStatus.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(healthyAuthInfo.claude.auth.ready === true, "baseline auth status was not ready before executable removal");
fs.unlinkSync(disappearingClaude);
const spawnFailedAuthInfo = parseToolResult(
  await spawnFailedAuthStatus.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(spawnFailedAuthInfo.claude.auth.ready === false, "spawn-failed auth status was accepted");
assert(spawnFailedAuthInfo.claude.auth.status_error === "spawn_failed", "spawn-failed auth status was misclassified");
assert(
  spawnFailedAuthInfo.claude.auth.remediation.commands[0] === "claude --version",
  "spawn failure omitted CLI check",
);
assert(
  !spawnFailedAuthInfo.claude.auth.remediation.commands.includes("claude auth login --claudeai"),
  "spawn-failed auth status incorrectly requested a new login",
);
await spawnFailedAuthStatus.client.close();
activeClients.delete(spawnFailedAuthStatus.client);

const unsupportedAuthStatus = createTestClient(path.join(tmpRoot, "state-unsupported-auth-status"), {
  FAKE_CLAUDE_AUTH_MODE: "unsupported",
});
await unsupportedAuthStatus.client.connect(unsupportedAuthStatus.transport);
const unsupportedAuthInfo = parseToolResult(
  await unsupportedAuthStatus.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(
  unsupportedAuthInfo.claude.auth.issue === "auth_status_unsupported",
  "unsupported auth command was not classified",
);
assert(
  unsupportedAuthInfo.claude.auth.remediation.commands[0] === "claude update",
  "old CLI remediation omitted update",
);
await unsupportedAuthStatus.client.close();
activeClients.delete(unsupportedAuthStatus.client);

const authCwdLog = path.join(tmpRoot, "auth-cwd.log");
const unauthenticatedStateDir = path.join(tmpRoot, "state-unauthenticated");
const unauthenticated = createTestClient(unauthenticatedStateDir, {
  FAKE_CLAUDE_AUTH_MODE: "not_logged_in",
  FAKE_CLAUDE_DOCTOR_MODE: "keychain_unwritable",
  FAKE_CLAUDE_AUTH_CWD_LOG: authCwdLog,
});
await unauthenticated.client.connect(unauthenticated.transport);
const unauthenticatedInfo = parseToolResult(
  await unauthenticated.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(unauthenticatedInfo.claude.auth.ready === false, "logged-out Claude was reported ready");
assert(unauthenticatedInfo.claude.auth.issue === "not_logged_in", "logged-out Claude issue was not classified");
assert(
  unauthenticatedInfo.claude.auth.diagnostics.keychain_unwritable === true,
  "Keychain write failure was not diagnosed",
);
assert(
  unauthenticatedInfo.claude.auth.remediation.commands[0].includes("security unlock-keychain"),
  "Keychain remediation did not include the unlock command",
);
let unauthenticatedStart;
try {
  unauthenticatedStart = await unauthenticated.client.callTool({
    name: "claude_interactive_start",
    arguments: { cwd: plainProjectDir, role: "reviewer", mcp_preset: "none" },
  });
} catch (error) {
  unauthenticatedStart = { isError: true, content: [{ text: error.message }] };
}
const unauthenticatedError = String(unauthenticatedStart.content?.[0]?.text || "");
assert(unauthenticatedStart?.isError === true, "logged-out Claude started an interactive session");
assert(unauthenticatedError.includes("authentication preflight failed"), "logged-out start did not fail at preflight");
assert(unauthenticatedError.includes("security unlock-keychain"), "logged-out start omitted Keychain remediation");
assert(unauthenticatedError.includes("Do not retry"), "logged-out start did not prevent futile retries");
const authCwds = fs.readFileSync(authCwdLog, "utf8").trim().split(/\r?\n/);
assert(authCwds.at(-1) === fs.realpathSync(plainProjectDir), "auth preflight did not use the target project cwd");
const unauthenticatedSessions = parseToolResult(
  await unauthenticated.client.callTool({
    name: "claude_interactive_saved_sessions",
    arguments: { cwd: plainProjectDir },
  }),
);
assert(unauthenticatedSessions.sessions.length === 0, "auth preflight failure persisted a phantom session");
await unauthenticated.client.close();
activeClients.delete(unauthenticated.client);

const apiAuthenticated = createTestClient(path.join(tmpRoot, "state-api-auth"), {
  FAKE_CLAUDE_AUTH_MODE: "api",
});
await apiAuthenticated.client.connect(apiAuthenticated.transport);
const apiInfo = parseToolResult(
  await apiAuthenticated.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(apiInfo.claude.auth.ready === false, "API-billed Claude auth was reported ready");
assert(apiInfo.claude.auth.issue === "non_subscription_auth", "API-billed auth issue was not classified");
let apiStart;
try {
  apiStart = await apiAuthenticated.client.callTool({
    name: "claude_interactive_start",
    arguments: { cwd: plainProjectDir, role: "reviewer", mcp_preset: "none" },
  });
} catch (error) {
  apiStart = { isError: true, content: [{ text: error.message }] };
}
assert(apiStart?.isError === true, "API-billed Claude auth started a subscription worker");
assert(
  String(apiStart.content?.[0]?.text || "").includes("does not fall back to API billing"),
  "API-billed auth rejection did not explain the billing boundary",
);
await apiAuthenticated.client.close();
activeClients.delete(apiAuthenticated.client);

// Preflight and the launched session must read the same settings sources.
const helperLog = path.join(tmpRoot, "helper-auth-args.jsonl");
const helperClient = createTestClient(path.join(tmpRoot, "state-helper"), {
  FAKE_CLAUDE_API_KEY_HELPER: "1",
  FAKE_CLAUDE_AUTH_ARGS_LOG: helperLog,
});
await helperClient.client.connect(helperClient.transport);
const helperRejected = await helperClient.client.callTool({
  name: "claude_interactive_start",
  arguments: { cwd: plainProjectDir, role: "reviewer", mcp_preset: "auto" },
});
assert(helperRejected.isError, "apiKeyHelper was not rejected with active project/user settings");
const helperNone = parseToolResult(
  await helperClient.client.callTool({
    name: "claude_interactive_start",
    arguments: { cwd: plainProjectDir, role: "reviewer", mcp_preset: "none" },
  }),
);
const helperArgs = fs
  .readFileSync(helperLog, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert(
  helperArgs.some((args) => args[args.indexOf("--setting-sources") + 1] === "user,project,local"),
  "normal preflight ignored settings",
);
assert(
  helperArgs.at(-1)[helperArgs.at(-1).indexOf("--setting-sources") + 1] === "",
  "isolated preflight loaded user settings",
);
await helperClient.client.callTool({
  name: "claude_interactive_stop",
  arguments: { cwd: plainProjectDir, interactive_id: helperNone.interactive_id },
});
await helperClient.client.close();
activeClients.delete(helperClient.client);

const effortClient = createTestClient(path.join(tmpRoot, "state-effort"), { CLAUDE_CODE_EFFORT_LEVEL: "high" });
await effortClient.client.connect(effortClient.transport);
const effortConflict = await effortClient.client.callTool({
  name: "claude_interactive_start",
  arguments: { cwd: plainProjectDir, role: "reviewer", effort: "low", mcp_preset: "none" },
});
assert(
  effortConflict.isError && effortConflict.content[0].text.includes("CLAUDE_CODE_EFFORT_LEVEL"),
  "effort conflict was silently overridden",
);
await effortClient.client.close();
activeClients.delete(effortClient.client);

const delegated = parseToolResult(
  await client.callTool({
    name: "claude_interactive_start",
    arguments: { cwd: plainProjectDir, role: "implementer", subagent_mode: "auto", mcp_preset: "none" },
  }),
);
assert(
  delegated.resolved.tools.includes("Agent") && !delegated.resolved.disallowed_tools.includes("Agent"),
  "explicit native delegation was not enabled",
);
await client.callTool({
  name: "claude_interactive_stop",
  arguments: { cwd: plainProjectDir, interactive_id: delegated.interactive_id },
});
for (const args of [
  { role: "reviewer", subagent_mode: "auto" },
  { role: "implementer", subagent_mode: "auto", tools: ["Read"] },
  { role: "implementer", subagent_mode: "auto", disallowed_tools: ["Agent"] },
  { role: "implementer", subagent_mode: "auto", tools: ["Agent", "SendMessage"] },
]) {
  const rejected = await client.callTool({
    name: "claude_interactive_start",
    arguments: { cwd: plainProjectDir, ...args },
  });
  assert(rejected.isError, "conflicting delegation configuration was silently expanded");
}

for (const mode of [
  "trust",
  "bypass",
  "missing-observer",
  "selector",
  "delayed-native",
  "background",
  "unknown-count",
  "empty-answer",
  "unknown-reason",
  "blocked",
  "cron",
  "tokenless",
  "aborted",
  "error",
  "refusal",
  "prevent",
]) {
  const inputFile = path.join(tmpRoot, `unexpected-input-${mode}`);
  const isolated = createTestClient(path.join(tmpRoot, `state-lifecycle-${mode}`), {
    ...(mode === "trust" || mode === "bypass"
      ? { FAKE_CLAUDE_STARTUP_DIALOG: mode, FAKE_CLAUDE_UNEXPECTED_INPUT: inputFile }
      : {}),
    ...(mode === "missing-observer" ? { FAKE_CLAUDE_SKIP_OBSERVER: "1" } : {}),
    ...(mode === "selector" ? { FAKE_CLAUDE_STARTUP_SELECTOR: "1" } : {}),
    ...(mode === "delayed-native" ? { FAKE_CLAUDE_NATIVE_DELAY_MS: "800" } : {}),
    ...(mode === "background" ? { FAKE_CLAUDE_BACKGROUND_PENDING: "1" } : {}),
    ...(mode === "unknown-count" ? { FAKE_CLAUDE_BACKGROUND_PENDING: "unknown" } : {}),
    ...(mode === "empty-answer" ? { FAKE_CLAUDE_NATIVE_EMPTY: "1" } : {}),
    ...(mode === "unknown-reason" ? { FAKE_CLAUDE_NATIVE_REASON: "unrecognized" } : {}),
    ...(mode === "blocked" ? { FAKE_CLAUDE_STOP_BLOCKED: "1" } : {}),
    ...(mode === "tokenless" ? { FAKE_CLAUDE_TOKENLESS_WAKE: "1" } : {}),
    ...(["aborted", "error", "refusal"].includes(mode) ? { FAKE_CLAUDE_NATIVE_REASON: mode } : {}),
    ...(mode === "prevent" ? { FAKE_CLAUDE_PREVENT: "1" } : {}),
    ...(mode === "cron" ? { FAKE_CLAUDE_CRON_PENDING: "1" } : {}),
  });
  await isolated.client.connect(isolated.transport);
  const started = parseToolResult(
    await isolated.client.callTool({
      name: "claude_interactive_start",
      arguments: { cwd: plainProjectDir, role: "reviewer", mcp_preset: "none" },
    }),
  );
  const result = await isolated.client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: started.interactive_id,
      text: "review this",
      idle_ms: null,
      timeout_ms: mode === "delayed-native" ? 200 : 2000,
    },
  });
  if (["trust", "bypass", "missing-observer"].includes(mode)) {
    assert(result.isError, `${mode} startup was treated as ready`);
    assert(!fs.existsSync(inputFile), `${mode} startup received request or consent bytes`);
  } else {
    const response = parseToolResult(result);
    if (mode === "delayed-native") {
      assert(!response.request.done, "Stop or completion marker completed before native event");
      const final = parseToolResult(
        await isolated.client.callTool({
          name: "claude_interactive_wait_request",
          arguments: {
            cwd: plainProjectDir,
            interactive_id: started.interactive_id,
            request_id: response.request.request_id,
            idle_ms: null,
            timeout_ms: 2000,
          },
        }),
      );
      assert(final.request.done, "delayed native completion was not resumable");
    } else if (mode === "background") {
      assert(
        response.request.done && response.request.work_pending && response.request.completion_scope === "main_turn",
        "background work incorrectly blocked main-turn completion",
      );
      const next = await isolated.client.callTool({
        name: "claude_interactive_send",
        arguments: {
          cwd: plainProjectDir,
          interactive_id: started.interactive_id,
          text: "next harmless input",
          submit: false,
        },
      });
      assert(!next.isError, "background count left an input lock after main completion");
    } else if (mode === "empty-answer") {
      assert(response.request.done && response.request.status === "completed", "empty answer changed completion");
      assert(
        response.request.result_text === null && response.latest_native_outcome.answer === null,
        "no captured text was not null",
      );
      assert(
        response.latest_native_outcome.answer_truncated === false && response.request.result_text_truncated === false,
        "empty answer was reported truncated",
      );
      const emptyView = parseToolResult(
        await isolated.client.callTool({
          name: "claude_interactive_read",
          arguments: { cwd: plainProjectDir, interactive_id: started.interactive_id },
        }),
      );
      assert(
        emptyView.last_request.result_text === null && emptyView.latest_native_outcome.answer === null,
        "read changed null answer semantics",
      );
    } else if (mode === "unknown-reason") {
      assert(
        !response.request.done &&
          response.request.pending &&
          response.request.attention_required?.reason === "completion_unconfirmed",
        "unknown reason claimed completion",
      );
      assert(
        response.request.result_text === null && response.request.provisional_result_text === "review complete",
        "unknown reason lost provisional answer",
      );
    } else if (mode === "unknown-count") {
      assert(
        response.request.done && response.request.count_unknown && !response.request.work_pending,
        "unknown count blocked completion or claimed known work",
      );
    } else if (mode === "blocked") {
      assert(
        response.request.done && response.request.stop_block_overridden,
        "final overridden Stop block held the input lock",
      );
    } else if (["aborted", "prevent", "error", "refusal"].includes(mode)) {
      assert(!response.request.done && !response.request.pending, `${mode} was not terminal`);
      assert(
        response.request.status === (["aborted", "prevent"].includes(mode) ? "interrupted" : "failed"),
        `${mode} terminal mapping incorrect`,
      );
    } else if (mode === "tokenless") {
      let view;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        view = parseToolResult(
          await isolated.client.callTool({
            name: "claude_interactive_read",
            arguments: { cwd: plainProjectDir, interactive_id: started.interactive_id, max_chars: 100 },
          }),
        );
        if (view.native_active_turn_id) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(view.native_active_turn_id, "tokenless turn was not tracked");
      for (const name of ["claude_interactive_send", "claude_interactive_request"]) {
        const rejected = await isolated.client.callTool({
          name,
          arguments: { cwd: plainProjectDir, interactive_id: started.interactive_id, text: "must not send" },
        });
        assert(rejected.isError, "input was accepted during tokenless main turn");
      }
      for (let attempt = 0; attempt < 50; attempt += 1) {
        view = parseToolResult(
          await isolated.client.callTool({
            name: "claude_interactive_read",
            arguments: { cwd: plainProjectDir, interactive_id: started.interactive_id, max_chars: 100 },
          }),
        );
        if (!view.native_active_turn_id) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(
        !view.native_active_turn_id && view.latest_native_outcome?.answer === "BACKGROUND_FINISHED",
        "tokenless outcome did not clear active turn",
      );
      assert(
        view.last_request.request_id === response.request.request_id &&
          view.last_request.result_text === "review complete",
        "tokenless completion changed correlated request",
      );
      const unlocked = await isolated.client.callTool({
        name: "claude_interactive_send",
        arguments: {
          cwd: plainProjectDir,
          interactive_id: started.interactive_id,
          text: "safe followup",
          submit: false,
        },
      });
      assert(!unlocked.isError, "tokenless completion left input locked");
    } else {
      assert(
        response.request.done && response.request.completion_transport === "claude_code_mod",
        `${mode} native completion failed`,
      );
    }
  }
  await isolated.client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: plainProjectDir, interactive_id: started.interactive_id },
  });
  await isolated.client.close();
  activeClients.delete(isolated.client);
}

// This receiver records raw-mode PTY input; it does not model live Claude's
// paste handling or establish what a live model receives.
{
  const integrityState = path.join(tmpRoot, "state-context-integrity");
  const inputLog = path.join(tmpRoot, "exact-body-input.log");
  const isolated = createTestClient(integrityState, {
    FAKE_CLAUDE_INPUT_LOG: inputLog,
    FAKE_CLAUDE_EXACT_BODY: "1",
  });
  await isolated.client.connect(isolated.transport);
  const call = async (name, args = {}) =>
    parseToolResult(
      await isolated.client.callTool({
        name,
        arguments: { cwd: plainProjectDir, ...args },
      }),
    );
  const started = await call("claude_interactive_start", { role: "reviewer", mcp_preset: "none" });
  const sessionArgs = { interactive_id: started.interactive_id };
  const callerText =
    "  User 1:\n日本語の原文🙂 e\u0301\u3000\u00a0\t  \n\n" +
    "first section  ".repeat(180) +
    "\n\nAssistant proposal (not adopted):\n案を仮置きします。\n\n" +
    "User 2 (correction):\n中央の訂正: その案は採用していません。\t  \n\n" +
    "last section  ".repeat(180) +
    "\nUser 3:\n引用の順序と空白を保つ。  \n\t  ";
  const response = await call("claude_interactive_request", {
    ...sessionArgs,
    text: callerText,
    idle_ms: null,
    timeout_ms: 3000,
  });
  const bytes = fs.readFileSync(inputLog);
  const pasteStart = bytes.lastIndexOf(Buffer.from("\x1b[200~"));
  const pasteEnd = bytes.indexOf(Buffer.from("\x1b[201~"), pasteStart);
  assert(pasteStart >= 0 && pasteEnd > pasteStart, "receiver did not capture a bracketed paste");
  const frameBytes = bytes.subarray(pasteStart + Buffer.byteLength("\x1b[200~"), pasteEnd);
  const frame = frameBytes.toString("utf8");
  const label = "Request from the calling Codex agent:\n";
  const labelAt = frame.indexOf(label);
  const bodyAt = labelAt + label.length;
  const protocolAt = frame.lastIndexOf("\n\nCompletion protocol:\n");
  assert(
    frame.startsWith(`Codex–Claude Subagent correlation token: ${response.request.hook_correlation_token}\n\n`),
    "correlation token was not first",
  );
  assert(
    frame.indexOf("Review-only boundary:") >= 0 && frame.indexOf("Review-only boundary:") < labelAt,
    "role boundary did not precede caller label",
  );
  assert(labelAt >= 0 && protocolAt > bodyAt, "caller framing was missing");
  assert(frame.slice(bodyAt, protocolAt) === callerText, "caller body changed, including its middle or whitespace");
  assert(
    frameBytes
      .subarray(Buffer.byteLength(frame.slice(0, bodyAt)), Buffer.byteLength(frame.slice(0, protocolAt)))
      .equals(Buffer.from(callerText, "utf8")),
    "PTY receiver body was not byte-identical UTF-8",
  );

  const sentinel = "ORDINARY_CONTEXT_INTEGRITY_SENTINEL_🙂";
  const assertTextPaths = (view, withRequest, surface) => {
    const paths = [];
    const walk = (value, at = "") => {
      if (typeof value === "string") {
        if (value.includes(sentinel)) paths.push(at);
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (!["output_tail", "chunks"].includes(key)) walk(child, at ? `${at}.${key}` : key);
        }
      }
    };
    walk(view);
    const expected = [
      "last_request.result_text",
      "latest_native_outcome.answer",
      ...(withRequest ? ["request.result_text"] : []),
    ];
    assert(
      JSON.stringify(paths.sort()) === JSON.stringify(expected.sort()),
      `${surface}: unexpected sentinel paths ${JSON.stringify(paths)}`,
    );
    assert(
      view.last_request.result_text === sentinel && (!withRequest || view.request.result_text === sentinel),
      `${surface}: canonical result_text changed`,
    );
    assert(view.latest_native_outcome.answer_truncated === false, `${surface}: native truncation flag missing`);
  };
  assertTextPaths(response, true, "request");
  assertTextPaths(
    await call("claude_interactive_wait_request", {
      ...sessionArgs,
      request_id: response.request.request_id,
      timeout_ms: 100,
    }),
    true,
    "wait_request",
  );
  assertTextPaths(await call("claude_interactive_read", sessionArgs), false, "live read");
  const sessionFrom = (result) => result.sessions.find((session) => session.interactive_id === started.interactive_id);
  assertTextPaths(sessionFrom(await call("claude_interactive_list")), false, "live list");

  const registryFile = path.join(integrityState, "interactive-sessions.json");
  const storedSession = () =>
    JSON.parse(fs.readFileSync(registryFile, "utf8")).sessions.find(
      (session) => session.interactive_id === started.interactive_id,
    );
  await waitForCondition(() => storedSession()?.last_request?.result_text === sentinel, 3000);
  const reader = createTestClient(integrityState);
  await reader.client.connect(reader.transport);
  const readCall = async (name, args = {}) =>
    parseToolResult(await reader.client.callTool({ name, arguments: { cwd: plainProjectDir, ...args } }));
  const persisted = await readCall("claude_interactive_read", sessionArgs);
  assert(
    persisted.control_available === false && persisted.read_only_snapshot,
    "second process did not use persisted reader",
  );
  assertTextPaths(persisted, false, "persisted read");
  assertTextPaths(sessionFrom(await readCall("claude_interactive_list")), false, "persisted list");
  assertTextPaths(
    sessionFrom(await readCall("claude_interactive_saved_sessions")),
    false,
    "second process saved_sessions",
  );
  assertTextPaths(sessionFrom(await call("claude_interactive_saved_sessions")), false, "owner saved_sessions");
  assert(
    storedSession().last_request.completion_event.last_assistant_message === sentinel,
    "public projection stripped canonical registry event body",
  );
  assert(
    storedSession().last_request.last_wait.matched_hook.answer === sentinel,
    "public projection stripped canonical wait body",
  );

  // A manual-send failure has no new correlated request. Its unique diagnostic
  // must survive without overwriting the earlier request, even after reading.
  await call("claude_interactive_send", { ...sessionArgs, text: "hook failure request" });
  let manualFailure;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    manualFailure = await call("claude_interactive_read", sessionArgs);
    if (manualFailure.last_hook_event?.hook_event_name === "StopFailure") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const assertManualFailure = (view, surface) => {
    assert(
      view.last_hook_event?.hook_event_name === "StopFailure" &&
        view.last_hook_event.error === "rate_limit" &&
        view.last_hook_event.last_assistant_message === "rate limited",
      `${surface}: unique manual-send failure disappeared`,
    );
    for (const field of ["result_text", "status", "done", "terminal_state"]) {
      assert(
        view.last_request[field] === response.request[field],
        `${surface}: manual failure changed previous ${field}`,
      );
    }
  };
  assertManualFailure(manualFailure, "live manual failure");
  assertManualFailure(sessionFrom(await call("claude_interactive_list")), "list manual failure");
  // Manual hooks alone do not promise an immediate registry flush. Stopping
  // this throwaway session persists the canonical snapshot without a new turn.
  await call("claude_interactive_stop", sessionArgs);
  await waitForCondition(() => storedSession()?.status === "exited", 3000);
  assertManualFailure(await readCall("claude_interactive_read", sessionArgs), "persisted manual failure");
  assertManualFailure(sessionFrom(await readCall("claude_interactive_saved_sessions")), "saved manual failure");
  await isolated.client.close();
  activeClients.delete(isolated.client);
  // Simulate an older canonical registry without the additive native flag.
  const legacyRegistry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const legacySession = sessionFrom(legacyRegistry);
  delete legacySession.latest_native_outcome.answer_truncated;
  fs.writeFileSync(registryFile, JSON.stringify(legacyRegistry));
  for (const name of ["claude_interactive_read", "claude_interactive_list", "claude_interactive_saved_sessions"]) {
    const result = await readCall(name, name === "claude_interactive_read" ? sessionArgs : {});
    const view = result.sessions ? sessionFrom(result) : result;
    assert(!Object.hasOwn(view.latest_native_outcome, "answer_truncated"), `${name}: legacy unknown flag became false`);
    assert(view.last_request.result_text === sentinel, `${name}: legacy reader lost result_text`);
  }
  await reader.client.close();
  activeClients.delete(reader.client);
}

let unsafeToolResult;
{
  const inputLog = path.join(tmpRoot, "retry-guard-input.log");
  const metadata = path.join(tmpRoot, "retry-guard-observer.json");
  const guarded = createTestClient(path.join(tmpRoot, "state-retry-guard"), {
    FAKE_CLAUDE_INPUT_LOG: inputLog,
    FAKE_CLAUDE_OBSERVER_META: metadata,
  });
  await guarded.client.connect(guarded.transport);
  const started = parseToolResult(
    await guarded.client.callTool({
      name: "claude_interactive_start",
      arguments: { cwd: plainProjectDir, role: "reviewer", mcp_preset: "none" },
    }),
  );
  const waiting = parseToolResult(
    await guarded.client.callTool({
      name: "claude_interactive_request",
      arguments: {
        cwd: plainProjectDir,
        interactive_id: started.interactive_id,
        text: "retry submit request",
        idle_ms: null,
        timeout_ms: 100,
      },
    }),
  );
  assert(waiting.request.pending && !waiting.request.submitted_at, "retry guard fixture was already submitted");
  const before = fs.readFileSync(inputLog, "utf8");
  const meta = JSON.parse(fs.readFileSync(metadata, "utf8"));
  const event = (seq, kind, extra = {}) =>
    fs.writeFileSync(
      path.join(meta.directory, `event-${String(seq).padStart(8, "0")}.json`),
      JSON.stringify({
        schema: 1,
        seq,
        generation: meta.generation,
        session_id: meta.session_id,
        kind,
        turn_id: "tokenless-guard-turn",
        request_token: null,
        at: new Date().toISOString(),
        ...extra,
      }),
    );
  event(2, "turn.start");
  const retry = () =>
    guarded.client.callTool({
      name: "claude_interactive_wait_request",
      arguments: {
        cwd: plainProjectDir,
        interactive_id: started.interactive_id,
        request_id: waiting.request.request_id,
        retry_submit: true,
        idle_ms: null,
        timeout_ms: 50,
      },
    });
  assert((await retry()).isError, "retry_submit accepted an active tokenless turn");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(fs.readFileSync(inputLog, "utf8") === before, "retry_submit wrote Enter during active native turn");
  event(3, "turn.complete", {
    reason: "answer",
    is_aborted: false,
    answer: "background complete",
    stop: { background_tasks_pending: 0 },
  });
  fs.writeFileSync(path.join(meta.directory, "event-00000004.json"), '{"schema":1');
  assert((await retry()).isError, "retry_submit accepted incomplete observer state");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(fs.readFileSync(inputLog, "utf8") === before, "retry_submit wrote Enter with a partial observer record");
  const stopped = parseToolResult(
    await guarded.client.callTool({
      name: "claude_interactive_stop",
      arguments: { cwd: plainProjectDir, interactive_id: started.interactive_id },
    }),
  );
  assert(!stopped.native_active_turn_id, "process exit left a native turn active");
  await guarded.client.close();
  activeClients.delete(guarded.client);
}
try {
  unsafeToolResult = await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: projectDir,
      role: "reviewer",
      tools: ["Read", "Edit"],
    },
  });
} catch (error) {
  unsafeToolResult = { isError: true, content: [{ text: error.message }] };
}
assert(unsafeToolResult?.isError === true, "reviewer role accepted a mutating tool override");
assert(
  String(unsafeToolResult.content?.[0]?.text || "").includes("Edit"),
  "mutating tool rejection did not explain the constraint",
);

for (const [field, value] of [
  ["tools", ["default"]],
  ["allowed_tools", ["Bash(git diff)"]],
  ["allowed_tools", ["mcp__serena__write_file"]],
]) {
  let unsafeReadOnlyOverride;
  try {
    unsafeReadOnlyOverride = await client.callTool({
      name: "claude_interactive_start",
      arguments: {
        cwd: projectDir,
        role: "reviewer",
        [field]: value,
      },
    });
  } catch (error) {
    unsafeReadOnlyOverride = { isError: true, content: [{ text: error.message }] };
  }
  assert(unsafeReadOnlyOverride?.isError === true, `reviewer accepted unsafe ${field} override`);
}

let nestedAgentResult;
try {
  nestedAgentResult = await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: projectDir,
      role: "reviewer",
      tools: ["Task"],
    },
  });
} catch (error) {
  nestedAgentResult = { isError: true, content: [{ text: error.message }] };
}
assert(nestedAgentResult?.isError === true, "nested agent tool override was accepted");
assert(
  String(nestedAgentResult.content?.[0]?.text || "").includes("leaf subagent"),
  "nested agent rejection did not explain the leaf-subagent boundary",
);

for (const claudeArgs of [["--print"], ["--debug-file", "/tmp/claude-debug.log"]]) {
  let forbiddenClaudeArgResult;
  try {
    forbiddenClaudeArgResult = await client.callTool({
      name: "claude_interactive_start",
      arguments: {
        cwd: projectDir,
        role: "reviewer",
        claude_args: claudeArgs,
      },
    });
  } catch (error) {
    forbiddenClaudeArgResult = { isError: true, content: [{ text: error.message }] };
  }
  assert(forbiddenClaudeArgResult?.isError === true, `unsafe Claude argument was accepted: ${claudeArgs[0]}`);
}

let controlledClaudeArgResult;
try {
  controlledClaudeArgResult = await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: projectDir,
      role: "reviewer",
      claude_args: ["--model", "opus"],
    },
  });
} catch (error) {
  controlledClaudeArgResult = { isError: true, content: [{ text: error.message }] };
}
assert(controlledClaudeArgResult?.isError === true, "structured Claude argument was accepted as a raw argument");
assert(
  String(controlledClaudeArgResult.content?.[0]?.text || "").includes("structured"),
  "structured Claude argument rejection did not explain the contract",
);

const forwardedClaudeArgStart = parseToolResult(
  await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: projectDir,
      role: "reviewer",
      claude_args: ["--verbose"],
      mcp_preset: "none",
    },
  }),
);
assert(
  JSON.stringify(forwardedClaudeArgStart.resolved.claude_args) === JSON.stringify(["--verbose"]),
  "interactive Claude argument was not reported",
);
assert(forwardedClaudeArgStart.args_preview.includes("--verbose"), "interactive Claude argument was not forwarded");
const forwardedClaudeArgStop = parseToolResult(
  await client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: projectDir, interactive_id: forwardedClaudeArgStart.interactive_id },
  }),
);
assert(forwardedClaudeArgStop.stop.exited === true, "forwarded-argument session did not exit after stop");

const implementerStart = parseToolResult(
  await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: projectDir,
      role: "implementer",
      name: "implementer contract check",
      mcp_preset: "none",
    },
  }),
);
assert(implementerStart.status === "running", "implementer interactive session did not start");
assert(implementerStart.resolved.role === "implementer", "implementer role was not resolved");
assert(implementerStart.resolved.mode === "implementation", "implementer mode was not resolved");
assert(implementerStart.resolved.mutates_files === true, "implementer mutability was not resolved");
assert(implementerStart.resolved.requires_worktree === false, "implementer worktree requirement was not disabled");
assert(!Object.hasOwn(implementerStart.resolved, "claude_worktree"), "legacy worktree field was still resolved");
assert(
  ["Bash", "Read", "Grep", "Glob", "Edit", "Write"].every((tool) => implementerStart.resolved.tools.includes(tool)),
  "implementer did not expose implementation tools",
);
assert(
  ["Bash", "Read", "Grep", "Glob", "Edit", "Write"].every((tool) =>
    implementerStart.resolved.allowed_tools.includes(tool),
  ),
  "implementer did not allow implementation tools",
);
assert(implementerStart.resolved.permission_mode === "bypassPermissions", "implementer did not bypass permissions");
assert(
  implementerStart.args_preview[implementerStart.args_preview.indexOf("--permission-mode") + 1] === "bypassPermissions",
  "implementer did not pass bypassPermissions to Claude Code",
);
assert(!implementerStart.args_preview.includes("--worktree"), "implementer unexpectedly passed a worktree");
const implementerInstructionArg = implementerStart.args_preview.indexOf("--append-system-prompt-file");
assert(implementerInstructionArg >= 0, "implementer instruction was not supplied");
const implementerInstruction = fs.readFileSync(implementerStart.args_preview[implementerInstructionArg + 1], "utf8");
assert(
  implementerInstruction.includes("Implementation boundary:") &&
    implementerInstruction.includes("directly in the provided project directory") &&
    !implementerInstruction.includes("Do not commit, push, or publish changes."),
  "implementer direct-project boundary was not appended",
);
const implementerStop = parseToolResult(
  await client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: projectDir, interactive_id: implementerStart.interactive_id },
  }),
);
assert(implementerStop.stop.exited === true, "implementer session did not exit after stop");

const noWorktreeCapability = createTestClient(path.join(tmpRoot, "state-no-worktree"), {
  FAKE_CLAUDE_DISABLE_WORKTREE: "1",
});
await noWorktreeCapability.client.connect(noWorktreeCapability.transport);
const noWorktreeInfo = parseToolResult(
  await noWorktreeCapability.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(noWorktreeInfo.claude.capabilities.worktree === false, "worktree-disabled Claude was not detected");
const noWorktreeImplementerStart = parseToolResult(
  await noWorktreeCapability.client.callTool({
    name: "claude_interactive_start",
    arguments: { cwd: projectDir, role: "implementer", mcp_preset: "none" },
  }),
);
assert(noWorktreeImplementerStart.status === "running", "implementer required an unused worktree capability");
assert(
  !noWorktreeImplementerStart.args_preview.includes("--worktree"),
  "implementer passed a worktree despite direct project behavior",
);
const noWorktreeImplementerStop = parseToolResult(
  await noWorktreeCapability.client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: projectDir, interactive_id: noWorktreeImplementerStart.interactive_id },
  }),
);
assert(noWorktreeImplementerStop.stop.exited === true, "direct-project implementer session did not exit after stop");
await noWorktreeCapability.client.close();
activeClients.delete(noWorktreeCapability.client);

const autoMcpStart = parseToolResult(
  await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: projectDir,
      role: "reviewer",
      name: "auto mcp check",
    },
  }),
);
assert(autoMcpStart.status === "running", "auto MCP interactive session did not start");
assert(autoMcpStart.resolved.mcp_preset === "auto", "reviewer did not default to auto MCP preset");
assert(
  autoMcpStart.resolved.mcp_config.mode === "project_default",
  "auto MCP did not use Claude Code project discovery",
);
assert(autoMcpStart.resolved.mcp_config.path === null, "auto MCP unexpectedly injected a private config");
assert(!autoMcpStart.args_preview.includes("--strict-mcp-config"), "auto MCP unexpectedly enabled strict MCP mode");
const autoSettingSourcesArg = autoMcpStart.args_preview.indexOf("--setting-sources");
assert(
  autoSettingSourcesArg >= 0 && autoMcpStart.args_preview[autoSettingSourcesArg + 1] === "user,project,local",
  "auto MCP did not enable normal Claude settings",
);
assert(
  ["Bash", "Read", "Grep", "Glob"].every((tool) => autoMcpStart.resolved.tools.includes(tool)),
  "reviewer did not expose ordinary review built-in tools",
);
assert(
  ["Bash", "Read", "Grep", "Glob"].every((tool) => autoMcpStart.resolved.allowed_tools.includes(tool)),
  "reviewer did not allow ordinary review built-in tools",
);
assert(
  ["Agent", "Task"].every((tool) => autoMcpStart.resolved.disallowed_tools.includes(tool)),
  "default single-agent mode did not deny delegation",
);
assert(autoMcpStart.resolved.permission_mode === "bypassPermissions", "review role did not bypass permissions");
assert(
  autoMcpStart.args_preview[autoMcpStart.args_preview.indexOf("--permission-mode") + 1] === "bypassPermissions",
  "reviewer did not pass bypassPermissions to Claude Code",
);
const autoStop = parseToolResult(
  await client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: projectDir, interactive_id: autoMcpStart.interactive_id },
  }),
);
assert(autoStop.stop.exited === true, "auto MCP session did not exit after stop");

const autoWithoutMcpCapability = createTestClient(path.join(tmpRoot, "state-auto-without-mcp-capability"), {
  FAKE_CLAUDE_DISABLE_MCP_CONFIG: "1",
});
await autoWithoutMcpCapability.client.connect(autoWithoutMcpCapability.transport);
const autoWithoutMcpInfo = parseToolResult(
  await autoWithoutMcpCapability.client.callTool({ name: "codex_claude_subagent_info", arguments: {} }),
);
assert(
  autoWithoutMcpInfo.claude.capabilities.mcp_config === false,
  "MCP capability-disabled fake Claude was not detected",
);
assert(
  autoWithoutMcpInfo.claude.capabilities.strict_mcp_config === false,
  "strict MCP capability-disabled fake Claude was not detected",
);
const autoWithoutMcpStart = parseToolResult(
  await autoWithoutMcpCapability.client.callTool({
    name: "claude_interactive_start",
    arguments: { cwd: projectDir, role: "reviewer" },
  }),
);
assert(autoWithoutMcpStart.status === "running", "normal project MCP start required strict MCP capabilities");
assert(
  autoWithoutMcpStart.resolved.mcp_config.mode === "project_default",
  "capability-free auto MCP did not use project discovery",
);
assert(!autoWithoutMcpStart.args_preview.includes("--mcp-config"), "capability-free auto MCP injected a config");
const autoWithoutMcpStop = parseToolResult(
  await autoWithoutMcpCapability.client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: projectDir, interactive_id: autoWithoutMcpStart.interactive_id },
  }),
);
assert(autoWithoutMcpStop.stop.exited === true, "capability-free auto MCP session did not exit after stop");
await autoWithoutMcpCapability.client.close();
activeClients.delete(autoWithoutMcpCapability.client);

const complexStart = parseToolResult(
  await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: plainProjectDir,
      role: "architect",
      name: "complex model check",
      permission_mode: "bypassPermissions",
      mcp_preset: "none",
    },
  }),
);
assert(complexStart.resolved.model === null, "complex role did not defer model selection to Claude Code");
assert(complexStart.resolved.effort === null, "complex role did not defer effort selection to Claude Code");
assert(complexStart.resolved.fallback === null, "complex role unexpectedly exposed a plugin fallback");
assert(!complexStart.args_preview.includes("--model"), "complex role unexpectedly passed a model to Claude");
assert(!complexStart.args_preview.includes("--effort"), "complex role unexpectedly passed an effort to Claude");
const complexStop = parseToolResult(
  await client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: plainProjectDir, interactive_id: complexStart.interactive_id },
  }),
);
assert(complexStop.stop.exited === true, "complex model session did not exit after stop");

const explicitLegacyModelStart = parseToolResult(
  await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: plainProjectDir,
      role: "architect",
      model: "custom-model-id",
      effort: "fast",
      name: "explicit model and effort check",
      mcp_preset: "none",
    },
  }),
);
assert(explicitLegacyModelStart.resolved.model === "custom-model-id", "explicit model override was not preserved");
assert(
  explicitLegacyModelStart.resolved.fallback === null,
  "explicit model override should disable automatic fallback metadata",
);
assert(explicitLegacyModelStart.resolved.effort === "fast", "forwarded effort override was not preserved");
assert(
  explicitLegacyModelStart.args_preview.includes("--model") &&
    explicitLegacyModelStart.args_preview.includes("custom-model-id"),
  "explicit model override was not passed to Claude",
);
const explicitLegacyModelStop = parseToolResult(
  await client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: plainProjectDir, interactive_id: explicitLegacyModelStart.interactive_id },
  }),
);
assert(explicitLegacyModelStop.stop.exited === true, "explicit legacy model session did not exit after stop");

const namedReviewSessions = [];
for (const model of ["fable", "opus"]) {
  const started = parseToolResult(
    await client.callTool({
      name: "claude_interactive_start",
      arguments: { cwd: plainProjectDir, role: "reviewer", model, mcp_preset: "none" },
    }),
  );
  namedReviewSessions.push(started);
  assert(started.status === "running", `${model} reviewer did not start`);
  assert(started.resolved.model === model, `${model} reviewer model was not preserved`);
  assert(
    started.args_preview[started.args_preview.indexOf("--model") + 1] === model,
    `${model} reviewer model was not passed as a structured CLI option`,
  );
  assert(started.resolved.effort === null, `${model} reviewer unexpectedly selected effort`);
  assert(!started.args_preview.includes("--effort"), `${model} reviewer unexpectedly passed effort`);
  assert(started.resolved.subagent_mode === "disabled", `${model} reviewer enabled nested delegation`);
}
assert(
  namedReviewSessions[0].interactive_id !== namedReviewSessions[1].interactive_id &&
    namedReviewSessions[0].claude_session_id !== namedReviewSessions[1].claude_session_id,
  "Fable and Opus reviews unexpectedly shared a conversation",
);
for (const started of namedReviewSessions) {
  const stopped = parseToolResult(
    await client.callTool({
      name: "claude_interactive_stop",
      arguments: { cwd: plainProjectDir, interactive_id: started.interactive_id },
    }),
  );
  assert(stopped.stop.exited === true, "named reviewer session did not exit after stop");
}
const resumedFableReview = parseToolResult(
  await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: plainProjectDir,
      role: "reviewer",
      resume_claude_session_id: namedReviewSessions[0].claude_session_id,
      mcp_preset: "none",
    },
  }),
);
assert(resumedFableReview.resolved.resume_mode === "resume", "Fable review did not resume");
assert(!resumedFableReview.args_preview.includes("--model"), "review default overrode the resumed Fable conversation");
assert(resumedFableReview.resolved.effort === null, "resumed review unexpectedly selected effort");
const resumedFableStop = parseToolResult(
  await client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: plainProjectDir, interactive_id: resumedFableReview.interactive_id },
  }),
);
assert(resumedFableStop.stop.exited === true, "resumed Fable review did not exit after stop");

const interactiveStart = parseToolResult(
  await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: plainProjectDir,
      role: "reviewer",
      name: "fake interactive",
      mcp_preset: "none",
    },
  }),
);
assert(interactiveStart.status === "running", "interactive session did not start");
assert(interactiveStart.command === "claude", "interactive session did not launch claude");
assert(
  interactiveStart.resolved.auth.auth_method === "claude.ai",
  "interactive session did not retain its auth preflight method",
);
assert(
  interactiveStart.resolved.auth.subscription_type === "max",
  "interactive session did not retain its subscription type",
);
assert(
  interactiveStart.resolved.auth.billing_mode === "claude_subscription",
  "interactive session did not retain subscription billing mode",
);
assert(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(interactiveStart.claude_session_id),
  "interactive session did not expose a Claude Code session UUID",
);
assert(
  interactiveStart.resolved.claude_session_id === interactiveStart.claude_session_id,
  "resolved Claude session id did not match session",
);
assert(interactiveStart.resolved.resume_mode === "new", "new interactive session did not use new resume mode");
assert(interactiveStart.resolved.model === "opus", "new reviewer session did not default to Opus");
assert(interactiveStart.resolved.effort === null, "new reviewer session did not defer effort selection to Claude Code");
assert(
  interactiveStart.args_preview[interactiveStart.args_preview.indexOf("--model") + 1] === "opus",
  "new reviewer session did not pass the Opus model default",
);
assert(!interactiveStart.args_preview.includes("--effort"), "new reviewer session unexpectedly passed an effort");
assert(interactiveStart.args_preview.includes("--session-id"), "new interactive session did not pass --session-id");
assert(
  interactiveStart.args_preview.includes(interactiveStart.claude_session_id),
  "new interactive session did not pass the generated Claude session id",
);
assert(
  !interactiveStart.args_preview.includes("--remote-control"),
  "interactive session should not force Remote Control",
);
assert(interactiveStart.resolved.mcp_preset === "none", "interactive MCP preset was not resolved");
assert(
  interactiveStart.resolved.mcp_config.mode === "strict_empty",
  "none MCP preset did not use a strict empty config",
);
assert(
  interactiveStart.args_preview.includes("--strict-mcp-config"),
  "none MCP preset did not pass --strict-mcp-config",
);
const settingSourcesArg = interactiveStart.args_preview.indexOf("--setting-sources");
assert(
  settingSourcesArg >= 0 && interactiveStart.args_preview[settingSourcesArg + 1] === "",
  "strict-empty MCP sessions should not load Claude settings",
);
const settingsArg = interactiveStart.args_preview.indexOf("--settings");
assert(settingsArg >= 0, "session-local Claude settings were not supplied");
const sessionSettings = JSON.parse(fs.readFileSync(interactiveStart.args_preview[settingsArg + 1], "utf8"));
assert(
  !Object.hasOwn(sessionSettings, "permissions"),
  "session settings unexpectedly replaced Claude Code permissions",
);
assert(
  JSON.stringify(Object.keys(sessionSettings.hooks).sort()) ===
    JSON.stringify(["Notification", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"].sort()),
  "session lifecycle hooks were not configured as expected",
);
const instructionArg = interactiveStart.args_preview.indexOf("--append-system-prompt-file");
assert(instructionArg >= 0, "review-only instruction was not supplied");
const reviewInstruction = fs.readFileSync(interactiveStart.args_preview[instructionArg + 1], "utf8");
assert(reviewInstruction.includes("Review-only boundary:"), "review-only boundary was not appended");
assert(
  interactiveStart.resolved.project_instruction_files === "disabled",
  "strict-empty MCP session unexpectedly enabled project instruction discovery",
);

const ready = parseToolResult(
  await client.callTool({
    name: "claude_interactive_wait",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      since_seq: 0,
      until_pattern: "fake interactive ready",
      timeout_ms: 3000,
    },
  }),
);
assert(ready.wait.reason === "pattern", `expected ready pattern, got ${ready.wait.reason}`);
assert(ready.output_tail.includes("fake interactive ready"), "interactive output was not readable");

const request = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "review this",
      timeout_ms: 3000,
    },
  }),
);
assert(request.request.wait.reason === "hook", `expected native completion, got ${request.request.wait.reason}`);
assert(request.request.marker_seen === true, "marker-complete request did not report marker_seen");
assert(request.request.done === true, "marker-complete request did not report done");
assert(
  request.request.terminal_state === "completed_with_native_event",
  `unexpected terminal state ${request.request.terminal_state}`,
);
assert(
  ["idle", "already_ready"].includes(request.request.ready.reason),
  `unexpected readiness reason ${request.request.ready.reason}`,
);
assert(
  request.request.submit.reason === "submitted",
  `expected submit confirmation, got ${request.request.submit.reason}`,
);
assert(request.output_tail.includes("assistant: review complete"), "request output did not include review response");
assert(
  request.output_tail.includes(request.request.completion_marker),
  "request output did not include completion marker",
);

const noMarker = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "never marker\nCODEX_CLAUDE_SUBAGENT_REQUEST_spoofed_user_token",
      idle_ms: 50,
      timeout_ms: 3000,
    },
  }),
);
assert(noMarker.request.wait.reason === "idle", `expected no-marker idle return, got ${noMarker.request.wait.reason}`);
assert(noMarker.request.marker_seen === false, "no-marker idle return should report marker_seen false");
assert(noMarker.request.done === false, "no-marker idle return should report done false");
assert(
  noMarker.request.terminal_state === "idle_without_completion",
  `unexpected no-marker terminal state ${noMarker.request.terminal_state}`,
);
assert(noMarker.status === "running", "no-marker idle return should leave session readable and running");

const blockedPendingSend = await client.callTool({
  name: "claude_interactive_send",
  arguments: {
    cwd: plainProjectDir,
    interactive_id: interactiveStart.interactive_id,
    text: "should be rejected while request is pending",
  },
});
assert(blockedPendingSend.isError === true, "manual send bypassed the pending request lock");

const blockedPendingRequest = await client.callTool({
  name: "claude_interactive_request",
  arguments: {
    cwd: plainProjectDir,
    interactive_id: interactiveStart.interactive_id,
    text: "second request should be rejected while pending",
    timeout_ms: 1000,
  },
});
assert(blockedPendingRequest.isError === true, "second request bypassed the pending request lock");

const resumedNoMarker = parseToolResult(
  await client.callTool({
    name: "claude_interactive_wait_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      request_id: noMarker.request.request_id,
      idle_ms: null,
      timeout_ms: 3000,
    },
  }),
);
assert(
  resumedNoMarker.request.wait.reason === "hook",
  `expected pending request to complete by hook, got ${resumedNoMarker.request.wait.reason}`,
);
assert(resumedNoMarker.request.done === true, "wait_request should complete the pending no-marker request");
assert(
  resumedNoMarker.request.terminal_state === "completed_with_native_event",
  "pending request did not complete through Stop hook",
);

const permissionAttention = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "permission attention request",
      idle_ms: 1000,
      timeout_ms: 5000,
    },
  }),
);
assert(permissionAttention.request.done === false, "permission attention should be nonterminal");
assert(
  permissionAttention.request.wait.reason === "hook",
  `permission attention did not return immediately: ${permissionAttention.request.wait.reason}`,
);
assert(
  permissionAttention.request.wait.matched_hook?.notification_type === "permission_prompt",
  "permission attention did not wake on its notification",
);
assert(
  permissionAttention.request.permission_attention?.notification_type === "permission_prompt",
  "permission prompt attention was not captured",
);
assert(
  permissionAttention.request.permission_attention.request_id === permissionAttention.request.request_id,
  "permission attention lost request correlation",
);
const duplicateAttentionRequest = await client.callTool({
  name: "claude_interactive_request",
  arguments: {
    cwd: plainProjectDir,
    interactive_id: interactiveStart.interactive_id,
    text: "duplicate permission attention request",
    timeout_ms: 1000,
  },
});
assert(duplicateAttentionRequest.isError === true, "duplicate request bypassed the permission attention pending lock");
const completedPermissionAttention = parseToolResult(
  await client.callTool({
    name: "claude_interactive_wait_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      request_id: permissionAttention.request.request_id,
      timeout_ms: 3000,
      idle_ms: null,
    },
  }),
);
assert(completedPermissionAttention.request.done === true, "permission attention request did not reach Stop");
assert(
  completedPermissionAttention.request.terminal_state === "completed_with_native_event",
  "permission attention request used a nonterminal transport",
);
assert(
  completedPermissionAttention.request.permission_attention === null,
  "permission attention was not cleared on resume/terminal completion",
);
const unconfirmedSubmit = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "retry submit request",
      idle_ms: 50,
      timeout_ms: 1000,
    },
  }),
);
assert(unconfirmedSubmit.request.done === false, "unconfirmed request should remain pending");
assert(unconfirmedSubmit.request.submitted_at === null, "unconfirmed request should not claim submission");

const retriedSubmit = parseToolResult(
  await client.callTool({
    name: "claude_interactive_wait_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      request_id: unconfirmedSubmit.request.request_id,
      retry_submit: true,
      timeout_ms: 3000,
    },
  }),
);
assert(
  retriedSubmit.request.retry_submit?.reason === "submitted",
  `Enter-only retry did not confirm submission: ${JSON.stringify(retriedSubmit.request.retry_submit)}`,
);
assert(retriedSubmit.request.done === true, "Enter-only retry did not complete the pending request");
assert(retriedSubmit.request.result_text === "retry submit complete", "Enter-only retry lost the hook result");

const hookFailure = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "hook failure request",
      idle_ms: null,
      timeout_ms: 3000,
    },
  }),
);
assert(hookFailure.request.wait.reason === "hook", `StopFailure request returned ${hookFailure.request.wait.reason}`);
assert(
  hookFailure.request.status === "failed" && hookFailure.request.done === false,
  "StopFailure did not produce a failed terminal request",
);
assert(
  hookFailure.request.terminal_state === "stop_failure:rate_limit",
  `unexpected StopFailure state ${hookFailure.request.terminal_state}`,
);
assert(hookFailure.request.result_text === "rate limited", "StopFailure result text was not preserved");
assert(
  hookFailure.request.wait_required === false && hookFailure.request.next_action === null,
  "terminal StopFailure incorrectly requested another wait",
);
assert(hookFailure.active_request === null, "StopFailure did not release the active request lock");

const delayedHookFailure = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "delayed hook failure request",
      idle_ms: null,
      timeout_ms: 3000,
    },
  }),
);
assert(delayedHookFailure.request.wait.reason === "hook", "marker grace did not wait for delayed StopFailure");
assert(delayedHookFailure.request.marker_seen === true, "delayed StopFailure test did not observe the marker first");
assert(delayedHookFailure.request.status === "failed", "delayed StopFailure was misclassified as success");
assert(
  delayedHookFailure.request.terminal_state === "stop_failure:delayed_rate_limit",
  `unexpected delayed StopFailure state ${delayedHookFailure.request.terminal_state}`,
);

const noOutputWait = parseToolResult(
  await client.callTool({
    name: "claude_interactive_wait",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      since_seq: delayedHookFailure.next_seq,
      idle_ms: 50,
      timeout_ms: 3000,
    },
  }),
);
assert(
  noOutputWait.wait.reason === "idle_no_output",
  `expected low-level no-output idle return, got ${noOutputWait.wait.reason}`,
);

const hardTimeout = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "hard timeout marker",
      idle_ms: null,
      timeout_ms: 300,
    },
  }),
);
assert(hardTimeout.request.wait.reason === "timeout", `expected hard timeout, got ${hardTimeout.request.wait.reason}`);
assert(hardTimeout.request.wait_required === true, "hard timeout did not require continued waiting");
assert(
  hardTimeout.request.next_action?.tool === "claude_interactive_wait_request",
  "hard timeout did not name the required wait tool",
);
assert(hardTimeout.request.next_action?.repeat_until_terminal === true, "hard timeout did not require repeated waits");

const repeatedHardTimeout = parseToolResult(
  await client.callTool({
    name: "claude_interactive_wait_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      request_id: hardTimeout.request.request_id,
      idle_ms: null,
      timeout_ms: 300,
    },
  }),
);
assert(
  repeatedHardTimeout.request.wait.reason === "timeout",
  "first resumed wait should time out before the delayed Stop",
);
assert(repeatedHardTimeout.request.wait_required === true, "resumed timeout did not require another wait");
assert(
  repeatedHardTimeout.request.next_action?.repeat_until_terminal === true,
  "resumed timeout did not preserve repeat guidance",
);

const registryPath = path.join(stateDir, "interactive-sessions.json");
await waitForCondition(() => {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const persisted = registry.sessions.find((session) => session.interactive_id === interactiveStart.interactive_id);
  return (
    persisted?.last_request?.request_id === hardTimeout.request.request_id &&
    persisted.last_request.terminal_state === "completed_with_native_event" &&
    persisted.active_request === null
  );
}, 3000);

const resumedHardTimeout = parseToolResult(
  await client.callTool({
    name: "claude_interactive_wait_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      request_id: hardTimeout.request.request_id,
      idle_ms: null,
      timeout_ms: 3000,
    },
  }),
);
assert(resumedHardTimeout.request.done === true, "timed-out request did not remain resumable");
assert(
  resumedHardTimeout.request.terminal_state === "completed_with_native_event",
  "timed-out request did not eventually complete",
);
assert(resumedHardTimeout.request.wait.reason === "hook", "late Stop was not returned as the terminal hook");
assert(
  resumedHardTimeout.request.wait_required === false && resumedHardTimeout.request.next_action === null,
  "completed late Stop still requested another wait",
);

const spamMarker = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "spam marker",
      timeout_ms: 3000,
    },
  }),
);
assert(
  ["pattern", "hook"].includes(spamMarker.request.wait.reason),
  `expected high-volume completion, got ${spamMarker.request.wait.reason}`,
);
assert(
  spamMarker.output_tail.includes(spamMarker.request.completion_marker),
  "high-volume request lost completion marker",
);
assert(spamMarker.request.terminal_state === "completed_with_native_event", "marker bypassed native completion");
assert(spamMarker.request.result_text === "spam complete", "Stop hook grace period lost the authoritative result");

const longPayload = [
  "LONG_PAYLOAD_BEGIN",
  ...Array.from(
    { length: 12000 },
    (_, index) => `payload_line_${index.toString().padStart(5, "0")}_abcdefghijklmnopqrstuvwxyz`,
  ),
  "LONG_PAYLOAD_END",
].join("\n");
const longPaste = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: longPayload,
      idle_ms: null,
      timeout_ms: 10000,
    },
  }),
);
assert(
  ["pattern", "hook"].includes(longPaste.request.wait.reason),
  `expected long paste completion, got ${longPaste.request.wait.reason}`,
);
assert(
  longPaste.request.result_text === "long paste received" ||
    longPaste.output_tail.includes("assistant: long paste received"),
  "long paste did not reach fake Claude intact",
);

const longOutputStartOffset = longPaste.log_size_bytes;
const longOutput = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "long output marker",
      idle_ms: null,
      timeout_ms: 10000,
    },
  }),
);
assert(
  ["pattern", "hook"].includes(longOutput.request.wait.reason),
  `expected long output completion, got ${longOutput.request.wait.reason}`,
);
assert(longOutput.output_tail.includes("LONG_OUTPUT_END"), "long output tail did not include end sentinel");

let longOutputLogOffset = longOutputStartOffset;
let longOutputLogText = "";
let longOutputLogPage = null;
for (let page = 0; page < 10; page += 1) {
  longOutputLogPage = parseToolResult(
    await client.callTool({
      name: "claude_interactive_read_log",
      arguments: {
        cwd: plainProjectDir,
        interactive_id: interactiveStart.interactive_id,
        offset: longOutputLogOffset,
        max_bytes: 400000,
      },
    }),
  );
  if (page === 0)
    assert(longOutputLogPage.start_offset === longOutputStartOffset, "log read did not start at requested offset");
  longOutputLogText += longOutputLogPage.text;
  longOutputLogOffset = longOutputLogPage.next_offset;
  if (longOutputLogPage.eof) break;
}
assert(longOutputLogText.includes("LONG_OUTPUT_LINE_00000"), "log paging lost the start of long Claude output");
assert(longOutputLogText.includes("LONG_OUTPUT_END"), "log paging lost the end of long Claude output");
assert(longOutputLogPage?.eof === true, "paged long output log read should reach EOF");

const utf8Request = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "utf8 split request",
      idle_ms: null,
      timeout_ms: 10000,
    },
  }),
);
assert(["hook", "pattern"].includes(utf8Request.request.wait.reason), "UTF-8 request did not complete");
assert(utf8Request.request.result_text?.includes("日本語🙂完了"), "Stop hook lost the final UTF-8 response");

const utf8Visible = parseToolResult(
  await client.callTool({
    name: "claude_interactive_wait",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      since_seq: utf8Request.request.start_seq,
      until_pattern: "日本語🙂完了",
      timeout_ms: 3000,
    },
  }),
);
assert(
  utf8Visible.wait.reason === "pattern",
  `split UTF-8 terminal output did not become visible: ${utf8Visible.wait.reason} ${JSON.stringify(utf8Visible.chunks)}`,
);
assert(!utf8Visible.output_tail.includes("�"), "live UTF-8 output contains replacement characters");

let utf8LogOffset = Math.max(0, utf8Visible.log_size_bytes - 256);
let utf8LogText = "";
let utf8LogPage = null;
for (let page = 0; page < 200; page += 1) {
  utf8LogPage = parseToolResult(
    await client.callTool({
      name: "claude_interactive_read_log",
      arguments: {
        cwd: plainProjectDir,
        interactive_id: interactiveStart.interactive_id,
        offset: utf8LogOffset,
        max_bytes: 4,
      },
    }),
  );
  utf8LogText += utf8LogPage.text;
  utf8LogOffset = utf8LogPage.next_offset;
  if (utf8LogPage.eof) break;
}
assert(utf8LogPage?.eof === true, "UTF-8 log paging did not reach EOF");
assert(utf8LogText.includes("日本語🙂完了"), "UTF-8 log paging lost multibyte output");
assert(!utf8LogText.includes("�"), "UTF-8 log paging contains replacement characters");

const longHookResult = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "long hook result request",
      idle_ms: null,
      timeout_ms: 10000,
    },
  }),
);
assert(longHookResult.request.done === true, "long hook result request did not complete");
assert(longHookResult.request.result_text_truncated === true, "long hook result did not report truncation");
assert(longHookResult.request.result_text.startsWith("RESULT_BEGIN_"), "long hook result lost its prefix");
assert(
  longHookResult.request.result_text.includes(
    "[codex-claude-subagent: native answer truncated to at most 64,000 UTF-16 code units; the rest is not in this field and may or may not be in the terminal log]",
  ),
  "long hook result lacked a truncation marker",
);
assert(!longHookResult.request.result_text.includes("�"), "long hook result split a Unicode character");
assert(longHookResult.latest_native_outcome.answer_truncated === true, "session native outcome lost truncation flag");
assert(
  longHookResult.latest_native_outcome.answer === longHookResult.request.result_text,
  "session native outcome re-sliced the clipped answer or marker",
);
for (const name of ["claude_interactive_read", "claude_interactive_saved_sessions"]) {
  const result = parseToolResult(
    await client.callTool({
      name,
      arguments: {
        cwd: plainProjectDir,
        ...(name === "claude_interactive_read" ? { interactive_id: interactiveStart.interactive_id } : {}),
      },
    }),
  );
  const view = result.sessions
    ? result.sessions.find((session) => session.interactive_id === interactiveStart.interactive_id)
    : result;
  assert(
    view.latest_native_outcome.answer_truncated === true &&
      view.latest_native_outcome.answer === longHookResult.request.result_text,
    `${name}: long native answer marker/flag lost`,
  );
  assert(
    view.last_request.result_text_truncated === true &&
      view.last_request.result_text === longHookResult.request.result_text,
    `${name}: long request answer marker/flag lost`,
  );
}

const firstSeq = utf8Visible.next_seq;
const interactiveSend = parseToolResult(
  await client.callTool({
    name: "claude_interactive_send",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "hello interactive",
      submit: true,
    },
  }),
);
assert(interactiveSend.status === "running", "interactive send changed session status");

const reply = parseToolResult(
  await client.callTool({
    name: "claude_interactive_wait",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      since_seq: firstSeq,
      until_pattern: "assistant: interactive reply",
      timeout_ms: 3000,
    },
  }),
);
assert(reply.wait.reason === "pattern", `expected reply pattern, got ${reply.wait.reason}`);

const interactiveList = parseToolResult(
  await client.callTool({
    name: "claude_interactive_list",
    arguments: { cwd: plainProjectDir },
  }),
);
assert(
  interactiveList.sessions.some((session) => session.interactive_id === interactiveStart.interactive_id),
  "interactive list did not include the live session",
);

const scheduleExhaustion = parseToolResult(
  await client.callTool({
    name: "claude_interactive_request",
    arguments: {
      cwd: plainProjectDir,
      interactive_id: interactiveStart.interactive_id,
      text: "schedule exhaustion request",
      idle_ms: null,
    },
  }),
);
assert(
  scheduleExhaustion.request.wait.reason === "timeout",
  "scheduled request did not return at its first checkpoint",
);
assert(scheduleExhaustion.request.timeout_ms <= 100, "first scheduled wait exceeded its 100ms checkpoint");
const expectedRemainingCheckpoints = [200, 300, 400, 500, 600, 900, 1200, 1800];
let scheduledResponse = scheduleExhaustion;
for (const checkpointMs of expectedRemainingCheckpoints) {
  assert(
    scheduledResponse.request.next_action?.checkpoint_elapsed_ms === checkpointMs,
    `missing cumulative checkpoint ${checkpointMs}`,
  );
  scheduledResponse = parseToolResult(
    await client.callTool({
      name: "claude_interactive_wait_request",
      arguments: {
        cwd: plainProjectDir,
        interactive_id: interactiveStart.interactive_id,
        request_id: scheduleExhaustion.request.request_id,
        idle_ms: null,
      },
    }),
  );
  assert(scheduledResponse.request.wait.reason === "timeout", `checkpoint ${checkpointMs} did not return on timeout`);
}
assert(
  scheduledResponse.request.pending === true,
  "90-minute-equivalent checkpoint incorrectly terminated the request",
);
assert(scheduledResponse.request.long_running === true, "exhausted wait schedule did not report long_running");
assert(scheduledResponse.request.wait_required === false, "exhausted wait schedule requested automatic continuation");
assert(scheduledResponse.request.next_action === null, "exhausted wait schedule exposed an automatic next action");
assert(
  scheduledResponse.request.attention_required?.action === "ask_user_to_continue_or_stop",
  "exhausted wait schedule did not require user direction",
);

const interactiveStop = parseToolResult(
  await client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: plainProjectDir, interactive_id: interactiveStart.interactive_id },
  }),
);
assert(interactiveStop.stop.exited === true, "interactive stop did not wait for process exit");
assert(interactiveStop.status === "exited", `interactive stop returned ${interactiveStop.status}`);

const savedSessions = parseToolResult(
  await client.callTool({
    name: "claude_interactive_saved_sessions",
    arguments: { cwd: plainProjectDir },
  }),
);
const savedInteractive = savedSessions.sessions.find(
  (session) => session.claude_session_id === interactiveStart.claude_session_id,
);
assert(savedInteractive, "saved sessions did not include the stopped Claude session id");
assert(savedInteractive.status === "exited", `saved session did not record exited status: ${savedInteractive?.status}`);

const changedRoleResume = await client.callTool({
  name: "claude_interactive_start",
  arguments: {
    cwd: plainProjectDir,
    role: "critic",
    name: "invalid changed-role resume",
    mcp_preset: "none",
    resume_claude_session_id: interactiveStart.claude_session_id,
    model: "opus",
    effort: "xhigh",
  },
});
assert(changedRoleResume.isError === true, "resume unexpectedly allowed a role change");
assert(
  changedRoleResume.content[0].text.includes("was created for role reviewer"),
  "changed-role resume failed for an unexpected reason",
);

const resumedStart = parseToolResult(
  await client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: plainProjectDir,
      role: "reviewer",
      name: "fake resumed interactive",
      mcp_preset: "none",
      resume_claude_session_id: interactiveStart.claude_session_id,
      model: "opus",
      effort: "xhigh",
    },
  }),
);
assert(resumedStart.status === "running", "resumed interactive session did not start");
assert(
  resumedStart.claude_session_id === interactiveStart.claude_session_id,
  "resumed session did not preserve Claude session id",
);
assert(resumedStart.resolved.resume_mode === "resume", "resumed interactive session did not use resume mode");
assert(resumedStart.resolved.model === "opus", "resumed interactive session did not apply the requested model");
assert(resumedStart.resolved.effort === "xhigh", "resumed interactive session did not apply the requested effort");
assert(resumedStart.args_preview.includes("--resume"), "resumed interactive session did not pass --resume");
assert(
  resumedStart.args_preview.includes(interactiveStart.claude_session_id),
  "resumed interactive session did not pass saved Claude session id",
);
assert(
  resumedStart.args_preview.includes("--model") && resumedStart.args_preview.includes("opus"),
  "resumed interactive session did not pass the requested model",
);
assert(
  resumedStart.args_preview.includes("--effort") && resumedStart.args_preview.includes("xhigh"),
  "resumed interactive session did not pass the requested effort",
);
assert(!resumedStart.args_preview.includes("--remote-control"), "resumed session should not force Remote Control");
const resumedStop = parseToolResult(
  await client.callTool({
    name: "claude_interactive_stop",
    arguments: { cwd: plainProjectDir, interactive_id: resumedStart.interactive_id },
  }),
);
assert(resumedStop.stop.exited === true, "resumed session did not exit after stop");

const disconnected = createTestClient(path.join(tmpRoot, "state-disconnected-client"));
await disconnected.client.connect(disconnected.transport);
const disconnectedStart = parseToolResult(
  await disconnected.client.callTool({
    name: "claude_interactive_start",
    arguments: {
      cwd: plainProjectDir,
      role: "explorer",
      name: "fake disconnected client",
      mcp_preset: "none",
    },
  }),
);
assert(disconnectedStart.status === "running", "disconnected-client session did not start");
const disconnectStartedAt = Date.now();
await disconnected.client.close();
activeClients.delete(disconnected.client);
const disconnectElapsedMs = Date.now() - disconnectStartedAt;
assert(disconnectElapsedMs < 1800, `server did not exit promptly after MCP stdin closed (${disconnectElapsedMs}ms)`);

await client.close();

console.log(
  JSON.stringify(
    {
      ok: true,
      stateDir,
      interactiveId: interactiveStart.interactive_id,
    },
    null,
    2,
  ),
);
