import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function supportedEffortsFromHelp(helpText) {
  const match = /--effort\s+<level>[\s\S]{0,220}?\(([^)]+)\)/i.exec(String(helpText || ""));
  if (!match) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z0-9_-]+$/.test(value));
}

export function createClaudeAuthPreflight({
  buildEnvironment,
  detectTimeoutMs = 5000,
  statusTimeoutMs = 10000,
  doctorTimeoutMs = 15000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  platform = process.platform,
}) {
  let detectionPromise = null;

  function runClaudeCommand(args, { cwd = process.cwd(), env = buildEnvironment(), timeoutMs }) {
    return new Promise((resolve) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let child;
      let settled = false;
      let timedOut = false;
      let timeout = null;
      let forceKill = null;

      const capture = (chunks, currentBytes, chunk) => {
        const buffer = Buffer.from(chunk);
        const remaining = Math.max(0, maxOutputBytes - currentBytes);
        if (remaining === 0) return currentBytes;
        const captured = buffer.subarray(0, remaining);
        chunks.push(captured);
        return currentBytes + captured.length;
      };
      const finish = (status, signal, spawnError = null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        // The error and close events race; `settled` above makes this resolve-once.
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve({
          status,
          signal,
          timed_out: timedOut,
          spawn_error: spawnError ? String(spawnError.code || "spawn_failed") : null,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      };

      try {
        child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        finish(null, null, error);
        return;
      }
      child.stdout.on("data", (chunk) => {
        stdoutBytes = capture(stdoutChunks, stdoutBytes, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes = capture(stderrChunks, stderrBytes, chunk);
      });
      child.once("error", (error) => finish(null, null, error));
      child.once("close", (status, signal) => finish(status, signal));
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
      }, timeoutMs);
    });
  }

  function classifyCommandFailure(result, parsed = true) {
    if (result.timed_out) return "timeout";
    if (result.spawn_error) return "spawn_failed";
    if (result.status !== 0) return "exit_nonzero";
    if (!parsed) return "invalid_json";
    return null;
  }

  function detectClaude() {
    if (!detectionPromise) {
      const env = { ...buildEnvironment(), FORCE_COLOR: "0", NO_COLOR: "1" };
      detectionPromise = Promise.all([
        runClaudeCommand(["--version"], { env, timeoutMs: detectTimeoutMs }),
        runClaudeCommand(["--help"], { env, timeoutMs: detectTimeoutMs }),
      ]).then(
        ([version, help]) => {
          const helpText = `${help.stdout || ""}\n${help.stderr || ""}`;
          const versionFailure = classifyCommandFailure(version);
          const result = {
            binary: "claude",
            available: versionFailure === null,
            version: versionFailure === null ? String(version.stdout || "").trim() || null : null,
            error: versionFailure,
            capabilities: {
              interactive_pty: platform !== "win32",
              worktree: helpText.includes("--worktree"),
              allowed_tools: helpText.includes("--allowedTools") || helpText.includes("--allowed-tools"),
              mcp_config: helpText.includes("--mcp-config"),
              strict_mcp_config: helpText.includes("--strict-mcp-config"),
              settings: helpText.includes("--settings"),
              setting_sources: helpText.includes("--setting-sources"),
              append_system_prompt_file:
                helpText.includes("--append-system-prompt-file") || helpText.includes("--append-system-prompt[-file]"),
              session_id: helpText.includes("--session-id"),
              resume: helpText.includes("--resume"),
              continue: helpText.includes("--continue"),
              fable_alias: helpText.includes("'fable'") || helpText.includes(" fable") || helpText.includes("fable,"),
              fable_5: helpText.includes("claude-fable-5"),
              model_passthrough: true,
              effort_passthrough: true,
              supported_efforts: supportedEffortsFromHelp(helpText),
            },
          };
          if (!result.available) detectionPromise = null;
          return result;
        },
        (error) => {
          detectionPromise = null;
          throw error;
        },
      );
    }
    return detectionPromise;
  }

  function parseJsonObject(text) {
    try {
      const value = JSON.parse(String(text || "").trim());
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  function normalizeMetadata(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return /^[A-Za-z0-9._-]{1,64}$/.test(normalized) ? normalized : null;
  }

  async function diagnoseClaudeAuth(env, cwd) {
    const doctor = await runClaudeCommand(["--setting-sources", "", "doctor"], {
      cwd,
      env,
      timeoutMs: doctorTimeoutMs,
    });
    const output = `${doctor.stdout || ""}\n${doctor.stderr || ""}`;
    return {
      doctor_available: classifyCommandFailure(doctor) === null,
      keychain_unwritable: /macOS Keychain is not writable/i.test(output),
      keychain_locked: /unlock-keychain|keychain[^\n]*locked/i.test(output),
      missing_user_profile_scope: /missing the user:profile scope/i.test(output),
    };
  }

  function emptyDiagnostics() {
    return {
      doctor_available: null,
      keychain_unwritable: false,
      keychain_locked: false,
      missing_user_profile_scope: false,
    };
  }

  function buildRemediation(issue, diagnostics, statusFailure) {
    const commands = [];
    let summary;
    let loginRequired = false;
    if (platform === "darwin" && (diagnostics.keychain_unwritable || diagnostics.keychain_locked)) {
      summary =
        "Claude Code cannot persist or read its OAuth token because the macOS login keychain is locked or not writable. A browser 'Login successful' message is not sufficient until the CLI can read the saved token.";
      commands.push('security unlock-keychain "$HOME/Library/Keychains/login.keychain-db"');
      loginRequired = true;
    } else if (diagnostics.missing_user_profile_scope) {
      summary = "Claude Code authentication is missing the user profile scope required to verify the Claude.ai login.";
      loginRequired = true;
    } else if (issue === "non_subscription_auth") {
      summary =
        "Claude Code is authenticated without a claude.ai session. Codex–Claude Subagent accepts Claude.ai authentication and does not fall back to API billing.";
      loginRequired = true;
    } else if (issue === "auth_status_unsupported") {
      summary =
        "The installed Claude Code CLI does not support the authentication status command required by Codex–Claude Subagent.";
      commands.push("claude update");
      loginRequired = true;
    } else if (issue === "auth_status_unavailable") {
      summary =
        statusFailure === "timeout"
          ? "Claude Code authentication status timed out. The existing login may still be valid."
          : statusFailure === "spawn_failed"
            ? "Codex–Claude Subagent could not launch the Claude Code authentication status command."
            : "Claude Code returned an unusable authentication status. The existing login may still be valid.";
      if (statusFailure === "spawn_failed") commands.push("claude --version");
      commands.push("claude auth status --text");
    } else {
      summary = "The Claude Code CLI is not authenticated with a claude.ai account.";
      loginRequired = true;
    }
    if (loginRequired) commands.push("claude auth login --claudeai", "claude auth status --text");
    return {
      user_action_required: true,
      summary,
      commands,
      success_condition: "claude auth status reports loggedIn=true with authMethod=claude.ai",
    };
  }

  async function detectClaudeAuth(cwd = process.cwd()) {
    const env = { ...buildEnvironment(), FORCE_COLOR: "0", NO_COLOR: "1" };
    const status = await runClaudeCommand(["--setting-sources", "", "auth", "status", "--json"], {
      cwd,
      env,
      timeoutMs: statusTimeoutMs,
    });
    const parsed = parseJsonObject(status.stdout);
    const statusFailure = classifyCommandFailure(status, parsed);
    const usableStatus = statusFailure === null ? parsed : null;
    const loggedIn = usableStatus?.loggedIn === true;
    const authMethod = normalizeMetadata(usableStatus?.authMethod);
    const apiProvider = normalizeMetadata(usableStatus?.apiProvider);
    const subscriptionType = normalizeMetadata(usableStatus?.subscriptionType);
    const unsupportedStatusCommand =
      statusFailure === "exit_nonzero" &&
      /unknown|unrecognized|unsupported|invalid command|unexpected argument/i.test(String(status.stderr || ""));
    const ready = statusFailure === null && loggedIn && authMethod === "claude.ai";
    const issue = ready
      ? null
      : unsupportedStatusCommand
        ? "auth_status_unsupported"
        : statusFailure
          ? "auth_status_unavailable"
          : loggedIn
            ? "non_subscription_auth"
            : "not_logged_in";
    const shouldDiagnose =
      !ready &&
      !unsupportedStatusCommand &&
      (issue === "not_logged_in" || issue === "non_subscription_auth" || statusFailure === "exit_nonzero");
    const diagnostics = shouldDiagnose ? await diagnoseClaudeAuth(env, cwd) : emptyDiagnostics();
    return {
      checked_at: new Date().toISOString(),
      ready,
      logged_in: loggedIn,
      auth_method: authMethod,
      api_provider: apiProvider,
      subscription_type: subscriptionType,
      billing_mode: ready ? "claude_subscription" : "unavailable",
      issue,
      status_error: statusFailure,
      diagnostics,
      remediation: ready ? null : buildRemediation(issue, diagnostics, statusFailure),
    };
  }

  function compactClaudeAuth(auth) {
    return {
      checked_at: auth.checked_at,
      auth_method: auth.auth_method,
      api_provider: auth.api_provider,
      subscription_type: auth.subscription_type,
      billing_mode: auth.billing_mode,
    };
  }

  function formatPreflightError(auth) {
    return [
      "Codex–Claude Subagent authentication preflight failed; no interactive session was created.",
      `Reason: ${auth.remediation?.summary || auth.issue || "unknown authentication error"}`,
      "Run these commands in a local terminal. Never send your password or login code to Codex:",
      ...(auth.remediation?.commands || []).map((command) => `  ${command}`),
      `Success condition: ${auth.remediation?.success_condition || "Claude Code CLI authentication is ready"}.`,
      "Do not retry claude_interactive_start until that condition passes.",
    ].join("\n");
  }

  return {
    compactClaudeAuth,
    detectClaude,
    detectClaudeAuth,
    formatPreflightError,
  };
}
