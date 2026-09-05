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
for /f "tokens=*" %%P in ('python -c "import socket; [print(p) or exit() for p in range(8731, 8782) if socket.socket().connect_ex((\"127.0.0.1\", p)) == 0]" 2^>nul') do set "PORT=%%P"
echo Подключение туннеля к YT Studio (порт %PORT%)...
echo.
echo Через несколько секунд появится ссылка вида:
echo https://xxxx.trycloudflare.com
echo.
echo Откройте эту ссылку на телефоне или любом другом устройстве!
echo Чтобы остановить: закройте это окно.
echo ================================================================
echo.
"%~dp0bin\cloudflared.exe" tunnel --protocol http2 --url http://127.0.0.1:%PORT% --http-host-header localhost
echo.
echo Туннель остановлен.
pause
