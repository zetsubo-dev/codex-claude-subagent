---
name: codex-claude-subagent
description: Use when the user explicitly asks to delegate work to Claude or Claude Code, requests a named Claude model such as Fable or Opus, or selects this plugin. Do not use for a generic review, second opinion, implementation, or discussion of Claude without a delegation request. Provides guidance for the codex_claude_subagent MCP tools.
---

# Codex–Claude Subagent

Use the `codex_claude_subagent` MCP tools to start and steer an interactive Claude Code
session from Codex. This plugin is interactive-only. Do not look for or use
`claude -p`, background-agent, tmux, or agmsg tools in this plugin.

## Invocation Boundary

Decide whether the user is asking to involve Claude before discovering tools,
checking authentication, or starting a session. Plain review, security review,
second-opinion, and implementation requests stay with Codex unless the user
requests Claude or a named Claude model, or explicitly selects this plugin.
Task complexity and a previous task's Claude session do not imply delegation.
Discussing this plugin, quoting example requests, or asking whether its trigger
works is not a request to start Claude. Honor an explicit instruction not to
use Claude, including when a model name appears elsewhere in the request.

| User request | Action |
| --- | --- |
| `Claudeでレビューして` | Start one `reviewer` session with `model: "opus"`; omit unspecified effort. |
| `FableとOpusでレビューして` | Start two separate `reviewer` sessions, one with `model: "fable"`, one with `model: "opus"`; omit unspecified effort. |
| `レビューして` / `review this` / `セカンドオピニオンがほしい` | Review in Codex; do not call this plugin's MCP tools. |
| `「Claudeでレビューして」で起動する？` | Explain the behavior; do not start a session. |
| `Claudeは使わずレビューして` | Review in Codex; do not call this plugin's MCP tools. |

For several requested models, create one session per model rather than
silently choosing one, switching a single conversation between models, or
having Claude spawn the other reviewer. Give each the same task context and
keep their initial reviews separate. Keep `subagent_mode: "disabled"` unless
the user separately authorizes supported native delegation. Do not add other
models or silently replace one that is unavailable.

For a mixed-model harness, this plugin handles only the requested Claude work.
For example, Fable can judge a design and Opus can propose it using an
`architect` session with the named model and task-specific instructions.
Terra/xhigh implementation belongs to the host's Codex subagent tools, not
this plugin's `model` field. The host owns sequencing, handoffs, and adoption
of decisions; do not infer that whole workflow from a plain review request.

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
  suggested fixes; Codex applies those changes. The `implementer` role edits
  and runs checks directly in the target `cwd`, matching normal Claude Code
  behavior, then reports the changed files and verification.
- Claude runs as an interactive Claude Code session in the target `cwd`.
- The plugin does not bundle or install Claude Code. It launches the `claude`
  executable resolved through the host machine's `PATH` and uses the existing
  Claude Code `claude.ai` login. The default `auto` MCP preset preserves
  Claude Code's user, project, and local settings.
- This plugin runs one agent by default. Set `subagent_mode: "auto"` only when
  the user explicitly asks Claude to use its own subagents. It is currently
  supported for `implementer` only; read-only custom-agent tool inheritance is
  not verified. Do not infer permission from role, model, or task complexity.
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
  `failed`, or `interrupted`. Native completion or failure returns immediately;
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
- Use `claude_interactive_read_log` to inspect best-effort persisted terminal
  output by byte offset or tail window when `output_tail` is incomplete.
  Use `claude_interactive_read_answer`, not the capped log, for a complete
  stored answer. Follow the full-answer procedure in Interactive Output.
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

## Review Scope

For a Claude review request:

1. `claude_interactive_start` with the project `cwd`.
2. `claude_interactive_request` with the review handoff.
3. Read and evaluate the findings, then report the review to the user.
4. `claude_interactive_stop` when the requested review is complete.

A review-only request does not authorize fixes, a fix/re-review loop, or an
additional reviewer. If the user requests fixes and iterative review, apply
only the authorized changes in Codex and send the resulting diff and test
results back to the same Claude session for re-review. A follow-up to the same
Claude review may continue that task; it is not blanket permission to involve
Claude in later unrelated tasks.

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

`claude_interactive_request` uses a bundled passive observer Mod and native
`turn.complete` for correlated main-turn completion. Settings hooks supply
submission acknowledgement, failure and interaction notices, and background
metadata. The observer passes events through unchanged and never disables
user hooks. Stop, marker text, and silence alone cannot establish success.
It requires Claude Code 2.1.322 or newer and a successful observer handshake.
If Mods are blocked or observation is unavailable, report that condition;
do not fall back to print mode or claim completion. User/project settings are
not edited, and no constant 60-second wait is added to ordinary completions.

