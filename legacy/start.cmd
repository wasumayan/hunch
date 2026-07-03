@echo off
title GoonMarket
cd /d "%~dp0"
set NODE_EXE=%LOCALAPPDATA%\node-portable\node-v24.18.0-win-x64\node.exe
if not exist "%NODE_EXE%" (
  where node >nul 2>nul && set NODE_EXE=node
)
if "%NODE_EXE%"=="" (
  echo Node.js not found. Install Node 22+ or restore %LOCALAPPDATA%\node-portable
  pause
  exit /b 1
)
"%NODE_EXE%" server.js
pause
