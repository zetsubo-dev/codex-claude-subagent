# Codex–Claude Subagent

An MCP plugin for the Codex desktop app and Codex CLI that uses interactive
Claude Code sessions as role-controlled subagents for exploration, code review,
and implementation.

Sessions remain observable and resumable from Codex. The plugin does not use
the Claude API, `claude -p`, API-key billing, or nested agents.
It uses the Claude Code installation already available on your Mac and does not
install Claude Code for you.

## Install

You need macOS, Node.js 20 or newer, Python 3, a plugin-enabled Codex desktop
app or Codex CLI, and Claude Code already signed in with an active `claude.ai`
subscription.

### Codex desktop app from a ZIP

The easiest way to install the plugin in the Codex desktop app is:

1. [Download the distribution ZIP from the latest GitHub Release](https://github.com/zetsubo-dev/codex-claude-subagent/releases/latest)
2. Double-click the downloaded release ZIP file to extract it.
3. Open the extracted folder and double-click `Install.command` to install the plugin.

If macOS blocks the installer the first time, right-click `Install.command`,
choose **Open**, and confirm.

### Codex CLI from GitHub

For Codex CLI, add the GitHub marketplace and install the plugin:

```sh
codex plugin marketplace add zetsubo-dev/codex-claude-subagent
codex plugin add codex-claude-subagent@codex-claude-subagent
```

## Quick start

After installation, start a new Codex conversation. No additional command or
special plugin syntax is required. Describe the task in natural language and
mention Claude when you want Codex to delegate it to Claude Code.

Examples:

- `Ask Claude to review this change.`
- `Have Claude investigate the cause of this test failure.`
- `Ask Claude to implement this fix.`

### Choose the Claude model and effort

Specify the model and reasoning effort in the same request when needed:

- `Ask Claude Sonnet to review this change with medium effort.`
- `Investigate this issue with Claude Opus using high effort.`

The requested model and effort are passed through to Claude Code. If you omit
either value, Claude Code uses its own default.

If this plugin is useful to you, please consider giving the repository a star.
It helps others discover the project and supports further development.

## License

This project is released under the [MIT License](LICENSE).
