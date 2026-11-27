#!/usr/bin/env sh
# One in your browser: serves a folder on http://127.0.0.1 (port 4317+) and opens the browser.
#   ./start-web.sh [folder] [--port N] [--host 127.0.0.1]     (Ctrl+C stops the server)
# Runs in the bundled app itself, without a window (no display needed) — no Node.js install needed.
DIR="$(cd "$(dirname "$0")" && pwd)"
FOLDER="${1:-$PWD}"
[ $# -gt 0 ] && shift
unset ELECTRON_RUN_AS_NODE
exec "$DIR/one" --ozone-platform=headless --serve "$FOLDER" --open "$@"
