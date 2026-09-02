# Tier 1 — YubiKey provenance signing + "unsigned binary" disclaimer

> **Status:** active · drafted 2026-06-05 · **rewritten 2026-08-24 for FIDO reality** ·
> requested by user · **signing shipped; the disclaimer surfaces are what remain**
>
> **Status refreshed 2026-09-02.** The header read "partially shipped in v0.1.0"
> for three releases after that stopped being true. Tags are signed (v0.1.0,
> v0.2.0, v0.4.0 verify; **v0.3.0 is annotated only** — it degraded silently, so
> check `git cat-file tag vX.Y.Z | grep "BEGIN SSH SIGNATURE"` after tagging),
> `SHA256SUMS.sig` is produced and verified by `scripts/sign-release.sh`, and
> `docs/allowed_signers` is in the repo. Neither hygiene check in AGENTS.md can
> catch a header like the old one: the spec is not duplicated in `done/` and has
> no `todo.md` row to disagree with. Same trap as `tier1-70-self-update.md`.

## Goal

We are **not** buying a Windows Authenticode certificate, so the distributed `.exe` stays
**unsigned** — Windows SmartScreen will show "Windows protected your PC / unknown publisher." That is
accepted. Instead we give users **SOME level of trust** via the maintainer's **YubiKey hardware key**:

- Release **tags** on `main` are cryptographically signed by the YubiKey.
- Each GitHub Release ships a **detached signature of its `SHA256SUMS`**, so anyone can verify the exact
  bytes they downloaded were vouched for by the key holder.
- A plain-language **disclaimer** explains the unsigned status and *how to verify the download instead*,
  in the README, the installer's welcome screen, and a first-run in-app banner.

"Done" means: a user who downloads a release can (a) see the warning is expected and why, and (b) run a
documented verification to confirm the binary is the maintainer's authentic build.

## Hardware constraint — this rewrite exists because the original plan was impossible

The original draft assumed the **OpenPGP applet** on the YubiKey (`gpg --card-status`, an OpenPGP
signing subkey, `docs/maintainer-pubkey.asc`, `gpg --verify`). **The maintainer's key is a "Security Key
NFC" (firmware 5.4.3), whose only applets are FIDO U2F and FIDO2.** There is no OpenPGP applet, no PIV,
no OATH. `gpg --card-status` returns "Operation not supported by device" and always will. Only the
YubiKey **5** series carries OpenPGP.

The original draft's own escape hatch — *"or SSH/FIDO signing if preferred"* — is therefore the whole
mechanism, not an alternative. Everything below is SSH signature format, backed by FIDO2.

The security property is unchanged and is the one that matters: **the private key never leaves the
authenticator and every signature requires a physical touch.**

### macOS toolchain trap (cost an hour; do not repeat it)

Apple's `/usr/bin/ssh-keygen` is built **without** FIDO support and fails with
`No FIDO SecurityKeyProvider specified`. `brew install libfido2` does **not** fix this —
it ships `libfido2.dylib`, never the `libsk-libfido2.dylib` shim OpenSSH needs, because that shim is
built by OpenSSH, not by libfido2. The fix is `brew install openssh`, whose formula passes
`--with-security-key-builtin` (FIDO compiled in, no provider needed). **`SSH_SK_PROVIDER` must be unset**
— if it points anywhere, it overrides the built-in provider and reintroduces the failure.

## Hard constraint: the hardware key is on the maintainer's machine, not in CI

GitHub Actions cannot touch the YubiKey. So **CI never signs anything with it.** The signable artifacts
are the ones the maintainer produces locally:

- **release tag** — `git tag -s vX.Y.Z` (YubiKey touch), pushed to trigger `release.yml`.
- **`SHA256SUMS.sig`** — after CI publishes the release, the maintainer runs
  `scripts/sign-release.sh vX.Y.Z`, which downloads `SHA256SUMS`, detached-signs it with the YubiKey,
  verifies the result locally, and uploads the `.sig` to the same release.

This is honest about what the key can attest: **source authorship + "these are the bytes I shipped."**
It does **not** silence SmartScreen (only Authenticode does) — hence the disclaimer.

> Note on merge method: GitHub squash/rebase-merges re-author the commit with **GitHub's** web-flow key,
> so the commit that lands on `main` shows "Verified by GitHub", not the YubiKey. The **signed tag** and
> **signed `SHA256SUMS`** are therefore the authoritative maintainer-signature anchors for a release.

## Deliverables

### 1. Maintainer key setup — ✅ DONE (2026-08-24)

```sh
brew install openssh                       # Apple's ssh-keygen cannot do FIDO
ssh-keygen -t ed25519-sk -C "neonbench release signing" -f ~/.ssh/id_ed25519_sk
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519_sk.pub
git config --global gpg.ssh.program /opt/homebrew/bin/ssh-keygen
```

