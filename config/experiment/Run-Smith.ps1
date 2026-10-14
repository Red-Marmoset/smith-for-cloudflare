# Run-Smith.ps1 - keeps this folder's Smith agent running in the background, with no window.
#
# You never run this yourself: Setup-Smith.bat starts it and registers it to start when you log on
# to Windows. It restarts the agent whenever it stops, waiting longer between tries while the
# network or coordinator is down. It stops for good when "Setup-Smith.bat stop" asks (the stop-agent
# file) or when the agent's saved connection no longer works (exit code 3: run Setup-Smith.bat
# reconnect). Everything the agent prints goes to agent.log next to this file.
$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
$launcher = Join-Path $dir 'Start-Smith.bat'
$stopFile = Join-Path $dir 'stop-agent'
$log = Join-Path $dir 'agent.log'

# One keeper per folder, however many times it is launched.
$hash = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($dir.ToLowerInvariant()))
$mutexName = 'Local\SmithAgent-' + [BitConverter]::ToString($hash).Replace('-', '')
$mutex = [Threading.Mutex]::new($false, $mutexName)
try { if (-not $mutex.WaitOne(0)) { exit 0 } } catch [Threading.AbandonedMutexException] { }   # abandoned = ours now

function Note([string]$text) {
    Add-Content -LiteralPath $log -Encoding ASCII -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text)
}

Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
$delay = 5
while ($true) {
    if (Test-Path -LiteralPath $stopFile) { Note 'Stopped on request.'; Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue; break }
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) { Move-Item -LiteralPath $log -Destination "$log.old" -Force }
    Note 'Starting the Smith agent.'
    $started = Get-Date
    # Go through the launcher, not Smith.exe, so its update restarts and rollback still apply.
    # cmd does the redirection so stdout and stderr land in one log, in order. /s keeps the inner quotes.
    $arguments = "/d /s /c `"`"$launcher`" agent >>`"$log`" 2>&1`""
    $process = Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -WorkingDirectory $dir -NoNewWindow -PassThru
    $null = $process.Handle   # keep the handle so ExitCode is available after the wait
    $process.WaitForExit()
    $code = $process.ExitCode
    if (Test-Path -LiteralPath $stopFile) {
        Note 'Stopped on request.'
        Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
        break
    }
    if ($code -eq 3) { Note 'Stopped: this computer needs reconnecting. Run Setup-Smith.bat reconnect.'; break }
    if (((Get-Date) - $started).TotalMinutes -ge 10) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 300) }
    Note "The agent exited with code $code; restarting in $delay seconds."
    for ($i = 0; $i -lt $delay -and -not (Test-Path -LiteralPath $stopFile); $i++) { Start-Sleep -Seconds 1 }
}
