#!/usr/bin/env bash
# Installs the repo's git hooks by pointing core.hooksPath at .githooks/.
# Run once per clone. Re-running is safe.
set -euo pipefail

cd "$(dirname "$0")/.."

git config core.hooksPath .githooks
chmod +x .githooks/*

echo "✓ Hooks installed (core.hooksPath = .githooks)."
echo "  Pre-push will block direct pushes to 'main'. Override: GIT_PUSH_TO_MAIN_OK=1"
