@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0e2ee-key.ps1" %*
set "e2ee_exit_code=%errorlevel%"
pause
exit /b %e2ee_exit_code%
