@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose-invitation.ps1" %*
pause
