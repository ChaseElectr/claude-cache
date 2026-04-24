#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd installation is supported on macOS only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCHD_DIR="$PROJECT_ROOT/launchd"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
BOOTSTRAP_DOMAIN="gui/$(id -u)"

PROXY_LABEL="com.qi.claude-openrouter-ttl-1h"
STATUS_LABEL="com.qi.claude-cache-status"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
CLAUDE_CACHE_HOST="${CLAUDE_CACHE_HOST:-127.0.0.1}"
CLAUDE_CACHE_PORT="${CLAUDE_CACHE_PORT:-3456}"
CLAUDE_CACHE_STATUS_URL="${CLAUDE_CACHE_STATUS_URL:-http://${CLAUDE_CACHE_HOST}:${CLAUDE_CACHE_PORT}/__status}"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js was not found. Install Node.js 20+ or set NODE_BIN=/path/to/node." >&2
  exit 1
fi

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\/&]/\\&/g'
}

escape_xml() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

template_value() {
  escape_sed_replacement "$(escape_xml "$1")"
}

render_template() {
  local template="$1"
  local target="$2"
  local status_app_path="$PROJECT_ROOT/menubar-app/.build/release/ClaudeCacheStatusApp"

  sed \
    -e "s/__NODE_BIN__/$(template_value "$NODE_BIN")/g" \
    -e "s/__PROJECT_ROOT__/$(template_value "$PROJECT_ROOT")/g" \
    -e "s/__HOME__/$(template_value "$HOME")/g" \
    -e "s/__STATUS_APP_PATH__/$(template_value "$status_app_path")/g" \
    -e "s/__CLAUDE_CACHE_HOST__/$(template_value "$CLAUDE_CACHE_HOST")/g" \
    -e "s/__CLAUDE_CACHE_PORT__/$(template_value "$CLAUDE_CACHE_PORT")/g" \
    -e "s/__CLAUDE_CACHE_STATUS_URL__/$(template_value "$CLAUDE_CACHE_STATUS_URL")/g" \
    "$template" > "$target"
}

install_agent() {
  local label="$1"
  local template="$2"
  local target="$LAUNCH_AGENTS_DIR/$label.plist"

  render_template "$template" "$target"
  chmod 644 "$target"
  plutil -lint "$target" >/dev/null
  launchctl bootstrap "$BOOTSTRAP_DOMAIN" "$target"
  launchctl enable "$BOOTSTRAP_DOMAIN/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "$BOOTSTRAP_DOMAIN/$label" >/dev/null 2>&1 || true
}

echo "Building menu bar app..."
swift build -c release --package-path "$PROJECT_ROOT/menubar-app"

mkdir -p "$LAUNCH_AGENTS_DIR" "$HOME/Library/Logs"

launchctl bootout "$BOOTSTRAP_DOMAIN/$PROXY_LABEL" >/dev/null 2>&1 || true
launchctl bootout "$BOOTSTRAP_DOMAIN/$STATUS_LABEL" >/dev/null 2>&1 || true

install_agent "$PROXY_LABEL" "$LAUNCHD_DIR/$PROXY_LABEL.plist.template"
install_agent "$STATUS_LABEL" "$LAUNCHD_DIR/$STATUS_LABEL.plist.template"

echo "Installed LaunchAgents:"
echo "  $LAUNCH_AGENTS_DIR/$PROXY_LABEL.plist"
echo "  $LAUNCH_AGENTS_DIR/$STATUS_LABEL.plist"
echo "Proxy status: $CLAUDE_CACHE_STATUS_URL"
