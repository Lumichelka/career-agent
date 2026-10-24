@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ZhiXiang] Node.js not found.
  echo Please install Node.js 23 or newer from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\pdfjs-dist\legacy\build\pdf.mjs" (
  echo [ZhiXiang] First run: installing dependencies, please keep the network on...
  call npm ci --omit=optional
  if errorlevel 1 (
    echo [ZhiXiang] Dependency installation failed. Check the network and try again.
    pause
    exit /b 1
  )
)
node scripts\launch.mjs --lan
if errorlevel 1 pause
