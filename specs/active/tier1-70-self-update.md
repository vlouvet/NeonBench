# Tier 1 #70 — Self-update via GitHub Releases (signed + notarized)

> **Status:** active · drafted 2026-05-08 · branch `task/1-self-update`

## Goal

Today NeonBench is distributed as a cross-compiled binary built by `scripts/build.sh`. Users grab a binary, run it, and never know when a new version drops. Shipping the app to shop operators means **updates need to land without an IT person walking from station to station**.

"Done" means: a tagged release on `main` triggers a CI workflow that builds + signs (macOS) + notarizes (macOS) + uploads platform binaries to GitHub Releases. The running NeonBench binary checks `releases/latest` once on startup (and every 24 h while running), surfaces "Update available" in the UI, and lets the user click "Update now" to swap-in the new binary and restart — verifying the signature before swap. Auto-update on launch is opt-in (default: prompt).

## Branch + setup

```sh
git fetch origin
git checkout -b task/1-self-update origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

This spec covers four sub-PRs that can ship in sequence (or be combined). Each sub-PR is independently mergeable; the version plumbing in 70a unblocks the rest.

### Sub-PR 70a — Version plumbing + tag-release CI (no signing) — ✅ SHIPPED

**Status added 2026-09-01.** This sub-PR is done and nothing below it should be
re-implemented: `internal/version/version.go` and `.github/workflows/release.yml`
both exist on `main`, and v0.1.0 / v0.2.0 / v0.3.0 have all been tagged and
released (v0.3.0 with 5 binaries, per-asset `.sha256`, `SHA256SUMS`, and a
`SHA256SUMS.sig` signed with the FIDO2/ED25519-SK hardware key). The spec is
kept in `specs/active/` because 70b-70d have not shipped. Read the sub-PR
headings for status before starting work here — a multi-part spec can be
partly done, and neither of the `AGENTS.md` hygiene checks detects that.

**Original scope, for reference:**

**New:**
- `internal/version/version.go` — `var Version = "dev"`, overwritten via `-ldflags "-X 'github.com/.../internal/version.Version=v1.0.0'"` at build time. Helper `Current() string` returns the value (or `"dev"` if unset, useful for `go run` during development).
- `.github/workflows/release.yml` — triggered on `push: tags: ['v*']`. One job builds linux/amd64, linux/arm64, windows/amd64. Second job (macos-latest runner) builds darwin/arm64 + darwin/amd64. Third job collects artifacts, computes SHA256 checksums, creates the GitHub Release.

**Modify:**
- `cmd/neonbench/main.go` — accept `--version` flag → print `version.Current()` and exit 0. Logs the version on startup as the first INFO line.
- `scripts/build.sh` — accept an optional `VERSION` env var; if set, pass through `-ldflags`. Default = "dev" for local hacking.

**Don't touch:**
- The selfupdate runtime (sub-PR 70c lands that).
- macOS code signing (sub-PR 70b lands that).
- The web bundle / Go server.
- `--port` / `--data-dir` / `--dev` / `--no-open` / `--log-level` flags (preserve current shape; just add `--version`).

**Asset naming convention** (set once here, the rest of the system depends on it):
- `neonbench-darwin-arm64` (Apple Silicon mac)
- `neonbench-darwin-amd64` (Intel mac)
- `neonbench-linux-amd64`
- `neonbench-linux-arm64`
- `neonbench-windows-amd64.exe`
- Each binary has a sibling `<name>.sha256` containing one line: `<sha256>  <name>`.

**Workflow logic:**

```yaml
# .github/workflows/release.yml — sketch
name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: write  # required to create releases