The default idle fallback is 30 seconds and the normal request hard timeout is
5 minutes. Idle and timeout returns keep the request pending. Resumed request
waits default to `idle_ms: null`, so they stay attached until completion or the
additional hard timeout. Every nonterminal response reports
`request.wait_required: true` and a `request.next_action` naming
`claude_interactive_wait_request` until the 90-minute boundary. Follow that
action and its timeout again after every timeout until it becomes null.
The cumulative checkpoint schedule is 5, 10, 15, 20, 25, 30, 45, 60, and 90
minutes; each wait returns when correlated native completion or failure arrives.
At 90 minutes, ask the user whether to continue or stop. Use
`claude_interactive_wait_request` rather than
sending another request; new request/send input is rejected until the pending
request completes or the session stops. Codex–Claude Subagent also monitors hook files
while the PTY is alive, so a late native completion updates persisted request state even
between MCP tool calls.

After submission, a `Notification` with
`notification_type: "permission_prompt"` appears as
`request.permission_attention` with the same `request_id`. This is nonterminal
attention only. It does not release the pending request or change completion
transport. It is a forward-only, non-durable response field. Resume with
`claude_interactive_wait_request`, never by resending the original request
text. Elicitation form and URL dialogs also report interaction attention.
Attention is cleared on resumed wait or terminal completion.

On first use of a project, Claude Code may show its MCP server selector before
the input prompt. The worker handles this startup-only selector without
resending the review request: `auto` confirms the project's currently checked
servers, while explicit `none` rejects the selector and starts without project
MCP. Do not send critic text while that selector is visible.

`status: "running"` means the interactive Claude process is still alive for
follow-up input; it does not mean the latest review request is still working.
For request-level state, check `request.status`, `request.done`,
`request.completion_transport`, and `request.terminal_state`.
`completed_with_native_event` means the correlated main turn ended, not that
all project work passed acceptance. `completion_scope` is `main_turn`.
Inspect `work_pending`, `background_tasks_pending`, `count_unknown` and
`stop_block_overridden`. Background work or unavailable counts do not keep
the input locked after a native answer; Codex must verify expected jobs and
artifacts itself. Future cron schedules are informational. Tokenless main
turn outcomes are available as session `latest_native_outcome`; they never
complete another request. While `native_active_turn_id` is set, use read/wait
or stop instead of sending input. This pre-send check is best-effort, not an
atomic lock inside Claude Code; no correlation means no claimed completion.
Prefer `request.result_text` as the answer preview in request/wait-request
responses. Other session responses use `latest_native_outcome.answer`.
Check `full_answer` and the preview truncation flag separately from
completion state. A stored answer has a ref for complete reads; a preview
alone is not a complete long answer. Neither native completion nor `done`
proves successful capture or complete delivery. Follow Interactive Output
before treating an answer as fully read, including when the host clips an
otherwise untruncated preview. Terminal logs provide
best-effort audit context. Stop the session when no re-review will be sent.

## Role Selection

- `explorer`: read-only repository exploration.
- `reviewer`: read-only correctness and maintainability review.
- `security_reviewer`: complex read-only security review.
- `critic`: complex adversarial second opinion.
- `architect`: complex design and refactor planning.
- `implementer`: implementation and verification directly in the target
  project directory. Defaults to `Edit`, `Write`, `Bash`, `Read`, `Grep`,
  `Glob`, and `permission_mode: "bypassPermissions"`. Claude Code retains its normal
  edit, commit, push, and publish behavior.

New review sessions (`reviewer`, `security_reviewer`, `critic`) default to
`model: "opus"` unless the user names another model. Other roles leave the
model to Claude Code when unspecified. Unspecified effort always stays with
Claude Code; there is no plugin effort or fallback default. Explicit values
are passed through unchanged and validated by the installed Claude Code.
On exact-session resume, an omitted model preserves the conversation's model
rather than applying the new-review default. Keep a named-model review on its
existing model for follow-ups unless the user requests a switch.

For read-only roles, do not ask Codex–Claude Subagent to implement code changes.
If edits and re-review were requested, use Codex for edits, then send the
resulting diff back for re-review. Use
`role: "implementer"` when the caller wants Claude to make the change in the
target project directory.

