@echo off
rem Double-click this file in File Explorer to open the trading floor with LIVE market data.
rem It installs what it needs the first time, starts the floor and opens your browser.
rem Close this window (or press Ctrl+C) to stop the floor: the desks flatten and the track
rem record is saved. With the background service on (npm run service -- install) it just
rem opens the floor.
cd /d "%~dp0"
title Meridian trading floor (live)
rem Node.js installed a moment ago isn't on this window's PATH yet: look where it installs.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul || goto nonode
node scripts\launch.js --live
if errorlevel 1 pause
exit /b
:nonode
echo.
echo   Node.js isn't installed yet. Your browser opens the download page:
echo   install the LTS version (Windows Installer), then double-click this file again.
echo   (Or run the one-line setup from the README, which installs everything.)
echo.
start "" "https://nodejs.org/en/download"
pause
exit /b 1
