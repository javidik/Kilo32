@echo off
rem Kilo32 installer entry point.
rem Launches install.ps1 under Windows PowerShell with UTF-8 codepage so
rem the script's English output renders correctly in any locale.

setlocal
set "PSOPTIONS=-NoLogo -NoProfile -ExecutionPolicy Bypass"

rem Try Windows PowerShell 5.1 first (built into Windows 10 x86 1809+).
where powershell.exe >nul 2>nul
if not errorlevel 1 (
    chcp 65001 >nul
    powershell.exe %PSOPTIONS% -File "%~dp0install.ps1"
    set "RC=%ERRORLEVEL%"
    goto :done
)

rem Fall back to PowerShell 7+ if available (pwsh.exe on PATH).
where pwsh.exe >nul 2>nul
if not errorlevel 1 (
    chcp 65001 >nul
    pwsh.exe %PSOPTIONS% -File "%~dp0install.ps1"
    set "RC=%ERRORLEVEL%"
    goto :done
)

echo.
echo Windows PowerShell was not found on this system.
echo Please install Windows PowerShell 5.1 (built into Windows 10)
echo or PowerShell 7+ from https://github.com/PowerShell/PowerShell
echo.
pause
exit /b 1

:done
if not "%RC%"=="0" (
    echo.
    echo Installation failed with exit code %RC%.
    pause
    exit /b %RC%
)
echo.
echo Installation complete.
echo Open a NEW PowerShell or CMD window and run:  kilo
echo.
pause
endlocal