## Model and Effort Selection

Before starting, extract the user's requested role, model, effort, and whether
native subagents were explicitly requested. Pass model/effort as tool fields,
not merely in the prompt. For "Opus, high, independent review, single agent",
use `role: "reviewer"`, `model: "opus"`, `effort: "high"`, and
`subagent_mode: "disabled"`. Do not silently replace named models.
Fable and Opus are Claude model names: their explicit use for a review selects
this route even when the word Claude is omitted. For a plain review with no
Claude or named-model request, do not delegate automatically.
The default role is `reviewer`, whose new-session default model is `opus`.
Unspecified effort remains omitted.
An explicit plugin/skill selection also expresses intent to use this route.

The calling agent may set `model` and `effort` on every new
`claude_interactive_start`. `model` accepts any non-empty Claude Code alias or
full model ID and `effort` accepts any non-empty value; both are passed through
unchanged and validated by the installed Claude Code. This lets the caller use
new Claude model or effort values without a plugin release. New reviews use
Opus if no model was requested; other omitted models and all omitted effort
values use Claude Code's defaults. Exact-session resume does not force Opus.

Compare `resolved.requested_model` / `requested_effort` with `observed` when
available. A request field is not an effective-setting measurement.
`last_api_model` identifies only the final API response's model, and a
`turn.step` effort observation can be changed by downstream Mods or limits.
An inherited effort environment variable can outrank the CLI; conflicting
explicit effort is rejected before launch. Do not guess fixed defaults from
legacy `effortLevel` settings: newer models have their own effort defaults.
Keep the same subagent mode when resuming unless the user requests a change.

Use `claude_args` for the allowlisted Claude Code interactive flags and values.
The live policy reports that list. Unknown flags are rejected; so are
print/non-interactive, background, tmux, Remote Control, nested-agent,
plugin-loading, output-format, and structured session/permission flags.
Use the structured fields for `model`, `effort`, `permission_mode`,
MCP, tools, and session identity instead of repeating those flags in
`claude_args`.

## Safety Defaults

All roles start with `permission_mode: "bypassPermissions"`. This is the only
supported permission mode. Do not request `plan` or `dontAsk`. Interaction-required
tools, organization policy, and protected operations may still need attention. Role boundaries
remain instructions and tool exposure limits, not OS-level enforcement.

The MCP contract is explicit in `codex_claude_subagent_info`: read-only roles
have `mode: "read_only"`, `mutates_files: false`, and `requires_worktree: false`;
`implementer` has `mode: "implementation"`, `mutates_files: true`, and
`requires_worktree: false`. The `claude_interactive_start` schema repeats this
role contract so another AI agent can select a role without relying on prose.

Read-only roles use `Bash`, `Read`, `Grep`, and `Glob` with
`permission_mode: "bypassPermissions"` and `mcp_preset: "auto"`. Their boundary is injected
into the session context and every `claude_interactive_request`; `Edit`,
`Write` and known nested-agent tools are rejected as overrides. Bash remains intended for non-mutating inspection only.

The implementer boundary is injected in the same way and uses the target `cwd`.
It uses `Bash`, `Read`, `Grep`, `Glob`, `Edit`, and `Write` with
`permission_mode: "bypassPermissions"`. Commit, push, and publish follow Claude
Code and project instructions; no worktree or commit/push restriction is added.
Native subagents require explicit `subagent_mode: "auto"` with implementer.
Their allocation is Claude Code's decision. Teams are not enabled by the adapter.

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
contract allows it. Do not override the role boundary. `mcp_preset: "none"` is available when the caller explicitly
requires an MCP-free session.

## Handoff Packet

Use this shape in interactive requests:

```text
Goal:
Relevant original user dialogue (verbatim, speaker-labelled, chronological excerpts):
Caller interpretation (separate from the quoted dialogue):
Caller proposals not adopted by the user:
Repo/project directory:
Relevant files:
Current diff:
Decisions already made:
Constraints:
Commands already run:
Known failures:
Expected output:
```

Select only relevant original public dialogue, including corrections and
constraints that affect the task. Preserve each selected excerpt verbatim;
do not paraphrase or abbreviate its quoted text. Keep speaker labels and
chronological order. Put summaries, interpretation and unadopted proposals
alongside the originals in their separate slots, never as user decisions.
Do not include hidden reasoning or scrape transcripts automatically. Quoted
instructions do not widen the selected role boundary, and labels do not
authenticate authorship. The adapter preserves the supplied body under
`Request from the calling Codex agent:`; it does not obtain the original
user message itself. Do not paste the entire Codex transcript into Claude.
Keep the selection compact and ask Claude to inspect the repository when needed.