jobs:
  build-linux-windows:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.26' }
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: ( cd web && npm ci && npm run build )
      - run: |
          for target in linux/amd64 linux/arm64 windows/amd64; do
            goos=${target%/*}; goarch=${target#*/}
            ext=$([ "$goos" = "windows" ] && echo ".exe" || echo "")
            name="neonbench-${goos}-${goarch}${ext}"
            GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go build \
              -ldflags "-s -w -X 'github.com/vlouvet/neonbench/internal/version.Version=${{ github.ref_name }}'" \
              -o "dist/${name}" ./cmd/neonbench
            ( cd dist && shasum -a 256 "${name}" > "${name}.sha256" )
          done
      - uses: actions/upload-artifact@v4
        with: { name: linux-windows-binaries, path: dist/ }

  build-macos:
    runs-on: macos-latest
    # Sub-PR 70b will add signing + notarization steps here.
    # Sub-PR 70a just builds unsigned binaries (CI works end-to-end).
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.26' }
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: ( cd web && npm ci && npm run build )
      - run: |
          for arch in arm64 amd64; do
            name="neonbench-darwin-${arch}"
            GOOS=darwin GOARCH=$arch CGO_ENABLED=0 go build \
              -ldflags "-s -w -X 'github.com/vlouvet/neonbench/internal/version.Version=${{ github.ref_name }}'" \
              -o "dist/${name}" ./cmd/neonbench
            ( cd dist && shasum -a 256 "${name}" > "${name}.sha256" )
          done
      - uses: actions/upload-artifact@v4
        with: { name: macos-binaries, path: dist/ }

  release:
    needs: [build-linux-windows, build-macos]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { path: dist/ }
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/**/neonbench-*
          generate_release_notes: true
```

**Tests:**
- `internal/version/version_test.go` — `Current()` returns embedded value, falls back to "dev" if unset.
- Manual: tag `v0.0.1-test` on a branch, push, verify CI produces 5 binaries + 5 sha256 files in a GitHub draft release.

### Sub-PR 70b — macOS code signing + notarization

**Modify:**
- `.github/workflows/release.yml` — extend the `build-macos` job with: import cert from `MACOS_CERT_P12_BASE64`, codesign the two darwin binaries with `--options runtime --timestamp --entitlements <path>`, submit each to notary via `xcrun notarytool` against the App Store Connect API key, staple the resulting tickets.
- New `build/macos/entitlements.plist` — minimal hardened-runtime entitlements (no special entitlements claimed; the binary just talks to localhost + filesystem).

**Required GitHub Secrets** (the human walks through the per-secret setup in `docs/apple-signing-setup.md`):
- `MACOS_CERT_P12_BASE64` — the .p12 export, base64-encoded. Single line, no headers.
- `MACOS_CERT_PASSWORD` — the password set when exporting the .p12.
- `MACOS_CERT_IDENTITY` — the codesign identity name, e.g. `Developer ID Application: Vicente Louvet (TEAMID12345)`.
- `ASC_API_KEY_ID` — the 10-character key ID from App Store Connect.
- `ASC_API_ISSUER_ID` — the UUID issuer ID from App Store Connect.
- `ASC_API_KEY_P8` — the contents of the downloaded .p8 file (multi-line; preserve newlines as-is).

**CI signing block** (extends `build-macos`):

```yaml
      - name: Import codesigning cert
        env:
          P12_BASE64: ${{ secrets.MACOS_CERT_P12_BASE64 }}
          P12_PASS:   ${{ secrets.MACOS_CERT_PASSWORD }}
        run: |
          echo "$P12_BASE64" | base64 --decode > /tmp/cert.p12
          security create-keychain -p "$P12_PASS" build.keychain
          security default-keychain -s build.keychain
          security unlock-keychain -p "$P12_PASS" build.keychain
          security import /tmp/cert.p12 -k build.keychain -P "$P12_PASS" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$P12_PASS" build.keychain
          rm /tmp/cert.p12

      - name: Sign macOS binaries
        env:
          IDENTITY: ${{ secrets.MACOS_CERT_IDENTITY }}
        run: |
          for arch in arm64 amd64; do
            name="neonbench-darwin-${arch}"
            codesign --force --options runtime --timestamp \
              --entitlements build/macos/entitlements.plist \
              --sign "$IDENTITY" \
              "dist/${name}"
            codesign --verify --deep --strict --verbose=2 "dist/${name}"
          done

      - name: Notarize macOS binaries
        env:
          API_KEY_ID:    ${{ secrets.ASC_API_KEY_ID }}
          API_ISSUER_ID: ${{ secrets.ASC_API_ISSUER_ID }}
          API_KEY_P8:    ${{ secrets.ASC_API_KEY_P8 }}
        run: |
          mkdir -p ~/.private_keys
          echo "$API_KEY_P8" > ~/.private_keys/AuthKey_${API_KEY_ID}.p8
          chmod 600 ~/.private_keys/AuthKey_${API_KEY_ID}.p8
          for arch in arm64 amd64; do
            name="neonbench-darwin-${arch}"
            # Notarytool requires a zip; submit, wait, then staple the binary.
            ditto -c -k --keepParent "dist/${name}" "dist/${name}.zip"
            xcrun notarytool submit "dist/${name}.zip" \
              --key ~/.private_keys/AuthKey_${API_KEY_ID}.p8 \
              --key-id "$API_KEY_ID" \
              --issuer "$API_ISSUER_ID" \
              --wait \
              --timeout 30m
            xcrun stapler staple "dist/${name}"
            rm "dist/${name}.zip"
            # Re-emit checksum after stapling (binary contents change).
            ( cd dist && shasum -a 256 "${name}" > "${name}.sha256" )
          done
