<#
.SYNOPSIS
    Boot a freshly built neonbench.exe and assert the shipped artifact works.

.DESCRIPTION
    Runs in CI (the `windows-smoke` job) and locally. This covers the ground the
    Go test suite cannot, because `go test` exercises handlers via registerAPI
    rather than the real binary:

      * the -ldflags version string survived the build
      * %APPDATA% resolution + goose migrations against a Windows SQLite path
      * the //go:embed'd SPA is the real Vite bundle, not a stub
      * the SQLite write path round-trips through the HTTP API

    Windows is the only platform where users are handed a bare .exe, so this is
    the last gate before that artifact ships.

    Exits non-zero on the first failed assertion, and always dumps the server
    log so a CI failure is diagnosable without a rerun.

.EXAMPLE
    ./scripts/windows-smoke.ps1
    ./scripts/windows-smoke.ps1 -Exe dist/neonbench.exe -DataDir $env:TEMP\nb-smoke
#>
[CmdletBinding()]
param(
    # Binary under test.
    [string]$Exe = 'dist/neonbench.exe',
    [int]$Port = 5199,
    [int]$TimeoutSec = 60,
    # Leave empty to exercise the real %APPDATA% resolution (what CI wants).
    # Point it at a scratch directory to avoid touching a developer's own data.
    [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"

if (-not (Test-Path $Exe)) { throw "binary not found: $Exe" }

# The release pipeline injects the tag via -ldflags; a blank value means that
# wiring broke and every published binary would report "dev".
$version = (& $Exe --version | Out-String).Trim()
if (-not $version) { throw '--version printed nothing (ldflags version injection broken?)' }
Write-Host "version : $version"

$tmp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$outLog = Join-Path $tmp 'neonbench-smoke-out.log'
$errLog = Join-Path $tmp 'neonbench-smoke-err.log'

$appArgs = @('--no-open', '--port', "$Port", '--log-level', 'debug')
if ($DataDir) { $appArgs += @('--data-dir', $DataDir) }

$proc = Start-Process -FilePath $Exe -ArgumentList $appArgs -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

try {
    # 1. Comes up and reports healthy.
    $healthy = $false
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { throw "process exited early with code $($proc.ExitCode)" }
        try {
            if ((Invoke-RestMethod "$base/api/health" -TimeoutSec 3).status -eq 'ok') {
                $healthy = $true
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) { throw "server never became healthy on $base within ${TimeoutSec}s" }
    Write-Host 'health  : ok'

    # 2. The embedded SPA is real. A stubbed web/dist/index.html has no hashed
    #    asset bundle, so this assertion is what forces CI to build the frontend.
    $index = (Invoke-WebRequest "$base/" -UseBasicParsing -TimeoutSec 10).Content
    $asset = [regex]::Match($index, '/assets/[A-Za-z0-9._-]+\.js').Value
    if (-not $asset) {
        throw "index.html references no /assets/*.js bundle - the embed is stubbed or empty:`n$index"
    }
    $bundle = Invoke-WebRequest "$base$asset" -UseBasicParsing -TimeoutSec 30
    if ($bundle.StatusCode -ne 200) { throw "$asset returned HTTP $($bundle.StatusCode)" }
    Write-Host "spa     : $asset ($($bundle.RawContentLength) bytes)"

    # 3. Migrations ran against a real Windows SQLite path.
    $dbDir = if ($DataDir) { $DataDir } else { Join-Path $env:APPDATA 'NeonBench' }
    $db = Join-Path $dbDir 'neonbench.db'
    if (-not (Test-Path $db)) { throw "no SQLite database at $db" }
    # Windows PowerShell 5.1 emits a JSON array as ONE pipeline object, so
    # `@(Invoke-RestMethod ...)` wraps it instead of flattening it: .Count reads
    # 1 and $specs[0].id member-enumerates to every id at once. `+=` onto an
    # empty array flattens correctly under both 5.1 and pwsh 7.
    $specs = @()
    $specs += Invoke-RestMethod "$base/api/tube_specs" -TimeoutSec 10
    if ($specs.Count -lt 1) { throw 'GET /api/tube_specs was empty - migrations or seed did not run' }
    Write-Host "data    : $db ($($specs.Count) seeded tube specs)"

    # 4. Write path: create a project and read it back out of SQLite.
    $body = @{ name = 'ci-smoke'; tube_spec_id = $specs[0].id; units = 'mm' } | ConvertTo-Json
    $created = Invoke-RestMethod "$base/api/projects" -Method Post -Body $body `
        -ContentType 'application/json' -TimeoutSec 10
    $read = Invoke-RestMethod "$base/api/projects/$($created.id)" -TimeoutSec 10
    if ($read.name -ne 'ci-smoke') { throw "project round-trip failed: read back '$($read.name)'" }
    Write-Host "write   : project $($created.id) round-tripped"

    Write-Host "`nwindows smoke OK"
} finally {
    if ($proc -and -not $proc.HasExited) {
        $proc.Kill()
        $proc.WaitForExit(5000) | Out-Null
    }
    if (Test-Path $errLog) {
        Write-Host "`n--- server log (tail) ---"
        Get-Content $errLog -Tail 40
    }
}
