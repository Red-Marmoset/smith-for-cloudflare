@echo off
rem Deploy the hosted Smith coordinator (the Cloudflare Worker behind exp.redmarmosetstudios.com)
rem from this checkout, together with the Windows agent package. It builds and checks everything
rem first and changes nothing live unless all of it passes. Once the Worker is live it publishes the
rem agent package, and every connected Windows agent updates itself to it between builds.
rem
rem   DeployWorker.bat                 Worker + Windows agent package
rem   DeployWorker.bat --worker-only   only the Worker (agents keep the package they have)
rem   DeployWorker.bat --unattended    as a Smith build (smith.json "deploy-experiment", run by a push to
rem                                    feature/cloudflare-experiment): never logs in, prompts or pauses;
rem                                    needs CLOUDFLARE_API_TOKEN (the workspace's Cloudflare token in
rem                                    Settings reaches the build) or a Wrangler login already on the machine
rem
rem Needs Git and Node.js 22 or newer on PATH, plus the normal Smith build prerequisites and Python 3
rem for the agent package. The first time, Wrangler opens your browser to log in to Cloudflare (or set
rem CLOUDFLARE_API_TOKEN beforehand). The version deployed is VERSION plus the commit count (0.1.0.239).
rem This deploys Smith itself, never the projects Smith builds.
setlocal EnableExtensions
set "REPO=%~dp0"
set "COORDINATOR=%~dp0cloudflare\coordinator"
set "SMITH_URL=https://exp.redmarmosetstudios.com"
set "EXITCODE=0"
set "AGENT=1"
set "UNATTENDED="
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--worker-only" (set "AGENT=" & shift & goto parse)
if /i "%~1"=="--unattended" (set "UNATTENDED=1" & shift & goto parse)
echo Usage: %~nx0 [--worker-only] [--unattended]
goto failed
:parsed
set "AGENT_ZIP=%~dp0Build\SmithExperiment\smith-experiment-windows.zip"
set "AGENT_MANIFEST=%~dp0Build\SmithExperiment\smith-experiment-windows.json"

