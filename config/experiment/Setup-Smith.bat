@echo off
rem Setup-Smith.bat - connect this computer to Smith and keep its agent running in the background.
rem
rem Double-click it. The first time, paste the connect code from "Connect build machine" in the
rem dashboard. After that the agent starts by itself when you log on to Windows, runs without a
rem window, restarts if it ever stops and reconnects on its own. Running this again is always safe.
rem
rem   Setup-Smith.bat             connect (first time only), start at logon, start now
rem   Setup-Smith.bat status      is it running? shows the end of its log (agent.log)
rem   Setup-Smith.bat stop        stop it; a running build finishes first. It starts again at next logon
rem   Setup-Smith.bat remove      stop it and no longer start it at logon (the connection is kept)
rem   Setup-Smith.bat reconnect   set the connection up again with a new connect code
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Smith.ps1" %*
set "RESULT=%errorlevel%"
rem Keep the window open when started by double-clicking.
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
exit /b %RESULT%
