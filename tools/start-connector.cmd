@echo off
rem ---------------------------------------------------------------------------
rem  Kxxy remote connector - one-click launcher (Windows)
rem
rem  Why this file exists: the connector itself is a .mjs script, so a normal
rem  user has to open a terminal, cd into the project and type a node command.
rem  Most people stop at "open a terminal". Double-clicking this file does the
rem  same thing, prints the same connection string, and keeps the window open
rem  so the string does not vanish together with the console.
rem
rem  Everything below is ASCII on purpose: a .cmd with non-ASCII text can be
rem  garbled by the console codepage before `chcp 65001` takes effect. The
rem  Chinese output you see comes from node, which is always UTF-8.
rem ---------------------------------------------------------------------------

chcp 65001 >nul
title Kxxy Remote Connector
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] Node.js not found.
  echo       Install Node.js 18 or newer, then run this file again.
  echo       https://nodejs.org
  echo.
  pause
  exit /b 1
)

node "tools\remote-connector.mjs" %*
set KXXY_EXIT=%ERRORLEVEL%

echo.
if not "%KXXY_EXIT%"=="0" echo   Connector exited with code %KXXY_EXIT%.
echo   Press any key to close this window.
pause >nul
