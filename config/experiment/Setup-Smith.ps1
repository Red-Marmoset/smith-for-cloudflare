# Setup-Smith.ps1 - the logic behind Setup-Smith.bat; run that instead (double-click it).
param(
    [ValidateSet('setup', 'start', 'status', 'stop', 'remove', 'reconnect')]
    [string]$Command = 'setup'
)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$exe = Join-Path $dir 'Smith.exe'
$workspace = Join-Path $dir 'hosted-workspace'
$state = Join-Path $workspace 'hosted-state.json'
$stopFile = Join-Path $dir 'stop-agent'
$log = Join-Path $dir 'agent.log'
$keeper = Join-Path $dir 'Run-Smith.ps1'
$target = 'https://exp.redmarmosetstudios.com'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'Smith agent'
$keeperArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$keeper`""
$launch = "powershell.exe $keeperArgs"

# The background keeper (Run-Smith.ps1) and the agent it runs, for this folder only.
function Get-Keeper {
    @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { ([string]$_.CommandLine).ToLowerInvariant().Contains($keeper.ToLowerInvariant()) })
}
function Get-Agent {
    @(Get-CimInstance Win32_Process -Filter "Name='Smith.exe'" |
        Where-Object { $c = ([string]$_.CommandLine).ToLowerInvariant(); $c.Contains('hosted-agent') -and $c.Contains($workspace.ToLowerInvariant()) })
}
function Get-Autostart { (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue).$runName }

function Stop-Agent {
    if ((Get-Agent).Count -eq 0 -and (Get-Keeper).Count -eq 0) { Write-Host 'The agent is not running.'; return $true }
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
    Write-Host 'Stopping the agent; a build in progress is allowed to finish first...'
    $deadline = (Get-Date).AddMinutes(10)
    while ((Get-Agent).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
    if ((Get-Agent).Count -gt 0) {
        $answer = Read-Host 'It is still busy after 10 minutes. Stop it now? Its current build would be marked lost [y/N]'
        if ($answer -notmatch '^[yY]') { return $false }
        Get-Agent | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Keeper).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Get-Keeper | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Stopped.'
    return $true
}

function Show-Status {
    $agents = Get-Agent; $keepers = Get-Keeper
    if ($agents.Count -gt 0) { Write-Host "Running in the background (process $($agents[0].ProcessId))." }
    elseif ($keepers.Count -gt 0) { Write-Host 'Not running right now; it is waiting to restart (see the log below).' }
    else { Write-Host 'Not running.' }
    $autostart = Get-Autostart
    if ($autostart -eq $launch) { Write-Host 'Starts when you log on to Windows: yes.' }
    elseif ($autostart) { Write-Host "Starts when you log on to Windows: a different folder does ($autostart)." }
    else { Write-Host 'Starts when you log on to Windows: no. Run Setup-Smith.bat to turn it on.' }
    if (Test-Path -LiteralPath $log) {
        Write-Host ''
        Write-Host "Last lines of $log :"
        Get-Content -LiteralPath $log -Tail 15 | ForEach-Object { Write-Host "  $_" }
    }
}

function Connect-Agent {
    Write-Host ''
    Write-Host 'In the Smith dashboard, click "Connect build machine" and copy the connect code.'
    while ($true) {
        # Start-Process keeps Smith on this console, so its prompt and the * echo show as typed;
        # calling it with & inside a function would capture its output instead.
        $process = Start-Process -FilePath $exe -ArgumentList "hosted-agent --coordinator $target --workspace `"$workspace`" --enroll-only" -NoNewWindow -Wait -PassThru
        if ($process.ExitCode -eq 0) { return $true }
        Write-Host ''
        $answer = Read-Host 'That did not connect. Each code works once: open "Connect build machine" again for a fresh one. Try again? [Y/n]'
        if ($answer -match '^[nN]') { return $false }
    }
}

function Start-Keeper {
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    $before = 0; if (Test-Path -LiteralPath $log) { $before = (Get-Item -LiteralPath $log).Length }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $keeperArgs -WindowStyle Hidden | Out-Null
    Write-Host 'Starting the agent in the background...'
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (-not (Test-Path -LiteralPath $log)) { continue }
        # The running agent holds agent.log open for appending; open it shared or the read fails.
        try {
            $stream = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite, Delete')
            try { $text = (New-Object IO.StreamReader($stream)).ReadToEnd() } finally { $stream.Dispose() }
        } catch { continue }
        if ($text.Length -lt $before) { $before = 0 }   # the log was rotated
        $new = $text.Substring([Math]::Min($before, $text.Length))
        if ($new.Contains('Online: the coordinator accepted this agent')) {
            Write-Host 'Online. This computer now shows in the dashboard.'
            return
        }
        if ($new.Contains('needs reconnecting')) { break }
    }
    Write-Host 'It has not come online yet. It keeps trying in the background; the log so far:'
    Get-Content -LiteralPath $log -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
    Write-Host 'Check again later with: Setup-Smith.bat status'
}

if (-not (Test-Path -LiteralPath $exe)) { Write-Host "Smith.exe is missing from $dir. Extract the whole package into this folder."; exit 1 }

switch ($Command) {
    'status' { Show-Status; exit 0 }
    'stop' {
        if (-not (Stop-Agent)) { exit 1 }
        if (Get-Autostart) { Write-Host 'It starts again the next time you log on. To stop that too: Setup-Smith.bat remove' }
        exit 0
    }
    'remove' {
        if (-not (Stop-Agent)) { exit 1 }
        if ((Get-Autostart) -eq $launch) { Remove-ItemProperty -Path $runKey -Name $runName }
        Write-Host 'It no longer starts when you log on. Its connection is kept: Setup-Smith.bat turns it back on.'
        exit 0
    }
}

Write-Host "Smith agent folder: $dir"
if ($Command -eq 'reconnect' -and (Test-Path -LiteralPath $workspace)) {
    if (-not (Stop-Agent)) { exit 1 }
    $old = "$workspace.old-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item -LiteralPath $workspace -Destination $old
    Write-Host "Moved the old connection aside to $old."
    Write-Host 'In the dashboard you can disconnect the old machine entry.'
}

# 1. Connect once. After this the saved connection is reused forever.
if (-not (Test-Path -LiteralPath $state)) {
    if (-not (Connect-Agent)) { exit 1 }
}

# 2. An agent started by hand in a window (the old way) holds the folder; move it to the background.
if ((Get-Agent).Count -gt 0 -and (Get-Keeper).Count -eq 0) {
    Write-Host 'An agent from this folder is running in a window; moving it to the background.'
    if (-not (Stop-Agent)) { exit 1 }
}

# 3. Start at logon: a per-user Run entry, so no administrator rights are needed.
$previous = Get-Autostart
if ($previous -ne $launch) {
    if ($previous) { Write-Host "Replacing the previous start-at-logon entry: $previous" }
    if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
    Set-ItemProperty -Path $runKey -Name $runName -Value $launch
}
Write-Host 'It starts by itself whenever you log on to Windows, and restarts if it ever stops.'

# 4. Start it now, unless it is already running.
if ((Get-Keeper).Count -gt 0) { Write-Host 'It is already running in the background.' }
else { Start-Keeper }
Write-Host ''
Write-Host 'Check on it: Setup-Smith.bat status    Stop it: Setup-Smith.bat stop'
exit 0
