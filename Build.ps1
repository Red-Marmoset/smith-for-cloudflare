# Build.ps1 - Build Smith using the Una engine's BuildTool.
#
# Mirrors the brag / p4-grep-ui pattern: auto-detects vcvarsall.bat (pinning
# MSVC toolset 14.44 to match the prebuilt wxWidgets ABI, which the SmithTray
# project links) so the script works from a plain PowerShell window, not only a
# Visual Studio Developer PowerShell.
#
# Usage:
#   .\Build.ps1 [-Project Smith|SmithTray] [-Config Release|Debug] [-Clean]
# Any additional arguments are forwarded to BuildTool verbatim.

param(
    [string]$Project = "Smith",
    [string]$Config = "Release",
    [switch]$Clean,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Extra
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
    Write-Host "  Searched: $($engineCandidates -join '; ')" -ForegroundColor Red
    exit 1
}
$env:UNA_ENGINE_PATH = $enginePath
Write-Host "[Build.ps1] Una engine: $enginePath"

function Invoke-EnvironmentSetup {
    param([string]$Path, [string]$Arguments)
    $tempFile = [IO.Path]::GetTempFileName()
    cmd /c " `"$Path`" $Arguments && set > `"$tempFile`" "
    Get-Content $tempFile | ForEach-Object {
        if ($_ -match "^(.*?)=(.*)$") {
            Set-Content "env:\$($matches[1])" $matches[2]
        }
    }
    Remove-Item $tempFile
}

# Skip MSVC setup entirely if cl.exe is already on PATH.
if (-not (Get-Command "cl.exe" -ErrorAction SilentlyContinue)) {
    Write-Host "Setting up MSVC environment for x64..."
    $vcvarsPaths = @(
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2019\Enterprise\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2019\Professional\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvarsall.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
    )

    $vcvarsFound = $false
    $preferredToolset = "14.44"
    foreach ($path in $vcvarsPaths) {
        if (Test-Path $path) {
            $toolsDir = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $path))) "Tools\MSVC"
            $hasPreferred = $false
            if (Test-Path $toolsDir) {
                $hasPreferred = @(Get-ChildItem -Directory -Path $toolsDir -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -like "$preferredToolset.*" }).Count -gt 0
            }
            if ($hasPreferred) {
                Invoke-EnvironmentSetup -Path $path -Arguments "x64 -vcvars_ver=$preferredToolset"
                Write-Host "MSVC environment configured for x64 (toolset $preferredToolset) from:`n  $path"
            } else {
                Invoke-EnvironmentSetup -Path $path -Arguments "x64"
                Write-Host "MSVC environment configured for x64 (default toolset) from:`n  $path"
            }
            $vcvarsFound = $true
            break
        }
    }

    if (-not $vcvarsFound) {
        Write-Host "ERROR: Could not find vcvarsall.bat for any installed Visual Studio." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "cl.exe already on PATH; skipping MSVC environment setup."
}

# Locate BuildTool. Prefer Release, fall back to MinSizeRel, Debug, Bootstrap.
$candidates = @(
    (Join-Path $enginePath "Build\BuildTool\Release\BuildTool.exe"),
    (Join-Path $enginePath "Build\BuildTool\MinSizeRel\BuildTool.exe"),
    (Join-Path $enginePath "Build\BuildTool\Debug\BuildTool.exe"),
    (Join-Path $enginePath "Build\BuildTool\Bootstrap\BuildTool.exe")
)
$buildTool = $null
foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { $buildTool = $candidate; break }
}

