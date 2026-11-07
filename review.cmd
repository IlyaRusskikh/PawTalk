@echo off
cd /d "%~dp0"
if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 exit /b 1
)
"node_modules\electron\dist\electron.exe" "scripts\review.cjs"
