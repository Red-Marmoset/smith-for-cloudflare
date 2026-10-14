@echo off
rem Build Smith and make the Windows agent package for the hosted experiment.
rem
rem   PackageAgent.bat                         build + package + zip
rem   PackageAgent.bat --install C:\SmithAgent also copy it into your agent folder (stop the agent first;
rem                                            its saved enrollment in hosted-workspace is kept)
rem   PackageAgent.bat --upload                also publish the zip as the dashboard's download (asks first);
rem                                            connected agents then update themselves to it
rem
rem Output: Build\SmithExperiment\Release\, Build\SmithExperiment\smith-experiment-windows.zip and its
rem         update manifest smith-experiment-windows.json
rem Needs the normal Smith build prerequisites plus Python 3; --upload also needs Node.js.
setlocal EnableExtensions
set "REPO=%~dp0"
set "SELF=%~nx0"
set "PACKAGE=%~dp0Build\SmithExperiment\Release"
set "ZIP=%~dp0Build\SmithExperiment\smith-experiment-windows.zip"
set "MANIFEST=%~dp0Build\SmithExperiment\smith-experiment-windows.json"
set "INSTALL="
set "UPLOAD="
set "EXITCODE=0"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--upload" (set "UPLOAD=1" & shift & goto parse)
if /i "%~1"=="--install" (
    if "%~2"=="" (echo ERROR: --install needs a folder, e.g. --install C:\SmithAgent& goto failed)
    set "INSTALL=%~f2"
    shift & shift & goto parse
)
echo ERROR: Unknown option %1
echo Usage: PackageAgent.bat [--install ^<agent folder^>] [--upload]
goto failed
:parsed

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (echo ERROR: Python 3 is not on PATH.& goto failed)

echo [1/3] Building Smith (Release)...
call "%REPO%Build.bat" -Config Release || goto failed
echo.
echo [2/3] Packaging and zipping the agent...
if exist "%ZIP%" del /q "%ZIP%"
if exist "%MANIFEST%" del /q "%MANIFEST%"
%PY% "%REPO%tools\package-experiment.py" --binary-dir "%REPO%Build\Smith\Release" --output "%PACKAGE%" --zip "%ZIP%" || goto failed
echo.
echo [3/3] Done.
echo Package:  %PACKAGE%
echo Zip:      %ZIP%
echo Manifest: %MANIFEST%

if defined INSTALL (
    echo.
    echo Installing into %INSTALL% ...
    if not exist "%INSTALL%\" mkdir "%INSTALL%" || goto failed
    copy /y "%PACKAGE%\*" "%INSTALL%\" >nul || (echo ERROR: Copy failed. Stop the agent running from %INSTALL% and try again.& goto failed)
    rem A hand install replaces whatever a self-update left half-done (it would otherwise be rolled back).
    if exist "%INSTALL%\update-pending.json" del /q "%INSTALL%\update-pending.json"
    if exist "%INSTALL%\.update-previous\" rmdir /s /q "%INSTALL%\.update-previous"
    if exist "%INSTALL%\.update-staging\" rmdir /s /q "%INSTALL%\.update-staging"
    echo Installed. Start it with: "%INSTALL%\Start-Smith.bat" agent --workspace-id ^<workspace-id^>
)

if defined UPLOAD (
    echo.
    choice /c YN /m "Publish this zip as the dashboard's Windows agent download (connected agents update to it)"
    if errorlevel 2 (echo Not uploaded.& goto finish)
    pushd "%REPO%cloudflare\coordinator"
    if not exist node_modules\ (call npm ci --no-audit --no-fund || (popd & goto failed))
    call npx wrangler r2 object put smith-experiment-releases/smith-experiment-windows.zip --file "%ZIP%" --remote || (popd & goto failed)
    rem The manifest goes second: agents are offered the new version only once its zip is in place.
    call npx wrangler r2 object put smith-experiment-releases/smith-experiment-windows.json --file "%MANIFEST%" --content-type application/json --remote || (popd & goto failed)
    popd
    echo Uploaded. Connected Windows agents install it between builds within a minute or so.
)
goto finish

:failed
echo.
echo Stopped because of the error above.
set "EXITCODE=1"
:finish
rem Keep the window open when started by double-clicking.
echo %cmdcmdline% | findstr /i /c:"%SELF%" >nul && pause
exit /b %EXITCODE%