if (-not $buildTool) {
    Write-Host "ERROR: BuildTool not found under $enginePath\Build\BuildTool\." -ForegroundColor Red
    Write-Host "Bootstrap it first: cd $enginePath && .\BootstrapBuildTool.bat" -ForegroundColor Red
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectFile = Join-Path $scriptDir "Workspaces\Projects\$Project\Project.json"
if (-not (Test-Path $projectFile)) {
    Write-Host "ERROR: Project file not found at $projectFile" -ForegroundColor Red
    exit 1
}

$cores = [System.Environment]::ProcessorCount
if ($cores -lt 1) { $cores = 4 }
# Cap parallelism: the SmithTray translation units pull in heavy wxWidgets +
# std::function template instantiations; >4 parallel MSVC compiles can hit
# fatal C1060 "out of heap space" on a fresh build.
if ($cores -gt 4) { $cores = 4 }

Write-Host "[Build.ps1] UNA_ENGINE_PATH=$enginePath"
Write-Host "[Build.ps1] BuildTool=$buildTool"
Write-Host "[Build.ps1] Project=$projectFile"
Write-Host "[Build.ps1] Config=$Config"

# Keep the coordinator's embedded web assets (Modules\SmithCoordinator\WebAssets.cpp)
# in sync with web\ so the production binary never serves a stale UI. WebAssets.cpp is
# generated - never hand-edited. Skips quietly if the generator is unavailable.
$webDir = Join-Path $scriptDir "web"
$genPs1 = Join-Path $scriptDir "tools\gen-web-assets.ps1"
$genPy  = Join-Path $scriptDir "tools\gen-web-assets.py"
if (Test-Path $webDir) {
    if (Test-Path $genPs1) {
        Write-Host "[Build.ps1] Regenerating embedded web assets"
        & $genPs1 | Out-Null
    } elseif ((Test-Path $genPy) -and (Get-Command python -ErrorAction SilentlyContinue)) {
        Write-Host "[Build.ps1] Regenerating embedded web assets"
        & python $genPy | Out-Null
    }
}

$buildArgs = @($projectFile, "-config", $Config, "-j", "$cores")

# Stale-cache guard. BuildTool's shared cache is keyed per module, so after a header
# LAYOUT change (adding a member to a struct another module includes - typically
# after switching branches or pulling) it can hand back a module compiled against
# the OLD layout. That links cleanly and then corrupts memory at runtime: garbage
# container sizes, std::length_error, or a hang. Hash the headers/manifests and
# clean whenever they move, so this can't be hit by accident.
$hashFile = Join-Path $scriptDir "Build\.header-state"
$headerHash = $null
try {
    $srcFiles = Get-ChildItem -Path (Join-Path $scriptDir "Modules"), (Join-Path $scriptDir "Workspaces") `
                    -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like "*.h" -or $_.Name -eq "Module.manifest" -or $_.Name -eq "Project.json" } |
                Sort-Object FullName
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $acc = New-Object System.IO.MemoryStream
    foreach ($f in $srcFiles) { $b = [System.IO.File]::ReadAllBytes($f.FullName); $acc.Write($b, 0, $b.Length) }
    $headerHash = [System.BitConverter]::ToString($sha.ComputeHash($acc.ToArray())).Replace("-", "")
    $acc.Dispose(); $sha.Dispose()
} catch { $headerHash = $null }
if ($headerHash) {
    $prev = if (Test-Path $hashFile) { (Get-Content $hashFile -Raw).Trim() } else { $null }
    if ($prev -ne $headerHash) {
        Write-Host "[Build.ps1] Headers changed since the last build - clearing the build cache"
        $Clean = $true
    }
}

if ($Clean) {
    # Belt-and-braces clean: BuildTool's own --clean has been less reliable than
    # nuking the cache directories ourselves (stale .obj keyed to an old ABI can
    # cause 0xC0000374 at launch). See engine / brag CLAUDE.md foot-guns.
    $unaDir = Join-Path $scriptDir ".una"
    $intDir = Join-Path $scriptDir "Build\Intermediate"
    if (Test-Path $unaDir) { Write-Host "[Build.ps1] Clean: removing $unaDir"; Remove-Item -Recurse -Force $unaDir }
    if (Test-Path $intDir) { Write-Host "[Build.ps1] Clean: removing $intDir"; Remove-Item -Recurse -Force $intDir }
    $buildArgs += "--clean"
}
if ($Extra) { $buildArgs += $Extra }

Push-Location $scriptDir
try {
    & $buildTool @buildArgs
    $rc = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($rc -ne 0) {
    Write-Host "$Project build failed with exit code $rc." -ForegroundColor Red
    exit $rc
}
# Record the header state only after a successful build, so a failed one doesn't
# leave the next build thinking the cache is already consistent.
if ($headerHash) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $hashFile) | Out-Null
    Set-Content -Path $hashFile -Value $headerHash -NoNewline
}
Write-Host "$Project build complete." -ForegroundColor Green
