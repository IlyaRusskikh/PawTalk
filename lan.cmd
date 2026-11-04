@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lan.ps1" %*
exit /b %errorlevel%
