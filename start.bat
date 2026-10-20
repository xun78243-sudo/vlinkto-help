@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Some shells/tools export ELECTRON_RUN_AS_NODE=1, which makes electron.exe
rem behave like plain node and breaks the app. Clear it here.
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron not installed. Run:  npm install
  pause
  exit /b 2
)

start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
