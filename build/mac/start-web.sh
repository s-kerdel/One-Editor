#!/usr/bin/env sh
# One in your browser: serves a folder on http://127.0.0.1 (port 4317+) and opens the browser.
#   ./start-web.sh [folder] [--port N] [--host 127.0.0.1]     (Ctrl+C stops the server)
# Runs in the bundled app itself, without a window — no Node.js install needed.
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/One.app/Contents"
[ -d "$APP" ] || APP="/Applications/One.app/Contents" # this script copied elsewhere: the installed app
FOLDER="${1:-$PWD}"
[ $# -gt 0 ] && shift
unset ELECTRON_RUN_AS_NODE
exec "$APP/MacOS/one" --serve "$FOLDER" --open "$@"
