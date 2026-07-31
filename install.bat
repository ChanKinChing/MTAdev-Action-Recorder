@echo off
title MTAdev Action Recorder - Installer
cd /d "%~dp0"

echo ==============================
echo  MTAdev Action Recorder
echo  Auto Installer
echo ==============================
echo.

if not exist "%~dp0manifest.json" (
    echo ERROR: manifest.json not found in %~dp0
    echo Please run this bat from the extension folder.
    pause
    exit /b 1
)

echo Running installer script...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_ext.ps1"

echo.
echo Done. Press any key to close...
pause > nul
