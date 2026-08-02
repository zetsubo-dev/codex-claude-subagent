#!/bin/zsh

set -euo pipefail

script_dir="${0:A:h}"
marketplace_path="${script_dir}/.agents/plugins/marketplace.json"

if [[ ! -f "$marketplace_path" ]]; then
  print "Could not find the plugin marketplace file:"
  print "  $marketplace_path"
  print "Run this installer from the extracted Codex–Claude Subagent folder."
  exit 1
fi

if ! command -v open >/dev/null 2>&1; then
  print "The macOS 'open' command is unavailable."
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  marketplace_url="$(python3 - "$marketplace_path" <<'PY'
import sys
from urllib.parse import quote

print(quote(sys.argv[1], safe="/:"))
PY
)"
else
  print "Python 3 is required to open the Codex plugin installer."
  print "Install Python 3, then double-click Install.command again."
  exit 1
fi

open "codex://plugins/?marketplacePath=${marketplace_url}"
print "Codex–Claude Subagent installation completed."
