@echo off
setlocal

cd /d "%~dp0"
title Novel Generator

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Please install Node.js LTS first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required. Please install Node.js LTS with npm first.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\vite.cmd" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist "node_modules\.bin\electron.cmd" (
  echo Electron is missing. Installing dependencies again...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting Novel Generator in a standalone desktop window...
call npm run desktop

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Novel Generator failed to start. Exit code: %EXIT_CODE%
  echo Keep this window open so the error above can be reviewed.
  pause
)

endlocal & exit /b %EXIT_CODE%
