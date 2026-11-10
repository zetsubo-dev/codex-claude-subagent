# Codex–Claude Subagent

Codex–Claude Subagent is a Codex MCP plugin that exposes interactive Claude
Code sessions as role-controlled subagents for exploration, code review, and
implementation through the Model Context Protocol. It is backed by the user's
`claude.ai` subscription. This is the core distinction from API-based or
non-interactive integrations: it does not call the Claude API or use
`claude -p`.

The session remains observable and resumable, and the caller chooses an
explicit role so Claude is used consistently for exploration, review, or
implementation.

## What it does

- Starts and resumes interactive Claude Code sessions.
- Sends requests and reports completion, waiting, errors, and permission
  attention as structured MCP results.
- Reads terminal output and long persisted logs.
- Lists and stops sessions.
- Exposes role defaults and safety rules through
  `codex_claude_subagent_info`, so Codex can select the right mode
  without guessing from prose.

## What it does not do

- It does not use `claude -p` or another non-interactive print mode.
- It does not use Claude API keys or fall back to API billing.
- It does not launch background CLI sessions, tmux, or Agent Teams.
- It runs one Claude agent by default. Native subagents require an explicit request.
- It does not override Claude Code's normal edit, commit, push, or publish behavior.

Claude Code must be authenticated through `claude.ai`. The plugin rejects
API-key or Console authentication before starting a session, so usage is tied
to the user's Claude subscription login.

The plugin does not include or install Claude Code. It launches the `claude`
executable already installed on the user's Mac through the normal `PATH`, uses
that installation's existing `claude.ai` login, and starts it with the
requested project directory as its working directory. If sign-in is required,
Codex will report that Claude Code needs authentication.

## Roles

The caller should first inspect `codex_claude_subagent_info`, then pass the
appropriate `role` to `claude_interactive_start`.
The returned `policy.implementer_requires_claude_worktree` field is `false`, and
the role records expose `mode`, `mutates_files`, `requires_worktree`, and
`filesystem_isolation`.

| Role | Purpose | File changes | Worktree |
| --- | --- | ---: | ---: |
| `explorer` | Find relevant files, structure, and evidence. | No | Not required |
| `reviewer` | Review correctness and maintainability. | No | Not required |
| `security_reviewer` | Review security risks. | No | Not required |
| `critic` | Provide an adversarial second opinion. | No | Not required |
| `architect` | Propose design and refactoring direction. | No | Not required |
| `implementer` | Implement a change and run checks in the target project. | Yes | Not used |

All roles start Claude Code with `--permission-mode bypassPermissions`.
Claude Code's interaction-required tools, organization policy, and protected
operations can still require attention; bypass does not promise zero dialogs.
The `permission_mode` input accepts only `bypassPermissions`. Read-only roles
retain their non-mutating instructions and reject editing tools and
nested-agent overrides. The `implementer` role uses `Edit`, `Write`, and the
target project directory supplied as `cwd`, matching normal Claude Code
behavior. Claude Code retains its normal ability to edit, commit, push, and
publish according to the target project's instructions and account permissions.

For implementation, the minimum start request is:

```json
{
  "cwd": "/absolute/path/to/project",
  "role": "implementer"
}
```

For review or investigation, use `explorer`, `reviewer`, or the more specialized
read-only roles instead. The role boundary is supplied by the plugin; the
calling agent does not need to recreate it in every prompt.

## Calling it from Codex

Ask Codex, for example, "Have Claude review this with Opus and high effort" or
"Have Claude implement this using Fable and xhigh effort; allow its subagents."
Codex maps these instructions to `role`, `model`, `effort`, and
`subagent_mode` in the start tool. The plugin itself does not parse natural language.
Selecting a plugin or skill explicitly also makes the intended route clear.

The MCP server connecting and Codex choosing a tool are separate steps.
An ordinary review request does not automatically delegate to Claude. The
calling skill discovers deferred tools, checks `codex_claude_subagent_info`,
then starts a session when Claude involvement is requested.

`role` defaults to `reviewer`; `subagent_mode` defaults to `disabled` for every
role. Use `subagent_mode: "auto"` explicitly with `implementer` to expose the
native Agent tool. Claude Code decides whether and how to delegate; the adapter
does not add a planner. Explicit `tools` lists are never expanded silently.
Read-only roles currently reject `auto`, because custom-agent tool inheritance
has not been proven to preserve their tool boundary. Project MCP can expose
other delegation tools; this is a built-in-tool contract, not an OS sandbox.

## Model and effort selection

The calling agent can choose the Claude model and effort for each new session:

```json
{
  "role": "reviewer",
  "model": "sonnet",
  "effort": "medium"
}
```

`model` accepts any alias or full model ID supported by the installed Claude
Code. `effort` is also passed through unchanged, so new Claude Code values do
not require a plugin release. If Claude Code rejects a value, start the session
again with a value supported by that installation.

When the caller omits `model` or `effort`, the plugin omits that CLI option and
Claude Code uses its own default. The default therefore comes from the installed
Claude Code, the user's account, and its normal settings sources. There is no
automatic model fallback injected by the plugin.