Non-resident key by choice: nothing is stored on the authenticator, so it consumes no FIDO2 slot and
does not interfere with the key's 2FA duty.

**Still open:** register `~/.ssh/id_ed25519_sk.pub` at <https://github.com/settings/keys> as a
**Signing Key** — a *different* entry type from Authentication Key. Without it GitHub renders signed
tags as "Unverified" even though the signature is valid.

### 2. Public key in the repo — ✅ DONE

`docs/allowed_signers` (this replaces the original `docs/maintainer-pubkey.asc`; there is no `.asc`,
because there is no OpenPGP key). It carries the principal, the public key, and the fingerprint in a
header comment.

Repo-wide tag/commit verification, once per clone:

```sh
git config gpg.ssh.allowedSignersFile docs/allowed_signers
git tag -v v0.1.0
# Good "git" signature for louvetvicente@gmail.com with ED25519-SK key SHA256:BwjB7xo…
```

### 3. Release-signing helper — ✅ DONE

`scripts/sign-release.sh`:

| Invocation | Effect |
|---|---|
| `sign-release.sh vX.Y.Z` | download `SHA256SUMS`, sign, verify locally, upload `.sig` |
| `sign-release.sh vX.Y.Z --dry-run` | print the exact commands, touch nothing |
| `sign-release.sh vX.Y.Z --verify` | download and verify what is already published |
| `sign-release.sh --check` | validate `docs/allowed_signers` — no hardware, no network |

It verifies the fresh signature against the committed `docs/allowed_signers` **before** uploading: a
signature that does not check out is worse than none, because it looks like proof.

### 4. Single `SHA256SUMS` in CI — ✅ DONE (PR #130)

`release.yml` concatenates the per-file `*.sha256` into one `SHA256SUMS`, runs `sha256sum -c` over the
flattened directory as a real gate, and uploads it. Per-file `.sha256` files are retained — they are
the friendlier check for a non-developer verifying one download.

### 5. Branch protection — ❌ NOT DONE

Enable GitHub's **"Require signed commits"** on `main`. **Shared-infrastructure change (CLAUDE.md) — the
maintainer must enable it**, or explicitly approve `gh api` doing so.

### 6. User-facing disclaimer + verification — 🟡 PARTIAL

- **README.md** — ✅ shipped in #129. The Windows section states the build is unsigned, walks through
  SmartScreen's **More info → Run anyway**, and documents checksum verification with
  `certutil -hashfile`. **TODO:** add the signature-verification step once a release actually carries
  a `.sig`:
  ```sh
  ssh-keygen -Y verify -f docs/allowed_signers \
    -I louvetvicente@gmail.com -n file \
    -s SHA256SUMS.sig < SHA256SUMS
  sha256sum -c SHA256SUMS          # certutil -hashfile <file> SHA256 on Windows
  ```
- **Installer welcome page** — ❌ blocked on the P1 installer spec (no installer exists; the `.exe` is
  portable).
- **First-run in-app banner** — ❌ not started. Dismissible notice in the web UI: "Unofficial/unsigned
  build — verify your download · how to", dismissal persisted in localStorage.

## Tests

- ✅ `scripts/sign-release.sh --check` validates `docs/allowed_signers`: exactly one signer entry, the
  key parses, and the fingerprint in the header comment matches the key beneath it — so that comment
  cannot silently drift. Needs no hardware or network, so CI can gate on it.
  **TODO:** wire it into `ci.yml`.
- ✅ Argument handling covered by `--dry-run` (asserts no download/sign/upload occurs) and by the
  rejection paths for a missing tag, an unknown flag, and a duplicate positional.
- ❌ First-run banner: component renders, dismiss persists to localStorage
  (renderToStaticMarkup-level, per the repo's no-RTL convention).

## Known limitations — state these plainly, do not paper over them

- **SSH signatures are less familiar than GPG.** Verification needs `ssh-keygen -Y verify` plus the
  `allowed_signers` file, which most users have never done. For handing builds to known people this is
  fine; if NeonBench goes public, revisit.
- **Single point of failure.** The signing key exists only on that one authenticator. Lose it and the
  identity is unrecoverable — there is no backup, by construction. Mitigate by enrolling a second key
  and adding it to `docs/allowed_signers`, or accept rotation.
- **Signing is manual and therefore skippable.** Nothing fails if a release ships unsigned; `v0.1.0`
  did. Consider a CI check that flags a published release lacking `SHA256SUMS.sig`.

## Out of scope (separate specs / future)

- The **Windows installer + icon + tray** (P0/P1 specs) — this spec only supplies the disclaimer text.
- **Real public Authenticode trust** without a paid cert — if the repo goes public OSS, apply to
  **SignPath Foundation** (free) or **Azure Artifact Signing** (~$10/mo). This spec stays at
  "unsigned + provenance."
- Reproducible builds, which would let a signed tag attest the exact binary. Until then the signed
  `SHA256SUMS` is the binary-trust anchor.
