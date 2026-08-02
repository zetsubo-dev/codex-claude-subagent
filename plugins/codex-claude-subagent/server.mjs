#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { createClaudeAuthPreflight } from "./lib/auth-preflight.mjs";
import { createSessionRegistrySupport } from "./lib/session-registry.mjs";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE_VERSION = "0.2.0";
const VERSION = readPluginVersion();
const PTY_BRIDGE_PATH = path.join(PLUGIN_DIR, "scripts", "pty_bridge.py");
const HOOK_BRIDGE_PATH = path.join(PLUGIN_DIR, "scripts", "hook_bridge.mjs");
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".codex", "codex-claude-subagent");
const STATE_DIR = process.env.CODEX_CLAUDE_SUBAGENT_STATE_DIR || DEFAULT_STATE_DIR;
const INTERACTIVE_LOG_DIR = path.join(STATE_DIR, "interactive-logs");
const MCP_CONFIG_DIR = path.join(STATE_DIR, "mcp-configs");
const HOOK_EVENT_DIR = path.join(STATE_DIR, "hook-events");
const HOOK_SETTINGS_DIR = path.join(STATE_DIR, "hook-settings");
const INSTRUCTION_CONTEXT_DIR = path.join(STATE_DIR, "instruction-contexts");
const SESSION_REGISTRY_PATH = path.join(STATE_DIR, "interactive-sessions.json");
const SESSION_REGISTRY_LOCK_DIR = path.join(STATE_DIR, "interactive-sessions.lock");
const INSTANCE_ID = crypto.randomUUID();
const INSTANCE_STARTED_AT = new Date().toISOString();
const MAX_TAIL_CHARS = 20000;
const MAX_INTERACTIVE_CHUNKS = 200;
const MAX_WAITER_BUFFER_CHARS = 200000;
const MAX_HOOK_EVENTS = 200;
const MAX_HOOK_READ_BYTES = 2 * 1024 * 1024;
const MAX_HOOK_FILE_BYTES = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_MAX_HOOK_FILE_BYTES", 8 * 1024 * 1024);
const HOOK_MONITOR_POLL_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_HOOK_MONITOR_POLL_MS", 250);
const HOOK_FILE_GENERATION_FIELD = "codex_claude_subagent_hook_generation";
const DEFAULT_WAIT_TIMEOUT_MS = 1800000;
const MAX_WAIT_TIMEOUT_MS = 3600000;
const DEFAULT_REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_REQUEST_TIMEOUT_MS", 300000);
const DEFAULT_REQUEST_IDLE_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_REQUEST_IDLE_MS", 30000);
const MAX_REQUEST_IDLE_MS = 300000;
const DEFAULT_REQUEST_WAIT_SCHEDULE_MINUTES = Object.freeze([5, 10, 15, 20, 25, 30, 45, 60, 90]);
const DEFAULT_REQUEST_WAIT_SCHEDULE_MS = DEFAULT_REQUEST_WAIT_SCHEDULE_MINUTES.map((minutes) => minutes * 60 * 1000);
const REQUEST_WAIT_SCHEDULE_MS = parseWaitScheduleMs(process.env.CODEX_CLAUDE_SUBAGENT_REQUEST_WAIT_SCHEDULE_MS);
const CLAUDE_DETECT_TIMEOUT_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_DETECT_TIMEOUT_MS", 5000);
const AUTH_STATUS_TIMEOUT_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_AUTH_STATUS_TIMEOUT_MS", 10000);
const AUTH_DOCTOR_TIMEOUT_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_AUTH_DOCTOR_TIMEOUT_MS", 15000);
const HOOK_COMPLETION_GRACE_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_HOOK_COMPLETION_GRACE_MS", 6000);
const STARTUP_READY_IDLE_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_STARTUP_READY_IDLE_MS", 1000);
const STARTUP_READY_TIMEOUT_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_STARTUP_READY_TIMEOUT_MS", 30000);
const STARTUP_MCP_SELECTOR_RE =
  /new MCP servers found|Select any you wish to enable|Space to select.*Enter to confirm.*Esc to reject all/i;
const SUBMIT_AFTER_PASTE_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_SUBMIT_AFTER_PASTE_MS", 1000);
const SUBMIT_AFTER_PASTE_LINE_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_SUBMIT_AFTER_PASTE_LINE_MS", 50);
const SUBMIT_AFTER_PASTE_MAX_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_SUBMIT_AFTER_PASTE_MAX_MS", 2500);
const SUBMIT_ENTER_COUNT = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_SUBMIT_ENTER_COUNT", 2);
const SUBMIT_ENTER_GAP_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_SUBMIT_ENTER_GAP_MS", 250);
const SUBMIT_CONFIRM_TIMEOUT_MS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_SUBMIT_CONFIRM_TIMEOUT_MS", 2500);
const SUBMIT_CONFIRM_ATTEMPTS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_SUBMIT_CONFIRM_ATTEMPTS", 4);
const STOP_GRACE_MS = 8000;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_BYTES = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_MAX_LOG_BYTES", DEFAULT_MAX_LOG_BYTES);
const MAX_LOG_READ_BYTES = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_MAX_LOG_READ_BYTES", 1024 * 1024);
const DEFAULT_LOG_READ_BYTES = Math.min(
  parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_DEFAULT_LOG_READ_BYTES", 200000),
  MAX_LOG_READ_BYTES,
);
const MAX_MCP_CONFIG_FILES = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_MAX_MCP_CONFIG_FILES", 200);
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_SAVED_SESSIONS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_MAX_SAVED_SESSIONS", 200);
const MAX_SAVED_SESSION_BYTES = parsePositiveIntegerEnv(
  "CODEX_CLAUDE_SUBAGENT_MAX_SAVED_SESSION_BYTES",
  512 * 1024 * 1024,
);
const MAX_SAVED_SESSION_AGE_DAYS = parsePositiveIntegerEnv("CODEX_CLAUDE_SUBAGENT_MAX_SAVED_SESSION_AGE_DAYS", 30);
const MAX_SAVED_SESSION_AGE_MS = MAX_SAVED_SESSION_AGE_DAYS * 24 * 60 * 60 * 1000;
const MAX_RECENT_INTERACTIVE_SESSIONS = 50;
const REGISTRY_LOCK_TIMEOUT_MS = 5000;
const REGISTRY_LOCK_STALE_MS = 30000;
const LIVE_SESSION_STATUSES = new Set(["starting", "running", "stopping"]);
const READ_ONLY_ROLES = new Set(["explorer", "reviewer", "security_reviewer", "critic", "architect"]);
const IMPLEMENTATION_ROLES = new Set(["implementer"]);
const READ_ONLY_BUILTIN_TOOLS = ["Bash", "Read", "Grep", "Glob"];
const READ_ONLY_ALLOWED_TOOLS = [...READ_ONLY_BUILTIN_TOOLS];
const IMPLEMENTER_BUILTIN_TOOLS = [...READ_ONLY_BUILTIN_TOOLS, "Edit", "Write"];
const IMPLEMENTER_ALLOWED_TOOLS = [...IMPLEMENTER_BUILTIN_TOOLS];
const NESTED_AGENT_TOOL_PATTERN = /^(?:Task|Team|SendMessage|Agent)(?:$|[(:])/;
const FORBIDDEN_CLAUDE_ARG_FLAGS = new Set([
  "-p",
  "--print",
  "--bg",
  "--background",
  "--tmux",
  "--remote-control",
  "--remote-control-skill",
  "--bare",
  "--no-session-persistence",
  "--dangerously-skip-permissions",
  "--add-dir",
  "--plugin-dir",
  "--plugin-url",
  "--agents",
  "--agent",
  "--output-format",
  "--input-format",
  "--json-schema",
  "--system-prompt",
  "--safe-mode",
]);
const CONTROLLED_CLAUDE_ARG_FLAGS = new Set([
  "-m",
  "-n",
  "--model",
  "--effort",
  "--permission-mode",
  "--session-id",
  "--resume",
  "--continue",
  "--name",
  "--settings",
  "--setting-sources",
  "--append-system-prompt-file",
  "--tools",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--mcp-config",
  "--strict-mcp-config",
  "--worktree",
]);
const FORWARDED_CLAUDE_ARG_FLAGS = new Map([
  ["-d", { values: 1, optional: true }],
  ["--debug", { values: 1, optional: true }],
  ["--disable-slash-commands", { values: 0 }],
  ["--exclude-dynamic-system-prompt-sections", { values: 0 }],
  ["--ide", { values: 0 }],
  ["--no-chrome", { values: 0 }],
  ["--prompt-suggestions", { values: 1, optional: true }],
  ["--verbose", { values: 0 }],
]);
const DEFAULT_READ_ONLY_MCP_PRESET = "auto";
const MODEL_EFFORT_DEFAULT_SOURCE = "claude_code";
const REVIEW_ONLY_BOUNDARY = `Review-only boundary:
- Do not create, modify, delete, format, or stage files.
- Do not run implementation, install, formatting, migration, or destructive commands.
- Use Bash, Read, Grep, Glob, and project MCP tools only for non-mutating investigation and verification.
- Follow the target project's CLAUDE.md and configured MCP guidance.
- Return findings, evidence, and suggested fixes for Codex to apply.`;
const IMPLEMENTATION_BOUNDARY = `Implementation boundary:
- Use the dedicated Claude Code Git worktree selected by --worktree for all intended edits and checks.
- You may create, modify, delete, and format files there, and run the project's tests and checks.
- The Git worktree separates normal repository changes but is not an OS-level filesystem sandbox; do not use absolute paths or change directories outside it.
- Do not commit, push, or publish changes.
- Follow the target project's CLAUDE.md and configured MCP guidance.
- Return the changed files, commands and tests run, results, and any remaining issues for Codex to inspect and integrate.`;
const MCP_PRESETS = {
  none: { mode: "strict_empty" },
  auto: { mode: "project_default" },
  serena: { mode: "project_default", legacy_alias: true },
  context7: { mode: "project_default", legacy_alias: true },
  serena_context7: { mode: "project_default", legacy_alias: true },
};

const ROLE_PROFILES = {
  explorer: {
    mode: "read_only",
    purpose: "Explore the repository and report relevant files, structure, and evidence without changing files.",
    mutatesFiles: false,
    requiresWorktree: false,
    filesystemIsolation: "none",
    tools: READ_ONLY_BUILTIN_TOOLS,
    allowedTools: READ_ONLY_ALLOWED_TOOLS,
    disallowedTools: [],
    permissionMode: "plan",
  },
  reviewer: {
    mode: "read_only",
    purpose: "Review correctness, maintainability, and regressions without changing files.",
    mutatesFiles: false,
    requiresWorktree: false,
    filesystemIsolation: "none",
    tools: READ_ONLY_BUILTIN_TOOLS,
    allowedTools: READ_ONLY_ALLOWED_TOOLS,
    disallowedTools: [],
    permissionMode: "plan",
  },
  security_reviewer: {
    mode: "read_only",
    purpose: "Perform a complex security review without changing files.",
    mutatesFiles: false,
    requiresWorktree: false,
    filesystemIsolation: "none",
    tools: READ_ONLY_BUILTIN_TOOLS,
    allowedTools: READ_ONLY_ALLOWED_TOOLS,
    disallowedTools: [],
    permissionMode: "plan",
  },
  critic: {
    mode: "read_only",
    purpose: "Give an adversarial second opinion without changing files.",
    mutatesFiles: false,
    requiresWorktree: false,
    filesystemIsolation: "none",
    tools: READ_ONLY_BUILTIN_TOOLS,
    allowedTools: READ_ONLY_ALLOWED_TOOLS,
    disallowedTools: [],
    permissionMode: "plan",
  },
  architect: {
    mode: "read_only",
    purpose: "Develop design and refactor recommendations without changing files.",
    mutatesFiles: false,
    requiresWorktree: false,
    filesystemIsolation: "none",
    tools: READ_ONLY_BUILTIN_TOOLS,
    allowedTools: READ_ONLY_ALLOWED_TOOLS,
    disallowedTools: [],
    permissionMode: "plan",
  },
  implementer: {
    mode: "implementation",
    purpose: "Implement a requested change and run relevant checks in a dedicated worktree.",
    mutatesFiles: true,
    requiresWorktree: true,
    filesystemIsolation: "git_worktree_not_os_sandbox",
    tools: IMPLEMENTER_BUILTIN_TOOLS,
    allowedTools: IMPLEMENTER_ALLOWED_TOOLS,
    disallowedTools: [],
    permissionMode: "dontAsk",
  },
};

const interactiveSessions = new Map();
const savedSessionRegistry = new Map();
let registryWriteQueue = Promise.resolve();
const claudeAuthPreflight = createClaudeAuthPreflight({
  buildEnvironment: buildClaudeEnvironment,
  detectTimeoutMs: CLAUDE_DETECT_TIMEOUT_MS,
  statusTimeoutMs: AUTH_STATUS_TIMEOUT_MS,
  doctorTimeoutMs: AUTH_DOCTOR_TIMEOUT_MS,
});
const sessionRegistrySupport = createSessionRegistrySupport({
  lockDir: SESSION_REGISTRY_LOCK_DIR,
  instanceId: INSTANCE_ID,
  privateDirMode: PRIVATE_DIR_MODE,
  privateFileMode: PRIVATE_FILE_MODE,
  lockTimeoutMs: REGISTRY_LOCK_TIMEOUT_MS,
  lockStaleMs: REGISTRY_LOCK_STALE_MS,
  processIsAlive,
  sessionKey: sessionRegistryKey,
  isLive: (record) => LIVE_SESSION_STATUSES.has(record.status),
  artifactSize: sessionArtifactSizeBytes,
  maxSessions: MAX_SAVED_SESSIONS,
  maxTerminalBytes: MAX_SAVED_SESSION_BYTES,
  maxTerminalAgeMs: MAX_SAVED_SESSION_AGE_MS,
});

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseWaitScheduleMs(rawValue) {
  if (!rawValue) return [...DEFAULT_REQUEST_WAIT_SCHEDULE_MS];
  const schedule = String(rawValue)
    .split(",")
    .map((value) => Number(value.trim()));
  if (
    !schedule.length ||
    schedule.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    schedule.some((value, index) => index > 0 && value <= schedule[index - 1]) ||
    schedule.some((value, index) => index > 0 && value - schedule[index - 1] > MAX_WAIT_TIMEOUT_MS)
  ) {
    throw new Error(
      "CODEX_CLAUDE_SUBAGENT_REQUEST_WAIT_SCHEDULE_MS must be a strictly increasing comma-separated list whose adjacent waits do not exceed the maximum wait timeout.",
    );
  }
  return schedule;
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, ".codex-plugin", "plugin.json"), "utf8"));
    return typeof manifest.version === "string" && manifest.version ? manifest.version : BASE_VERSION;
  } catch {
    return BASE_VERSION;
  }
}

