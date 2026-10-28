@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0release\本地清单\本地清单.exe" (
  echo Please build the Windows application first. See README.md.
  pause
  exit /b 1
)
start "" "%~dp0release\本地清单\本地清单.exe"
