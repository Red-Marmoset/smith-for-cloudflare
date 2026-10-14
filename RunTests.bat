@echo off
rem Build and run every Tests\<Name>\ project (same as RunTests.ps1, without typing PowerShell).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0RunTests.ps1" %*
if %errorlevel% neq 0 exit /b %errorlevel%
