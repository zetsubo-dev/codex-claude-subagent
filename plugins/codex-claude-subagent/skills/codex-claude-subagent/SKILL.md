---
name: codex-claude-subagent
description: Use when the user asks Codex to involve Claude as a subagent, Claude Code, Claude reviewers, second opinions, or interactive Claude Code sessions from Codex. Provides guidance for the local codex_claude_subagent MCP tools.
---

# Codex–Claude Subagent

Use the `codex_claude_subagent` MCP tools to start and steer an interactive Claude Code
session from Codex. This plugin is interactive-only. Do not look for or use
`claude -p`, background-agent, tmux, or agmsg tools in this plugin.

## Tool Discovery

Codex–Claude Subagent MCP tools can be deferred and therefore absent from the initial
callable tool catalog even when the plugin and MCP server are available. Before
reporting that `claude_interactive_start`, `claude_interactive_request`, or the
`mcp__codex_claude_subagent` namespace is unavailable:

1. If `tool_search` is callable, use it to search for `codex_claude_subagent`,
   `codex_claude_subagent_info`, `claude_interactive_start`, and
   `claude_interactive_request`.
2. If `tool_search` is not callable, inspect the current callable catalog
   directly for the `mcp__codex_claude_subagent` namespace and those tool names.
3. If the tools are found, call `codex_claude_subagent_info` to verify the live MCP
   connection before starting the requested session.
4. If the tools remain absent after either `tool_search` or direct catalog
  inspection, report only that the current turn cannot use or discover
  Codex–Claude Subagent. Do not claim that the plugin is uninstalled, that the MCP server is
   unbound, or that a particular host or plugin failure caused the absence.
5. Report a verified live MCP failure only when a discovered
   `codex_claude_subagent_info` call fails.

The skill being visible proves only that the plugin's skill surface was loaded;
it does not by itself prove or disprove live MCP tool exposure.

The bundled MCP server uses Codex's optional startup behavior. If it cannot
  initialize during startup or resume, Codex may continue without the
  Codex–Claude Subagent tool surface. Inspect the enabled state, current plugin entrypoint, and
host logs before assigning the cause; do not treat a successfully resumed task
as proof that Codex–Claude Subagent initialized.

## Operating Model

- Codex remains the orchestrator and final integrator.
- The caller must choose a role contract. Read-only roles report findings and
  suggested fixes; Codex applies those changes. The `implementer` role is
  instructed to edit and run checks in its required dedicated Claude Git
  worktree, then
  reports the changed files and verification for Codex to inspect and integrate.
- Claude runs as an interactive Claude Code session in the target `cwd`.
- The plugin does not bundle or install Claude Code. It launches the `claude`
  executable resolved through the host machine's `PATH` and uses the existing
  Claude Code `claude.ai` login. The default `auto` MCP preset preserves
  Claude Code's user, project, and local settings.
- This plugin is a leaf subagent: nested Claude agents and team tools are not
  exposed by default and are rejected when supplied as tool overrides.
- Start with `claude_interactive_start`.
- `claude_interactive_start` performs a fresh subscription-authentication
  preflight before creating any PTY or saved session. API-billed authentication
  is rejected; any authenticated `claude.ai` session is accepted regardless of
  plan name.
- If start reports an authentication preflight failure, do not retry another
  fresh session. Read `codex_claude_subagent_info.claude.auth`, present its remediation
  commands and success condition, and wait for the user to complete any
  password or browser interaction in their own terminal.
- `codex_claude_subagent_info.claude.auth` distinguishes ordinary logout from a locked
  or unwritable macOS login keychain. A browser `Login successful` message is
  not sufficient; the reported success condition must pass.
- For review and re-review requests, prefer `claude_interactive_request`.
- If a request returns on idle or timeout with `done: false`, call
  `claude_interactive_wait_request` with its `request_id`; its default
  `idle_ms: null` waits for completion or hard timeout. If that resumed wait
  also returns on timeout while `request.wait_required` is `true`, call the
  same tool again with the same request ID and the returned
  `request.next_action.timeout_ms`. The cumulative checkpoints are 5, 10, 15,
  20, 25, 30, 45, 60, and 90 minutes from request creation. Repeat until
  `request.next_action` is null and the request status is `completed`,
  `failed`, or `interrupted`. A successful hook or marker returns immediately;
  checkpoints are maximum waits, not sleeps. Do not resend the request text.
