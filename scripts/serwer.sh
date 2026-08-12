#!/usr/bin/env bash
# Instalacja serwera DHM (Debian/Ubuntu/Fedora/Arch/RPi).
# Ściąga bundle z GitHub Releases do $INSTALL_DIR, generuje tokeny,
# startuje pod pm2 i włącza autostart (systemd). Nic nie usuwa.
#
# Zmienne: PORT, AUTH_TOKEN, REGISTER_TOKEN, PM2_NAME, INSTALL_DIR, GITHUB_URL
# Druga instancja na tej maszynie: inny INSTALL_DIR + PORT + PM2_NAME.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/device-health-monitor}"
GITHUB_URL="${GITHUB_URL:-https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/dhm-bundle.tar.gz}"
PORT="${PORT:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
REGISTER_TOKEN="${REGISTER_TOKEN:-}"
PM2_NAME="${PM2_NAME:-dhm-server}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Port + sprawdzenie czy wolny ---
port_in_use() {
    local p="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${p}\$"
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${p}\$"
    else
        if node -e "const n=require('net');n.createServer().once('error',()=>process.exit(1)).listen($p,()=>process.exit(0))" 2>/dev/null; then
            return 1
        else
            return 0
        fi
    fi
}

if [ -n "$PORT" ]; then
    if ! echo "$PORT" | grep -qE '^[0-9]{1,5}$' || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
        fail "PORT=$PORT jest nieprawidłowy - użyj liczby 1-65535."
    fi
    if port_in_use "$PORT"; then
        fail "Port $PORT jest już zajęty. Wybierz wolny, np.: PORT=4001 ./serwer.sh"
    fi
else
    PORT=4000
    while true; do
        read -r -p "Na jakim porcie ma nasłuchiwać serwer DHM? [4000]: " ans
        ans="${ans:-4000}"
        if ! echo "$ans" | grep -qE '^[0-9]{1,5}$' || [ "$ans" -lt 1 ] || [ "$ans" -gt 65535 ]; then
            warn "Nieprawidłowy port - użyj liczby 1-65535."
            continue
        fi
        PORT="$ans"
        if port_in_use "$PORT"; then
            warn "Port $PORT jest już zajęty - wybierz inny."
            continue
        fi
        break
    done
fi
ok "Wybrany port: $PORT"

# --- Wymagania ---
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Brak Node.js. Instaluję..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y && sudo apt-get install -y nodejs npm build-essential python3 curl
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y nodejs npm gcc-c++ make python3 curl
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm nodejs npm base-devel python curl
    else
        fail "Nieznany menedżer pakietów - zainstaluj Node.js >= 18 ręcznie (https://nodejs.org)."
    fi
fi
command -v node >/dev/null 2>&1 || fail "node dalej niedostępny po instalacji"
command -v npm  >/dev/null 2>&1 || fail "npm dalej niedostępny po instalacji"
command -v curl >/dev/null 2>&1 || fail "curl dalej niedostępny po instalacji"
ok "Node.js $(node --version)"

# --- Narzędzia build (better-sqlite3 potrzebuje kompilatora C++) ---
has_cxx() { command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1; }
if ! has_cxx || ! command -v make >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    echo "Brak narzędzi build (potrzebne do better-sqlite3). Instaluję..."
    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -y && sudo apt-get install -y build-essential python3
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y gcc-c++ make python3
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm base-devel python
    else
        fail "Brak kompilatora C++ / make / python3 - zainstaluj i uruchom ponownie."
    fi
fi
if ! has_cxx || ! command -v make >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
    fail "Narzędzia build dalej niedostępne - zainstaluj kompilator C++, make i python3, potem ponów."
fi

# --- Pobierz kod (już jest -> nie ściągaj) ---
if [ -f "$INSTALL_DIR/server/index.js" ]; then
    warn "Pliki serwera DHM już są w $INSTALL_DIR - używam ich (bez pobierania)."
else
    mkdir -p "$INSTALL_DIR"
    warn "Pobieram bundle serwera DHM z GitHub Releases..."
    TMP_DL="$(mktemp)"
    if ! curl -fsSL --max-time 120 "$GITHUB_URL" -o "$TMP_DL" 2>/dev/null; then
        rm -f "$TMP_DL"
        fail "Nie udało się pobrać bundle z $GITHUB_URL.
   Sprawdź połączenie / zmienną GITHUB_URL."
    fi
    tar xzf "$TMP_DL" -C "$INSTALL_DIR" --strip-components=1
    rm -f "$TMP_DL"
fi
[ -f "$INSTALL_DIR/server/index.js" ] || fail "Brak plików serwera DHM w $INSTALL_DIR/server (brak index.js)."

