@echo off
if not exist "%~dp0voicecord-lan-root.crt" (
    echo Missing voicecord-lan-root.crt next to this file.
    exit /b 1
)
certutil.exe -user -addstore Root "%~dp0voicecord-lan-root.crt"
if errorlevel 1 exit /b 1
echo Certificate trusted for this Windows user. Fully exit Voicecord via the tray and restart it.
pause
