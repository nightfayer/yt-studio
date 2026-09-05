@echo off
chcp 65001 >nul
title YT Studio - Online Access (Cloudflare)
echo ================================================================
echo         YT Studio - Online Access via Cloudflare Tunnel
echo ================================================================
echo.
echo 1. Make sure YT Studio is running via Start.bat
echo 2. Establishing secure Cloudflare HTTPS Tunnel...
echo.
echo A link like https://xxxx.trycloudflare.com will appear below.
echo Open this link on your phone or any device anywhere in the world!
echo To stop: close this window.
echo ================================================================
echo.
if not exist "%~dp0bin\cloudflared.exe" (
    echo ERROR: bin\cloudflared.exe not found!
    pause
    exit /b 1
)
"%~dp0bin\cloudflared.exe" tunnel --url http://127.0.0.1:8080 --http-host-header localhost
echo.
echo Tunnel stopped.
pause
