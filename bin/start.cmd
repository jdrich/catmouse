@echo off
setlocal
cd /d "%~dp0\.."
if not exist node_modules\tsx (
  call npm install
)
call npx tsx ui/serve.ts
