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
rem  Fully self-contained - NO GitHub, NO internet needed.
rem  Where the agent code comes from (first match wins):
rem    1) existing folder C:\agent           -> used as-is
rem    2) dhm-agent.tar.gz next to this .bat -> extracted
rem    3) LAN file server  (:9999)           -> downloaded
rem    4) Samba share      (\\server\NAS\media\DHM)
rem  After the install the downloaded tarball is removed.
rem
rem  Variables (set before running):
rem    SERVER_URL      DHM server        (default: http://192.168.0.10:4000)
rem    SERVE_URL       file server       (default: http://192.168.0.10:9999)
rem    DEVICE_NAME     dashboard name    (default: %COMPUTERNAME%)
rem    DEVICE_TYPE     desktop|laptop    (default: desktop)
rem    REPORT_INTERVAL report interval   (default: 60 s)
rem    REGISTER_TOKEN  registration token (or dhm-token.txt next to this
rem                     script, or interactive prompt)
rem ============================================================

if "%SERVER_URL%"=="" set "SERVER_URL=http://192.168.0.10:4000"
if "%SERVE_URL%"=="" set "SERVE_URL=http://192.168.0.10:9999"
if "%SMB_TAR%"=="" set "SMB_TAR=\\192.168.0.10\NAS\media\DHM\dhm-agent.tar.gz"
set "AGENT_DIR=C:\agent"
set "AGENT_TAR=%TEMP%\dhm-agent.tar.gz"
set "LOCAL_TAR=%~dp0dhm-agent.tar.gz"

if "%DEVICE_NAME%"=="" set "DEVICE_NAME=%COMPUTERNAME%"
if "%DEVICE_TYPE%"=="" set "DEVICE_TYPE=desktop"

rem ---- registration token: env -> dhm-token.txt (LAN) -> prompt ----
if "%REGISTER_TOKEN%"=="" if exist "%~dp0dhm-token.txt" set /p REGISTER_TOKEN=<"%~dp0dhm-token.txt"
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

rem ---- stop the old agent ----
pm2 kill >nul 2>nul
taskkill /f /im node.exe >nul 2>nul

rem ---- get the agent code (self-contained - no GitHub, no internet) ----
if exist "%AGENT_DIR%\index.js" goto :have_agent
rmdir /s /q "%AGENT_DIR%" >nul 2>nul
mkdir "%AGENT_DIR%" >nul 2>nul

if exist "%LOCAL_TAR%" (
    echo Extracting agent from %LOCAL_TAR% ...
    tar xf "%LOCAL_TAR%" -C "%AGENT_DIR%"
    if exist "%AGENT_DIR%\index.js" goto :have_agent
    echo   local archive invalid - trying the LAN server.
)
del "%AGENT_TAR%" >nul 2>nul
echo Downloading the agent...
curl -fsSL "%SERVE_URL%/dhm-agent.tar.gz" -o "%AGENT_TAR%" >nul 2>nul
if not exist "%AGENT_TAR%" (
    echo   fallback: Samba
    copy /Y "%SMB_TAR%" "%AGENT_TAR%" >nul 2>nul
)
if exist "%AGENT_TAR%" (
    tar xf "%AGENT_TAR%" -C "%AGENT_DIR%"
    del "%AGENT_TAR%" >nul 2>nul
)
:have_agent
if not exist "%AGENT_DIR%\index.js" (
    echo ERROR: agent files missing - check the download sources.
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