## Interactive Output

Interactive output is terminal output. It can include prompts, redraws,
permission requests, and partial text. Always check `wait.reason`, `status`,
`quiet_ms`, and the returned `output_tail` before deciding whether Claude is
done, waiting for input, asking for permission, or still running.

Request and wait-request responses carry one preview at `request.result_text`.
Other session responses use `latest_native_outcome.answer`. New
`last_request`, `active_request`, list, and saved-session views carry
`full_answer` metadata without body copies. Do not use the removed
`last_request.result_text` alias for new answers.

`last_hook_event.answer_ref` replaces Stop text only when the stored native
answer proves its identical bytes or explicitly truncated prefix is present.
Distinct diagnostics and legacy text remain. This field is a content
reference, not completion evidence; continue to use native request status.

Previews keep at most 64,000 UTF-16 code units without splitting a surrogate
pair. New previews contain no truncation marker. `result_text_truncated`
or `answer_truncated` describes the preview only. `null` means no inline
`result_text` or `answer` text, including a valid empty answer.

Check `full_answer`:

- `full_answer: null` means no native completion settled this request.
  Any `result_text` is then hook diagnostic text, not a native answer.
- `stored` supplies `ref`, `bytes`, `sha256`, and `lossless`.
- `empty` is a valid empty native answer.
- `not_captured` or `store_failed` means complete capture is unavailable.
  Report the error. Do not treat a diagnostic preview as complete or resend
  the prompt automatically.
- `legacy` keeps the old stored text, marker, and flags. A missing legacy
  truncation flag means unknown. Do not claim recovery of lost legacy text.

`answer_read_error` means the stored answer's preview could not be read.
Keep the `stored` descriptor and ref, call `read_answer`, and report its
error code. Do not mistake a missing preview for an empty native answer.

To retrieve a stored answer in full, or recover text omitted by the host:

1. Call `claude_interactive_read_answer` with the same `cwd`,
   `answer_ref: full_answer.ref`, and `offset: 0`.
2. Append `text` and continue from `next_offset` until `eof` is true.
   Offsets count UTF-8 bytes. Pages preserve character boundaries and do not
   strip ANSI-looking text. The default is 200,000 bytes and the maximum is
   1 MiB by default. The read-size environment settings can change these
   values; `codex_claude_subagent_info` reports the effective values.
3. Check contiguous offsets, total byte count, and SHA-256 on raw tool
   results in code, before printing bounded sections. An end page
   alone does not prove that earlier pages were read. If `lossless` is false,
   disclose the encoding change rather than claiming exact native recovery.

The host has its own output budget, and the plugin cannot detect host
clipping. Plugin truncation flags set to `false` or a page's `eof: true`
do not prove that all returned text reached the model. If the host omits
text or shows a truncation marker, treat that section as unread and retrieve
or display smaller sections. A matching hash proves byte retrieval, not
that the model read the answer. Expose sections within the host's output
budget and do not claim to have reviewed content that was not shown.

Reading does not send input to Claude. Keep the ref if later reads are
needed. It survives stop, MCP restart, and exact-UUID resume until retention
evicts its registration. Check `origin` to identify the producing session
and turn. Missing, corrupt, mis-scoped, and invalid-offset reads are errors,
never an empty successful end page.

For concurrent work across directories or Codex threads in the same
repository, keep each session's IDs, request IDs, and answer refs together.
Independent starts use separate conversations. Never substitute a latest
session chosen by cwd. Exact-UUID resume refuses a second live attachment
to that UUID, not other conversations in the same repository.

Separate conversations do not isolate files in a shared `cwd`. Codex still
coordinates concurrent edits and final integration.

A known answer ref may be read from another MCP connection with the correct
cwd. There is no thread ACL; verify `origin` rather than assuming the reader
owns the producing session. Shared retention may evict stopped records from
other threads, never live ones. Report `persist_error` separately from
native completion and capture.

`output_tail` is bounded. `claude_interactive_read_log` remains a best-effort
reader for rendered, capped terminal output. Its `eof` means the log's end,
not complete native answer recovery. Use the answer reader for stored
answers and report unavailable capture honestly.

When stopping a session, check `stop.exited`. If it is `false`, the stop signal
was sent but the PTY bridge did not confirm exit within the wait window.
