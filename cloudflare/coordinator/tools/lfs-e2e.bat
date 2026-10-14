@echo off
rem Runs tools\lfs-e2e.mjs with Node (usage at the top of that file).
node "%~dp0lfs-e2e.mjs" %*
exit /b %errorlevel%
