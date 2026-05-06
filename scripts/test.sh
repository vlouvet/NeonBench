#!/usr/bin/env bash
# Run the full automated test suite: Go unit + integration tests, then the
# frontend vitest suite. Used in CI and as a quick "is the build alive"
# check before manual smoke testing in the browser.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "→ go test ./..."
# Filter out web/node_modules — npm packages occasionally ship a stray
# Go file (e.g. flatted/golang/) that go list otherwise tries to compile.
go test $(go list ./... | grep -v '/web/node_modules/')

echo ""
echo "→ vitest (web/)"
cd web && npm test
