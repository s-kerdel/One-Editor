#!/usr/bin/env sh
# One in your browser: serves a folder on http://127.0.0.1 (port 4317+) and opens the browser.
#   ./start-web.sh [folder] [--port N] [--host 127.0.0.1]     (Ctrl+C stops the server)
# Uses the bundled app in Node mode — no Node.js install needed.
DIR="$(cd "$(dirname "$0")" && pwd)"
FOLDER="${1:-$PWD}"
[ $# -gt 0 ] && shift
ELECTRON_RUN_AS_NODE=1 exec "$DIR/one" "$DIR/resources/app.asar.unpacked/dist/server/cli.mjs" "$FOLDER" --open "$@"