function ensureState() {
  ensureNotSymlink(STATE_DIR);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodBestEffort(STATE_DIR, PRIVATE_DIR_MODE);

  ensureNotSymlink(INTERACTIVE_LOG_DIR);
  fs.mkdirSync(INTERACTIVE_LOG_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodBestEffort(INTERACTIVE_LOG_DIR, PRIVATE_DIR_MODE);

  ensureNotSymlink(MCP_CONFIG_DIR);
  fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodBestEffort(MCP_CONFIG_DIR, PRIVATE_DIR_MODE);

  ensureNotSymlink(HOOK_EVENT_DIR);
  fs.mkdirSync(HOOK_EVENT_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodBestEffort(HOOK_EVENT_DIR, PRIVATE_DIR_MODE);

  ensureNotSymlink(HOOK_SETTINGS_DIR);
  fs.mkdirSync(HOOK_SETTINGS_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodBestEffort(HOOK_SETTINGS_DIR, PRIVATE_DIR_MODE);

  ensureNotSymlink(INSTRUCTION_CONTEXT_DIR);
  fs.mkdirSync(INSTRUCTION_CONTEXT_DIR, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodBestEffort(INSTRUCTION_CONTEXT_DIR, PRIVATE_DIR_MODE);

  ensureNotSymlink(SESSION_REGISTRY_PATH);
  ensureNotSymlink(SESSION_REGISTRY_LOCK_DIR);
}

function ensureNotSymlink(targetPath) {
  const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked Codex–Claude Subagent state path: ${targetPath}`);
  }
}

function chmodBestEffort(targetPath, mode) {
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // Ignore chmod failures on filesystems that do not support POSIX modes.
  }
}

function sessionRegistryKey(record) {
  return record.claude_session_id || record.interactive_id;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readRegistryMapUnsafe() {
  if (!fs.existsSync(SESSION_REGISTRY_PATH)) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(SESSION_REGISTRY_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse Codex–Claude Subagent session registry: ${error.message}`, { cause: error });
  }
  const registry = new Map();
  for (const record of Array.isArray(parsed?.sessions) ? parsed.sessions : []) {
    const key = sessionRegistryKey(record || {});
    if (key) registry.set(key, record);
  }
  return registry;
}

function removeOwnedArtifact(filePath, directory) {
  if (!filePath || typeof filePath !== "string") return;
  const resolved = path.resolve(filePath);
  if (!isPathWithin(path.resolve(directory), resolved)) return;
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat?.isFile() && !stat.isSymbolicLink()) fs.rmSync(resolved, { force: true });
}

function cleanupSessionArtifacts(record) {
  removeOwnedArtifact(record.log_path, INTERACTIVE_LOG_DIR);
  removeOwnedArtifact(record.hook_event_path, HOOK_EVENT_DIR);
  removeOwnedArtifact(record.hook_settings_path, HOOK_SETTINGS_DIR);
  removeOwnedArtifact(record.instruction_context_path, INSTRUCTION_CONTEXT_DIR);
}

function sessionArtifactSizeBytes(record) {
  return [record.log_path, record.hook_event_path, record.hook_settings_path, record.instruction_context_path].reduce(
    (total, filePath) => total + fileSizeBytes(filePath),
    0,
  );
}

function writeRegistryMapUnsafe(registry) {
  const { retained: sessions, evicted } = sessionRegistrySupport.selectRetained(registry.values());
  const payload = JSON.stringify({ sessions }, null, 2);
  const tmpPath = `${SESSION_REGISTRY_PATH}.${process.pid}.${INSTANCE_ID}.tmp`;
  fs.writeFileSync(tmpPath, payload, { mode: PRIVATE_FILE_MODE });
  chmodBestEffort(tmpPath, PRIVATE_FILE_MODE);
  fs.renameSync(tmpPath, SESSION_REGISTRY_PATH);
  for (const record of evicted) {
    try {
      cleanupSessionArtifacts(record);
    } catch (error) {
      console.error(`Codex–Claude Subagent could not remove evicted session artifacts: ${error.message}`);
    }
  }
  return new Map(sessions.map((record) => [sessionRegistryKey(record), record]));
}

async function withRegistryLock(callback) {
  ensureState();
  return sessionRegistrySupport.withLock(callback);
}

function queueRegistryOperation(operation) {
  const queued = registryWriteQueue.then(operation, operation);
  registryWriteQueue = queued.catch((error) => {
    console.error(`Codex–Claude Subagent session registry update failed: ${error.message}`);
  });
  return queued;
}

function reconcileRegistryMap(registry) {
  const now = new Date().toISOString();
  let reconciled = false;
  for (const record of registry.values()) {
    if (LIVE_SESSION_STATUSES.has(record?.status) && !processIsAlive(record.owner_pid)) {
      record.status = "interrupted";
      record.ended_at ||= now;
      record.updated_at = now;
      record.error ||= "Codex–Claude Subagent server restarted before this PTY session reached a terminal state.";
      if (requestIsPending(record.active_request)) {
        record.active_request.status = "interrupted";
        record.active_request.done = false;
        record.active_request.terminal_state = "server_restarted";
        record.active_request.completed_at = now;
        record.last_request = record.active_request;
        record.active_request = null;
      }
      reconciled = true;
    }
  }
  return reconciled;
}

function replaceSavedSessionRegistry(registry) {
  savedSessionRegistry.clear();
  for (const [key, record] of registry) savedSessionRegistry.set(key, record);
}

async function loadSessionRegistry() {
  const registry = await queueRegistryOperation(() =>
    withRegistryLock(() => {
      let current = readRegistryMapUnsafe();
      if (reconcileRegistryMap(current)) current = writeRegistryMapUnsafe(current);
      return current;
    }),
  );
  replaceSavedSessionRegistry(registry);
}

async function reserveSessionLease(record) {
  const registry = await queueRegistryOperation(() =>
    withRegistryLock(() => {
      let current = readRegistryMapUnsafe();
      const reconciled = reconcileRegistryMap(current);
      const key = sessionRegistryKey(record);
      if (record.resume_mode === "new" && current.has(key)) {
        if (reconciled) writeRegistryMapUnsafe(current);
        throw new Error(
          `Claude Code session ${record.claude_session_id} already exists; resume it instead of reusing its UUID.`,
        );
      }
      const leased = [...current.values()].find(
        (candidate) =>
          candidate.claude_session_id === record.claude_session_id &&
          LIVE_SESSION_STATUSES.has(candidate.status) &&
          processIsAlive(candidate.owner_pid),
      );
      if (leased) {
        if (reconciled) writeRegistryMapUnsafe(current);
        throw new Error(
          `Claude Code session ${record.claude_session_id} is already attached to interactive session ${leased.interactive_id}.`,
        );
      }
      current.set(key, record);
      return writeRegistryMapUnsafe(current);
    }),
  );
  replaceSavedSessionRegistry(registry);
}

async function requireSavedResumeRecord(claudeSessionId, cwd, role) {
  await loadSessionRegistry();
  const record = savedSessionRegistry.get(claudeSessionId);
  if (!record) throw new Error(`Claude Code session ${claudeSessionId} is not registered with Codex–Claude Subagent.`);
  if (record.cwd !== cwd) throw new Error(`Claude Code session ${claudeSessionId} belongs to a different cwd.`);
  if (record.role !== role)
    throw new Error(`Claude Code session ${claudeSessionId} was created for role ${record.role}.`);
  if (LIVE_SESSION_STATUSES.has(record.status) && processIsAlive(record.owner_pid)) {
    throw new Error(
      `Claude Code session ${claudeSessionId} is already attached to interactive session ${record.interactive_id}.`,
    );
  }
  return record;
}

function persistInteractiveSession(session) {
  const record = {
    interactive_id: session.interactive_id,
    claude_session_id: session.claude_session_id,
    resume_mode: session.resume_mode,
    role: session.role,
    status: session.status,
    cwd: session.cwd,
    name: session.name,
    resolved: session.resolved,
    log_path: session.log_path,
    log_size_bytes: fileSizeBytes(session.log_path),
    started_at: session.started_at,
    last_output_at: session.last_output_at,
    updated_at: session.updated_at,
    ended_at: session.ended_at,
    exit_code: session.exit_code,
    signal: session.signal,
    error: session.error,
    owner_instance_id: INSTANCE_ID,
    owner_pid: process.pid,
    owner_started_at: INSTANCE_STARTED_AT,
    hook_event_path: session.hook_event_path,
    hook_file_generation: session.hook_file_generation,
    hook_settings_path: session.hook_settings_path,
    instruction_context_path: session.instruction_context_path,
    hooks_active: session.hooks_active,
    last_hook_event: session.last_hook_event,
    active_request: compactRequest(session.active_request),
    last_request: compactRequest(session.last_request),
  };
  const key = sessionRegistryKey(record);
  if (!key) return;
  const previousKey = session.registry_key;
  session.registry_key = key;
  return queueRegistryOperation(() =>
    withRegistryLock(() => {
      let current = readRegistryMapUnsafe();
      reconcileRegistryMap(current);
      if (previousKey && previousKey !== key) {
        const previous = current.get(previousKey);
        if (previous?.owner_instance_id === INSTANCE_ID) current.delete(previousKey);
      }
      current.set(key, record);
      const registry = writeRegistryMapUnsafe(current);
      replaceSavedSessionRegistry(registry);
      return registry;
    }),
  );
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function safeStringSuffix(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

function tailAppend(existing, chunk, maxChars = MAX_TAIL_CHARS) {
  const next = `${existing || ""}${chunk}`;
  return safeStringSuffix(next, maxChars);
}

function tailChunksByChars(chunks, maxChars) {
  const selected = [];
  let remaining = maxChars;
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index];
    const text = String(chunk.text || "");
    if (text.length > remaining) {
      selected.unshift({ ...chunk, text: safeStringSuffix(text, remaining) });
      remaining = 0;
    } else {
      selected.unshift(chunk);
      remaining -= text.length;
    }
  }
  return selected;
}

function fileSizeBytes(filePath) {
  if (!filePath) return 0;
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  return stat?.isFile() ? stat.size : 0;
}

function readHookFileGeneration(filePath) {
  const size = Math.min(fileSizeBytes(filePath), 512);
  if (!size) return null;
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline === -1) return null;
    const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    return typeof header?.[HOOK_FILE_GENERATION_FIELD] === "string" ? header[HOOK_FILE_GENERATION_FIELD] : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function requireAbsoluteExistingDirectory(cwd) {
  if (!cwd || typeof cwd !== "string") {
    throw new Error("cwd is required and must be an absolute path to the target project or worktree.");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error(`cwd must be absolute: ${cwd}`);
  }
  const stat = fs.statSync(cwd, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  }
  return fs.realpathSync(cwd);
}

function assertSessionCwd(session, cwd) {
  const canonicalCwd = requireAbsoluteExistingDirectory(cwd);
  if (session.cwd !== canonicalCwd) {
    throw new Error(`Interactive Claude session ${session.interactive_id} belongs to a different cwd.`);
  }
}

function uniqueInteractiveId() {
  return `clint_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function csv(values) {
  return [...new Set((values || []).filter(Boolean))].join(",");
}

function pushCsvArg(args, flag, values, { allowEmpty = false } = {}) {
  if (!values) return;
  const value = csv(values);
  if (value || allowEmpty) args.push(flag, value);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function profileFor(role) {
  return ROLE_PROFILES[role] || ROLE_PROFILES.reviewer;
}

function roleProfilesForInfo() {
  return Object.fromEntries(
    Object.entries(ROLE_PROFILES).map(([role, profile]) => {
      const { mutatesFiles, requiresWorktree, filesystemIsolation, ...rest } = profile;
      return [
        role,
        {
          ...rest,
          model: null,
          effort: null,
          model_effort_default_source: MODEL_EFFORT_DEFAULT_SOURCE,
          mutates_files: mutatesFiles,
          requires_worktree: requiresWorktree,
          filesystem_isolation: filesystemIsolation,
        },
      ];
    }),
  );
}

function defaultMcpPresetForRole() {
  return DEFAULT_READ_ONLY_MCP_PRESET;
}

function writePrivateMcpConfig(config, digestInput) {
  ensureState();
  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        digestInput,
        config,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  const configPath = path.join(MCP_CONFIG_DIR, `${digest}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: PRIVATE_FILE_MODE });
  chmodBestEffort(configPath, PRIVATE_FILE_MODE);
  prunePrivateMcpConfigs(configPath);
  return configPath;
}

