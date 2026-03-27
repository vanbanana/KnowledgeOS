@echo off
setlocal

cd /d "%~dp0"

call powershell -ExecutionPolicy Bypass -File "%CD%\apps\desktop\scripts\dev-reset.ps1"
start "KnowFlow Dev" cmd /k "cd /d %CD% && corepack pnpm tauri:dev"

echo KnowFlow dev started with tauri dev.

endlocal
