@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-selfhost.ps1" %*
set "selfhost_exit_code=%errorlevel%"
pause
exit /b %selfhost_exit_code%
