# Windows

The Windows build is a single self-contained `neonbench-windows-amd64.exe` —
no Go, no Node, no runtime to install. Verified end-to-end on Windows 11
(build 26200, amd64).

## Download and run

1. Download `neonbench-windows-amd64.exe` from the
   [latest release](https://github.com/vlouvet/NeonBench/releases/latest).
2. Optionally verify it — see [Downloads and trust](#downloads-and-trust).
3. Double-click it. A console window opens, the server starts on
   `127.0.0.1`, and your default browser opens on the project list.

Leave the console window open; closing it stops NeonBench. To pin the port or
stop it hijacking your browser, run it from a terminal with the
[CLI flags](#cli-flags) above:

```powershell
.\neonbench-windows-amd64.exe --port 5199 --no-open
```

> **Firefox users:** with Firefox's "Choose a profile when Firefox opens"
> setting enabled, the profile picker appears *instead of* the app. Pick a
> profile and NeonBench loads normally.

## Expect a SmartScreen warning on first launch

Releases are **not code-signed**, so Windows sees an unknown publisher. This is
expected and does not mean the download is damaged or hostile:

- Your browser may flag the file as "not commonly downloaded" — choose **Keep**.
- Windows then shows a blue **"Windows protected your PC"** dialog. Click
  **More info**, then **Run anyway**.
- If it keeps reappearing, right-click the `.exe` → **Properties** → tick
  **Unblock** → **OK**.

Only an Authenticode certificate silences SmartScreen, and NeonBench
deliberately doesn't buy one. Verify the checksum instead.

## Downloads and trust

Every release publishes a `.sha256` beside each binary. Comparing that pair is
the simplest check for a single download:

```powershell
certutil -hashfile neonbench-windows-amd64.exe SHA256
type neonbench-windows-amd64.exe.sha256
```

The hashes must match. PowerShell equivalent:
`Get-FileHash neonbench-windows-amd64.exe -Algorithm SHA256`.

Releases also carry a combined `SHA256SUMS` listing every platform's binary in
one file — useful when verifying more than one download, and the single file a
maintainer signature will cover once provenance signing lands.

## Where your data lives

Projects, design versions and uploaded assets live in one SQLite database under
your roaming profile:

```
%APPDATA%\NeonBench\neonbench.db
```

That folder is created on first launch and is the only thing NeonBench writes
outside its own directory — the `.exe` is portable and never runs an installer.
To keep data elsewhere (USB stick, shared drive), pass `--data-dir`:

```powershell
.\neonbench-windows-amd64.exe --data-dir D:\neonbench-data
```

Back up or migrate a workstation by copying that folder. Uninstalling is
deleting the `.exe`, plus that folder if you want the data gone.

## Building from source on Windows

Only needed if you're changing the code — end users should take the release
binary. Requires **Go 1.26+**, **Node 20+** and **Git**:

```powershell
git clone https://github.com/vlouvet/NeonBench.git
cd NeonBench

# Frontend first — web/web.go has //go:embed all:dist, so every go command
# fails with "pattern all:dist: no matching files found" until web/dist exists.
cd web ; npm.cmd install ; npm.cmd run build ; cd ..

$env:CGO_ENABLED = '0'
go build -trimpath -o bin\neonbench.exe .\cmd\neonbench
.\bin\neonbench.exe
```

> Use **`npm.cmd`**, not `npm`, from PowerShell. Bare `npm` resolves to
> `npm.ps1`, which the default execution policy blocks with *"running scripts
> is disabled on this system"*. `npm.cmd` sidesteps that without weakening
> machine policy. `cmd.exe` and Git Bash are unaffected.

The bash helpers (`scripts/build.sh`, `scripts/run.sh`, `scripts/test.sh`) run
under **Git Bash**, which ships with Git for Windows.

---

Back to the [README](../README.md) · [User manual](USER_MANUAL.md)
