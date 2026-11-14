import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createObserverFixture, waitForFile } from "./observer-fixture.mjs";
import { openMcp } from "./mcp-fixture.mjs";

export const hash = (text) => createHash("sha256").update(text).digest("hex");

export function createDeliveryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-delivery-"));
  const stateDir = path.join(root, "state");
  const control = path.join(root, "control");
  const bin = path.join(root, "bin");
  const projects = [path.join(root, "project-a"), path.join(root, "project-b")];
  for (const dir of [stateDir, control, bin, ...projects]) fs.mkdirSync(dir, { recursive: true });
  const childModule = fileURLToPath(new URL("./delivery-claude.mjs", import.meta.url));
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env node\nimport(${JSON.stringify(new URL("./delivery-claude.mjs", import.meta.url).href)});\n`,
    { mode: 0o700 },
  );
  assert(fs.existsSync(childModule));
  const clients = new Set();
  const sessions = new Set();
  const connect = async (extra = {}) => {
    const client = await openMcp({
      stateDir,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
        DELIVERY_FIXTURE_CONTROL: control,
        CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
        CODEX_CLAUDE_SUBAGENT_STARTUP_READY_IDLE_MS: "10",
        CODEX_CLAUDE_SUBAGENT_STARTUP_READY_TIMEOUT_MS: "2000",
        CODEX_CLAUDE_SUBAGENT_SUBMIT_AFTER_PASTE_MS: "1",
        CODEX_CLAUDE_SUBAGENT_SUBMIT_AFTER_PASTE_LINE_MS: "1",
        CODEX_CLAUDE_SUBAGENT_SUBMIT_AFTER_PASTE_MAX_MS: "10",
        CODEX_CLAUDE_SUBAGENT_SUBMIT_ENTER_COUNT: "1",
        CODEX_CLAUDE_SUBAGENT_SUBMIT_ENTER_GAP_MS: "1",
        ...extra,
      },
    });
    clients.add(client);
    return client;
  };
  const start = async (client, cwd = projects[0], { resume, sessionId, ...observerOptions } = {}) => {
    if (resume) fs.rmSync(path.join(control, resume), { recursive: true, force: true });
    const view = await client.call("claude_interactive_start", {
      cwd,
      role: "reviewer",
      mcp_preset: "none",
      ...(resume ? { resume_claude_session_id: resume } : {}),
    });
    const directory = path.join(control, view.claude_session_id);
    fs.mkdirSync(directory, { recursive: true });
    await waitForFile(path.join(directory, "ready.json"));
    const meta = JSON.parse(fs.readFileSync(path.join(directory, "ready.json"), "utf8"));
    const observer = await createObserverFixture({
      ...meta,
      sessionId: sessionId || meta.sessionId,
      ...observerOptions,
    });
    await observer.call("session.start");
    const session = { client, cwd, view, directory, observer, meta, count: 0, stopped: false };
    sessions.add(session);
    return session;
  };
  const begin = async (session, { timeoutMs = 10000 } = {}) => {
    const completion = session.client.call("claude_interactive_request", {
      cwd: session.cwd,
      interactive_id: session.view.interactive_id,
      text: `fixture request ${++session.count}`,
      idle_ms: null,
      timeout_ms: timeoutMs,
    });
    completion.catch(() => {});
    const file = path.join(session.directory, `prompt-${session.count}.json`);
    await waitForFile(file);
    const prompt = JSON.parse(fs.readFileSync(file, "utf8"));
    assert(prompt.token, "request correlation token did not reach the PTY");
    const turnId = randomUUID();
    await session.observer.call("turn.start", {
      text: `Codex–Claude Subagent correlation token: ${prompt.token}`,
      turnId,
    });
    await session.observer.observe("fixture-model", "xhigh");
    return { session, completion, turnId, token: prompt.token };
  };
  const complete = async (pending, answer, reason = "answer") => {
    await pending.session.observer.call("classic.Stop", { background_tasks: [], session_crons: [] });
    await pending.session.observer.call("turn.complete", { turnId: pending.turnId, answer, reason, isAborted: false });
    return pending.completion;
  };
  const stop = async (session) => {
    const result = await session.client.call("claude_interactive_stop", {
      cwd: session.cwd,
      interactive_id: session.view.interactive_id,
    });
    assert.equal(result.stop.exited, true);
    session.stopped = true;
    return result;
  };
  const cleanup = async () => {
    for (const session of sessions) {
      if (!session.stopped && session.client.child.exitCode === null && session.client.child.signalCode === null)
        await stop(session).catch(() => {});
      if (!session.stopped && Number.isInteger(session.view.pid) && session.view.pid > 1) {
        try {
          process.kill(process.platform === "win32" ? session.view.pid : -session.view.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    for (const client of clients) await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, stateDir, control, projects, connect, start, begin, complete, stop, cleanup };
}

export async function reconstruct(client, cwd, descriptor, maxBytes = 65536) {
  assert.equal(descriptor.status, "stored");
  let offset = 0;
  const parts = [];
  do {
    const page = await client.call("claude_interactive_read_answer", {
      cwd,
      answer_ref: descriptor.ref,
      offset,
      max_bytes: maxBytes,
    });
    assert.equal(page.answer_ref, descriptor.ref);
    assert.equal(page.start_offset, offset);
    assert.equal(page.total_bytes, descriptor.bytes);
    assert.equal(page.sha256, descriptor.sha256);
    assert.equal(page.lossless, descriptor.lossless);
    assert(Buffer.byteLength(page.text) <= maxBytes);
    assert.equal(page.next_offset, offset + Buffer.byteLength(page.text));
    assert.equal(page.eof, page.next_offset === descriptor.bytes);
    assert(page.eof || page.next_offset > offset, "non-final page made no progress");
    parts.push(page.text);
    offset = page.next_offset;
    if (page.eof) break;
  } while (offset <= descriptor.bytes);
  const body = parts.join("");
  assert.equal(Buffer.byteLength(body), descriptor.bytes);
  assert.equal(hash(body), descriptor.sha256);
  return body;
}