The response's `requested_model` and `requested_effort` are requested values,
not proof of effective selection. `observed` records what the observer saw;
`last_api_model` means the final API response's model, not every step's model.
An inherited `CLAUDE_CODE_EFFORT_LEVEL` outranks `--effort`; a conflicting
explicit request is rejected before launch instead of silently using another
level. Omitted values preserve normal Claude Code settings and environment.
Recent models use per-model effort settings; an older user-level
`effortLevel: "high"` does not necessarily apply to a newer model.

The model and effort are fixed for a live session. To change them while
preserving the Claude conversation, stop the session and resume the exact
`claude_session_id` with the same `cwd` and `role`, supplying the new values.

Other allowlisted Claude Code interactive flags can be passed through
`claude_args`. The current allowlist covers diagnostics, verbosity, IDE
connection, slash-command disabling, prompt suggestions, and Chrome disabling;
the live policy reports the exact list. The plugin rejects unknown flags and
flags that would change the contract: `-p` / print mode, background, tmux,
Remote Control, nested-agent or plugin loading, permission/session fields
managed by the structured request, and output formats intended for
non-interactive use.

## Hosts

The plugin is packaged for the Codex plugin system and is intended to work in:

- Codex desktop app (the primary local-app workflow).
- Codex CLI, which supports installing and running Codex plugins.

In both hosts, Codex is the calling agent. Claude runs alone by default;
explicitly enabled native delegation is decided by Claude Code.

## Completion and startup

A bundled passive Claude Code Mod observes `turn.start` and `turn.complete`
for this session. It does not change prompts, model requests, permissions, or
user Stop hooks. Completion is correlated by session generation, Claude UUID,
request token, and main turn ID. Child-agent completion cannot finish the
parent request. Normal completion does not wait for the roughly 60-second
`idle_prompt` notification. Stop and printed markers alone never establish
success, including when hooks or Mods cannot load.

Startup checks the observer handshake before sending any request. If workspace
trust or the bypass warning needs attention, no request is sent; review the
prompt in your own Claude Code terminal, then start a new plugin session.
An already recorded user-level bypass acceptance is carried into private
session settings, including with `mcp_preset: "none"`; no new acceptance is
created and user/project settings are not edited.

`done: true` means the correlated **main turn** ended, not that all project
work has been accepted. `completion_scope` is `main_turn`.
`work_pending` reports observed background tasks; `count_unknown` means that
their count was unavailable. Interpret these flags with the completed turn's
result, not as acceptance of the whole task. Future cron schedules are reported separately
and do not block completion. Codex must check the expected jobs, results and
artifacts before declaring the user's task complete. For example:

```json
{ "done": true, "completion_scope": "main_turn", "work_pending": true,
  "background_tasks_pending": 1, "count_unknown": false }
```

Tokenless main turns update `latest_native_outcome` on the session, never
another request. Sending is rejected while an observed native main turn is
active or a record is incomplete; use read/wait or stop. This check is
best-effort: a turn can start between checking and writing input, which Claude
Code can queue. Without a correlated native completion, the adapter never
claims that request completed. Timeout keeps the request ID and input lock;
continue with `claude_interactive_wait_request` rather than resending text.
If a Mod is blocked or its records are unavailable, report the startup or
observation failure; do not promote Stop, a marker, or silence to success.
If a record remains incomplete (for example after a disk write failure), stop
the session and resume its exact Claude UUID after resolving the cause.

## Requirements

- macOS
- Codex desktop app or Codex CLI with plugin support
- Node.js 20 or newer
- Python 3
- Claude Code 2.1.322 or newer, with local observer Mods permitted
- An active `claude.ai` subscription login in Claude Code

Linux and Windows are not currently supported because the local PTY bridge is
macOS-oriented.

## Install from GitHub

For the Codex desktop app:

1. [Download the distribution ZIP from the latest GitHub Release](https://github.com/zetsubo-dev/codex-claude-subagent/releases/latest)
2. Double-click the downloaded release ZIP file to extract it.
3. Open the extracted folder and double-click `Install.command` to install the plugin.
4. Start a new Codex conversation.

If macOS blocks the installer the first time, right-click `Install.command`,
choose **Open**, and confirm.

For Codex CLI, register the GitHub marketplace:

```sh
codex plugin marketplace add zetsubo-dev/codex-claude-subagent
codex plugin add codex-claude-subagent@codex-claude-subagent
```

Start a new Codex conversation after installation so the plugin's MCP tools and
skill are loaded.

## MCP tools

- `claude_interactive_start` — start a role-controlled session.
- `claude_interactive_request` — submit a request and wait for completion.
- `claude_interactive_wait_request` — continue a pending request without sending
  it again.
- `claude_interactive_send` — send manual follow-up input.
- `claude_interactive_read` / `claude_interactive_read_log` — inspect output.
- `claude_interactive_list` / `claude_interactive_saved_sessions` — inspect live
  and resumable sessions.
- `claude_interactive_stop` — stop a session.
- `codex_claude_subagent_info` — inspect the live role and policy contract.

Use `claude_interactive_request` for normal agent-to-agent work because it
returns request-level completion state. If it returns on idle or timeout, use
the returned request ID with `claude_interactive_wait_request`; do not resend
the original request.

## MCP discovery

The default `mcp_preset: "auto"` lets Claude Code use its normal user, project,
and local settings, including project instructions and configured MCP servers.
Use `mcp_preset: "none"` only when the caller explicitly needs an MCP-free
session.

## License

This plugin is released under the [MIT License](LICENSE).
