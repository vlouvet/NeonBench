#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> Building frontend"
( cd web && npm install --silent && npm run build )

echo "==> Cross-compiling Go binary"
mkdir -p "$ROOT/dist"
TARGETS=(
  "darwin/arm64"
  "darwin/amd64"
  "linux/amd64"
  "windows/amd64"
)
for t in "${TARGETS[@]}"; do
  os="${t%/*}"
  arch="${t#*/}"
  out="$ROOT/dist/neonbench-${os}-${arch}"
  [[ "$os" == "windows" ]] && out+=".exe"
  echo "  -> $out"
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "$out" ./cmd/neonbench
done

echo "==> Done. Artifacts in $ROOT/dist/"
ls -lh "$ROOT/dist/"
