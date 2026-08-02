#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSessionRegistrySupport } from "../lib/session-registry.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-subagent-lib-test-"));
const lockDir = path.join(tempRoot, "registry.lock");
const now = Date.now();
const support = createSessionRegistrySupport({
  lockDir,
  instanceId: "test-instance",
  privateDirMode: 0o700,
  privateFileMode: 0o600,
  lockTimeoutMs: 1000,
  lockStaleMs: 5000,
  processIsAlive: (pid) => pid === process.pid,
  sessionKey: (record) => record.id,
  isLive: (record) => record.status === "running",
  artifactSize: (record) => record.bytes,
  maxSessions: 3,
  maxTerminalBytes: 100,
  maxTerminalAgeMs: 1000,
});

try {
  const selection = support.selectRetained(
    [
      { id: "live", status: "running", updated_at: new Date(now).toISOString(), bytes: 1000 },
      { id: "new", status: "exited", updated_at: new Date(now - 10).toISOString(), bytes: 60 },
      { id: "too-large", status: "exited", updated_at: new Date(now - 20).toISOString(), bytes: 50 },
      { id: "too-old", status: "exited", updated_at: new Date(now - 2000).toISOString(), bytes: 10 },
    ],
    now,
  );
  assert(selection.retained.map((record) => record.id).join(",") === "live,new", "retention limits were not applied");
  assert(selection.terminalBytes === 60, "retained artifact bytes were calculated incorrectly");
  assert(selection.evicted.length === 2, "evicted session records were not reported");

  fs.mkdirSync(lockDir, { mode: 0o700 });
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid }));
  const releaseTimer = setTimeout(() => fs.rmSync(lockDir, { recursive: true, force: true }), 50);
  const result = await support.withLock(() => "acquired");
  clearTimeout(releaseTimer);
  assert(result === "acquired", "asynchronous registry lock was not acquired");

  console.log("codex-claude-subagent library tests passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
