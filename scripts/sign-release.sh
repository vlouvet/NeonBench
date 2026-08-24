#!/usr/bin/env bash
# Detached-sign a published release's SHA256SUMS with the maintainer's hardware
# key, then attach the signature to that release.
#
# CI deliberately does not do this. The signing key is a FIDO2 authenticator
# that must be physically touched, so GitHub Actions cannot reach it — that is
# the point, not a limitation. CI produces SHA256SUMS (see
# .github/workflows/release.yml); this is the manual step where the key holder
# vouches for those bytes.
#
# What the signature attests: "the holder of this key vouched for these hashes."
# It does NOT code-sign the binaries — Windows SmartScreen still warns. See the
# README's "Downloads and trust" section.
#
# Usage:
#   scripts/sign-release.sh v1.2.3             sign SHA256SUMS and upload the .sig
#   scripts/sign-release.sh v1.2.3 --dry-run   print what would run, change nothing
#   scripts/sign-release.sh v1.2.3 --verify    verify the signature already published
#   scripts/sign-release.sh --check            validate docs/allowed_signers (no key needed)
#
# Env:
#   SIGNING_KEY   private key path (default: ~/.ssh/id_ed25519_sk)
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# Absolute from here on: the sign/verify paths run from a scratch directory, so
# a relative path would resolve against the wrong root.
ALLOWED_SIGNERS="$REPO_ROOT/docs/allowed_signers"
SIGNING_KEY="${SIGNING_KEY:-$HOME/.ssh/id_ed25519_sk}"
SUMS="SHA256SUMS"
SIG="$SUMS.sig"
# ssh-keygen namespaces separate signature domains, so a signature made for one
# purpose cannot be replayed as another. "file" is the convention for file
# signing (git uses "git"). Verifiers MUST pass the same value.
NAMESPACE="file"

die() { echo "error: $*" >&2; exit 1; }

# Read the principal from the signers file rather than hardcoding it, so
# rotating the key updates signing and verification from one place.
signer_principal() {
  awk '!/^[[:space:]]*#/ && NF { print $1; exit }' "$ALLOWED_SIGNERS"
}

# Assert the fingerprint in the header comment still describes the key beneath
# it. Needs no hardware and no network, so CI can gate on it.
check_allowed_signers() {
  [ -f "$ALLOWED_SIGNERS" ] || die "$ALLOWED_SIGNERS not found"

  local entries documented actual tmp
  entries=$(awk '!/^[[:space:]]*#/ && NF' "$ALLOWED_SIGNERS" | wc -l | tr -d ' ')
  [ "$entries" = "1" ] ||
    die "expected exactly 1 signer entry in docs/allowed_signers, found $entries"

  documented=$(awk '/^#[[:space:]]*fingerprint:/ { print $3; exit }' "$ALLOWED_SIGNERS")
  [ -n "$documented" ] ||
    die "no '# fingerprint: SHA256:...' line in docs/allowed_signers"

  # ssh-keygen -lf needs a .pub file, so rebuild one from the signer entry.
  tmp=$(mktemp -t nb-signer.XXXXXX)
  awk '!/^[[:space:]]*#/ && NF { print $2, $3; exit }' "$ALLOWED_SIGNERS" > "$tmp"
  actual=$(ssh-keygen -lf "$tmp" 2>/dev/null | awk '{print $2}') || true
  rm -f "$tmp"
  [ -n "$actual" ] || die "ssh-keygen could not parse the key in docs/allowed_signers"

  [ "$documented" = "$actual" ] ||
    die "fingerprint drift: header says $documented, key is $actual"

  echo "✓ docs/allowed_signers: 1 signer, fingerprint $actual"
  echo "  principal: $(signer_principal)"
}

# Verifies $SIG against $SUMS in the current directory.
verify_sig() {
  ssh-keygen -Y verify -f "$ALLOWED_SIGNERS" -I "$(signer_principal)" \
    -n "$NAMESPACE" -s "$SIG" < "$SUMS"
}

TAG=""
MODE="sign"
for arg in "$@"; do
  case "$arg" in
    --check)   MODE="check" ;;
    --dry-run) MODE="dry-run" ;;
    --verify)  MODE="verify" ;;
    -h|--help) grep '^#' "$0" | sed -n '2,22p' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "unknown flag: $arg" ;;
    *)         [ -z "$TAG" ] || die "unexpected extra argument: $arg"; TAG="$arg" ;;
  esac
done

check_allowed_signers
[ "$MODE" = "check" ] && exit 0

[ -n "$TAG" ] || die "missing release tag (e.g. v1.2.3). See --help."

if [ "$MODE" = "dry-run" ]; then
  cat <<EOF

would run:
  ssh-keygen -Y sign -f $SIGNING_KEY -n $NAMESPACE $SUMS
  ssh-keygen -Y verify -f docs/allowed_signers -I $(signer_principal) -n $NAMESPACE -s $SIG < $SUMS
  gh release upload $TAG $SIG

nothing was downloaded, signed or uploaded.
EOF
  exit 0
fi

command -v gh >/dev/null || die "gh CLI not found"
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) ||
  die "could not determine the GitHub repo from this checkout"

work=$(mktemp -d -t nb-sign.XXXXXX)
trap 'rm -rf "$work"' EXIT
cd "$work"

echo "→ downloading $SUMS from $TAG"
gh release download "$TAG" --repo "$REPO" --pattern "$SUMS" >/dev/null ||
  die "could not download $SUMS from release $TAG"

if [ "$MODE" = "verify" ]; then
  gh release download "$TAG" --repo "$REPO" --pattern "$SIG" >/dev/null ||
    die "release $TAG has no $SIG — has it been signed yet?"
  verify_sig
  echo "✓ $TAG: $SUMS signature verifies"
  exit 0
fi

[ -f "$SIGNING_KEY" ] || die "signing key not found: $SIGNING_KEY (override with SIGNING_KEY=)"

echo "→ signing $SUMS (touch your security key)"
ssh-keygen -Y sign -f "$SIGNING_KEY" -n "$NAMESPACE" "$SUMS" >/dev/null

# Verify before publishing: a signature that does not check out against the
# committed allowed_signers is worse than none, because it looks like proof.
echo "→ verifying locally before upload"
verify_sig

echo "→ uploading $SIG to $TAG"
gh release upload "$TAG" "$SIG" --repo "$REPO" --clobber

echo "✓ $TAG signed. Verify with: scripts/sign-release.sh $TAG --verify"
