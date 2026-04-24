#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd uninstallation is supported on macOS only." >&2
  exit 1
fi

BOOTSTRAP_DOMAIN="gui/$(id -u)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

for label in com.qi.claude-openrouter-ttl-1h com.qi.claude-cache-status; do
  launchctl bootout "$BOOTSTRAP_DOMAIN/$label" >/dev/null 2>&1 || true
  rm -f "$LAUNCH_AGENTS_DIR/$label.plist"
  echo "Removed $label"
done
