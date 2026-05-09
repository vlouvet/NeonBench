#!/usr/bin/env bash
# Local dev convenience: rebuild + (re)launch NeonBench.
#
# Order of operations:
#   1. Kill any running `bin/neonbench` instance (SIGTERM, then SIGKILL
#      if it doesn't exit within ~0.5s).
#   2. Rebuild the web bundle (the Go binary embeds web/dist/ at build
#      time, so a stale bundle silently produces a stale UI).
#   3. Rebuild the Go binary at bin/neonbench.
#   4. Run the freshly built binary in the foreground; Ctrl-C stops it.
#
# Anything passed on the command line gets forwarded to the binary, so
# the usual --port / --data-dir / --no-open / --log-level flags work:
#
#   ./scripts/run.sh
#   ./scripts/run.sh --port 5174 --log-level debug
#   ./scripts/run.sh --no-open
#
# To embed a real version string for testing the self-update flow:
#
#   VERSION=v0.0.1-local ./scripts/run.sh --version
#
# Macros for cross-compile + signed releases live in scripts/build.sh —
# this script is only for the local-dev round-trip.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${VERSION:-dev}"
MODULE="github.com/vlouvet/neonbench"

# 1. Kill any running instance. -f matches against the full command
# line so this catches "./bin/neonbench", "/abs/path/bin/neonbench",
# etc. Self-match (this script's name) is filtered with $0 exclusion.
if pgrep -f 'bin/neonbench' >/dev/null 2>&1; then
  echo "→ killing running NeonBench instance(s)…"
  pkill -TERM -f 'bin/neonbench' || true
  # Brief beat for the OS to release the listening port; without this
  # the new instance can hit "address already in use" on the next bind.
  sleep 0.5
  if pgrep -f 'bin/neonbench' >/dev/null 2>&1; then
    pkill -KILL -f 'bin/neonbench' || true
    sleep 0.2
  fi
fi

# 2. Web bundle. Skip npm install — assume the developer has run it
# once. CI does the full install; this is the inner-loop helper.
echo "→ building web bundle…"
( cd web && npm run build )

# 3. Go binary. Honor the VERSION env var so this script can stand in
# for the release CI workflow during local self-update testing.
echo "→ building Go binary (version=${VERSION})…"
go build \
  -ldflags "-X '${MODULE}/internal/version.Version=${VERSION}'" \
  -o bin/neonbench \
  ./cmd/neonbench

# 4. Run in the foreground. exec replaces this shell so Ctrl-C
# delivers SIGINT to the binary directly, not to the script.
echo "→ starting NeonBench (Ctrl-C to stop)…"
exec ./bin/neonbench "$@"
