@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0release\DitaList\DitaList.exe" (
  echo Please build the Windows application first. See README.md.
  pause
  exit /b 1
)
start "" "%~dp0release\DitaList\DitaList.exe"
