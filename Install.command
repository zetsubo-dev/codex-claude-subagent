#!/bin/zsh

set -euo pipefail

script_dir="${0:A:h}"
node_binary=""
for candidate in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$candidate" ]] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    node_binary="$candidate"
    break
  fi
done
if [[ -z "$node_binary" ]]; then
  print "Node.js 20 or newer is required. Install it, then run Install.command again."
  exit 1
fi

exec "$node_binary" "$script_dir/scripts/install.mjs"
