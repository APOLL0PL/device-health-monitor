@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title DHM Agent - install (Windows)

rem ============================================================
rem  DHM AGENT - Windows auto-install
rem
rem  Installs the DHM agent on this PC, registers the device with
rem  the DHM server and enables autostart (after login).
rem
rem  Designed to be run as a ONE-LINER (from the README) - it downloads
rem  the agent from GitHub Releases automatically. The installer does NOT
rem  delete anything; to remove the agent use scripts/uninstall-win.bat.
rem  Where the agent code comes from:
rem    1) existing folder C:\agent           -> used as-is
rem    2) GitHub Releases  (dhm-agent.tar.gz)
rem
rem  Variables (set before running):
rem    SERVER_URL      DHM server        (default: http://192.168.0.10:4000)
rem    DEVICE_NAME     dashboard name    (default: %COMPUTERNAME%)
rem    DEVICE_TYPE     desktop|laptop    (default: desktop)
rem    REPORT_INTERVAL report interval   (default: 60 s)
rem    REGISTER_TOKEN  registration token (or interactive prompt)
rem ============================================================

if "%SERVER_URL%"=="" set "SERVER_URL=http://192.168.0.10:4000"
if "%GITHUB_TAR%"=="" set "GITHUB_TAR=https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/dhm-agent.tar.gz"
set "AGENT_DIR=C:\agent"
set "AGENT_TAR=%TEMP%\dhm-agent.tar.gz"

if "%DEVICE_NAME%"=="" set "DEVICE_NAME=%COMPUTERNAME%"
if "%DEVICE_TYPE%"=="" set "DEVICE_TYPE=desktop"

rem ---- registration token: env -> prompt ----
if "%REGISTER_TOKEN%"=="" set /p "REGISTER_TOKEN=Registration token (REGISTER_TOKEN from server/.env): "
if "%REGISTER_TOKEN%"=="" (
    echo ERROR: no registration token - get it from server/.env on the DHM server.
    pause
    exit /b 1
)

rem ---- report interval (seconds): env -> prompt (default 60) ----
if "%REPORT_INTERVAL%"=="" set /p "REPORT_INTERVAL=How often should the agent report? (seconds) [60]: "
if "%REPORT_INTERVAL%"=="" set "REPORT_INTERVAL=60"

echo.
echo === DHM Agent install (Windows) ===
echo Server:   %SERVER_URL%
echo Device:   %DEVICE_NAME%  (%DEVICE_TYPE%)
echo Reports:  every %REPORT_INTERVAL%s
echo.

rem ---- Node.js ----
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js not found. Installing Node.js LTS...
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    echo.
    echo Close this window and run the script again (PATH was updated).
    pause
    exit /b 1
)
echo [OK] Node.js

rem ---- pm2 ----
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo Installing pm2...
    call npm install -g pm2
)
set "PATH=%APPDATA%\npm;%PATH%"

rem ---- stop only the DHM agent (leave other node/pm2 apps alone) ----
pm2 delete dhm-agent >nul 2>nul

rem ---- get the agent code (GitHub Releases) ----
if exist "%AGENT_DIR%\index.js" goto :have_agent
rmdir /s /q "%AGENT_DIR%" >nul 2>nul
mkdir "%AGENT_DIR%" >nul 2>nul

del "%AGENT_TAR%" >nul 2>nul
echo Downloading the agent...
curl -fsSL --max-time 60 "%GITHUB_TAR%" -o "%AGENT_TAR%" >nul 2>nul
if exist "%AGENT_TAR%" (
    tar xf "%AGENT_TAR%" -C "%AGENT_DIR%"
    del "%AGENT_TAR%" >nul 2>nul
)
:have_agent
if not exist "%AGENT_DIR%\index.js" (
    echo ERROR: agent files missing - check the download source.
    pause
    exit /b 1
)
echo [OK] Agent ready

rem ---- dependencies ----
cd /d "%AGENT_DIR%"
call npm install --omit=dev
if %errorlevel% neq 0 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

rem ---- register + start ----
del /q "%AGENT_DIR%\.api_key" >nul 2>nul
set "REPORT_INTERVAL=%REPORT_INTERVAL%"
pm2 start index.js --name dhm-agent --update-env
rem ---- saves dhm-agent AND any other apps already managed by pm2 ----
pm2 save

rem ---- autostart (all users if admin, otherwise current user) ----
net session >nul 2>nul
if %errorlevel% equ 0 (
    set "STARTUP_DIR=%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup"
) else (
    set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
)
> "%TEMP%\dhm-autostart.bat" (
    echo @echo off
    echo set "PATH=%APPDATA%\npm;%%PATH%%"
    echo cd /d "%AGENT_DIR%"
    echo pm2 resurrect
)
mkdir "%STARTUP_DIR%" >nul 2>nul
copy /Y "%TEMP%\dhm-autostart.bat" "%STARTUP_DIR%\dhm-autostart.bat" >nul
del "%TEMP%\dhm-autostart.bat" >nul 2>nul
echo [OK] Autostart configured: %STARTUP_DIR%

echo.
echo === DONE ===
call pm2 list
echo.
echo Dashboard: %SERVER_URL%
echo The device will show up on its own in about a minute.
pause
