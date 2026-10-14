# Agent launcher for the Cloudflare-hosted experiment.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('agent', 'version', 'help')]
    [string]$Mode,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$SmithArgs
)
$ErrorActionPreference = 'Stop'
$binary = Join-Path $PSScriptRoot 'Smith.exe'
$target = 'https://exp.redmarmosetstudios.com'
if (-not (Test-Path -LiteralPath $binary)) { throw "Smith executable missing: $binary" }
Push-Location $PSScriptRoot
try {
    switch ($Mode) {
        'agent' {
            Write-Host "Smith experiment agent: $target"
            if (-not $env:UNA_ENGINE_PATH -and (Test-Path -LiteralPath 'C:\code\engine\Build\BuildTool')) { $env:UNA_ENGINE_PATH = 'C:\code\engine' }
            & $binary hosted-agent --coordinator $target --workspace (Join-Path $PSScriptRoot 'hosted-workspace') @SmithArgs
        }
        'version' { & $binary version }
        'help' { & $binary help hosted-agent }
    }
    $result = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $result
