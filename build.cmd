@echo off
rem Use a process-local policy so this also works from a default PowerShell.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
set "build_result=%errorlevel%"
if not "%build_result%"=="0" (
  echo.
  echo Build failed. See build-transcript.log in the project directory.
  pause
)
exit /b %build_result%
