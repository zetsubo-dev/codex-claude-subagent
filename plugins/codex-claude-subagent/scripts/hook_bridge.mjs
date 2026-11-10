#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PRIVATE_FILE_MODE = 0o600;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 64000;
const DEFAULT_MAX_EVENT_FILE_BYTES = 8 * 1024 * 1024;
const HOOK_FILE_GENERATION_FIELD = "codex_claude_subagent_hook_generation";
const LOCK_WAIT_MS = 4000;
const LOCK_STALE_MS = 3000;

function generationHeader(generation) {
  return `${JSON.stringify({ [HOOK_FILE_GENERATION_FIELD]: generation })}\n`;
}

function readGeneration(eventPath) {
  const size = Math.min(fs.statSync(eventPath, { throwIfNoEntry: false })?.size || 0, 512);
  if (!size) return null;
  const fd = fs.openSync(eventPath, "r");
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

function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
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

function readLockOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function acquireFileLock(eventPath) {
  const lockPath = `${eventPath}.lock`;
  const started = Date.now();
  const token = crypto.randomUUID();
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() }),
        { mode: PRIVATE_FILE_MODE, flag: "wx" },
      );
      return () => {
        if (readLockOwner(lockPath)?.token === token) {
          fs.rmSync(lockPath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) {
        throw new Error("Refusing to use a symlinked Codex–Claude Subagent hook lock.", { cause: error });
      }
      const owner = readLockOwner(lockPath);
      if (stat && !processIsAlive(owner?.pid) && Date.now() - stat.mtimeMs >= LOCK_STALE_MS) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new Error("Timed out waiting for the Codex–Claude Subagent hook event lock.", { cause: error });
      }
      sleepSync(10);
    }
  }
}

function safeStringPrefix(value, maxChars) {
  const text = String(value);
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function truncateField(value, maxChars = MAX_MESSAGE_CHARS) {
  if (value === undefined || value === null) return { value: null, truncated: false };
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= maxChars) return { value: text, truncated: false };
  return {
    value: `${safeStringPrefix(text, maxChars)}\n[codex-claude-subagent: hook field truncated]`,
    truncated: true,
  };
}

function truncate(value, maxChars = MAX_MESSAGE_CHARS) {
  return truncateField(value, maxChars).value;
}

function promptRequestToken(prompt) {
  if (typeof prompt !== "string") return null;
  const pastePrefix = "\x1b[200~";
  const pasteIndex = prompt.lastIndexOf(pastePrefix);
  const currentPrompt = pasteIndex === -1 ? prompt : prompt.slice(pasteIndex + pastePrefix.length);
  const match = currentPrompt.match(
    /^Codex–Claude Subagent correlation token:\s*(CODEX_CLAUDE_SUBAGENT_REQUEST_[a-z0-9_]+)\s*$/im,
  );
  return match?.[1] || null;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) throw new Error("Claude hook input exceeded the Codex–Claude Subagent limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const eventPath = process.argv[2];
  const configuredMax = Number(process.argv[3]);
  const maxEventFileBytes =
    Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_EVENT_FILE_BYTES;
  if (!eventPath || !path.isAbsolute(eventPath)) {
    throw new Error("Codex–Claude Subagent hook event path must be absolute.");
  }
  const stat = fs.lstatSync(eventPath, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error("Refusing to write a symlinked Codex–Claude Subagent hook event file.");

  const rawInput = await readStdin();
  const parsed = JSON.parse(rawInput || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hook input must be a JSON object.");
  }
  const assistantMessage = truncateField(parsed.last_assistant_message);
  const event = {
    at: new Date().toISOString(),
    hook_event_name: truncate(parsed.hook_event_name, 128),
    session_id: truncate(parsed.session_id, 256),
    cwd: truncate(parsed.cwd, 4096),
    permission_mode: truncate(parsed.permission_mode, 128),
    notification_type: truncate(parsed.notification_type, 256),
    message: truncate(parsed.message, 16000),
    error: truncate(parsed.error, 512),
    error_details: truncate(parsed.error_details, 16000),
    last_assistant_message: assistantMessage.value,
    last_assistant_message_truncated: assistantMessage.truncated,
    stop_hook_active: parsed.stop_hook_active === true,
    background_tasks_pending: Array.isArray(parsed.background_tasks) ? parsed.background_tasks.length : null,
    session_crons_pending: Array.isArray(parsed.session_crons) ? parsed.session_crons.length : null,
    prompt_request_token: promptRequestToken(parsed.prompt),
  };
  const line = `${JSON.stringify(event)}\n`;
  const releaseLock = acquireFileLock(eventPath);
  try {
    const currentSize = fs.statSync(eventPath, { throwIfNoEntry: false })?.size || 0;
    let generation = readGeneration(eventPath) || crypto.randomUUID();
    if (currentSize + Buffer.byteLength(line) > maxEventFileBytes) {
      generation = crypto.randomUUID();
      fs.writeFileSync(eventPath, `${generationHeader(generation)}${line}`, { mode: PRIVATE_FILE_MODE });
    } else if (currentSize === 0) {
      fs.writeFileSync(eventPath, `${generationHeader(generation)}${line}`, { mode: PRIVATE_FILE_MODE });
    } else {
      fs.appendFileSync(eventPath, line, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
        flag: "a",
      });
    }
    fs.chmodSync(eventPath, PRIVATE_FILE_MODE);
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
