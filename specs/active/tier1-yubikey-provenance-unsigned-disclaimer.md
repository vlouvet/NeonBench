# Tier 1 — YubiKey provenance signing + "unsigned binary" disclaimer

> **Status:** active · drafted 2026-06-05 · branch `task/1-yubikey-provenance` · requested by user

## Goal

We are **not** buying a Windows Authenticode certificate, so the distributed `.exe`/installer stays
**unsigned** — Windows SmartScreen will show "Windows protected your PC / unknown publisher." That is
accepted. Instead we give users **SOME level of trust** via the maintainer's **YubiKey hardware key**:

- Commits and release **tags** on `main` are cryptographically signed by the YubiKey.
- Each GitHub Release ships a **detached signature of its `SHA256SUMS`**, so anyone can verify the exact
  bytes they downloaded were vouched for by the key holder.
- A plain-language **disclaimer** explains the unsigned status and *how to verify the download instead*,
  in the README, the installer's welcome screen, and a first-run in-app banner.

"Done" means: a user who downloads a release can (a) see the warning is expected and why, and (b) run a
documented `gpg --verify` to confirm the binary is the maintainer's authentic build.

## Hard constraint: the hardware key is on the maintainer's machine, not in CI

GitHub Actions cannot touch the YubiKey. So **CI never signs anything with it.** The signable artifacts
are the ones the maintainer produces locally:

- **commits** — signed at `git commit` time (YubiKey OpenPGP/SSH).
- **release tag** — `git tag -s vX.Y.Z` (YubiKey), pushed to trigger the existing `release.yml`.
- **`SHA256SUMS.sig`** — after CI publishes the release, the maintainer downloads the generated
  `SHA256SUMS`, detached-signs it with the YubiKey, and uploads the `.sig` to the same release.

This is honest about what the key can attest: **source authorship + "these are the bytes I shipped."**
It does **not** silence SmartScreen (only Authenticode does) — hence the disclaimer.

> Note on merge method: GitHub squash/rebase-merges re-author the commit with **GitHub's** web-flow key,
> so the commit that lands on `main` shows "Verified by GitHub", not the YubiKey. The **signed tag** and
> **signed `SHA256SUMS`** are therefore the authoritative maintainer-signature anchors for a release;
> signed commits + branch protection are defense-in-depth for the repo history.

## Deliverables

### 1. Maintainer key setup (docs only — `docs/signing-and-trust.md`)

A walkthrough the maintainer runs once:

- Provision the signing key on the YubiKey (OpenPGP applet, signing subkey — recommended so the same
  key signs commits, tags, and checksums) **or** SSH/FIDO signing if preferred for commits.
- `git config --global user.signingkey <KEYID>`, `commit.gpgsign true`, `tag.gpgSign true`.
- Add the **public** key to GitHub (so commits/tags show "Verified") and commit it to the repo at
  `docs/maintainer-pubkey.asc` so downloaders can `gpg --import` it without trusting a keyserver.
- Publish the key fingerprint in `README.md` and `docs/signing-and-trust.md`.

### 2. Release-signing helper (`scripts/sign-release.sh`)

A small script the maintainer runs after a release publishes:

```sh
# usage: scripts/sign-release.sh vX.Y.Z
# - gh release download <tag> --pattern 'SHA256SUMS'   (or rebuild the list from *.sha256)
# - gpg --armor --detach-sign --output SHA256SUMS.sig SHA256SUMS   (YubiKey touch)
# - gh release upload <tag> SHA256SUMS.sig
```

If the current `release.yml` emits per-file `*.sha256` rather than one `SHA256SUMS`, add a CI step that
concatenates them into a single `SHA256SUMS` artifact so there's one file to sign. (CI produces the
file; the maintainer signs it locally.)

### 3. Branch protection — require signed commits on `main`

Enable GitHub's **"Require signed commits"** rule on `main`. **This is a shared-infrastructure change
(CLAUDE.md) — the maintainer must enable it (or explicitly approve `gh api` doing so).** Document the
nuance that GitHub-performed squash merges are signed by GitHub's key.

### 4. User-facing disclaimer + verification instructions

Same wording in three places:

- **README.md** — a "Downloads & trust" section: this build is **not code-signed**; Windows will warn
  (with the exact "More info → Run anyway" steps); and the *better* check is to verify the signed
  checksum:
  ```sh
  gpg --import docs/maintainer-pubkey.asc          # one time
  gpg --verify SHA256SUMS.sig SHA256SUMS           # confirms the maintainer signed these hashes
  sha256sum -c SHA256SUMS                          # confirms your download matches  (certutil -hash on Win)
  ```
- **Installer welcome page** — Inno Setup `InfoBeforeFile` / a custom message stating it's a
  community build, unsigned, with a link to the verification steps. (Lands with the P1 installer spec.)
- **First-run in-app banner** — a dismissible notice in the web UI: "Unofficial/unsigned build — verify
  your download · how to" linking to the docs. Persist dismissal in localStorage.

## Tests

- `scripts/sign-release.sh` has a `--dry-run`/`--check` path unit-tested for argument handling and the
  `gpg`/`gh` command construction (no real signing in CI).
- A docs lint / link check that `docs/maintainer-pubkey.asc` and the fingerprint referenced in README
  exist and match (a tiny Go or shell test).
- First-run banner: component renders, dismiss persists to localStorage (renderToStaticMarkup-level
  assertion, consistent with the repo's no-RTL convention).

## Out of scope (separate specs / future)

- The **Windows installer + icon + tray** (P0/P1 specs) — this spec only adds the disclaimer text those
  surfaces will display.
- **Real public Authenticode trust** without a paid cert — if the repo is/goes public OSS, apply to
  **SignPath Foundation** (free) or **Azure Artifact Signing** (~$10/mo); track as a follow-up. This
  spec deliberately stays at "unsigned + provenance."
- Reproducible builds (which would let a signed tag attest the exact binary). Until then, the signed
  `SHA256SUMS` is the binary-trust anchor.
