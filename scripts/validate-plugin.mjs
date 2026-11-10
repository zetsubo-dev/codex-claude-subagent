#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = fs.realpathSync(path.resolve(process.argv[2] || path.join(root, "plugins/codex-claude-subagent")));
function entry(relative, directory = false) {
  assert.equal(typeof relative, "string", "Manifest paths must be strings");
  const target = fs.realpathSync(path.resolve(plugin, relative));
  assert(target.startsWith(`${plugin}${path.sep}`), `Path escapes the plugin: ${relative}`);
  assert(directory ? fs.statSync(target).isDirectory() : fs.statSync(target).isFile(), `Invalid entry: ${relative}`);
  return target;
}
const manifest = JSON.parse(fs.readFileSync(entry(".codex-plugin/plugin.json"), "utf8"));
assert.match(manifest.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid plugin name");
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/, "Invalid plugin version");
assert.equal(typeof manifest.description, "string", "Missing plugin description");
assert(manifest.description.trim(), "Empty plugin description");
assert.equal(typeof manifest.interface?.displayName, "string", "Missing display name");
for (const relative of [manifest.skills].flat()) {
  const skills = entry(relative, true);
  const names = fs.readdirSync(skills).filter((name) => fs.statSync(path.join(skills, name)).isDirectory());
  assert(names.length, "No bundled skills");
  for (const name of names) {
    const text = fs.readFileSync(entry(path.relative(plugin, path.join(skills, name, "SKILL.md"))), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    assert(
      frontmatter && /^name:\s*\S+/m.test(frontmatter) && /^description:\s*\S+/m.test(frontmatter),
      `Missing skill metadata: ${name}`,
    );
  }
}
const config = JSON.parse(fs.readFileSync(entry(manifest.mcpServers), "utf8"));
assert(config.mcpServers && Object.keys(config.mcpServers).length, "Missing MCP server configuration");
for (const [name, server] of Object.entries(config.mcpServers)) {
  assert.equal(typeof server.command, "string", `Missing command: ${name}`);
  assert(server.command.trim(), `Empty command: ${name}`);
  assert(Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string"), `Invalid args: ${name}`);
  for (const arg of server.args) if (arg.startsWith("./")) entry(arg);
  for (const field of ["startup_timeout_sec", "tool_timeout_sec"]) {
    if (server[field] !== undefined) assert(Number.isFinite(server[field]) && server[field] > 0, `Invalid ${field}`);
  }
}
console.log("Plugin validation passed (repository-owned validator).");