- If the request is still pending at 90 minutes, it reports
  `long_running: true`, clears the automatic `next_action`, and returns
  `attention_required`. Ask the user whether to continue waiting or stop.
  Continue only with an explicit `timeout_ms`; never stop or resend on your own.
- If `request.submit.reason` is not `submitted` and `submitted_at` is still
  null, retry once with `claude_interactive_wait_request` and
  `retry_submit: true`. This sends only Enter, never duplicate request text.
- Use `claude_interactive_wait` only when you need lower-level waiting for a
  pattern, idle period, exit, or timeout.
- Use `claude_interactive_read` to inspect recent terminal output.
- Use `claude_interactive_read_log` to recover long Claude output by byte
  offset or tail window when `output_tail` is incomplete.
- Read and read-log can inspect a persisted session owned by another MCP
  server process. Such a result is read-only (`control_available: false`);
  send, wait, and stop must use the owning Codex session.
- Use `claude_interactive_saved_sessions` when you need the persisted Claude Code
  session ID for a stopped or server-restarted worker.
- Use `claude_interactive_send` for manual follow-up text.
- Stop sessions with `claude_interactive_stop` when finished.
- The first send/request waits for Claude Code startup output to become quiet
  before pasting input; inspect `request.ready` if startup behavior looks wrong.
- `claude_interactive_request` also returns `request.submit`; if this is not
  `submitted`, inspect `output_tail` because Claude Code may still be in a paste
  preview or prompt state.

## Review Loop

Use this loop for Claude review from Codex:

1. `claude_interactive_start` with the project `cwd`.
2. `claude_interactive_request` with the review handoff.
3. Read the returned output and apply fixes in Codex.
4. `claude_interactive_request` again in the same `interactive_id` with the
   current diff, test results, and a re-review request.
5. Repeat until Claude has no blocking findings.
6. `claude_interactive_stop`.

A successful start includes `resolved.auth`. Confirm its `billing_mode` is
`claude_subscription` when reporting live proof that the worker is using the
user's Claude.ai authentication rather than API billing. Do not infer or claim
a specific Claude.ai plan from this field.

For a review that should survive closing the PTY or restarting the MCP server,
preserve `claude_session_id` from the start response. To continue that same
Claude Code conversation later, call `claude_interactive_start` with
`resume_claude_session_id` set to that ID. `continue_latest` is intentionally
rejected because it can attach the wrong conversation; use
`claude_interactive_saved_sessions` to recover the exact ID, or start a new
session when no registered ID is available.

Do not set or request Remote Control flags from this plugin. Codex–Claude Subagent does
not explicitly alter Remote Control behavior. Its normal `auto` session uses
Claude Code's `user,project,local` setting sources, so user MCP, project
instructions, project MCP, and local project settings are discovered normally.
The explicit `none` preset intentionally disables all setting sources.

## Model Changes While Preserving Context

Treat requests such as "continue this Claude conversation with Opus", "keep the
context and have another model review it", or "switch this session's model" as an
exact-session resume, not as a fresh Claude session.

Do not change models merely because the user asks for an ordinary follow-up or
re-review. Keep the current live session and model unless the user explicitly
requests another model.

The model and effort are fixed for a live Codex–Claude Subagent PTY.
`claude_interactive_request` has no model override, and
`claude_interactive_send` must not be used to type a `/model` command. To change
the model while preserving Claude's conversation context:

1. Finish any pending request. If the session still reports an
   `active_request`, continue it with `claude_interactive_wait_request`.
   `request.done: false` alone does not prove that work is pending:
   `failed`, `interrupted`, and `server_restarted` are terminal states whose
   active request has already been released, so they may proceed to stop.
