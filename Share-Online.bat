@echo off
chcp 65001 >nul
title YT Studio - Доступ через интернет (Cloudflare Tunnel)
echo ================================================================
echo         YT Studio - Публичный доступ через Cloudflare Tunnel
echo ================================================================
echo.
if not exist "%~dp0bin\cloudflared.exe" (
    echo ОШИБКА: bin\cloudflared.exe не найден!
    pause
    exit /b 1
)
:: Автоопределение порта YT Studio (по умолчанию 8731)
set "PORT=8731"
set "FOUND_PORT="
for /f "tokens=*" %%P in ('python -c "import socket; [print(p) or exit() for p in range(8731, 8782) if socket.socket().connect_ex((\"127.0.0.1\", p)) == 0]" 2^>nul') do set "FOUND_PORT=%%P"
if defined FOUND_PORT (
    set "PORT=%FOUND_PORT%"
    echo [OK] YT Studio обнаружена на порту %PORT%.
) else (
    echo [!] ВНИМАНИЕ: YT Studio сейчас не запущена.
    echo     Не забудьте запустить Start.bat, чтобы видео и интерфейс работали!
)
echo Подключение туннеля к YT Studio (порт %PORT%)...
echo.
echo Через несколько секунд появится ссылка вида:
echo https://xxxx.trycloudflare.com
echo.
echo Откройте эту ссылку на телефоне или любом другом устройстве!
echo Чтобы остановить: закройте это окно.
echo ================================================================
echo.
:tunnel_loop
"%~dp0bin\cloudflared.exe" --edge-ip-version 4 --no-autoupdate tunnel --protocol http2 --url http://127.0.0.1:%PORT% --http-host-header localhost --proxy-keepalive-connections 10 --proxy-keepalive-timeout 30s
echo.
echo Соединение было сброшено или закрыто.
echo Автоматический перезапуск через 3 секунды... (Закройте окно для остановки)
timeout /t 3 /nobreak >nul
goto tunnel_loop
