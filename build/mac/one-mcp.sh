#!/usr/bin/env sh
# One's MCP server over stdio, for MCP clients (LM Studio, Codex CLI, Claude).
#   It prints nothing itself: stdout belongs to the protocol. Switch it on first: One → Settings → MCP server.
#   Extra arguments pass through:  ./one-mcp.sh --folder notes --read-only
# Runs in the bundled app itself, without a window or Dock icon — no Node.js install needed.
unset CDPATH # cd would print the folder it found (stdout is the protocol channel)
DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
APP="$DIR/One.app/Contents"
[ -d "$APP" ] || APP="/Applications/One.app/Contents" # this script copied elsewhere: the installed app
unset ELECTRON_RUN_AS_NODE
exec "$APP/MacOS/one" --mcp-stdio "$@"
