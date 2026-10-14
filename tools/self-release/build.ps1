# Build an immutable candidate from a tested revision. Does not deploy or promote.
# Set SMITH_RELEASE_BRANCH and SMITH_COORDINATOR_URL on the build machine, or pass
# -Branch and -CoordinatorUrl explicitly. Source repository comes from Git origin.
param(
    [string]$Branch = $env:SMITH_RELEASE_BRANCH,
    [string]$CoordinatorUrl = $env:SMITH_COORDINATOR_URL
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($Branch)) { throw 'Pass -Branch or set SMITH_RELEASE_BRANCH to the source branch.' }
if ([string]::IsNullOrWhiteSpace($CoordinatorUrl)) { throw 'Pass -CoordinatorUrl or set SMITH_COORDINATOR_URL to an HTTPS origin.' }
$origin = $null
if (-not [Uri]::TryCreate($CoordinatorUrl, [UriKind]::Absolute, [ref]$origin) -or
    $origin.Scheme -ne 'https' -or -not $origin.Host -or $origin.UserInfo -or
    $origin.Query -or $origin.Fragment -or $CoordinatorUrl -ne $origin.GetLeftPart([UriPartial]::Authority)) {
    throw 'CoordinatorUrl must be an HTTPS origin without credentials, path, query or fragment.'
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$releaseDir = Join-Path $repoRoot 'Build/SelfRelease'
$bundleDir = Join-Path $releaseDir ('worker-bundle-' + [Guid]::NewGuid().ToString('N'))
$candidate = Join-Path $releaseDir 'smith-release.zip'
$coordinatorDir = Join-Path $repoRoot 'cloudflare/coordinator'
$powerShell = (Get-Process -Id $PID).Path
$python = (Get-Command python -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Executable" }
}

Push-Location $repoRoot
try {
    & git check-ref-format --branch $Branch | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Branch is not a valid Git branch name.' }
    $trackedChanges = & git status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git checkout.' }
    if ($trackedChanges) { throw 'Self-release requires a clean tracked checkout before building. Commit or restore tracked changes first.' }
    $commit = (& git rev-parse --verify HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -cnotmatch '^[0-9a-f]{40}$') { throw 'Could not determine the full Git commit.' }
    $repository = (& git remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $repository -notmatch '^(https://[^/@\s]+/[^\s?#]+|ssh://git@[^/\s]+/[^\s?#]+|git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+)$') {
        throw 'Git origin must be HTTPS or SSH and must not contain embedded credentials.'
    }
    Write-Host "Self-release repository: $repository"
    Write-Host "Self-release branch: $Branch"
    Write-Host "Self-release commit: $commit"
    Write-Host "Self-release coordinator: $CoordinatorUrl"

    # Resolve the fixed output beneath this checkout and reject junctions before removing generated files.
    if (-not ([IO.Path]::GetFullPath($releaseDir)).StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release output must stay inside the source checkout.'
    }
    foreach ($outputDirectory in @((Join-Path $repoRoot 'Build'), $releaseDir)) {
        if ((Test-Path -LiteralPath $outputDirectory) -and
            ((Get-Item -LiteralPath $outputDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Release directories must not be links.' }
    }
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    # Never leave a previous checkout's candidate at the declared artifact path on build failure.
    foreach ($generatedFile in @($candidate, ($candidate + '.sha256'))) {
        if (Test-Path -LiteralPath $generatedFile) {
            $outputItem = Get-Item -LiteralPath $generatedFile
            if ($outputItem.PSIsContainer -or ($outputItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Release output must be a regular file.' }
            Remove-Item -LiteralPath $generatedFile -Force
        }
    }
    Invoke-Checked -Executable $python -Arguments @('tools/self-release/test_package.py')
    Invoke-Checked -Executable $python -Arguments @('tools/self-release/test_promote.py')
    Invoke-Checked -Executable $powerShell -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'RunTests.ps1', '-Config', 'Release')
    Invoke-Checked -Executable $powerShell -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'Build.ps1', '-Project', 'Smith', '-Config', 'Release')

    Push-Location $coordinatorDir
    try {
        $env:WRANGLER_LOG_PATH = Join-Path $releaseDir 'wrangler-logs'
        $env:WRANGLER_SEND_METRICS = 'false'
        Invoke-Checked -Executable $npm -Arguments @('ci', '--no-audit', '--no-fund')
        Invoke-Checked -Executable $npm -Arguments @('run', 'verify')
        Invoke-Checked -Executable $npx -Arguments @('--no-install', 'wrangler', 'deploy', '--dry-run', '--outdir', $bundleDir)
    } finally { Pop-Location }

    $finalCommit = (& git rev-parse --verify HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $finalCommit -ne $commit) { throw 'Git HEAD changed while building; candidate rejected.' }
    # Both files are deterministic build/type generation outputs; source edits are never ignored.
    & git diff --quiet HEAD -- . ':(exclude)Modules/SmithCoordinator/WebAssets.cpp' ':(exclude)cloudflare/coordinator/worker-configuration.d.ts'
    if ($LASTEXITCODE -ne 0) { throw 'Tracked source changed while building; candidate rejected.' }
    Invoke-Checked -Executable $python -Arguments @(
        'tools/self-release/package.py', '--repo-root', $repoRoot,
        '--binary-dir', (Join-Path $repoRoot 'Build/Smith/Release'), '--bundle-dir', $bundleDir,
        '--output', $candidate, '--repository', $repository, '--branch', $Branch,
        '--commit', $commit, '--coordinator-origin', $CoordinatorUrl
    )
    Write-Host "Candidate ready: $candidate"
    Write-Host 'Promotion is a separate explicit operation. Nothing has been deployed.'
} finally { Pop-Location }
