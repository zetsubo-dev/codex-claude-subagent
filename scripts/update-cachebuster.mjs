#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "plugins/codex-claude-subagent/.codex-plugin/plugin.json");
const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
const { version } = JSON.parse(fs.readFileSync(path.join(root, "plugins/codex-claude-subagent/package.json"), "utf8"));
const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
manifest.version = `${version}+codex.${timestamp}.${crypto.randomBytes(3).toString("hex")}`;
fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Updated plugin cachebuster: ${manifest.version}`);
