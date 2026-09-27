@echo off
REM Single entry point: starts the casino and opens it in your browser.
title Crypto Casino
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install Node 22.5 or newer from https://nodejs.org
  pause
  exit /b 1
)

echo Starting %~dp0 ...
start "" http://127.0.0.1:8787
node src\server.js
echo.
echo Server stopped.
pause
