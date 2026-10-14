@echo off
rem Smith agent launcher for the Cloudflare-hosted experiment. No PowerShell needed.
rem
rem   Start-Smith.bat agent --workspace-id <workspace-id>   connect this computer and run builds/chats
rem   Start-Smith.bat version                               print the packaged Smith version
rem
rem The first run asks for the one-use enrollment code from the dashboard (shown as *****).
rem Later runs reuse the saved enrollment in the hosted-workspace folder next to this file.
rem To stop it cleanly, create a file named stop-agent next to this file: the agent exits once its
rem current build is finished (SmithAgent.bat stop does this for you).
rem
rem The agent keeps itself up to date: when the dashboard publishes a newer package it installs it
rem between builds and exits with code 10, and this launcher starts the new version at once. If the
rem new version stops before the coordinator accepts it, the previous files are put back.
rem Set SMITH_AGENT_AUTO_UPDATE=0 to switch that off.
setlocal EnableExtensions DisableDelayedExpansion
set "SMITH_DIR=%~dp0"
set "SMITH_EXE=%~dp0Smith.exe"
set "SMITH_TARGET=https://exp.redmarmosetstudios.com"

if not exist "%SMITH_EXE%" (
    echo ERROR: Smith executable missing: "%SMITH_EXE%"
    exit /b 1
)
if /i "%~1"=="version" goto version
if /i "%~1"=="help" goto help
if /i "%~1"=="--help" goto help
if /i "%~1"=="-h" goto help
if /i "%~1"=="agent" goto agent
echo Usage: %~nx0 agent --workspace-id ^<workspace-id^>
echo        %~nx0 version
echo        %~nx0 help
exit /b 2

:help
"%SMITH_EXE%" help hosted-agent
exit /b %errorlevel%

:version
"%SMITH_EXE%" version
exit /b %errorlevel%

:agent
rem Pass everything after "agent" through unchanged (keeps comma lists such as --labels a,b intact).
set "SMITH_ARGS="
for /f "tokens=1,* delims= " %%A in ("%*") do set "SMITH_ARGS=%%B"
:agent-help-check
rem Help in any argument position must not clear a pending graceful-stop request.
if "%~1"=="" goto agent-run
if /i "%~1"=="--help" goto help
if /i "%~1"=="-h" goto help
shift
goto agent-help-check

:agent-run
if not defined UNA_ENGINE_PATH if exist "C:\code\engine\Build\BuildTool\" set "UNA_ENGINE_PATH=C:\code\engine"
if exist "%SMITH_DIR%stop-agent" del /q "%SMITH_DIR%stop-agent"
rem Tells the agent this launcher restarts it after an update and can roll one back.
set "SMITH_UPDATE_SUPERVISED=1"
echo Smith experiment agent: %SMITH_TARGET%
echo Running from: %SMITH_DIR%
pushd "%SMITH_DIR%"
:run
rem An update replaces this file while it runs, and cmd reads a batch file line by line from a saved
rem offset. So the agent, the settling and the jump that follows are one line, already read; goto and
rem call find their labels afresh in whichever file is there by then.
"%SMITH_EXE%" hosted-agent --coordinator %SMITH_TARGET% --workspace "%SMITH_DIR%hosted-workspace" --drain-file "%SMITH_DIR%stop-agent" %SMITH_ARGS% & call :settle & goto next

:next
if "%SMITH_NEXT%"=="restart" goto run
popd
exit /b %SMITH_RESULT%

:settle
rem Every path through here ends inside one parsed block, for the same reason as above.
set "SMITH_RESULT=%errorlevel%"
set "SMITH_NEXT=exit"
if "%SMITH_RESULT%"=="10" (
    echo Smith updated itself; starting the new version.
    set "SMITH_NEXT=restart"
    exit /b 0
)
if not "%SMITH_RESULT%"=="0" if exist "%SMITH_DIR%update-pending.json" if exist "%SMITH_DIR%.update-previous\" (
    echo The updated agent stopped before the coordinator accepted it ^(exit code %SMITH_RESULT%^); going back to the previous version.
    for %%F in ("%SMITH_DIR%.update-previous\*") do move /y "%%~fF" "%SMITH_DIR%" >nul
    move /y "%SMITH_DIR%update-pending.json" "%SMITH_DIR%update-rejected.json" >nul
    rd /s /q "%SMITH_DIR%.update-previous"
    set "SMITH_NEXT=restart"
    exit /b 0
)
exit /b 0
