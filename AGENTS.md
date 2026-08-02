# Codex–Claude Subagent

## Repository shape

This repository is a local Codex marketplace containing one independently
packaged plugin:

```text
.agents/plugins/marketplace.json       local marketplace entry
package.json                           root development command wrapper
plugins/codex-claude-subagent/         plugin source and standalone package
```

The plugin directory is the package boundary. Keep its `package.json` and
bundled `server.bundle.mjs` valid for installation without relying on the
repository root.

The root `package.json` is intentionally private and contains development-only
tooling. The repository is a pnpm workspace; the root lockfile covers the root
tooling and the plugin's build dependency.

## Naming contract

- Display name: `Codex–Claude Subagent`
- Plugin identifier: `codex-claude-subagent`
- MCP server key: `codex_claude_subagent`
- Plugin-specific environment variables: `CODEX_CLAUDE_SUBAGENT_*`
- Default state directory: `~/.codex/codex-claude-subagent`

Keep generated MCP tool names, package metadata, documentation, tests, and
marketplace metadata aligned with this contract.

## Development commands

Run commands from the repository root:

```sh
pnpm run deps:install
pnpm run verify
```

Useful focused commands are `pnpm run build`, `pnpm run format:check`,
`pnpm run lint`, `pnpm run check`, `pnpm test`, `pnpm run smoke`, and
`pnpm run smoke:package`. The live smoke test is opt-in:

```sh
pnpm run smoke:live -- /absolute/project/path
```

`server.bundle.mjs` is a committed generated artifact. Edit source files under
the plugin, then run `pnpm run build`; do not hand-edit the bundle.

## Release and distribution

The end-user distribution is a prebuilt ZIP containing the repository
marketplace and `Install.command`. `Install.command` is a tracked installer
source file; `pnpm run build` does not generate it. The release packaging
command verifies the bundle and tests first, then creates the ZIP under the
ignored `dist/` directory:

```sh
pnpm run plugin:cachebuster
pnpm run release:package
```

Before running the commands, update the root package, plugin package, and
manifest base versions together. Review the generated
`dist/codex-claude-subagent-v<VERSION>.zip` and confirm it contains
`Install.command`, both `LICENSE` files, `.agents/plugins/marketplace.json`,
the bundled server, and both bridge scripts. Do not include `node_modules` or
development-only files in the release ZIP. Commit the source, generated bundle,
installer, license, and metadata changes; attach the generated ZIP to the
matching GitHub Release.

Oxfmt formats JavaScript and JSON from the repository root. It excludes the
generated bundle, lockfiles, Markdown, and Python files. Oxlint checks the
Node.js sources with warnings denied. Python receives syntax coverage through
the existing compile check; do not add a second Python package tool without a
concrete need.

## Boundaries

- Codex remains responsible for edits and final integration.
- The plugin exposes interactive Claude Code sessions for exploration, review,
  planning, and implementation.
- Do not add orchestration policy to this adapter; keep reusable orchestration
  behavior in its own skill or project-level instructions.
- Preserve unrelated worktree changes and do not commit unless explicitly
  requested.
