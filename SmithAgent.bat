@echo off
rem SmithAgent.bat - run this computer's Smith agent for the hosted experiment from ONE fixed folder,
rem so you never have to know where it lives. Double-click it for a menu, or:
rem
rem   SmithAgent.bat install   build Smith from this checkout, install it to the agent folder, set it up
rem   SmithAgent.bat start     connect if needed, start at logon, start now (Setup-Smith.bat in the folder)
rem   SmithAgent.bat stop      stop the agent (waits for a running build to finish)
rem   SmithAgent.bat status    is it running? shows the end of its log
rem   SmithAgent.bat find      list Smith agents running on this computer and folders where one was set up
rem
rem The agent folder is C:\SmithAgent unless you set SMITH_AGENT_HOME. Setup asks once for the connect
rem code from "Connect build machine" in the dashboard; after that the agent runs in the background,
rem starts when you log on to Windows and reconnects by itself.
rem
rem Only processes running "Smith.exe hosted-agent" are ever stopped; a LAN coordinator or LAN agent
rem on this computer is left alone.
setlocal EnableExtensions DisableDelayedExpansion
set "REPO=%~dp0"
set "SELF=%~nx0"
if not defined SMITH_AGENT_HOME set "SMITH_AGENT_HOME=C:\SmithAgent"
set "SETUP=%SMITH_AGENT_HOME%\Setup-Smith.bat"
set "STOP_FILE=%SMITH_AGENT_HOME%\stop-agent"
rem Packaged here, not in Build\SmithExperiment\Release, so an older agent running there cannot block it.
set "STAGING=%~dp0Build\SmithAgentStaging"
set "EXITCODE=0"

if /i "%~1"=="install" goto install
if /i "%~1"=="update" goto install
if /i "%~1"=="start" goto start
if /i "%~1"=="stop" goto stop
if /i "%~1"=="status" goto status
if /i "%~1"=="find" goto find
if /i "%~1"=="help" goto help
if /i "%~1"=="--help" goto help
if not "%~1"=="" (
    echo Usage: %SELF% [install ^| start ^| stop ^| status ^| find ^| help]
    set "EXITCODE=2"
    goto finish
)

echo Smith agent folder: %SMITH_AGENT_HOME%
echo   1. Install or update from this checkout, then start
echo   2. Start
echo   3. Stop
echo   4. Status
echo   5. Find agents on this computer
echo   6. Help with setup and troubleshooting
choice /c 123456 /m "Choose"
if errorlevel 6 goto help
if errorlevel 5 goto find
if errorlevel 4 goto status
if errorlevel 3 goto stop
if errorlevel 2 goto start
goto install

:help
echo Smith hosted agent help
echo   install / update  Build from this checkout, preserve enrollment, then start.
echo   start             Run the installed agent. First start needs the dashboard workspace ID and code.
echo   stop              Gracefully finish build work, then stop. Stop active chats separately.
echo   status            Show whether the installed agent is running.
echo   find              Find hosted agents and saved connection folders on this computer.
echo   Agent folder:     %SMITH_AGENT_HOME% ^(override with SMITH_AGENT_HOME^).
echo   Use Connect my computer for personal AI chats; install and sign in to the coding CLI locally.
echo   Full guide: https://exp.redmarmosetstudios.com/help.html
echo   Source guides: docs\user-guide.md and docs\smith-json.md
echo   Planned workflows: docs\task-stubs.md
goto finish

rem ---------------------------------------------------------------------------------------------
:find
echo Smith hosted agents running now:
call :list_agents all
echo.
echo Folders where a hosted agent has been enrolled (each holds its saved connection):
set "FOUND="
echo   (searching your Downloads, Desktop, Documents, C:\code and C:\Smith* folders; this can take a minute)
for %%R in ("%SMITH_AGENT_HOME%" "%USERPROFILE%\Downloads" "%USERPROFILE%\Desktop" "%USERPROFILE%\Documents" "C:\code" "%REPO%Build") do call :scan "%%~R"
for /d %%D in (C:\Smith*) do if /i not "%%~fD"=="%SMITH_AGENT_HOME%" call :scan "%%~fD"
if not defined FOUND echo   (none found)
echo.
echo From now on, use "%SELF% install" so the agent always lives in %SMITH_AGENT_HOME%.
goto finish

:scan
if not exist "%~1\" exit /b 0
for /f "delims=" %%F in ('where /r "%~1" hosted-state.json 2^>nul') do call :report "%%~dpF"
exit /b 0

:report
rem %1 is ...\<agent folder>\hosted-workspace\ ; show the agent folder.
for %%G in ("%~1..") do echo   %%~fG
set "FOUND=1"
exit /b 0

rem ---------------------------------------------------------------------------------------------
:install
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (echo ERROR: Python 3 is not on PATH.& goto failed)
echo [1/4] Building Smith from %REPO% ...
call "%REPO%Build.bat" -Config Release || goto failed
if exist "%STAGING%\" rmdir /s /q "%STAGING%" || goto failed
%PY% "%REPO%tools\package-experiment.py" --binary-dir "%REPO%Build\Smith\Release" --output "%STAGING%" || goto failed
echo.
echo [2/4] Stopping the agent in %SMITH_AGENT_HOME%, if it is running...
call :stop_agent || goto failed
echo.
echo [3/4] Installing into %SMITH_AGENT_HOME% ...
if not exist "%SMITH_AGENT_HOME%\" mkdir "%SMITH_AGENT_HOME%" || goto failed
copy /y "%STAGING%\*" "%SMITH_AGENT_HOME%\" >nul || (echo ERROR: Copying into %SMITH_AGENT_HOME% failed.& goto failed)
rem A hand install replaces whatever a self-update left half-done (it would otherwise be rolled back).
if exist "%SMITH_AGENT_HOME%\update-pending.json" del /q "%SMITH_AGENT_HOME%\update-pending.json"
if exist "%SMITH_AGENT_HOME%\.update-previous\" rmdir /s /q "%SMITH_AGENT_HOME%\.update-previous"
if exist "%SMITH_AGENT_HOME%\.update-staging\" rmdir /s /q "%SMITH_AGENT_HOME%\.update-staging"
call :stop_others
echo.
echo [4/4] Setting it up...
goto start

