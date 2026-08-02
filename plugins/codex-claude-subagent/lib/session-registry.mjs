import fs from "node:fs";
import path from "node:path";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSessionRegistrySupport({
  lockDir,
  instanceId,
  privateDirMode,
  privateFileMode,
  lockTimeoutMs,
  lockStaleMs,
  processIsAlive,
  sessionKey,
  isLive,
  artifactSize,
  maxSessions,
  maxTerminalBytes,
  maxTerminalAgeMs,
}) {
  function lockIsLive() {
    const ownerPath = path.join(lockDir, "owner.json");
    try {
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      if (processIsAlive(owner.pid)) return true;
    } catch {
      // Fall through to the lock directory age check.
    }
    const stat = fs.statSync(lockDir, { throwIfNoEntry: false });
    return Boolean(stat && Date.now() - stat.mtimeMs < lockStaleMs);
  }

  async function withLock(callback) {
    const started = Date.now();
    while (true) {
      try {
        fs.mkdirSync(lockDir, { mode: privateDirMode });
        try {
          fs.writeFileSync(
            path.join(lockDir, "owner.json"),
            JSON.stringify({ instance_id: instanceId, pid: process.pid, acquired_at: new Date().toISOString() }),
            { mode: privateFileMode },
          );
        } catch (error) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (!lockIsLive()) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - started >= lockTimeoutMs) {
          throw new Error("Timed out waiting for the Codex–Claude Subagent session registry lock.", { cause: error });
        }
        await delay(10);
      }
    }
    try {
      return await callback();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  function selectRetained(records, now = Date.now()) {
    const sorted = [...records].sort((left, right) =>
      String(right.updated_at || "").localeCompare(String(left.updated_at || "")),
    );
    const live = sorted.filter(isLive);
    const terminal = sorted.filter((record) => !isLive(record));
    const retained = [...live];
    let terminalBytes = 0;

    for (const record of terminal) {
      if (retained.length >= Math.max(maxSessions, live.length)) break;
      const updatedAt = Date.parse(record.updated_at || record.ended_at || "");
      if (!Number.isFinite(updatedAt) || now - updatedAt > maxTerminalAgeMs) continue;
      const bytes = artifactSize(record);
      if (terminalBytes + bytes > maxTerminalBytes) continue;
      terminalBytes += bytes;
      retained.push(record);
    }

    const retainedKeys = new Set(retained.map(sessionKey));
    return {
      retained,
      evicted: sorted.filter((record) => !retainedKeys.has(sessionKey(record)) && !isLive(record)),
      terminalBytes,
    };
  }

  return { selectRetained, withLock };
}
