@echo off
setlocal
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell 5.1 was not found.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo Kilo installation failed.
  pause
  exit /b 1
)
echo.
echo Installation complete. Open a new terminal and run: kilo