2. Preserve the exact `claude_session_id`, `cwd`, and `role` from the live or
   saved session.
3. Call `claude_interactive_stop` and require `stop.exited: true`.
4. Call `claude_interactive_start` with the same `cwd` and `role`, the preserved
   ID in `resume_claude_session_id`, and the requested `model` and `effort`.
5. Verify the start response reports the same `claude_session_id`,
   `resolved.resume_mode: "resume"`, and the requested `resolved.model` and
   `resolved.effort` before sending the next review request.

Exact-session resume intentionally requires the same `cwd` and `role`. If the
user requests a different role, start a new Claude session with a compact
handoff packet instead of claiming that the old conversation was resumed.

`claude_interactive_request` uses session-local Claude Code hooks as the
primary lifecycle signal. `UserPromptSubmit` confirms submission,
`Stop` completes the current request, and `StopFailure` reports API
failures. Codex–Claude Subagent passes these hooks through a private per-session
`--settings` file; it does not modify the user's or project's Claude
settings. A split completion marker remains as fallback when hooks are disabled
or unavailable.

The default idle fallback is 30 seconds and the normal request hard timeout is
5 minutes. Idle and timeout returns keep the request pending. Resumed request
waits default to `idle_ms: null`, so they stay attached until completion or the
additional hard timeout. Every nonterminal response reports
`request.wait_required: true` and a `request.next_action` naming
`claude_interactive_wait_request` until the 90-minute boundary. Follow that
action and its timeout again after every timeout until it becomes null.
The cumulative checkpoint schedule is 5, 10, 15, 20, 25, 30, 45, 60, and 90
minutes; each wait returns immediately when a hook or completion marker arrives.
At 90 minutes, ask the user whether to continue or stop. Use
`claude_interactive_wait_request` rather than
sending another request; new request/send input is rejected until the pending
request completes or the session stops. Codex–Claude Subagent also monitors hook files
while the PTY is alive, so a late `Stop` updates persisted request state even
between MCP tool calls.

After submission, a `Notification` with
`notification_type: "permission_prompt"` appears as
`request.permission_attention` with the same `request_id`. This is nonterminal
attention only. It does not release the pending request or change completion
transport. It is a forward-only, non-durable response field. Resume with
`claude_interactive_wait_request`, never by resending the original request
text. The attention is cleared on resumed wait and on `Stop`, `StopFailure`, or
completion-marker terminal state.

On first use of a project, Claude Code may show its MCP server selector before
the input prompt. The worker handles this startup-only selector without
resending the review request: `auto` confirms the project's currently checked
servers, while explicit `none` rejects the selector and starts without project
MCP. Do not send critic text while that selector is visible.

`status: "running"` means the interactive Claude process is still alive for
follow-up input; it does not mean the latest review request is still working.
For request-level state, check `request.status`, `request.done`,
`request.completion_transport`, and `request.terminal_state`.
`completed_with_stop_hook` and `completed_with_marker` are terminal
successes. For a hook-completed request, prefer `request.result_text` as
Claude's final answer; use terminal logs for long/truncated output and audit
context. Stop the session when no re-review will be sent.

## Role Selection

- `explorer`: read-only repository exploration.
- `reviewer`: read-only correctness and maintainability review.
- `security_reviewer`: complex read-only security review.
- `critic`: complex adversarial second opinion.
- `architect`: complex design and refactor planning.
- `implementer`: implementation and verification in a dedicated Claude
  worktree. Requires `claude_worktree`; defaults to `Edit`, `Write`, `Bash`,
  `Read`, `Grep`, `Glob`, and `permission_mode: "dontAsk"`. It must not commit,
  push, or modify files outside that worktree.

When `model` or `effort` is omitted, the plugin passes no corresponding CLI
option and Claude Code selects its own default from its normal installation,
account, and settings. The plugin does not inject a role-specific model,
effort, or fallback. Explicit values are passed through unchanged and are
validated by the installed Claude Code.

For read-only roles, do not ask Codex–Claude Subagent to implement code changes;
use Codex for edits, then send the resulting diff back for re-review. Use
`role: "implementer"` only when the caller explicitly wants Claude to make the
change in an isolated worktree.

