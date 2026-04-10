@echo off
setlocal enabledelayedexpansion
title ODIN - OD Validation System

:: ─────────────────────────────────────────────────────────────────────────────
::  ODIN_Launch.bat
::  Single-click launcher for the OD Validation System.
::
::  First run  : Downloads embedded Python 3.11 + installs all packages (needs internet).
::  Later runs : Starts instantly — fully offline.
::
::  To reset packages  : delete  python-embed\.packages_ok
::  To reset Python    : delete  python-embed\  folder entirely
:: ─────────────────────────────────────────────────────────────────────────────

:: ── Paths ────────────────────────────────────────────────────────────────────
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "PYDIR=%ROOT%\python-embed"
set "PYEXE=%PYDIR%\python.exe"
set "BACKEND=%ROOT%\backend"
set "REQUIREMENTS=%ROOT%\backend\requirements.txt"
set "SENTINEL=%PYDIR%\.packages_ok"

set "PY_VER=3.11.9"
set "PY_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"
set "PIP_URL=https://bootstrap.pypa.io/get-pip.py"

:: ── Banner ───────────────────────────────────────────────────────────────────
cls
echo.
echo  +======================================================+
echo  ^|         ODIN  ^|  OD Validation System                ^|
echo  +======================================================+
echo.

:: ─────────────────────────────────────────────────────────────────────────────
::  STEP 1 — Embedded Python
:: ─────────────────────────────────────────────────────────────────────────────
if exist "%PYEXE%" goto :check_packages

echo  [1/3] Setting up embedded Python %PY_VER%
echo        One-time download (~10 MB). Internet required.
echo.

if not exist "%PYDIR%" mkdir "%PYDIR%"

echo        Downloading Python %PY_VER%...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-WebRequest -Uri '%PY_URL%' -OutFile '%PYDIR%\py.zip' -UseBasicParsing; Write-Host '        Download complete.' } catch { Write-Host '[ERROR] Download failed: ' + $_.Exception.Message; exit 1 }"
if errorlevel 1 (
  echo.
  echo  [ERROR] Could not download Python. Check your internet connection.
  echo          URL: %PY_URL%
  echo.
  pause & exit /b 1
)

if not exist "%PYDIR%\py.zip" (
  echo  [ERROR] Downloaded file not found. Disk may be full.
  pause & exit /b 1
)

echo        Extracting...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Expand-Archive -Path '%PYDIR%\py.zip' -DestinationPath '%PYDIR%' -Force"
del /q "%PYDIR%\py.zip" 2>nul

:: Patch python311._pth to uncomment "import site" so pip (site-packages) works
echo        Configuring Python runtime...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pth = '%PYDIR%\python311._pth'; (Get-Content $pth) -replace '^#import site','import site' | Set-Content $pth"

:: Bootstrap pip into the embedded runtime
echo        Bootstrapping pip...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Invoke-WebRequest -Uri '%PIP_URL%' -OutFile '%PYDIR%\get-pip.py' -UseBasicParsing"
"%PYEXE%" "%PYDIR%\get-pip.py" --no-warn-script-location --quiet
del /q "%PYDIR%\get-pip.py" 2>nul

if not exist "%PYEXE%" (
  echo  [ERROR] Python setup failed unexpectedly.
  pause & exit /b 1
)

echo.
echo  [OK] Python %PY_VER% is ready.
echo.

:: ─────────────────────────────────────────────────────────────────────────────
::  STEP 2 — Install packages (one-time)
:: ─────────────────────────────────────────────────────────────────────────────
:check_packages
if exist "%SENTINEL%" goto :start_server

echo  [2/3] Installing required packages
echo        One-time setup. This may take 3-10 minutes.
echo        Please keep this window open...
echo.

"%PYEXE%" -m pip install -r "%REQUIREMENTS%" --no-warn-script-location
if errorlevel 1 (
  echo.
  echo  [ERROR] Package installation failed.
  echo          Ensure you have an internet connection and try again.
  echo          If the error persists, delete python-embed\ and relaunch.
  echo.
  pause & exit /b 1
)

:: Write sentinel so we skip installation on future launches
echo installed > "%SENTINEL%"

echo.
echo  [OK] All packages installed successfully.
echo.

:: ─────────────────────────────────────────────────────────────────────────────
::  STEP 3 — Start server and open browser
:: ─────────────────────────────────────────────────────────────────────────────
:start_server
echo  [3/3] Starting ODIN server...

:: Launch a background health-checker that polls /api/health every second.
:: It opens the browser only when the server is actually ready (up to 60s wait).
:: Written as a single line to avoid ^-continuation parsing issues with start /b.
start /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$i=0; while($i -lt 60){ try{ $r=Invoke-WebRequest -Uri 'http://127.0.0.1:8000/api/health' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){ Start-Process 'http://127.0.0.1:8000'; break } } catch{}; Start-Sleep -Seconds 1; $i++ }"

echo.
echo  +======================================================+
echo  ^|  ODIN is running at:  http://127.0.0.1:8000          ^|
echo  ^|                                                      ^|
echo  ^|  Browser will open automatically once server ready.  ^|
echo  ^|                                                      ^|
echo  ^|  ^>^> Close this window to stop the server. ^<^<      ^|
echo  +======================================================+
echo.

:: Kill any existing process occupying port 8000 (e.g. a previous ODIN instance)
echo  Checking port 8000...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr /r ":8000 "') do (
  taskkill /f /pid %%a >nul 2>&1
)
echo  Port 8000 is free. Starting server...
echo.

:: Change to backend directory and start uvicorn (foreground — keeps server alive)
pushd "%BACKEND%"
"%PYEXE%" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
popd

:: Reached here only if uvicorn exits (user Ctrl+C or crash)
echo.
echo  ODIN server has stopped.
echo  Press any key to close this window.
pause > nul
