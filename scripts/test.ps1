<#
.SYNOPSIS
    Run the automated test suite on Windows — the sibling of scripts/test.sh.

.DESCRIPTION
    Same scope as test.sh: build the frontend if it is missing, run the Go
    tests, then the frontend vitest suite. It exists separately because the
    bash scripts assume a Unix shell, and three Windows specifics bite anyone
    running the suite by hand:

      * bare `npm` resolves to npm.ps1, which the default execution policy
        blocks with "running scripts is disabled on this system". npm.cmd
        sidesteps that without weakening machine policy.
      * web/web.go has `//go:embed all:dist`, so every go command fails with
        "pattern all:dist: no matching files found" until web/dist exists.
      * `go list ./... | grep -v` has no direct PowerShell equivalent.

    Native commands do not trip $ErrorActionPreference, so every step checks
    $LASTEXITCODE explicitly — otherwise a failing suite exits 0 and looks green.

.PARAMETER Smoke
    Additionally build bin\neonbench.exe and run scripts\windows-smoke.ps1
    against it — the artifact-level check CI runs, covering what `go test`
    cannot: %APPDATA% resolution, migrations against a Windows SQLite path, and
    the embedded SPA actually being served.

.PARAMETER Port
    Port for the -Smoke run. Default 5290, chosen to avoid colliding with a
    dev instance on the usual port.

.EXAMPLE
    .\scripts\test.ps1
    .\scripts\test.ps1 -Smoke
#>
[CmdletBinding()]
param(
    [switch]$Smoke,
    [int]$Port = 5290
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# `throw` here would print a stack trace with raw source lines, which buries the
# actual test failure in CI output. Report the step and exit 1 instead — `exit`
# inside a function ends the whole script, and 1 is what shells expect.
function Assert-LastExit {
    param([string]$Label)
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host "FAILED: $Label (exit $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
}

# Fresh clone or fresh worktree: populate web/dist so the embed resolves.
# Skipped when it already exists, to keep the inner loop fast.
if (-not (Test-Path 'web/dist/index.html')) {
    Write-Host '-> web/dist missing, building frontend first'
    Push-Location web
    try {
        & npm.cmd install --silent; Assert-LastExit 'npm install'
        & npm.cmd run build;        Assert-LastExit 'npm run build'
    } finally { Pop-Location }
}

Write-Host '-> go test ./...'
# Filter out web/node_modules — npm packages occasionally ship a stray Go file
# (e.g. flatted/golang/) that go list would otherwise try to compile.
$pkgs = @()
$pkgs += go list ./... | Where-Object { $_ -notmatch '/web/node_modules/' }
Assert-LastExit 'go list'
go test $pkgs
Assert-LastExit 'go test'

Write-Host ''
Write-Host '-> vitest (web/)'
Push-Location web
try {
    & npm.cmd test; Assert-LastExit 'vitest'
} finally { Pop-Location }

if ($Smoke) {
    Write-Host ''
    Write-Host '-> building bin\neonbench.exe'
    $env:CGO_ENABLED = '0'
    New-Item -ItemType Directory -Force -Path bin | Out-Null
    go build -trimpath -o bin\neonbench.exe ./cmd/neonbench
    Assert-LastExit 'go build'

    # Scratch data dir, never %APPDATA%\NeonBench: the smoke run creates a
    # project, and a developer's real project list is not a test fixture.
    $data = Join-Path ([System.IO.Path]::GetTempPath()) 'neonbench-smoke-data'
    Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host "-> windows-smoke (port $Port, data $data)"
    & "$PSScriptRoot\windows-smoke.ps1" -Exe bin\neonbench.exe -Port $Port -DataDir $data
    Assert-LastExit 'windows-smoke'
}

Write-Host ''
Write-Host 'all green'
