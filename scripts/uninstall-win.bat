@echo off
setlocal
chcp 65001 >nul
title DHM Agent - Uninstall (Windows)

rem ============================================================
rem DHM AGENT - uninstall (Windows)
rem Stops only the DHM agent, removes the agent files and the
rem autostart entry. Other node/pm2 apps are left untouched.
rem ============================================================

set "PATH=%APPDATA%\npm;%PATH%"

call pm2 delete dhm-agent >nul 2>nul
call pm2 save >nul 2>nul

if exist "C:\agent" rmdir /s /q "C:\agent"
if exist "C:\dhm-agent.tar.gz" del "C:\dhm-agent.tar.gz" >nul 2>nul

if exist "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup\dhm-autostart.bat" del "%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup\dhm-autostart.bat" >nul 2>nul
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dhm-autostart.bat" del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dhm-autostart.bat" >nul 2>nul

echo === Removed ===
echo A reboot is recommended.
pause
