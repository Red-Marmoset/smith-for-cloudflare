@echo off
rem Make a one-use invitation code (valid for one hour) to sign in to the hosted Smith dashboard.
rem
rem   NewInvite.bat         a code for your existing account (asks which one if there are several)
rem   NewInvite.bat --new   a code for a brand-new person (they then create their own workspace)
rem
rem Uses your Cloudflare login (your browser opens the first time). Needs Node.js 22 or newer.
setlocal EnableExtensions
set "SELF=%~nx0"
set "EXITCODE=0"
where node >nul 2>nul || (echo ERROR: Node.js is not on PATH. Install Node.js 22 or newer from https://nodejs.org& goto failed)
pushd "%~dp0cloudflare\coordinator"
if not exist node_modules\wrangler\ (
    echo Installing the Cloudflare tools - first time only...
    call npm ci --no-audit --no-fund || (popd & goto failed)
)
node tools\invite.mjs %* || (popd & goto failed)
popd
goto finish

:failed
echo.
echo No invitation was created because of the error above.
set "EXITCODE=1"
:finish
rem Keep the window open when started by double-clicking.
echo %cmdcmdline% | findstr /i /c:"%SELF%" >nul && pause
exit /b %EXITCODE%
