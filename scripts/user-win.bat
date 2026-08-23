@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title DHM Agent - install (Windows)

rem ============================================================
rem Instalacja agenta DHM na Windows: pobiera agenta z GitHub
rem Releases, rejestruje urzadzenie i wlacza autostart (Startup).
rem Nic nie usuwa. Usuwanie: scripts\uninstall-win.bat
rem
rem Zmienne: SERVER_URL, DEVICE_NAME, DEVICE_TYPE,
rem          REPORT_INTERVAL, REGISTER_TOKEN
rem ============================================================

rem ---- adres serwera: env -> prompt (pusty Enter = przerwanie; gotowa komenda z adresem i tokenem jest na dashboardzie, panel "Dodaj urzadzenie") ----
if not "%SERVER_URL%"=="" goto :have_url
echo Nie podano SERVER_URL.
echo Najlatwiej: otworz dashboard DHM i skopiuj gotowa komende z panelu "Dodaj urzadzenie".
set /p "SERVER_URL=Albo wpisz tutaj adres serwera DHM http://IP:4000 : "
if "%SERVER_URL%"=="" (
    echo ERROR: brak adresu serwera - instalacja przerwana.
    pause
    exit /b 1
)
:have_url
if "%GITHUB_TAR%"=="" set "GITHUB_TAR=https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/dhm-agent.tar.gz"
set "AGENT_DIR=C:\agent"
set "AGENT_TAR=%TEMP%\dhm-agent.tar.gz"

if "%DEVICE_NAME%"=="" set "DEVICE_NAME=%COMPUTERNAME%"
if "%DEVICE_TYPE%"=="" set "DEVICE_TYPE=desktop"

rem ---- token rejestracji: env -> prompt ----
if "%REGISTER_TOKEN%"=="" set /p "REGISTER_TOKEN=Token rejestracji (REGISTER_TOKEN z server/.env): "
if "%REGISTER_TOKEN%"=="" (
    echo ERROR: brak tokenu rejestracji - wez go z server/.env na serwerze DHM.
    pause
    exit /b 1
)

rem ---- interwal raportowania (s): env -> prompt (domyslnie 60) ----
if "%REPORT_INTERVAL%"=="" set /p "REPORT_INTERVAL=Jak czesto agent ma raportowac? (sekundy) [60]: "
if "%REPORT_INTERVAL%"=="" set "REPORT_INTERVAL=60"

echo.
echo === Instalacja agenta DHM (Windows) ===
echo Serwer:   %SERVER_URL%
echo Urzadzenie: %DEVICE_NAME%  (%DEVICE_TYPE%)
echo Raporty:  co %REPORT_INTERVAL%s
echo.

rem ---- Node.js ----
echo [2/8] Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Brak Node.js. Instaluje Node.js LTS...
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    if %errorlevel% neq 0 (
        echo ERROR: winget nie zadzialal - zainstaluj Node.js LTS recznie z https://nodejs.org
        pause
        exit /b 1
    )
    echo.
    echo Zamknij to okno i uruchom skrypt ponownie - PATH zostal zaktualizowany.
    pause
    exit /b 1
)
echo [OK] Node.js

rem ---- pm2 ----
echo [3/8] pm2...
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo Instaluje pm2...
    call npm install -g pm2
)
set "PATH=%APPDATA%\npm;%PATH%"
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: pm2 nadal niedostepny po instalacji. Sprawdz recznie:
    echo   npm install -g pm2
    echo i uruchom ten skrypt ponownie.
    pause
    exit /b 1
)
echo [OK] pm2

rem ---- zatrzymaj tylko agenta DHM (inne apki node/pm2 zostaja) ----
echo [4/8] Zatrzymuje stara instancje (jesli byla)...
pm2 delete dhm-agent >nul 2>nul

rem ---- pobierz agenta (juz jest -> nie sciagaj) ----
echo [5/8] Pliki agenta...
if exist "%AGENT_DIR%\index.js" goto :have_agent
rmdir /s /q "%AGENT_DIR%" >nul 2>nul
mkdir "%AGENT_DIR%" >nul 2>nul

del "%AGENT_TAR%" >nul 2>nul
echo Pobieram agenta...
curl -fsSL --max-time 60 "%GITHUB_TAR%" -o "%AGENT_TAR%" >nul 2>nul
if exist "%AGENT_TAR%" (
    tar xf "%AGENT_TAR%" -C "%AGENT_DIR%"
    del "%AGENT_TAR%" >nul 2>nul
)
:have_agent
if not exist "%AGENT_DIR%\index.js" (
    echo ERROR: brak plikow agenta - sprawdz zrodlo pobierania.
    pause
    exit /b 1
)
echo [OK] Agent gotowy

rem ---- zaleznosci ----
echo [6/8] npm install...
cd /d "%AGENT_DIR%"
call npm install --omit=dev
if %errorlevel% neq 0 (
    echo ERROR: npm install nie powiodl sie.
    pause
    exit /b 1
)

rem ---- rejestracja + start ----
echo [7/8] Start pod pm2...
del /q "%AGENT_DIR%\.api_key" >nul 2>nul
set "REPORT_INTERVAL=%REPORT_INTERVAL%"
call pm2 start index.js --name dhm-agent --update-env
if %errorlevel% neq 0 (
    echo ERROR: pm2 start nie powiodl sie - logi: pm2 logs dhm-agent
    pause
    exit /b 1
)
rem ---- zapisuje dhm-agent ORAZ inne apki juz zarzadzane przez pm2 ----
call pm2 save

rem ---- autostart (dla wszystkich uzytkownikow jesli admin, inaczej obecny) ----
echo [8/8] Autostart...
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
echo [OK] Autostart skonfigurowany: %STARTUP_DIR%

echo.
echo === GOTOWE ===
call pm2 list
echo.
echo Dashboard: %SERVER_URL%
echo Urzadzenie pojawi sie samo za okolo minute.
pause
