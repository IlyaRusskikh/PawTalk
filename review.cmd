@echo off
cd /d "%~dp0"
call npm run build
if errorlevel 1 exit /b 1
"node_modules\electron\dist\electron.exe" "scripts\review.cjs" "--profile=%~1"
