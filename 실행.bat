@echo off
title Danggeun Autobot
cd /d "%~dp0"

REM Step 1: Check Node.js installation
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo ==================================================
    echo   [!] Node.js is not installed on this PC.
    echo.
    echo   Download and install from: https://nodejs.org
    echo   After installing, restart this script.
    echo ==================================================
    echo.
    echo Opening Node.js download page in your browser...
    start "" https://nodejs.org/ko
    echo.
    pause
    exit /b 1
)

REM Step 2: First-time setup - install dependencies if missing
if not exist "node_modules" (
    echo.
    echo ==================================================
    echo   First-time setup - installing dependencies
    echo   This takes 1-2 minutes. Please wait...
    echo ==================================================
    echo.
    call npm install
    if errorlevel 1 goto :npmerror
    echo.
    echo [OK] Dependencies installed.
    echo.
)

REM Step 3: Launch dev server (browser opens automatically via vite)
echo.
echo ==================================================
echo   Starting Danggeun Autobot dev server...
echo   The app will open in your browser shortly.
echo   Press Ctrl+C in this window to stop.
echo ==================================================
echo.
call npm run dev
goto :end

:npmerror
echo.
echo [ERROR] Failed to install dependencies.
echo   Possible causes:
echo    - No internet connection
echo    - Corporate firewall blocking npm registry
echo    - Old Node.js version (needs 18 or newer)
echo.
echo   Run "node --version" to check your Node version.
echo.
pause
exit /b 1

:end
pause
