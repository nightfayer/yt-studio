@echo off
setlocal enabledelayedexpansion
title YT Studio
cd /d "%~dp0"

set "PY="

for %%C in (py.exe python.exe python3.exe) do (
  for /f "delims=" %%P in ('where %%C 2^>nul') do call :try "%%P"
)
for /d %%D in ("%LocalAppData%\Programs\Python\Python3*") do call :try "%%D\python.exe"
for /d %%D in ("%ProgramFiles%\Python3*") do call :try "%%D\python.exe"
for /d %%D in ("C:\Python3*") do call :try "%%D\python.exe"

if not defined PY goto nopython

echo.
echo   Python: !PY!
echo   Starting YT Studio - browser will open automatically.
echo   To stop: close this window.
echo.
"!PY!" "%~dp0app.py"
echo.
echo   Server stopped.
pause
exit /b 0

:try
if defined PY exit /b 0
if not exist "%~1" exit /b 0
"%~1" -c "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)" >nul 2>nul
if errorlevel 1 exit /b 0
set "PY=%~1"
exit /b 0

:nopython
echo.
echo   ==========================================================
echo    Python 3.8+ not found.
echo   ==========================================================
echo.
echo    Option 1 - run this command here:
echo        winget install -e --id Python.Python.3.12
echo.
echo    Option 2 - download the installer:
echo        https://www.python.org/downloads/
echo        IMPORTANT: check "Add python.exe to PATH".
echo.
echo    Then close this window and run Start.bat again.
echo   ==========================================================
echo.
pause
exit /b 1
