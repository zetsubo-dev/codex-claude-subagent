# Codex–Claude Subagent

An MCP plugin for the Codex desktop app and Codex CLI that uses interactive
Claude Code sessions as role-controlled subagents for exploration, code review,
and implementation.

Sessions remain observable and resumable from Codex. The plugin does not use
the Claude API, `claude -p`, or API-key billing. Claude runs alone by default;
its native subagents are available for implementation only when explicitly requested.
It uses the Claude Code installation already available on your Mac and does not
install Claude Code for you.

## Install

You need macOS, Node.js 20 or newer, Python 3, a plugin-enabled Codex desktop
app or Codex CLI, Git with access to GitHub, and Claude Code 2.1.322 or newer already signed in with an active `claude.ai`
subscription.

The lifecycle observer uses Claude Code's early-access Mods API. Claude Code
updates may require a compatibility update to this plugin. See the
[compatibility notes](plugins/codex-claude-subagent/README.md#requirements) and
[saved-session limits](plugins/codex-claude-subagent/README.md#saved-session-retention)
before relying on unattended or long-term resume workflows.

### Codex desktop app from a ZIP

The easiest way to install the plugin in the Codex desktop app is:

1. [Download the distribution ZIP from the latest GitHub Release](https://github.com/zetsubo-dev/codex-claude-subagent/releases/latest)
2. Double-click the downloaded release ZIP file to extract it.
3. Open the extracted folder and double-click `Install.command` to install the plugin.

If macOS blocks the installer the first time, right-click `Install.command`,
choose **Open**, and confirm.

Internet access is required. The installer uses Codex CLI (from your PATH or
the desktop app), checks that the published Git files match this ZIP, then
installs or updates the same plugin ID and verifies its installed contents.
An outdated or mismatched ZIP is rejected before replacing the plugin; download
the latest ZIP instead. Re-running the same verified version does not replace
its cache. If an older cache is in use, close the app and running Codex CLI chats
and retry. Start a new chat after updating; existing chats are not switched.

If an older ZIP installation reports a marketplace source conflict, close Codex
and its CLI chats, run `codex plugin marketplace remove codex-claude-subagent`,
then run `Install.command` again. Removing the source registration leaves the
original extracted folder and plugin cache intact. The installer then registers
the official Git source and updates the same plugin ID.

### Codex CLI from GitHub

For Codex CLI, add the GitHub marketplace and install the plugin:

```sh
codex plugin marketplace add zetsubo-dev/codex-claude-subagent
codex plugin add codex-claude-subagent@codex-claude-subagent
```

For an existing Git installation, close running Codex sessions before updating:

```sh
codex plugin marketplace upgrade codex-claude-subagent
codex plugin add codex-claude-subagent@codex-claude-subagent
```

These commands update the existing plugin ID, not a second installation.
For the verified update and busy-cache checks, use `Install.command` instead.

## Quick start

After installation, start a new Codex conversation. No additional command or
special plugin syntax is required. Describe the task in natural language and
mention Claude or a named Claude model such as Fable or Opus when you want
Codex to delegate it to Claude Code. A plain request such as "review this"
stays with Codex and does not request a Claude session.

Examples:

- `Ask Claude to review this change.`
- `Have Claude investigate the cause of this test failure.`
- `Ask Claude to implement this fix.`
- `FableとOpusでレビューして` — request separate reviews from both models.

A review request returns findings; it does not automatically authorize fixes
or repeated fix/re-review cycles. Ask for those explicitly when wanted.

### Choose the Claude model and effort

Specify the model and reasoning effort in the same request when needed:

- `Ask Claude Sonnet to review this change with medium effort.`
- `Investigate this issue with Claude Opus using high effort.`

Requested model and effort values are passed through to Claude Code. New
reviews default to Opus when no model is named. Other roles use Claude Code's
model default, and unspecified effort always uses Claude Code's default.

If this plugin is useful to you, please consider giving the repository a star.
It helps others discover the project and supports further development.

## License

This project is released under the [MIT License](LICENSE).
