#!/usr/bin/env bash
set -euo pipefail

# Optional VERSION env var: if set, baked into the binary via -ldflags so
# `neonbench --version` prints it. Defaults to "dev" for local hacking.
# Example: VERSION=v1.0.0 ./scripts/build.sh
VERSION="${VERSION:-dev}"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> Building frontend"
( cd web && npm install --silent && npm run build )

echo "==> Cross-compiling Go binary (version=${VERSION})"
mkdir -p "$ROOT/dist"
TARGETS=(
  "darwin/arm64"
  "darwin/amd64"
  "linux/amd64"
  "windows/amd64"
)
LDFLAGS="-s -w -X 'github.com/vlouvet/neonbench/internal/version.Version=${VERSION}'"
for t in "${TARGETS[@]}"; do
  os="${t%/*}"
  arch="${t#*/}"
  out="$ROOT/dist/neonbench-${os}-${arch}"
  [[ "$os" == "windows" ]] && out+=".exe"
  echo "  -> $out"
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags="${LDFLAGS}" -o "$out" ./cmd/neonbench
done

echo "==> Done. Artifacts in $ROOT/dist/"
ls -lh "$ROOT/dist/"
