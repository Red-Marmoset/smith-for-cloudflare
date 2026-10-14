@echo off
rem Turn on "Continue with Google" and/or "Continue with GitHub" for the hosted Smith dashboard.
rem
rem   SetupSignIn.bat google
rem   SetupSignIn.bat github
rem
rem It opens the provider's page, tells you what to fill in, then stores the client ID and secret as
rem Cloudflare Worker secrets (never in this repository). Needs Node.js 22+ and your Cloudflare login.
rem Takes effect on a Worker deployed with sign-in support (DeployWorker.bat).
setlocal EnableExtensions
set "SELF=%~nx0"
set "EXITCODE=0"
set "SMITH_URL=https://exp.redmarmosetstudios.com"
set "PROVIDER=%~1"
if not defined PROVIDER (
    choice /c GH /m "Set up Google (G) or GitHub (H)"
    if errorlevel 2 (set "PROVIDER=github") else (set "PROVIDER=google")
)
if /i "%PROVIDER%"=="google" goto google
if /i "%PROVIDER%"=="github" goto github
echo Usage: %SELF% google ^| github
set "EXITCODE=2"
goto finish

:google
set "PREFIX=GOOGLE"
echo.
echo Google sign-in setup
echo   1. In the page that opens, choose "Create credentials", then "OAuth client ID".
echo      If Google first asks you to set up the consent screen: pick "Internal" so only
echo      accounts in your Google Workspace can use it, and enter the app name Smith.
echo   2. Application type: Web application. Name: Smith.
echo   3. Under "Authorized redirect URIs" add exactly:
echo        %SMITH_URL%/auth/callback/google
echo   4. Click Create, and keep the Client ID and Client secret it shows.
start "" "https://console.cloud.google.com/apis/credentials"
goto store

:github
set "PREFIX=GITHUB"
echo.
echo GitHub sign-in setup
echo   1. In the page that opens, register a new OAuth app:
echo        Application name:            Smith
echo        Homepage URL:                %SMITH_URL%
echo        Authorization callback URL:  %SMITH_URL%/auth/callback/github
echo   2. Click "Register application", then "Generate a new client secret".
echo   3. Keep the Client ID and the new client secret.
start "" "https://github.com/settings/applications/new"
goto store

:store
echo.
pause
where node >nul 2>nul || (echo ERROR: Node.js is not on PATH. Install Node.js 22 or newer from https://nodejs.org& goto failed)
pushd "%~dp0cloudflare\coordinator"
if not exist node_modules\wrangler\ (
    echo Installing the Cloudflare tools - first time only...
    call npm ci --no-audit --no-fund || (popd & goto failed)
)
if not defined CLOUDFLARE_API_TOKEN (
    call npx wrangler whoami 2>&1 | findstr /i /c:"not authenticated" >nul && (call npx wrangler login || (popd & goto failed))
)
echo.
echo Paste the Client ID when asked:
call npx wrangler secret put %PREFIX%_CLIENT_ID || (popd & goto failed)
echo.
echo Now paste the Client secret when asked:
call npx wrangler secret put %PREFIX%_CLIENT_SECRET || (popd & goto failed)
popd
echo.
echo Done. Within a minute the Smith sign-in page offers "Continue with %PROVIDER%".
echo To use it: sign in once with an invitation code (NewInvite.bat), then click
echo "Link %PROVIDER%" at the top of the dashboard. After that, that account signs you in.
goto finish

:failed
echo.
echo Sign-in was not set up because of the error above.
set "EXITCODE=1"
:finish
rem Keep the window open when started by double-clicking.
echo %cmdcmdline% | findstr /i /c:"%SELF%" >nul && pause
exit /b %EXITCODE%
