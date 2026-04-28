@echo off
title Chrome Extension Setup
cd /d "%~dp0"

echo.
echo ==================================================
echo   Danggeun Autobot - Chrome Extension Setup
echo ==================================================
echo.
echo Follow these steps (1 minute):
echo.
echo   1. Chrome will open the extensions page.
echo.
echo   2. Turn ON "Developer mode" toggle (top-right).
echo.
echo   3. Click "Load unpacked" button (top-left).
echo.
echo   4. Select this folder:
echo      %~dp0extension
echo      (folder path copied to clipboard)
echo.
echo   5. Visit https://chat.daangn.com to test.
echo.
echo ==================================================
echo.

REM Copy extension folder path to clipboard
echo %~dp0extension| clip 2>nul

REM Open Chrome extensions page
start chrome chrome://extensions 2>nul
if errorlevel 1 start "" chrome://extensions

echo Chrome opened. Follow the steps above.
echo.
pause
