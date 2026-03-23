@echo off
setlocal

cd /d "%~dp0"
set "COREPACK_HOME=%CD%\.corepack"

start "KnowledgeOS Vite" cmd /k "cd /d %CD% && set COREPACK_HOME=%COREPACK_HOME% && corepack pnpm --dir %CD%\apps\desktop dev"
ping 127.0.0.1 -n 6 >nul
start "KnowledgeOS Desktop" cmd /k "cd /d %CD% && cargo run --manifest-path %CD%\apps\desktop\src-tauri\Cargo.toml"

echo Started. If a window reports an error, keep it open and send me the last 30 lines.

endlocal