function prunePrivateMcpConfigs(activePath) {
  const files = fs
    .readdirSync(MCP_CONFIG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(MCP_CONFIG_DIR, entry.name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const retained = new Set([activePath, ...files.slice(0, MAX_MCP_CONFIG_FILES).map(({ filePath }) => filePath)]);
  for (const { filePath } of files) {
    if (!retained.has(filePath)) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // Stale cache cleanup must not prevent a review session from starting.
      }
    }
  }
}

function instructionBoundaryForRole(role) {
  return IMPLEMENTATION_ROLES.has(role) ? IMPLEMENTATION_BOUNDARY : REVIEW_ONLY_BOUNDARY;
}

function writeInstructionContext(interactiveId, role) {
  ensureState();
  const contextPath = path.join(INSTRUCTION_CONTEXT_DIR, `${interactiveId}.md`);
  ensureNotSymlink(contextPath);
  fs.writeFileSync(contextPath, `${instructionBoundaryForRole(role)}\n`, { mode: PRIVATE_FILE_MODE, flag: "wx" });
  chmodBestEffort(contextPath, PRIVATE_FILE_MODE);
  return contextPath;
}

function createHookRuntime(interactiveId, role) {
  ensureState();
  const eventPath = path.join(HOOK_EVENT_DIR, `${interactiveId}.jsonl`);
  const settingsPath = path.join(HOOK_SETTINGS_DIR, `${interactiveId}.json`);
  const instructionContextPath = writeInstructionContext(interactiveId, role);
  const hookFileGeneration = crypto.randomUUID();
  ensureNotSymlink(eventPath);
  ensureNotSymlink(settingsPath);
  fs.writeFileSync(eventPath, `${JSON.stringify({ [HOOK_FILE_GENERATION_FIELD]: hookFileGeneration })}\n`, {
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
  const eventCommand = [process.execPath, HOOK_BRIDGE_PATH, eventPath, String(MAX_HOOK_FILE_BYTES)]
    .map(shellQuote)
    .join(" ");
  const hooks = {};
  for (const eventName of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "Notification"]) {
    hooks[eventName] = [
      {
        hooks: [
          {
            type: "command",
            command: eventCommand,
            timeout: 5,
          },
        ],
      },
    ];
  }
  const settings = { hooks };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), {
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
  chmodBestEffort(eventPath, PRIVATE_FILE_MODE);
  chmodBestEffort(settingsPath, PRIVATE_FILE_MODE);
  return {
    eventPath,
    settingsPath,
    hookFileGeneration,
    instructionContextPath,
  };
}

function resolveMcpSettings({ mcp_preset }) {
  const presetName = mcp_preset || defaultMcpPresetForRole();

  if (presetName === "none") {
    const configPath = writePrivateMcpConfig({ mcpServers: {} }, { preset: "none" });
    return {
      preset: presetName,
      config: {
        mode: "strict_empty",
        path: configPath,
        selected_servers: [],
        missing_servers: [],
        rejected_servers: [],
        project_config_path: null,
      },
    };
  }

  return {
    preset: presetName,
    config: {
      mode: "project_default",
      path: null,
      selected_servers: null,
      missing_servers: [],
      rejected_servers: [],
      project_config_path: null,
    },
  };
}

function startupMcpSelectorVisible(session) {
  const recentOutput = stripAnsi(session.output_tail || "").slice(-12000);
  return STARTUP_MCP_SELECTOR_RE.test(recentOutput);
}

function resolveToolPermissions({ profile, allowed_tools, disallowed_tools }) {
  const baseAllowedTools = allowed_tools === null ? [] : allowed_tools || profile.allowedTools || profile.tools || [];
  const baseDisallowedTools = disallowed_tools === null ? [] : disallowed_tools || profile.disallowedTools || [];
  return { resolvedAllowedTools: baseAllowedTools, resolvedDisallowedTools: baseDisallowedTools };
}

function flagName(argument) {
  const value = String(argument);
  const equalsIndex = value.indexOf("=");
  return equalsIndex >= 0 ? value.slice(0, equalsIndex) : value;
}

function assertForwardedClaudeArgs(claudeArgs) {
  const args = claudeArgs || [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const flag = flagName(argument);
    if (FORBIDDEN_CLAUDE_ARG_FLAGS.has(flag)) {
      throw new Error(
        `Claude argument '${argument}' is not allowed; Codex–Claude Subagent requires an interactive subscription session.`,
      );
    }
    if (CONTROLLED_CLAUDE_ARG_FLAGS.has(flag)) {
      throw new Error(`Claude argument '${argument}' is controlled by a structured Codex–Claude Subagent field.`);
    }
    const forwarded = FORWARDED_CLAUDE_ARG_FLAGS.get(flag);
    if (!forwarded) {
      throw new Error(
        `Claude argument '${argument}' is not in the safe interactive allowlist; use a structured field or a supported interactive flag.`,
      );
    }
    if (argument.includes("=") && forwarded.values === 0) {
      throw new Error(`Claude argument '${argument}' does not accept a value.`);
    }
    if (argument.includes("=") || forwarded.values === 0) continue;
    if (forwarded.optional && flag !== "-d" && flag !== "--debug" && flag !== "--prompt-suggestions") {
      throw new Error(`Claude argument '${argument}' has an invalid arity.`);
    }
    const value = args[index + 1];
    if (forwarded.optional && (value === undefined || flagName(value) !== value || value.startsWith("-"))) continue;
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`Claude argument '${argument}' requires a value.`);
    }
    index += 1;
  }
}

function assertSafeOverrides(input) {
  const role = input.role || "reviewer";
  const profile = profileFor(role);
  assertForwardedClaudeArgs(input.claude_args);
  const nestedAgentOverride = [...(input.tools || []), ...(input.allowed_tools || [])].find((tool) =>
    NESTED_AGENT_TOOL_PATTERN.test(String(tool)),
  );
  if (nestedAgentOverride) {
    throw new Error(
      `Nested agent tool '${nestedAgentOverride}' is not allowed; Codex–Claude Subagent is a leaf subagent.`,
    );
  }

  if (READ_ONLY_ROLES.has(role)) {
    if (input.claude_worktree) {
      throw new Error(`claude_worktree is not allowed for read-only role '${role}'.`);
    }
    if (input.permission_mode && input.permission_mode !== profile.permissionMode) {
      throw new Error(`permission_mode '${input.permission_mode}' is not allowed for read-only role '${role}'.`);
    }
    const invalidBuiltInOverride = (input.tools || []).find((tool) => !READ_ONLY_BUILTIN_TOOLS.includes(tool));
    if (invalidBuiltInOverride) {
      throw new Error(`Tool '${invalidBuiltInOverride}' is not allowed for read-only role '${role}'.`);
    }
    const invalidPermissionOverride = (input.allowed_tools || []).find(
      (tool) => !READ_ONLY_ALLOWED_TOOLS.includes(tool),
    );
    if (invalidPermissionOverride) {
      throw new Error(`Tool permission '${invalidPermissionOverride}' is not allowed for read-only role '${role}'.`);
    }
    return;
  }

  if (IMPLEMENTATION_ROLES.has(role) && !input.claude_worktree) {
    throw new Error("claude_worktree is required for the implementer role so file changes stay isolated.");
  }
}

