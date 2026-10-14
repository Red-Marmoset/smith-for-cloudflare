# RunTests.ps1 - Build and run every Tests/<Name>/Project.json test project.
#
# Each test's Main.cpp implements Test::TestMain and returns the failure count as
# its exit code (0 = all passed). Mirrors the engine's RunTests convention.
#
# Usage: .\RunTests.ps1 [-Config Release|Debug] [-Jobs N]

param(
    [string]$Config = "Release",
    [int]$Jobs = 4
)

$ErrorActionPreference = "Stop"

# Locate the Una engine. UNA_ENGINE_PATH wins; otherwise search common locations,
# validating each candidate actually has a bootstrapped BuildTool.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$engineCandidates = @($env:UNA_ENGINE_PATH,
    "C:\code\engine",
    (Join-Path (Split-Path -Parent $here) "engine"),
    (Join-Path $env:USERPROFILE "code\engine"),
    "D:\code\engine") | Where-Object { $_ }
$enginePath = $null
foreach ($cand in $engineCandidates) {
    foreach ($cfg in @("Release", "MinSizeRel", "Debug", "Bootstrap")) {
        if (Test-Path (Join-Path $cand "Build\BuildTool\$cfg\BuildTool.exe")) { $enginePath = $cand; break }
    }
    if ($enginePath) { break }
}
if (-not $enginePath) {
    Write-Host "ERROR: Una engine not found. Set UNA_ENGINE_PATH to your engine checkout (with a bootstrapped BuildTool)." -ForegroundColor Red
    exit 1
}
$env:UNA_ENGINE_PATH = $enginePath

function Invoke-EnvironmentSetup {
    param([string]$Path, [string]$Arguments)
    $tempFile = [IO.Path]::GetTempFileName()
    cmd /c " `"$Path`" $Arguments && set > `"$tempFile`" "
    Get-Content $tempFile | ForEach-Object {
        if ($_ -match "^(.*?)=(.*)$") { Set-Content "env:\$($matches[1])" $matches[2] }
    }
    Remove-Item $tempFile
}

if (-not (Get-Command "cl.exe" -ErrorAction SilentlyContinue)) {
    $vcvarsPaths = @(
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
    )
    $found = $false
    foreach ($p in $vcvarsPaths) {
        if (Test-Path $p) { Invoke-EnvironmentSetup -Path $p -Arguments "x64"; $found = $true; break }
    }
    if (-not $found) {
        Write-Host "ERROR: Could not find vcvarsall.bat. Run from a VS Developer PowerShell." -ForegroundColor Red
        exit 1
    }
}

$candidates = @(
    (Join-Path $enginePath "Build\BuildTool\Release\BuildTool.exe"),
    (Join-Path $enginePath "Build\BuildTool\MinSizeRel\BuildTool.exe"),
    (Join-Path $enginePath "Build\BuildTool\Debug\BuildTool.exe"),
    (Join-Path $enginePath "Build\BuildTool\Bootstrap\BuildTool.exe")
)
$buildTool = $null
foreach ($c in $candidates) { if (Test-Path $c) { $buildTool = $c; break } }
if (-not $buildTool) {
    Write-Host "ERROR: BuildTool not found under $enginePath. Bootstrap the engine first." -ForegroundColor Red
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$testsDir = Join-Path $scriptDir "Tests"
if (-not (Test-Path $testsDir)) {
    Write-Host "[RunTests] No Tests/ directory yet - nothing to run." -ForegroundColor Yellow
    exit 0
}

$passed = 0
$failed = 0
$failedNames = @()
# BuildTool's shared-cache signature does not reliably track source/header changes:
# a stale cached .obj (an outdated Main.cpp compiled against an old struct layout,
# linked with current modules) produced an ABI-mismatch stack corruption that
# crashed SmithCoreTest at exit (0xC0000409) while reporting stale results. Until
# the engine cache hashes properly, EVERY test project builds with --clean -
# correctness over the few seconds saved.

Push-Location $scriptDir
try {
    foreach ($dir in (Get-ChildItem $testsDir -Directory)) {
        $projectFile = Join-Path $dir.FullName "Project.json"
        if (-not (Test-Path $projectFile)) { continue }
        $name = $dir.Name

        Write-Host "`n======== $name ========" -ForegroundColor Cyan
        # Cap parallel MSVC compiles, as Build.ps1 does: >4 can hit C1060 "out of heap space" on a clean build.
        $btArgs = @($projectFile, "-config", $Config, "--clean", "-j", "$Jobs")
        & $buildTool @btArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: build failed for $name" -ForegroundColor Red
            $failed++; $failedNames += "$name (build)"; continue
        }

        $exe = Join-Path $scriptDir "Build\$name\$Config\$name.exe"
        if (-not (Test-Path $exe)) {
            Write-Host "ERROR: test exe not found: $exe" -ForegroundColor Red
            $failed++; $failedNames += "$name (missing exe)"; continue
        }

        # Integration tests start a real agent. Never let its maintenance update
        # the developer machine; update policy is covered with a controlled runner.
        # The test's own output (agent chatter: tool maintenance, chat/Codex runs,
        # heartbeats) goes to Build\TestLogs\<name>.log, not the build log; it is
        # printed only when the test fails. Errors are relaxed around the call so
        # a native stderr line can't trip $ErrorActionPreference = Stop.
        $logDir = Join-Path $scriptDir "Build\TestLogs"
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $testLog = Join-Path $logDir "$name.log"
        $savedToolUpdates = $env:SMITH_AUTO_UPDATE_TOOLS
        try {
            $env:SMITH_AUTO_UPDATE_TOOLS = '0'; $ErrorActionPreference = "Continue"
            & $exe 2>&1 | ForEach-Object { "$_" } | Set-Content -Path $testLog -Encoding UTF8
        }
        finally { $env:SMITH_AUTO_UPDATE_TOOLS = $savedToolUpdates; $ErrorActionPreference = "Stop" }
        if ($LASTEXITCODE -ne 0) {
            $rc = $LASTEXITCODE
            Get-Content $testLog -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
            Write-Host "$name FAILED (exit $rc) - output above, also in $testLog" -ForegroundColor Red
            $failed++; $failedNames += $name
        } else {
            Write-Host "$name passed" -ForegroundColor Green
            $passed++
        }
    }
} finally {
    Pop-Location
}

Write-Host "`n========================================"
if ($failed -eq 0) {
    Write-Host "ALL $passed TEST PROJECT(S) PASSED" -ForegroundColor Green
    exit 0
} else {
    Write-Host "$failed TEST PROJECT(S) FAILED, $passed PASSED" -ForegroundColor Red
    $failedNames | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
