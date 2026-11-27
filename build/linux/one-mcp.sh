#!/usr/bin/env sh
# One's MCP server over stdio, for MCP clients (LM Studio, Codex CLI, Claude).
#   It prints nothing itself: stdout belongs to the protocol. Switch it on first: One → Settings → MCP server.
#   Extra arguments pass through:  ./one-mcp.sh --folder notes --read-only
# Runs in the bundled app itself, without a window (no display needed) — no Node.js install needed.
unset CDPATH # cd would print the folder it found (stdout is the protocol channel)
SELF="$(readlink -f -- "$0" 2>/dev/null || printf '%s' "$0")"
DIR="$(cd -- "$(dirname -- "$SELF")" && pwd)"
unset ELECTRON_RUN_AS_NODE
exec "$DIR/one" --ozone-platform=headless --mcp-stdio "$@"