rem ---------------------------------------------------------------------------------------------
:start
if not exist "%SETUP%" (
    echo The agent is not installed in %SMITH_AGENT_HOME% yet. Run: %SELF% install
    goto failed
)
call "%SETUP%"
if errorlevel 1 set "EXITCODE=1"
goto finish

:status
if not exist "%SETUP%" (
    echo The agent is not installed in %SMITH_AGENT_HOME% yet. Run: %SELF% install
    goto failed
)
call "%SETUP%" status
goto finish

rem ---------------------------------------------------------------------------------------------
:stop
if exist "%SETUP%" (
    call "%SETUP%" stop
) else (
    call :stop_agent
)
if errorlevel 1 set "EXITCODE=1"
goto finish

rem Stops the agent in SMITH_AGENT_HOME and the background keeper that restarts it. Used before
rem installing, when the folder may still hold an older package without Setup-Smith.bat.
:stop_agent
call :count_agents home
if not errorlevel 1 goto stop_keeper
echo   Asking it to stop; a build in progress is allowed to finish first...
type nul > "%STOP_FILE%"
for /l %%S in (1,1,120) do (
    call :count_agents home
    if not errorlevel 1 goto stop_keeper
    timeout /t 5 /nobreak >nul
)
echo   It is still busy after 10 minutes.
choice /c YN /m "  Stop it now? Its current build would be marked lost"
if errorlevel 2 exit /b 1
call :kill_agents home
:stop_keeper
call :kill_keeper
if exist "%STOP_FILE%" del /q "%STOP_FILE%"
echo   Stopped.
exit /b 0

:stop_others
call :count_agents others
if not errorlevel 1 exit /b 0
echo.
echo Another Smith hosted agent is running from a different folder:
call :list_agents others
echo Running two agents is harmless but confusing. The one above was set up before this script.
choice /c YN /m "Stop it so only %SMITH_AGENT_HOME% runs your builds"
if errorlevel 2 exit /b 0
call :kill_agents others
echo Stopped. It still appears as an offline machine in the dashboard; you can disconnect it there.
exit /b 0

rem ---------------------------------------------------------------------------------------------
rem Process helpers. Windows has no batch command that shows a process's command line, so these ask
rem PowerShell for it; you never need to use PowerShell yourself. %1 selects which hosted agents:
rem   all = every hosted agent, home = the one in SMITH_AGENT_HOME, others = every other hosted agent.
:count_agents
set "SMITH_PICK=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h = ($env:SMITH_AGENT_HOME + '\hosted-workspace').ToLower(); exit @(Get-CimInstance Win32_Process -Filter 'Name=''Smith.exe''' | Where-Object { $c = [string]$_.CommandLine; $mine = $c.ToLower().Contains($h); $c -match 'hosted-agent' -and ($env:SMITH_PICK -eq 'all' -or ($env:SMITH_PICK -eq 'home' -and $mine) -or ($env:SMITH_PICK -eq 'others' -and -not $mine)) }).Count"
exit /b %errorlevel%

:list_agents
set "SMITH_PICK=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h = ($env:SMITH_AGENT_HOME + '\hosted-workspace').ToLower(); $p = @(Get-CimInstance Win32_Process -Filter 'Name=''Smith.exe''' | Where-Object { $c = [string]$_.CommandLine; $mine = $c.ToLower().Contains($h); $c -match 'hosted-agent' -and ($env:SMITH_PICK -eq 'all' -or ($env:SMITH_PICK -eq 'home' -and $mine) -or ($env:SMITH_PICK -eq 'others' -and -not $mine)) }); if ($p.Count -eq 0) { '  (none)' } else { $p | ForEach-Object { '  ' + $_.ExecutablePath + '   [process ' + $_.ProcessId + ']' } }"
exit /b 0

:kill_agents
set "SMITH_PICK=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h = ($env:SMITH_AGENT_HOME + '\hosted-workspace').ToLower(); Get-CimInstance Win32_Process -Filter 'Name=''Smith.exe''' | Where-Object { $c = [string]$_.CommandLine; $mine = $c.ToLower().Contains($h); $c -match 'hosted-agent' -and (($env:SMITH_PICK -eq 'home' -and $mine) -or ($env:SMITH_PICK -eq 'others' -and -not $mine)) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
exit /b 0

rem The background keeper (Run-Smith.ps1) restarts the agent; stop it too so files can be replaced.
:kill_keeper
powershell -NoProfile -ExecutionPolicy Bypass -Command "$k = ($env:SMITH_AGENT_HOME + '\Run-Smith.ps1').ToLower(); Get-CimInstance Win32_Process -Filter 'Name=''powershell.exe''' | Where-Object { ([string]$_.CommandLine).ToLower().Contains($k) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
exit /b 0

rem ---------------------------------------------------------------------------------------------
:failed
echo.
echo Stopped because of the error above.
set "EXITCODE=1"
:finish
rem Keep the window open when started by double-clicking.
echo %cmdcmdline% | findstr /i /c:"%SELF%" >nul && pause
exit /b %EXITCODE%
