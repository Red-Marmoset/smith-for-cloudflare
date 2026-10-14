@echo off
rem Runs tools\import-e2e.mjs with Node (usage at the top of that file).
node "%~dp0import-e2e.mjs" %*
exit /b %errorlevel%