ok "Instaluję zależności serwera..."
if ! (cd "$INSTALL_DIR/server" && npm install); then
    fail "npm install się nie powiodło. Na Debianie/Ubuntu może być potrzebne:
       sudo apt install build-essential python3
       (better-sqlite3 wymaga kompilacji)"
fi

# --- Dashboard (dist jest w repo, zbuduj jeśli brak) ---
if [ ! -d "$INSTALL_DIR/dashboard/dist" ]; then
    warn "Brak builda dashboard - buduję (vite)..."
    (cd "$INSTALL_DIR/dashboard" && npm install && npm run build)
fi

# --- pm2 ---
if ! command -v pm2 >/dev/null 2>&1; then
    ok "Instaluję pm2 (globalny prefix wymaga root)..."
    sudo env "PATH=$PATH" npm install -g pm2
fi

# --- Tokeny ---
gen_token() {
    command -v openssl >/dev/null 2>&1 && openssl rand -hex 24 || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
}
if [ -f "$INSTALL_DIR/server/.env" ] && grep -q '^AUTH_TOKEN=' "$INSTALL_DIR/server/.env"; then
    warn "server/.env istnieje - zostawiam obecne tokeny"
else
    AUTH_TOKEN="${AUTH_TOKEN:-$(gen_token)}"
    REGISTER_TOKEN="${REGISTER_TOKEN:-$(gen_token)}"
    cat > "$INSTALL_DIR/server/.env" <<EOF
PORT=$PORT
AUTH_TOKEN=$AUTH_TOKEN
REGISTER_TOKEN=$REGISTER_TOKEN
EOF
    ok "Wygenerowano server/.env (tokeny zapisu + rejestracji)"
fi
mkdir -p "$INSTALL_DIR/dashboard/dist"
AUTH_TOKEN_FINAL=$(grep '^AUTH_TOKEN=' "$INSTALL_DIR/server/.env" | cut -d= -f2-)
REGISTER_TOKEN_FINAL=$(grep '^REGISTER_TOKEN=' "$INSTALL_DIR/server/.env" | cut -d= -f2-)
PORT_FINAL=$(grep '^PORT=' "$INSTALL_DIR/server/.env" | cut -d= -f2-)
cat > "$INSTALL_DIR/dashboard/dist/config.js" <<EOF
window.DHM_CONFIG = { token: "$AUTH_TOKEN_FINAL" };
EOF
ok "Wygenerowano config dashboard (token)"

# --- Start ---
# PORT/tokeny serwer czyta z server/.env - nie trzeba eksportować.
cd "$INSTALL_DIR/server"
pm2 start index.js --name "$PM2_NAME"
pm2 save
ok "Serwer wystartował (pm2 name: $PM2_NAME)."

# --- Firewall ---
if command -v ufw >/dev/null 2>&1; then
    ok "Otwieram porty w UFW..."
    sudo ufw allow "$PORT_FINAL"/tcp || true
fi

# --- Autostart po restarcie ---
if [ -d /run/systemd/system ] || [ -d /etc/systemd ]; then
    warn "Włączam autostart systemd dla pm2 (może poprosić o sudo)..."
    sudo env "PATH=$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" \
        || warn "Autostart NIE włączony - uruchom ręcznie: sudo env PATH=\$PATH pm2 startup systemd -u $USER --hp $HOME"
fi

echo
ok "=== GOTOWE ==="
# Preferuj IP z sieci LAN (na podstawie trasy), fallback: hostname -I
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
[ -z "$LAN_IP" ] && LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
echo "Dashboard:   http://${LAN_IP:-<server-IP>}:$PORT_FINAL"
echo "Logi:        pm2 logs $PM2_NAME"
echo
echo "Agenty (one-linery z README):"
echo "  Linux:    curl -fsSL https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/user-linux.sh -o /tmp/dhm.sh && REGISTER_TOKEN=$REGISTER_TOKEN_FINAL sh /tmp/dhm.sh"
echo "  Windows:  curl -fsSL https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/user-win.bat -o %TEMP%\user-win.bat && %TEMP%\user-win.bat"
echo "  Telefon:  pkg install -y curl && curl -fsSL https://github.com/APOLL0PL/device-health-monitor/releases/latest/download/setup-termux.sh -o /tmp/setup-dhm.sh && REGISTER_TOKEN=$REGISTER_TOKEN_FINAL sh /tmp/setup-dhm.sh"
echo
echo "REGISTER_TOKEN: $REGISTER_TOKEN_FINAL"
echo "             (trzymaj w sekrecie - agenty potrzebują go tylko przy rejestracji)"
echo
echo "Usuwanie DHM:  scripts/uninstall-serwer.sh"
echo