## Model and Effort Selection

The calling agent may set `model` and `effort` on every new
`claude_interactive_start`. `model` accepts any non-empty Claude Code alias or
full model ID and `effort` accepts any non-empty value; both are passed through
unchanged and validated by the installed Claude Code. This lets the caller use
new Claude model or effort values without a plugin release. When either value
is omitted, Claude Code's own default is used.

Use `claude_args` for the allowlisted Claude Code interactive flags and values.
The live policy reports that list. Unknown flags are rejected; so are
print/non-interactive, background, tmux, Remote Control, nested-agent,
plugin-loading, output-format, and structured session/permission/worktree flags.
Use the structured fields for `model`, `effort`, `permission_mode`,
`claude_worktree`, MCP, tools, and session identity instead of repeating those
flags in `claude_args`.

## Safety Defaults

The MCP contract is explicit in `codex_claude_subagent_info`: read-only roles
have `mode: "read_only"`, `mutates_files: false`, and `requires_worktree: false`;
`implementer` has `mode: "implementation"`, `mutates_files: true`, and
`requires_worktree: true`. The `claude_interactive_start` schema repeats this
role contract so another AI agent can select a role without relying on prose.

Read-only roles use `Bash`, `Read`, `Grep`, and `Glob` with
`permission_mode: "plan"` and `mcp_preset: "auto"`. Their boundary is injected
into the session context and every `claude_interactive_request`; `Edit`,
`Write`, known nested-agent tools, mutating permission modes, and worktrees are
rejected as overrides. Bash remains intended for non-mutating inspection only.

The implementer boundary is injected in the same way and requires
`claude_worktree`. It uses `Bash`, `Read`, `Grep`, `Glob`, `Edit`, and `Write`
with `permission_mode: "dontAsk"`. Its Git worktree is not an OS-level
filesystem sandbox; commit, push, publish, outside-worktree paths, and
nested-agent tools remain outside the contract. Claude Code handles the tool
and permission behavior for the interactive session.

`auto` uses Claude Code's normal user, project, and local MCP discovery. The legacy
`serena`, `context7`, and `serena_context7` preset names remain aliases for that
normal behavior. Normal MCP does not require or receive
`--mcp-config` or `--strict-mcp-config`.

Use `mcp_preset: "none"` when the worker must not use MCP at all. Only this
explicit preset writes an empty private config, omits all Claude settings/MCP
discovery, and requires Claude Code's strict MCP capabilities. This is an
exception for an explicitly MCP-free session, not a recovery step for a normal
MCP selector. Do not select `none` merely because the startup selector appears.

Override `mcp_preset`, tools, model, or effort only when the selected role's
contract allows it. Do not override the role boundary or use a worktree with a
read-only role. `mcp_preset: "none"` is available when the caller explicitly
requires an MCP-free session.

## Handoff Packet

Use this shape in interactive requests:

```text
Goal:
Repo/worktree:
Relevant files:
Current diff:
Decisions already made:
Constraints:
Commands already run:
Known failures:
Expected output:
```

Do not paste the entire Codex transcript into Claude. Pass compact, explicit
context and ask Claude to inspect the repository directly when needed.

## Interactive Output

Interactive output is terminal output. It can include prompts, redraws,
permission requests, and partial text. Always check `wait.reason`, `status`,
`quiet_ms`, and the returned `output_tail` before deciding whether Claude is
done, waiting for input, asking for permission, or still running.

`output_tail` is intentionally bounded. When Claude's answer is long, read the
persisted terminal log with `claude_interactive_read_log`. Start from
`request.start_log_offset` when available, otherwise use `tail_bytes`;
then keep reading from `next_offset` until `eof: true`. Log pages
preserve UTF-8 character boundaries. This avoids mistaking a truncated
transport response for Claude omitting part of its answer.

When stopping a session, check `stop.exited`. If it is `false`, the stop signal
was sent but the PTY bridge did not confirm exit within the wait window.
