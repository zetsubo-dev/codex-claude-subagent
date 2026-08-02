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
- It does not expose Claude background agents, tmux, or nested agent/team tools.
- It does not automatically commit or push changes.

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
The returned `policy.implementer_requires_claude_worktree` field is `true`, and
the role records expose `mode`, `mutates_files`, `requires_worktree`, and
`filesystem_isolation`.

| Role | Purpose | File changes | Worktree |
| --- | --- | ---: | ---: |
| `explorer` | Find relevant files, structure, and evidence. | No | Not required |
| `reviewer` | Review correctness and maintainability. | No | Not required |
| `security_reviewer` | Review security risks. | No | Not required |
| `critic` | Provide an adversarial second opinion. | No | Not required |
| `architect` | Propose design and refactoring direction. | No | Not required |
| `implementer` | Implement a change and run checks. | Yes | Required |

Read-only roles use Claude Code's plan mode and reject editing tools, worktrees,
and nested-agent overrides. The `implementer` role uses `Edit` and `Write` with
a required dedicated Git worktree. The worktree separates normal repository
changes, but is not an OS-level filesystem sandbox; the implementation boundary
forbids absolute-path or outside-worktree changes, commits, pushes, and publish
operations.

For implementation, the minimum start request is:

```json
{
  "cwd": "/absolute/path/to/project",
  "role": "implementer",
  "claude_worktree": "codex-implementation"
}
```

For review or investigation, use `explorer`, `reviewer`, or the more specialized
read-only roles instead. The role boundary is supplied by the plugin; the
calling agent does not need to recreate it in every prompt.

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

The model and effort are fixed for a live session. To change them while
preserving the Claude conversation, stop the session and resume the exact
`claude_session_id` with the same `cwd` and `role`, supplying the new values.

Other allowlisted Claude Code interactive flags can be passed through
`claude_args`. The current allowlist covers diagnostics, verbosity, IDE
connection, slash-command disabling, prompt suggestions, and Chrome disabling;
the live policy reports the exact list. The plugin rejects unknown flags and
flags that would change the contract: `-p` / print mode, background, tmux,
Remote Control, nested-agent or plugin loading, permission/session/worktree
fields managed by the structured request, and output formats intended for
non-interactive use.

## Hosts

The plugin is packaged for the Codex plugin system and is intended to work in:

- Codex desktop app (the primary local-app workflow).
- Codex CLI, which supports installing and running Codex plugins.

In both hosts, Codex is the calling agent and Claude Code is the leaf
subagent; the plugin does not create nested Claude agents or teams.

## Requirements

- macOS
- Codex desktop app or Codex CLI with plugin support
- Node.js 20 or newer
- Python 3
- Claude Code with the interactive, session, and worktree options required by
  the selected role
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