where git >nul 2>nul || (echo ERROR: Git is not on PATH.& goto failed)
where node >nul 2>nul || (echo ERROR: Node.js is not on PATH. Install Node.js 22 or newer from https://nodejs.org& goto failed)
set "NODE_MAJOR=0"
for /f %%v in ('node -p "parseInt(process.versions.node)"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 22 (echo ERROR: Node.js %NODE_MAJOR% is too old; install 22 or newer.& goto failed)

rem The live Worker reports the commit it came from, so only deploy committed code that is on GitHub.
set "DIRTY="
for /f "delims=" %%l in ('git -C "%REPO%." status --porcelain') do set "DIRTY=1"
if defined DIRTY (
    echo ERROR: This checkout has uncommitted changes. Commit or stash them first:
    git -C "%REPO%." status --short
    goto failed
)
for /f %%c in ('git -C "%REPO%." rev-parse HEAD') do set "COMMIT=%%c"
for /f %%b in ('git -C "%REPO%." rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
echo Checking that %COMMIT:~0,12% is on GitHub...
git -C "%REPO%." fetch --quiet origin
set "PUSHED="
for /f %%r in ('git -C "%REPO%." branch -r --contains %COMMIT% 2^>nul') do set "PUSHED=1"
if not defined PUSHED (
    echo ERROR: %COMMIT:~0,12% is not on GitHub yet. Push it first: git push origin %BRANCH%
    goto failed
)

rem The version is VERSION (semantic: major.minor.patch) plus the commit count as the fourth part, e.g. 0.1.0.239.
rem A shallow checkout (a Smith build's clone can be one) would count only what it holds, so fetch the history first.
set "BASE_VERSION="
for /f "usebackq delims=" %%v in ("%REPO%VERSION") do if not defined BASE_VERSION set "BASE_VERSION=%%v"
if not defined BASE_VERSION (echo ERROR: VERSION is missing or empty.& goto failed)
for /f %%s in ('git -C "%REPO%." rev-parse --is-shallow-repository') do if "%%s"=="true" (
    echo Fetching the full history so the version's commit count is right...
    git -C "%REPO%." fetch --quiet --unshallow origin || (echo ERROR: Could not fetch the full history to number this version.& goto failed)
)
for /f %%n in ('git -C "%REPO%." rev-list --count HEAD') do set "REVISION=%%n"
set "VERSION=%BASE_VERSION%.%REVISION%"

echo.
if defined AGENT (
    echo [1/6] Building the Windows agent package from %COMMIT:~0,12% ^(nothing goes live yet^)...
    call "%REPO%PackageAgent.bat" || goto failed
) else (
    echo [1/6] Skipping the agent package ^(--worker-only^).
)

pushd "%COORDINATOR%"
echo.
echo [2/6] Installing the exact locked dependencies...
call npm ci --no-audit --no-fund || goto failed_in_dir
echo.
echo [3/6] Type checks, all tests, and a dry-run deploy (nothing goes live yet)...
call npm run verify || goto failed_in_dir
echo.
echo [4/6] Checking your Cloudflare login...
if not defined CLOUDFLARE_API_TOKEN (
    rem Unattended (a Smith build): never open a browser to log in. The fix is the Cloudflare API token in the
    rem workspace's Settings, which reaches every build, or a one-time "npx wrangler login" on this machine.
    if defined UNATTENDED (
        call npx wrangler whoami 2>&1 | findstr /i /c:"not authenticated" >nul && (
            echo ERROR: Not logged in to Cloudflare and CLOUDFLARE_API_TOKEN is not set. Add the Cloudflare API token
            echo        in Smith's workspace Settings ^(it needs Workers Scripts:Edit, D1:Edit and R2:Edit^), or run
            echo        "npx wrangler login" once on this machine.
            goto failed_in_dir
        )
    ) else (
        call npx wrangler whoami 2>&1 | findstr /i /c:"not authenticated" >nul && (call npx wrangler login || goto failed_in_dir)
    )
)

echo.
echo Checking the repository bucket (Smith-hosted repositories relay and back up through it)...
call npx wrangler r2 bucket list 2>nul | findstr /c:"smith-experiment-git" >nul || (
    echo ERROR: The R2 bucket smith-experiment-git does not exist yet. Create it once, with its lifecycle rules:
    echo     npx wrangler r2 bucket create smith-experiment-git
    echo     npx wrangler r2 bucket lifecycle add smith-experiment-git relay-expiry --prefix relay/ --expire-days 1
    echo     npx wrangler r2 bucket lifecycle add smith-experiment-git abort-uploads --abort-multipart-days 1
    goto failed_in_dir
)
echo.
echo Deploying Smith %VERSION% (%COMMIT:~0,12%, %BRANCH%) to %SMITH_URL%.
echo This replaces the live coordinator. Agents and open dashboards reconnect by themselves.
echo.
echo [5/6] Applying any new database migrations...
rem Wrangler asks "Ok to proceed?" before applying migrations; CI mode takes the default (yes) so the
rem deploy never stalls on a prompt. setlocal keeps this to this script.
set "CI=true"
call npx wrangler d1 migrations apply smith-experiment-identity --remote || goto failed_in_dir
echo.
echo [6/6] Deploying the Worker...
call npx wrangler deploy --tag %COMMIT:~0,12% --var RELEASE_SHA:%COMMIT% --var RELEASE_VERSION:%VERSION% || goto failed_in_dir
if defined AGENT (
    echo.
    echo Publishing the Windows agent package; connected agents update to it between builds...
    rem The zip first, then its manifest: agents are offered the new version only once its zip is in place.
    call npx wrangler r2 object put smith-experiment-releases/smith-experiment-windows.zip --file "%AGENT_ZIP%" --remote || goto agent_failed
    call npx wrangler r2 object put smith-experiment-releases/smith-experiment-windows.json --file "%AGENT_MANIFEST%" --content-type application/json --remote || goto agent_failed
    echo Agent package hosted-%COMMIT:~0,12% published.
)
popd

echo.
echo Checking %SMITH_URL%/health ...
set "HEALTHY="
for /l %%i in (1,1,10) do if not defined HEALTHY (
    curl -s "%SMITH_URL%/health" | findstr /c:"%COMMIT%" >nul && set "HEALTHY=1"
    if not defined HEALTHY timeout /t 3 /nobreak >nul
)
if not defined HEALTHY (
    echo WARNING: The deploy finished, but %SMITH_URL%/health does not report %COMMIT:~0,12% yet.
    echo Check it in a minute with: curl %SMITH_URL%/health
    goto finish
)
echo Done: %SMITH_URL% is running %VERSION% (%COMMIT:~0,12%).
goto finish

:agent_failed
popd
echo.
echo WARNING: The Worker is live, but publishing the agent package failed; agents keep their current
echo version. Retry the upload with: PackageAgent.bat --upload
set "EXITCODE=1"
goto finish

:failed_in_dir
popd
:failed
echo.
echo Deploy stopped; nothing after the failed step was changed.
set "EXITCODE=1"
:finish
rem Keep the window open when started by double-clicking (never when a Smith build runs this).
if not defined UNATTENDED echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
exit /b %EXITCODE%