function stripAnsi(text) {
  return String(text || "").replace(
    // Strip common ANSI CSI/OSC/control sequences from terminal output.
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    "",
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyInteractiveWaiters(session) {
  for (const waiter of session.waiters) waiter.notify?.();
}

function writeProcessStdin(session, text) {
  return new Promise((resolve, reject) => {
    if (!session.process.stdin.writable || session.process.stdin.destroyed) {
      reject(new Error(`Interactive Claude session ${session.interactive_id} stdin is not writable.`));
      return;
    }
    session.process.stdin.write(String(text), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function submitDelayForPaste(text) {
  const lineCount = (String(text).match(/\n/g) || []).length;
  const sizeUnits = Math.ceil(Buffer.byteLength(String(text), "utf8") / 2000);
  return Math.min(
    SUBMIT_AFTER_PASTE_MAX_MS,
    SUBMIT_AFTER_PASTE_MS + lineCount * SUBMIT_AFTER_PASTE_LINE_MS + sizeUnits * 50,
  );
}

function buildPtyBridgeCommand(command, args, { cols = 120, rows = 40 } = {}) {
  if (process.platform === "win32") {
    throw new Error("Interactive Claude PTY sessions are not supported on Windows yet.");
  }
  return {
    command: "python3",
    args: [PTY_BRIDGE_PATH, "--cols", String(cols), "--rows", String(rows), "--", command, ...args],
  };
}

function buildInteractiveArgs(input, hookRuntime) {
  assertSafeOverrides(input);
  if (input.continue_latest) {
    throw new Error("continue_latest is disabled; resume an exact Codex–Claude Subagent session UUID instead.");
  }
  if (input.claude_session_id && input.resume_claude_session_id) {
    throw new Error("claude_session_id can only be used for new Claude Code sessions.");
  }
  const profile = profileFor(input.role);
  const args = [];
  const resumeMode = input.resume_claude_session_id ? "resume" : "new";
  const claudeSessionId =
    resumeMode === "new" ? input.claude_session_id || crypto.randomUUID() : input.resume_claude_session_id;
  const resolvedModel = input.model || null;
  const resolvedEffort = input.effort || null;
  const resolvedFallback = null;
  const resolvedTools = input.tools === null ? [] : input.tools || profile.tools;
  const mcpSettings = resolveMcpSettings({ mcp_preset: input.mcp_preset });
  const settingSources = mcpSettings.preset === "none" ? [] : ["user", "project", "local"];
  const { resolvedAllowedTools, resolvedDisallowedTools } = resolveToolPermissions({
    profile,
    allowed_tools: input.allowed_tools,
    disallowed_tools: input.disallowed_tools,
  });
  const resolvedPermissionMode = input.permission_mode || profile.permissionMode;

  if (input.name) args.push("--name", input.name);
  if (resumeMode === "resume") {
    args.push("--resume", input.resume_claude_session_id);
  } else {
    args.push("--session-id", claudeSessionId);
  }
  if (resolvedModel) args.push("--model", resolvedModel);
  if (resolvedEffort) args.push("--effort", resolvedEffort);
  if (resolvedPermissionMode) args.push("--permission-mode", resolvedPermissionMode);
  args.push("--setting-sources", settingSources.join(","));
  if (hookRuntime?.useSettings) args.push("--settings", hookRuntime.settingsPath);
  args.push("--append-system-prompt-file", hookRuntime.instructionContextPath);
  pushCsvArg(args, "--tools", resolvedTools, { allowEmpty: true });
  pushCsvArg(args, "--allowedTools", resolvedAllowedTools);
  pushCsvArg(args, "--disallowedTools", resolvedDisallowedTools);
  if (mcpSettings.config.path) args.push("--strict-mcp-config", "--mcp-config", mcpSettings.config.path);
  if (input.claude_worktree) args.push("--worktree", input.claude_worktree);
  if (input.claude_args?.length) args.push(...input.claude_args);

  return {
    args,
    resolved: {
      model: resolvedModel,
      effort: resolvedEffort,
      fallback: resolvedFallback,
      claude_session_id: claudeSessionId,
      resume_mode: resumeMode,
      settings_sources: settingSources,
      project_instruction_files: settingSources.includes("project") ? "claude_code_auto_discovery" : "disabled",
      hooks_configured: Boolean(hookRuntime.useSettings),
      tools: resolvedTools,
      allowed_tools: resolvedAllowedTools,
      disallowed_tools: resolvedDisallowedTools,
      mcp_preset: mcpSettings.preset,
      mcp_config: mcpSettings.config,
      permission_mode: resolvedPermissionMode,
      role: input.role || "reviewer",
      mode: profile.mode,
      purpose: profile.purpose,
      mutates_files: profile.mutatesFiles,
      requires_worktree: profile.requiresWorktree,
      filesystem_isolation: profile.filesystemIsolation,
      claude_worktree: input.claude_worktree || null,
      claude_args: input.claude_args || [],
      completion_transport: hookRuntime ? "claude_code_hooks_with_marker_fallback" : "completion_marker",
    },
  };
}

function createBoundedLogWriter(filePath) {
  let bytesWritten = 0;
  let truncated = false;
  let closed = false;
  const existing = fs.statSync(filePath, { throwIfNoEntry: false });
  if (existing) bytesWritten = existing.size;
  const fd = fs.openSync(filePath, "a", PRIVATE_FILE_MODE);

  const writeBuffer = (buffer) => {
    if (closed) return;
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error(`Could not append Codex–Claude Subagent log ${filePath}.`);
      offset += written;
    }
  };

  return {
    write(text) {
      if (bytesWritten >= MAX_LOG_BYTES) {
        if (!truncated) {
          const marker = "\n[codex-claude-subagent: log truncated]\n";
          writeBuffer(Buffer.from(marker));
          bytesWritten += Buffer.byteLength(marker);
          truncated = true;
        }
        return;
      }
      const buffer = Buffer.from(text);
      const remaining = MAX_LOG_BYTES - bytesWritten;
      const safe = safeUtf8Slice(buffer, remaining);
      const slice = buffer.subarray(safe.start, safe.end);
      writeBuffer(slice);
      bytesWritten += slice.byteLength;
      if (slice.byteLength < buffer.byteLength && !truncated) {
        const marker = "\n[codex-claude-subagent: log truncated]\n";
        writeBuffer(Buffer.from(marker));
        bytesWritten += Buffer.byteLength(marker);
        truncated = true;
      }
    },
    end() {
      if (closed) return;
      fs.closeSync(fd);
      closed = true;
    },
  };
}

function utf8SequenceLength(byte) {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

function safeUtf8Slice(buffer, maxBytes) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  if (start >= buffer.length) return { start, end: start };
  const available = buffer.length - start;
  let end = start + Math.min(maxBytes, available);
  while (end > start) {
    let lead = end - 1;
    while (lead > start && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
    const sequenceLength = utf8SequenceLength(buffer[lead]);
    if (lead + sequenceLength <= end) break;
    end = lead;
  }
  if (end === start) {
    const firstLength = utf8SequenceLength(buffer[start]);
    if (firstLength <= maxBytes && start + firstLength <= buffer.length) end = start + firstLength;
  }
  return { start, end };
}

function readInteractiveLog(session, { offset = 0, maxBytes = null, tailBytes = null, strip = true } = {}) {
  const logSizeBytes = fileSizeBytes(session.log_path);
  const effectiveWindowBytes = tailBytes === null ? null : Math.min(tailBytes, MAX_LOG_READ_BYTES, logSizeBytes);
  const requestedOffset =
    effectiveWindowBytes === null ? Math.min(offset, logSizeBytes) : Math.max(0, logSizeBytes - effectiveWindowBytes);
  const effectiveMaxBytes = Math.min(
    Math.max(maxBytes ?? effectiveWindowBytes ?? DEFAULT_LOG_READ_BYTES, 4),
    MAX_LOG_READ_BYTES,
  );
  const readableBytes = Math.max(0, Math.min(effectiveMaxBytes + 3, logSizeBytes - requestedOffset));
  let text = "";
  let startOffset = requestedOffset;
  let endOffset = requestedOffset;

  if (readableBytes > 0) {
    const fd = fs.openSync(session.log_path, "r");
    try {
      const buffer = Buffer.alloc(readableBytes);
      const probedBytes = fs.readSync(fd, buffer, 0, readableBytes, requestedOffset);
      const safe = safeUtf8Slice(buffer.subarray(0, probedBytes), effectiveMaxBytes);
      const slice = buffer.subarray(safe.start, safe.end);
      startOffset = requestedOffset + safe.start;
      endOffset = requestedOffset + safe.end;
      text = slice.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    interactive_id: session.interactive_id,
    status: session.status,
    cwd: session.cwd,
    log_path: session.log_path,
    log_size_bytes: logSizeBytes,
    log_may_be_capped: logSizeBytes >= MAX_LOG_BYTES,
    requested_offset: requestedOffset,
    start_offset: startOffset,
    end_offset: endOffset,
    next_offset: endOffset,
    eof: endOffset >= logSizeBytes,
    max_bytes: effectiveMaxBytes,
    text: strip ? stripAnsi(text) : text,
  };
}

function requestWaitPolicy(request, nowMs = Date.now()) {
  const startedMs = Date.parse(request?.created_at || "");
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
  const checkpointIndex = REQUEST_WAIT_SCHEDULE_MS.findIndex((checkpointMs) => checkpointMs > elapsedMs);
  if (checkpointIndex === -1) {
    return {
      elapsed_ms: elapsedMs,
      schedule_exhausted: true,
      long_running: true,
      next_checkpoint_index: null,
      next_checkpoint_elapsed_ms: null,
      next_checkpoint_minutes: null,
      next_timeout_ms: null,
    };
  }
  const checkpointMs = REQUEST_WAIT_SCHEDULE_MS[checkpointIndex];
  return {
    elapsed_ms: elapsedMs,
    schedule_exhausted: false,
    long_running: false,
    next_checkpoint_index: checkpointIndex,
    next_checkpoint_elapsed_ms: checkpointMs,
    next_checkpoint_minutes: checkpointMs % 60000 === 0 ? checkpointMs / 60000 : null,
    next_timeout_ms: Math.max(1, Math.min(MAX_WAIT_TIMEOUT_MS, checkpointMs - elapsedMs)),
  };
}

function effectiveRequestTimeoutMs(request, requestedTimeoutMs) {
  if (requestedTimeoutMs !== undefined && requestedTimeoutMs !== null) {
    return requestedTimeoutMs;
  }
  if (!requestIsPending(request)) return 1;
  const policy = requestWaitPolicy(request);
  if (policy.schedule_exhausted) {
    throw new Error(
      "Claude request reached the 90-minute wait schedule. Ask the user whether to continue, then pass an explicit timeout_ms or stop the session.",
    );
  }
  return policy.next_timeout_ms;
}

function compactRequest(request, { includePermissionAttention = false } = {}) {
  if (!request) return null;
  const pending = requestIsPending(request);
  const waitPolicy = pending ? requestWaitPolicy(request) : null;
  const waitRequired = pending && !waitPolicy.long_running;
  const compacted = {
    request_id: request.request_id,
    status: request.status,
    done: request.done,
    terminal_state: request.terminal_state,
    completion_transport: request.completion_transport,
    completion_marker: request.completion_marker,
    marker_seen: request.marker_seen,
    start_seq: request.start_seq,
    start_log_offset: request.start_log_offset,
    end_log_offset: request.end_log_offset,
    hook_start_offset: request.hook_start_offset,
    prompt_event_offset: request.prompt_event_offset,
    hook_correlation_token: request.hook_correlation_token,
    created_at: request.created_at,
    submitted_at: request.submitted_at,
    completed_at: request.completed_at,
    last_wait: request.last_wait,
    completion_event: request.completion_event,
    result_text: request.completion_event?.last_assistant_message || null,
    result_text_truncated: Boolean(request.completion_event?.last_assistant_message_truncated),
    last_notification: request.last_notification,
    pending,
    long_running: Boolean(pending && waitPolicy.long_running),
    wait_policy: waitPolicy,
    wait_required: waitRequired,
    next_action: waitRequired
      ? {
          tool: "claude_interactive_wait_request",
          request_id: request.request_id,
          idle_ms: null,
          timeout_ms: waitPolicy.next_timeout_ms,
          checkpoint_index: waitPolicy.next_checkpoint_index,
          checkpoint_elapsed_ms: waitPolicy.next_checkpoint_elapsed_ms,
          checkpoint_minutes: waitPolicy.next_checkpoint_minutes,
          repeat_until_terminal: true,
          terminal_statuses: ["completed", "failed", "interrupted"],
          instruction:
            "Call claude_interactive_wait_request again after every idle or timeout return. Do not resend the request text.",
        }
      : null,
    attention_required:
      pending && waitPolicy.long_running
        ? {
            reason: "wait_schedule_exhausted",
            action: "ask_user_to_continue_or_stop",
            elapsed_ms: waitPolicy.elapsed_ms,
            continue_tool: "claude_interactive_wait_request",
            continue_requires_explicit_timeout_ms: true,
            stop_tool: "claude_interactive_stop",
            instruction:
              "The request is still active after the 90-minute schedule. Ask the user whether to continue waiting or stop; do not resend the request text.",
          }
        : null,
  };
  if (includePermissionAttention) compacted.permission_attention = request.permission_attention || null;
  return compacted;
}

function requestIsPending(request) {
  return Boolean(request) && !request.done && !["failed", "interrupted"].includes(request.status);
}

function clearPermissionAttention(request) {
  if (!request?.permission_attention) return false;
  request.permission_attention_cleared_key = permissionAttentionKey(request.permission_attention);
  request.permission_attention = null;
  return true;
}

function permissionAttentionKey(event) {
  return JSON.stringify([
    event?.notification_type || null,
    event?.message || null,
    event?.error || null,
    event?.error_details || null,
  ]);
}

function finalizeRequest(
  session,
  request,
  { status, terminalState, markerSeen = request.marker_seen || false, event = null },
) {
  const now = new Date().toISOString();
  request.status = status;
  request.done = status === "completed";
  request.terminal_state = terminalState;
  request.marker_seen = markerSeen;
  request.completion_event = event;
  clearPermissionAttention(request);
  request.completion_transport =
    event?.hook_event_name === "Stop"
      ? "claude_code_stop_hook"
      : event?.hook_event_name === "StopFailure"
        ? "claude_code_stop_failure_hook"
        : markerSeen
          ? "completion_marker"
          : request.completion_transport;
  request.completed_at = now;
  request.end_log_offset = fileSizeBytes(session.log_path);
  session.last_request = request;
  if (session.active_request?.request_id === request.request_id) session.active_request = null;
  session.updated_at = now;
  persistInteractiveSession(session);
}

function refreshHookEvents(session) {
  if (!session.hook_event_path) return [];
  const size = fileSizeBytes(session.hook_event_path);
  const fileGeneration = readHookFileGeneration(session.hook_event_path);
  const previousOffset = session.hook_read_offset || 0;
  const generationChanged = Boolean(
    session.hook_file_generation && fileGeneration && session.hook_file_generation !== fileGeneration,
  );
  const rotated = size < previousOffset || generationChanged;
  if (fileGeneration) session.hook_file_generation = fileGeneration;
  const startOffset = rotated ? 0 : previousOffset;
  if (rotated && requestIsPending(session.active_request)) {
    session.active_request.hook_start_offset = 0;
    session.active_request.prompt_event_offset = session.active_request.submitted_at ? 0 : null;
  }
  if (size <= startOffset) return [];
  const fd = fs.openSync(session.hook_event_path, "r");
  let buffer;
  try {
    buffer = Buffer.alloc(Math.min(size - startOffset, MAX_HOOK_READ_BYTES));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, startOffset);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) return [];
  const complete = buffer.subarray(0, lastNewline + 1);
  const events = [];
  let eventOffset = startOffset;
  for (const line of complete.toString("utf8").split("\n")) {
    if (!line) continue;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      eventOffset += lineBytes;
      continue;
    }
    event.event_offset_start = eventOffset;
    event.event_offset_end = eventOffset + lineBytes;
    if (event[HOOK_FILE_GENERATION_FIELD] && !event.hook_event_name) {
      eventOffset += lineBytes;
      continue;
    }
    events.push(event);
    session.hook_events.push(event);
    if (session.hook_events.length > MAX_HOOK_EVENTS) {
      session.hook_events.splice(0, session.hook_events.length - MAX_HOOK_EVENTS);
    }
    session.last_hook_event = event;
    if (["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"].includes(event.hook_event_name)) {
      session.hooks_active = true;
    }
    let identityChanged = false;
    if (event.session_id && event.session_id !== session.claude_session_id) {
      session.claude_session_id = event.session_id;
      session.resolved.claude_session_id = event.session_id;
      identityChanged = true;
    }
    const request = session.active_request;
    if (request && event.event_offset_start >= request.hook_start_offset) {
      const eventAfterPrompt =
        request.prompt_event_offset !== null && event.event_offset_start >= request.prompt_event_offset;
      if (
        event.hook_event_name === "UserPromptSubmit" &&
        (event.prompt_request_token === request.hook_correlation_token ||
          (event.prompt_request_token === null &&
            (event.event_offset_start > request.hook_start_offset || request.hook_start_offset === 0)))
      ) {
        request.status = "working";
        request.submitted_at ||= event.at;
        request.prompt_event_offset = event.event_offset_end;
      } else if (event.hook_event_name === "Notification" && eventAfterPrompt) {
        request.last_notification = event;
        if (event.notification_type === "permission_prompt") {
          const attentionKey = permissionAttentionKey(event);
          const duplicateAttention =
            request.permission_attention && permissionAttentionKey(request.permission_attention) === attentionKey;
          const alreadyCleared = request.permission_attention_cleared_key === attentionKey;
          if (!duplicateAttention && !alreadyCleared) {
            request.permission_attention = { ...event, request_id: request.request_id };
          }
        }
      } else if (eventAfterPrompt && event.hook_event_name === "Stop") {
        finalizeRequest(session, request, {
          status: "completed",
          terminalState: "completed_with_stop_hook",
          event,
        });
      } else if (eventAfterPrompt && event.hook_event_name === "StopFailure") {
        finalizeRequest(session, request, {
          status: "failed",
          terminalState: `stop_failure:${event.error || "unknown"}`,
          event,
        });
      }
    }
    if (identityChanged) persistInteractiveSession(session);
    eventOffset += lineBytes;
  }
  session.hook_read_offset = startOffset + complete.length;
  return events;
}

function refreshHookEventsFromMonitor(session) {
  if (!session?.hook_event_path || !LIVE_SESSION_STATUSES.has(session.status)) return [];
  try {
    const events = refreshHookEvents(session);
    if (session.hook_monitor_error) {
      session.hook_monitor_error = null;
      persistInteractiveSession(session);
    }
    if (events.length) notifyInteractiveWaiters(session);
    return events;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (session.hook_monitor_error !== message) {
      session.hook_monitor_error = message;
      session.updated_at = new Date().toISOString();
      persistInteractiveSession(session);
    }
    return [];
  }
}

function stopHookMonitor(session) {
  session?.hook_watcher?.close();
  if (session?.hook_poll_timer) clearInterval(session.hook_poll_timer);
  if (session) {
    session.hook_watcher = null;
    session.hook_poll_timer = null;
  }
}

function startHookMonitor(session) {
  if (!session?.hook_event_path) return;
  stopHookMonitor(session);
  try {
    session.hook_watcher = fs.watch(session.hook_event_path, { persistent: false }, () =>
      refreshHookEventsFromMonitor(session),
    );
    session.hook_watcher.on("error", (error) => {
      session.hook_watcher?.close();
      session.hook_watcher = null;
      session.hook_monitor_error = error instanceof Error ? error.message : String(error);
    });
  } catch (error) {
    session.hook_monitor_error = error instanceof Error ? error.message : String(error);
  }
  session.hook_poll_timer = setInterval(() => refreshHookEventsFromMonitor(session), HOOK_MONITOR_POLL_MS);
  session.hook_poll_timer.unref();
  refreshHookEventsFromMonitor(session);
}

function signalChild(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall through to direct process signaling.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function waitForSessionExit(session, timeoutMs = STOP_GRACE_MS) {
  if (session.status !== "running" && session.status !== "stopping") return Promise.resolve(true);
  if (session.process.exitCode !== null || session.process.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      session.process.off("close", onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      cleanup();
      resolve(true);
    };
    session.process.once("close", onClose);
  });
}

async function stopInteractiveSession(session, { signal = "SIGTERM", waitMs = STOP_GRACE_MS } = {}) {
  let signaled = false;
  if (session.status === "running" || session.status === "stopping") {
    session.status = "stopping";
    session.updated_at = new Date().toISOString();
    signaled = signalChild(session.process, signal);
    persistInteractiveSession(session);
  }
  const exited = await waitForSessionExit(session, waitMs);
  return { signaled, exited };
}

function stopAllInteractiveSessions(signal = "SIGTERM") {
  for (const session of interactiveSessions.values()) {
    if (session.status === "running" || session.status === "stopping") {
      session.status = "stopping";
      session.updated_at = new Date().toISOString();
      signalChild(session.process, signal);
      persistInteractiveSession(session);
    }
  }
}

function pruneInteractiveSessions() {
  const exited = [...interactiveSessions.values()]
    .filter((session) => !["running", "stopping"].includes(session.status))
    .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")));
  for (const session of exited.slice(MAX_RECENT_INTERACTIVE_SESSIONS)) {
    interactiveSessions.delete(session.interactive_id);
  }
}

function compactInteractiveSession(
  session,
  { includeOutput = false, strip = true, sinceSeq = null, maxChars = MAX_TAIL_CHARS } = {},
) {
  if (!session) return null;
  const startedMs = Date.parse(session.started_at || "");
  const endedMs = Date.parse(session.ended_at || "");
  const lastOutputMs = Date.parse(session.last_output_at || session.started_at || "");
  const now = Date.now();
  const chunks = sinceSeq === null ? session.chunks : session.chunks.filter((chunk) => chunk.seq > sinceSeq);
  const visibleTail = strip ? stripAnsi(session.output_tail) : session.output_tail;
  const logSizeBytes = fileSizeBytes(session.log_path);
  const visibleChunks = chunks.map((chunk) => ({
    ...chunk,
    text: strip ? stripAnsi(chunk.text) : chunk.text,
  }));
  const base = {
    interactive_id: session.interactive_id,
    claude_session_id: session.claude_session_id,
    resume_mode: session.resume_mode,
    role: session.role,
    status: session.status,
    cwd: session.cwd,
    name: session.name,
    pid: session.pid,
    resolved: session.resolved,
    command: session.command,
    args_preview: session.args_preview,
    transport_command: session.transport_command,
    transport_args_preview: session.transport_args_preview,
    log_path: session.log_path,
    log_size_bytes: logSizeBytes,
    log_may_be_capped: logSizeBytes >= MAX_LOG_BYTES,
    started_at: session.started_at,
    last_output_at: session.last_output_at,
    updated_at: session.updated_at,
    ended_at: session.ended_at,
    runtime_ms: Number.isFinite(startedMs) ? (Number.isFinite(endedMs) ? endedMs : now) - startedMs : null,
    quiet_ms: Number.isFinite(lastOutputMs) && session.status === "running" ? now - lastOutputMs : null,
    exit_code: session.exit_code,
    signal: session.signal,
    error: session.error,
    ready_at: session.ready_at,
    ready_wait: session.ready_wait,
    hooks_active: session.hooks_active,
    last_hook_event: session.last_hook_event,
    hook_monitor: {
      watcher_active: Boolean(session.hook_watcher),
      polling_active: Boolean(session.hook_poll_timer),
      poll_ms: HOOK_MONITOR_POLL_MS,
      error: session.hook_monitor_error || null,
    },
    active_request: compactRequest(session.active_request),
    last_request: compactRequest(session.last_request),
    input_busy: session.input_busy,
    control_available: true,
    next_seq: session.next_seq,
  };
  if (includeOutput) {
    base.output_tail = safeStringSuffix(visibleTail, maxChars);
    base.chunks = tailChunksByChars(visibleChunks, maxChars);
  }
  return base;
}

function requireInteractiveSession(interactiveId, cwd) {
  const session = interactiveSessions.get(interactiveId);
  if (!session) throw new Error(`Unknown interactive Claude session: ${interactiveId}`);
  assertSessionCwd(session, cwd);
  return session;
}

async function requireInspectableSession(interactiveId, cwd) {
  const liveSession = interactiveSessions.get(interactiveId);
  if (liveSession) {
    assertSessionCwd(liveSession, cwd);
    return liveSession;
  }
  await loadSessionRegistry();
  const record = [...savedSessionRegistry.values()].find((candidate) => candidate.interactive_id === interactiveId);
  if (!record) throw new Error(`Unknown persisted Claude session: ${interactiveId}`);
  assertSessionCwd(record, cwd);
  return record;
}

function persistedSessionView(record, { includeOutput = false, maxChars = MAX_TAIL_CHARS } = {}) {
  const output = includeOutput
    ? readInteractiveLog(record, {
        tailBytes: Math.min(MAX_LOG_READ_BYTES, Math.max(4, maxChars * 4)),
        strip: true,
      }).text
    : "";
  const view = compactInteractiveSession(
    {
      ...record,
      pid: null,
      command: "claude",
      args_preview: [],
      transport_command: null,
      transport_args_preview: [],
      output_tail: output,
      chunks: [],
      next_seq: 0,
      input_busy: null,
    },
    { includeOutput, strip: true, maxChars },
  );
  view.control_available = false;
  view.owner_pid = record.owner_pid;
  view.owner_instance_id = record.owner_instance_id;
  return view;
}

function assertInteractiveInputAvailable(session) {
  if (requestIsPending(session.active_request)) {
    throw new Error(
      "Interactive Claude session " +
        session.interactive_id +
        " has pending request " +
        session.active_request.request_id +
        ". Use claude_interactive_wait_request before sending another input.",
    );
  }
}

function acquireInteractiveInputLease(session, operation) {
  if (session.input_busy) {
    throw new Error(
      `Interactive Claude session ${session.interactive_id} is already handling ${session.input_busy}; wait for it before sending another input.`,
    );
  }
  session.input_busy = operation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (session.input_busy === operation) session.input_busy = null;
  };
}

async function writeInteractiveInput(session, text, { submit = true, paste = true } = {}) {
  if (session.status !== "running") {
    throw new Error(`Interactive Claude session ${session.interactive_id} is not running.`);
  }
  const body = String(text || "");
  if (paste) {
    await writeProcessStdin(session, `\x1b[200~${body}\x1b[201~`);
    if (submit) await delay(submitDelayForPaste(body));
  } else {
    await writeProcessStdin(session, body);
  }
  if (submit) {
    const enterCount = paste ? SUBMIT_ENTER_COUNT : 1;
    for (let index = 0; index < enterCount; index += 1) {
      if (index > 0) await delay(SUBMIT_ENTER_GAP_MS);
      await writeProcessStdin(session, "\r");
    }
  }
  session.updated_at = new Date().toISOString();
}

async function confirmInteractiveSubmit(
  session,
  sinceSeq,
  { extraPattern = null, hookSinceOffset = 0, hookCorrelationToken = null } = {},
) {
  const submittedPatterns = [
    "Infusing",
    "Osmosing",
    "Envisioning",
    "Reading",
    "Searching",
    "thinking with",
    "⏺",
    "✢",
    "✳",
    "✶",
    "✻",
    "✽",
    extraPattern,
  ].filter(Boolean);
  const attempts = [];
  for (let attempt = 1; attempt <= SUBMIT_CONFIRM_ATTEMPTS; attempt += 1) {
    const wait = await waitForInteractive(session, {
      sinceSeq,
      untilTexts: submittedPatterns,
      untilHookEvents: ["UserPromptSubmit"],
      hookSinceOffset,
      hookCorrelationToken,
      timeoutMs: SUBMIT_CONFIRM_TIMEOUT_MS,
      strip: true,
    });
    attempts.push({ attempt, ...wait });
    if (wait.reason === "hook" || wait.reason === "pattern" || wait.reason === "exited") {
      return {
        reason: wait.reason === "hook" || wait.reason === "pattern" ? "submitted" : "exited",
        transport: wait.reason === "hook" ? "UserPromptSubmit" : "terminal",
        attempts,
      };
    }
    const text = interactiveTextSince(session, sinceSeq, { strip: true });
    if (!/Pasted text|Past ext|paste again/i.test(text)) {
      return { reason: wait.reason, attempts };
    }
    await writeProcessStdin(session, "\r");
  }
  return { reason: "unconfirmed", attempts };
}

async function ensureInteractiveReady(session) {
  if (session.ready_at) {
    return { reason: "already_ready", waited_ms: 0 };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wait = await waitForInteractive(session, {
      sinceSeq: 0,
      idleMs: STARTUP_READY_IDLE_MS,
      timeoutMs: STARTUP_READY_TIMEOUT_MS,
      strip: true,
      requireOutputForIdle: true,
    });
    session.ready_wait = wait;
    refreshHookEvents(session);
    if (wait.reason !== "idle" && wait.reason !== "pattern") {
      throw new Error(
        `Interactive Claude session ${session.interactive_id} did not become ready before first input: ${wait.reason}`,
      );
    }
    if (!startupMcpSelectorVisible(session)) {
      session.ready_at = new Date().toISOString();
      return wait;
    }

    if (attempt === 1) {
      throw new Error(
        `Interactive Claude session ${session.interactive_id} is waiting at the MCP selection screen. ` +
          "The startup selector was not dismissed; inspect the session before sending the review request.",
      );
    }

    // Claude Code shows this selector on first project startup. Confirm the
    // project's checked MCP servers without sending the review request text.
    await writeProcessStdin(session, session.resolved.mcp_preset === "none" ? "\u001b" : "\r");
    await delay(150);
  }
}

function interactiveTextSince(session, sinceSeq, { strip = true } = {}) {
  const chunks = session.chunks.filter((chunk) => chunk.seq > sinceSeq);
  const text = chunks.map((chunk) => chunk.text).join("");
  return strip ? stripAnsi(text) : text;
}

async function waitForInteractive(
  session,
  {
    sinceSeq = 0,
    untilPattern = null,
    untilTexts = null,
    untilHookEvents = null,
    wakeOnPermissionAttention = false,
    hookSinceOffset = 0,
    hookCorrelationToken = null,
    idleMs = null,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    strip = true,
    requireOutputForIdle = false,
    hookRequestId = null,
  } = {},
) {
  const started = Date.now();
  const matchTexts = [...(untilTexts || []), ...(untilPattern ? [String(untilPattern)] : [])];
  const waiter = {
    buffer: tailAppend("", interactiveTextSince(session, sinceSeq, { strip }), MAX_WAITER_BUFFER_CHARS),
    strip,
    notify: null,
  };
  session.waiters.add(waiter);
  let hookWatcher = null;

  try {
    try {
      if (session.hook_event_path) {
        hookWatcher = fs.watch(session.hook_event_path, { persistent: false }, () => waiter.notify?.());
        hookWatcher.on("error", () => {
          hookWatcher?.close();
          hookWatcher = null;
        });
      }
    } catch {
      // Hook polling below remains the fallback on filesystems without fs.watch support.
    }
    while (true) {
      const text = waiter.buffer;
      if (untilHookEvents?.length) {
        refreshHookEvents(session);
        if (
          hookRequestId &&
          session.last_request?.request_id === hookRequestId &&
          !requestIsPending(session.last_request) &&
          session.last_request.completion_event
        ) {
          return {
            reason: "hook",
            matched_hook: session.last_request.completion_event,
            waited_ms: Date.now() - started,
          };
        }
        const correlatedRequest =
          hookRequestId && session.active_request?.request_id === hookRequestId ? session.active_request : null;
        if (
          wakeOnPermissionAttention &&
          hookRequestId &&
          session.active_request?.request_id === hookRequestId &&
          session.active_request.permission_attention
        ) {
          return {
            reason: "hook",
            matched_hook: session.active_request.permission_attention,
            waited_ms: Date.now() - started,
          };
        }
        const matchedHook = session.hook_events.find((event) => {
          if (event.event_offset_start < hookSinceOffset) return false;
          if (!untilHookEvents.includes(event.hook_event_name)) return false;
          if (hookRequestId && Date.parse(event.at || "") < Date.parse(correlatedRequest?.created_at || ""))
            return false;
          if (
            hookRequestId &&
            (!correlatedRequest ||
              correlatedRequest.prompt_event_offset === null ||
              event.event_offset_start < correlatedRequest.prompt_event_offset)
          )
            return false;
          if (!hookCorrelationToken) return true;
          return (
            event.prompt_request_token === hookCorrelationToken ||
            (event.hook_event_name === "UserPromptSubmit" &&
              event.prompt_request_token === null &&
              (event.event_offset_start > hookSinceOffset || hookSinceOffset === 0))
          );
        });
        if (matchedHook) {
          return { reason: "hook", matched_hook: matchedHook, waited_ms: Date.now() - started };
        }
      }
      const matchedText = matchTexts.find((candidate) => text.includes(candidate));
      if (matchedText) {
        return { reason: "pattern", matched_pattern: matchedText, waited_ms: Date.now() - started };
      }
      if (session.status !== "running" && session.status !== "stopping") {
        return { reason: "exited", waited_ms: Date.now() - started };
      }
      if (idleMs !== null) {
        const lastOutputMs = Date.parse(session.last_output_at || "");
        const outputDuringWait = Number.isFinite(lastOutputMs) && lastOutputMs >= started;
        const hasRelevantOutput = Boolean(text) || outputDuringWait;
        if (!requireOutputForIdle || hasRelevantOutput) {
          const idleReferenceMs = outputDuringWait ? lastOutputMs : started;
          if (Date.now() - idleReferenceMs >= idleMs) {
            return {
              reason: hasRelevantOutput ? "idle" : "idle_no_output",
              waited_ms: Date.now() - started,
              had_output: hasRelevantOutput,
            };
          }
        }
      }
      if (Date.now() - started >= timeoutMs) {
        return { reason: "timeout", waited_ms: Date.now() - started };
      }
      const now = Date.now();
      const timeoutRemaining = Math.max(1, timeoutMs - (now - started));
      let wakeAfter = Math.min(100, timeoutRemaining);
      if (idleMs !== null) {
        const lastOutputMs = Date.parse(session.last_output_at || "");
        const outputDuringWait = Number.isFinite(lastOutputMs) && lastOutputMs >= started;
        const hasRelevantOutput = Boolean(text) || outputDuringWait;
        if (!requireOutputForIdle || hasRelevantOutput) {
          const idleReferenceMs = outputDuringWait ? lastOutputMs : started;
          wakeAfter = Math.min(wakeAfter, Math.max(1, idleMs - (now - idleReferenceMs)));
        }
      }
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (waiter.notify === finish) waiter.notify = null;
          // Timer and hook notification can race; `settled` above makes this resolve-once.
          // oxlint-disable-next-line promise/no-multiple-resolved
          resolve();
        };
        const timer = setTimeout(finish, wakeAfter);
        waiter.notify = finish;
      });
    }
  } finally {
    hookWatcher?.close();
    waiter.notify = null;
    session.waiters.delete(waiter);
  }
}

function beginInteractiveRequest(session, completionMarker) {
  if (requestIsPending(session.active_request)) {
    throw new Error(
      `Interactive Claude session ${session.interactive_id} already has pending request ${session.active_request.request_id}. ` +
        "Use claude_interactive_wait_request before starting another request.",
    );
  }
  const now = new Date().toISOString();
  const requestId = `clreq_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const request = {
    request_id: requestId,
    status: "submitting",
    done: false,
    terminal_state: "submitting",
    completion_transport: session.hooks_active ? "claude_code_hooks_with_marker_fallback" : "completion_marker",
    completion_marker: completionMarker,
    marker_seen: false,
    start_seq: session.next_seq - 1,
    start_log_offset: fileSizeBytes(session.log_path),
    end_log_offset: null,
    hook_start_offset: fileSizeBytes(session.hook_event_path),
    prompt_event_offset: null,
    hook_correlation_token: `CODEX_CLAUDE_SUBAGENT_REQUEST_${requestId}`,
    created_at: now,
    submitted_at: null,
    completed_at: null,
    last_wait: null,
    completion_event: null,
    last_notification: null,
    permission_attention: null,
    permission_attention_cleared_key: null,
  };
  session.active_request = request;
  session.updated_at = now;
  persistInteractiveSession(session);
  return request;
}

async function waitForRequestCompletion(session, request, { idleMs, timeoutMs, strip }) {
  if (!requestIsPending(request)) {
    const wait = request.completion_event
      ? { reason: "hook", matched_hook: request.completion_event, waited_ms: 0 }
      : { reason: "already_terminal", waited_ms: 0 };
    request.last_wait = wait;
    request.end_log_offset ||= fileSizeBytes(session.log_path);
    persistInteractiveSession(session);
    return wait;
  }
  let wait = await waitForInteractive(session, {
    sinceSeq: request.start_seq,
    untilTexts: [request.completion_marker],
    untilHookEvents: ["Stop", "StopFailure"],
    wakeOnPermissionAttention: true,
    hookSinceOffset: request.hook_start_offset,
    hookRequestId: request.request_id,
    idleMs,
    timeoutMs,
    strip,
  });
  if (!requestIsPending(request)) {
    request.last_wait = wait;
    request.end_log_offset = fileSizeBytes(session.log_path);
    persistInteractiveSession(session);
    return wait;
  }
  if (wait.reason === "pattern") {
    request.marker_seen = true;
    if (session.hooks_active) {
      const hookGrace = await waitForInteractive(session, {
        sinceSeq: request.start_seq,
        untilHookEvents: ["Stop", "StopFailure"],
        hookSinceOffset: request.hook_start_offset,
        hookRequestId: request.request_id,
        timeoutMs: HOOK_COMPLETION_GRACE_MS,
        strip,
      });
      if (!requestIsPending(request)) {
        wait = { ...hookGrace, marker_seen_before_hook: true };
        request.last_wait = wait;
        request.end_log_offset = fileSizeBytes(session.log_path);
        persistInteractiveSession(session);
        return wait;
      }
      wait = { ...wait, hook_grace: hookGrace };
    }
    finalizeRequest(session, request, {
      status: "completed",
      terminalState: "completed_with_marker",
      markerSeen: true,
    });
  } else if (wait.reason === "exited") {
    finalizeRequest(session, request, {
      status: "interrupted",
      terminalState: "process_exited",
    });
  } else {
    request.status = request.submitted_at ? "working" : "waiting";
    request.terminal_state =
      wait.reason === "idle"
        ? "idle_without_completion"
        : wait.reason === "idle_no_output"
          ? "idle_without_output"
          : wait.reason;
    persistInteractiveSession(session);
  }
  request.last_wait = wait;
  request.end_log_offset = fileSizeBytes(session.log_path);
  persistInteractiveSession(session);
  return wait;
}

function buildClaudeEnvironment() {
  const env = {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
  };
  delete env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB;
  const scrubbedNames = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
  ]);
  for (const name of Object.keys(env)) {
    if (scrubbedNames.has(name.toUpperCase())) delete env[name];
  }
  return env;
}

async function startInteractiveClaude(rawInput) {
  const input = { ...rawInput, cwd: requireAbsoluteExistingDirectory(rawInput.cwd) };
  assertSafeOverrides(input);
  if (input.continue_latest) {
    throw new Error("continue_latest is disabled; resume an exact Codex–Claude Subagent session UUID instead.");
  }
  if (input.resume_claude_session_id) {
    await requireSavedResumeRecord(input.resume_claude_session_id, input.cwd, input.role);
  }
  const claudeInfo = await claudeAuthPreflight.detectClaude();
  if (!claudeInfo.available) throw new Error(`Claude Code is unavailable: ${claudeInfo.error || "unknown error"}`);
  const requiredCapabilities = [
    "settings",
    "setting_sources",
    "append_system_prompt_file",
    "allowed_tools",
    input.resume_claude_session_id ? "resume" : "session_id",
  ];
  if (input.mcp_preset === "none") {
    requiredCapabilities.push("mcp_config", "strict_mcp_config");
  }
  if ((input.role || "reviewer") === "implementer") {
    requiredCapabilities.push("worktree");
  }
  for (const capability of requiredCapabilities) {
    if (!claudeInfo.capabilities[capability]) {
      throw new Error(
        `Installed Claude Code does not support --${capability.replaceAll("_", "-")}; update Claude Code before starting a session.`,
      );
    }
  }
  const claudeAuth = await claudeAuthPreflight.detectClaudeAuth(input.cwd);
  if (!claudeAuth.ready) throw new Error(claudeAuthPreflight.formatPreflightError(claudeAuth));
  const interactiveId = uniqueInteractiveId();
  const logPath = path.join(INTERACTIVE_LOG_DIR, `${interactiveId}.log`);
  const hookRuntime = createHookRuntime(interactiveId, input.role || "reviewer");
  hookRuntime.useSettings = true;
  const { args, resolved } = buildInteractiveArgs(input, hookRuntime);
  resolved.auth = claudeAuthPreflight.compactClaudeAuth(claudeAuth);
  const startedAt = new Date().toISOString();
  await reserveSessionLease({
    interactive_id: interactiveId,
    claude_session_id: resolved.claude_session_id,
    resume_mode: resolved.resume_mode,
    role: input.role,
    status: "starting",
    cwd: input.cwd,
    name: input.name || null,
    resolved,
    log_path: logPath,
    started_at: startedAt,
    updated_at: startedAt,
    owner_instance_id: INSTANCE_ID,
    owner_pid: process.pid,
    owner_started_at: INSTANCE_STARTED_AT,
    hook_event_path: hookRuntime.eventPath,
    hook_settings_path: hookRuntime.settingsPath,
    instruction_context_path: hookRuntime.instructionContextPath,
  });
  const env = buildClaudeEnvironment();
  const cols = input.cols || 120;
  const rows = input.rows || 40;
  const ptyCommand = buildPtyBridgeCommand("claude", args, { cols, rows });
  const child = spawn(ptyCommand.command, ptyCommand.args, {
    cwd: input.cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const logStream = createBoundedLogWriter(logPath);
  const session = {
    interactive_id: interactiveId,
    claude_session_id: resolved.claude_session_id,
    resume_mode: resolved.resume_mode,
    role: input.role,
    status: "running",
    cwd: input.cwd,
    name: input.name || null,
    pid: child.pid,
    resolved,
    command: "claude",
    args_preview: args,
    transport_command: ptyCommand.command,
    transport_args_preview: ptyCommand.args,
    log_path: logPath,
    process: child,
    logStream,
    output_tail: "",
    chunks: [],
    waiters: new Set(),
    next_seq: 1,
    started_at: startedAt,
    last_output_at: startedAt,
    updated_at: startedAt,
    ended_at: null,
    exit_code: null,
    signal: null,
    error: null,
    ready_at: null,
    ready_wait: null,
    hook_event_path: hookRuntime?.eventPath || null,
    hook_file_generation: hookRuntime?.hookFileGeneration || null,
    hook_settings_path: hookRuntime?.settingsPath || null,
    instruction_context_path: hookRuntime?.instructionContextPath || null,
    hook_read_offset: 0,
    hook_events: [],
    hooks_active: false,
    last_hook_event: null,
    hook_watcher: null,
    hook_poll_timer: null,
    hook_monitor_error: null,
    active_request: null,
    last_request: null,
    input_busy: null,
  };
  interactiveSessions.set(interactiveId, session);
  persistInteractiveSession(session);

  const handleOutput = (text) => {
    if (!text) return;
    const now = new Date().toISOString();
    session.output_tail = tailAppend(session.output_tail, text);
    session.logStream.write(text);
    for (const waiter of session.waiters) {
      waiter.buffer = tailAppend(waiter.buffer, waiter.strip ? stripAnsi(text) : text, MAX_WAITER_BUFFER_CHARS);
    }
    session.chunks.push({ seq: session.next_seq, at: now, text });
    session.next_seq += 1;
    if (session.chunks.length > MAX_INTERACTIVE_CHUNKS) {
      session.chunks.splice(0, session.chunks.length - MAX_INTERACTIVE_CHUNKS);
    }
    session.last_output_at = now;
    session.updated_at = now;
    notifyInteractiveWaiters(session);
  };

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  child.stdout.on("data", (chunk) => handleOutput(stdoutDecoder.write(chunk)));
  child.stderr.on("data", (chunk) => handleOutput(stderrDecoder.write(chunk)));
  child.stdout.on("end", () => handleOutput(stdoutDecoder.end()));
  child.stderr.on("end", () => handleOutput(stderrDecoder.end()));
  child.on("error", (error) => {
    refreshHookEventsFromMonitor(session);
    stopHookMonitor(session);
    const now = new Date().toISOString();
    session.status = "failed";
    session.error = error.message;
    if (requestIsPending(session.active_request)) {
      finalizeRequest(session, session.active_request, {
        status: "failed",
        terminalState: "process_error",
      });
    }
    session.ended_at = now;
    session.updated_at = now;
    session.logStream.end();
    persistInteractiveSession(session);
  });
  child.on("close", (code, signal) => {
    refreshHookEventsFromMonitor(session);
    stopHookMonitor(session);
    const now = new Date().toISOString();
    session.status = session.status === "failed" ? "failed" : "exited";
    session.exit_code = code;
    session.signal = signal;
    if (requestIsPending(session.active_request)) {
      finalizeRequest(session, session.active_request, {
        status: "interrupted",
        terminalState: "process_exited",
      });
    }
    session.ended_at = now;
    session.updated_at = now;
    session.logStream.end();
    persistInteractiveSession(session);
    pruneInteractiveSessions();
  });

  startHookMonitor(session);
  return compactInteractiveSession(session, { includeOutput: true, strip: true });
}

const roleEnum = z.enum(["explorer", "reviewer", "security_reviewer", "critic", "architect", "implementer"]);

const effortSchema = z.string().min(1);
const permissionModeEnum = z.enum(["dontAsk", "plan"]);
const mcpPresetEnum = z.enum(["auto", "none", "serena", "context7", "serena_context7"]);

const interactiveSessionInput = {
  cwd: z.string().describe("Absolute path to the target project or worktree."),
  role: roleEnum
    .default("reviewer")
    .describe(
      "Role contract: explorer/reviewer/security_reviewer/critic/architect are read-only; implementer is instructed to work in a required dedicated claude_worktree. This is a Git worktree boundary, not OS-level filesystem confinement. Model and effort defaults remain with Claude Code unless explicitly provided.",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Claude model alias or full model ID. Passed through unchanged; when omitted, Claude Code selects the model using its own defaults.",
    ),
  effort: effortSchema
    .optional()
    .describe(
      "Optional Claude Code effort value. Passed through unchanged; when omitted, Claude Code uses its own default.",
    ),
  claude_args: z
    .array(z.string())
    .optional()
    .describe(
      "Additional allowlisted Claude Code interactive flags and values. Inspect codex_claude_subagent_info.policy.forwarded_claude_arg_flags; all other flags, including non-interactive, background, remote-control, nested-agent, and structured-session flags, are rejected.",
    ),
  tools: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Built-in Claude tools to expose. null means no built-in tools."),
  allowed_tools: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Claude Code tool permissions to allow, passed as --allowedTools."),
  disallowed_tools: z.array(z.string()).nullable().optional().describe("Optional Claude Code tool deny list."),
  mcp_preset: mcpPresetEnum
    .optional()
    .describe(
      "MCP behavior. auto uses normal project discovery; none uses a strict empty config. Named legacy presets also use project discovery.",
    ),
  permission_mode: permissionModeEnum.optional().describe("Claude Code permission mode."),
  name: z.string().optional().describe("Human-readable Claude session name."),
  claude_session_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Claude Code session UUID for a new session. If omitted, Codex–Claude Subagent generates one and passes --session-id.",
    ),
  resume_claude_session_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Resume an exact Codex–Claude Subagent session UUID previously saved for this cwd and role. Pass explicit model and effort values to change models while preserving the Claude conversation.",
    ),
  continue_latest: z.boolean().default(false).describe("Deprecated and rejected. Resume an exact saved UUID instead."),
  claude_worktree: z
    .string()
    .optional()
    .describe(
      "Required for role=implementer; forbidden for read-only roles. Claude Code --worktree name for isolation.",
    ),
  cols: z.number().int().min(40).max(300).default(120).describe("PTY columns."),
  rows: z.number().int().min(10).max(100).default(40).describe("PTY rows."),
};

const server = new McpServer({
  name: "codex-claude-subagent",
  version: VERSION,
});

server.registerTool(
  "claude_interactive_start",
  {
    title: "Start Interactive Claude Code",
    description:
      "Start an interactive Claude Code subagent. Read-only roles (explorer, reviewer, security_reviewer, critic, architect) investigate and report without edits; implementer is instructed to edit and test in the required claude_worktree, which is a Git worktree boundary rather than OS-level filesystem confinement. Preflights Claude subscription authentication and supports exact saved UUID resume.",
    inputSchema: interactiveSessionInput,
  },
  async (input) => textResult(await startInteractiveClaude(input)),
);

server.registerTool(
  "claude_interactive_send",
  {
    title: "Send To Interactive Claude Code",
    description: "Paste text into a live interactive Claude Code PTY session, optionally submitting it.",
    inputSchema: {
      cwd: z.string().describe("Absolute path to the same target project or worktree."),
      interactive_id: z.string().min(1).describe("Interactive session id from claude_interactive_start."),
      text: z.string().describe("Text to send to Claude Code."),
      submit: z.boolean().default(true).describe("Whether to press Enter after sending text."),
      paste: z.boolean().default(true).describe("Use bracketed paste for safer multi-line input."),
    },
  },
  async ({ cwd, interactive_id, text, submit, paste }) => {
    const session = requireInteractiveSession(interactive_id, cwd);
    const releaseInput = acquireInteractiveInputLease(session, "claude_interactive_send");
    try {
      assertInteractiveInputAvailable(session);
      await ensureInteractiveReady(session);
      refreshHookEvents(session);
      const sinceSeq = session.next_seq - 1;
      const hookStartOffset = fileSizeBytes(session.hook_event_path);
      await writeInteractiveInput(session, text, { submit, paste });
      const submitConfirm = submit
        ? await confirmInteractiveSubmit(session, sinceSeq, { hookSinceOffset: hookStartOffset })
        : null;
      return textResult({
        ...compactInteractiveSession(session, { includeOutput: true, strip: true, sinceSeq }),
        submit: submitConfirm,
      });
    } finally {
      releaseInput();
    }
  },
);

server.registerTool(
  "claude_interactive_request",
  {
    title: "Request Interactive Claude Code",
    description:
      "Submit one correlated Claude Code turn and wait for its Stop/StopFailure hook, with a completion-marker fallback. Idle and timeout returns remain resumable by request id.",
    inputSchema: {
      cwd: z.string().describe("Absolute path to the same target project or worktree."),
      interactive_id: z.string().min(1).describe("Interactive session id from claude_interactive_start."),
      text: z.string().describe("Request text to send to Claude Code."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_WAIT_TIMEOUT_MS)
        .optional()
        .describe(
          "Optional wait override. When omitted, wait until the next cumulative request checkpoint: 5, 10, 15, 20, 25, 30, 45, 60, or 90 minutes.",
        ),
      idle_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_REQUEST_IDLE_MS)
        .nullable()
        .default(DEFAULT_REQUEST_IDLE_MS)
        .describe(
          "Return after output has been quiet for this long while keeping the request pending. null disables idle fallback.",
        ),
      strip_ansi: z.boolean().default(true).describe("Strip ANSI terminal escape sequences from returned output."),
    },
  },
  async ({ cwd, interactive_id, text, timeout_ms, idle_ms, strip_ansi }) => {
    const session = requireInteractiveSession(interactive_id, cwd);
    const releaseInput = acquireInteractiveInputLease(session, "claude_interactive_request");
    let activeRequest = null;
    try {
      assertInteractiveInputAvailable(session);
      const ready = await ensureInteractiveReady(session);
      refreshHookEvents(session);
      const markerPrefix = "CODEX_CLAUDE_SUBAGENT_DONE_";
      const markerSuffix = crypto.randomUUID().replace(/-/g, "_");
      const marker = `${markerPrefix}${markerSuffix}`;
      activeRequest = beginInteractiveRequest(session, marker);
      const effectiveTimeoutMs = effectiveRequestTimeoutMs(activeRequest, timeout_ms);
      const requestText = `${instructionBoundaryForRole(session.role)}

User request:
${text}`;
      const request = `Codex–Claude Subagent correlation token: ${activeRequest.hook_correlation_token}

${requestText}

Completion protocol:
- When, and only when, this request is complete, print one final line made by joining these two fragments with no spaces:
  1. ${markerPrefix}
  2. ${markerSuffix}
- Do not print that joined line before the work is complete.`;
      let submit;
      let wait;
      await writeInteractiveInput(session, request, { submit: true, paste: true });
      submit = await confirmInteractiveSubmit(session, activeRequest.start_seq, {
        extraPattern: marker,
        hookSinceOffset: activeRequest.hook_start_offset,
        hookCorrelationToken: activeRequest.hook_correlation_token,
      });
      if (submit.reason === "submitted" && requestIsPending(activeRequest)) {
        activeRequest.status = "working";
        activeRequest.submitted_at ||= new Date().toISOString();
      }
      wait = await waitForRequestCompletion(session, activeRequest, {
        idleMs: idle_ms,
        timeoutMs: effectiveTimeoutMs,
        strip: strip_ansi,
      });
      const requestState = compactRequest(activeRequest, { includePermissionAttention: true });
      return textResult({
        ...compactInteractiveSession(session, {
          includeOutput: true,
          strip: strip_ansi,
          sinceSeq: activeRequest.start_seq,
        }),
        request: {
          ...requestState,
          ready,
          submit,
          idle_ms,
          timeout_ms: effectiveTimeoutMs,
          wait,
        },
      });
    } catch (error) {
      if (activeRequest && requestIsPending(activeRequest)) {
        finalizeRequest(session, activeRequest, {
          status: "failed",
          terminalState: "request_error",
        });
      }
      throw error;
    } finally {
      releaseInput();
    }
  },
);

server.registerTool(
  "claude_interactive_wait_request",
  {
    title: "Wait For Interactive Claude Code Request",
    description:
      "Continue waiting for a previously submitted Claude Code request by request id. Use after an idle or timeout return instead of sending a second request.",
    inputSchema: {
      cwd: z.string().describe("Absolute path to the same target project or worktree."),
      interactive_id: z.string().min(1).describe("Interactive session id from claude_interactive_start."),
      request_id: z.string().min(1).describe("Request id returned by claude_interactive_request."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_WAIT_TIMEOUT_MS)
        .optional()
        .describe("Optional wait override. When omitted, wait only until the next cumulative request checkpoint."),
      idle_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_REQUEST_IDLE_MS)
        .nullable()
        .default(null)
        .describe(
          "Optional additional idle return. Defaults to null so a resumed wait stays attached until completion or hard timeout.",
        ),
      retry_submit: z
        .boolean()
        .default(false)
        .describe(
          "Press Enter once more before waiting when submission was not confirmed. This never resends the request text.",
        ),
      strip_ansi: z.boolean().default(true).describe("Strip ANSI terminal escape sequences from returned output."),
    },
  },
  async ({ cwd, interactive_id, request_id, timeout_ms, idle_ms, retry_submit, strip_ansi }) => {
    const session = requireInteractiveSession(interactive_id, cwd);
    const request =
      session.active_request?.request_id === request_id
        ? session.active_request
        : session.last_request?.request_id === request_id
          ? session.last_request
          : null;
    if (!request) throw new Error(`Unknown request ${request_id} for interactive Claude session ${interactive_id}.`);
    refreshHookEvents(session);
    const effectiveTimeoutMs = effectiveRequestTimeoutMs(request, timeout_ms);
    if (requestIsPending(request) && clearPermissionAttention(request)) persistInteractiveSession(session);
    let retrySubmit = null;
    if (retry_submit && requestIsPending(request) && !request.submitted_at) {
      const releaseInput = acquireInteractiveInputLease(session, "claude_interactive_wait_request.retry_submit");
      try {
        const sinceSeq = session.next_seq - 1;
        await writeProcessStdin(session, "\r");
        retrySubmit = await confirmInteractiveSubmit(session, sinceSeq, {
          extraPattern: request.completion_marker,
          hookSinceOffset: request.hook_start_offset,
          hookCorrelationToken: request.hook_correlation_token,
        });
        if (retrySubmit.reason === "submitted" && requestIsPending(request)) {
          request.status = "working";
          request.submitted_at ||= new Date().toISOString();
        }
      } finally {
        releaseInput();
      }
    }
    const wait = await waitForRequestCompletion(session, request, {
      idleMs: idle_ms,
      timeoutMs: effectiveTimeoutMs,
      strip: strip_ansi,
    });
    return textResult({
      ...compactInteractiveSession(session, {
        includeOutput: true,
        strip: strip_ansi,
        sinceSeq: request.start_seq,
      }),
      request: {
        ...compactRequest(request, { includePermissionAttention: true }),
        idle_ms,
        timeout_ms: effectiveTimeoutMs,
        retry_submit: retrySubmit,
        wait,
      },
    });
  },
);

server.registerTool(
  "claude_interactive_wait",
  {
    title: "Wait For Interactive Claude Code",
    description:
      "Wait for new interactive Claude Code output, a pattern, idle period, exit, or timeout. This avoids fixed polling sleeps from Codex.",
    inputSchema: {
      cwd: z.string().describe("Absolute path to the same target project or worktree."),
      interactive_id: z.string().min(1).describe("Interactive session id from claude_interactive_start."),
      since_seq: z.number().int().nonnegative().default(0).describe("Watch output chunks after this sequence number."),
      until_pattern: z
        .string()
        .max(10000)
        .optional()
        .describe("Optional literal text to wait for in output. The legacy field name is retained for compatibility."),
      idle_ms: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("Return after output has been quiet for this many milliseconds."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_WAIT_TIMEOUT_MS)
        .default(DEFAULT_WAIT_TIMEOUT_MS)
        .describe("Maximum wait time."),
      strip_ansi: z
        .boolean()
        .default(true)
        .describe("Strip ANSI terminal escape sequences before matching and returning output."),
    },
  },
  async ({ cwd, interactive_id, since_seq, until_pattern, idle_ms, timeout_ms, strip_ansi }) => {
    const session = requireInteractiveSession(interactive_id, cwd);
    const wait = await waitForInteractive(session, {
      sinceSeq: since_seq,
      untilPattern: until_pattern || null,
      idleMs: idle_ms ?? null,
      timeoutMs: timeout_ms,
      strip: strip_ansi,
    });
    return textResult({
      ...compactInteractiveSession(session, {
        includeOutput: true,
        strip: strip_ansi,
        sinceSeq: since_seq,
      }),
      wait,
    });
  },
);

server.registerTool(
  "claude_interactive_read",
  {
    title: "Read Interactive Claude Code",
    description: "Read recent output from an interactive Claude Code PTY session.",
    inputSchema: {
      cwd: z.string().describe("Absolute path to the same target project or worktree."),
      interactive_id: z.string().min(1).describe("Interactive session id from claude_interactive_start."),
      since_seq: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional()
        .describe("Return chunks after this sequence number."),
      max_chars: z
        .number()
        .int()
        .positive()
        .max(100000)
        .default(MAX_TAIL_CHARS)
        .describe("Maximum output_tail characters."),
      strip_ansi: z.boolean().default(true).describe("Strip ANSI terminal escape sequences from returned output."),
    },
  },
  async ({ cwd, interactive_id, since_seq, max_chars, strip_ansi }) => {
    const session = await requireInspectableSession(interactive_id, cwd);
    if (interactiveSessions.has(interactive_id)) {
      refreshHookEvents(session);
      return textResult(
        compactInteractiveSession(session, {
          includeOutput: true,
          strip: strip_ansi,
          sinceSeq: since_seq ?? null,
          maxChars: max_chars,
        }),
      );
    }
    const view = persistedSessionView(session, { includeOutput: true, maxChars: max_chars });
    if (!strip_ansi) {
      view.output_tail = readInteractiveLog(session, {
        tailBytes: Math.min(MAX_LOG_READ_BYTES, Math.max(4, max_chars * 4)),
        strip: false,
      }).text;
    }
    view.read_only_snapshot = true;
    return textResult(view);
  },
);

server.registerTool(
  "claude_interactive_read_log",
  {
    title: "Read Interactive Claude Code Log",
    description:
      "Read persisted interactive Claude Code terminal output by byte offset or tail window. Use this to recover long responses that do not fit in output_tail.",
    inputSchema: {
      cwd: z.string().describe("Absolute path to the same target project or worktree."),
      interactive_id: z.string().min(1).describe("Interactive session id from claude_interactive_start."),
      offset: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe("Byte offset in the persisted terminal log. Ignored when tail_bytes is set."),
      max_bytes: z
        .number()
        .int()
        .min(4)
        .max(MAX_LOG_READ_BYTES)
        .optional()
        .describe("Maximum bytes to read in this page."),
      tail_bytes: z
        .number()
        .int()
        .min(4)
        .max(MAX_LOG_READ_BYTES)
        .optional()
        .describe("Read from the last N bytes of the persisted terminal log."),
      strip_ansi: z.boolean().default(true).describe("Strip ANSI terminal escape sequences from returned text."),
    },
  },
  async ({ cwd, interactive_id, offset, max_bytes, tail_bytes, strip_ansi }) => {
    const session = await requireInspectableSession(interactive_id, cwd);
    return textResult(
      readInteractiveLog(session, {
        offset,
        maxBytes: max_bytes ?? null,
        tailBytes: tail_bytes ?? null,
        strip: strip_ansi,
      }),
    );
  },
);

server.registerTool(
  "claude_interactive_list",
  {
    title: "List Interactive Claude Code Sessions",
    description: "List live or recently exited interactive Claude Code PTY sessions in this MCP server process.",
    inputSchema: {
      cwd: z.string().describe("Absolute project/worktree cwd. Global cross-project listing is not supported."),
      include_output: z.boolean().default(false),
    },
  },
  async ({ cwd, include_output }) => {
    const canonicalCwd = requireAbsoluteExistingDirectory(cwd);
    await loadSessionRegistry();
    const sessionsById = new Map(
      [...savedSessionRegistry.values()]
        .filter((session) => session.cwd === canonicalCwd)
        .map((session) => [session.interactive_id, session]),
    );
    for (const session of interactiveSessions.values()) {
      if (session.cwd === canonicalCwd) sessionsById.set(session.interactive_id, session);
    }
    const sessions = [...sessionsById.values()].map((session) => {
      if (interactiveSessions.has(session.interactive_id)) {
        refreshHookEvents(session);
        return compactInteractiveSession(session, { includeOutput: include_output, strip: true });
      }
      return persistedSessionView(session, { includeOutput: include_output });
    });
    return textResult({ sessions });
  },
);

server.registerTool(
  "claude_interactive_saved_sessions",
  {
    title: "List Saved Claude Code Sessions",
    description:
      "List persisted Codex–Claude Subagent session records, including Claude Code session IDs that can be resumed with claude_interactive_start.resume_claude_session_id.",
    inputSchema: {
      cwd: z.string().describe("Absolute project/worktree cwd. Global cross-project listing is not supported."),
      limit: z.number().int().positive().max(200).default(50).describe("Maximum saved session records to return."),
    },
  },
  async ({ cwd, limit }) => {
    const canonicalCwd = requireAbsoluteExistingDirectory(cwd);
    await loadSessionRegistry();
    const sessions = [...savedSessionRegistry.values()]
      .filter((session) => session.cwd === canonicalCwd)
      .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
      .slice(0, limit);
    return textResult({ sessions });
  },
);

server.registerTool(
  "claude_interactive_stop",
  {
    title: "Stop Interactive Claude Code",
    description: "Terminate an interactive Claude Code PTY session.",
    inputSchema: {
      cwd: z.string().describe("Absolute path to the same target project or worktree."),
      interactive_id: z.string().min(1).describe("Interactive session id from claude_interactive_start."),
      signal: z
        .enum(["SIGTERM", "SIGINT", "SIGHUP"])
        .default("SIGTERM")
        .describe("Signal to send. Defaults to SIGTERM."),
      wait_ms: z
        .number()
        .int()
        .positive()
        .max(30000)
        .default(STOP_GRACE_MS)
        .describe("How long to wait for the bridge and Claude child to exit."),
    },
  },
  async ({ cwd, interactive_id, signal, wait_ms }) => {
    const session = requireInteractiveSession(interactive_id, cwd);
    refreshHookEvents(session);
    const stop = await stopInteractiveSession(session, { signal, waitMs: wait_ms });
    return textResult({
      ...compactInteractiveSession(session, { includeOutput: true, strip: true }),
      stop,
    });
  },
);

server.registerTool(
  "codex_claude_subagent_info",
  {
    title: "Codex–Claude Subagent Info",
    description:
      "Show local Codex–Claude Subagent configuration, subscription-auth readiness, role profiles, state paths, and interactive sessions.",
    inputSchema: {},
  },
  async () => {
    const claude = await claudeAuthPreflight.detectClaude();
    return textResult({
      version: VERSION,
      state_dir: STATE_DIR,
      interactive_log_dir: INTERACTIVE_LOG_DIR,
      mcp_config_dir: MCP_CONFIG_DIR,
      max_mcp_config_files: MAX_MCP_CONFIG_FILES,
      hook_event_dir: HOOK_EVENT_DIR,
      max_hook_file_bytes: MAX_HOOK_FILE_BYTES,
      hook_settings_dir: HOOK_SETTINGS_DIR,
      session_registry_path: SESSION_REGISTRY_PATH,
      max_saved_sessions: MAX_SAVED_SESSIONS,
      max_saved_session_bytes: MAX_SAVED_SESSION_BYTES,
      max_saved_session_age_days: MAX_SAVED_SESSION_AGE_DAYS,
      max_log_bytes: MAX_LOG_BYTES,
      max_log_read_bytes: MAX_LOG_READ_BYTES,
      default_log_read_bytes: DEFAULT_LOG_READ_BYTES,
      default_wait_timeout_ms: DEFAULT_WAIT_TIMEOUT_MS,
      max_wait_timeout_ms: MAX_WAIT_TIMEOUT_MS,
      default_request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
      request_wait_schedule_minutes: DEFAULT_REQUEST_WAIT_SCHEDULE_MINUTES,
      request_wait_schedule_ms: REQUEST_WAIT_SCHEDULE_MS,
      default_request_idle_ms: DEFAULT_REQUEST_IDLE_MS,
      max_request_idle_ms: MAX_REQUEST_IDLE_MS,
      claude_detect_timeout_ms: CLAUDE_DETECT_TIMEOUT_MS,
      hook_completion_grace_ms: HOOK_COMPLETION_GRACE_MS,
      hook_monitor_poll_ms: HOOK_MONITOR_POLL_MS,
      startup_ready_idle_ms: STARTUP_READY_IDLE_MS,
      startup_ready_timeout_ms: STARTUP_READY_TIMEOUT_MS,
      submit_after_paste_ms: SUBMIT_AFTER_PASTE_MS,
      submit_after_paste_line_ms: SUBMIT_AFTER_PASTE_LINE_MS,
      submit_after_paste_max_ms: SUBMIT_AFTER_PASTE_MAX_MS,
      submit_enter_count: SUBMIT_ENTER_COUNT,
      submit_enter_gap_ms: SUBMIT_ENTER_GAP_MS,
      submit_confirm_timeout_ms: SUBMIT_CONFIRM_TIMEOUT_MS,
      submit_confirm_attempts: SUBMIT_CONFIRM_ATTEMPTS,
      roles: roleProfilesForInfo(),
      policy: {
        caller: "ai_agent",
        read_only_roles: [...READ_ONLY_ROLES],
        implementation_roles: [...IMPLEMENTATION_ROLES],
        read_only_roles_mutate_files: false,
        implementer_requires_claude_worktree: true,
        implementer_filesystem_isolation: "git_worktree_not_os_sandbox",
        nested_subagents: false,
        request_boundary: "injected_by_role",
        forwards_allowlisted_interactive_claude_args: true,
        forbidden_claude_arg_flags: [...FORBIDDEN_CLAUDE_ARG_FLAGS],
        structured_claude_arg_flags: [...CONTROLLED_CLAUDE_ARG_FLAGS],
        forwarded_claude_arg_flags: [...FORWARDED_CLAUDE_ARG_FLAGS.keys()],
        model_passthrough: true,
        effort_passthrough: true,
        model_effort_default_source: MODEL_EFFORT_DEFAULT_SOURCE,
      },
      mcp_presets: {
        default_read_only: DEFAULT_READ_ONLY_MCP_PRESET,
        available: Object.fromEntries(Object.entries(MCP_PRESETS).map(([name, preset]) => [name, preset])),
      },
      tools: [
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
      ],
      active_interactive_sessions: [...interactiveSessions.values()].filter((session) =>
        LIVE_SESSION_STATUSES.has(session.status),
      ).length,
      claude: {
        ...claude,
        auth: claude.available ? await claudeAuthPreflight.detectClaudeAuth() : null,
      },
    });
  },
);

async function main() {
  ensureState();
  await loadSessionRegistry();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`codex-claude-subagent interactive MCP server ${VERSION} running`);
}

let shuttingDown = false;
function beginShutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAllInteractiveSessions("SIGTERM");
  setTimeout(() => process.exit(exitCode), STOP_GRACE_MS + 1000).unref();
}

function installShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      beginShutdown(signal === "SIGINT" ? 130 : 0);
    });
  }
  // The v1 stdio transport does not turn stdin EOF into transport.close().
  // Treat loss of the owning MCP client as shutdown so active PTY sessions
  // cannot keep this server alive as an orphan after its host exits.
  process.stdin.once("end", () => beginShutdown());
  process.stdin.once("close", () => beginShutdown());
  process.once("exit", () => {
    stopAllInteractiveSessions("SIGTERM");
  });
}

installShutdownHandlers();

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