```

**Local-build path** (so the user can sign on their workstation without CI):
- `scripts/build.sh` gains an optional `--sign` flag. When passed AND `MACOS_CERT_IDENTITY` env var is set, it runs the same codesign + notarytool flow against the user's login keychain. Notarization needs `ASC_API_KEY_ID` + `ASC_API_ISSUER_ID` + path to .p8 (env var `ASC_API_KEY_PATH`).
- The flag is a no-op on linux/windows builds (signing those is sub-PR 70b-windows, deferred).

**Tests:**
- Manual: re-tag `v0.0.2-test`, push, verify the GitHub Release contains a notarized darwin binary. Download → run → it opens without Gatekeeper warning. Re-emitted .sha256 matches the post-staple binary.

### Sub-PR 70c — Self-updater backend (Go)

**New:**
- `internal/updater/updater.go` — public types + functions:
  ```go
  type ReleaseInfo struct {
      Version    string  // e.g. "v1.0.5"
      AssetURL   string  // direct download URL for the platform's binary
      ChecksumURL string // direct URL for <asset>.sha256
      ReleasedAt time.Time
      Notes      string  // markdown release notes
  }

  type CheckResult struct {
      Current     string
      Latest      *ReleaseInfo
      Available   bool   // true iff Latest > Current
      LastChecked time.Time
      Error       string // populated on network failure
  }

  func Check(ctx context.Context) (*CheckResult, error)
  func Download(ctx context.Context, info *ReleaseInfo, dest string) error
  func VerifyChecksum(file, expectedSHA256 string) error
  func VerifySignature(file string) error  // macOS-only: codesign --verify
  func Apply(downloadedBinaryPath string) error  // selfupdate.Apply + restart hook
  ```
- `internal/updater/updater_test.go` — tests with a mock GitHub API server (httptest); verify checksum success / failure, asset selection picks correct platform/arch.
- `internal/updater/cache.go` — in-memory + on-disk (JSON in app data dir) cache of the last `CheckResult` with timestamp; refresh after 24 h.

**Modify:**
- `go.mod` — add `github.com/minio/selfupdate` (active fork of inconshreveable/go-update).
- `internal/server/api.go` — register three new routes:
  - `GET /api/version` — returns `{"current":"v1.0.5","latest":"v1.0.6","available":true,"opt_in":false,"last_checked":"..."}`. Cheap; reads cached state.
  - `POST /api/update/check` — force a fresh check (bypasses 24 h cache); returns same shape as `/api/version`.
  - `POST /api/update/apply` — downloads, verifies, swaps, restarts. Streams progress as Server-Sent Events: `{"phase":"downloading","percent":42}` → `{"phase":"verifying"}` → `{"phase":"applying"}` → connection closes (server is restarting). Frontend polls `/api/version` after the connection drops to confirm the new version.
- `internal/server/api.go` — at startup, kick off a background goroutine that calls `updater.Check()` once (non-blocking; failures only log).
- `internal/storage/migrations/NNN_app_settings.sql` (new) — one-row settings table:
  ```sql
  -- +goose Up
  CREATE TABLE app_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      auto_update_opt_in BOOLEAN NOT NULL DEFAULT 0,
      last_update_check_at TEXT,
      last_update_dismissed_version TEXT
  );
  INSERT INTO app_settings (id) VALUES (1);

  -- +goose Down
  DROP TABLE app_settings;
  ```
  - `auto_update_opt_in`: user toggle. Default off.
  - `last_update_check_at`: cache-key for the 24 h refresh.
  - `last_update_dismissed_version`: lets the user dismiss a banner for v1.2.3 without re-prompting until a newer version drops.

**Don't touch:**
- The web bundle (sub-PR 70d adds the UI).
- Existing storage migrations.
- The `--dev` proxy mode (selfupdate is a no-op in dev).

**Behavior:**
- `dev` build (no version injected) → `Current() == "dev"` → `IsAvailable` always false → updater is a quiet no-op. Frontend hides the banner.
- Apply flow on macOS: download + verify checksum + verify codesign signature against expected Team ID before swap (fails closed if mismatch).
- Apply flow on Windows: selfupdate handles the rename-then-replace dance.
- Apply flow on Linux: simple write-then-rename.
- Restart: after `selfupdate.Apply()` returns success, call `os.StartProcess` with the new binary's path + same args, then `os.Exit(0)`. The browser will reconnect to the same port within 1-2 s. Log the restart.

**Edge cases:**
- Read-only install location (e.g. macOS `/Applications`): `selfupdate.Apply()` returns a permission error. Surface in the UI as "Cannot auto-update from this location. Please re-download from <link>." Don't crash.
- Network down: `Check()` returns an error; UI shows "Couldn't check for updates" with retry. Cached result still serves from `/api/version`.
- Pre-release tags: skip. Use `releases/latest`, not `releases`. (`releases/latest` excludes pre-releases by default.)
- Rate limiting: GitHub's unauthenticated rate limit (60/h per IP) is plenty for a single-user app, but we cache the result for 24 h so repeated launches don't burn it.

**Tests:**
- `Check()` against a mock server that returns a release with `tag_name=v1.0.5`: parses correctly.
- `Check()` against a 304 / cached path: doesn't re-hit the network.
- Asset selection: on `runtime.GOOS=="darwin" && runtime.GOARCH=="arm64"`, picks `neonbench-darwin-arm64` from a multi-asset release.
- Checksum mismatch: returns a non-nil error and DOES NOT call selfupdate.Apply.

### Sub-PR 70d — Self-updater UI (React)

**New:**
- `web/src/components/UpdateBanner.tsx` — small dismissible banner at the top of `<App>`. Shows when `available && !dismissed`. Buttons: "Update now" → POSTs `/api/update/apply` and shows progress; "Later" → records the current latest version as dismissed; "Release notes" → opens GitHub release page.
- `web/src/pages/SettingsPage.tsx` — new route at `/settings`. Sections:
  - **Version** — current version, last check time, "Check now" button (POSTs `/api/update/check`).
  - **Auto-update** — toggle for `auto_update_opt_in`. Default OFF. When ON, the next launch checks + applies any update without prompting.
  - **About** — read-only build info (commit SHA, build date — both injectable via -ldflags later).
- `web/src/api.ts` — add `getVersion()`, `checkUpdate()`, `applyUpdate()` (uses Server-Sent Events). The SSE client should handle "connection-closed-as-success-signal": when the apply stream completes via close (not an error event), poll `/api/version` until the version changes (with timeout), then reload the page so the user sees the new build.
- `web/src/lib/updateChannel.ts` — small helper for the SSE flow + poll-until-restart.

**Modify:**
- `web/src/App.tsx` — mount `<UpdateBanner>` inside the layout shell; add `/settings` route.
- `web/src/App.css` — banner positioning + progress-bar styling.

**Don't touch:**
- Editor / preview / project list logic.
- The existing `<PrintPopover>` / `<SceneControls>` patterns (banner is its own thing).

**Banner UX details:**
- Color: subtle accent (matches existing `--info` or `--accent`); not a red alert.
- Position: pinned to top of viewport; doesn't push layout — `position: sticky`.
- Dismissed state survives page reload via `last_update_dismissed_version` in app_settings.
- "Update now" replaces the banner with a progress bar (SSE stream); "Cancel" during download is allowed.

**Settings page UX:**
- Reuse the existing job-fields click-to-edit pattern for the auto-update toggle.
- "Check now" is debounced (5 s minimum between forced checks) so a user mashing it doesn't burn the GitHub rate limit.
- Auto-update toggle has fine print: "Updates apply on next launch. The update is verified against the publisher's signature before installing."

**Tests:**
- `UpdateBanner.test.tsx` — renders nothing when `available === false`; renders the buttons when true; "Later" calls the dismiss API.
- `updateChannel.test.ts` — SSE parser unit tests against a mock event stream.

## Constraints

- **No new third-party Go dependencies beyond `minio/selfupdate`.** No update server. No telemetry.
- **No new third-party npm dependencies.** Server-Sent Events use native `EventSource`.
- **No code-signing on Linux** — Linux distros don't enforce it; an unsigned binary is normal there.
- **Windows is unsigned in v1.** SmartScreen will warn on auto-update. EV cert (~$300/yr) is a future buy. Document the warning in release notes.
- **Always verify signature before swap on macOS.** A tampered download must NOT replace the running binary.
- **Default to opt-in prompt, NOT silent auto-update.** The user explicitly enables auto.
- **Preserve the user's `--port` / `--data-dir` flags across restart.** The new process inherits the same args.
- **Zero-config for dev**: `go run ./cmd/neonbench` should still work — Version="dev" + updater self-disables.

## Tests (cross-cutting)

Manual checklist before declaring 70 done:

1. **Tag a `v0.0.1` release**, watch CI build all 5 binaries + .sha256 files.
2. **Download `neonbench-darwin-arm64` on a fresh mac** (one that hasn't seen the binary). Run it. **No Gatekeeper warning.** Notarization is working.
3. **In the running app, tag a `v0.0.2` release** in the meantime. Within ~30 s of next launch, the banner appears.
4. **Click "Update now"**: the progress bar fills, the app restarts, the version in Settings shows v0.0.2.
5. **Toggle auto-update ON**, tag v0.0.3, restart the binary: it auto-applies before the browser opens.
6. **Toggle auto-update ON, but install in `/Applications/` (read-only as a non-admin user)**: the apply flow surfaces the read-only error gracefully; the running binary keeps working at the old version.
7. **Tag a v0.0.4 with a corrupted SHA256 file** (manually edit the .sha256): the apply flow refuses to swap and surfaces "Checksum mismatch" in the UI.
8. **`./neonbench --version`** prints `v0.0.X` (matches the tag CI built).
9. **`go run ./cmd/neonbench`** prints `dev` and the banner never appears (updater quiet no-op).

## Pre-merge (per sub-PR)

```sh
./scripts/test.sh
( cd web && npm run lint )
( cd web && npm run build )
go vet ./...
```

## Workflow

Each sub-PR ships independently. Recommended order:

1. **70a** (version plumbing + unsigned tag-release CI) — proves the release pipeline works end-to-end before adding signing complexity. Confirm by tagging a v0.0.1-rc on a branch, watching the workflow, downloading binaries.
2. **70b** (macOS signing + notarization) — requires the human to first complete the steps in `docs/apple-signing-setup.md` and add the 6 GitHub Secrets. Then this PR adds the CI steps + entitlements file. Tag a v0.0.2-rc, verify the binary opens without Gatekeeper warning.
3. **70c** (updater backend) — adds the migration, the package, the API endpoints. The backend is testable via `curl /api/version` against a fresh tag.
4. **70d** (UI banner + settings) — finishes the user-facing surface. Manual smoke against a real tag end-to-end.

Each PR titled `Self-update <sub-letter>: <focus> (Tier 1 #70<letter>)`.

## Report back (per sub-PR)

Under 300 words. Include: PR URL, what manual smoke step(s) you ran, CI state, follow-ups, anything you defer to a future sub-PR.

## Follow-ups (deferred to a v1.1 spec)

- Windows EV code signing (~$300/yr cert from Sectigo or DigiCert).
- Beta channel: a `?channel=beta` toggle that polls `releases` not `releases/latest`, surfaces pre-release tags. Useful if you want shop pilots before stable.
- Update rollback: keep the previous binary as `<name>.bak`; "rollback" button restores it. v1 just says "if it broke, re-download."
- Differential updates: bsdiff between binaries. Saves bandwidth on large updates. Not worth it for a ~30 MB binary that ships infrequently.
- Telemetry: opt-in "send my version on update check" so you can see the install base. Privacy implications; defer to a real privacy doc.
- macOS .dmg installer with auto-Applications-folder install. Currently the user grabs the bare binary; a .dmg would be nicer but adds notarization complexity (notarize the .dmg, not the inner binary).
