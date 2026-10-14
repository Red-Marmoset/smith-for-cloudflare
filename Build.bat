@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build.ps1" %*
if %errorlevel% neq 0 exit /b %errorlevel%
